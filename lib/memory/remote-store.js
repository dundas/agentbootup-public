import { assertContainedRelativePath } from '../bundle/manifest-schema.js';
import { readCredentials } from '../auth/credentials.js';
import { apiUrl, isValidServerUrl } from '../auth/validate.js';
import { getAgentId } from '../project-config.js';
import { AGENTBOOTUP_VERSION } from '../version.js';
import {
  BRAIN_ASSET_MAX_FILES,
  createBrainAssetSizeError,
  planBrainAssetPushBatches,
  sendBrainAssetBatchWith413Split,
} from '../brain/asset-transport.js';

export const REMOTE_MEMORY_PREFIX = 'memory-store';
const BUNDLE_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Per-fetch timeout for memory server fetches (publisher-head listing, snapshot
 * pulls/pushes). The daemon converge startup runs a freshness check (listing
 * publisher heads) before the initial asset sync, and that fetch — like every
 * memory server fetch that did not receive an explicit fetchFn — used the bare
 * default `fetch` with no per-fetch bound. Against an unresponsive (black-hole)
 * server the GET accepted the TCP connection then hung forever, so the daemon
 * took ~78s to reach "Daemon running" and blew the 30s startup guarantee
 * (smoke-brain-asset-sync-wedge scenario 2). Large bounded snapshot batches can
 * take more than 10s at the storage boundary, so the default covers that proven
 * path while still failing fast against an unresponsive server. Composed manually with any caller signal
 * because AbortSignal.any needs Node >= 20.3 and engines allow 18 (same pattern
 * as the brain-asset-sync push path). Env-overridable for slow links.
 */
function readPositiveMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DEFAULT_MEMORY_FETCH_TIMEOUT_MS = 30_000;

/**
 * Build a fetch function that bounds each call to a per-fetch timeout and
 * composes the timeout with an optional caller signal — either passed as the
 * closure `signal` (e.g. a daemon converge cycle signal) or present on each
 * call's `init.signal`. The caller signal wins when both are supplied. Exported
 * so the memory CLI's runMemoryCommand and other callers reuse the same bound
 * instead of duplicating the helper. The timeout is resolved lazily inside the
 * factory (from AGENTBOOTUP_MEMORY_FETCH_TIMEOUT_MS, default 30s) so env overrides
 * applied after module load — tests, unified-daemon launches — are respected,
 * matching getSyncWatchdogMs/getConvergeStartupMs. Composed manually with the
 * caller signal because AbortSignal.any needs Node >= 20.3 and engines allow 18.
 * @param {AbortSignal} [signal] optional caller/cycle signal to compose with.
 * @param {number} [timeoutMs] override; defaults to AGENTBOOTUP_MEMORY_FETCH_TIMEOUT_MS.
 * @returns {(input: any, init?: any) => Promise<Response>}
 */
export function createBoundedMemoryFetch(signal, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : readPositiveMs(process.env.AGENTBOOTUP_MEMORY_FETCH_TIMEOUT_MS, DEFAULT_MEMORY_FETCH_TIMEOUT_MS);
  return (input, init = {}) => {
    const controller = new AbortController();
    const timerId = setTimeout(
      () => controller.abort(new Error(`memory fetch timeout after ${ms}ms`)),
      ms,
    );
    const callerSignal = init.signal ?? signal;
    const onCallerAbort = () => controller.abort(callerSignal.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    return fetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timerId);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    });
  };
}

function assertBundleHash(bundleHash, label = 'bundle_hash') {
  if (typeof bundleHash !== 'string' || !BUNDLE_HASH_RE.test(bundleHash)) {
    throw new Error(`${label} must match sha256:<64 hex>`);
  }
  return bundleHash;
}

export function headAssetPath(publisherId) {
  return `${REMOTE_MEMORY_PREFIX}/heads/${publisherId}.json`;
}

export function latestAssetPath() {
  return `${REMOTE_MEMORY_PREFIX}/latest.json`;
}

export function snapshotManifestAssetPath(bundleHash) {
  return `${REMOTE_MEMORY_PREFIX}/snapshots/${assertBundleHash(bundleHash, 'remote snapshot bundle_hash')}/manifest.json`;
}

export function snapshotMarkersAssetPath(bundleHash) {
  return `${REMOTE_MEMORY_PREFIX}/snapshots/${assertBundleHash(bundleHash, 'remote snapshot bundle_hash')}/markers.json`;
}

export function snapshotPayloadAssetPath(bundleHash, relPath) {
  const safeBundleHash = assertBundleHash(bundleHash, 'remote snapshot bundle_hash');
  const safeRel = assertContainedRelativePath(relPath, 'remote snapshot payload path');
  if (!safeRel.startsWith('memory/')) {
    throw new Error(`remote snapshot payload path must stay under memory/: ${relPath}`);
  }
  return `${REMOTE_MEMORY_PREFIX}/snapshots/${safeBundleHash}/payload/${safeRel}`;
}

export function snapshotPayloadPrefix(bundleHash) {
  const safeBundleHash = assertBundleHash(bundleHash, 'remote snapshot bundle_hash');
  return `${REMOTE_MEMORY_PREFIX}/snapshots/${safeBundleHash}/payload/memory/`;
}

export function headPathPrefix() {
  return `${REMOTE_MEMORY_PREFIX}/heads/`;
}

