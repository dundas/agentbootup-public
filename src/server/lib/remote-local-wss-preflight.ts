import { timingSafeEqual } from 'node:crypto';
import type { RemoteLocalWssSocketData } from './remote-local-wss-router';

export const REMOTE_LOCAL_PREFLIGHT_PATH = '/v1/internal/remote-local/preflight';
export const REMOTE_LOCAL_PREFLIGHT_SUBPROTOCOL = 'agentbootup.remote-local-preflight.v1';
export const REMOTE_LOCAL_PREFLIGHT_HEARTBEAT_FRAME = '{"type":"heartbeat"}';
export const REMOTE_LOCAL_PREFLIGHT_MIN_PAYLOAD_BYTES = Buffer.byteLength(REMOTE_LOCAL_PREFLIGHT_HEARTBEAT_FRAME, 'utf8');
const TOKEN_SUBPROTOCOL_PREFIX = 'agentbootup.remote-local-preflight-token.';

export interface RemoteLocalPreflightOptions {
  enabled: boolean;
  bearerToken: string | null;
  idleTimeoutSeconds: number;
  maxPayloadBytes: number;
}

function matches(candidate: string | null, expected: string | null): boolean {
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseProtocols(value: string | null): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

export function createRemoteLocalPreflight(options: RemoteLocalPreflightOptions): {
  upgrade(request: Request, server: import('bun').Server<RemoteLocalWssSocketData>): Response | undefined;
  websocket: Bun.WebSocketHandler<RemoteLocalWssSocketData>;
} {
  if (options.enabled && (!options.bearerToken || !/^[A-Za-z0-9_-]{32,128}$/.test(options.bearerToken))) {
    throw new Error('enabled remote-local WSS preflight requires a 32-128 character base64url token');
  }
  const close = (ws: Bun.ServerWebSocket<RemoteLocalWssSocketData>) => ws.close(1008, 'preflight protocol violation');
  const clearIdleTimer = (ws: Bun.ServerWebSocket<RemoteLocalWssSocketData>) => {
    if (ws.data.kind !== 'preflight') return;
    if (ws.data.idleTimer) clearTimeout(ws.data.idleTimer);
    ws.data.idleTimer = undefined;
  };
  const armIdleTimer = (ws: Bun.ServerWebSocket<RemoteLocalWssSocketData>) => {
    if (ws.data.kind !== 'preflight') return;
    clearIdleTimer(ws);
    ws.data.idleTimer = setTimeout(() => ws.close(1008, 'preflight idle timeout'), options.idleTimeoutSeconds * 1_000);
  };
  return {
    upgrade(request, server) {
      if (!options.enabled) return new Response('Not Found', { status: 404 });
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
      const protocols = parseProtocols(request.headers.get('sec-websocket-protocol'));
      if (protocols.length !== 2 || protocols[0] !== REMOTE_LOCAL_PREFLIGHT_SUBPROTOCOL) return new Response('Not Found', { status: 404 });
      const supplied = protocols[1] ?? '';
      const token = supplied.startsWith(TOKEN_SUBPROTOCOL_PREFIX) ? supplied.slice(TOKEN_SUBPROTOCOL_PREFIX.length) : null;
      if (!matches(token, options.bearerToken)) return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      return server.upgrade(request, { data: { kind: 'preflight' } })
        ? undefined : new Response('WebSocket Upgrade Failed', { status: 400 });
    },
    websocket: {
      idleTimeout: options.idleTimeoutSeconds,
      maxPayloadLength: options.maxPayloadBytes,
      perMessageDeflate: false,
      open(ws) {
        if (ws.data.kind !== 'preflight') return;
        armIdleTimer(ws);
      },
      close(ws) {
        if (ws.data.kind !== 'preflight') return;
        clearIdleTimer(ws);
      },
      message(ws, message) {
        if (ws.data.kind !== 'preflight') return close(ws);
        if (typeof message !== 'string' || Buffer.byteLength(message) > options.maxPayloadBytes || message !== REMOTE_LOCAL_PREFLIGHT_HEARTBEAT_FRAME) return close(ws);
        ws.send('{"type":"heartbeat_ack"}');
        armIdleTimer(ws);
      },
    },
  };
}
