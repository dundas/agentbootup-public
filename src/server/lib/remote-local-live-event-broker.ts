import { randomBytes } from 'node:crypto';
import type { RemoteLocalOwnerOperationScope } from './remote-local-owner-operations';
import type { ApprovalAuthority, RemoteLocalRelayFrame } from './remote-local-relay-protocol';
import type { RemoteLocalApprovalStore } from './remote-local-approval-store';

const encoder = new TextEncoder();
const MAX_SUBSCRIBERS = 128;
const MAX_EXPIRY_TIMER_MS = 2_147_000_000;
const EXPIRY_RETRY_MS = 1_000;
// Keep every socket-subordinate SSE response alive while the local runtime is
// quiet. Comment frames are transport-only and never create replay state.
const SSE_HEARTBEAT_MS = 5_000;
// A proxy can hold one response frame while an otherwise healthy native tool
// runs. Bound a genuinely stalled subscriber without cutting the 90s tool
// continuation qualification short.
const SSE_BACKPRESSURE_GRACE_TICKS = 24;
type PendingCloseOutcome = 'accepted' | 'indeterminate' | 'expired' | 'session_ended';

type EventFrame = Extract<RemoteLocalRelayFrame, { commandId: string }> | Extract<RemoteLocalRelayFrame, { type: 'approval.request' | 'approval.resolved' }>;
type Subscriber = { scope: RemoteLocalOwnerOperationScope; controller: ReadableStreamDefaultController<Uint8Array>; heartbeat?: ReturnType<typeof setInterval>; backpressureTicks?: number; signal?: AbortSignal; onAbort?: () => void };
type ExpectedResolution = { authority: ApprovalAuthority; disposition: 'allow' | 'deny' | 'expired' | 'session_ended' | 'indeterminate'; resolutionId: string;
  decider: { kind: 'owner'; principalId: string; credentialId: string } | { kind: 'system' } };
type PendingApproval = { scope: RemoteLocalOwnerOperationScope; commandId: string; sessionHandle: string; authority: ApprovalAuthority;
  requestDelivered: boolean; expected?: ExpectedResolution; expiryTimer?: ReturnType<typeof setTimeout> };

