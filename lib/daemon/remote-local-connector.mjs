/**
 * Default-off outbound connector for PRD-0072 Task 3.1.
 *
 * This module deliberately lives inside an existing managed daemon: it opens
 * one outbound TLS WebSocket and never binds a port, spawns a process, or
 * accepts a relay-selected URL. A protected handler may add the frozen
 * inventory/turn composition; without one post-admission traffic remains a
 * bounded heartbeat and any command frame fails closed.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readRemoteLocalConnectorState } from '../auth/credentials.js';

export const REMOTE_LOCAL_CONNECTOR_PATH = '/v1/internal/remote-local/connector/v1';
export const REMOTE_LOCAL_CONNECTOR_SUBPROTOCOL = 'agentbootup.remote-local-connector.v1';
export const REMOTE_LOCAL_CONNECTOR_STATE_VERSION = 2;
export const REMOTE_LOCAL_CONNECTOR_LEGACY_STATE_VERSION = 1;
export const REMOTE_LOCAL_CONNECTOR_HEARTBEAT_MS = 20_000;
export const REMOTE_LOCAL_CONNECTOR_ADMISSION_DEADLINE_MS = 30_000;
export const REMOTE_LOCAL_CONNECTOR_BACKOFF_MIN_MS = 1_000;
export const REMOTE_LOCAL_CONNECTOR_BACKOFF_MAX_MS = 30_000;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL = /^[^\u0000-\u001f\u007f]{1,256}$/;

function endpointFromServerUrl(serverUrl) {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    url.protocol = 'wss:';
    url.pathname = REMOTE_LOCAL_CONNECTOR_PATH;
    return url.toString();
  } catch { return null; }
}

function validFence(value, brainId, deviceId) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && value.brainId === brainId && value.deviceId === deviceId
    && typeof value.authorityRevision === 'string' && IDENTIFIER.test(value.authorityRevision);
}

function validChallenge(value, brainId, deviceId) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 8 && value.type === 'device.reauth.challenge' && value.protocolVersion === 1
    && validFence(value.fence, brainId, deviceId) && typeof value.credentialId === 'string' && IDENTIFIER.test(value.credentialId)
    && typeof value.proofChallengeId === 'string' && IDENTIFIER.test(value.proofChallengeId)
    && value.purpose === 'socket_open' && typeof value.rotationId === 'string' && IDENTIFIER.test(value.rotationId)
    && typeof value.expiresAt === 'string' && value.expiresAt.length === 24
    && Number.isFinite(Date.parse(value.expiresAt)) && new Date(Date.parse(value.expiresAt)).toISOString() === value.expiresAt;
}

function canonicalProofPayload(challenge) {
  return JSON.stringify({
    authorityRevision: challenge.fence.authorityRevision,
    brainId: challenge.fence.brainId,
    credentialId: challenge.credentialId,
    deviceId: challenge.fence.deviceId,
    domain: 'remote-local-device-pop/v1',
    expiresAt: challenge.expiresAt,
    proofChallengeId: challenge.proofChallengeId,
    purpose: challenge.purpose,
    rotationId: challenge.rotationId,
  });
}

/**
 * Read the local-only enrollment material without ever accepting a relay URL.
 * There is intentionally no plaintext-file compatibility fallback: the
 * pre-release daemon-root JSON draft never shipped, and auto-importing it
 * would recreate the path-replacement secret-loading flaw this encrypted
 * record removes. A real enrollment workflow writes this record directly.
 */
