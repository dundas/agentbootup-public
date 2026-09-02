import { parseRemoteLocalRelayFrame, REMOTE_LOCAL_RELAY_LIMITS, type FenceProjection, type RemoteLocalRelayFrame, type SessionAdvertisement } from './remote-local-relay-protocol';

export const REMOTE_LOCAL_RELAY_STATE_LIMITS = { maxQueuedEvents: 32, maxQueuedBytesPerSession: 65_536, maxCompletedCommands: 256 } as const;
type Result = { status: 'accepted'; frame?: RemoteLocalRelayFrame } | { status: 'closed'; code: 'invalid_frame' | 'fence_changed' | 'no_active_session' | 'concurrency_exceeded' | 'session_ended' };
type CloseCode = Extract<Result, { status: 'closed' }>['code'];
type Command = { handle: string; events: RemoteLocalRelayFrame[]; eventBytes: number; nextSequence: number; terminal: boolean };
type InterruptedCommand = { commandId: string; sessionHandle: string; disposition: 'session_ended' | 'post_ingress_indeterminate' };

function sameFence(left: FenceProjection, right: FenceProjection): boolean { return left.brainId === right.brainId && left.deviceId === right.deviceId && left.authorityRevision === right.authorityRevision; }
function fenceFrame(frame: RemoteLocalRelayFrame): frame is Extract<RemoteLocalRelayFrame, { fence: FenceProjection }> { return 'fence' in frame; }
function bytes(frame: RemoteLocalRelayFrame): number { return Buffer.byteLength(JSON.stringify(frame), 'utf8'); }

/**
 * Task 3.3's ephemeral, transport-neutral WSS state owner. It never starts a
 * runtime and never accepts arbitrary bytes: callers must pass frozen frames.
 */
export class RemoteLocalRelayStateMachine {
  private readonly advertised = new Map<string, SessionAdvertisement>();
  private readonly handles = new Map<string, string>();
  private readonly handleByReference = new Map<string, string>();
  private readonly commands = new Map<string, Command>();
  private readonly commandByHandle = new Map<string, string>();
  private readonly completed = new Set<string>();
  private readonly completedOrder: string[] = [];
  private readonly interrupted: InterruptedCommand[] = [];
  private inventoryRevision = 0;
  private inventoryRefreshId: string | null = null;
  private inventoryRefreshSupported = false;
  private closed = false;

  constructor(private readonly fence: FenceProjection) {}

  receiveConnector(raw: string | Uint8Array): Result {
    const frame = parseRemoteLocalRelayFrame(raw, 'connector_to_relay');
    if (frame.type === 'protocol.error' || !fenceFrame(frame) || !sameFence(frame.fence, this.fence)) return this.close(frame.type === 'protocol.error' ? 'invalid_frame' : 'fence_changed');
    if (this.closed) return { status: 'closed', code: 'session_ended' };
    if (frame.type === 'heartbeat' || frame.type === 'availability') return { status: 'accepted' };
    if (frame.type === 'session.inventory.propose') {
      this.advertised.clear(); this.handles.clear(); this.endCommands('session_ended'); this.inventoryRevision += 1; this.inventoryRefreshId = frame.refreshId ?? null; this.inventoryRefreshSupported = frame.refreshCapability === 'correlated-v1';
      for (const session of frame.sessions) this.advertised.set(session.connectorReference, { ...session });
      return { status: 'accepted' };
    }
    if (frame.type === 'event.text' || frame.type === 'event.tool' || frame.type === 'event.progress') return this.event(frame);
    // Approval frames deliberately carry their complete environment authority,
    // not a relay-selected command ID. Their live session handle maps them to
    // the sole current command for that handle without inventing a second
    // authority or accepting approvals outside an active continuation.
    if (frame.type === 'approval.request' || frame.type === 'approval.resolved') return this.approval(frame);
    if (frame.type === 'terminal.receipt') return this.terminal(frame);
    return this.close('invalid_frame');
  }

