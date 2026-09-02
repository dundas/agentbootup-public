import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRemoteLocalConnectorState, writeRemoteLocalConnectorState } from '../../lib/auth/credentials.js';
import { createRemoteLocalConnector, createSupervisedRemoteLocalConnector, REMOTE_LOCAL_CONNECTOR_PATH, REMOTE_LOCAL_CONNECTOR_SUBPROTOCOL, resolveRemoteLocalConnectorConfig } from '../../lib/daemon/remote-local-connector.mjs';

function fixture(overrides = {}) {
  const pair = generateKeyPairSync('ed25519');
  return { pair, state: { version: 1, brainId: 'brain-a', deviceId: 'device-a', credential: 'ldc1_test', privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), ...overrides } };
}
const runtime = Object.freeze({ approvalExpiresInMs: 60_000, authorityScope: { tenantId: 'tenant-a', consumerId: 'consumer-a' },
  daemon: { credential: 'loopback-credential', bindAddress: '127.0.0.1', runtime: { runtimeIdentity: 'runtime-a', provider: 'codex', workspace: '/private/tmp/agentbootup-runtime-test', capabilityPolicyId: 'policy-a', sessionDiscoveryMaxAgeMs: 60_000, sessionClockSkewToleranceMs: 5_000 } },
  planeAuthority: { mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', assurance: 'assurance-a' } });
async function config(state) { return await resolveRemoteLocalConnectorConfig({ brainId: 'brain-a', serverUrl: 'https://relay.example', env: { AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_ENABLED: '1' }, readState: async () => state }); }

describe('remote-local connector', () => {
  test('uses machine-bound encrypted state rather than a plaintext configuration file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-local-encrypted-'));
    const previous = process.env.AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_STATE_FILE;
    const previousMachineId = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    process.env.AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_STATE_FILE = path.join(directory, 'state');
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(directory, 'machine-id');
    try {
      const { state } = fixture(); await writeRemoteLocalConnectorState(state);
      expect(await readRemoteLocalConnectorState()).toMatchObject({ brainId: 'brain-a', deviceId: 'device-a' });
    } finally {
      if (previous === undefined) delete process.env.AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_STATE_FILE; else process.env.AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_STATE_FILE = previous;
      if (previousMachineId === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE; else process.env.AGENTBOOTUP_MACHINE_ID_FILE = previousMachineId;
      await rm(directory, { recursive: true, force: true });
    }
  });
  test('is default-off and derives only the frozen WSS endpoint from encrypted local state', async () => {
    expect(await resolveRemoteLocalConnectorConfig({ brainId: 'brain-a', serverUrl: 'https://relay.example' })).toEqual({ enabled: false });
    expect(await config(fixture().state)).toMatchObject({ enabled: true, endpoint: `wss://relay.example${REMOTE_LOCAL_CONNECTOR_PATH}`, brainId: 'brain-a', deviceId: 'device-a' });
  });

  test('fails closed for absent, malformed, non-Ed25519, or endpoint-selecting state', async () => {
    await expect(config(null)).rejects.toThrow('state is unavailable');
    await expect(config({ ...fixture().state, endpoint: 'wss://attacker.invalid' })).rejects.toThrow('state is invalid');
    await expect(config(fixture({ version: 2, runtime: null }).state)).rejects.toThrow('state is invalid');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(config({ ...fixture().state, privateKeyPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) })).rejects.toThrow('Ed25519');
    await expect(resolveRemoteLocalConnectorConfig({ brainId: 'brain-a', serverUrl: 'https://relay.example/other', env: { AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_ENABLED: '1' }, readState: async () => fixture().state })).rejects.toThrow('HTTPS credential server URL');
  });

  test('disables a misconfigured connector without taking down its supervising daemon', async () => {
    const errors = []; const disabled = { start() {}, stop: async () => {}, status: () => ({ state: 'disabled' }) };
    const connector = await createSupervisedRemoteLocalConnector({
      brainId: 'brain-a', serverUrl: 'https://relay.example', env: { AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_ENABLED: '1' },
      resolveConfig: async () => { throw new Error('state unavailable'); },
      createConnector: (value) => { expect(value).toEqual({ enabled: false }); return disabled; },
      logError: (message) => errors.push(message),
    });
    expect(connector).toBe(disabled);
    expect(errors).toEqual(['remote-local connector disabled: protected state is unavailable or invalid']);
  });

  test('mounts execution only from sealed v2 state and leaves legacy v1 fail-closed', async () => {
    const disabled = { start() {}, stop: async () => {}, status: () => ({ state: 'disabled' }) };
    let legacyFactoryCalled = false;
    const legacy = await createSupervisedRemoteLocalConnector({ brainId: 'brain-a', serverUrl: 'https://relay.example',
      env: { AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_ENABLED: '1' }, resolveConfig: async () => await config(fixture().state),
      createHandler: () => { legacyFactoryCalled = true; return { admitted() {}, receive() {}, disconnect() {}, idle: async () => {} }; },
      createConnector: (value) => { expect(value).toEqual({ enabled: false }); return disabled; } });
    expect(legacy).toBe(disabled);
    expect(legacyFactoryCalled).toBe(false);
    let mounted;
    const connected = { start() {}, stop: async () => {}, status: () => ({ state: 'idle' }) };
    const v2 = fixture({ version: 2, runtime }).state;
    const installer = () => {};
    const connector = await createSupervisedRemoteLocalConnector({ brainId: 'brain-a', serverUrl: 'https://relay.example', hostExtensionInstaller: installer,
      env: { AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_ENABLED: '1' }, resolveConfig: async () => await config(v2),
      createHandler: async (value, options) => { mounted = value.runtime; expect(options.hostExtensionInstaller).toBe(installer); return { admitted() {}, receive() {}, disconnect() {}, idle: async () => {} }; },
      createConnector: (value, options) => { expect(value.runtime).toBe(runtime); expect(typeof options.handler.admitted).toBe('function'); return connected; } });
    expect(connector).toBe(connected); expect(mounted).toBe(runtime);
  });

  test('opens only the frozen protocol, proves the server challenge, and emits bounded heartbeats', async () => {
    const { state, pair } = fixture(); const sent = []; let instance;
    class FakeWebSocket { static OPEN = 1; static CLOSING = 2; constructor(endpoint, protocol) { instance = this; this.endpoint = endpoint; this.protocol = protocol; this.readyState = 1; this.listeners = new Map(); queueMicrotask(() => this.emit('open')); } addEventListener(type, listener) { this.listeners.set(type, listener); } emit(type, event = {}) { this.listeners.get(type)?.(event); } send(value) { sent.push(JSON.parse(value)); } close() { this.readyState = 3; this.emit('close'); } }
    let heartbeat;
    const connector = createRemoteLocalConnector(await config(state), { WebSocketImpl: FakeWebSocket, random: () => 0, setIntervalImpl: (callback) => { heartbeat = callback; return 1; }, clearIntervalImpl: () => {} });
    connector.start(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(instance.endpoint).toBe(`wss://relay.example${REMOTE_LOCAL_CONNECTOR_PATH}`); expect(instance.protocol).toBe(REMOTE_LOCAL_CONNECTOR_SUBPROTOCOL);
    expect(sent.shift()).toEqual({ type: 'device.admission.open', protocolVersion: 1, brainId: 'brain-a', deviceId: 'device-a', credential: 'ldc1_test' });
    const challenge = { type: 'device.reauth.challenge', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, credentialId: 'credential-a', proofChallengeId: 'pop-a', purpose: 'socket_open', expiresAt: new Date(Date.now() + 60_000).toISOString(), rotationId: 'rot-a' };
    instance.emit('message', { data: JSON.stringify(challenge) }); const proof = sent.shift();
    const payload = JSON.stringify({ authorityRevision: 'fence-a', brainId: 'brain-a', credentialId: 'credential-a', deviceId: 'device-a', domain: 'remote-local-device-pop/v1', expiresAt: challenge.expiresAt, proofChallengeId: 'pop-a', purpose: 'socket_open', rotationId: 'rot-a' });
    expect(verify(null, Buffer.from(payload), pair.publicKey, Buffer.from(proof.signature, 'base64url'))).toBe(true);
    heartbeat(); expect(sent.shift()).toEqual({ type: 'heartbeat', protocolVersion: 1, fence: challenge.fence, sequence: 1 }); await connector.stop();
  });

  test('bounds stalled admission and reconnects after loss without an inbound server', async () => {
    const sockets = []; const timers = [];
    class FakeWebSocket { static OPEN = 1; static CLOSING = 2; constructor() { this.readyState = 1; this.listeners = new Map(); sockets.push(this); queueMicrotask(() => this.emit('open')); } addEventListener(type, listener) { this.listeners.set(type, listener); } emit(type, event = {}) { this.listeners.get(type)?.(event); } send() {} close() { this.readyState = 3; this.emit('close'); } }
    const connector = createRemoteLocalConnector(await config(fixture().state), { WebSocketImpl: FakeWebSocket, random: () => 0, setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeoutImpl: () => {} });
    connector.start(); await new Promise((resolve) => setTimeout(resolve, 0)); expect(sockets).toHaveLength(1);
    timers.find((timer) => timer.delay === 30_000).callback(); expect(connector.status()).toMatchObject({ state: 'backoff', connected: false });
    const reconnect = timers.find((timer) => timer.delay === 1000); expect(reconnect).toEqual({ callback: expect.any(Function), delay: 1000 }); reconnect.callback(); await new Promise((resolve) => setTimeout(resolve, 0)); expect(sockets).toHaveLength(2); await connector.stop();
  });

  test('isolates stale socket callbacks and delayed handler admission from a reconnected generation', async () => {
    const sockets = []; const timers = []; let releaseFirst; let admissions = 0; let disconnects = 0;
    const firstAdmission = new Promise((resolve) => { releaseFirst = resolve; });
    class FakeWebSocket {
      static OPEN = 1; static CLOSING = 2;
      constructor() { this.readyState = 1; this.listeners = new Map(); this.sent = []; sockets.push(this); queueMicrotask(() => this.emit('open')); }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      emit(type, event = {}) { this.listeners.get(type)?.(event); }
      send(value) { this.sent.push(JSON.parse(value)); }
      close() { this.readyState = 3; this.emit('close'); }
    }
    const handler = {
      admitted: async () => (++admissions === 1 ? firstAdmission : true),
      receive: () => true,
      disconnect: () => { disconnects += 1; },
      idle: async () => {},
    };
    const connector = createRemoteLocalConnector(await config(fixture().state), { handler, WebSocketImpl: FakeWebSocket, random: () => 0,
      setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeoutImpl: () => {},
      setIntervalImpl: () => 99, clearIntervalImpl: () => {} });
    const challenge = { type: 'device.reauth.challenge', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, credentialId: 'credential-a', proofChallengeId: 'pop-a', purpose: 'socket_open', expiresAt: new Date(Date.now() + 60_000).toISOString(), rotationId: 'rot-a' };
    connector.start(); await Bun.sleep(0);
    const first = sockets[0]; first.emit('message', { data: JSON.stringify(challenge) }); await Bun.sleep(0);
    first.close();
    timers.find((timer) => timer.delay === 1000).callback(); await Bun.sleep(0);
    const second = sockets[1]; second.emit('message', { data: JSON.stringify(challenge) }); await Bun.sleep(0);
    expect(connector.status()).toMatchObject({ state: 'admitted', connected: true });
    releaseFirst(false); await Bun.sleep(0);
    first.emit('close'); first.emit('message', { data: '{}' });
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
    expect(connector.status()).toMatchObject({ state: 'admitted', connected: true });
    expect(admissions).toBe(2); expect(disconnects).toBe(1);
    await connector.stop();
  });
});