export async function resolveRemoteLocalConnectorConfig({ brainId, serverUrl, env = process.env, readState = readRemoteLocalConnectorState } = {}) {
  if (env.AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_ENABLED?.trim() !== '1') return { enabled: false };
  if (typeof brainId !== 'string' || !IDENTIFIER.test(brainId)) throw new Error('remote-local connector requires a configured brain ID');
  const endpoint = endpointFromServerUrl(serverUrl);
  if (!endpoint) throw new Error('remote-local connector requires an HTTPS credential server URL without a path');
  let state;
  try { state = await readState(); } catch { throw new Error('remote-local connector state is unavailable'); }
  if (state === null) throw new Error('remote-local connector state is unavailable');
  const stateKeys = state && typeof state === 'object' && !Array.isArray(state) ? Object.keys(state).sort().join(',') : '';
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !((state.version === REMOTE_LOCAL_CONNECTOR_LEGACY_STATE_VERSION && stateKeys === 'brainId,credential,deviceId,privateKeyPem,version')
      || (state.version === REMOTE_LOCAL_CONNECTOR_STATE_VERSION && stateKeys === 'brainId,credential,deviceId,privateKeyPem,runtime,version'))
    || state.brainId !== brainId
    || (state.version === REMOTE_LOCAL_CONNECTOR_STATE_VERSION && (!state.runtime || typeof state.runtime !== 'object' || Array.isArray(state.runtime)))
    || typeof state.deviceId !== 'string' || !IDENTIFIER.test(state.deviceId)
    || typeof state.credential !== 'string' || !CREDENTIAL.test(state.credential)
    || typeof state.privateKeyPem !== 'string' || state.privateKeyPem.length > 8192) throw new Error('remote-local connector state is invalid');
  let privateKey;
  try {
    privateKey = createPrivateKey(state.privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key');
  } catch { throw new Error('remote-local connector state requires an Ed25519 private key'); }
  return { enabled: true, endpoint, brainId, deviceId: state.deviceId, credential: state.credential, privateKey,
    ...(state.version === REMOTE_LOCAL_CONNECTOR_STATE_VERSION ? { runtime: state.runtime } : {}) };
}

export function createRemoteLocalConnector(config, {
  WebSocketImpl = globalThis.WebSocket,
  handler,
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  log = () => {},
} = {}) {
  if (!config?.enabled) return Object.freeze({ start() {}, stop: async () => {}, status: () => ({ state: 'disabled' }) });
  if (typeof WebSocketImpl !== 'function') throw new Error('remote-local connector requires WebSocket support');
  let stopped = true;
  let socket = null;
  let retryTimer = null;
  let heartbeatTimer = null;
  let admissionTimer = null;
  let attempts = 0;
  let state = 'idle';
  let fence = null;
  const clearAdmissionTimer = () => { if (admissionTimer) clearTimeoutImpl(admissionTimer); admissionTimer = null; };
  const clearTimers = () => { if (retryTimer) clearTimeoutImpl(retryTimer); if (heartbeatTimer) clearIntervalImpl(heartbeatTimer); clearAdmissionTimer(); retryTimer = null; heartbeatTimer = null; };
  const delay = () => Math.min(REMOTE_LOCAL_CONNECTOR_BACKOFF_MAX_MS, REMOTE_LOCAL_CONNECTOR_BACKOFF_MIN_MS * 2 ** Math.min(attempts++, 5)) + Math.floor(random() * REMOTE_LOCAL_CONNECTOR_BACKOFF_MIN_MS);
  const schedule = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeoutImpl(() => { retryTimer = null; connect(); }, delay());
    retryTimer.unref?.();
  };
  const startHeartbeat = (currentSocket, currentFence, sendCurrent) => {
    if (!currentFence || heartbeatTimer) return;
    let sequence = 0;
    heartbeatTimer = setIntervalImpl(() => {
      if (socket !== currentSocket) return;
      if (!sendCurrent({ type: 'heartbeat', protocolVersion: 1, fence: currentFence, sequence: ++sequence })) currentSocket.close(1008, 'connector heartbeat unavailable');
    }, REMOTE_LOCAL_CONNECTOR_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  };
  const connect = () => {
    if (stopped || socket) return;
    state = 'connecting';
    try { socket = new WebSocketImpl(config.endpoint, REMOTE_LOCAL_CONNECTOR_SUBPROTOCOL); } catch { socket = null; state = 'backoff'; schedule(); return; }
    const currentSocket = socket;
    const sendCurrent = (frame) => {
      if (stopped || socket !== currentSocket || currentSocket.readyState !== WebSocketImpl.OPEN) return false;
      try { currentSocket.send(JSON.stringify(frame)); return true; } catch { return false; }
    };
    currentSocket.addEventListener('open', () => {
      if (stopped || socket !== currentSocket) return;
      state = 'challenging';
      admissionTimer = setTimeoutImpl(() => { if (socket === currentSocket && state !== 'admitted') currentSocket.close(1008, 'connector admission timeout'); }, REMOTE_LOCAL_CONNECTOR_ADMISSION_DEADLINE_MS);
      admissionTimer.unref?.();
      if (!sendCurrent({ type: 'device.admission.open', protocolVersion: 1, brainId: config.brainId, deviceId: config.deviceId, credential: config.credential })) currentSocket.close(1008, 'connector admission unavailable');
    });
    currentSocket.addEventListener('message', (event) => {
      if (stopped || socket !== currentSocket) return;
      if (state === 'admitted') {
        let accepted = false;
        try { accepted = !!handler && handler.receive(String(event.data)) === true; } catch { accepted = false; }
        if (!accepted && socket === currentSocket) currentSocket.close(1008, 'connector protocol violation');
        return;
      }
      if (state !== 'challenging') return;
      let challenge;
      try { challenge = JSON.parse(String(event.data)); } catch { currentSocket.close(1008, 'connector protocol violation'); return; }
      if (!validChallenge(challenge, config.brainId, config.deviceId) || Date.parse(challenge.expiresAt) <= Date.now()) { currentSocket.close(1008, 'connector protocol violation'); return; }
      const signature = sign(null, Buffer.from(canonicalProofPayload(challenge), 'utf8'), config.privateKey).toString('base64url');
      fence = challenge.fence;
      if (!sendCurrent({ type: 'device.reauth.proof', protocolVersion: 1, fence, credentialId: challenge.credentialId, proofChallengeId: challenge.proofChallengeId, purpose: 'socket_open', expiresAt: challenge.expiresAt, rotationId: challenge.rotationId, signatureAlgorithm: 'ed25519', signature })) { currentSocket.close(1008, 'connector proof unavailable'); return; }
      state = 'admitted'; attempts = 0; clearAdmissionTimer();
      const currentFence = fence;
      startHeartbeat(currentSocket, currentFence, sendCurrent);
      const closeRuntimeTransport = () => {
        if (socket === currentSocket && currentSocket.readyState < WebSocketImpl.CLOSING) currentSocket.close(1008, 'connector runtime unavailable');
      };
      if (handler) void Promise.resolve(handler.admitted(currentFence, sendCurrent, closeRuntimeTransport)).then((accepted) => {
        if (!accepted && socket === currentSocket) currentSocket.close(1008, 'connector runtime unavailable');
      }, () => { if (socket === currentSocket) currentSocket.close(1008, 'connector runtime unavailable'); });
    });
    currentSocket.addEventListener('error', () => { if (socket === currentSocket) currentSocket.close(1008, 'connector transport error'); });
    currentSocket.addEventListener('close', () => {
      if (socket !== currentSocket) return;
      handler?.disconnect?.();
      socket = null; fence = null; clearAdmissionTimer(); if (heartbeatTimer) { clearIntervalImpl(heartbeatTimer); heartbeatTimer = null; }
      if (!stopped) { state = 'backoff'; schedule(); }
    });
  };
  return Object.freeze({
    start() { if (!stopped) return; stopped = false; attempts = 0; connect(); },
    async stop() { stopped = true; clearTimers(); handler?.disconnect?.(); const active = socket; socket = null; fence = null; state = 'stopped'; if (active && active.readyState < WebSocketImpl.CLOSING) active.close(1000, 'connector stopped'); await handler?.idle?.(); await handler?.stop?.(); },
    status() { return { state, attempts, connected: state === 'admitted' }; },
  });
}

