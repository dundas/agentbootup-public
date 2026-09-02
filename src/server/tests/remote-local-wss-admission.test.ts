import { afterEach, expect, test } from 'bun:test';
import { createRemoteLocalWssAdmission, REMOTE_LOCAL_ADMISSION_PATH, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL } from '../lib/remote-local-wss-admission';
import { RemoteLocalConnectorRegistry } from '../lib/remote-local-connector-registry';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

const open = { type: 'device.admission.open', protocolVersion: 1, brainId: 'brain-a', deviceId: 'device-a', credential: 'ldc1_test' };
const proof = { type: 'device.reauth.proof', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, credentialId: 'credential-a', proofChallengeId: 'pop-a', purpose: 'socket_open', expiresAt: '2026-08-23T12:00:30.000Z', rotationId: 'rot-a', signatureAlgorithm: 'ed25519', signature: 'A'.repeat(86) };

function start(options: { enabled?: boolean; deadline?: number; authority?: 'current' | 'unavailable' | 'revoked' | 'stale'; closeOnHeartbeat?: 'unavailable' | 'fence_changed'; captureRegistryClose?: (close: () => void) => void; receiveHostExtension?: (frame: string | Uint8Array) => boolean; recheck?: () => Promise<{ status: 'live' } | { status: 'closed'; code: 'fence_changed' }>; onLegacyReceive?: () => void; open?: () => Promise<{ status: 'admitted'; sessionId: string; fence: string }> } = {}) {
  const authority = options.authority ?? 'current';
  let sessions = 0;
  const liveSessions = new Set<string>();
  const closeDiagnostics: Array<{ disposition: string | null; transportCode: number }> = [];
  const adapter = createRemoteLocalWssAdmission({
    enabled: options.enabled ?? true, initialDeadlineMs: options.deadline ?? 1_000,
    handshake: {
      feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
      inspectAuthority: async () => authority === 'current' ? ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }) : ({ disposition: authority === 'unavailable' ? 'unavailable' as const : 'missing' as const }),
      reauthenticate: { issueChallenge: async () => ({ status: 'issued' as const, brainId: 'brain-a', deviceId: 'device-a', authorityRevision: authority === 'stale' ? 'fence-b' : 'fence-a', credentialId: 'credential-a', proofChallengeId: 'pop-a', purpose: 'socket_open' as const, expiresAt: '2026-08-23T12:00:30.000Z', rotationId: 'rot-a' }) },
      admission: {
        open: async () => {
          if (authority === 'revoked') return { status: 'closed' as const, code: 'revoked' as const };
          const result = options.open ? await options.open() : { status: 'admitted' as const, sessionId: 'rsh_0123456789abcdef', fence: 'fence-a' };
          sessions += 1;
          liveSessions.add(result.sessionId);
          return result;
        },
        receive: async (_sessionId: string, frame: string | Uint8Array) => {
          options.onLegacyReceive?.();
          const text = typeof frame === 'string' ? frame : Buffer.from(frame).toString('utf8');
          if (text.includes('heartbeat') && options.closeOnHeartbeat) return { status: 'closed' as const, code: options.closeOnHeartbeat };
          return text.includes('heartbeat') || text.includes('availability') ? ({ status: 'live' as const }) : ({ status: 'closed' as const, code: 'invalid_frame' as const });
        },
        recheckSession: async () => options.recheck ? options.recheck() : ({ status: 'live' as const }),
        revoke: async (sessionId: string) => (liveSessions.delete(sessionId), { status: 'closed' as const, code: 'fence_changed' as const }),
        claimCommand: async () => ({ status: 'admitted' as const, fence: 'fence-a' }),
      },
    },
    connectorRegistry: options.captureRegistryClose || options.receiveHostExtension ? {
      attach: (input) => (options.captureRegistryClose?.(input.close), true),
      detach: () => undefined,
      observeConnector: async () => true,
      bindInventory: () => true,
      receiveHostExtension: (_sessionId, frame) => options.receiveHostExtension?.(frame) ?? false,
    } : undefined,
    onCloseDiagnostic: (diagnostic) => { closeDiagnostics.push(diagnostic); },
  });
  const server = Bun.serve({ port: 0, fetch(request, bunServer) { return adapter.upgrade(request, bunServer) ?? new Response('Not Found', { status: 404 }); }, websocket: adapter.websocket });
  servers.push(server);
  const url = `ws://localhost:${server.port}${REMOTE_LOCAL_ADMISSION_PATH}`;
  return { url, httpUrl: url.replace(/^ws:/, 'http:'), sessions: () => sessions, liveSessions: () => liveSessions.size, closeDiagnostics: () => closeDiagnostics };
}

