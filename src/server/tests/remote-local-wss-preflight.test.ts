import { afterEach, describe, expect, test } from 'bun:test';
import {
  REMOTE_LOCAL_PREFLIGHT_PATH,
  createRemoteLocalPreflight,
} from '../lib/remote-local-wss-preflight';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function start(enabled = true, idleTimeoutSeconds = 10) {
  const preflight = createRemoteLocalPreflight({
    enabled,
    bearerToken: enabled ? 't'.repeat(32) : null,
    idleTimeoutSeconds,
    maxPayloadBytes: 128,
  });
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (new URL(request.url).pathname === REMOTE_LOCAL_PREFLIGHT_PATH) {
        return preflight.upgrade(request, bunServer);
      }
      return new Response('Not Found', { status: 404 });
    },
    websocket: preflight.websocket,
  });
  servers.push(server);
  return { preflight, url: `ws://localhost:${server.port}${REMOTE_LOCAL_PREFLIGHT_PATH}` };
}

function protocols() {
  return ['agentbootup.remote-local-preflight.v1', `agentbootup.remote-local-preflight-token.${'t'.repeat(32)}`];
}

function receive(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
  });
}

describe('remote-local WSS preflight (Task 1.1)', () => {
  test('is default-off and therefore has no upgrade surface', async () => {
    const { url } = start(false);
    const socket = new WebSocket(url, protocols());
    const result = await new Promise<string>((resolve) => socket.addEventListener('close', () => resolve('closed'), { once: true }));
    expect(result).toBe('closed');
  });

  test('requires the exact protocol and configured Bearer token before upgrade', async () => {
    const { url } = start();
    const rejected = new WebSocket(url, ['other', `agentbootup.remote-local-preflight-token.${'t'.repeat(32)}`]);
    await new Promise<void>((resolve) => rejected.addEventListener('close', () => resolve(), { once: true }));

    const accepted = new WebSocket(url, protocols());
    await new Promise<void>((resolve, reject) => {
      accepted.addEventListener('open', () => resolve(), { once: true });
      accepted.addEventListener('error', () => reject(new Error('expected authenticated upgrade')), { once: true });
    });
    accepted.close();
  });

  test('accepts only bounded heartbeat frames and never accepts connector/chat payloads', async () => {
    const { url } = start();
    const socket = new WebSocket(url, protocols());
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve(), { once: true }));
    socket.send('{"type":"heartbeat"}');
    expect(await receive(socket)).toBe('{"type":"heartbeat_ack"}');
    socket.send('{"type":"chat.request"}');
    const close = await new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code), { once: true }));
    expect(close).toBe(1008);
  });

  test('closes an idle preflight socket with an explicit policy code', async () => {
    const { url } = start(true, 1);
    const socket = new WebSocket(url, protocols());
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('expected authenticated upgrade')), { once: true });
    });
    const closeCode = await Promise.race([
      new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code), { once: true })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('idle close timeout')), 3_000)),
    ]);
    expect(closeCode).toBe(1008);
  });
});
