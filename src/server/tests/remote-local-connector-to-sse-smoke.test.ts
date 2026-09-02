import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { createRemoteLocalConnector } from '../../../lib/daemon/remote-local-connector.mjs';
import { createRemoteLocalConnectorHandlerComposition } from '../../../lib/daemon/remote-local-connector-handler.mjs';
import { createBrainAuthorizationFence } from '../lib/brain-authorization-decision';
import { RemoteLocalConnectorRegistry } from '../lib/remote-local-connector-registry';
import { RemoteLocalLiveEventBroker } from '../lib/remote-local-live-event-broker';
import { RemoteLocalRelayStateMachine } from '../lib/remote-local-relay-state-machine';
import { createRemoteLocalRegistryOwnerOperations, handleRemoteLocalChatRoute } from '../routes/remote-local-chat';

const ownerFence = createBrainAuthorizationFence({ brainId: 'brain-a', fencingEpoch: 1, ownerPrincipalId: 'owner-a', credentialRevision: 1,
  hostId: 'device-a', deploymentGeneration: 1, adapterIdentityVersion: 'adapter-v1', capabilityPolicyRevision: 1 });
const wireFence = { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: ownerFence.capabilitiesRevision } as const;
const scope = { tenantId: 'owner-a', ownerPrincipalId: 'owner-a', consumerId: 'owner-a', credentialId: 'key-a', brainId: 'brain-a',
  deviceId: 'device-a', fence: { capabilitiesRevision: ownerFence.capabilitiesRevision } } as never;