function waitOpen(socket: WebSocket): Promise<void> { return new Promise((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('unexpected websocket error')), { once: true }); }); }
function waitClose(socket: WebSocket): Promise<number> { return new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.code), { once: true })); }
function waitMessage(socket: WebSocket): Promise<Record<string, unknown>> { return new Promise((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), { once: true })); }

test('is default-off and rejects malformed configuration before WebSocket upgrade', async () => {
  const disabled = start({ enabled: false });
  expect(await fetch(disabled.httpUrl)).toMatchObject({ status: 404 });
  const socket = new WebSocket(disabled.url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  // Bun reports a rejected HTTP upgrade to its client as protocol error.
  expect(await waitClose(socket)).toBe(1002);
});

test('rejects path query method browser origin and subprotocol before upgrade', async () => {
  const { url, httpUrl } = start();
  expect((await fetch(`${httpUrl}?brain=brain-a`)).status).toBe(404);
  expect((await fetch(httpUrl, { method: 'POST' })).status).toBe(405);
  expect((await fetch(httpUrl, { headers: { Origin: 'https://example.invalid', 'sec-websocket-protocol': REMOTE_LOCAL_ADMISSION_SUBPROTOCOL } })).status).toBe(403);
  const wrongProtocol = new WebSocket(url, 'other');
  expect(await waitClose(wrongProtocol)).toBe(1002);
});

test('enforces pre-admission deadline and no session exists until valid proof', async () => {
  const { url, sessions } = start({ deadline: 1_000 });
  const idle = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(idle);
  expect(await waitClose(idle)).toBe(1008);
  expect(sessions()).toBe(0);
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open));
  expect(await waitMessage(socket)).toMatchObject({ type: 'device.reauth.challenge' });
  expect(sessions()).toBe(0);
  socket.send(JSON.stringify(proof));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sessions()).toBe(1);
  socket.send(JSON.stringify({ type: 'heartbeat', protocolVersion: 1, fence: proof.fence, sequence: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.send(JSON.stringify({ type: 'availability', protocolVersion: 1, fence: proof.fence, state: 'online' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const closed = waitClose(socket);
  socket.close();
  expect(await closed).toBe(1000);
});

test('MVP admission rejects post-admission credential refresh traffic', async () => {
  const { url, sessions } = start();
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open));
  await waitMessage(socket);
  socket.send(JSON.stringify(proof));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sessions()).toBe(1);
  const closed = waitClose(socket);
  socket.send(JSON.stringify({ ...proof, purpose: 'credential_refresh' }));
  expect(await closed).toBe(1008);
});

test('routes a rechecked host extension frame to the registry before legacy admission parsing', async () => {
  let rechecks = 0;
  let legacyReceives = 0;
  let delivered: string | Uint8Array | undefined;
  const { url } = start({
    recheck: async () => (rechecks += 1, { status: 'live' as const }),
    onLegacyReceive: () => { legacyReceives += 1; },
    receiveHostExtension: (frame) => (delivered = frame, true),
  });
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open)); await waitMessage(socket);
  socket.send(JSON.stringify(proof));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const extension = JSON.stringify({ type: 'host_extension.register', protocolVersion: 1, fence: proof.fence,
    endpoint: { serviceId: 'example.local-extension/v1', protocolVersion: 1, capabilities: ['opaque_request', 'opaque_event', 'terminal_delivery'], availability: 'available' } });
  socket.send(extension);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(rechecks).toBe(1);
  expect(legacyReceives).toBe(0);
  expect(delivered).toBe(extension);
  socket.close();
});

