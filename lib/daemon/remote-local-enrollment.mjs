/**
 * Owner-initiated, local-device enrollment for the default-off remote-local
 * connector. Runtime policy is validated locally and never crosses this API.
 */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { apiUrl, isPlausibleServerUrl } from '../auth/validate.js';
import { isValidRemoteLocalEnrollmentRuntime, isValidRemoteLocalRuntime } from './remote-local-runtime-config.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// Mech Storage may briefly serve the pre-enrollment authority record to the
// immediately following completion read. Retrying the *same* proof is safe:
// the server owns the pending-record check and completion command idempotency.
// Keep this deliberately short; prolonged retries would turn enrollment into
// an offline queue, which the remote-local MVP explicitly forbids.
export const REMOTE_LOCAL_ENROLLMENT_COMPLETION_RETRY_DELAYS_MS = Object.freeze([250, 750, 1_500, 4_000, 9_000]);

function commandId(prefix, uuid = randomUUID()) {
  return `${prefix}_${uuid.replaceAll('-', '')}`;
}

function requireString(value, name, { min = 1, max = 512 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new Error(`remote-local enrollment returned invalid ${name}`);
  return value;
}

async function requestJson(fetchImpl, url, apiKey, body, stage) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`remote-local enrollment ${stage} request failed`);
  }
  if (!response?.ok) {
    const error = new Error(`remote-local enrollment ${stage} failed (HTTP ${response?.status ?? 'unknown'})`);
    Object.defineProperty(error, 'status', { value: response?.status, enumerable: false });
    throw error;
  }
  try { return await response.json(); } catch { throw new Error(`remote-local enrollment ${stage} returned invalid JSON`); }
}

/**
 * Complete the two-request enrollment ceremony and atomically seal the local
 * connector material. No partial state is written when either request fails.
 */
export async function enrollRemoteLocalDevice({
  brainId, runtime, credentials, fetchImpl = fetch, writeState, randomUUIDImpl = randomUUID,
  completionRetryDelaysMs = REMOTE_LOCAL_ENROLLMENT_COMPLETION_RETRY_DELAYS_MS,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof brainId !== 'string' || !IDENTIFIER.test(brainId)) throw new Error('remote-local enrollment requires a configured brain ID');
  if (!credentials || typeof credentials.apiKey !== 'string' || credentials.apiKey.length === 0 || !isPlausibleServerUrl(credentials.serverUrl)) {
    throw new Error('remote-local enrollment requires valid local credentials');
  }
  if (typeof writeState !== 'function') throw new Error('remote-local enrollment requires protected state storage');
  if (!isValidRemoteLocalEnrollmentRuntime(runtime)) throw new Error('remote-local enrollment runtime profile is invalid');
  if (!Array.isArray(completionRetryDelaysMs) || completionRetryDelaysMs.length < 1 || completionRetryDelaysMs.length > REMOTE_LOCAL_ENROLLMENT_COMPLETION_RETRY_DELAYS_MS.length
    || !completionRetryDelaysMs.every((delay) => Number.isSafeInteger(delay) && delay >= 1 && delay <= 10_000)
    || typeof sleepImpl !== 'function') throw new Error('remote-local enrollment retry configuration is invalid');

  const pair = generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const startCommandId = commandId('enroll', randomUUIDImpl());
  const startPayload = await requestJson(fetchImpl, apiUrl(credentials.serverUrl, `/v1/remote-local/brains/${brainId}/enrollments`), credentials.apiKey, {
    commandId: startCommandId, publicKey,
  }, 'start');
  const enrollment = startPayload?.data?.enrollment;
  const enrollmentId = requireString(enrollment?.enrollmentId, 'enrollmentId', { min: 1, max: 128 });
  const deviceId = requireString(enrollment?.deviceId, 'deviceId', { min: 1, max: 128 });
  const enrollmentSecret = requireString(enrollment?.enrollmentSecret, 'enrollmentSecret', { min: 32, max: 256 });
  const challenge = requireString(enrollment?.challenge, 'challenge', { min: 32, max: 256 });
  const authorityScope = enrollment?.authorityScope;
  if (!IDENTIFIER.test(enrollmentId) || !IDENTIFIER.test(deviceId) || !BASE64URL.test(enrollmentSecret) || !BASE64URL.test(challenge)
    || !authorityScope || typeof authorityScope !== 'object' || Array.isArray(authorityScope)
    || Object.keys(authorityScope).sort().join(',') !== 'consumerId,tenantId'
    || typeof authorityScope.tenantId !== 'string' || !IDENTIFIER.test(authorityScope.tenantId)
    || typeof authorityScope.consumerId !== 'string' || !IDENTIFIER.test(authorityScope.consumerId)) throw new Error('remote-local enrollment returned invalid enrollment material');
  const signature = sign(null, Buffer.from(challenge, 'utf8'), pair.privateKey).toString('base64url');
  const completionPayload = {
    commandId: commandId('complete', randomUUIDImpl()), deviceId, enrollmentSecret, signature,
  };
  let completePayload;
  for (let attempt = 0; ; attempt += 1) {
    try {
      completePayload = await requestJson(fetchImpl, apiUrl(credentials.serverUrl, `/v1/remote-local/brains/${brainId}/enrollments/${enrollmentId}/complete`), credentials.apiKey, completionPayload, 'completion');
      break;
    } catch (error) {
      // A fresh start followed by a 403 can be a stale replica observation.
      // Only replay the byte-for-byte same completion command, and only within
      // this bounded local reconciliation window.
      if (error?.status !== 403 || attempt >= completionRetryDelaysMs.length) throw error;
      await sleepImpl(completionRetryDelaysMs[attempt]);
    }
  }
  const complete = completePayload?.data;
  const credential = requireString(complete?.connectorCredential, 'connectorCredential', { min: 1, max: 256 });
  if (!credential.startsWith('ldc1_') || !BASE64URL.test(credential.slice('ldc1_'.length))) throw new Error('remote-local enrollment returned invalid connectorCredential');
  const sealedRuntime = Object.freeze({ ...runtime, authorityScope: Object.freeze({ tenantId: authorityScope.tenantId, consumerId: authorityScope.consumerId }) });
  if (!isValidRemoteLocalRuntime(sealedRuntime)) throw new Error('remote-local enrollment returned invalid authority scope');
  await writeState(Object.freeze({ version: 2, brainId, deviceId, credential, privateKeyPem, runtime: sealedRuntime }));
  return Object.freeze({ brainId, deviceId });
}