  receiveRelay(raw: string | Uint8Array): Result {
    const frame = parseRemoteLocalRelayFrame(raw, 'relay_to_connector');
    if (frame.type === 'protocol.error' || !fenceFrame(frame) || !sameFence(frame.fence, this.fence)) return this.close(frame.type === 'protocol.error' ? 'invalid_frame' : 'fence_changed');
    if (this.closed) return { status: 'closed', code: 'session_ended' };
    if (frame.type === 'heartbeat' || frame.type === 'session.inventory.request') return { status: 'accepted', frame };
    if (frame.type === 'session.inventory.bind') {
      if (!frame.sessions.every((binding) => this.advertised.has(binding.connectorReference)) || frame.sessions.some((binding) => this.handles.has(binding.handle) || this.handleByReference.has(binding.connectorReference))) return this.close('no_active_session');
      for (const binding of frame.sessions) { this.handles.set(binding.handle, binding.connectorReference); this.handleByReference.set(binding.connectorReference, binding.handle); }
      return { status: 'accepted', frame };
    }
    if (frame.type === 'turn.request') {
      if (!this.handles.has(frame.sessionHandle)) return { status: 'closed', code: 'no_active_session' };
      if (this.commands.has(frame.commandId) || this.completed.has(frame.commandId) || this.commandByHandle.has(frame.sessionHandle)) return { status: 'closed', code: 'concurrency_exceeded' };
      if (this.commands.size >= REMOTE_LOCAL_RELAY_LIMITS.maxBrainInFlight) return { status: 'closed', code: 'concurrency_exceeded' };
      this.commands.set(frame.commandId, { handle: frame.sessionHandle, events: [], eventBytes: 0, nextSequence: 0, terminal: false });
      this.commandByHandle.set(frame.sessionHandle, frame.commandId);
      return { status: 'accepted', frame };
    }
    if (frame.type === 'approval.decision') {
      const commandId = this.commandByHandle.get(frame.sessionHandle);
      const command = commandId ? this.commands.get(commandId) : undefined;
      return command && !command.terminal ? { status: 'accepted', frame } : { status: 'closed', code: 'no_active_session' };
    }
    if (frame.type === 'turn.cancel') { const command = this.commands.get(frame.commandId); return command?.handle === frame.sessionHandle && !command.terminal ? { status: 'accepted', frame } : { status: 'closed', code: 'no_active_session' }; }
    return this.close('invalid_frame');
  }