export async function resolveRemoteMemoryStoreConfig({
  projectRoot,
  store,
  credentialsReader = readCredentials,
} = {}) {
  if (!store || store.scheme !== 'server') {
    throw new Error(`remote memory store requires scheme 'server' (got ${store?.scheme ?? 'null'})`);
  }

  const creds = await credentialsReader();
  if (!creds?.apiKey || !creds?.serverUrl) {
    throw new Error('remote memory store requires saved credentials (run: agentbootup auth login --api-key <key>)');
  }
  if (!isValidServerUrl(creds.serverUrl)) {
    throw new Error(`remote memory store requires a valid http(s) server URL (got ${creds.serverUrl})`);
  }

  const brainId = typeof store.brainId === 'string' && store.brainId
    ? store.brainId
    : getAgentId(projectRoot);
  if (!brainId) {
    throw new Error('remote memory store requires a brain id (set agentbootup.json agent_id or use server://<brain-id>)');
  }

  return {
    scheme: 'server',
    brainId,
    serverUrl: creds.serverUrl,
    apiKey: creds.apiKey,
  };
}

function authHeaders(apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
  };
}

function buildBrainAssetsUrl(serverUrl, brainId, suffix = '', query = null) {
  const base = apiUrl(serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}${suffix}`);
  if (!query || Object.keys(query).length === 0) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

async function parseApiResponse(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.error?.message || `remote memory store request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.code = body?.error?.code || null;
    throw error;
  }
  return body?.data;
}

function assertRemotePushSucceeded(data, files) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const failed = results.find((result) => result?.status !== 'pushed' && result?.status !== 'updated');
  if (Number(data?.errors) > 0 || failed) {
    const path = failed?.path ?? files[0]?.path ?? '<unknown>';
    const error = new Error(`remote memory asset push rejected ${path}: ${failed?.error ?? 'server reported file errors'}`);
    error.code = 'REMOTE_MEMORY_ASSET_REJECTED';
    error.retryable = true;
    throw error;
  }
  return data;
}

export async function pushRemoteMemoryAssets({
  remote,
  files,
  fetchFn = createBoundedMemoryFetch(),
}) {
  const endpoint = buildBrainAssetsUrl(remote.serverUrl, remote.brainId, '/push');
  const makePayload = (batchFiles) => ({ files: batchFiles });
  const plan = planBrainAssetPushBatches({
    items: files,
    maxFiles: BRAIN_ASSET_MAX_FILES,
    makePayload,
  });
  const responses = [];
  for (const batch of plan.batches) {
    const leaves = await sendBrainAssetBatchWith413Split(batch, {
      makePayload,
      send: (requestBatch) => fetchFn(endpoint, {
        method: 'POST',
        headers: {
          ...authHeaders(remote.apiKey),
          'content-type': 'application/json',
          ...(AGENTBOOTUP_VERSION ? { 'x-agentbootup-version': AGENTBOOTUP_VERSION } : {}),
        },
        body: requestBatch.body,
      }),
    });
    for (const { batch: leafBatch, response } of leaves) {
      if (response.status === 413) {
        const file = leafBatch.items[0];
        throw createBrainAssetSizeError({
          path: file?.path ?? '<unknown>',
          encodedBytes: leafBatch.encodedBytes,
          budget: plan.budget,
          status: 413,
        });
      }
      responses.push(assertRemotePushSucceeded(await parseApiResponse(response), leafBatch.items));
    }
  }
  if (plan.oversized.length > 0) throw createBrainAssetSizeError(plan.oversized[0]);
  if (responses.length === 1) return responses[0];
  return {
    batches: responses.length,
    results: responses.flatMap((data) => Array.isArray(data?.results) ? data.results : []),
  };
}

export async function pullRemoteMemoryAssets({
  remote,
  assetType = 'memory',
  path,
  pathPrefix,
  fetchFn = createBoundedMemoryFetch(),
}) {
  const endpoint = buildBrainAssetsUrl(remote.serverUrl, remote.brainId, '', {
    asset_type: assetType,
    ...(path ? { path } : {}),
    ...(pathPrefix ? { path_prefix: pathPrefix } : {}),
  });
  const response = await fetchFn(endpoint, {
    method: 'GET',
    headers: authHeaders(remote.apiKey),
  });
  return parseApiResponse(response);
}

export async function listRemoteMemoryAssetHashes({
  remote,
  assetType = 'memory',
  pathPrefix,
  fetchFn = createBoundedMemoryFetch(),
}) {
  const endpoint = buildBrainAssetsUrl(remote.serverUrl, remote.brainId, '/hashes', {
    asset_type: assetType,
    ...(pathPrefix ? { path_prefix: pathPrefix } : {}),
  });
  const response = await fetchFn(endpoint, {
    method: 'GET',
    headers: authHeaders(remote.apiKey),
  });
  return parseApiResponse(response);
}

function encodeJsonAsset(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decodeJsonAsset(contentBase64, label) {
  try {
    return JSON.parse(Buffer.from(contentBase64, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractSingleFile(data, label) {
  const files = Array.isArray(data?.files) ? data.files : [];
  if (files.length !== 1) {
    throw new Error(`${label} expected exactly 1 remote asset, got ${files.length}`);
  }
  return files[0];
}

export async function pushRemoteJsonAsset({
  remote,
  path,
  value,
  fetchFn = createBoundedMemoryFetch(),
}) {
  return pushRemoteMemoryAssets({
    remote,
    files: [{
      path,
      content_base64: encodeJsonAsset(value),
      asset_type: 'memory',
      cli: 'shared',
    }],
    fetchFn,
  });
}

export async function pullRemoteSingleAsset({
  remote,
  path,
  fetchFn = createBoundedMemoryFetch(),
}) {
  const data = await pullRemoteMemoryAssets({
    remote,
    path,
    fetchFn,
  });
  return extractSingleFile(data, `remote asset ${path}`);
}

export async function pullRemoteJsonAsset({
  remote,
  path,
  fetchFn = createBoundedMemoryFetch(),
}) {
  const file = await pullRemoteSingleAsset({ remote, path, fetchFn });
  return decodeJsonAsset(file.content_base64, `remote asset ${path}`);
}