test('closes a host extension frame when its separate session recheck fails', async () => {
  let delivered = false;
  const { url } = start({
    recheck: async () => ({ status: 'closed' as const, code: 'fence_changed' as const }),
    receiveHostExtension: () => (delivered = true, true),
  });
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open)); await waitMessage(socket);
  socket.send(JSON.stringify(proof));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const closed = waitClose(socket);
  socket.send(JSON.stringify({ type: 'host_extension.register', protocolVersion: 1, fence: proof.fence,
    endpoint: { serviceId: 'example.local-extension/v1', protocolVersion: 1, capabilities: ['opaque_request'], availability: 'available' } }));
  expect(await closed).toBe(1008);
  expect(delivered).toBe(false);
});

test('emits a redacted typed close diagnostic without socket or authority identifiers', async () => {
  const { url, closeDiagnostics } = start();
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open)); await waitMessage(socket);
  socket.send(JSON.stringify(proof));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const closed = waitClose(socket);
  socket.send(JSON.stringify({ type: 'not-a-real-frame' }));
  expect(await closed).toBe(1008);
  expect(closeDiagnostics()).toEqual([{ disposition: 'invalid_frame', transportCode: 1008 }]);
  expect(JSON.stringify(closeDiagnostics())).not.toContain('device-a');
  expect(JSON.stringify(closeDiagnostics())).not.toContain('fence-a');
});

test('retains an unavailable liveness close classification for operator diagnosis', async () => {
  const { url, closeDiagnostics } = start({ closeOnHeartbeat: 'unavailable' });
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open)); await waitMessage(socket);
  socket.send(JSON.stringify(proof));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const closed = waitClose(socket);
  socket.send(JSON.stringify({ type: 'heartbeat', protocolVersion: 1, fence: proof.fence, sequence: 1 }));
  expect(await closed).toBe(1008);
  expect(closeDiagnostics()).toEqual([{ disposition: 'unavailable', transportCode: 1008 }]);
});

test('classifies a registry-initiated connector eviction without native identifiers', async () => {
  let evict!: () => void;
  const { url, closeDiagnostics } = start({ captureRegistryClose: (close) => { evict = close; } });
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open)); await waitMessage(socket);
  socket.send(JSON.stringify(proof));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const closed = waitClose(socket);
  evict();
  expect(await closed).toBe(1008);
  expect(closeDiagnostics()).toEqual([{ disposition: 'registry_evicted', transportCode: 1008 }]);
  expect(JSON.stringify(closeDiagnostics())).not.toContain('rsh_');
});

test('maps unavailable, stale, revoked, duplicate/replayed frames to a topology-free policy close', async () => {
  for (const authority of ['unavailable', 'stale', 'revoked'] as const) {
    const { url, sessions } = start({ authority });
    const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
    await waitOpen(socket);
    socket.send(JSON.stringify(open));
    expect(await waitClose(socket)).toBe(1008);
    expect(sessions()).toBe(0);
  }
  const { url, sessions } = start();
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open)); await waitMessage(socket);
  socket.send(JSON.stringify(open));
  expect(await waitClose(socket)).toBe(1008);
  expect(sessions()).toBe(0);
});

