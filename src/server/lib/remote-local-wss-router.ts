import type { RemoteLocalAdmissionHandshake } from './remote-local-admission-handshake';
import { REMOTE_LOCAL_RELAY_LIMITS } from './remote-local-relay-protocol';
import type { RemoteLocalRelayStateMachine } from './remote-local-relay-state-machine';

/**
 * Bun installs these properties on the server-wide websocket handler, not on
 * the route which called `upgrade`.  Keep the broad transport bound here and
 * let each route enforce its narrower application-level budget/timer itself.
 */
export const REMOTE_LOCAL_WSS_SHARED_IDLE_TIMEOUT_SECONDS = 120;

export type RemoteLocalPreflightSocketData = {
  readonly kind: 'preflight';
  idleTimer?: ReturnType<typeof setTimeout>;
};

export type RemoteLocalAdmissionSocketData = {
  readonly kind: 'admission';
  readonly admission: RemoteLocalAdmissionHandshake;
  initialTimer?: ReturnType<typeof setTimeout>;
  /** Set synchronously by close before any in-flight admission continuation. */
  transportClosed: boolean;
  closeDisposition?: RemoteLocalAdmissionCloseDisposition;
  admitted: boolean;
  sessionId?: string;
  relayState?: RemoteLocalRelayStateMachine;
  messageChain?: Promise<void>;
};

export type RemoteLocalAdmissionCloseDisposition = 'initial_deadline' | 'invalid_frame' | 'registry_unavailable' | 'registry_evicted' | 'transport_closed'
  | 'feature_disabled' | 'rate_limited' | 'invalid_proof' | 'revoked' | 'fence_changed'
  | 'expired' | 'unavailable' | 'indeterminate' | 'heartbeat_expired';

export type RemoteLocalWssSocketData = RemoteLocalPreflightSocketData | RemoteLocalAdmissionSocketData;

type RemoteLocalWssEndpoint = {
  websocket: Bun.WebSocketHandler<RemoteLocalWssSocketData>;
};

/**
 * Bun accepts one websocket handler per server. Route-tagged upgrade data keeps
 * the independently bounded preflight and connector-admission handlers from
 * overwriting one another when mounted on the same server.
 */
export function createRemoteLocalWssRouter(
  preflight: RemoteLocalWssEndpoint,
  admission: RemoteLocalWssEndpoint,
): Bun.WebSocketHandler<RemoteLocalWssSocketData> {
  return {
    // A Bun server has exactly one WebSocketHandler.  Do not rely on callback
    // forwarding to carry endpoint options: it silently drops them.
    idleTimeout: REMOTE_LOCAL_WSS_SHARED_IDLE_TIMEOUT_SECONDS,
    maxPayloadLength: REMOTE_LOCAL_RELAY_LIMITS.maxFrameBytes,
    perMessageDeflate: false,
    open(ws) {
      if (ws.data.kind === 'preflight') return preflight.websocket.open?.(ws);
      return admission.websocket.open?.(ws);
    },
    close(ws, code, reason) {
      if (ws.data.kind === 'preflight') return preflight.websocket.close?.(ws, code, reason);
      return admission.websocket.close?.(ws, code, reason);
    },
    message(ws, message) {
      if (ws.data.kind === 'preflight') return preflight.websocket.message(ws, message);
      return admission.websocket.message(ws, message);
    },
  };
}
