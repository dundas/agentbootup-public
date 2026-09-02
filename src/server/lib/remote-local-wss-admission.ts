import { REMOTE_LOCAL_RELAY_LIMITS } from './remote-local-relay-protocol';
import { RemoteLocalAdmissionHandshake, type RemoteLocalAdmissionHandshakeDependencies } from './remote-local-admission-handshake';
import type { RemoteLocalAdmissionCloseDisposition, RemoteLocalWssSocketData } from './remote-local-wss-router';
import { RemoteLocalRelayStateMachine } from './remote-local-relay-state-machine';
import { parseHostExtensionRelayFrame } from './host-extension-relay-protocol';

/** Immutable, non-routable connector admission endpoint. Credentials are frame-only. */
export const REMOTE_LOCAL_ADMISSION_PATH = '/v1/internal/remote-local/connector/v1';
export const REMOTE_LOCAL_ADMISSION_SUBPROTOCOL = 'agentbootup.remote-local-connector.v1';
export const REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS = 30_000;

export interface RemoteLocalWssAdmissionOptions {
  enabled: boolean;
  initialDeadlineMs: number;
  handshake: RemoteLocalAdmissionHandshakeDependencies;
  connectorRegistry?: {
    attach(input: { connectionId: string; sessionId: string; fence: import('./remote-local-relay-protocol').FenceProjection; relay: RemoteLocalRelayStateMachine; send: (frame: string) => boolean | void; close: () => void; claim: () => Promise<{ status: 'admitted'; fence: string } | { status: 'closed'; code: string }> }): boolean;
    detach(connectionId: string): void | Promise<void>;
    observeConnector(connectionId: string): Promise<boolean>;
    bindInventory(connectionId: string): boolean;
    receiveHostExtension(connectionId: string, raw: string | Uint8Array): boolean;
  };
  /** Redacted operator hook; it receives no device, session, frame, or authority data. */
  onCloseDiagnostic?: (input: { disposition: RemoteLocalAdmissionCloseDisposition | null; transportCode: number }) => void;
}

function protocols(value: string | null): string[] { return value?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? []; }
function validOptions(options: RemoteLocalWssAdmissionOptions): boolean {
  return options.enabled === true && Number.isSafeInteger(options.initialDeadlineMs)
    && options.initialDeadlineMs >= 1_000 && options.initialDeadlineMs <= 60_000;
}

/**
 * The only accepted origin is no Origin header: this endpoint is an outbound
 * daemon protocol, not a browser surface. Every rejection below happens before
 * Bun upgrades the request, therefore no socket or relay session exists.
 */