test('in-process connector-to-Plane-binding-to-authenticated-SSE contract stays inert when disabled', async () => {
  const broker = new RemoteLocalLiveEventBroker();
  const seenFrames: string[] = [];
  const serverFrames: string[] = [];
  let deliveryTail = Promise.resolve();
  const registry = new RemoteLocalConnectorRegistry({
    onEvents: async ({ scope: eventScope, commandId, events }) => broker.publish({ scope: eventScope, commandId, events }),
    onTerminal: async () => {},
  });
  const relay = new RemoteLocalRelayStateMachine(wireFence);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const composed = createRemoteLocalConnectorHandlerComposition({
    daemon: { credential: 'loopback-credential', bindAddress: '127.0.0.1', runtime: { runtimeIdentity: 'runtime-a', provider: 'codex',
      workspace: '/private/tmp/agentbootup-parent-gate', capabilityPolicyId: 'policy-a' } },
    authorityScope: { tenantId: 'owner-a', consumerId: 'owner-a' },
    listExistingSessions: async () => [{ nativeSessionId: 'native-private-a', runtimeClass: 'codex_cli', availability: 'online', activity: 'idle' }],
    continueExisting: async function* ({ text }: { text: string }) {
      expect(text).toBe('continue safely');
      await held;
      yield { type: 'text' as const, text: 'local continuation completed' };
      yield { type: 'tool' as const, invocationId: 'invocation-a', toolName: 'Bash', phase: 'completed' as const };
      yield { type: 'terminal' as const, disposition: 'completed' as const };
    },
    randomBytesImpl: () => Buffer.alloc(24, 1), mintCallId: () => 'call-a', mintSystemResolutionId: () => 'system-a',
  });

  let activeSocket: FakeWebSocket | null = null;
  class FakeWebSocket {
    static OPEN = 1; static CLOSING = 2;
    readyState = FakeWebSocket.OPEN;
    listeners = new Map<string, (event?: { data?: string }) => void>();
    constructor() { activeSocket = this; queueMicrotask(() => this.emit('open')); }
    addEventListener(type: string, listener: (event?: { data?: string }) => void) { this.listeners.set(type, listener); }
    emit(type: string, event = {}) { this.listeners.get(type)?.(event); }
    send(raw: string) {
      const frame = JSON.parse(raw);
      seenFrames.push(frame.type);
      if (frame.type === 'device.admission.open') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'device.reauth.challenge', protocolVersion: 1, fence: wireFence,
          credentialId: 'credential-a', proofChallengeId: 'proof-a', purpose: 'socket_open', expiresAt: new Date(Date.now() + 60_000).toISOString(), rotationId: 'rotation-a' }) }));
        return;
      }
      if (frame.type === 'device.reauth.proof') {
        expect(registry.attach({ connectionId: 'connection-a', sessionId: 'connection-a', fence: wireFence, relay,
          send: (serverFrame) => { serverFrames.push(JSON.parse(serverFrame).type); this.emit('message', { data: serverFrame }); return true; }, close: () => this.close(),
          claim: async () => ({ status: 'admitted' as const, fence: ownerFence.capabilitiesRevision }) })).toBe(true);
        return;
      }
      expect(relay.receiveConnector(raw)).toEqual({ status: 'accepted' });
      deliveryTail = deliveryTail.then(async () => {
        expect(await registry.observeConnector('connection-a')).toBe(true);
        expect(registry.bindInventory('connection-a')).toBe(true);
      });
    }
    close() { if (this.readyState >= FakeWebSocket.CLOSING) return; this.readyState = 3; this.emit('close'); }
  }

  const disabled = createRemoteLocalConnector({ enabled: false }, { WebSocketImpl: FakeWebSocket as never, handler: composed.handler });
  disabled.start();
  expect(disabled.status()).toEqual({ state: 'disabled' });
  expect(activeSocket).toBeNull();

  const privateKey = generateKeyPairSync('ed25519').privateKey;
  const connector = createRemoteLocalConnector({ enabled: true, endpoint: 'wss://relay.example/v1/internal/remote-local/connector/v1',
    brainId: 'brain-a', deviceId: 'device-a', credential: 'ldc1_test', privateKey }, {
    WebSocketImpl: FakeWebSocket as never, handler: composed.handler, setIntervalImpl: () => 1 as never, clearIntervalImpl: () => {},
  });
  connector.start();
  let inventory = await registry.sessions(scope);
  for (let index = 0; index < 50 && (inventory.status !== 'ok' || inventory.sessions.length === 0); index += 1) {
    await Bun.sleep(1); await deliveryTail; inventory = await registry.sessions(scope);
  }
  expect(seenFrames).toContain('session.inventory.propose');
  expect(serverFrames).toContain('session.inventory.bind');
  expect(inventory.status).toBe('ok');
  if (inventory.status !== 'ok') throw new Error('inventory unavailable');
  const sessionHandle = inventory.sessions[0]?.handle;
  expect(sessionHandle).toMatch(/^rsh_/);

  const commandId = 'rlc_abcdefghijklmnop';
  expect(await registry.turn({ scope, sessionHandle: sessionHandle!, commandId, message: 'continue safely', beforeSend: async () => true })).toEqual({ status: 'accepted' });
  const operations = createRemoteLocalRegistryOwnerOperations({ registry, turnStore: {} as never, eventBroker: broker });
  const response = await handleRemoteLocalChatRoute({
    req: new Request(`https://agentbootup.test/v1/remote-local/brains/brain-a/commands/${commandId}/events`), method: 'GET',
    path: `/v1/remote-local/brains/brain-a/commands/${commandId}/events`, principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' },
    deps: { repository: { inspect: async () => ({ disposition: 'current', fence: ownerFence, record: { owner_principal_id: 'owner-a', owner_status: 'active',
      local_device: { device_id: 'device-a', brain_id: 'brain-a', owner_principal_id: 'owner-a', state: 'active', authority_capabilities_revision: ownerFence.capabilitiesRevision } } }) } as never, operations },
  });
  expect(response?.status).toBe(200);
  expect(response?.headers.get('content-type')).toContain('text/event-stream');
  expect(response?.headers.get('cache-control')).toBe('no-store, no-cache, no-transform, private');
  expect(response?.headers.get('x-accel-buffering')).toBe('no');
  expect(response?.headers.has('connection')).toBe(false);
  const reader = response!.body!.getReader();
  let body = new TextDecoder().decode((await reader.read()).value);
  expect(body).toContain('event: connected');
  release();
  await composed.handler.idle(); await deliveryTail;
  for (;;) { const next = await reader.read(); if (next.done) break; body += new TextDecoder().decode(next.value); }
  expect(body).toContain('event: text');
  expect(body).toContain('local continuation completed');
  expect(body).toContain('event: tool');
  expect(body).toContain('event: terminal');
  expect(body).not.toContain('native-private-a');
  await connector.stop();
});

