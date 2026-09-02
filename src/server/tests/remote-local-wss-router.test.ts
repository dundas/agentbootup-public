import { afterEach, expect, test } from 'bun:test';
import {
  REMOTE_LOCAL_ADMISSION_PATH,
  REMOTE_LOCAL_ADMISSION_SUBPROTOCOL,
  createRemoteLocalWssAdmission,
} from '../lib/remote-local-wss-admission';
import {
  REMOTE_LOCAL_PREFLIGHT_PATH,
  REMOTE_LOCAL_PREFLIGHT_SUBPROTOCOL,
  createRemoteLocalPreflight,
} from '../lib/remote-local-wss-preflight';
import { createRemoteLocalWssRouter } from '../lib/remote-local-wss-router';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('unexpected websocket error')), { once: true });
  });
}

function waitMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), { once: true }));
}

test('multiplexes preflight and admission sockets without replacing either route handler', async () => {
  let sessions = 0;
  const preflight = createRemoteLocalPreflight({
    enabled: true,
    bearerToken: 't'.repeat(32),
    idleTimeoutSeconds: 10,
    maxPayloadBytes: 128,
  });
  const admission = createRemoteLocalWssAdmission({
    enabled: true,
    initialDeadlineMs: 1_000,
    handshake: {
      feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
      inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
      reauthenticate: {
        issueChallenge: async () => ({
          status: 'issued' as const,
          brainId: 'brain-a',
          deviceId: 'device-a',
          authorityRevision: 'fence-a',
          credentialId: 'credential-a',
          proofChallengeId: 'pop-a',
          purpose: 'socket_open' as const,
          expiresAt: '2026-08-23T12:00:30.000Z',
          rotationId: 'rot-a',
        }),
      },
      admission: { open: async () => (sessions += 1, { status: 'admitted' as const, sessionId: 'rsh_0123456789abcdef', fence: 'fence-a' }), receive: async () => ({ status: 'live' as const }), recheckSession: async () => ({ status: 'live' as const }), revoke: async () => ({ status: 'closed' as const, code: 'fence_changed' as const }), claimCommand: async () => ({ status: 'admitted' as const, fence: 'fence-a' }) },
    },
  });
  const router = createRemoteLocalWssRouter(preflight, admission);
  expect(router).toMatchObject({ maxPayloadLength: 16_384, perMessageDeflate: false });
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      const path = new URL(request.url).pathname;
      if (path === REMOTE_LOCAL_PREFLIGHT_PATH) return preflight.upgrade(request, bunServer);
      if (path === REMOTE_LOCAL_ADMISSION_PATH) return admission.upgrade(request, bunServer);
      return new Response('Not Found', { status: 404 });
    },
    websocket: router,
  });
  servers.push(server);

  const origin = `ws://localhost:${server.port}`;
  const heartbeat = new WebSocket(`${origin}${REMOTE_LOCAL_PREFLIGHT_PATH}`, [
    REMOTE_LOCAL_PREFLIGHT_SUBPROTOCOL,
    `agentbootup.remote-local-preflight-token.${'t'.repeat(32)}`,
  ]);
  const connector = new WebSocket(`${origin}${REMOTE_LOCAL_ADMISSION_PATH}`, REMOTE_LOCAL_ADMISSION_SUBPROTOCOL);
  await Promise.all([waitOpen(heartbeat), waitOpen(connector)]);

  // The shared Bun limit is broader than the heartbeat route's own budget;
  // routing must still preserve that endpoint's narrower frame rejection.
  const oversizedHeartbeat = new WebSocket(`${origin}${REMOTE_LOCAL_PREFLIGHT_PATH}`, [
    REMOTE_LOCAL_PREFLIGHT_SUBPROTOCOL,
    `agentbootup.remote-local-preflight-token.${'t'.repeat(32)}`,
  ]);
  await waitOpen(oversizedHeartbeat);
  const oversizedClosed = new Promise<number>((resolve) => oversizedHeartbeat.addEventListener('close', (event) => resolve(event.code), { once: true }));
  oversizedHeartbeat.send('x'.repeat(129));
  expect(await oversizedClosed).toBe(1008);

  const heartbeatAck = waitMessage(heartbeat);
  const connectorChallenge = waitMessage(connector);
  heartbeat.send('{"type":"heartbeat"}');
  connector.send(JSON.stringify({ type: 'device.admission.open', protocolVersion: 1, brainId: 'brain-a', deviceId: 'device-a', credential: 'ldc1_test' }));
  expect(await heartbeatAck).toEqual({ type: 'heartbeat_ack' });
  expect(await connectorChallenge).toMatchObject({ type: 'device.reauth.challenge' });

  expect(sessions).toBe(0);
  heartbeat.close();
  connector.close();
});
