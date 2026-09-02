/**
 * Fixed post-admission composition for the daemon-resident remote-local connector.
 * Transport admission stays in remote-local-connector.mjs; this module owns only
 * protected inventory, server-handle binding, and selected existing-session turns.
 */
import { createRemoteLocalFixedMechPlaneAdapter } from './remote-local-fixed-mech-plane-adapter.mjs';
import { createRemoteLocalNativeSessionRegistry } from './remote-local-native-session-registry.mjs';
import { createHostExtensionRelayHandler } from './host-extension-relay-handler.mjs';

export const REMOTE_LOCAL_CONNECTOR_HANDLER_MAX_FRAME_BYTES = 16_384;
export const REMOTE_LOCAL_CONNECTOR_HANDLER_MAX_IN_FLIGHT = 8;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDLE = /^rsh_[A-Za-z0-9_-]{16,128}$/;
const DIGEST = /^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9_-]{32,128})$/;
const AUTHORITY_KEYS = ['tenantId', 'consumerId', 'targetDeviceId', 'environmentAuthorizationId', 'bindingDigest', 'mountId', 'functionalityId', 'resourceId', 'principalId', 'mountEpoch', 'runGeneration', 'expiresAt', 'assurance'];

function exact(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function validFence(value) {
  return exact(value, ['brainId', 'deviceId', 'authorityRevision'])
    && ID.test(value.brainId) && ID.test(value.deviceId) && ID.test(value.authorityRevision);
}
function sameFence(left, right) {
  return left?.brainId === right?.brainId && left?.deviceId === right?.deviceId
    && left?.authorityRevision === right?.authorityRevision;
}
function validScope(value) {
  return exact(value, ['tenantId', 'consumerId']) && ID.test(value.tenantId) && ID.test(value.consumerId);
}
function validAuthority(value, currentFence) {
  return exact(value, AUTHORITY_KEYS) && ID.test(value.tenantId) && ID.test(value.consumerId)
    && value.targetDeviceId === currentFence.deviceId && ID.test(value.environmentAuthorizationId)
    && DIGEST.test(value.bindingDigest)
    && ['mountId', 'functionalityId', 'resourceId', 'principalId', 'mountEpoch', 'runGeneration', 'assurance'].every((key) => ID.test(value[key]))
    && typeof value.expiresAt === 'string' && value.expiresAt.length === 24
    && Number.isFinite(Date.parse(value.expiresAt)) && new Date(Date.parse(value.expiresAt)).toISOString() === value.expiresAt;
}
function validOwner(value) {
  return exact(value, ['kind', 'principalId', 'credentialId']) && value.kind === 'owner'
    && ID.test(value.principalId) && ID.test(value.credentialId);
}
function parse(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > REMOTE_LOCAL_CONNECTOR_HANDLER_MAX_FRAME_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype ? value : null;
  } catch { return null; }
}
function relaySafeTurnEvent(event, frame, currentFence) {
  if (event?.type !== 'protocol.error') return event;
  // Correlated adapter outcomes are local command lifecycle results. The relay
  // intentionally treats connector-originated protocol.error as a malformed
  // transport and closes it, so never let an ended/stale selected session tear
  // down unrelated sessions on the authenticated connector.
  return Object.freeze({
    type: 'terminal.receipt', protocolVersion: 1, fence: currentFence,
    commandId: frame.commandId, sessionHandle: frame.sessionHandle,
    disposition: event.code === 'no_active_session' || event.code === 'session_ended'
      ? 'session_ended' : 'post_ingress_indeterminate',
  });
}

/**
 * Dependencies are daemon-protected. In particular authorityScope is not read
 * from a relay/client frame, and the registry never serializes native IDs.
 */
