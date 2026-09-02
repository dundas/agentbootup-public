import { randomBytes } from 'node:crypto';
import type { RemoteLocalOwnerOperationScope } from './remote-local-owner-operations';
import { type FenceProjection, type RemoteLocalRelayFrame } from './remote-local-relay-protocol';
import { RemoteLocalRelayStateMachine } from './remote-local-relay-state-machine';
import { parseHostExtensionRelayFrame, type HostExtensionDescriptor } from './host-extension-relay-protocol';

export const REMOTE_LOCAL_CONNECTOR_LIMITS = Object.freeze({
  maxConnections: 128, maxTurnAttemptsPerMinute: 24, maxRateKeys: 4_096, maxExtensionReceipts: 256, maxInventoryRefreshMs: 10_000,
} as const);

type AdmissionClaim = { status: 'admitted'; fence: string } | { status: 'closed'; code: string };
type Entry = { connectionId: string; sessionId: string; fence: FenceProjection; relay: RemoteLocalRelayStateMachine; send: (frame: string) => boolean | void; close: () => void; claim: () => Promise<AdmissionClaim>; inventoryRevision?: number; inventoryRefreshId?: string | null; inventoryRefreshing: boolean; inventoryWaiters: Map<string, (status: 'updated' | 'host_offline') => void>; extensions: Map<string, HostExtensionDescriptor>; extensionCorrelations: Set<string>; extensionCorrelationOrder: string[]; extensionReceiptOrder: string[]; extensionReceipts: Map<string, 'delivered' | 'endpoint_rejected' | 'post_ingress_indeterminate'>; extensionWaiters: Map<string, (disposition: 'delivered' | 'endpoint_rejected' | 'post_ingress_indeterminate') => void> };
type TurnResult = { status: 'accepted' } | { status: 'host_offline' | 'no_active_session' | 'indeterminate' };
type InventoryRefreshResult = { status: 'updated'; revision: number; refreshId: string } | { status: 'host_offline' | 'timeout' };
type CommandScope = { scope: RemoteLocalOwnerOperationScope; commandId: string; sessionHandle: string };
type CommandInvalidation = CommandScope & { outcome: 'indeterminate' | 'session_ended' };
type StagedTurn = CommandScope & { message: string; beforeSend: () => Promise<boolean>; abort: () => Promise<void>; expiryTimer?: ReturnType<typeof setTimeout> };
export const DEFAULT_REMOTE_LOCAL_STAGED_TURN_TIMEOUT_MS = 30_000;
export const DEFAULT_REMOTE_LOCAL_INVENTORY_REFRESH_TIMEOUT_MS = 2_000;

function sameFence(left: FenceProjection, right: FenceProjection): boolean {
  return left.brainId === right.brainId && left.deviceId === right.deviceId && left.authorityRevision === right.authorityRevision;
}
function sameScope(left: RemoteLocalOwnerOperationScope, right: RemoteLocalOwnerOperationScope): boolean {
  return left.tenantId === right.tenantId && left.ownerPrincipalId === right.ownerPrincipalId && left.consumerId === right.consumerId
    && left.credentialId === right.credentialId && sameFence(scopeFence(left), scopeFence(right));
}
function scopeFence(scope: RemoteLocalOwnerOperationScope): FenceProjection {
  return { brainId: scope.brainId, deviceId: scope.deviceId, authorityRevision: scope.fence.capabilitiesRevision };
}
function registryKey(fence: FenceProjection): string { return `${fence.brainId.length}:${fence.brainId}${fence.deviceId.length}:${fence.deviceId}`; }
function rateKey(parts: readonly string[]): string { return parts.map((part) => `${part.length}:${part}`).join('|'); }
function handle(): string { return `rsh_${randomBytes(24).toString('base64url')}`; }
function inventoryRefreshId(): string { return `rir_${randomBytes(24).toString('base64url')}`; }

class TurnLimiter {
  private readonly entries = new Map<string, { startedAt: number; count: number }>();
  constructor(private readonly limit: number, private readonly maxKeys: number, private readonly now: () => number) {}
  consume(parts: readonly string[]): boolean {
    const now = this.now();
    if (!Number.isFinite(now)) return false;
    for (const [key, value] of this.entries) if (now - value.startedAt >= 60_000) this.entries.delete(key);
    const key = rateKey(parts); const prior = this.entries.get(key);
    if (!prior) { if (this.entries.size >= this.maxKeys) return false; this.entries.set(key, { startedAt: now, count: 1 }); return true; }
    if (prior.count >= this.limit) return false;
    prior.count += 1; return true;
  }
}

