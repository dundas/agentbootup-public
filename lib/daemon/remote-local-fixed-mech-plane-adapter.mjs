/**
 * Fixed local Mech Plane adapter for PRD-0072 Task 3.4.
 *
 * This is deliberately not a transport parser or a public execution API. Its
 * caller supplies a command that has already been admitted by the relay owner
 * and the protected tenant/consumer scope that the v1 connector wire does not
 * carry. Native session IDs, runtime policy, workspace, and the loopback
 * credential never enter a relay frame.
 */
import { createHash, randomBytes } from 'node:crypto';
import { FixedExistingSessionBinding } from '@mech/plane/interactive/fixed-existing-session-binding';
import { FIXED_LOOPBACK_SESSION_SCHEMA } from '@mech/plane/interactive/fixed-loopback-session-adapter';

export const REMOTE_LOCAL_FIXED_ADAPTER_MAX_MESSAGE_BYTES = 8_192;
export const REMOTE_LOCAL_FIXED_ADAPTER_MAX_EVENT_BYTES = 8_192;
export const REMOTE_LOCAL_FIXED_ADAPTER_MAX_RECEIPTS_PER_SESSION = 256;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDLE = /^rsh_[A-Za-z0-9_-]{16,128}$/;
const APPROVAL_KEYS = ['tenantId', 'consumerId', 'targetDeviceId', 'environmentAuthorizationId', 'bindingDigest', 'mountId', 'functionalityId', 'resourceId', 'principalId', 'mountEpoch', 'runGeneration', 'expiresAt', 'assurance'];

function bytes(value) { return Buffer.byteLength(value, 'utf8'); }
function exact(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function validFence(value) { return exact(value, ['brainId', 'deviceId', 'authorityRevision']) && ID.test(value.brainId) && ID.test(value.deviceId) && ID.test(value.authorityRevision); }
function sameFence(left, right) { return left?.brainId === right?.brainId && left?.deviceId === right?.deviceId && left?.authorityRevision === right?.authorityRevision; }
function validScope(value) { return exact(value, ['tenantId', 'consumerId']) && ID.test(value.tenantId) && ID.test(value.consumerId); }
function validAuthority(value, fence) {
  return exact(value, APPROVAL_KEYS) && ID.test(value.tenantId) && ID.test(value.consumerId)
    && value.targetDeviceId === fence.deviceId && ID.test(value.environmentAuthorizationId)
    && /^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9_-]{32,128})$/.test(value.bindingDigest)
    && ['mountId', 'functionalityId', 'resourceId', 'principalId', 'mountEpoch', 'runGeneration', 'assurance'].every((key) => ID.test(value[key]))
    && typeof value.expiresAt === 'string' && value.expiresAt.length === 24
    && Number.isFinite(Date.parse(value.expiresAt)) && new Date(Date.parse(value.expiresAt)).toISOString() === value.expiresAt;
}
function sameAuthority(left, right) { return APPROVAL_KEYS.every((key) => left?.[key] === right?.[key]); }
function fixedFenceToken(fence) {
  return `rlf_${createHash('sha256').update(`${fence.brainId}\u0000${fence.deviceId}\u0000${fence.authorityRevision}`, 'utf8').digest('base64url')}`;
}
function receiptIdentity(command) {
  // Build our own canonical projection rather than retaining the caller's
  // object, then retain only its digest. The receipt is opaque control state:
  // it never contains a message, native session ID, runtime configuration,
  // event payload, or approval authority.
  const canonical = JSON.stringify({
    fence: { brainId: command.fence.brainId, deviceId: command.fence.deviceId, authorityRevision: command.fence.authorityRevision },
    commandId: command.commandId, sessionHandle: command.sessionHandle, message: command.message,
    authorityScope: { tenantId: command.authorityScope.tenantId, consumerId: command.authorityScope.consumerId },
  });
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}
function generatedId(prefix) { return `${prefix}_${randomBytes(24).toString('base64url')}`; }
function protocolError(command, code) {
  return Object.freeze({ type: 'protocol.error', protocolVersion: 1, code, fence: command.fence, commandId: command.commandId, sessionHandle: command.sessionHandle });
}
function frozenAuthority(scope, fence, event) {
  return Object.freeze({
    tenantId: scope.tenantId, consumerId: scope.consumerId, targetDeviceId: fence.deviceId,
    environmentAuthorizationId: event.challengeId, bindingDigest: event.bindingDigest,
    mountId: event.mountId, functionalityId: event.functionalityId, resourceId: event.resourceId,
    principalId: event.principalId, mountEpoch: event.mountEpoch, runGeneration: event.runGeneration,
    expiresAt: event.expiresAt, assurance: event.assurance,
  });
}