export function createRemoteLocalConnectorHandler({ registry, adapter, authorityScope, hostExtensionHandler } = {}) {
  if (!registry || typeof registry.inventory !== 'function' || typeof registry.bind !== 'function' || typeof registry.reconnect !== 'function'
    || typeof registry.refreshBindings !== 'function'
    || !adapter || typeof adapter.dispatchTurn !== 'function' || typeof adapter.resolveApproval !== 'function'
    || !validScope(authorityScope)
    || (hostExtensionHandler !== undefined && (typeof hostExtensionHandler.admitted !== 'function' || typeof hostExtensionHandler.receive !== 'function' || typeof hostExtensionHandler.disconnect !== 'function' || typeof hostExtensionHandler.idle !== 'function')))
    throw new Error('remote-local connector handler requires protected runtime dependencies');

  let generation = 0;
  let fence = null;
  let send = null;
  let closeTransport = null;
  const turns = new Map();
  const maintenance = new Set();

  function invalidate() {
    generation += 1;
    for (const turn of turns.values()) turn.controller.abort();
    hostExtensionHandler?.disconnect();
    registry.reconnect();
    fence = null;
    send = null;
    closeTransport = null;
  }

  function fatal(expectedGeneration) {
    if (generation !== expectedGeneration) return;
    const close = closeTransport;
    invalidate();
    try { close?.(); } catch { /* transport owner also observes send failure */ }
  }

  async function proposeInventory(expectedGeneration, expectedFence, sendFrame, refreshId = null) {
    let sessions;
    try { sessions = await registry.inventory(expectedFence); } catch { return false; }
    if (generation !== expectedGeneration || !sameFence(fence, expectedFence) || send !== sendFrame) return false;
    try {
      return sendFrame({ type: 'session.inventory.propose', protocolVersion: 1, fence: expectedFence, sessions, refreshCapability: 'correlated-v1',
        ...(refreshId ? { refreshId } : {}) }) !== false;
    } catch { return false; }
  }

  async function admitted(currentFence, sendFrame, closeFrameTransport) {
    if (!validFence(currentFence) || typeof sendFrame !== 'function' || typeof closeFrameTransport !== 'function') return false;
    invalidate();
    const expectedGeneration = generation;
    const expectedFence = Object.freeze({ ...currentFence });
    fence = expectedFence;
    send = sendFrame;
    closeTransport = closeFrameTransport;
    if (hostExtensionHandler && !hostExtensionHandler.admitted(expectedFence, sendFrame)) { fatal(expectedGeneration); return false; }
    const accepted = await proposeInventory(expectedGeneration, expectedFence, sendFrame);
    if (!accepted && generation !== expectedGeneration && fence === expectedFence && send === sendFrame) {
      // A valid inventory request may supersede the initial observation while
      // this same admitted transport is still active. Its refresh now owns the
      // proposal; do not let the stale initial promise close that transport.
      return true;
    }
    if (!accepted) fatal(expectedGeneration);
    return accepted;
  }

  function refreshInventory(refreshId) {
    // A refresh replaces all server bindings.  If a request races a live
    // continuation, preserve that continuation and let the requester time out
    // fail-closed rather than aborting its tool/approval path.
    if (turns.size > 0) return true;
    generation += 1;
    for (const turn of turns.values()) turn.controller.abort();
    turns.clear();
    const expectedGeneration = generation;
    const expectedFence = fence;
    const sendFrame = send;
    if (!expectedFence || !sendFrame) return false;
    try { registry.refreshBindings(expectedFence); } catch { fatal(expectedGeneration); return false; }
    const task = proposeInventory(expectedGeneration, expectedFence, sendFrame, refreshId).then((accepted) => {
      if (!accepted) fatal(expectedGeneration);
    }).finally(() => maintenance.delete(task));
    maintenance.add(task);
    return true;
  }

  function launchTurn(frame) {
    if (!fence || !send || turns.size >= REMOTE_LOCAL_CONNECTOR_HANDLER_MAX_IN_FLIGHT
      || turns.has(frame.commandId) || [...turns.values()].some((turn) => turn.sessionHandle === frame.sessionHandle)) return false;
    const controller = new AbortController();
    const expectedGeneration = generation;
    const expectedFence = fence;
    const sendFrame = send;
    const turn = { sessionHandle: frame.sessionHandle, controller, generation: expectedGeneration, task: null };
    turns.set(frame.commandId, turn);
    turn.task = (async () => {
      let terminalSent = false;
      try {
        for await (const event of adapter.dispatchTurn({ fence: expectedFence, commandId: frame.commandId,
          sessionHandle: frame.sessionHandle, message: frame.message, authorityScope, signal: controller.signal })) {
          if (generation !== expectedGeneration || fence !== expectedFence || send !== sendFrame) { controller.abort(); break; }
          const outbound = relaySafeTurnEvent(event, frame, expectedFence);
          let accepted = false;
          try { accepted = sendFrame(outbound) !== false; } catch { /* fail closed below */ }
          if (!accepted) { controller.abort(); fatal(expectedGeneration); break; }
          if (outbound?.type === 'terminal.receipt') terminalSent = true;
        }
      } catch { controller.abort(); }
      finally {
        if (!terminalSent && generation === expectedGeneration && fence === expectedFence && send === sendFrame) {
          try {
            if (sendFrame({ type: 'terminal.receipt', protocolVersion: 1, fence: expectedFence, commandId: frame.commandId,
              sessionHandle: frame.sessionHandle, disposition: 'post_ingress_indeterminate' }) === false) fatal(expectedGeneration);
          } catch { fatal(expectedGeneration); }
        }
        if (turns.get(frame.commandId) === turn) turns.delete(frame.commandId);
      }
    })();
    return true;
  }

  function receive(raw) {
    const frame = parse(raw);
    if (!frame || !fence || !validFence(frame.fence) || !sameFence(frame.fence, fence) || frame.protocolVersion !== 1) return false;
    // Host extensions are a separately frozen, service-neutral transport lane.
    // All non-extension frames continue through the fixed Mech Plane handler.
    if (typeof frame.type === 'string' && frame.type.startsWith('host_extension.')) return hostExtensionHandler?.receive(raw) === true;
    if (frame.type === 'heartbeat') {
      return exact(frame, ['type', 'protocolVersion', 'fence', 'sequence'])
        && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0;
    }
    if (frame.type === 'session.inventory.request') {
      return exact(frame, ['type', 'protocolVersion', 'fence', 'refreshId']) && /^rir_[A-Za-z0-9_-]{16,128}$/.test(frame.refreshId) && refreshInventory(frame.refreshId);
    }
    if (frame.type === 'session.inventory.bind') {
      if (!exact(frame, ['type', 'protocolVersion', 'fence', 'sessions']) || !Array.isArray(frame.sessions) || frame.sessions.length > 32) return false;
      try { registry.bind(fence, frame.sessions); return true; } catch { return false; }
    }
    if (frame.type === 'turn.request') {
      if (!exact(frame, ['type', 'protocolVersion', 'fence', 'commandId', 'sessionHandle', 'message'])
        || !ID.test(frame.commandId) || !HANDLE.test(frame.sessionHandle) || typeof frame.message !== 'string'
        || Buffer.byteLength(frame.message, 'utf8') < 1 || Buffer.byteLength(frame.message, 'utf8') > 8_192) return false;
      return launchTurn(frame);
    }
    if (frame.type === 'turn.cancel') {
      if (!exact(frame, ['type', 'protocolVersion', 'fence', 'commandId', 'sessionHandle'])
        || !ID.test(frame.commandId) || !HANDLE.test(frame.sessionHandle)) return false;
      const turn = turns.get(frame.commandId);
      if (!turn || turn.generation !== generation || turn.sessionHandle !== frame.sessionHandle) return false;
      turn.controller.abort();
      return true;
    }
    if (frame.type === 'approval.decision') {
      if (!exact(frame, ['type', 'protocolVersion', 'fence', 'sessionHandle', 'authority', 'disposition', 'decisionIdempotencyKey', 'decider', 'resolutionId'])
        || !HANDLE.test(frame.sessionHandle) || !validAuthority(frame.authority, fence)
        || (frame.disposition !== 'allow' && frame.disposition !== 'deny') || !ID.test(frame.decisionIdempotencyKey)
        || !validOwner(frame.decider) || !ID.test(frame.resolutionId)) return false;
      try {
        return adapter.resolveApproval({ fence, sessionHandle: frame.sessionHandle, authority: frame.authority,
          disposition: frame.disposition, decider: frame.decider, resolutionId: frame.resolutionId }).accepted === true;
      } catch { return false; }
    }
    if (frame.type === 'device.revoked') {
      if (!exact(frame, ['type', 'protocolVersion', 'fence', 'reason'])
        || (frame.reason !== 'revoked' && frame.reason !== 'fence_changed')) return false;
      invalidate();
      // Revocation is terminal for this authenticated transport. Returning
      // false makes the connector close immediately instead of leaving a
      // heartbeat-only socket admitted under revoked authority.
      return false;
    }
    return false;
  }

  function disconnect() { invalidate(); }
  async function idle() {
    await Promise.allSettled([...turns.values()].map((turn) => turn.task).concat([...maintenance]));
    await hostExtensionHandler?.idle?.();
  }
  return Object.freeze({ admitted, receive, disconnect, idle, activeCount: () => turns.size });
}

/**
 * Shipped composition seam. The daemon lifecycle must supply an authenticated
 * owner scope plus an observer/continuation for sessions it already owns; this
 * factory cannot discover, create, or select a runtime from relay input.
 */
export function createRemoteLocalConnectorHandlerComposition({ daemon, authorityScope, listExistingSessions, continueExisting,
  randomBytesImpl, mintCallId, mintSystemResolutionId, Binding, hostExtensionHandler = createHostExtensionRelayHandler() } = {}) {
  if (typeof listExistingSessions !== 'function' || typeof continueExisting !== 'function') {
    throw new Error('remote-local connector composition requires protected existing-session dependencies');
  }
  const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions, ...(randomBytesImpl ? { randomBytesImpl } : {}) });
  const adapter = createRemoteLocalFixedMechPlaneAdapter({ daemon, registry, continueExisting, mintSystemResolutionId,
    ...(mintCallId ? { mintCallId } : {}), ...(Binding ? { Binding } : {}) });
  const handler = createRemoteLocalConnectorHandler({ registry, adapter, authorityScope, hostExtensionHandler });
  return Object.freeze({ handler, registry, adapter, hostExtensionHandler });
}