test('authenticated owner session read refreshes an admitted connector and exposes a newly observed opaque session', async () => {
  let localSessions: { nativeSessionId: string; runtimeClass: 'codex_cli'; availability: 'online'; activity: 'idle' | 'active' }[] = [];
  const registry = new RemoteLocalConnectorRegistry({ inventoryRefreshTimeoutMs: 100 });
  const relay = new RemoteLocalRelayStateMachine(wireFence);
  const observedWire: unknown[] = [];
  let deliveryTail = Promise.resolve();
  const composed = createRemoteLocalConnectorHandlerComposition({
    daemon: { credential: 'loopback-credential', bindAddress: '127.0.0.1', runtime: { runtimeIdentity: 'runtime-a', provider: 'codex', workspace: '/private/tmp/agentbootup-owner-refresh', capabilityPolicyId: 'policy-a' } },
    authorityScope: { tenantId: 'owner-a', consumerId: 'owner-a' },
    listExistingSessions: async () => localSessions,
    continueExisting: async function* () { yield { type: 'terminal' as const, disposition: 'completed' as const }; },
    randomBytesImpl: () => Buffer.alloc(24, 7), mintCallId: () => 'call-a', mintSystemResolutionId: () => 'system-a',
  });
  expect(registry.attach({ connectionId: 'connection-a', sessionId: 'connection-a', fence: wireFence, relay,
    send: (raw) => { observedWire.push(JSON.parse(raw)); return composed.handler.receive(raw); }, close: () => {},
    claim: async () => ({ status: 'admitted' as const, fence: ownerFence.capabilitiesRevision }) })).toBe(true);
  expect(await composed.handler.admitted(wireFence, (frame) => {
    observedWire.push(frame);
    expect(relay.receiveConnector(JSON.stringify(frame))).toEqual({ status: 'accepted' });
    deliveryTail = deliveryTail.then(async () => {
      expect(await registry.observeConnector('connection-a')).toBe(true);
      expect(registry.bindInventory('connection-a')).toBe(true);
    });
    return true;
  }, () => {})).toBe(true);
  await composed.handler.idle(); await deliveryTail;
  expect(await registry.sessions(scope)).toEqual({ status: 'ok', sessions: [] });
  localSessions = [{ nativeSessionId: 'native-private-new-session', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }];
  const operations = createRemoteLocalRegistryOwnerOperations({ registry, turnStore: {} as never });
  const response = await handleRemoteLocalChatRoute({
    req: new Request('https://agentbootup.test/v1/remote-local/brains/brain-a/sessions'), method: 'GET', path: '/v1/remote-local/brains/brain-a/sessions',
    principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' },
    deps: { repository: { inspect: async () => ({ disposition: 'current', fence: ownerFence, record: { owner_principal_id: 'owner-a', owner_status: 'active', local_device: { device_id: 'device-a', brain_id: 'brain-a', owner_principal_id: 'owner-a', state: 'active', authority_capabilities_revision: ownerFence.capabilitiesRevision } } }) } as never, operations },
  });
  expect(response?.status).toBe(200);
  const payload = await response?.json() as { data: { sessions: { handle: string; alias: string }[] } };
  expect(payload.data.sessions).toHaveLength(1);
  expect(payload.data.sessions[0]).toMatchObject({ handle: expect.stringMatching(/^rsh_/), alias: 'session-1' });
  expect(JSON.stringify({ payload, observedWire })).not.toContain('native-private-new-session');
  expect(observedWire).toContainEqual(expect.objectContaining({ type: 'session.inventory.request', refreshId: expect.stringMatching(/^rir_/) }));
  expect(observedWire).toContainEqual(expect.objectContaining({ type: 'session.inventory.propose', refreshId: expect.stringMatching(/^rir_/) }));
  await composed.handler.idle();
});