/**
 * @param {{daemon: object, registry: {nativeSessionIdForHandle: Function}, continueExisting: (input: {nativeSessionId: string, text: string, fence: string, signal: AbortSignal, onApproval: Function}) => AsyncIterable<object>, mintSystemResolutionId: () => string, Binding?: typeof FixedExistingSessionBinding, mintCallId?: () => string}} options
 */
export function createRemoteLocalFixedMechPlaneAdapter({ daemon, registry, continueExisting, mintSystemResolutionId, Binding = FixedExistingSessionBinding, mintCallId = () => generatedId('rlc') } = {}) {
  if (!daemon || typeof daemon !== 'object' || !registry || typeof registry.nativeSessionIdForHandle !== 'function'
    || typeof continueExisting !== 'function' || typeof mintSystemResolutionId !== 'function'
    || typeof Binding !== 'function' || typeof mintCallId !== 'function') throw new Error('fixed Mech Plane adapter requires protected daemon dependencies');
  const activeByHandle = new Map();
  const receipts = new Map();

  function validCommand(command) {
    return exact(command, ['fence', 'commandId', 'sessionHandle', 'message', 'authorityScope', 'signal'])
      && validFence(command.fence) && ID.test(command.commandId) && HANDLE.test(command.sessionHandle)
      && typeof command.message === 'string' && bytes(command.message) > 0 && bytes(command.message) <= REMOTE_LOCAL_FIXED_ADAPTER_MAX_MESSAGE_BYTES
      && validScope(command.authorityScope) && (command.signal === undefined || command.signal instanceof AbortSignal);
  }

  async function* dispatchTurn(command) {
    if (!validCommand(command)) throw new Error('fixed Mech Plane adapter requires an exact server-derived command');
    const identity = receiptIdentity(command);
    const prior = receipts.get(command.commandId);
    if (prior) {
      // An exact duplicate receives the known terminal disposition. A changed
      // payload under the same protected command ID is never a fresh turn;
      // refusing it as indeterminate is safer than guessing whether ingress
      // happened for the original command.
      if (prior.identity === identity) {
        // The original stream may still emit ordered frames. Do not forge a
        // terminal receipt into that stream; the retry is conservatively told
        // that ingress is indeterminate and never enters native execution.
        if (prior.active) { yield protocolError(command, 'post_ingress_indeterminate'); return; }
        yield terminal(command, prior.disposition); return;
      }
      yield protocolError(command, 'post_ingress_indeterminate'); return;
    }
    const nativeSessionId = registry.nativeSessionIdForHandle(command.fence, command.sessionHandle);
    // Bad handle dispatch is correlated and local to that command. The future
    // connector transport remains usable for other independently bound handles.
    if (typeof nativeSessionId !== 'string' || nativeSessionId.length === 0) { yield protocolError(command, 'no_active_session'); return; }
    if (activeByHandle.has(command.sessionHandle)) { yield protocolError(command, 'concurrency_exceeded'); return; }
    // Do not evict an old receipt: doing so would permit a blind redispatch.
    // A reconnect/fence/session-end invalidates registry handles, which makes
    // their receipts safe to reclaim without re-opening an executable route.
    discardInvalidatedReceipts(command.fence);
    if (receiptCountForHandle(command.sessionHandle) >= REMOTE_LOCAL_FIXED_ADAPTER_MAX_RECEIPTS_PER_SESSION) { yield protocolError(command, 'concurrency_exceeded'); return; }

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (command.signal?.aborted) controller.abort();
    else command.signal?.addEventListener('abort', abort, { once: true });
    const callId = mintCallId();
    if (typeof callId !== 'string' || !ID.test(callId)) throw new Error('fixed Mech Plane adapter received an invalid protected call ID');
    const state = { callId, controller, fence: Object.freeze({ ...command.fence }), scope: Object.freeze({ ...command.authorityScope }), nativeSessionId, approvals: new Map(), sequence: 0 };
    activeByHandle.set(command.sessionHandle, state);
    // From this point the local binding may have accepted the continuation.
    // Until a terminal event proves otherwise, all exact retries must return
    // the conservative known disposition rather than invoke it again.
    const receipt = { identity, disposition: 'post_ingress_indeterminate', fence: state.fence, sessionHandle: command.sessionHandle, active: true };
    receipts.set(command.commandId, receipt);
    try {
      const binding = new Binding({
        daemon,
        // One selected session per invocation means this package boundary can
        // never discover, create, or select an alternative runtime session.
        // Bind the private selected ID into the continuation closure. The
        // public Plane seam intentionally omits it from continuation input, so
        // passing one generic callback unchanged would leave a multi-session
        // daemon unable to resume the session selected by the protected handle.
        sessions: [{ nativeSessionId, continueExisting: (input) => continueExisting(Object.freeze({ ...input, nativeSessionId })) }],
      });
      for await (const event of binding.invoke({
        credential: daemon.credential,
        remoteAddress: daemon.bindAddress,
        callId,
        signal: controller.signal,
        request: { schemaVersion: FIXED_LOOPBACK_SESSION_SCHEMA, text: command.message, nativeSessionId, commandId: command.commandId, fence: fixedFenceToken(command.fence) },
      })) {
        if (event.type === 'text') {
          if (bytes(event.text) > REMOTE_LOCAL_FIXED_ADAPTER_MAX_EVENT_BYTES) { receipt.active = false; yield terminal(command, receipt.disposition); return; }
          yield Object.freeze({ type: 'event.text', protocolVersion: 1, fence: state.fence, commandId: command.commandId, sessionHandle: command.sessionHandle, sequence: state.sequence++, text: event.text });
        } else if (event.type === 'tool') {
          yield Object.freeze({ type: 'event.tool', protocolVersion: 1, fence: state.fence, commandId: command.commandId, sessionHandle: command.sessionHandle, sequence: state.sequence++, tool: event.phase === 'requested' ? 'started' : event.phase === 'completed' ? 'completed' : 'failed' });
        } else if (event.type === 'progress') {
          yield Object.freeze({ type: 'event.progress', protocolVersion: 1, fence: state.fence, commandId: command.commandId, sessionHandle: command.sessionHandle, sequence: state.sequence++, state: event.phase === 'running' ? 'started' : 'resumed' });
        } else if (event.type === 'approval.requested') {
          const authority = frozenAuthority(state.scope, state.fence, event);
          state.approvals.set(event.challengeId, { authority, binding, bindingDigest: event.bindingDigest, invocationId: event.invocationId, resolution: null });
          yield Object.freeze({ type: 'approval.request', protocolVersion: 1, fence: state.fence, sessionHandle: command.sessionHandle, authority });
        } else if (event.type === 'approval.resolved') {
          const approval = state.approvals.get(event.challengeId);
          if (!approval) continue;
          const resolved = approval.resolution;
          const disposition = event.outcome === 'approved' ? 'allow' : event.outcome === 'denied' ? 'deny' : event.outcome === 'expired' ? 'expired' : event.outcome === 'cancelled' ? 'session_ended' : 'indeterminate';
          const resolutionId = resolved?.resolutionId ?? mintSystemResolutionId();
          if (typeof resolutionId !== 'string' || !ID.test(resolutionId)) throw new Error('fixed Mech Plane adapter received an invalid protected resolution ID');
          yield Object.freeze({ type: 'approval.resolved', protocolVersion: 1, fence: state.fence, sessionHandle: command.sessionHandle, authority: approval.authority, disposition, decider: resolved?.decider ?? Object.freeze({ kind: 'system' }), resolutionId });
          state.approvals.delete(event.challengeId);
        } else if (event.type === 'terminal') {
          receipt.disposition = event.disposition === 'completed' ? 'completed' : event.disposition === 'cancelled' ? 'cancelled' : 'post_ingress_indeterminate';
          receipt.active = false;
          yield terminal(command, receipt.disposition);
          return;
        }
      }
    } catch {
      receipt.active = false;
      yield terminal(command, receipt.disposition);
    } finally {
      receipt.active = false;
      command.signal?.removeEventListener('abort', abort);
      activeByHandle.delete(command.sessionHandle);
    }
  }

  function resolveApproval(decision) {
    if (!exact(decision, ['fence', 'sessionHandle', 'authority', 'disposition', 'decider', 'resolutionId'])
      || !validFence(decision.fence) || !HANDLE.test(decision.sessionHandle) || !validAuthority(decision.authority, decision.fence)
      || !['allow', 'deny'].includes(decision.disposition) || !exact(decision.decider, ['kind', 'principalId', 'credentialId'])
      || decision.decider.kind !== 'owner' || !ID.test(decision.decider.principalId) || !ID.test(decision.decider.credentialId)
      || !ID.test(decision.resolutionId)) return { accepted: false };
    const state = activeByHandle.get(decision.sessionHandle);
    if (!state || !sameFence(state.fence, decision.fence) || state.scope.tenantId !== decision.authority.tenantId || state.scope.consumerId !== decision.authority.consumerId) return { accepted: false };
    const pending = [...state.approvals.values()].find((entry) => sameAuthority(entry.authority, decision.authority));
    if (!pending) return { accepted: false };
    // The map is the sole local liveness authority. Recheck it at effect
    // release, because a session-end, reconnect, or fence transition may have
    // invalidated this handle while the owner was considering the approval.
    if (registry.nativeSessionIdForHandle(state.fence, decision.sessionHandle) !== state.nativeSessionId) {
      state.controller.abort();
      return { accepted: false };
    }
    const binding = pending.binding;
    // The binding is retained on registration below so only the exact held
    // tuple plus native invocation ID can release a native approval.
    if (!binding) return { accepted: false };
    const accepted = binding.resolve({ credential: daemon.credential, remoteAddress: daemon.bindAddress, resolution: {
      schemaVersion: FIXED_LOOPBACK_SESSION_SCHEMA, callId: state.callId,
      challengeId: decision.authority.environmentAuthorizationId, bindingDigest: pending.bindingDigest,
      invocationId: pending.invocationId, fence: fixedFenceToken(state.fence), mountId: decision.authority.mountId,
      functionalityId: decision.authority.functionalityId, resourceId: decision.authority.resourceId,
      principalId: decision.authority.principalId, mountEpoch: decision.authority.mountEpoch,
      runGeneration: decision.authority.runGeneration, assurance: decision.authority.assurance,
      decision: decision.disposition === 'allow' ? 'once' : 'deny',
    } }).accepted;
    if (accepted) pending.resolution = Object.freeze({ decider: Object.freeze({ ...decision.decider }), resolutionId: decision.resolutionId });
    return { accepted };
  }

  function discardInvalidatedReceipts(currentFence) {
    let discarded = 0;
    for (const [commandId, receipt] of receipts) {
      // An in-flight continuation retains its receipt until it has unwound.
      // A live registry mapping means its opaque handle is still capable of
      // being targeted, so evicting would make an old command executable.
      // Never ask the fence-aware registry about an old-fence receipt: that
      // lookup intentionally invalidates stale mappings and could erase the
      // freshly bound current-fence handle during reconnect recovery.
      if (activeByHandle.has(receipt.sessionHandle)) continue;
      if (!sameFence(receipt.fence, currentFence)) {
        receipts.delete(commandId);
        discarded += 1;
        continue;
      }
      if (typeof registry.nativeSessionIdForHandle(currentFence, receipt.sessionHandle) === 'string') continue;
      receipts.delete(commandId);
      discarded += 1;
    }
    return discarded;
  }

  function receiptCountForHandle(sessionHandle) {
    let count = 0;
    for (const receipt of receipts.values()) if (receipt.sessionHandle === sessionHandle) count += 1;
    return count;
  }

  return Object.freeze({ dispatchTurn, resolveApproval, activeCount: () => activeByHandle.size, receiptCount: () => receipts.size });
}

function terminal(command, disposition) {
  return Object.freeze({ type: 'terminal.receipt', protocolVersion: 1, fence: command.fence, commandId: command.commandId, sessionHandle: command.sessionHandle, disposition });
}