/**
 * Supervision boundary for the existing brain-sync daemon. A connector state
 * problem is fail-closed for remote operation, not a reason to stop memory
 * and asset convergence for the whole brain.
 */
export async function createSupervisedRemoteLocalConnector({ brainId, serverUrl, env = process.env, handler, createHandler, hostExtensionInstaller, logError = () => {}, resolveConfig = resolveRemoteLocalConnectorConfig, createConnector = createRemoteLocalConnector } = {}) {
  try {
    if (hostExtensionInstaller !== undefined && typeof hostExtensionInstaller !== 'function') throw new Error('remote-local host-extension installer must be a function');
    const config = await resolveConfig({ brainId, serverUrl, env });
    // The daemon composition may need Bun-only runtime dependencies. Resolve it
    // only after the sealed v2 state enables this opt-in capability, and allow
    // that protected factory to load asynchronously. This keeps normal Node
    // CLI/packaged maintenance commands from evaluating the execution bridge.
    const canMountRuntime = config.enabled && config.runtime !== undefined;
    const resolvedHandler = handler ?? (canMountRuntime && typeof createHandler === 'function'
      ? await createHandler(config, Object.freeze({ hostExtensionInstaller })) : undefined);
    if (config.enabled && (!canMountRuntime || typeof resolvedHandler?.admitted !== 'function')) throw new Error('remote-local connector runtime composition is unavailable');
    return createConnector(config, { handler: resolvedHandler });
  } catch (error) {
    logError('remote-local connector disabled: protected state is unavailable or invalid', error);
    return createConnector({ enabled: false }, { handler: undefined });
  }
}
