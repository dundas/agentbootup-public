import { describe, expect, test } from 'bun:test';
import { RemoteLocalConnectorRegistry } from '../lib/remote-local-connector-registry';
import { RemoteLocalRelayStateMachine } from '../lib/remote-local-relay-state-machine';

const fence = { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' };
const scope = { tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a', deviceId: 'device-a', fence: { capabilitiesRevision: 'fence-a' } } as never;
const handle = 'rsh_abcdefghijklmnopqrstuvwxyz';
const wire = (value: unknown) => JSON.stringify(value);

function fixture(options: { send?: () => boolean | void; claim?: () => Promise<{ status: 'admitted'; fence: string } | { status: 'closed'; code: string }>; now?: () => number; maxTurnAttemptsPerMinute?: number; onTerminal?: (input: { scope: typeof scope; commandId: string; disposition: 'completed' | 'interrupted' | 'indeterminate' }) => Promise<void>; onEvents?: (input: { commandId: string }) => Promise<boolean | void> } = {}) {
  const registry = new RemoteLocalConnectorRegistry({ now: options.now, maxTurnAttemptsPerMinute: options.maxTurnAttemptsPerMinute ?? 3, onTerminal: options.onTerminal, onEvents: options.onEvents });
  const relay = new RemoteLocalRelayStateMachine(fence); const sent: unknown[] = []; let closed = 0;
  const attached = registry.attach({ connectionId: 'connection-a', sessionId: 'session-a', fence, relay,
    send: (frame) => { sent.push(JSON.parse(frame)); return options.send?.() ?? true; }, close: () => { closed += 1; },
    claim: options.claim ?? (async () => ({ status: 'admitted' as const, fence: 'fence-a' })) });
  expect(attached).toBe(true);
  return { registry, relay, sent, closed: () => closed };
}

function advertise(f: ReturnType<typeof fixture>) {
  expect(f.relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence,
    sessions: [{ connectorReference: 'sar_abcdefghijklmnop', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }], refreshCapability: 'correlated-v1' }))).toEqual({ status: 'accepted' });
  expect(f.registry.bindInventory('connection-a')).toBe(true);
  expect(f.sent[0]).toMatchObject({ type: 'session.inventory.bind', sessions: [{ connectorReference: 'sar_abcdefghijklmnop' }] });
}