test('serializes back-to-back open and proof while challenge issuance is delayed', async () => {
  let release!: () => void;
  let challenges = 0;
  let admissions = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter = createRemoteLocalWssAdmission({ enabled: true, initialDeadlineMs: 1_000, handshake: {
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
    reauthenticate: { issueChallenge: async () => { challenges += 1; await gate; return { status: 'issued' as const, brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a', credentialId: 'credential-a', proofChallengeId: 'pop-a', purpose: 'socket_open' as const, expiresAt: '2026-08-23T12:00:30.000Z', rotationId: 'rot-a' }; } },
    admission: { open: async () => (admissions += 1, { status: 'admitted' as const, sessionId: 'rsh_0123456789abcdef', fence: 'fence-a' }), receive: async () => ({ status: 'live' as const }), recheckSession: async () => ({ status: 'live' as const }), revoke: async () => ({ status: 'closed' as const, code: 'fence_changed' as const }), claimCommand: async () => ({ status: 'admitted' as const, fence: 'fence-a' }) },
  } });
  const server = Bun.serve({ port: 0, fetch(request, bunServer) { return adapter.upgrade(request, bunServer) ?? new Response('Not Found', { status: 404 }); }, websocket: adapter.websocket });
  servers.push(server);
  const socket = new WebSocket(`ws://localhost:${server.port}${REMOTE_LOCAL_ADMISSION_PATH}`, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  const challenge = waitMessage(socket);
  socket.send(JSON.stringify(open));
  socket.send(JSON.stringify(proof));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(challenges).toBe(1);
  expect(admissions).toBe(0);
  release();
  expect(await challenge).toMatchObject({ type: 'device.reauth.challenge' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(admissions).toBe(1);
  socket.close();
});

test('revokes a delayed durable admission when the initial deadline closes its transport', async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredOpen = new Promise<void>((resolve) => { entered = resolve; });
  const delayedOpen = new Promise<{ status: 'admitted'; sessionId: string; fence: string }>((resolve) => { release = () => resolve({ status: 'admitted', sessionId: 'rsh_0123456789abcdef', fence: 'fence-a' }); });
  const { url, liveSessions } = start({ deadline: 1_000, open: async () => { entered(); return delayedOpen; } });
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open));
  await waitMessage(socket);
  const closed = waitClose(socket);
  socket.send(JSON.stringify(proof));
  await enteredOpen;
  expect(await closed).toBe(1008);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(liveSessions()).toBe(0);
});

test('revokes a delayed durable admission when the peer closes first', async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredOpen = new Promise<void>((resolve) => { entered = resolve; });
  const delayedOpen = new Promise<{ status: 'admitted'; sessionId: string; fence: string }>((resolve) => { release = () => resolve({ status: 'admitted', sessionId: 'rsh_0123456789abcdef', fence: 'fence-a' }); });
  const { url, liveSessions } = start({ open: async () => { entered(); return delayedOpen; } });
  const socket = new WebSocket(url, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open));
  await waitMessage(socket);
  socket.send(JSON.stringify(proof));
  await enteredOpen;
  const closed = waitClose(socket);
  socket.close();
  expect(await closed).toBe(1000);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(liveSessions()).toBe(0);
});

test('publishes an admitted connector inventory to owner operations through the real Bun websocket handler', async () => {
  const registry = new RemoteLocalConnectorRegistry({ onTerminal: async () => {} });
  const adapter = createRemoteLocalWssAdmission({ enabled: true, initialDeadlineMs: 1_000, handshake: {
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
    reauthenticate: { issueChallenge: async () => ({ status: 'issued' as const, brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a', credentialId: 'credential-a', proofChallengeId: 'pop-a', purpose: 'socket_open' as const, expiresAt: '2026-08-23T12:00:30.000Z', rotationId: 'rot-a' }) },
    admission: {
      open: async () => ({ status: 'admitted' as const, sessionId: 'rsh_0123456789abcdef', fence: 'fence-a' }),
      receive: async () => ({ status: 'live' as const }),
      recheckSession: async () => ({ status: 'live' as const }),
      revoke: async () => ({ status: 'closed' as const, code: 'fence_changed' as const }),
      claimCommand: async () => ({ status: 'admitted' as const, fence: 'fence-a' }),
    },
  }, connectorRegistry: registry });
  const server = Bun.serve({ port: 0, fetch(request, bunServer) { return adapter.upgrade(request, bunServer) ?? new Response('Not Found', { status: 404 }); }, websocket: adapter.websocket });
  servers.push(server);
  const socket = new WebSocket(`ws://localhost:${server.port}${REMOTE_LOCAL_ADMISSION_PATH}`, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await waitOpen(socket);
  socket.send(JSON.stringify(open));
  await waitMessage(socket);
  socket.send(JSON.stringify(proof));
  socket.send(JSON.stringify({ type: 'session.inventory.propose', protocolVersion: 1, fence: proof.fence, sessions: [{ connectorReference: 'sar_0123456789abcdef', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'idle' }] }));
  const binding = await waitMessage(socket);
  expect(binding).toMatchObject({ type: 'session.inventory.bind' });
  await expect(registry.sessions({ tenantId: 'owner-a', ownerPrincipalId: 'owner-a', consumerId: 'owner-a', credentialId: 'key-a', brainId: 'brain-a', deviceId: 'device-a', fence: { capabilitiesRevision: 'fence-a' } })).resolves.toMatchObject({ status: 'ok', sessions: [{ alias: 'session-1', availability: 'online' }] });
  socket.close();
});