export function createRemoteLocalWssAdmission(options: RemoteLocalWssAdmissionOptions): {
  upgrade(request: Request, server: import('bun').Server<RemoteLocalWssSocketData>): Response | undefined;
  websocket: Bun.WebSocketHandler<RemoteLocalWssSocketData>;
} {
  const preUpgradeEnabled = validOptions(options);
  const reject = (status = 404) => new Response(status === 405 ? 'Method Not Allowed' : 'Not Found', status === 405 ? { status, headers: { allow: 'GET' } } : { status });
  // Never surface authority state in a close reason. The durable admission
  // object owns the typed internal reason and invokes this transport callback.
  const close = (ws: Bun.ServerWebSocket<RemoteLocalWssSocketData>, code = 1008, disposition?: RemoteLocalAdmissionCloseDisposition) => {
    if (ws.data.kind === 'admission') {
      ws.data.transportClosed = true;
      if (disposition) ws.data.closeDisposition = disposition;
    }
    ws.close(code, 'admission rejected');
  };
  const clearInitialTimer = (ws: Bun.ServerWebSocket<RemoteLocalWssSocketData>) => {
    if (ws.data.kind !== 'admission') return;
    if (ws.data.initialTimer) clearTimeout(ws.data.initialTimer);
    ws.data.initialTimer = undefined;
  };
  return {
    upgrade(request, server) {
      if (!preUpgradeEnabled) return reject();
      const url = new URL(request.url);
      if (url.pathname !== REMOTE_LOCAL_ADMISSION_PATH || url.search) return reject();
      if (request.method !== 'GET') return reject(405);
      // Any browser Origin, including a forged one, is prohibited. TLS is
      // terminated by the deployment edge; this local adapter never downgrades
      // the policy into a CORS allowlist.
      if (request.headers.has('origin')) return reject(403);
      const offered = protocols(request.headers.get('sec-websocket-protocol'));
      if (offered.length !== 1 || offered[0] !== REMOTE_LOCAL_ADMISSION_SUBPROTOCOL) return reject();
      return server.upgrade(request, { data: { kind: 'admission', admission: new RemoteLocalAdmissionHandshake(options.handshake), transportClosed: false, admitted: false, messageChain: Promise.resolve() } })
        ? undefined : new Response('WebSocket Upgrade Failed', { status: 400 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind !== 'admission') return;
        const data = ws.data;
        data.initialTimer = setTimeout(() => { if (!data.admitted) close(ws, 1008, 'initial_deadline'); }, options.initialDeadlineMs);
      },
      close(ws, transportCode) {
        if (ws.data.kind !== 'admission') return;
        // This flag is the cancellation boundary for an async pre-admission
        // receive(). It must be set before looking for a recorded session ID:
        // a close can win while durable admission is still resolving.
        ws.data.transportClosed = true;
        clearInitialTimer(ws);
        // A live session is subordinate to this socket. Removal happens even
        // for peer disconnects, so the registry can never become a durable
        // "connected" claim after transport loss.
        const sessionId = ws.data.sessionId;
        ws.data.sessionId = undefined;
        ws.data.relayState?.sessionEnded();
        ws.data.relayState = undefined;
        try { options.onCloseDiagnostic?.({ disposition: ws.data.closeDisposition ?? null, transportCode }); } catch { /* diagnostics are never authority */ }
        if (sessionId) options.connectorRegistry?.detach(sessionId);
        if (sessionId) void options.handshake.admission.revoke(sessionId, 'fence_changed');
      },
      async message(ws, message) {
        const previous = ws.data.kind === 'admission' ? ws.data.messageChain ?? Promise.resolve() : Promise.resolve();
        const work = async () => {
        if (ws.data.kind !== 'admission') return close(ws);
        const bytes = typeof message === 'string' ? Buffer.byteLength(message, 'utf8') : message.byteLength;
        if (bytes > REMOTE_LOCAL_RELAY_LIMITS.maxFrameBytes) return close(ws, 1009, 'invalid_frame');
        if (ws.data.admitted) {
          // Task 1.8 admits only liveness traffic. No inventory, command, or
          // event reaches a relay state machine before Task 3 exists.
          const sessionId = ws.data.sessionId;
          if (!sessionId) return close(ws, 1008, 'transport_closed');
          const hostExtension = parseHostExtensionRelayFrame(message, 'connector_to_relay');
          if (hostExtension.type !== 'host_extension.protocol_error') {
            const live = await options.handshake.admission.recheckSession(sessionId);
            if (live.status !== 'live') return close(ws, 1008, live.code);
            if (options.connectorRegistry?.receiveHostExtension(sessionId, message)) return;
            return close(ws, 1008, 'invalid_frame');
          }
          const result = await options.handshake.admission.receive(sessionId, message);
          if (result.status !== 'live') close(ws, 1008, result.code);
          else if (!ws.data.relayState || ws.data.relayState.receiveConnector(message).status === 'closed') close(ws, 1008, 'invalid_frame');
          else if (options.connectorRegistry && (!(await options.connectorRegistry.observeConnector(sessionId)) || !options.connectorRegistry.bindInventory(sessionId))) close(ws, 1008, 'registry_unavailable');
          return;
        }
        const result = await ws.data.admission.receive(message, { close: ({ code }) => close(ws, 1008, code) });
        if (result.status === 'send') { ws.send(JSON.stringify(result.frame)); return; }
        if (result.status === 'admitted') {
          // Durable admission can finish after either the initial deadline or
          // peer-close has closed the transport. Never publish that handle to
          // this socket; retire it immediately so the registry cannot retain
          // an orphaned live session.
          if (ws.data.transportClosed) {
            void options.handshake.admission.revoke(result.sessionId, 'fence_changed').catch(() => undefined);
            return;
          }
          ws.data.admitted = true;
          ws.data.sessionId = result.sessionId;
          ws.data.relayState = new RemoteLocalRelayStateMachine(result.projection);
          if (options.connectorRegistry && !options.connectorRegistry.attach({ connectionId: result.sessionId, sessionId: result.sessionId,
            fence: result.projection, relay: ws.data.relayState, send: (frame) => ws.send(frame) > 0, close: () => close(ws, 1008, 'registry_evicted'),
            claim: () => options.handshake.admission.claimCommand(result.sessionId) })) return close(ws, 1008, 'registry_unavailable');
          clearInitialTimer(ws);
          return;
        }
        close(ws, 1008, result.code);
        };
        const queued = previous.catch(() => undefined).then(work);
        if (ws.data.kind === 'admission') ws.data.messageChain = queued;
        return queued;
      },
    },
  };
}