describe('RemoteLocalConnectorRegistry', () => {
  test('routes a host extension only after exact live registration and never selects an ambiguous device', async () => {
    const f = fixture();
    expect(await f.registry.sendHostExtension({ brainId: 'brain-a', serviceId: 'example.local-extension/v1', correlationId: 'ext_abcdefghijklmnop', payload: { opaque: true } })).toBe('unavailable');
    expect(f.registry.receiveHostExtension('connection-a', wire({ type: 'host_extension.register', protocolVersion: 1, fence,
      endpoint: { serviceId: 'example.local-extension/v1', protocolVersion: 1, capabilities: ['opaque_request', 'opaque_event', 'terminal_delivery'], availability: 'available' } }))).toBe(true);
    const delivery = f.registry.sendHostExtension({ brainId: 'brain-a', serviceId: 'example.local-extension/v1', correlationId: 'ext_abcdefghijklmnop', payload: { opaque: true } });
    await Promise.resolve();
    expect(f.sent.at(-1)).toEqual(expect.objectContaining({ type: 'host_extension.request', serviceId: 'example.local-extension/v1', payload: { opaque: true } }));
    expect(f.registry.receiveHostExtension('connection-a', wire({ type: 'host_extension.terminal_delivery', protocolVersion: 1, fence,
      serviceId: 'example.local-extension/v1', correlationId: 'ext_abcdefghijklmnop', disposition: 'delivered', evidence: 'transport_delivery_only' }))).toBe(true);
    expect(await delivery).toBe('delivered');
  });
  test('does not route a request to an endpoint that did not advertise opaque_request', async () => {
    const f = fixture();
    expect(f.registry.receiveHostExtension('connection-a', wire({ type: 'host_extension.register', protocolVersion: 1, fence,
      endpoint: { serviceId: 'example.local-extension/v1', protocolVersion: 1, capabilities: ['opaque_event'], availability: 'available' } }))).toBe(true);
    expect(await f.registry.sendHostExtension({ brainId: 'brain-a', serviceId: 'example.local-extension/v1', correlationId: 'ext_abcdefghijklmnop', payload: { opaque: true } })).toBe('unavailable');
  });
  test('arms the receipt waiter before a re-entrant extension terminal and withdraws a draining endpoint', async () => {
    let registry: RemoteLocalConnectorRegistry; let sent = false;
    registry = new RemoteLocalConnectorRegistry(); const relay = new RemoteLocalRelayStateMachine(fence);
    expect(registry.attach({ connectionId: 'connection-a', sessionId: 'session-a', fence, relay, close: () => {}, claim: async () => ({ status: 'admitted', fence: 'fence-a' }), send: (raw) => {
      const frame = JSON.parse(raw) as { type: string; correlationId?: string };
      if (frame.type === 'host_extension.request' && !sent) { sent = true; registry.receiveHostExtension('connection-a', wire({ type: 'host_extension.terminal_delivery', protocolVersion: 1, fence, serviceId: 'example.local-extension/v1', correlationId: frame.correlationId, disposition: 'delivered', evidence: 'transport_delivery_only' })); }
      return true;
    } })).toBe(true);
    const endpoint = { serviceId: 'example.local-extension/v1', protocolVersion: 1, capabilities: ['opaque_request', 'opaque_event', 'terminal_delivery'], availability: 'available' };
    expect(registry.receiveHostExtension('connection-a', wire({ type: 'host_extension.register', protocolVersion: 1, fence, endpoint }))).toBe(true);
    expect(await registry.sendHostExtension({ brainId: 'brain-a', serviceId: endpoint.serviceId, correlationId: 'rah_reentrant-terminal-0001', payload: { opaque: true } })).toBe('delivered');
    expect(registry.receiveHostExtension('connection-a', wire({ type: 'host_extension.register', protocolVersion: 1, fence, endpoint: { ...endpoint, availability: 'draining' } }))).toBe(true);
    expect(await registry.sendHostExtension({ brainId: 'brain-a', serviceId: endpoint.serviceId, correlationId: 'rah_after-drain-000000001', payload: { opaque: true } })).toBe('unavailable');
  });
  test('does not route offline, stale, or duplicate device connections', async () => {
    const registry = new RemoteLocalConnectorRegistry();
    expect((await registry.turn({ scope, sessionHandle: handle, commandId: 'command-a', message: 'hello', beforeSend: async () => true })).status).toBe('host_offline');
    const first = fixture({ claim: async () => ({ status: 'closed' as const, code: 'fence_changed' }) });
    const duplicate = new RemoteLocalRelayStateMachine(fence);
    expect(first.registry.attach({ connectionId: 'connection-b', sessionId: 'session-b', fence, relay: duplicate, send: () => true, close: () => {}, claim: async () => ({ status: 'admitted', fence: 'fence-a' }) })).toBe(false);
    expect((await first.registry.turn({ scope, sessionHandle: handle, commandId: 'command-a', message: 'hello', beforeSend: async () => true })).status).toBe('host_offline');
    expect(first.closed()).toBe(1);
  });

  test('binds only advertised opaque references and sends one bounded turn without queueing', async () => {
    const f = fixture(); advertise(f);
    const binding = f.sent[0] as { sessions: { handle: string }[] };
    expect(await f.registry.sessions(scope)).toEqual({ status: 'ok', sessions: [{ handle: binding.sessions[0]!.handle, alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activityAt: null }] });
    const result = await f.registry.turn({ scope, sessionHandle: binding.sessions[0]!.handle, commandId: 'command-a', message: 'hello', beforeSend: async () => true });
    expect(result).toEqual({ status: 'accepted' });
    expect(f.sent[1]).toMatchObject({ type: 'turn.request', commandId: 'command-a', message: 'hello' });
    expect((await f.registry.turn({ scope, sessionHandle: binding.sessions[0]!.handle, commandId: 'command-b', message: 'again', beforeSend: async () => true })).status).toBe('indeterminate');
  });

  test('arms a staged turn only after its owner stream is attached', async () => {
    const f = fixture(); advertise(f);
    const binding = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    const lifecycle: string[] = [];
    expect(await f.registry.stageTurn({ scope, sessionHandle: binding, commandId: 'command-staged', message: 'wait for stream',
      beforeSend: async () => { lifecycle.push('ingress'); return true; }, abort: async () => { lifecycle.push('abort'); } })).toEqual({ status: 'accepted' });
    expect(f.sent.filter((frame) => (frame as { type?: string }).type === 'turn.request')).toEqual([]);
    expect(lifecycle).toEqual([]);
    expect(await f.registry.startStagedTurn(scope, 'command-staged')).toEqual({ status: 'accepted' });
    expect(lifecycle).toEqual(['ingress']);
    expect(f.sent.at(-1)).toMatchObject({ type: 'turn.request', commandId: 'command-staged', message: 'wait for stream' });
  });

  test('returns an empty inventory and never starts or dispatches to a dead handle', async () => {
    const f = fixture();
    expect(f.relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence, sessions: [] }))).toEqual({ status: 'accepted' });
    expect(f.registry.bindInventory('connection-a')).toBe(true);
    expect(await f.registry.sessions(scope)).toEqual({ status: 'ok', sessions: [] });
    expect(await f.registry.turn({ scope, sessionHandle: handle, commandId: 'command-a', message: 'must not start', beforeSend: async () => true })).toEqual({ status: 'no_active_session' });
    expect(f.sent.filter((frame) => (frame as { type?: string }).type === 'turn.request')).toEqual([]);
  });

  test('refreshes an owner session read through the exact admitted connector and waits for fresh opaque bindings', async () => {
    let registry: RemoteLocalConnectorRegistry;
    const relay = new RemoteLocalRelayStateMachine(fence); const sent: unknown[] = [];
    registry = new RemoteLocalConnectorRegistry({ inventoryRefreshTimeoutMs: 50 });
    expect(registry.attach({ connectionId: 'connection-a', sessionId: 'session-a', fence, relay, close: () => {},
      claim: async () => ({ status: 'admitted', fence: 'fence-a' }), send: (raw) => {
        const frame = JSON.parse(raw) as { type: string; refreshId?: string };
        sent.push(frame);
        if (frame.type === 'session.inventory.request') {
          expect(relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence,
            sessions: [{ connectorReference: 'sar_qrstuvwxyzabcdef', alias: 'session-2', runtimeClass: 'codex_cli', availability: 'online', activity: 'idle' }], refreshId: frame.refreshId, refreshCapability: 'correlated-v1' }))).toEqual({ status: 'accepted' });
          expect(registry.bindInventory('connection-a')).toBe(true);
        }
        return true;
      } })).toBe(true);
    advertise({ registry, relay, sent, closed: () => 0 });
    const oldHandle = (sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    const refreshed = await registry.refreshSessions(scope);
    expect(refreshed).toEqual({ status: 'ok', sessions: [expect.objectContaining({ alias: 'session-2', runtimeClass: 'codex_cli' })] });
    if (refreshed.status !== 'ok') throw new Error('refresh did not complete');
    expect(refreshed.sessions[0]!.handle).not.toBe(oldHandle);
    expect(sent.at(-2)).toMatchObject({ type: 'session.inventory.request' });
    expect(await registry.turn({ scope, sessionHandle: oldHandle, commandId: 'command-stale', message: 'must not queue', beforeSend: async () => true })).toEqual({ status: 'no_active_session' });
  });

  test('does not satisfy an owner refresh with a stale or unmatched inventory proposal', async () => {
    const relay = new RemoteLocalRelayStateMachine(fence); const sent: { type: string; refreshId?: string }[] = [];
    const registry = new RemoteLocalConnectorRegistry({ inventoryRefreshTimeoutMs: 50 });
    expect(registry.attach({ connectionId: 'connection-a', sessionId: 'session-a', fence, relay, close: () => {},
      claim: async () => ({ status: 'admitted', fence: 'fence-a' }), send: (raw) => { sent.push(JSON.parse(raw)); return true; } })).toBe(true);
    expect(relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence,
      sessions: [{ connectorReference: 'sar_abcdefghijklmnop', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'idle' }], refreshCapability: 'correlated-v1' }))).toEqual({ status: 'accepted' });
    expect(registry.bindInventory('connection-a')).toBe(true);
    const refresh = registry.refreshSessions(scope);
    let request: { type: string; refreshId?: string } | undefined;
    for (let index = 0; index < 10 && !request; index += 1) { await Bun.sleep(1); request = sent.find((frame) => frame.type === 'session.inventory.request'); }
    expect(request?.refreshId).toMatch(/^rir_/);
    expect(relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence, refreshId: 'rir_qrstuvwxyzabcdef', refreshCapability: 'correlated-v1',
      sessions: [{ connectorReference: 'sar_qrstuvwxyzabcdef', alias: 'session-2', runtimeClass: 'codex_cli', availability: 'online', activity: 'idle' }] }))).toEqual({ status: 'accepted' });
    expect(registry.bindInventory('connection-a')).toBe(true);
    let settled = false; void refresh.then(() => { settled = true; }); await Promise.resolve();
    expect(settled).toBe(false);
    expect(relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence, refreshId: request!.refreshId, refreshCapability: 'correlated-v1',
      sessions: [{ connectorReference: 'sar_zyxwvutsrqponmlk', alias: 'session-3', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }] }))).toEqual({ status: 'accepted' });
    expect(registry.bindInventory('connection-a')).toBe(true);
    expect(await refresh).toMatchObject({ status: 'ok', sessions: [expect.objectContaining({ alias: 'session-3' })] });
  });

  test('fails closed when a later inventory bind replaces the matched revision during final liveness recheck', async () => {
    let claimCalls = 0; let releaseFinalClaim: (() => void) | undefined;
    const finalClaim = new Promise<void>((resolve) => { releaseFinalClaim = resolve; });
    const relay = new RemoteLocalRelayStateMachine(fence); const sent: { type: string; refreshId?: string }[] = [];
    let registry: RemoteLocalConnectorRegistry;
    registry = new RemoteLocalConnectorRegistry({ inventoryRefreshTimeoutMs: 50 });
    expect(registry.attach({ connectionId: 'connection-a', sessionId: 'session-a', fence, relay, close: () => {},
      claim: async () => { claimCalls += 1; if (claimCalls === 2) await finalClaim; return { status: 'admitted', fence: 'fence-a' }; },
      send: (raw) => {
        const frame = JSON.parse(raw) as { type: string; refreshId?: string };
        sent.push(frame);
        if (frame.type === 'session.inventory.request') {
          expect(relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence, refreshId: frame.refreshId, refreshCapability: 'correlated-v1',
            sessions: [{ connectorReference: 'sar_qrstuvwxyzabcdef', alias: 'session-2', runtimeClass: 'codex_cli', availability: 'online', activity: 'idle' }] }))).toEqual({ status: 'accepted' });
          expect(registry.bindInventory('connection-a')).toBe(true);
        }
        return true;
      } })).toBe(true);
    expect(relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence,
      sessions: [{ connectorReference: 'sar_abcdefghijklmnop', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'idle' }], refreshCapability: 'correlated-v1' }))).toEqual({ status: 'accepted' });
    expect(registry.bindInventory('connection-a')).toBe(true);
    const refresh = registry.refreshSessions(scope);
    for (let index = 0; index < 10 && claimCalls < 2; index += 1) await Bun.sleep(1);
    expect(claimCalls).toBe(2);
    expect(relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence, refreshId: 'rir_qwertyuiopasdfgh',
      sessions: [{ connectorReference: 'sar_zyxwvutsrqponmlk', alias: 'session-3', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }] }))).toEqual({ status: 'accepted' });
    expect(registry.bindInventory('connection-a')).toBe(true);
    releaseFinalClaim?.();
    expect(await refresh).toEqual({ status: 'indeterminate' });
  });

  test('fails closed when the admitted connector does not return a fresh inventory revision', async () => {
    const f = fixture({}); advertise(f);
    const registry = new RemoteLocalConnectorRegistry({ inventoryRefreshTimeoutMs: 1 });
    const relay = new RemoteLocalRelayStateMachine(fence);
    expect(registry.attach({ connectionId: 'silent', sessionId: 'silent', fence, relay, send: () => true, close: () => {}, claim: async () => ({ status: 'admitted', fence: 'fence-a' }) })).toBe(true);
    expect(relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence, sessions: [], refreshCapability: 'correlated-v1' }))).toEqual({ status: 'accepted' });
    expect(registry.bindInventory('silent')).toBe(true);
    const refresh = registry.refreshSessions(scope);
    await Promise.resolve();
    expect(await registry.turn({ scope, sessionHandle: handle, commandId: 'command-during-refresh', message: 'must not queue', beforeSend: async () => true })).toEqual({ status: 'indeterminate' });
    expect(await refresh).toEqual({ status: 'indeterminate' });
    // The unrelated fixture transport remains independent; no retry or queue
    // is created on either connection.
    expect(await f.registry.sessions(scope)).toMatchObject({ status: 'ok' });
  });

  test('does not probe an older unadvertised connector and leaves its admitted socket online', async () => {
    const relay = new RemoteLocalRelayStateMachine(fence); const sent: unknown[] = []; let closed = 0;
    const registry = new RemoteLocalConnectorRegistry();
    expect(registry.attach({ connectionId: 'old-connector', sessionId: 'old-connector', fence, relay,
      send: (raw) => { sent.push(JSON.parse(raw)); return true; }, close: () => { closed += 1; },
      claim: async () => ({ status: 'admitted', fence: 'fence-a' }) })).toBe(true);
    // This exact legacy proposal shape is intentionally still accepted, but
    // it cannot opt into a newer refresh frame.
    expect(relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence,
      sessions: [{ connectorReference: 'sar_abcdefghijklmnop', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'idle' }] }))).toEqual({ status: 'accepted' });
    expect(registry.bindInventory('old-connector')).toBe(true);
    const before = sent.length;
    expect(await registry.refreshSessions(scope)).toEqual({ status: 'indeterminate' });
    expect(sent).toHaveLength(before);
    expect(await registry.sessions(scope)).toMatchObject({ status: 'ok', sessions: [expect.objectContaining({ alias: 'session-1' })] });
    expect(closed).toBe(0);
  });

  test('does not request inventory while a live turn owns the selected session', async () => {
    const f = fixture(); advertise(f);
    const sessionHandle = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    expect(await f.registry.turn({ scope, sessionHandle, commandId: 'command-active', message: 'keep approval path', beforeSend: async () => true })).toEqual({ status: 'accepted' });
    const before = f.sent.length;
    expect(await f.registry.refreshSessions(scope)).toEqual({ status: 'indeterminate' });
    expect(f.sent).toHaveLength(before);
    expect(f.relay.activeCommandIds()).toEqual(['command-active']);
  });

  test('releases a terminal command so a later turn may use the same bound session', async () => {
    const f = fixture(); advertise(f);
    const binding = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    expect(await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-a', message: 'one', beforeSend: async () => true })).toEqual({ status: 'accepted' });
    expect(f.relay.receiveConnector(wire({ type: 'terminal.receipt', protocolVersion: 1, fence,
      commandId: 'command-a', sessionHandle: binding, disposition: 'completed' }))).toEqual({ status: 'accepted' });
    expect(await f.registry.observeConnector('connection-a')).toBe(true);
    expect(await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-b', message: 'two', beforeSend: async () => true })).toEqual({ status: 'accepted' });
  });

  test('registers an event stream only while the command is still active', async () => {
    let release: (() => void) | undefined; let calls = 0;
    const f = fixture({ claim: async () => {
      calls += 1; if (calls === 2) await new Promise<void>((resolve) => { release = resolve; });
      return { status: 'admitted', fence: 'fence-a' };
    } }); advertise(f); const binding = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-a', message: 'one', beforeSend: async () => true });
    const subscription = f.registry.subscribe(scope, 'command-a', () => 'stream-a');
    await Promise.resolve();
    expect(f.relay.receiveConnector(wire({ type: 'terminal.receipt', protocolVersion: 1, fence,
      commandId: 'command-a', sessionHandle: binding, disposition: 'completed' }))).toEqual({ status: 'accepted' });
    await f.registry.observeConnector('connection-a');
    release?.();
    expect(await subscription).toEqual({ status: 'no_active_session' });
  });

  test('isolates a dropped command event stream without closing the shared connector', async () => {
    const delivered: string[] = [];
    const f = fixture({ onEvents: async ({ commandId }) => { delivered.push(commandId); return commandId === 'command-a' ? false : undefined; } });
    expect(f.relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence,
      sessions: [
        { connectorReference: 'sar_abcdefghijklmnop', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' },
        { connectorReference: 'sar_qrstuvwxyzabcdef', alias: 'session-2', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' },
      ] }))).toEqual({ status: 'accepted' });
    expect(f.registry.bindInventory('connection-a')).toBe(true);
    const bindings = (f.sent[0] as { sessions: { handle: string }[] }).sessions;
    await f.registry.turn({ scope, sessionHandle: bindings[0]!.handle, commandId: 'command-a', message: 'one', beforeSend: async () => true });
    await f.registry.turn({ scope, sessionHandle: bindings[1]!.handle, commandId: 'command-b', message: 'two', beforeSend: async () => true });
    for (let sequence = 0; sequence < 40; sequence += 1) {
      expect(f.relay.receiveConnector(wire({ type: 'event.progress', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: bindings[0]!.handle, sequence, state: 'waiting' }))).toEqual({ status: 'accepted' });
      expect(await f.registry.observeConnector('connection-a')).toBe(true);
    }
    expect(f.relay.receiveConnector(wire({ type: 'event.progress', protocolVersion: 1, fence, commandId: 'command-b', sessionHandle: bindings[1]!.handle, sequence: 0, state: 'started' }))).toEqual({ status: 'accepted' });
    expect(await f.registry.observeConnector('connection-a')).toBe(true);
    expect(f.closed()).toBe(0);
    expect((await f.registry.sessions(scope)).status).toBe('ok');
    expect(delivered).toEqual(['command-a', 'command-b']);
  });

  test('interrupts only the flooded session while another active session continues', async () => {
    const delivered: { commandId: string; events?: readonly { type: string; disposition?: string }[] }[] = [];
    const terminal: unknown[] = [];
    const f = fixture({ onEvents: async (input) => { delivered.push(input as never); }, onTerminal: async (input) => { terminal.push(input); } });
    expect(f.relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence,
      sessions: [
        { connectorReference: 'sar_abcdefghijklmnop', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' },
        { connectorReference: 'sar_qrstuvwxyzabcdef', alias: 'session-2', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' },
      ] }))).toEqual({ status: 'accepted' });
    expect(f.registry.bindInventory('connection-a')).toBe(true);
    const bindings = (f.sent[0] as { sessions: { handle: string }[] }).sessions;
    expect(await f.registry.turn({ scope, sessionHandle: bindings[0]!.handle, commandId: 'command-a', message: 'one', beforeSend: async () => true })).toEqual({ status: 'accepted' });
    expect(await f.registry.turn({ scope, sessionHandle: bindings[1]!.handle, commandId: 'command-b', message: 'two', beforeSend: async () => true })).toEqual({ status: 'accepted' });
    for (let sequence = 0; sequence <= 32; sequence += 1) {
      expect(f.relay.receiveConnector(wire({ type: 'event.progress', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: bindings[0]!.handle, sequence, state: 'waiting' }))).toEqual({ status: 'accepted' });
    }
    expect(f.relay.receiveConnector(wire({ type: 'event.progress', protocolVersion: 1, fence, commandId: 'command-b', sessionHandle: bindings[1]!.handle, sequence: 0, state: 'started' }))).toEqual({ status: 'accepted' });
    expect(await f.registry.observeConnector('connection-a')).toBe(true);
    expect(delivered).toEqual([
      expect.objectContaining({ commandId: 'command-a', events: [expect.objectContaining({ type: 'terminal.receipt', disposition: 'post_ingress_indeterminate' })] }),
      expect.objectContaining({ commandId: 'command-b', events: [expect.objectContaining({ type: 'event.progress' })] }),
    ]);
    expect(terminal).toEqual([expect.objectContaining({ commandId: 'command-a', disposition: 'indeterminate' })]);
    expect((await f.registry.sessions(scope)).status).toBe('ok');
    expect(f.closed()).toBe(0);
  });

  test('passes terminal metadata to the durable callback before accepting another turn', async () => {
    const terminal: unknown[] = [];
    const f = fixture({ onTerminal: async (input) => { terminal.push(input); } }); advertise(f);
    const binding = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-a', message: 'one', beforeSend: async () => true });
    f.relay.receiveConnector(wire({ type: 'terminal.receipt', protocolVersion: 1, fence,
      commandId: 'command-a', sessionHandle: binding, disposition: 'completed' }));
    expect(await f.registry.observeConnector('connection-a')).toBe(true);
    expect(terminal).toEqual([{ scope, commandId: 'command-a', disposition: 'completed' }]);
  });

  test('terminalizes an in-flight turn as indeterminate when its advertised session ends', async () => {
    const terminal: unknown[] = []; const events: unknown[] = [];
    const f = fixture({ onTerminal: async (input) => { terminal.push(input); }, onEvents: async (input) => { events.push(input); } }); advertise(f);
    const binding = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-a', message: 'one', beforeSend: async () => true });
    expect(f.relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence, sessions: [] }))).toEqual({ status: 'accepted' });
    expect(await f.registry.observeConnector('connection-a')).toBe(true);
    expect(events).toEqual([expect.objectContaining({ commandId: 'command-a', events: [expect.objectContaining({ type: 'terminal.receipt', disposition: 'session_ended', sessionHandle: binding })] })]);
    expect(terminal).toEqual([{ scope, commandId: 'command-a', disposition: 'indeterminate' }]);
  });

  test('terminalizes an in-flight turn on malformed connector closure instead of abandoning it', async () => {
    const terminal: unknown[] = [];
    const f = fixture({ onTerminal: async (input) => { terminal.push(input); } }); advertise(f);
    const binding = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-a', message: 'one', beforeSend: async () => true });
    expect(f.relay.receiveConnector('{malformed')).toEqual({ status: 'closed', code: 'invalid_frame' });
    await f.registry.detach('connection-a');
    expect(terminal).toEqual([{ scope, commandId: 'command-a', disposition: 'indeterminate' }]);
  });

  test('stops event disclosure and terminalizes indeterminate when feature, fence, or device authority changes mid-stream', async () => {
    for (const code of ['disabled', 'fence_changed', 'revoked']) {
      let live = true; const delivered: unknown[] = []; const terminal: unknown[] = [];
      const f = fixture({ claim: async () => live ? { status: 'admitted', fence: 'fence-a' } : { status: 'closed', code },
        onEvents: async (input) => { delivered.push(input); }, onTerminal: async (input) => { terminal.push(input); } }); advertise(f);
      const binding = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
      await f.registry.turn({ scope, sessionHandle: binding, commandId: `command-${code}`, message: 'one', beforeSend: async () => true });
      expect(f.relay.receiveConnector(wire({ type: 'event.text', protocolVersion: 1, fence,
        commandId: `command-${code}`, sessionHandle: binding, sequence: 0, text: 'must not disclose' }))).toEqual({ status: 'accepted' });
      live = false;
      expect(await f.registry.observeConnector('connection-a')).toBe(false);
      expect(delivered).toEqual([]);
      expect(terminal).toEqual([{ scope, commandId: `command-${code}`, disposition: 'indeterminate' }]);
      expect(await f.registry.sessions(scope)).toEqual({ status: 'host_offline' });
      expect(f.closed()).toBe(1);
    }
  });

  test('becomes unroutable synchronously while detach settlement is still pending', async () => {
    let release: (() => void) | undefined;
    const f = fixture({ onTerminal: async () => new Promise<void>((resolve) => { release = resolve; }) }); advertise(f);
    const binding = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-a', message: 'one', beforeSend: async () => true });
    const detached = f.registry.detach('connection-a');
    expect(await f.registry.sessions(scope)).toEqual({ status: 'host_offline' });
    expect(await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-b', message: 'two', beforeSend: async () => true })).toEqual({ status: 'host_offline' });
    release?.(); await detached;
  });

  test('treats send loss after admission as indeterminate and removes the connection', async () => {
    const f = fixture({ send: () => false });
    // The bind itself fails and removes the transport; it cannot subsequently queue a turn.
    f.relay.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence,
      sessions: [{ connectorReference: 'sar_abcdefghijklmnop', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }] }));
    expect(f.registry.bindInventory('connection-a')).toBe(false);
    expect(f.closed()).toBe(1);
    expect((await f.registry.turn({ scope, sessionHandle: handle, commandId: 'command-a', message: 'hello', beforeSend: async () => true })).status).toBe('host_offline');
  });

  test('enforces independent brain, device, and consumer rate budgets', async () => {
    const f = fixture({ now: () => 1_000, maxTurnAttemptsPerMinute: 1 }); advertise(f);
    const binding = (f.sent[0] as { sessions: { handle: string }[] }).sessions[0]!.handle;
    expect((await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-a', message: 'one', beforeSend: async () => true })).status).toBe('accepted');
    expect(f.relay.receiveConnector(wire({ type: 'terminal.receipt', protocolVersion: 1, fence,
      commandId: 'command-a', sessionHandle: binding, disposition: 'completed' }))).toEqual({ status: 'accepted' });
    expect(await f.registry.observeConnector('connection-a')).toBe(true);
    expect((await f.registry.turn({ scope, sessionHandle: binding, commandId: 'command-b', message: 'two', beforeSend: async () => true })).status).toBe('indeterminate');
  });
});
