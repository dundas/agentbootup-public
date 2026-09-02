/**
 * Interactive ClearAuth device-login helpers for `agentbootup auth login`.
 *
 * Consumes Parent 3.0 device-auth routes:
 *   POST /v1/device-auth/start
 *   POST /v1/device-auth/poll
 */

import { spawn } from 'child_process';

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MAX_POLL_INTERVAL_SECONDS = 60;
const MAX_GRANT_TTL_SECONDS = 3600;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeServerUrl(serverUrl) {
  return serverUrl.replace(/\/+$/, '');
}

function assertSafeBrowserUrl(url, { forWindows = false } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid verification URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid verification URL protocol');
  }
  const unsafePattern = forWindows ? /[\r\n"&|<>^]/ : /[\r\n"|<>^]/;
  if (unsafePattern.test(url)) {
    throw new Error('Invalid verification URL');
  }
  return url;
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/**
 * @param {string} serverUrl
 * @param {typeof fetch} [fetchImpl]
 */
export async function startDeviceAuth(serverUrl, fetchImpl = fetch) {
  const base = normalizeServerUrl(serverUrl);
  const res = await fetchWithTimeout(fetchImpl, `${base}/v1/device-auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message ?? `device-auth start failed (${res.status})`;
    throw new Error(message);
  }
  const data = body?.data;
  if (
    !data
    || typeof data.device_code !== 'string'
    || typeof data.user_code !== 'string'
    || typeof data.verification_uri !== 'string'
  ) {
    throw new Error('device-auth start returned an invalid response');
  }
  const expiresIn = Math.min(MAX_GRANT_TTL_SECONDS, Number(data.expires_in ?? 600));
  const intervalSeconds = Math.min(
    MAX_POLL_INTERVAL_SECONDS,
    Number(data.interval ?? DEFAULT_POLL_INTERVAL_SECONDS),
  );
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('device-auth start returned invalid polling metadata');
  }
  assertSafeBrowserUrl(data.verification_uri);
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn,
    intervalSeconds,
  };
}

/**
 * @param {string} serverUrl
 * @param {string} deviceCode
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   intervalSeconds?: number,
 *   expiresAtMs?: number,
 *   onPending?: () => void,
 *   onAwaitingKey?: () => void,
 *   minPollIntervalMs?: number,
 * }} [options]
 */
export async function pollDeviceAuth(serverUrl, deviceCode, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = normalizeServerUrl(serverUrl);
  const minPollIntervalMs = options.minPollIntervalMs ?? 1000;
  const intervalMs = Math.max(
    minPollIntervalMs,
    (options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
  );
  const expiresAtMs = options.expiresAtMs ?? (Date.now() + 600_000);
  let approvedNotified = false;
  let pendingNotified = false;
  const notifyAwaitingKey = () => {
    if (approvedNotified) return;
    approvedNotified = true;
    options.onAwaitingKey?.();
  };
  const notifyPending = () => {
    if (pendingNotified) return;
    pendingNotified = true;
    options.onPending?.();
  };

  while (Date.now() < expiresAtMs) {
    let res;
    let body;
    try {
      res = await fetchWithTimeout(fetchImpl, `${base}/v1/device-auth/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      });
      body = await res.json().catch(() => null);
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (Date.now() >= expiresAtMs) break;
        await sleep(intervalMs);
        continue;
      }
      throw err;
    }

    if (res.status === 200 && body?.data?.status === 'pending') {
      notifyPending();
      await sleep(intervalMs);
      continue;
    }

    if (
      (res.status === 200 || res.status === 202)
      && body?.data?.status === 'approved'
      && typeof body?.data?.api_key === 'string'
    ) {
      return {
        apiKey: body.data.api_key,
        keyId: typeof body.data.key_id === 'string' ? body.data.key_id : null,
        userId: typeof body.data.user_id === 'string' ? body.data.user_id : null,
      };
    }

    if (
      (res.status === 202 || res.status === 200)
      && body?.data?.status === 'approved'
    ) {
      notifyAwaitingKey();
      await sleep(intervalMs);
      continue;
    }

    if (res.status === 429) {
      throw new Error(body?.error?.message ?? 'Device auth rate limit exceeded. Try again shortly.');
    }
    if (res.status === 404 || res.status === 410) {
      throw new Error(body?.error?.message ?? 'Device authorization request expired before approval.');
    }
    if (res.status === 409) {
      throw new Error(body?.error?.message ?? 'Device authorization was already consumed.');
    }

    const message = body?.error?.message ?? `device-auth poll failed (${res.status})`;
    throw new Error(message);
  }

  throw new Error('Timed out waiting for browser approval. Open the verification URL and try again.');
}

/**
 * Best-effort browser open; failures are non-fatal.
 *
 * @param {string} uri
 * @param {{ openBrowser?: (url: string) => void }} [options]
 */
export function tryOpenBrowser(uri, options = {}) {
  try {
    assertSafeBrowserUrl(uri, { forWindows: process.platform === 'win32' });
    const open = options.openBrowser ?? defaultOpenBrowser;
    open(uri);
    return true;
  } catch {
    return false;
  }
}

function defaultOpenBrowser(url) {
  // Re-validate: defaultOpenBrowser may be used without tryOpenBrowser's guard.
  if (process.platform === 'darwin') {
    const safeUrl = assertSafeBrowserUrl(url);
    spawnDetached('open', [safeUrl]);
    return;
  }
  if (process.platform === 'win32') {
    const safeUrl = assertSafeBrowserUrl(url, { forWindows: true });
    spawnDetached('cmd', ['/c', 'start', '""', safeUrl]);
    return;
  }
  const safeUrl = assertSafeBrowserUrl(url);
  spawnDetached('xdg-open', [safeUrl]);
}