function sameScope(left: RemoteLocalOwnerOperationScope, right: RemoteLocalOwnerOperationScope): boolean {
  return left.tenantId === right.tenantId && left.ownerPrincipalId === right.ownerPrincipalId && left.consumerId === right.consumerId && left.credentialId === right.credentialId
    && left.brainId === right.brainId && left.deviceId === right.deviceId
    && left.fence.capabilitiesRevision === right.fence.capabilitiesRevision;
}
function sameTarget(left: RemoteLocalOwnerOperationScope, right: RemoteLocalOwnerOperationScope): boolean {
  return left.tenantId === right.tenantId && left.consumerId === right.consumerId && left.brainId === right.brainId
    && left.deviceId === right.deviceId && left.fence.capabilitiesRevision === right.fence.capabilitiesRevision;
}
function sameAuthority(left: ApprovalAuthority, right: ApprovalAuthority): boolean {
  return left.tenantId === right.tenantId && left.consumerId === right.consumerId && left.targetDeviceId === right.targetDeviceId
    && left.environmentAuthorizationId === right.environmentAuthorizationId && left.bindingDigest === right.bindingDigest
    && left.mountId === right.mountId && left.functionalityId === right.functionalityId && left.resourceId === right.resourceId
    && left.principalId === right.principalId && left.mountEpoch === right.mountEpoch && left.runGeneration === right.runGeneration
    && left.expiresAt === right.expiresAt && left.assurance === right.assurance;
}
function sse(event: string, data: unknown): Uint8Array { return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

/**
 * Socket-subordinate, no-replay SSE broker. It deliberately keeps no event
 * buffer: a disconnected stream is an interruption, never a resume surface.
 */
export class RemoteLocalLiveEventBroker {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly lost = new Set<string>();
  private readonly lostOrder: string[] = [];
  private readonly resolutions = new Set<string>();
  private readonly resolutionOrder: string[] = [];
  private readonly lifecycleTails = new Map<string, Promise<void>>();

  subscribe(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; signal?: AbortSignal }): { status: 'open'; stream: ReadableStream<Uint8Array> } | { status: 'busy' } {
    if (this.subscribers.size >= MAX_SUBSCRIBERS || this.subscribers.has(input.commandId)) return { status: 'busy' };
    let key: string | undefined; let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        key = input.commandId;
        const subscriber: Subscriber = { scope: input.scope, controller, signal: input.signal };
        this.subscribers.set(input.commandId, subscriber);
        if (input.signal) {
          subscriber.onAbort = () => this.discardSubscriber(input.commandId, subscriber, true);
          input.signal.addEventListener('abort', subscriber.onAbort, { once: true });
          if (input.signal.aborted) { subscriber.onAbort(); return; }
        }
        controller.enqueue(sse('connected', { commandId: input.commandId }));
      },
      // A staged turn is armed only after this stream is returned through the
      // HTTP response. Do not mistake its pre-response connected frame for a
      // stalled client; begin backpressure monitoring with the first pull.
      pull: () => {
        if (!key) return;
        const subscriber = this.subscribers.get(key);
        if (!subscriber) return;
        // Every downstream pull proves the transport made progress. Preserve
        // the grace budget for a later one-frame proxy buffer.
        subscriber.backpressureTicks = 0;
        if (pulled) return;
        pulled = true; this.startHeartbeat(key, subscriber);
      },
      cancel: () => { if (key) { const subscriber = this.subscribers.get(key); if (subscriber) this.discardSubscriber(key, subscriber, true); } },
    // Keep this explicit: first pull is our proof the initial connected frame
    // has been consumed. The heartbeat must never arm in the staged-turn
    // window while that one-frame queue is still waiting for HTTP to attach.
    }, { highWaterMark: 1 });
    return { status: 'open', stream };
  }

  /** Persists/hydrates approval correlation before any approval event reaches SSE. */
  async publishAuthorized(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; events: readonly RemoteLocalRelayFrame[]; approvalStore: RemoteLocalApprovalStore }): Promise<'delivered' | 'not_subscribed' | 'lost' | 'invalid_resolution'> {
    return this.serializeLifecycle(input.commandId, () => this.publishAuthorizedNow(input));
  }

  private async publishAuthorizedNow(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; events: readonly RemoteLocalRelayFrame[]; approvalStore: RemoteLocalApprovalStore }): Promise<'delivered' | 'not_subscribed' | 'lost' | 'invalid_resolution'> {
    const approvalRequestIds: (string | undefined)[] = [];
    const preparedResolutions = new Set<string>();
    const suppressedIndices = new Set<number>();
    for (const [index, event] of input.events.entries()) {
      if (event.type === 'approval.request') {
        const existing = this.findApprovalId(input.scope, input.commandId, event.sessionHandle, event.authority);
        const approvalRequestId = existing ?? this.reserveApproval({ scope: input.scope, commandId: input.commandId, sessionHandle: event.sessionHandle, authority: event.authority });
        if (approvalRequestId === 'apr_unavailable') return 'invalid_resolution';
        const registered = await input.approvalStore.registerPending({ scope: input.scope, commandId: input.commandId, sessionHandle: event.sessionHandle, approvalRequestId, authority: event.authority });
        if (registered.status === 'unavailable') {
          this.abandonApproval({ scope: input.scope, sessionHandle: event.sessionHandle, approvalRequestId });
          return 'invalid_resolution';
        }
        this.scheduleApprovalExpiry(approvalRequestId, input.approvalStore);
        if (existing && this.approvals.get(existing)?.requestDelivered) suppressedIndices.add(index);
        approvalRequestIds[index] = approvalRequestId;
      }
      if (event.type === 'approval.resolved') {
        const key = resolutionKey(input.commandId, event.authority);
        if (this.resolutions.has(key) || preparedResolutions.has(key)) continue;
        preparedResolutions.add(key);
        if (event.disposition === 'allow' || event.disposition === 'deny') {
          if (event.decider.kind !== 'owner') return 'invalid_resolution';
          const resolved = await input.approvalStore.resolveConnector({ scope: input.scope, sessionHandle: event.sessionHandle, authority: event.authority,
            disposition: event.disposition, resolutionId: event.resolutionId, decider: event.decider });
          if (resolved.status !== 'accepted' || !this.expectConnectorResolution({ scope: input.scope, commandId: input.commandId,
            sessionHandle: event.sessionHandle, authority: event.authority, disposition: event.disposition,
            resolutionId: event.resolutionId, decider: event.decider })) return 'invalid_resolution';
        } else {
          if (event.decider.kind !== 'system') return 'invalid_resolution';
          const matching = [...this.approvals].filter(([, pending]) => pending.commandId === input.commandId
            && pending.sessionHandle === event.sessionHandle && sameTarget(pending.scope, input.scope) && sameAuthority(pending.authority, event.authority));
          if (matching.length !== 1) return 'invalid_resolution';
          const closed = await input.approvalStore.closePending({ scope: matching[0]![1].scope, sessionHandle: event.sessionHandle,
            approvalRequestId: matching[0]![0], outcome: event.disposition });
          if ((closed.status !== 'updated' && closed.status !== 'idempotent') || matching[0]![1].expected) return 'invalid_resolution';
          matching[0]![1].expected = { authority: event.authority, disposition: event.disposition,
            resolutionId: event.resolutionId, decider: event.decider };
        }
      }
    }
    const published = this.publish({ scope: input.scope, commandId: input.commandId, events: input.events, approvalRequestIds,
      suppressedIndices: [...suppressedIndices] });
    if (published === 'delivered') for (const [index, event] of input.events.entries()) if (event.type === 'approval.request' && !suppressedIndices.has(index)) {
      const id = approvalRequestIds[index]; const pending = id ? this.approvals.get(id) : undefined; if (pending) pending.requestDelivered = true;
    }
    return published;
  }

  publish(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; events: readonly RemoteLocalRelayFrame[];
    approvalRequestIds?: readonly (string | undefined)[]; suppressedIndices?: readonly number[] }): 'delivered' | 'not_subscribed' | 'lost' | 'invalid_resolution' {
    const duplicateResolutions = new Set<number>();
    for (const [index, frame] of input.events.entries()) if (frame.type === 'approval.resolved') {
      const consumed = this.consumeResolution(input.commandId, frame); if (consumed === 'invalid') return 'invalid_resolution';
      if (consumed === 'duplicate') duplicateResolutions.add(index);
    }
    const subscriber = this.subscribers.get(input.commandId);
    if (!subscriber || !sameScope(subscriber.scope, input.scope)) return this.lost.has(input.commandId) ? 'lost' : 'not_subscribed';
    for (const [index, frame] of input.events.entries()) {
      if (duplicateResolutions.has(index) || input.suppressedIndices?.includes(index)) continue;
      const approvalRequestId = frame.type === 'approval.request'
        ? input.approvalRequestIds?.[index] ?? this.registerApproval(input.scope, input.commandId, frame.sessionHandle, frame.authority)
        : undefined;
      const normalized = normalize(frame, input.commandId, approvalRequestId); if (!normalized) continue;
      try { subscriber.controller.enqueue(sse(normalized.event, normalized.data)); }
      catch { if (subscriber.heartbeat) clearInterval(subscriber.heartbeat); this.subscribers.delete(input.commandId); this.rememberLost(input.commandId); return 'lost'; }
      if (normalized.terminal) { if (subscriber.heartbeat) clearInterval(subscriber.heartbeat); subscriber.controller.close(); this.subscribers.delete(input.commandId); this.lost.delete(input.commandId); return 'delivered'; }
    }
    return 'delivered';
  }

  reserveApproval(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; sessionHandle: string; authority: ApprovalAuthority }): string {
    return this.registerApproval(input.scope, input.commandId, input.sessionHandle, input.authority);
  }

  hydrateApproval(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; sessionHandle: string; approvalRequestId: string;
    authority: ApprovalAuthority; approvalStore: RemoteLocalApprovalStore }): boolean {
    const existing = this.approvals.get(input.approvalRequestId);
    if (existing) return existing.commandId === input.commandId && existing.sessionHandle === input.sessionHandle
      && sameTarget(existing.scope, input.scope) && sameAuthority(existing.authority, input.authority);
    if (this.approvals.size >= MAX_SUBSCRIBERS) return false;
    this.approvals.set(input.approvalRequestId, { scope: input.scope, commandId: input.commandId,
      sessionHandle: input.sessionHandle, authority: structuredClone(input.authority), requestDelivered: false });
    this.scheduleApprovalExpiry(input.approvalRequestId, input.approvalStore);
    return true;
  }

  expectConnectorResolution(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; sessionHandle: string; authority: ApprovalAuthority; disposition: 'allow' | 'deny'; resolutionId: string; decider: { kind: 'owner'; principalId: string; credentialId: string } }): boolean {
    const matching = [...this.approvals.values()].filter((pending) => pending.commandId === input.commandId && pending.sessionHandle === input.sessionHandle
      && sameTarget(pending.scope, input.scope) && sameAuthority(pending.authority, input.authority));
    if (matching.length !== 1 || matching[0]!.expected) return false;
    matching[0]!.expected = { authority: input.authority, disposition: input.disposition, resolutionId: input.resolutionId, decider: input.decider };
    return true;
  }

  close(input: { scope: RemoteLocalOwnerOperationScope; commandId: string }): void {
    this.closeSubscriber(input);
    for (const [id, pending] of this.approvals) if (pending.commandId === input.commandId && sameScope(pending.scope, input.scope)) this.deleteApproval(id);
  }

  private closeSubscriber(input: { scope: RemoteLocalOwnerOperationScope; commandId: string }): void {
    const subscriber = this.subscribers.get(input.commandId);
    if (subscriber && sameScope(subscriber.scope, input.scope)) {
      this.discardSubscriber(input.commandId, subscriber, false);
    }
    this.lost.delete(input.commandId);
  }

  private discardSubscriber(commandId: string, subscriber: Subscriber, lost: boolean): void {
    if (this.subscribers.get(commandId) !== subscriber) return;
    if (subscriber.heartbeat) clearInterval(subscriber.heartbeat);
    if (subscriber.signal && subscriber.onAbort) subscriber.signal.removeEventListener('abort', subscriber.onAbort);
    try { subscriber.controller.close(); } catch { /* already closed */ }
    this.subscribers.delete(commandId);
    if (lost) this.rememberLost(commandId);
    else this.lost.delete(commandId);
  }

  async closeAuthorized(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; outcome: 'indeterminate' | 'session_ended'; approvalStore: RemoteLocalApprovalStore }): Promise<'closed' | 'unavailable'> {
    return this.serializeLifecycle(input.commandId, () => this.closeAuthorizedNow(input));
  }

  private async closeAuthorizedNow(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; outcome: 'indeterminate' | 'session_ended'; approvalStore: RemoteLocalApprovalStore }): Promise<'closed' | 'unavailable'> {
    const pending = [...this.approvals].filter(([, item]) => item.commandId === input.commandId && sameScope(item.scope, input.scope));
    const results = await Promise.all(pending.map(([approvalRequestId, item]) => input.approvalStore.closePending({ scope: item.scope,
      sessionHandle: item.sessionHandle, approvalRequestId, outcome: input.outcome })));
    const subscriber = this.subscribers.get(input.commandId);
    if (subscriber && sameScope(subscriber.scope, input.scope)) {
      try {
        for (const [index, [, item]] of pending.entries()) if (results[index]?.status === 'updated' || results[index]?.status === 'idempotent') {
          subscriber.controller.enqueue(sse('approval_resolved', { commandId: input.commandId,
            disposition: 'indeterminate', resolutionId: `rla_${randomBytes(18).toString('base64url')}`, decidingPrincipalId: null, targetDeviceId: item.authority.targetDeviceId }));
        }
        if (input.outcome === 'session_ended') subscriber.controller.enqueue(sse('terminal', { commandId: input.commandId, disposition: 'session_ended' }));
      } catch { /* close below remains fail-closed */ }
    }
    this.closeSubscriber(input);
    for (const [index, [approvalRequestId, item]] of pending.entries()) {
      const result = results[index];
      if (result?.status === 'unavailable' || result?.status === 'not_found') this.scheduleCloseRetry(approvalRequestId, item, input.approvalStore, input.outcome);
      else this.deleteApproval(approvalRequestId);
    }
    return results.some((result) => result.status === 'unavailable' || result.status === 'not_found') ? 'unavailable' : 'closed';
  }

  getApproval(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; approvalRequestId: string }): PendingApproval | null {
    const pending = this.approvals.get(input.approvalRequestId);
    if (!pending) return null;
    if (Date.parse(pending.authority.expiresAt) <= Date.now()) {
      return null;
    }
    if (pending.sessionHandle !== input.sessionHandle || !sameTarget(pending.scope, input.scope)) return null;
    return pending;
  }

  expectApprovalResolution(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; approvalRequestId: string; authority: ApprovalAuthority; disposition: 'allow' | 'deny'; resolutionId: string; decider: { kind: 'owner'; principalId: string; credentialId: string } }): boolean {
    const pending = this.approvals.get(input.approvalRequestId);
    if (!pending || pending.expected || pending.sessionHandle !== input.sessionHandle || !sameTarget(pending.scope, input.scope) || !sameAuthority(pending.authority, input.authority)) return false;
    pending.expected = { authority: input.authority, disposition: input.disposition, resolutionId: input.resolutionId, decider: input.decider };
    return true;
  }

  abandonApproval(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; approvalRequestId: string }): void {
    const pending = this.approvals.get(input.approvalRequestId);
    if (pending && pending.sessionHandle === input.sessionHandle && sameTarget(pending.scope, input.scope)) this.deleteApproval(input.approvalRequestId);
  }

  private registerApproval(scope: RemoteLocalOwnerOperationScope, commandId: string, sessionHandle: string, authority: ApprovalAuthority): string {
    if (this.approvals.size >= MAX_SUBSCRIBERS) return 'apr_unavailable';
    const id = `apr_${randomBytes(18).toString('base64url')}`;
    this.approvals.set(id, { scope, commandId, sessionHandle, authority, requestDelivered: false }); return id;
  }
  private findApprovalId(scope: RemoteLocalOwnerOperationScope, commandId: string, sessionHandle: string, authority: ApprovalAuthority): string | null {
    for (const [id, pending] of this.approvals) if (pending.commandId === commandId && pending.sessionHandle === sessionHandle
      && sameScope(pending.scope, scope) && sameAuthority(pending.authority, authority)) return id;
    return null;
  }
  private scheduleApprovalExpiry(approvalRequestId: string, approvalStore: RemoteLocalApprovalStore, retryMs?: number): void {
    const pending = this.approvals.get(approvalRequestId); if (!pending) return;
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    const remaining = Date.parse(pending.authority.expiresAt) - Date.now();
    const delay = retryMs ?? Math.max(0, Math.min(remaining, MAX_EXPIRY_TIMER_MS));
    pending.expiryTimer = setTimeout(() => {
      pending.expiryTimer = undefined;
      if (this.approvals.get(approvalRequestId) !== pending) return;
      if (Date.parse(pending.authority.expiresAt) > Date.now()) this.scheduleApprovalExpiry(approvalRequestId, approvalStore);
      else void this.serializeLifecycle(pending.commandId, () => this.expireApproval(approvalRequestId, pending, approvalStore));
    }, delay);
    pending.expiryTimer.unref?.();
  }
  private scheduleCloseRetry(approvalRequestId: string, pending: PendingApproval, approvalStore: RemoteLocalApprovalStore,
    outcome: PendingCloseOutcome): void {
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    pending.expiryTimer = setTimeout(() => {
      pending.expiryTimer = undefined;
      if (this.approvals.get(approvalRequestId) === pending) void this.serializeLifecycle(pending.commandId,
        () => this.retryClose(approvalRequestId, pending, approvalStore, outcome));
    }, EXPIRY_RETRY_MS);
    pending.expiryTimer.unref?.();
  }
  private async retryClose(approvalRequestId: string, pending: PendingApproval, approvalStore: RemoteLocalApprovalStore,
    outcome: PendingCloseOutcome): Promise<void> {
    const closed = await approvalStore.closePending({ scope: pending.scope, sessionHandle: pending.sessionHandle, approvalRequestId, outcome });
    if (this.approvals.get(approvalRequestId) !== pending) return;
    if (closed.status === 'unavailable' || closed.status === 'not_found') {
      this.scheduleCloseRetry(approvalRequestId, pending, approvalStore, outcome); return;
    }
    this.deleteApproval(approvalRequestId);
  }
  private async expireApproval(approvalRequestId: string, pending: PendingApproval, approvalStore: RemoteLocalApprovalStore): Promise<void> {
    const closed = await approvalStore.closePending({ scope: pending.scope, sessionHandle: pending.sessionHandle, approvalRequestId, outcome: 'expired' });
    if (this.approvals.get(approvalRequestId) !== pending) return;
    if (closed.status === 'unavailable' || closed.status === 'not_found') {
      this.scheduleApprovalExpiry(approvalRequestId, approvalStore, EXPIRY_RETRY_MS); return;
    }
    if (closed.status === 'conflict') {
      this.deleteApproval(approvalRequestId); return;
    }
    const subscriber = this.subscribers.get(pending.commandId);
    if (subscriber && sameScope(subscriber.scope, pending.scope)) {
      try { subscriber.controller.enqueue(sse('approval_resolved', { commandId: pending.commandId, disposition: 'expired',
        resolutionId: `rla_${randomBytes(18).toString('base64url')}`, decidingPrincipalId: null, targetDeviceId: pending.authority.targetDeviceId })); }
      catch { if (subscriber.heartbeat) clearInterval(subscriber.heartbeat); this.subscribers.delete(pending.commandId); this.rememberLost(pending.commandId); }
    }
    this.deleteApproval(approvalRequestId);
  }
  private deleteApproval(approvalRequestId: string): void {
    const pending = this.approvals.get(approvalRequestId); if (pending?.expiryTimer) clearTimeout(pending.expiryTimer);
    this.approvals.delete(approvalRequestId);
  }
  private startHeartbeat(commandId: string, subscriber: Subscriber): void {
    if (subscriber.heartbeat) return;
    const heartbeat = setInterval(() => {
      const current = this.subscribers.get(commandId);
      if (!current || current !== subscriber) {
        clearInterval(heartbeat); if (current?.heartbeat === heartbeat) current.heartbeat = undefined; return;
      }
      // `desiredSize === null` is a closed controller. A non-positive size is
      // only one queued frame: proxy-backed SSE consumers can legitimately
      // hold that frame between pulls. Give that condition a bounded grace
      // window before treating it as a disconnected client.
      if (current.controller.desiredSize === null || current.controller.desiredSize < 0) {
        clearInterval(heartbeat); if (current.heartbeat === heartbeat) current.heartbeat = undefined;
        try { current.controller.close(); } catch { /* already closed */ }
        this.subscribers.delete(commandId); this.rememberLost(commandId); return;
      }
      if (current.controller.desiredSize <= 0) {
        current.backpressureTicks = (current.backpressureTicks ?? 0) + 1;
        if (current.backpressureTicks < SSE_BACKPRESSURE_GRACE_TICKS) return;
        clearInterval(heartbeat); if (current.heartbeat === heartbeat) current.heartbeat = undefined;
        try { current.controller.close(); } catch { /* already closed */ }
        this.subscribers.delete(commandId); this.rememberLost(commandId); return;
      }
      current.backpressureTicks = 0;
      try { current.controller.enqueue(encoder.encode(': keepalive\n\n')); }
      catch { clearInterval(heartbeat); this.subscribers.delete(commandId); this.rememberLost(commandId); }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    subscriber.heartbeat = heartbeat;
  }
  private consumeResolution(commandId: string, frame: Extract<RemoteLocalRelayFrame, { type: 'approval.resolved' }>): 'consumed' | 'duplicate' | 'invalid' {
    const key = resolutionKey(commandId, frame.authority);
    if (this.resolutions.has(key)) return 'duplicate';
    const matching = [...this.approvals].filter(([, pending]) => pending.commandId === commandId
      && pending.sessionHandle === frame.sessionHandle && sameAuthority(pending.authority, frame.authority));
    if (matching.length !== 1) return 'invalid';
    const expected = matching[0]![1].expected;
    if (!expected || expected.resolutionId !== frame.resolutionId || expected.disposition !== frame.disposition
      || !sameAuthority(expected.authority, frame.authority) || expected.decider.kind !== frame.decider.kind) return 'invalid';
    if (expected.decider.kind === 'owner' && (frame.decider.kind !== 'owner' || expected.decider.principalId !== frame.decider.principalId
      || expected.decider.credentialId !== frame.decider.credentialId)) return 'invalid';
    this.resolutions.add(key); this.resolutionOrder.push(key);
    if (this.resolutionOrder.length > MAX_SUBSCRIBERS) this.resolutions.delete(this.resolutionOrder.shift()!);
    for (const [id] of matching) this.deleteApproval(id);
    return 'consumed';
  }
  private async serializeLifecycle<T>(commandId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.lifecycleTails.get(commandId) ?? Promise.resolve(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => undefined).then(() => gate); this.lifecycleTails.set(commandId, tail);
    await prior.catch(() => undefined);
    try { return await work(); }
    finally { release(); if (this.lifecycleTails.get(commandId) === tail) this.lifecycleTails.delete(commandId); }
  }
  private rememberLost(commandId: string): void {
    if (this.lost.has(commandId)) return;
    this.lost.add(commandId); this.lostOrder.push(commandId);
    if (this.lostOrder.length > MAX_SUBSCRIBERS) this.lost.delete(this.lostOrder.shift()!);
  }
}

function resolutionKey(commandId: string, authority: ApprovalAuthority): string {
  const intent = `${authority.environmentAuthorizationId.length}:${authority.environmentAuthorizationId}${authority.bindingDigest.length}:${authority.bindingDigest}`;
  return `${commandId.length}:${commandId}${intent.length}:${intent}`;
}

function normalize(frame: RemoteLocalRelayFrame, commandId: string, approvalRequestId?: string): { event: string; data: unknown; terminal?: boolean } | null {
  if ('commandId' in frame && frame.commandId !== commandId) return null;
  switch (frame.type) {
    case 'event.text': return { event: 'text', data: { commandId, sequence: frame.sequence, text: frame.text } };
    case 'event.tool': return { event: 'tool', data: { commandId, sequence: frame.sequence, state: frame.tool } };
    case 'event.progress': return { event: 'progress', data: { commandId, sequence: frame.sequence, state: frame.state } };
    case 'terminal.receipt': return { event: 'terminal', data: { commandId, disposition: frame.disposition }, terminal: true };
    case 'approval.request': return approvalRequestId === 'apr_unavailable' ? null : { event: 'approval_required', data: { commandId, approvalRequestId } };
    case 'approval.resolved': return { event: 'approval_resolved', data: { commandId, disposition: frame.disposition, resolutionId: frame.resolutionId,
      decidingPrincipalId: frame.decider.kind === 'owner' ? frame.decider.principalId : null, targetDeviceId: frame.authority.targetDeviceId } };
    default: return null;
  }
}