/**
 * In-memory, socket-subordinate registry for Task 4.3. It retains no command
 * payload or transcript and cannot outlive an admitted connector transport.
 */
export class RemoteLocalConnectorRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly byConnection = new Map<string, string>();
  private readonly commandScopes = new Map<string, CommandScope>();
  // A staged turn contains plaintext only in this socket-subordinate process and
  // only until its owner has attached the one live SSE stream. It is not a
  // reconnect queue and never survives connector loss or the bounded timeout.
  private readonly stagedTurns = new Map<string, StagedTurn>();
  private readonly detaching = new Set<string>();
  private readonly limiter: TurnLimiter;

  constructor(options: { maxConnections?: number; maxTurnAttemptsPerMinute?: number; maxRateKeys?: number; stagedTurnTimeoutMs?: number; inventoryRefreshTimeoutMs?: number; now?: () => number; onInvalidate?: (input: CommandInvalidation) => void | Promise<void>; onTerminal?: (input: Omit<CommandScope, 'sessionHandle'> & { disposition: 'completed' | 'interrupted' | 'indeterminate' }) => Promise<void>; onEvents?: (input: CommandScope & { events: readonly RemoteLocalRelayFrame[] }) => Promise<boolean | void> } = {}) {
    const maxConnections = options.maxConnections ?? REMOTE_LOCAL_CONNECTOR_LIMITS.maxConnections;
    const maxTurnAttempts = options.maxTurnAttemptsPerMinute ?? REMOTE_LOCAL_CONNECTOR_LIMITS.maxTurnAttemptsPerMinute;
    const maxRateKeys = options.maxRateKeys ?? REMOTE_LOCAL_CONNECTOR_LIMITS.maxRateKeys;
    const stagedTurnTimeoutMs = options.stagedTurnTimeoutMs ?? DEFAULT_REMOTE_LOCAL_STAGED_TURN_TIMEOUT_MS;
    const inventoryRefreshTimeoutMs = options.inventoryRefreshTimeoutMs ?? DEFAULT_REMOTE_LOCAL_INVENTORY_REFRESH_TIMEOUT_MS;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 4_096
      || !Number.isSafeInteger(maxTurnAttempts) || maxTurnAttempts < 1 || maxTurnAttempts > 1_000
      || !Number.isSafeInteger(maxRateKeys) || maxRateKeys < 1 || maxRateKeys > 100_000
      || !Number.isSafeInteger(stagedTurnTimeoutMs) || stagedTurnTimeoutMs < 1 || stagedTurnTimeoutMs > 300_000
      || !Number.isSafeInteger(inventoryRefreshTimeoutMs) || inventoryRefreshTimeoutMs < 1 || inventoryRefreshTimeoutMs > REMOTE_LOCAL_CONNECTOR_LIMITS.maxInventoryRefreshMs) throw new Error('RemoteLocalConnectorRegistry limits are invalid.');
    this.maxConnections = maxConnections;
    this.limiter = new TurnLimiter(maxTurnAttempts, maxRateKeys, options.now ?? Date.now);
    this.stagedTurnTimeoutMs = stagedTurnTimeoutMs;
    this.inventoryRefreshTimeoutMs = inventoryRefreshTimeoutMs;
    this.onTerminal = options.onTerminal;
    this.onEvents = options.onEvents;
    this.onInvalidate = options.onInvalidate;
  }
  private readonly maxConnections: number;
  private readonly stagedTurnTimeoutMs: number;
  private readonly inventoryRefreshTimeoutMs: number;
  private readonly onTerminal?: (input: Omit<CommandScope, 'sessionHandle'> & { disposition: 'completed' | 'interrupted' | 'indeterminate' }) => Promise<void>;
  private readonly onEvents?: (input: CommandScope & { events: readonly RemoteLocalRelayFrame[] }) => Promise<boolean | void>;
  private readonly onInvalidate?: (input: CommandInvalidation) => void | Promise<void>;

  attach(input: { connectionId: string; sessionId: string; fence: FenceProjection; relay: RemoteLocalRelayStateMachine; send: (frame: string) => boolean | void; close: () => void; claim: () => Promise<AdmissionClaim> }): boolean {
    if (!this.validEntry(input) || this.byConnection.has(input.connectionId) || this.entries.size >= this.maxConnections) return false;
    const key = registryKey(input.fence);
    // One device/fence gets one transport. Replacing it would let a racing stale
    // socket inherit online status; reject the new connection instead.
    if (this.entries.has(key)) return false;
    this.entries.set(key, { ...input, fence: { ...input.fence }, inventoryRefreshing: false, inventoryWaiters: new Map(), extensions: new Map(), extensionCorrelations: new Set(), extensionCorrelationOrder: [], extensionReceiptOrder: [], extensionReceipts: new Map(), extensionWaiters: new Map() }); this.byConnection.set(input.connectionId, key);
    return true;
  }

  async detach(connectionId: string): Promise<void> {
    if (this.detaching.has(connectionId)) return;
    const key = this.byConnection.get(connectionId); if (!key) return;
    this.detaching.add(connectionId);
    const entry = this.entries.get(key);
    const staged = [...this.stagedTurns.values()].filter((turn) => sameFence(scopeFence(turn.scope), entry?.fence ?? { brainId: '', deviceId: '', authorityRevision: '' }));
    for (const turn of staged) this.dropStaged(turn, true);
    // Capture every in-flight command before removing the routing entry.  The
    // socket close callback may already have called sessionEnded(), but that is
    // idempotent and its one-shot interruption evidence remains available.
    if (entry?.connectionId === connectionId) entry.relay.sessionEnded();
    const interrupted = entry?.connectionId === connectionId ? entry.relay.releaseInterruptedCommands() : [];
    const invalidations: Promise<void>[] = [];
    for (const item of interrupted) {
      const command = this.commandScopes.get(item.commandId);
      if (command) { try { invalidations.push(Promise.resolve(this.onInvalidate?.({ ...command, outcome: 'indeterminate' }))); } catch { /* invalidation remains fail-closed via routing removal */ } }
    }
    // Unpublish synchronously, before the first awaited durable settlement, so
    // no new operation can route through a closing connector.
    if (entry?.connectionId === connectionId) { this.resolveInventoryWaiters(entry, 'host_offline'); this.entries.delete(key); }
    this.byConnection.delete(connectionId);
    try {
      await Promise.allSettled(invalidations);
      if (entry?.connectionId === connectionId) await this.settleInterrupted(entry, false, interrupted);
    } finally {
      this.detaching.delete(connectionId);
    }
  }

  async observeConnector(connectionId: string): Promise<boolean> {
    const entry = this.entryForConnection(connectionId); if (!entry) return false;
    // Drain immediately into the live handoff callback. Frames are not retained
    // here; terminal delivery and receipt settlement share the same observation.
    for (const commandId of entry.relay.activeCommandIds()) {
      const events = entry.relay.drain(commandId); if (events.length === 0) continue;
      // A stream-lost command has already been terminalized durably and removed
      // from commandScopes. Keep draining its relay frames so its private backlog
      // cannot overflow and tear down unrelated commands on the shared connector.
      const command = this.commandScopes.get(commandId); if (!command) continue;
      // Revalidate feature/device/fence state after draining but before any
      // event, effect result, or terminal metadata is disclosed.
      if (await this.live(command.scope) !== entry) return false;
      let delivered: boolean | void; try { delivered = await this.onEvents?.({ ...command, events }); } catch { this.removeAndClose(entry); return false; }
      if (delivered === false) { this.commandScopes.delete(commandId); continue; }
      const terminal = events.find((event): event is Extract<RemoteLocalRelayFrame, { type: 'terminal.receipt' }> => event.type === 'terminal.receipt');
      if (!terminal) continue;
      this.commandScopes.delete(commandId);
      if (!this.onTerminal) continue;
      const disposition = terminal.disposition === 'completed' ? 'completed' as const
        : terminal.disposition === 'post_ingress_indeterminate' ? 'indeterminate' as const : 'interrupted' as const;
      try { await this.onTerminal({ scope: command.scope, commandId: command.commandId, disposition }); } catch { this.removeAndClose(entry); return false; }
    }
    /*
     * Compatibility cleanup for terminal frames observed by an earlier registry
     * version before the current drain callback became available.
     */
    for (const terminal of entry.relay.releaseTerminalCommands()) {
      const command = this.commandScopes.get(terminal.commandId); this.commandScopes.delete(terminal.commandId);
      if (!command || !this.onTerminal) continue;
      const disposition = terminal.disposition === 'completed' ? 'completed' as const
        : terminal.disposition === 'post_ingress_indeterminate' ? 'indeterminate' as const : 'interrupted' as const;
      try { await this.onTerminal({ scope: command.scope, commandId: command.commandId, disposition }); } catch { this.removeAndClose(entry); return false; }
    }
    if (!await this.settleInterrupted(entry, true)) { this.removeAndClose(entry); return false; }
    return true;
  }

  /** Binds only connector-proposed opaque references to fresh server handles. */
  bindInventory(connectionId: string): boolean {
    const entry = this.entryForConnection(connectionId); if (!entry) return false;
    const inventoryRevision = entry.relay.advertisedInventoryRevision();
    if (entry.inventoryRevision === inventoryRevision) return true;
    const sessions = entry.relay.advertisedSessions().map((session) => ({ connectorReference: session.connectorReference, handle: handle() }));
    const frame = JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence: entry.fence, sessions });
    const routed = entry.relay.receiveRelay(frame);
    if (routed.status !== 'accepted' || !this.send(entry, frame)) { this.removeAndClose(entry); return false; }
    entry.inventoryRevision = inventoryRevision;
    entry.inventoryRefreshId = entry.relay.advertisedInventoryRefreshId();
    if (entry.inventoryRefreshId) entry.inventoryWaiters.get(entry.inventoryRefreshId)?.('updated');
    return true;
  }

  async isLive(scope: RemoteLocalOwnerOperationScope): Promise<boolean> { return (await this.live(scope)) !== null; }
  async hostExtensions(scope: RemoteLocalOwnerOperationScope): Promise<{ status: 'ok'; extensions: readonly { serviceId: string; protocolVersion: 1; capabilities: readonly string[]; availability: 'available' | 'draining' }[] } | { status: 'host_offline' }> {
    const entry = await this.live(scope); if (!entry) return { status: 'host_offline' };
    return { status: 'ok', extensions: [...entry.extensions.values()].map((endpoint) => ({ serviceId: endpoint.serviceId, protocolVersion: endpoint.protocolVersion, capabilities: [...endpoint.capabilities], availability: endpoint.availability })) };
  }
  async hostExtensionReceipt(scope: RemoteLocalOwnerOperationScope, correlationId: string): Promise<{ status: 'ok'; disposition: 'delivered' | 'endpoint_rejected' | 'post_ingress_indeterminate' } | { status: 'host_offline' | 'not_found' }> {
    const entry = await this.live(scope); if (!entry) return { status: 'host_offline' };
    const disposition = entry.extensionReceipts.get(correlationId); return disposition ? { status: 'ok', disposition } : { status: 'not_found' };
  }
  /** Receives only the closed host-extension protocol after normal connector admission. */
  receiveHostExtension(connectionId: string, raw: string | Uint8Array): boolean {
    const entry = this.entryForConnection(connectionId); if (!entry) return false;
    const frame = parseHostExtensionRelayFrame(raw, 'connector_to_relay');
    if (!('fence' in frame) || !sameFence(entry.fence, frame.fence)) return false;
    if (frame.type === 'host_extension.register') {
      const existing = entry.extensions.get(frame.endpoint.serviceId);
      if (existing && (existing.protocolVersion !== frame.endpoint.protocolVersion || JSON.stringify(existing.capabilities) !== JSON.stringify(frame.endpoint.capabilities))) return false;
      entry.extensions.set(frame.endpoint.serviceId, Object.freeze({ ...frame.endpoint, capabilities: Object.freeze([...frame.endpoint.capabilities]) }));
      return true;
    }
    if ((frame.type === 'host_extension.event' || frame.type === 'host_extension.endpoint_rejected' || frame.type === 'host_extension.terminal_delivery')
      && entry.extensions.has(frame.serviceId) && entry.extensionCorrelations.has(frame.correlationId)) {
      if (frame.type === 'host_extension.terminal_delivery') { this.rememberExtensionReceipt(entry, frame.correlationId, frame.disposition); entry.extensionWaiters.get(frame.correlationId)?.(frame.disposition); entry.extensionWaiters.delete(frame.correlationId); }
      if (frame.type === 'host_extension.endpoint_rejected') { this.rememberExtensionReceipt(entry, frame.correlationId, 'endpoint_rejected'); entry.extensionWaiters.get(frame.correlationId)?.('endpoint_rejected'); entry.extensionWaiters.delete(frame.correlationId); }
      return true;
    }
    return false;
  }
  /** Exact brain/service routing only; ambiguity and offline state fail closed. */
  async sendHostExtension(input: { brainId: string; serviceId: string; correlationId: string; payload: unknown }): Promise<'delivered' | 'indeterminate' | 'unavailable'> {
    const candidates = [...this.entries.values()].filter((entry) => {
      const endpoint = entry.extensions.get(input.serviceId);
      return entry.fence.brainId === input.brainId && endpoint?.availability === 'available' && endpoint.capabilities.includes('opaque_request');
    });
    if (candidates.length !== 1) return 'unavailable';
    const entry = candidates[0]!;
    const claim = await entry.claim();
    if (claim.status !== 'admitted' || claim.fence !== entry.fence.authorityRevision || this.entries.get(registryKey(entry.fence)) !== entry) { this.removeAndClose(entry); return 'unavailable'; }
    if (entry.extensionCorrelations.has(input.correlationId)) return 'unavailable';
    const frame = JSON.stringify({ type: 'host_extension.request', protocolVersion: 1, fence: entry.fence, serviceId: input.serviceId, correlationId: input.correlationId, payload: input.payload });
    entry.extensionCorrelations.add(input.correlationId);
    entry.extensionCorrelationOrder.push(input.correlationId);
    while (entry.extensionCorrelationOrder.length > REMOTE_LOCAL_CONNECTOR_LIMITS.maxExtensionReceipts) entry.extensionCorrelations.delete(entry.extensionCorrelationOrder.shift()!);
    return await new Promise((resolve) => {
      // Arm receipt state before send: a local or test transport can answer
      // synchronously from send(), and that answer must not be lost.
      const timeout = setTimeout(() => { entry.extensionWaiters.delete(input.correlationId); this.rememberExtensionReceipt(entry, input.correlationId, 'post_ingress_indeterminate'); resolve('indeterminate'); }, 10_000); timeout.unref?.();
      entry.extensionWaiters.set(input.correlationId, (disposition) => { clearTimeout(timeout); resolve(disposition === 'delivered' ? 'delivered' : disposition === 'post_ingress_indeterminate' ? 'indeterminate' : 'unavailable'); });
      if (!this.send(entry, frame)) { clearTimeout(timeout); entry.extensionWaiters.delete(input.correlationId); entry.extensionCorrelations.delete(input.correlationId); resolve('unavailable'); }
    });
  }
  async hasActiveCommand(scope: RemoteLocalOwnerOperationScope, commandId: string): Promise<boolean> {
    const entry = await this.live(scope); return entry !== null && entry.relay.activeCommandIds().includes(commandId);
  }
  async subscribe<T>(scope: RemoteLocalOwnerOperationScope, commandId: string, open: () => T): Promise<{ status: 'open'; value: T } | { status: 'host_offline' | 'no_active_session' }> {
    const entry = await this.live(scope); if (!entry) return { status: 'host_offline' };
    // No await separates this check from registration, so serialized connector
    // delivery cannot terminalize the command between them.
    if (!entry.relay.activeCommandIds().includes(commandId)) return { status: 'no_active_session' };
    return { status: 'open', value: open() };
  }

  /**
   * Stages a live-device turn until the owner's SSE response has been created.
   * This is an arming barrier, not a queue: the plaintext remains process-local,
   * one staged turn may occupy a selected session, and timeout/detach abort it.
   */
  async stageTurn(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; commandId: string; message: string;
    beforeSend: () => Promise<boolean>; abort: () => Promise<void> }): Promise<TurnResult> {
    const entry = await this.live(input.scope); if (!entry) return { status: 'host_offline' };
    if (entry.inventoryRefreshing) return { status: 'indeterminate' };
    if (!this.limiter.consume(['brain', input.scope.brainId]) || !this.limiter.consume(['device', input.scope.deviceId]) || !this.limiter.consume(['consumer', input.scope.consumerId])) return { status: 'indeterminate' };
    if (this.entries.get(registryKey(entry.fence)) !== entry) return { status: 'host_offline' };
    if (!entry.relay.boundSessions().some((session) => session.handle === input.sessionHandle) || this.stagedTurns.has(input.commandId)
      || [...this.stagedTurns.values()].some((turn) => sameFence(scopeFence(turn.scope), entry.fence) && turn.sessionHandle === input.sessionHandle)) return { status: 'no_active_session' };
    const staged: StagedTurn = { ...input };
    staged.expiryTimer = setTimeout(() => this.dropStaged(staged, true), this.stagedTurnTimeoutMs);
    staged.expiryTimer.unref?.();
    this.stagedTurns.set(input.commandId, staged);
    return { status: 'accepted' };
  }

  /** Sends a previously staged turn only after its owner SSE stream is open. */
  async startStagedTurn(scope: RemoteLocalOwnerOperationScope, commandId: string): Promise<TurnResult> {
    const entry = await this.live(scope); if (!entry) return { status: 'host_offline' };
    const staged = this.stagedTurns.get(commandId);
    if (!staged || !sameScope(staged.scope, scope)) return entry.relay.activeCommandIds().includes(commandId) ? { status: 'accepted' } : { status: 'no_active_session' };
    if (this.entries.get(registryKey(entry.fence)) !== entry) return { status: 'host_offline' };
    const frame = JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence: entry.fence, commandId: staged.commandId, sessionHandle: staged.sessionHandle, message: staged.message });
    const routed = entry.relay.receiveRelay(frame);
    if (routed.status !== 'accepted') { this.dropStaged(staged, true); return routed.code === 'no_active_session' ? { status: 'no_active_session' } : { status: 'indeterminate' }; }
    this.dropStaged(staged, false);
    if (!await staged.beforeSend()) { this.removeAndClose(entry); await staged.abort(); return { status: 'indeterminate' }; }
    // Register immediately before send because a connector can answer a send
    // re-entrantly; before this point no native frame has been sent.
    this.commandScopes.set(commandId, { scope, commandId, sessionHandle: staged.sessionHandle });
    if (!this.send(entry, frame)) { this.commandScopes.delete(commandId); this.removeAndClose(entry); await staged.abort(); return { status: 'indeterminate' }; }
    return { status: 'accepted' };
  }

  async sessions(scope: RemoteLocalOwnerOperationScope): Promise<{ status: 'ok'; sessions: readonly { handle: string; alias: string; runtimeClass: string; availability: 'online' | 'away'; activityAt: string | null }[] } | { status: 'host_offline' }> {
    const entry = await this.live(scope); if (!entry) return { status: 'host_offline' };
    return { status: 'ok', sessions: entry.relay.boundSessions().map((session) => ({ handle: session.handle, alias: session.alias,
      runtimeClass: session.runtimeClass, availability: session.availability === 'online' ? 'online' as const : 'away' as const, activityAt: null })) };
  }

  /**
   * Requests one current-inventory observation from the already admitted
   * connector. This is deliberately neither a queue nor a retry: it waits for
   * one strictly newer, locally bound revision on this exact socket, then
   * reports a fail-closed result.
   */
  async refreshSessions(scope: RemoteLocalOwnerOperationScope): Promise<{ status: 'ok'; sessions: readonly { handle: string; alias: string; runtimeClass: string; availability: 'online' | 'away'; activityAt: string | null }[] } | { status: 'host_offline' | 'indeterminate' }> {
    const entry = await this.live(scope); if (!entry) return { status: 'host_offline' };
    // Older admitted connectors omit this capability. Do not probe them with a
    // newer frame: preserve their live socket and fail the owner read closed.
    if (!entry.relay.inventoryRefreshCapable()) return { status: 'indeterminate' };
    // A refresh invalidates bindings by design. Never send one while any live
    // or staged turn could depend on those bindings; do not queue the read.
    if (entry.inventoryRefreshing || entry.relay.activeCommandIds().length > 0 || [...this.stagedTurns.values()].some((turn) => sameFence(scopeFence(turn.scope), entry.fence))) return { status: 'indeterminate' };
    const priorRevision = entry.relay.advertisedInventoryRevision();
    const updated = await this.requestInventory(entry, priorRevision);
    if (updated.status === 'host_offline') return { status: 'host_offline' };
    if (updated.status !== 'updated' || await this.live(scope) !== entry
      || !entry.relay.inventoryRefreshCapable() || entry.relay.advertisedInventoryRevision() !== updated.revision || entry.inventoryRefreshId !== updated.refreshId) return { status: 'indeterminate' };
    return { status: 'ok', sessions: entry.relay.boundSessions().map((session) => ({ handle: session.handle, alias: session.alias,
      runtimeClass: session.runtimeClass, availability: session.availability === 'online' ? 'online' as const : 'away' as const, activityAt: null })) };
  }

  async turn(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; commandId: string; message: string; beforeSend: () => Promise<boolean> }): Promise<TurnResult> {
    const entry = await this.live(input.scope); if (!entry) return { status: 'host_offline' };
    if (entry.inventoryRefreshing) return { status: 'indeterminate' };
    if (!this.limiter.consume(['brain', input.scope.brainId]) || !this.limiter.consume(['device', input.scope.deviceId]) || !this.limiter.consume(['consumer', input.scope.consumerId])) return { status: 'indeterminate' };
    // The claim above may have awaited durable authority. Verify the registry
    // object has not been detached or replaced before the one-frame send.
    if (this.entries.get(registryKey(entry.fence)) !== entry) return { status: 'host_offline' };
    const frame = JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence: entry.fence, commandId: input.commandId, sessionHandle: input.sessionHandle, message: input.message });
    const routed = entry.relay.receiveRelay(frame);
    if (routed.status !== 'accepted') return routed.code === 'no_active_session' ? { status: 'no_active_session' } : { status: 'indeterminate' };
    this.commandScopes.set(input.commandId, { scope: input.scope, commandId: input.commandId, sessionHandle: input.sessionHandle });
    if (!await input.beforeSend()) { this.removeAndClose(entry); return { status: 'indeterminate' }; }
    // A synchronous send failure occurs after local ingress has been claimed;
    // close and make the caller treat it as indeterminate, never enqueue/retry.
    if (!this.send(entry, frame)) { this.removeAndClose(entry); return { status: 'indeterminate' }; }
    return { status: 'accepted' };
  }

  async approval(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; authority: import('./remote-local-relay-protocol').ApprovalAuthority; disposition: 'allow' | 'deny'; decisionIdempotencyKey: string; decider: { kind: 'owner'; principalId: string; credentialId: string }; resolutionId: string }): Promise<TurnResult> {
    const entry = await this.live(input.scope); if (!entry) return { status: 'host_offline' };
    if (input.decider.principalId !== input.scope.ownerPrincipalId || input.decider.credentialId !== input.scope.credentialId) return { status: 'indeterminate' };
    const frame = JSON.stringify({ type: 'approval.decision', protocolVersion: 1, fence: entry.fence, sessionHandle: input.sessionHandle,
      authority: input.authority, disposition: input.disposition, decisionIdempotencyKey: input.decisionIdempotencyKey,
      decider: input.decider, resolutionId: input.resolutionId });
    const routed = entry.relay.receiveRelay(frame);
    if (routed.status !== 'accepted') return routed.code === 'no_active_session' ? { status: 'no_active_session' } : { status: 'indeterminate' };
    if (!this.send(entry, frame)) { this.removeAndClose(entry); return { status: 'indeterminate' }; }
    return { status: 'accepted' };
  }

  private async live(scope: RemoteLocalOwnerOperationScope): Promise<Entry | null> {
    const expected = scopeFence(scope); const entry = this.entries.get(registryKey(expected));
    if (!entry || !sameFence(entry.fence, expected)) return null;
    let claim: AdmissionClaim; try { claim = await entry.claim(); } catch { this.removeAndClose(entry); return null; }
    if (claim.status !== 'admitted' || claim.fence !== expected.authorityRevision || this.entries.get(registryKey(expected)) !== entry) { this.removeAndClose(entry); return null; }
    return entry;
  }
  private send(entry: Entry, frame: string): boolean { try { return entry.send(frame) !== false; } catch { return false; } }
  private requestInventory(entry: Entry, priorRevision: number): Promise<InventoryRefreshResult> {
    return new Promise((resolve) => {
      entry.inventoryRefreshing = true;
      const refreshId = inventoryRefreshId();
      let settled = false;
      const finish = (result: InventoryRefreshResult) => {
        if (settled) return; settled = true; entry.inventoryRefreshing = false; clearTimeout(timeout); entry.inventoryWaiters.delete(refreshId); resolve(result);
      };
      const waiter = (status: 'updated' | 'host_offline') => {
        if (status === 'host_offline') return finish({ status });
        if (entry.inventoryRevision !== undefined && entry.inventoryRevision > priorRevision && entry.inventoryRefreshId === refreshId) finish({ status: 'updated', revision: entry.inventoryRevision, refreshId });
      };
      const timeout = setTimeout(() => finish({ status: 'timeout' }), this.inventoryRefreshTimeoutMs); timeout.unref?.();
      entry.inventoryWaiters.set(refreshId, waiter);
      const frame = JSON.stringify({ type: 'session.inventory.request', protocolVersion: 1, fence: entry.fence, refreshId });
      if (entry.relay.receiveRelay(frame).status !== 'accepted' || !this.send(entry, frame)) { this.removeAndClose(entry); finish({ status: 'host_offline' }); return; }
      // send() is permitted to be re-entrant in tests/transports.
      waiter('updated');
    });
  }
  private resolveInventoryWaiters(entry: Entry, status: 'updated' | 'host_offline'): void {
    for (const waiter of entry.inventoryWaiters.values()) waiter(status);
  }
  private rememberExtensionReceipt(entry: Entry, correlationId: string, disposition: 'delivered' | 'endpoint_rejected' | 'post_ingress_indeterminate'): void {
    if (!entry.extensionReceipts.has(correlationId)) entry.extensionReceiptOrder.push(correlationId);
    entry.extensionReceipts.set(correlationId, disposition);
    while (entry.extensionReceiptOrder.length > REMOTE_LOCAL_CONNECTOR_LIMITS.maxExtensionReceipts) {
      const retired = entry.extensionReceiptOrder.shift(); if (retired) { entry.extensionReceipts.delete(retired); entry.extensionCorrelations.delete(retired); }
    }
  }
  private async settleInterrupted(entry: Entry, discloseSessionEnd: boolean, interrupted = entry.relay.releaseInterruptedCommands()): Promise<boolean> {
    for (const item of interrupted) {
      const command = this.commandScopes.get(item.commandId); this.commandScopes.delete(item.commandId);
      if (!command) continue;
      if (discloseSessionEnd && item.disposition === 'session_ended' && this.onEvents) {
        try { await this.onInvalidate?.({ ...command, outcome: 'session_ended' }); } catch { return false; }
        if (await this.live(command.scope) !== entry) {
          try { await this.onInvalidate?.({ ...command, outcome: 'indeterminate' }); } catch { /* fail closed below */ }
          if (this.onTerminal) { try { await this.onTerminal({ scope: command.scope, commandId: command.commandId, disposition: 'indeterminate' }); } catch { return false; } }
          continue;
        }
        const event: RemoteLocalRelayFrame = { type: 'terminal.receipt', protocolVersion: 1, fence: entry.fence,
          commandId: item.commandId, sessionHandle: item.sessionHandle, disposition: 'session_ended' };
        try { await this.onEvents({ ...command, events: [event] }); } catch { return false; }
      }
      if (this.onTerminal) { try { await this.onTerminal({ scope: command.scope, commandId: command.commandId, disposition: 'indeterminate' }); } catch { return false; } }
    }
    return true;
  }
  private removeAndClose(entry: Entry): void {
    this.resolveInventoryWaiters(entry, 'host_offline');
    void this.detach(entry.connectionId);
    try { entry.close(); } catch { /* socket is no longer usable */ }
  }
  private dropStaged(staged: StagedTurn, abort: boolean): void {
    if (this.stagedTurns.get(staged.commandId) !== staged) return;
    this.stagedTurns.delete(staged.commandId);
    if (staged.expiryTimer) clearTimeout(staged.expiryTimer);
    if (abort) void staged.abort();
  }
  private entryForConnection(connectionId: string): Entry | null { const key = this.byConnection.get(connectionId); const entry = key ? this.entries.get(key) : undefined; return entry?.connectionId === connectionId ? entry : null; }
  private validEntry(value: unknown): value is Entry {
    return !!value && typeof value === 'object' && typeof (value as Entry).connectionId === 'string' && typeof (value as Entry).sessionId === 'string'
      && typeof (value as Entry).send === 'function' && typeof (value as Entry).close === 'function' && typeof (value as Entry).claim === 'function'
      && !!(value as Entry).relay && typeof (value as Entry).relay.receiveRelay === 'function'
      && !!(value as Entry).fence && typeof (value as Entry).fence.brainId === 'string' && typeof (value as Entry).fence.deviceId === 'string' && typeof (value as Entry).fence.authorityRevision === 'string';
  }
}