  drain(commandId: string): RemoteLocalRelayFrame[] { const command = this.commands.get(commandId); if (!command) return []; const events = command.events.splice(0); command.eventBytes = 0; if (command.terminal) { this.commands.delete(commandId); this.commandByHandle.delete(command.handle); this.rememberCompleted(commandId); } return events; }
  /** Trusted, redacted inventory projection for the socket-bound registry only. */
  advertisedSessions(): readonly SessionAdvertisement[] { return [...this.advertised.values()].map((session) => ({ ...session })); }
  advertisedInventoryRevision(): number { return this.inventoryRevision; }
  /** The one-shot owner-read correlation associated with the current revision. */
  advertisedInventoryRefreshId(): string | null { return this.inventoryRefreshId; }
  inventoryRefreshCapable(): boolean { return this.inventoryRefreshSupported; }
  boundSessions(): readonly (SessionAdvertisement & { handle: string })[] {
    return [...this.handles.entries()].flatMap(([handle, reference]) => {
      const session = this.advertised.get(reference); return session ? [{ ...session, handle }] : [];
    });
  }
  /** Ephemeral command identifiers only; callers still use drain() to consume frames. */
  activeCommandIds(): readonly string[] { return [...this.commands.keys()]; }
  /** One-shot interruption evidence retained across command-map invalidation. */
  releaseInterruptedCommands(): readonly InterruptedCommand[] { return this.interrupted.splice(0); }
  /** Task 4.3 deliberately discards pre-SSE buffered events at terminal release. */
  releaseTerminalCommands(): readonly { commandId: string; disposition: 'completed' | 'cancelled' | 'session_ended' | 'post_ingress_indeterminate' }[] {
    const released: { commandId: string; disposition: 'completed' | 'cancelled' | 'session_ended' | 'post_ingress_indeterminate' }[] = [];
    for (const [commandId, command] of this.commands) {
      const terminal = command.events.find((event): event is Extract<RemoteLocalRelayFrame, { type: 'terminal.receipt' }> => event.type === 'terminal.receipt');
      if (!command.terminal || !terminal) continue;
      this.commands.delete(commandId); this.commandByHandle.delete(command.handle); this.rememberCompleted(commandId);
      released.push({ commandId, disposition: terminal.disposition });
    }
    return released;
  }
  sessionEnded(): void { this.closed = true; this.advertised.clear(); this.handles.clear(); this.endCommands('post_ingress_indeterminate'); }
  private event(frame: Extract<RemoteLocalRelayFrame, { commandId: string; sessionHandle: string; sequence: number }>): Result {
    const command = this.commands.get(frame.commandId);
    if (!command || command.handle !== frame.sessionHandle || command.terminal) return this.close('no_active_session');
    if (frame.sequence !== command.nextSequence) return this.close('invalid_frame');
    const size = bytes(frame);
    if (command.events.length >= REMOTE_LOCAL_RELAY_STATE_LIMITS.maxQueuedEvents || command.eventBytes + size > REMOTE_LOCAL_RELAY_STATE_LIMITS.maxQueuedBytesPerSession) return this.interruptFlood(frame.commandId, command);
    command.events.push(frame); command.eventBytes += size; command.nextSequence += 1;
    return { status: 'accepted' };
  }
  private terminal(frame: Extract<RemoteLocalRelayFrame, { type: 'terminal.receipt' }>): Result {
    const command = this.commands.get(frame.commandId);
    if (!command || command.handle !== frame.sessionHandle || command.terminal) return this.close('no_active_session');
    const size = bytes(frame);
    if (command.events.length >= REMOTE_LOCAL_RELAY_STATE_LIMITS.maxQueuedEvents || command.eventBytes + size > REMOTE_LOCAL_RELAY_STATE_LIMITS.maxQueuedBytesPerSession) {
      command.events.length = 0; command.eventBytes = 0;
    }
    command.events.push(frame); command.eventBytes += size; command.terminal = true;
    return { status: 'accepted' };
  }
  private approval(frame: Extract<RemoteLocalRelayFrame, { type: 'approval.request' | 'approval.resolved' }>): Result {
    const commandId = this.commandByHandle.get(frame.sessionHandle);
    const command = commandId ? this.commands.get(commandId) : undefined;
    if (!command || command.terminal) return this.close('no_active_session');
    const size = bytes(frame);
    if (command.events.length >= REMOTE_LOCAL_RELAY_STATE_LIMITS.maxQueuedEvents || command.eventBytes + size > REMOTE_LOCAL_RELAY_STATE_LIMITS.maxQueuedBytesPerSession) return this.interruptFlood(commandId!, command);
    command.events.push(frame); command.eventBytes += size;
    return { status: 'accepted' };
  }
  private endCommands(disposition: InterruptedCommand['disposition']): void {
    for (const [commandId, command] of this.commands) this.interrupted.push({ commandId, sessionHandle: command.handle, disposition });
    this.commands.clear(); this.commandByHandle.clear(); this.handleByReference.clear();
  }
  private interruptFlood(commandId: string, command: Command): Result {
    const terminal: Extract<RemoteLocalRelayFrame, { type: 'terminal.receipt' }> = { type: 'terminal.receipt', protocolVersion: 1,
      fence: this.fence, commandId, sessionHandle: command.handle, disposition: 'post_ingress_indeterminate' };
    command.events = [terminal]; command.eventBytes = bytes(terminal); command.terminal = true;
    return { status: 'accepted' };
  }
  private rememberCompleted(commandId: string): void { this.completed.add(commandId); this.completedOrder.push(commandId); if (this.completedOrder.length > REMOTE_LOCAL_RELAY_STATE_LIMITS.maxCompletedCommands) this.completed.delete(this.completedOrder.shift()!); }
  private close(code: CloseCode): Result { this.sessionEnded(); return { status: 'closed', code }; }
}
