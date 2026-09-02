/**
 * Tests for brain-asset-sync.mjs — maybeAutoPushNetworkConfig
 *
 * We test the exported function directly. The production file exports:
 *   - maybeAutoPushNetworkConfig(apiKey, serverUrl, projectRoot)
 *   - _resetNetworkConfigMtime()
 *   - formatFailFastMessage(brainId)
 *
 * We control getNetworkRoot() via the AGENTBOOTUP_NETWORK_ROOT env var,
 * which the real config.js implementation respects, avoiding mock.module
 * pollution across the shared module registry.
 */

import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import http from 'http';
import { MechStorageBackend } from '../../lib/skill-projection/backends/mech-storage.js';
import { getBrainAssetSources } from '../../lib/brain/asset-sources.js';

// ---------------------------------------------------------------------------
// Import exported helpers from the daemon module
// import.meta.main guard prevents the daemon from starting on import.
// ---------------------------------------------------------------------------

const {
  maybeAutoPushNetworkConfig,
  _resetNetworkConfigMtime,
  formatFailFastMessage,
  isEphemeralAssetPath,
  syncPendingFiles,
  getBrainSyncHealthPath,
  readBrainSyncHealth,
  readCurrentBrainSyncHealth,
  readLivePersistedBrainSyncHealth,
  recordBrainSyncHealth,
  getMemoryReplayHealth,
  startHealthServer,
  _setMemoryPushGate,
  _setConvergeHealthProvider,
  syncAfterSafeConverge,
} =
  await import('../../lib/daemon/brain-asset-sync.mjs');
const { enqueueReplayItem, recordReplayFailure } = await import('../../lib/memory/replay-queue.js');
const { resolveMemoryStore } = await import('../../lib/memory/store.js');

// ---------------------------------------------------------------------------
// Shared state for fetch mock
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let capturedRequests: Array<{ url: string; method: string; body?: unknown }> = [];
let mockResponses: Array<{ status: number; body: unknown }> = [];

function installFetchMock() {
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method || 'GET';
    let body: unknown;
    if (init?.body) {
      try { body = JSON.parse(init.body as string); } catch { body = init.body; }
    }
    capturedRequests.push({ url, method, body });
    const mock = mockResponses.shift();
    if (!mock) throw new Error('No mock response configured');
    return new Response(JSON.stringify(mock.body), {
      status: mock.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Temp dir setup
// ---------------------------------------------------------------------------

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-bas-test-'));

function writeBackupPolicy(projectRoot: string) {
  let brainId = 'daemon-test';
  try {
    brainId = JSON.parse(fs.readFileSync(path.join(projectRoot, 'agentbootup.json'), 'utf8')).agent_id || brainId;
  } catch {
    // Negative-path fixtures may not carry project identity.
  }
  fs.writeFileSync(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: brainId,
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
}

afterAll(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.AGENTBOOTUP_NETWORK_ROOT;
  await fsp.rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function makeTempNetworkDir(config: Record<string, unknown>): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(tmpBase, 'net-'));
  await fsp.writeFile(
    path.join(dir, 'agentbootup.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
  return dir;
}

async function getHealthResponse(server: http.Server, route: string) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('health server did not bind a port');
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${address.port}${route}`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
    });
    request.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedRequests = [];
  mockResponses = [];
  delete process.env.AGENTBOOTUP_NETWORK_ROOT;
  _resetNetworkConfigMtime();
  installFetchMock();
  process.env.AGENTBOOTUP_DAEMON_DIR = path.join(tmpBase, `daemon-${Date.now()}-${Math.random()}`);
  _setConvergeHealthProvider(() => ({
    state: 'ok',
    detail: 'safe test converge',
    enabled: true,
    configSource: 'default',
    store: 'server://test-brain.gm',
    gateOpen: true,
    lastCycleAt: new Date().toISOString(),
    freshnessState: 'ok',
    freshnessCheckedAt: new Date().toISOString(),
  }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AGENTBOOTUP_NETWORK_ROOT;
  delete process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE;
  delete process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES;
  delete process.env.AGENTBOOTUP_DAEMON_DIR;
  _setMemoryPushGate(() => true);
  _setConvergeHealthProvider(null);
});

test('daemon health degrades after three failed cycles and resets after success', () => {
  const brainId = 'asset-sync-test.gm';
  expect(recordBrainSyncHealth(brainId, 0, 1).degraded).toBe(false);
  expect(recordBrainSyncHealth(brainId, 0, 1).consecutiveFailedCycles).toBe(2);
  expect(recordBrainSyncHealth(brainId, 0, 1)).toMatchObject({
    consecutiveFailedCycles: 3,
    degraded: true,
  });
  expect(readCurrentBrainSyncHealth(brainId)?.degraded).toBe(true);
  expect(recordBrainSyncHealth(brainId, 1, 0)).toMatchObject({
    consecutiveFailedCycles: 0,
    degraded: false,
  });
});

test('persisted and standalone health preserve canonical converge failure under inherited JSON hooks', async () => {
  const brainId = 'prototype-safe-health.gm';
  _setConvergeHealthProvider(() => ({
    state: 'publish_blocked',
    detail: 'raw=SENTINEL_UNTRUSTED_DETAIL',
    failure: {
      schema: 'memory-convergence-failure/v1',
      phase: 'publish',
      category: 'conflict',
      exit_code: 3,
      conflict: {
        schema: 'memory-conflict/v1',
        conflicts: [{ path: 'memory/a.md', reason_code: 'store_changed_since_baseline' }],
        omitted_count: 0,
      },
    },
    enabled: true,
    configSource: 'default',
    store: `server://${brainId}`,
    gateOpen: false,
    lastCycleAt: '2026-08-12T00:00:00.000Z',
    freshnessState: 'stale',
    freshnessCheckedAt: '2026-08-12T00:00:00.000Z',
    freshnessHeadCount: 2,
    escalated: false,
  }));
  const server = startHealthServer(brainId, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  const objectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const arrayMap = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
  const schema = Object.getOwnPropertyDescriptor(Object.prototype, 'schema');
  const numeric = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let persistedWire = '';
  let readback: ReturnType<typeof readBrainSyncHealth> = null;
  let healthResponse: Awaited<ReturnType<typeof getHealthResponse>> | null = null;
  let statusResponse: Awaited<ReturnType<typeof getHealthResponse>> | null = null;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => ({ leaked: 'SENTINEL_OBJECT_TO_JSON' }),
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => ['SENTINEL_ARRAY_TO_JSON'],
    });
    Object.defineProperty(Array.prototype, 'map', {
      configurable: true,
      writable: true,
      value: () => ['SENTINEL_ARRAY_MAP'],
    });
    Object.defineProperty(Object.prototype, 'schema', {
      configurable: true,
      set(value) {
        Object.defineProperty(this, 'schema', {
          configurable: true, enumerable: true, writable: true,
          value: String(value).includes('memory-') ? 'SENTINEL_INHERITED_SCHEMA' : value,
        });
      },
    });
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set(value) {
        Object.defineProperty(this, '0', {
          configurable: true, enumerable: true, writable: true,
          value: value?.path === 'memory/a.md'
            ? { path: 'memory/SENTINEL_INHERITED.md', reason_code: 'store_changed_since_baseline' }
            : value,
        });
      },
    });

    recordBrainSyncHealth(brainId, 0, 1);
    persistedWire = fs.readFileSync(getBrainSyncHealthPath(brainId), 'utf8');
    readback = readBrainSyncHealth(brainId);
    healthResponse = await getHealthResponse(server, '/health');
    statusResponse = await getHealthResponse(server, '/status');
  } finally {
    if (objectToJSON) Object.defineProperty(Object.prototype, 'toJSON', objectToJSON);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    if (arrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', arrayToJSON);
    else delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
    if (arrayMap) Object.defineProperty(Array.prototype, 'map', arrayMap);
    else delete Array.prototype.map;
    if (schema) Object.defineProperty(Object.prototype, 'schema', schema);
    else delete (Object.prototype as Record<string, unknown>).schema;
    if (numeric) Object.defineProperty(Array.prototype, '0', numeric);
    else delete (Array.prototype as unknown as Record<string, unknown>)['0'];
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }

  const expectedFailure = {
    schema: 'memory-convergence-failure/v1',
    phase: 'publish',
    category: 'conflict',
    exit_code: 3,
    conflict: {
      schema: 'memory-conflict/v1',
      conflicts: [{ path: 'memory/a.md', reason_code: 'store_changed_since_baseline' }],
      omitted_count: 0,
    },
  };
  expect(JSON.parse(persistedWire).memoryConverge.failure).toEqual(expectedFailure);
  expect(readback?.memoryConverge?.failure).toEqual(expectedFailure);
  expect(healthResponse?.status).toBe(503);
  expect(healthResponse?.body.syncHealth.memoryConverge.failure).toEqual(expectedFailure);
  expect(statusResponse?.status).toBe(200);
  expect(statusResponse?.body.syncHealth.memoryConverge.failure).toEqual(expectedFailure);
  expect(`${persistedWire}\n${JSON.stringify(healthResponse?.body)}\n${JSON.stringify(statusResponse?.body)}`)
    .not.toContain('SENTINEL');
});

test('post-startup asset resync runs only after an immediate converge proof opens the gate', async () => {
  let syncCalls = 0;
  const syncFn = async () => { syncCalls += 1; };

  expect(await syncAfterSafeConverge(Promise.resolve({ gateOpen: false }), syncFn, () => {})).toBe(false);
  expect(syncCalls).toBe(0);

  expect(await syncAfterSafeConverge(Promise.resolve({ gateOpen: true }), syncFn, () => {})).toBe(true);
  expect(syncCalls).toBe(1);
});

test('post-startup asset resync contains proof/sync errors', async () => {
  const errors: string[] = [];
  expect(await syncAfterSafeConverge(
    Promise.reject(new Error('proof failed')),
    async () => {},
    (message: string) => errors.push(message),
  )).toBe(false);
  expect(errors).toEqual(['Post-converge asset sync failed']);
});

test('post-converge resync waits for an in-flight closed-gate pass and then discovers memory afresh', async () => {
  const projectRoot = await makeQuarantineProject('post-converge-fresh-');
  await fsp.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'discover only after proof\n');
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'post-converge-fresh.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = path.join(projectRoot, 'sync-state.json');

  let fetchCalls = 0;
  let releaseFirstFetch!: () => void;
  const firstFetchBlocked = new Promise<void>((resolve) => { releaseFirstFetch = resolve; });
  const requests: any[][] = [];
  globalThis.fetch = (async (_i: string | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    requests.push(body.files ?? []);
    fetchCalls += 1;
    if (fetchCalls === 1) await firstFetchBlocked;
    return new Response(JSON.stringify({
      data: { results: (body.files ?? []).map((file: any) => ({ path: file.path, status: 'pushed' })) },
    }), { status: 200 });
  }) as typeof fetch;

  const args = [
    'post-converge-fresh.gm',
    'test-key',
    'http://localhost:9999',
    projectRoot,
    getBrainAssetSources(projectRoot),
    { shouldSkip: () => false },
    'machine-id',
  ] as const;

  try {
    _setMemoryPushGate(() => false);
    const initial = syncPendingFiles(...args);
    for (let i = 0; i < 100 && fetchCalls === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(fetchCalls).toBe(1);
    expect(requests[0].some((file: any) => file.path.startsWith('memory/'))).toBe(false);

    _setMemoryPushGate(() => true);
    const fresh = syncAfterSafeConverge(
      Promise.resolve({ gateOpen: true }),
      () => syncPendingFiles(...args),
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetchCalls).toBe(1);

    releaseFirstFetch();
    await initial;
    expect(await fresh).toBe(true);
    expect(fetchCalls).toBeGreaterThanOrEqual(2);
    expect(requests.slice(1).flat().some((file: any) => file.path === 'memory/MEMORY.md')).toBe(true);
  } finally {
    releaseFirstFetch?.();
    _setMemoryPushGate(() => true);
  }
});

test('daemon health persists replay state from only its injected project root', () => {
  const projectRoot = fs.mkdtempSync(path.join(tmpBase, 'replay-health-project-'));
  const storeRoot = fs.mkdtempSync(path.join(tmpBase, 'replay-health-store-'));
  fs.writeFileSync(path.join(projectRoot, 'agentbootup.json'), JSON.stringify({ agent_id: 'replay-health.gm' }));
  fs.mkdirSync(path.join(projectRoot, 'memory'));
  fs.writeFileSync(path.join(projectRoot, 'memory', 'MEMORY.md'), 'queued\n');
  writeBackupPolicy(projectRoot);
  enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'queued' });

  expect(getMemoryReplayHealth(projectRoot)).toEqual({ pending: 1, degraded: 0, invalid: false });
  const health = recordBrainSyncHealth('replay-health.gm', 1, 0, projectRoot);
  expect(health.memoryReplay).toEqual({ pending: 1, degraded: 0, invalid: false });
  expect(readBrainSyncHealth('replay-health.gm')?.memoryReplay).toEqual({ pending: 1, degraded: 0, invalid: false });
});

test('daemon health degrades terminal replay heads that block the FIFO', () => {
  const projectRoot = fs.mkdtempSync(path.join(tmpBase, 'replay-health-blocked-project-'));
  const storeRoot = fs.mkdtempSync(path.join(tmpBase, 'replay-health-blocked-store-'));
  fs.writeFileSync(path.join(projectRoot, 'agentbootup.json'), JSON.stringify({ agent_id: 'replay-blocked.gm' }));
  fs.mkdirSync(path.join(projectRoot, 'memory'));
  fs.writeFileSync(path.join(projectRoot, 'memory', 'MEMORY.md'), 'blocked\n');
  writeBackupPolicy(projectRoot);
  const queued = enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'blocked' });
  recordReplayFailure({ projectRoot, id: queued.item.id, type: 'blocked_conflict', detail: 'remote page changed' });

  expect(getMemoryReplayHealth(projectRoot)).toEqual({ pending: 1, degraded: 1, invalid: false });
  const health = recordBrainSyncHealth('replay-blocked.gm', 1, 0, projectRoot);
  expect(health.memoryReplay).toEqual({ pending: 1, degraded: 1, invalid: false });
});

test('daemon health reports an unsafe replay queue path as invalid without aborting', () => {
  const projectRoot = fs.mkdtempSync(path.join(tmpBase, 'replay-health-invalid-project-'));
  const outside = fs.mkdtempSync(path.join(tmpBase, 'replay-health-invalid-outside-'));
  fs.symlinkSync(outside, path.join(projectRoot, '.brain'));

  expect(getMemoryReplayHealth(projectRoot)).toEqual({ pending: null, degraded: 0, invalid: true });
  const health = recordBrainSyncHealth('replay-health-invalid.gm', 1, 0, projectRoot);
  expect(health.memoryReplay).toEqual({ pending: null, degraded: 0, invalid: true });
  expect(readBrainSyncHealth('replay-health-invalid.gm')?.memoryReplay).toEqual({ pending: null, degraded: 0, invalid: true });
});

test('daemon health preserves a long same-process failure streak but isolates a restart', () => {
  const brainId = 'restart-sync-test.gm';
  recordBrainSyncHealth(brainId, 0, 1);
  recordBrainSyncHealth(brainId, 0, 1);
  const healthPath = getBrainSyncHealthPath(brainId);
  const delayed = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
  delayed.lastSyncAt = new Date(Date.now() - 123_000).toISOString();
  fs.writeFileSync(healthPath, JSON.stringify(delayed));
  expect(recordBrainSyncHealth(brainId, 0, 1)).toMatchObject({
    consecutiveFailedCycles: 3,
    degraded: true,
  });

  const restarted = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
  restarted.instanceId = 'previous-daemon-instance';
  fs.writeFileSync(healthPath, JSON.stringify(restarted));
  expect(readCurrentBrainSyncHealth(brainId)).toBeNull();
  expect(recordBrainSyncHealth(brainId, 0, 1)).toMatchObject({
    consecutiveFailedCycles: 1,
    degraded: false,
  });
  expect(readBrainSyncHealth(brainId)?.pid).toBe(process.pid);
});

test('standalone health endpoint reports active degradation and ignores a prior instance', async () => {
  const brainId = 'endpoint-sync-test.gm';
  const server = startHealthServer(brainId, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    recordBrainSyncHealth(brainId, 0, 1);
    recordBrainSyncHealth(brainId, 0, 1);
    recordBrainSyncHealth(brainId, 0, 1);
    const degraded = await getHealthResponse(server, '/health');
    expect(degraded.status).toBe(503);
    expect(degraded.body).toMatchObject({ healthy: false, syncHealth: { degraded: true } });
    const status = await getHealthResponse(server, '/status');
    expect(status.body.syncHealth).toMatchObject({ degraded: true });

    const healthPath = getBrainSyncHealthPath(brainId);
    const prior = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    prior.instanceId = 'previous-daemon-instance';
    fs.writeFileSync(healthPath, JSON.stringify(prior));
    const restarted = await getHealthResponse(server, '/health');
    expect(restarted.status).toBe(503);
    expect(restarted.body).toMatchObject({ healthy: false, syncHealth: null });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('standalone health endpoint is non-green for a partially successful cycle with any file error', async () => {
  const brainId = 'endpoint-partial-error.gm';
  const server = startHealthServer(brainId, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    recordBrainSyncHealth(brainId, 2, 1);
    const response = await getHealthResponse(server, '/health');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      healthy: false,
      syncHealth: { lastPushed: 2, lastErrors: 1 },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('standalone health endpoint fails closed for unknown or unsafe converge health', async () => {
  const brainId = 'endpoint-converge-unsafe.gm';
  const server = startHealthServer(brainId, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    _setConvergeHealthProvider(null);
    recordBrainSyncHealth(brainId, 1, 0);
    const unknown = await getHealthResponse(server, '/health');
    expect(unknown.status).toBe(503);
    expect(unknown.body).toMatchObject({ healthy: false, syncHealth: { memoryConverge: null } });

    _setConvergeHealthProvider(() => ({
      state: 'unknown',
      detail: 'legacy state vocabulary',
      enabled: true,
      configSource: 'default',
      store: `server://${brainId}`,
      gateOpen: true,
      lastCycleAt: new Date().toISOString(),
      freshnessState: 'ok',
      freshnessCheckedAt: new Date().toISOString(),
    }));
    recordBrainSyncHealth(brainId, 1, 0);
    const unknownState = await getHealthResponse(server, '/health');
    expect(unknownState.status).toBe(503);
    expect(unknownState.body).toMatchObject({
      healthy: false,
      syncHealth: { memoryConverge: { state: 'unknown', gateOpen: true } },
    });

    _setConvergeHealthProvider(() => ({
      state: 'stale',
      detail: 'stale publisher head remains',
      enabled: true,
      configSource: 'default',
      store: `server://${brainId}`,
      gateOpen: false,
      lastCycleAt: new Date().toISOString(),
      freshnessState: 'stale',
      freshnessCheckedAt: new Date().toISOString(),
    }));
    recordBrainSyncHealth(brainId, 1, 0);
    const stale = await getHealthResponse(server, '/health');
    expect(stale.status).toBe(503);
    expect(stale.body).toMatchObject({
      healthy: false,
      syncHealth: { memoryConverge: { state: 'stale', gateOpen: false } },
    });

    for (const freshnessState of ['stale', 'future_status']) {
      _setConvergeHealthProvider(() => ({
        state: 'ok',
        detail: `contradictory freshness: ${freshnessState}`,
        enabled: true,
        configSource: 'default',
        store: `server://${brainId}`,
        gateOpen: true,
        lastCycleAt: new Date().toISOString(),
        freshnessState,
        freshnessCheckedAt: new Date().toISOString(),
      }));
      recordBrainSyncHealth(brainId, 1, 0);
      const contradictory = await getHealthResponse(server, '/health');
      expect(contradictory.status).toBe(503);
      expect(contradictory.body).toMatchObject({
        healthy: false,
        syncHealth: { memoryConverge: { state: 'ok', gateOpen: true, freshnessState } },
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('standalone health endpoint reports an invalid replay queue as unhealthy', async () => {
  const brainId = 'endpoint-replay-invalid.gm';
  const projectRoot = fs.mkdtempSync(path.join(tmpBase, 'endpoint-replay-invalid-project-'));
  const outside = fs.mkdtempSync(path.join(tmpBase, 'endpoint-replay-invalid-outside-'));
  fs.symlinkSync(outside, path.join(projectRoot, '.brain'));
  const server = startHealthServer(brainId, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    recordBrainSyncHealth(brainId, 1, 0, projectRoot);
    const response = await getHealthResponse(server, '/health');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ healthy: false, syncHealth: { memoryReplay: { invalid: true } } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('standalone health endpoint reports a degraded replay queue as unhealthy', async () => {
  const brainId = 'endpoint-replay-degraded.gm';
  const projectRoot = fs.mkdtempSync(path.join(tmpBase, 'endpoint-replay-degraded-project-'));
  const storeRoot = fs.mkdtempSync(path.join(tmpBase, 'endpoint-replay-degraded-store-'));
  fs.mkdirSync(path.join(projectRoot, 'memory'));
  fs.writeFileSync(path.join(projectRoot, 'memory', 'MEMORY.md'), 'queued\n');
  writeBackupPolicy(projectRoot);
  const queued = enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'queued' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    recordReplayFailure({ projectRoot, id: queued.item.id, type: 'retrying', detail: 'store write failed' });
  }
  const server = startHealthServer(brainId, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    recordBrainSyncHealth(brainId, 1, 0, projectRoot);
    const response = await getHealthResponse(server, '/health');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ healthy: false, syncHealth: { memoryReplay: { degraded: 1, invalid: false } } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('health remains truthful when persistence temporarily fails and recovers', () => {
  const brainId = 'persistence-failure-test.gm';
  expect(recordBrainSyncHealth(brainId, 1, 0).persisted).toBe(true);
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (() => { throw new Error('disk full'); }) as typeof fs.writeFileSync;
    expect(recordBrainSyncHealth(brainId, 0, 1).persisted).toBe(false);
    expect(recordBrainSyncHealth(brainId, 0, 1).persisted).toBe(false);
    const failed = recordBrainSyncHealth(brainId, 0, 1);
    expect(failed).toMatchObject({ persisted: false, degraded: true });
    expect(readCurrentBrainSyncHealth(brainId)).toMatchObject({ degraded: true });
  } finally {
    fs.writeFileSync = originalWrite;
  }

  const recovered = recordBrainSyncHealth(brainId, 1, 0);
  expect(recovered).toMatchObject({ persisted: true, degraded: false });
  expect(readCurrentBrainSyncHealth(brainId)).toMatchObject({ degraded: false });
});

test('CLI reader accepts only a live matching persisted brain health record', () => {
  const brainId = `cli-health-${Date.now()}`;
  recordBrainSyncHealth(brainId, 0, 1);
  expect(readLivePersistedBrainSyncHealth(brainId, process.pid)).toMatchObject({ brainId, pid: process.pid });
  expect(readLivePersistedBrainSyncHealth(brainId, process.pid + 1)).toBeNull();
  const healthPath = getBrainSyncHealthPath(brainId);
  fs.writeFileSync(healthPath, JSON.stringify({ brainId, pid: 999999999, degraded: true }) + '\n');
  expect(readLivePersistedBrainSyncHealth(brainId)).toBeNull();
});

test('generated assets are excluded by the documented portable-state policy', () => {
  const root = '/tmp/project';
  expect(isEphemeralAssetPath('/tmp/project/memory/narratives/run.md', root)).toBe(true);
  expect(isEphemeralAssetPath('/tmp/project/memory/messages/inbox.md', root)).toBe(true);
  expect(isEphemeralAssetPath('/tmp/project/memory/campaigns/check.loop.log', root)).toBe(true);
  expect(isEphemeralAssetPath('/tmp/project/.claude/skills/x/result.out.log', root)).toBe(true);
  expect(isEphemeralAssetPath('/tmp/project/memory/wiki-browser.html', root)).toBe(true);
  expect(isEphemeralAssetPath('/tmp/project/.claude/skills/x/wiki-browser.html', root)).toBe(false);
  expect(isEphemeralAssetPath('/tmp/project/memory/MEMORY.md', root)).toBe(false);
});

test('sync omits zero-byte and generated files while pushing an eligible asset', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'asset-project-'));
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'sample');
  await fsp.mkdir(skillRoot, { recursive: true });
  await fsp.writeFile(path.join(skillRoot, 'SKILL.md'), '# sample\n');
  await fsp.writeFile(path.join(skillRoot, 'empty.md'), '');
  await fsp.writeFile(path.join(skillRoot, 'trace.loop.log'), 'local trace');
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = path.join(projectRoot, 'sync-state.json');
  mockResponses.push({ status: 200, body: { data: { results: [{ path: '.claude/skills/sample/SKILL.md', status: 'pushed' }] } } });

  await syncPendingFiles('asset-sync-test.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id');

  const body = capturedRequests[0].body as { files: Array<{ path: string }> };
  expect(body.files.map((file) => file.path)).toEqual(['.claude/skills/sample/SKILL.md']);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Test 4: fires when projectRoot === networkRoot and config changed
test('maybeAutoPushNetworkConfig fires when projectRoot === networkRoot and config changed', async () => {
  const netDir = await makeTempNetworkDir({
    version: '2.0',
    role: 'network',
    projects: [{ id: 'a', agent_id: 'a.gm', path: '/local/path/a' }],
  });

  // Control getNetworkRoot via env var — no mock.module needed
  process.env.AGENTBOOTUP_NETWORK_ROOT = netDir;

  // pushNetworkConfig internally calls PUT /v1/network-config
  mockResponses.push({ status: 200, body: { data: { projectCount: 1 } } });

  await maybeAutoPushNetworkConfig('test-key', 'http://localhost:9999', netDir);

  expect(capturedRequests.length).toBe(1);
  expect(capturedRequests[0].method).toBe('PUT');
  expect(capturedRequests[0].url).toContain('/v1/network-config');

  // The payload must not contain path fields (pushNetworkConfig strips them)
  const body = capturedRequests[0].body as Record<string, unknown>;
  const projects = body.projects as Array<Record<string, unknown>>;
  expect(projects.length).toBe(1);
  expect('path' in projects[0]).toBe(false);
});

// Test 5: no-op when projectRoot !== networkRoot
test('maybeAutoPushNetworkConfig is a no-op when projectRoot !== networkRoot', async () => {
  const netDir = await makeTempNetworkDir({
    version: '2.0',
    role: 'network',
    projects: [],
  });
  process.env.AGENTBOOTUP_NETWORK_ROOT = netDir;

  const differentRoot = path.join(tmpBase, 'different-project');
  await fsp.mkdir(differentRoot, { recursive: true });

  await maybeAutoPushNetworkConfig('test-key', 'http://localhost:9999', differentRoot);

  expect(capturedRequests.length).toBe(0);
});

// Test 6: mtime dedup — does not push twice for same file
test('maybeAutoPushNetworkConfig does not push twice when mtime unchanged', async () => {
  const netDir = await makeTempNetworkDir({
    version: '2.0',
    role: 'network',
    projects: [{ id: 'b', agent_id: 'b.gm' }],
  });
  process.env.AGENTBOOTUP_NETWORK_ROOT = netDir;

  // First call — should push
  mockResponses.push({ status: 200, body: { data: { projectCount: 1 } } });
  await maybeAutoPushNetworkConfig('test-key', 'http://localhost:9999', netDir);
  expect(capturedRequests.length).toBe(1);

  // Second call with same mtime — should NOT push
  capturedRequests = [];
  await maybeAutoPushNetworkConfig('test-key', 'http://localhost:9999', netDir);
  expect(capturedRequests.length).toBe(0);

  // Reset mtime cache, call again — should push once more
  _resetNetworkConfigMtime();
  mockResponses.push({ status: 200, body: { data: { projectCount: 1 } } });
  await maybeAutoPushNetworkConfig('test-key', 'http://localhost:9999', netDir);
  expect(capturedRequests.length).toBe(1);
});

// Test 7 (bonus): error is swallowed, mtime not updated on push failure
test('maybeAutoPushNetworkConfig swallows errors and retries after push failure', async () => {
  const netDir = await makeTempNetworkDir({
    version: '2.0',
    role: 'network',
    projects: [{ id: 'c', agent_id: 'c.gm' }],
  });
  process.env.AGENTBOOTUP_NETWORK_ROOT = netDir;

  // First call: server returns 500
  mockResponses.push({ status: 500, body: { error: 'internal server error' } });

  // Must not throw
  let threw = false;
  try {
    await maybeAutoPushNetworkConfig('test-key', 'http://localhost:9999', netDir);
  } catch {
    threw = true;
  }
  expect(threw).toBe(false);
  expect(capturedRequests.length).toBe(1);

  // Mtime was NOT cached on failure — second call should try again
  capturedRequests = [];
  mockResponses.push({ status: 200, body: { data: { projectCount: 1 } } });
  await maybeAutoPushNetworkConfig('test-key', 'http://localhost:9999', netDir);
  expect(capturedRequests.length).toBe(1);
});

// ---------------------------------------------------------------------------
// Phase 7 Gap 2: fail-fast error message format
// Tests that isEmptyStore() + the expected error message string are consistent.
// The fail-fast logic in main() is not directly testable (it calls process.exit),
// but we verify: (a) isEmptyStore() works correctly via the real MechStorageBackend,
// and (b) the error message string (imported from production code) matches the
// documented format — catching silent refactoring of the user-facing error text.
// ---------------------------------------------------------------------------

const EXPECTED_FAIL_FAST_MESSAGE_PATTERN =
  /ERROR: No skills found in Mech Storage for .+\. Run: agentbootup skills migrate --from static --to mech-storage/;

test('fail-fast: isEmptyStore returns true when Mech Storage collection is empty', async () => {
  // Mock mechClient returning empty listDocuments — simulates empty Mech Storage
  const emptyMechClient = {
    listDocuments: async (_collection: string) => [],
    getDocument: async (_id: string) => null,
    createDocument: async (_collection: string, _data: unknown) => 'doc-1',
    updateDocument: async () => {},
    deleteDocument: async () => {},
  };

  const backend = new MechStorageBackend({ mechClient: emptyMechClient as any, agentId: 'test-brain.gm' });
  const isEmpty = await backend.isEmptyStore();
  expect(isEmpty).toBe(true);
});

test('fail-fast: isEmptyStore returns false when skills exist in Mech Storage', async () => {
  const nonEmptyMechClient = {
    listDocuments: async (_collection: string) => [
      { id: 'skill-1', document_id: 'skill-1', document: { name: 'my-skill', scope: 'master', tenantId: null, content: '# Skill', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } },
    ],
    getDocument: async (_id: string) => null,
    createDocument: async () => 'doc-1',
    updateDocument: async () => {},
    deleteDocument: async () => {},
  };

  const backend = new MechStorageBackend({ mechClient: nonEmptyMechClient as any, agentId: 'test-brain.gm' });
  const isEmpty = await backend.isEmptyStore();
  expect(isEmpty).toBe(false);
});

test('fail-fast: error message format matches expected pattern', () => {
  // Validate the actual production error message from brain-asset-sync.mjs.
  // Uses formatFailFastMessage imported from the module so that a change to the
  // production string will break this test (guards against silent refactoring).
  const brainId = 'signal.gm';
  const message = formatFailFastMessage(brainId);
  expect(message).toMatch(EXPECTED_FAIL_FAST_MESSAGE_PATTERN);
  expect(message).toContain(brainId);
  expect(message).toContain('agentbootup skills migrate --from static --to mech-storage');
});

// ---------------------------------------------------------------------------
// Wedge fixes: walk pruning, per-source depth, sync watchdog, idle logging,
// listDocuments timeout (bug report msg-1784215098537-ia98qk)
// ---------------------------------------------------------------------------

const {
  walkDir,
  discoverAllAssets,
  buildMechStorageClient,
  getConvergeStartupMs,
} = await import('../../lib/daemon/brain-asset-sync.mjs');

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of gen) out.push(item);
  return out.sort();
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { lines, restore: () => { process.stdout.write = original; } };
}

test('walkDir prunes node_modules and .git instead of descending into them', async () => {
  const root = await fsp.mkdtemp(path.join(tmpBase, 'walk-prune-'));
  await fsp.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fsp.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(root, 'node_modules', 'dep', 'README.md'), 'x');
  await fsp.writeFile(path.join(root, '.git', 'objects', 'abc'), 'x');
  await fsp.writeFile(path.join(root, 'sub', 'keep.md'), 'x');
  await fsp.writeFile(path.join(root, 'top.md'), 'x');

  const found = await collect(walkDir(root));
  expect(found).toEqual([path.join(root, 'sub', 'keep.md'), path.join(root, 'top.md')].sort());
});

test('walkDir honors a maxDepth of 0 by yielding only direct children', async () => {
  const root = await fsp.mkdtemp(path.join(tmpBase, 'walk-depth-'));
  await fsp.mkdir(path.join(root, 'deep'), { recursive: true });
  await fsp.writeFile(path.join(root, 'deep', 'nested.md'), 'x');
  await fsp.writeFile(path.join(root, 'top.md'), 'x');

  const found = await collect(walkDir(root, 0, { maxDepth: 0 }));
  expect(found).toEqual([path.join(root, 'top.md')]);
});

test('discoverAllAssets walks the project-root config source shallowly', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'discover-shallow-'));
  // A CLAUDE.md nested one level down must NOT be discovered as root config,
  // and the walk must not need to visit it to decide that.
  await fsp.mkdir(path.join(projectRoot, 'packages', 'a'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'packages', 'a', 'CLAUDE.md'), 'nested');
  await fsp.writeFile(path.join(projectRoot, 'CLAUDE.md'), 'root config');

  const sources = getBrainAssetSources(projectRoot).filter(
    (s: any) => s.asset_type === 'config' && s.rootFn() === path.resolve(projectRoot),
  );
  expect(sources.length).toBe(1);
  // The source must declare a shallow walk so large repos are never traversed.
  expect(sources[0].walkDepth).toBe(0);

  const assets = await discoverAllAssets(sources, { shouldSkip: () => false }, projectRoot);
  expect(assets.map((a: any) => a.path)).toEqual([path.join(projectRoot, 'CLAUDE.md')]);
});

test('sync logs "Sync complete" even when nothing was pushed', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'idle-log-'));
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = path.join(projectRoot, 'sync-state.json');

  const stdout = captureStdout();
  try {
    await syncPendingFiles('asset-sync-test.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id');
  } finally {
    stdout.restore();
  }
  const completeLine = stdout.lines.find((l) => l.includes('Sync complete'));
  expect(completeLine).toBeDefined();
  expect(completeLine).toContain('pushed=0');
});

test('watchdog aborts a wedged sync and releases the lock for the next cycle', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'watchdog-abort-'));
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'sample');
  await fsp.mkdir(skillRoot, { recursive: true });
  await fsp.writeFile(path.join(skillRoot, 'SKILL.md'), '# sample\n');
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = path.join(projectRoot, 'sync-state.json');
  process.env.AGENTBOOTUP_SYNC_WATCHDOG_MS = '80';

  let fetchCalls = 0;
  // First fetch hangs until aborted (simulates a scale-to-zero server that
  // never responds); later fetches succeed.
  globalThis.fetch = (async (_input: string | Request, init?: RequestInit) => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return new Response(JSON.stringify({ data: { results: [{ path: '.claude/skills/sample/SKILL.md', status: 'pushed' }] } }), { status: 200 });
  }) as typeof fetch;

  try {
    const args = ['asset-sync-test.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id'] as const;
    // First sync wedges; the watchdog must abort it and release the lock.
    await syncPendingFiles(...args);
    // A second sync must actually run (not "already in progress").
    await syncPendingFiles(...args);
    expect(fetchCalls).toBe(2);
  } finally {
    delete process.env.AGENTBOOTUP_SYNC_WATCHDOG_MS;
  }
});

test('watchdog releases the lock even when the wedged operation ignores abort', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'watchdog-ignore-'));
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'sample');
  await fsp.mkdir(skillRoot, { recursive: true });
  await fsp.writeFile(path.join(skillRoot, 'SKILL.md'), '# sample\n');
  const stateFile = path.join(projectRoot, 'sync-state.json');
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = stateFile;
  process.env.AGENTBOOTUP_SYNC_WATCHDOG_MS = '80';

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    if (fetchCalls === 1) return new Promise(() => {}); // never settles, ignores abort
    return new Response(JSON.stringify({ data: { results: [{ path: '.claude/skills/sample/SKILL.md', status: 'pushed' }] } }), { status: 200 });
  }) as typeof fetch;

  try {
    const args = ['asset-sync-test.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id'] as const;
    // The awaited call itself must settle when the watchdog fires — main()
    // awaits the initial sync before installing the poll timer, so a
    // never-settling syncPendingFiles would wedge daemon startup forever
    // even with the lock released.
    await syncPendingFiles(...args);
    // The second sync must start fresh even though the first cycle never settled.
    await syncPendingFiles(...args);
    expect(fetchCalls).toBe(2);
  } finally {
    delete process.env.AGENTBOOTUP_SYNC_WATCHDOG_MS;
  }
});

test('a watchdog-aborted sync never writes sync state', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'watchdog-state-'));
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'sample');
  await fsp.mkdir(skillRoot, { recursive: true });
  await fsp.writeFile(path.join(skillRoot, 'SKILL.md'), '# sample\n');
  const stateFile = path.join(projectRoot, 'sync-state.json');
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = stateFile;
  process.env.AGENTBOOTUP_SYNC_WATCHDOG_MS = '80';

  globalThis.fetch = (async (_input: string | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })) as typeof fetch;

  try {
    await syncPendingFiles('asset-sync-test.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id');
    expect(fs.existsSync(stateFile)).toBe(false);
  } finally {
    delete process.env.AGENTBOOTUP_SYNC_WATCHDOG_MS;
  }
});

test('listDocuments attaches an abort signal so a dead server cannot hang it', async () => {
  let capturedSignal: AbortSignal | undefined | null = null;
  globalThis.fetch = (async (_input: string | Request, init?: RequestInit) => {
    capturedSignal = init?.signal;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  const client = buildMechStorageClient({ appId: 'app', apiKey: 'key', baseUrl: 'http://localhost:9999' });
  await client.listDocuments('skills');
  expect(capturedSignal).toBeInstanceOf(AbortSignal);
});

test('a concurrent caller awaiting an in-progress wedged sync also settles at the watchdog', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'watchdog-concurrent-'));
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'sample');
  await fsp.mkdir(skillRoot, { recursive: true });
  await fsp.writeFile(path.join(skillRoot, 'SKILL.md'), '# sample\n');
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = path.join(projectRoot, 'sync-state.json');
  process.env.AGENTBOOTUP_SYNC_WATCHDOG_MS = '80';

  // Wedged fetch that ignores the abort signal entirely.
  globalThis.fetch = (async () => new Promise(() => {})) as typeof fetch;

  try {
    const args = ['asset-sync-test.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id'] as const;
    const first = syncPendingFiles(...args);
    // Give the first cycle a beat to take the lock, then join it while wedged.
    await new Promise((r) => setTimeout(r, 10));
    const joined = syncPendingFiles(...args);
    // Both awaits must settle once the watchdog fires — a joiner handed the
    // raw cycle promise would hang forever.
    await Promise.all([first, joined]);
  } finally {
    delete process.env.AGENTBOOTUP_SYNC_WATCHDOG_MS;
  }
});

test('memory/protocol sources no longer discover .md files under pruned directories', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'memory-prune-'));
  await fsp.mkdir(path.join(projectRoot, 'memory', 'node_modules', 'dep'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'node_modules', 'dep', 'README.md'), 'x');
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'x');
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'asset-sync-test.gm',
    include: [{ path: 'memory/MEMORY.md', class: 'canonical' }],
  }));

  const sources = getBrainAssetSources(projectRoot).filter((s: any) => s.asset_type === 'memory');
  const assets = await discoverAllAssets(sources, { shouldSkip: () => false }, projectRoot);
  // Intentional behavior change (PR #322): match() for memory/protocol never
  // filtered skip-dirs, so a .md under memory/node_modules used to sync.
  // Walk-time pruning now excludes it for every source.
  expect(assets.map((a: any) => a.path)).toEqual([path.join(projectRoot, 'memory', 'MEMORY.md')]);
});

test('discoverAllAssets uses the exact selected memory set and accepts selected binary files', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'memory-selected-'));
  await fsp.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'x');
  await fsp.writeFile(path.join(projectRoot, 'memory', 'audio.m4a'), Buffer.from([0, 255, 1]));
  await fsp.writeFile(path.join(projectRoot, 'memory', 'unselected.md'), 'hidden');
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'asset-sync-test.gm',
    include: [
      { path: 'memory/MEMORY.md', class: 'canonical' },
      { path: 'memory/audio.m4a', class: 'attachment' },
    ],
  }));
  const sources = getBrainAssetSources(projectRoot).filter((source: any) => source.asset_type === 'memory');
  const assets = await discoverAllAssets(sources, { shouldSkip: () => false }, projectRoot);
  expect(assets.map((asset: any) => path.relative(projectRoot, asset.path))).toEqual([
    'memory/audio.m4a',
    'memory/MEMORY.md',
  ]);
});

test('discoverAllAssets excludes selected .gitkeep memory sentinels from transport', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'memory-gitkeep-'));
  await fsp.mkdir(path.join(projectRoot, 'memory', 'daily'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'durable state');
  await fsp.writeFile(path.join(projectRoot, 'memory', 'daily', '.gitkeep'), '');
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'asset-sync-test.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  const sources = getBrainAssetSources(projectRoot).filter((source: any) => source.asset_type === 'memory');
  const assets = await discoverAllAssets(sources, { shouldSkip: () => false }, projectRoot);
  expect(assets.map((asset: any) => path.relative(projectRoot, asset.path))).toEqual(['memory/MEMORY.md']);
});

test('memory converge startup budget defaults to 60 seconds and remains configurable', () => {
  delete process.env.AGENTBOOTUP_CONVERGE_STARTUP_MS;
  expect(getConvergeStartupMs()).toBe(60_000);
  process.env.AGENTBOOTUP_CONVERGE_STARTUP_MS = '1234';
  try {
    expect(getConvergeStartupMs()).toBe(1234);
  } finally {
    delete process.env.AGENTBOOTUP_CONVERGE_STARTUP_MS;
  }
});

test('discoverAllAssets fails closed only when an active memory source lacks policy', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'memory-policy-'));
  await fsp.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'x');
  await fsp.writeFile(path.join(projectRoot, 'CLAUDE.md'), '# config');
  const sources = getBrainAssetSources(projectRoot);
  await expect(discoverAllAssets(
    sources.filter((source: any) => source.asset_type === 'memory'),
    { shouldSkip: () => false },
    projectRoot,
  )).rejects.toThrow(/brain-backup\.json/i);
  const nonMemory = await discoverAllAssets(
    sources.filter((source: any) => source.asset_type === 'config'),
    { shouldSkip: () => false },
    projectRoot,
  );
  expect(nonMemory.map((asset: any) => path.relative(projectRoot, asset.path))).toEqual(['CLAUDE.md']);
});

test('discoverAllAssets includes portable backup policy files as config assets', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, 'memory-policy-config-'));
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'asset-sync-test.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  await fsp.writeFile(path.join(projectRoot, '.brainignore'), 'memory/private/**\n');
  const sources = getBrainAssetSources(projectRoot).filter((source: any) => source.asset_type === 'config');
  const assets = await discoverAllAssets(sources, { shouldSkip: () => false }, projectRoot);
  expect(assets.map((asset: any) => path.basename(asset.path))).toEqual(['.brainignore', 'brain-backup.json']);
});

// ---------------------------------------------------------------------------
// PRD-0054 Slice A: identity quarantine on the asset push path (FR A-1..A-3)
// ---------------------------------------------------------------------------

const { assetIdentityQuarantine } = await import('../../lib/daemon/brain-asset-sync.mjs');

async function makeQuarantineProject(name: string): Promise<string> {
  const projectRoot = await fsp.mkdtemp(path.join(tmpBase, name));
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'sample');
  await fsp.mkdir(skillRoot, { recursive: true });
  await fsp.writeFile(path.join(skillRoot, 'SKILL.md'), '# sample\n');
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = path.join(projectRoot, 'sync-state.json');
  return projectRoot;
}

test('a registry 404 on push quarantines the brain and skips cycles until cooldown', async () => {
  const brainId = 'quarantine-a.gm';
  const projectRoot = await makeQuarantineProject('quarantine-push-');
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
  }) as typeof fetch;

  const args = [brainId, 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id'] as const;
  try {
    await syncPendingFiles(...args);
    expect(assetIdentityQuarantine.isQuarantined(brainId)).toBe(true);
    const afterFirst = fetchCalls;
    // While quarantined, the next cycle must not touch the network at all.
    await syncPendingFiles(...args);
    expect(fetchCalls).toBe(afterFirst);
  } finally {
    assetIdentityQuarantine.clear(brainId);
  }
});

test('a successful push clears an expired quarantine and health reflects both states', async () => {
  const brainId = 'quarantine-b.gm';
  const projectRoot = await makeQuarantineProject('quarantine-clear-');
  // Expired-cooldown entry: cycle proceeds, success clears it.
  assetIdentityQuarantine.record(brainId, { status: 404, code: 'not_found', message: 'stale' }, Date.now() - 60 * 60_000);
  expect(assetIdentityQuarantine.isQuarantined(brainId)).toBe(false);

  // While an entry exists (even expired), health must surface it...
  const healthDuring = recordBrainSyncHealth(brainId, 0, 0, projectRoot);
  expect(healthDuring.quarantinedIdentity?.code).toBe('not_found');
  expect(readBrainSyncHealth(brainId)?.quarantinedIdentity?.code).toBe('not_found');

  mockResponses.push({ status: 200, body: { data: { results: [{ path: '.claude/skills/sample/SKILL.md', status: 'pushed' }] } } });
  await syncPendingFiles(brainId, 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id');

  expect(assetIdentityQuarantine.get(brainId)).toBeNull();
  const healthAfter = recordBrainSyncHealth(brainId, 1, 0, projectRoot);
  expect(healthAfter.quarantinedIdentity).toBeNull();
});

test('daemon exact-byte batches requests and advances state only for successful ordered leaves', async () => {
  const projectRoot = await makeQuarantineProject('byte-batch-');
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'sample');
  await fsp.writeFile(path.join(skillRoot, 'A.md'), '🧠'.repeat(30));
  await fsp.writeFile(path.join(skillRoot, 'B.md'), '🌍'.repeat(30));
  const stateFile = path.join(projectRoot, 'sync-state.json');
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = stateFile;
  process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = '560';
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const payload = JSON.parse(body);
    return new Response(JSON.stringify({ data: { results: payload.files.map((file: any) => ({ path: file.path, status: 'pushed' })) } }), { status: 200 });
  }) as typeof fetch;

  await syncPendingFiles('byte-batch.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id');

  expect(bodies.length).toBeGreaterThan(1);
  expect(bodies.every((body) => Buffer.byteLength(body, 'utf8') <= 560)).toBe(true);
  const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  expect(state[path.join(skillRoot, 'A.md')]).toBeTruthy();
  expect(state[path.join(skillRoot, 'B.md')]).toBeTruthy();
});

test('daemon isolates an oversized singleton, progresses siblings, and leaves it unsynchronized with non-green health', async () => {
  const projectRoot = await makeQuarantineProject('oversized-');
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'sample');
  const smallPath = path.join(skillRoot, 'a-small.md');
  const hugePath = path.join(skillRoot, 'z-huge.md');
  await fsp.writeFile(smallPath, 'ok');
  await fsp.writeFile(hugePath, 'x'.repeat(500));
  const stateFile = path.join(projectRoot, 'sync-state.json');
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = stateFile;
  process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = '360';
  const pushedPaths: string[] = [];
  globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    pushedPaths.push(...payload.files.map((file: any) => file.path));
    return new Response(JSON.stringify({ data: { results: payload.files.map((file: any) => ({ path: file.path, status: 'pushed' })) } }), { status: 200 });
  }) as typeof fetch;

  await syncPendingFiles('oversized.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id');

  expect(pushedPaths).toContain('.claude/skills/sample/a-small.md');
  expect(pushedPaths).not.toContain('.claude/skills/sample/z-huge.md');
  const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  expect(state[smallPath]).toBeTruthy();
  expect(state[hugePath]).toBeUndefined();
  expect(readBrainSyncHealth('oversized.gm')?.lastErrors).toBeGreaterThan(0);
});

test('daemon splits multi-file 413 and a single-file 413 never advances that file state', async () => {
  const projectRoot = await makeQuarantineProject('413-split-');
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'sample');
  const rejectedPath = path.join(skillRoot, 'B.md');
  await fsp.writeFile(path.join(skillRoot, 'A.md'), 'a');
  await fsp.writeFile(rejectedPath, 'b');
  const stateFile = path.join(projectRoot, 'sync-state.json');
  process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE = stateFile;
  const calls: string[][] = [];
  globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    const paths = payload.files.map((file: any) => file.path);
    calls.push(paths);
    const reject = paths.length > 1 || paths[0].endsWith('/B.md');
    return new Response(JSON.stringify({ data: { results: payload.files.map((file: any) => ({ path: file.path, status: 'pushed' })) } }), { status: reject ? 413 : 200 });
  }) as typeof fetch;

  await syncPendingFiles('split-413.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id');

  expect(calls.some((paths) => paths.length > 1)).toBe(true);
  expect(calls.some((paths) => paths.length === 1 && paths[0].endsWith('/A.md'))).toBe(true);
  expect(calls.some((paths) => paths.length === 1 && paths[0].endsWith('/B.md'))).toBe(true);
  const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  expect(state[path.join(skillRoot, 'A.md')]).toBeTruthy();
  expect(state[rejectedPath]).toBeUndefined();
});

test('a quarantined cycle persists quarantinedIdentity in health even with no successful cycle ever', async () => {
  const brainId = 'quarantine-c.gm';
  const projectRoot = await makeQuarantineProject('quarantine-health-');
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 })) as typeof fetch;

  try {
    await syncPendingFiles(brainId, 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id');
    // daemon status reads the persisted record — the quarantine must be there
    // without any completed sync cycle.
    expect(readBrainSyncHealth(brainId)?.quarantinedIdentity?.code).toBe('not_found');
  } finally {
    assetIdentityQuarantine.clear(brainId);
  }
});

// ---------------------------------------------------------------------------
// PRD-0054 Slice B: converge integration — 4b gate filtering + health field
// ---------------------------------------------------------------------------

test('closed memory-push gate excludes memory/** from a sync cycle; open gate includes it', async () => {
  const projectRoot = await makeQuarantineProject('gate-filter-');
  await fsp.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'mem\n');
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'gate-test.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));

  const pushedPaths: string[] = [];
  globalThis.fetch = (async (_i: string | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    for (const f of body.files ?? []) pushedPaths.push(f.path);
    return new Response(JSON.stringify({ data: { results: (body.files ?? []).map((f: any) => ({ path: f.path, status: 'pushed' })) } }), { status: 200 });
  }) as typeof fetch;

  const args = ['gate-test.gm', 'test-key', 'http://localhost:9999', projectRoot, getBrainAssetSources(projectRoot), { shouldSkip: () => false }, 'machine-id'] as const;
  try {
    _setMemoryPushGate(() => false);
    await syncPendingFiles(...args);
    expect(pushedPaths.some((p) => p.startsWith('memory/'))).toBe(false);
    expect(pushedPaths.some((p) => p.startsWith('.claude/'))).toBe(true); // non-memory still syncs

    _setMemoryPushGate(() => true);
    await syncPendingFiles(...args);
    expect(pushedPaths.some((p) => p.startsWith('memory/'))).toBe(true);
  } finally {
    _setMemoryPushGate(() => true);
  }
});

test('persisted OFF to ON config evaluation closes the real asset path before the read settles', async () => {
  const projectRoot = await makeQuarantineProject('config-enable-gate-filter-');
  await fsp.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'newly gated bytes\n');
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'config-enable.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;
  process.env.AGENTBOOTUP_MEMORY_STORE = `file://${await fsp.mkdtemp(path.join(tmpBase, 'config-enable-store-'))}`;

  let configReads = 0;
  let releaseConfig!: () => void;
  const configBlocked = new Promise<void>((resolve) => { releaseConfig = resolve; });
  const requests: any[][] = [];
  globalThis.fetch = (async (_i: string | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    requests.push(body.files ?? []);
    return new Response(JSON.stringify({
      data: { results: (body.files ?? []).map((file: any) => ({ path: file.path, status: 'pushed' })) },
    }), { status: 200 });
  }) as typeof fetch;

  const { createConvergeRunner } = await import('../../lib/daemon/memory-converge.mjs');
  const runner = createConvergeRunner({
    projectRoot,
    brainId: 'config-enable.gm',
    log: () => {},
    logError: () => {},
    readConfigFn: async () => {
      configReads += 1;
      if (configReads === 1) return { memoryConvergeEnabled: false };
      await configBlocked;
      return { memoryConvergeEnabled: true };
    },
    assessFreshnessFn: async () => ({ state: 'ok', freshHeads: [] }),
    runMemoryCommandFn: async () => 0,
  });

  try {
    expect(await runner.runCycle()).toMatchObject({ state: 'disabled', gateOpen: true });
    _setMemoryPushGate(() => runner.isMemoryPushGateOpen());
    const enablingCycle = runner.runCycle();
    expect(configReads).toBe(2);
    expect(runner.isMemoryPushGateOpen()).toBe(false);
    expect(await runner.runCycle()).toMatchObject({ gateOpen: false });
    expect(configReads).toBe(2); // the pending evaluation has one owner

    await syncPendingFiles(
      'config-enable.gm',
      'test-key',
      'http://localhost:9999',
      projectRoot,
      getBrainAssetSources(projectRoot),
      { shouldSkip: () => false },
      'machine-id',
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.flat().some((file: any) => file.path === 'memory/MEMORY.md')).toBe(false);
    expect(requests.flat().some((file: any) => !file.path.startsWith('memory/'))).toBe(true);

    releaseConfig();
    expect(await enablingCycle).toMatchObject({ state: 'ok', gateOpen: true });
  } finally {
    releaseConfig?.();
    _setMemoryPushGate(() => true);
    delete process.env.AGENTBOOTUP_MEMORY_STORE;
  }
});

test('a timed-out stale config result cannot reopen memory during a newer enabled refresh', async () => {
  const projectRoot = await makeQuarantineProject('stale-config-gate-filter-');
  await fsp.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'stale config must not leak this\n');
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'stale-config.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;
  process.env.AGENTBOOTUP_MEMORY_STORE = `file://${await fsp.mkdtemp(path.join(tmpBase, 'stale-config-store-'))}`;

  let configReads = 0;
  let releaseStaleConfig!: () => void;
  const staleConfigBlocked = new Promise<void>((resolve) => { releaseStaleConfig = resolve; });
  let refreshStarted = false;
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const requests: any[][] = [];
  globalThis.fetch = (async (_i: string | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    requests.push(body.files ?? []);
    return new Response(JSON.stringify({
      data: { results: (body.files ?? []).map((file: any) => ({ path: file.path, status: 'pushed' })) },
    }), { status: 200 });
  }) as typeof fetch;

  const { createConvergeRunner } = await import('../../lib/daemon/memory-converge.mjs');
  const runner = createConvergeRunner({
    projectRoot,
    brainId: 'stale-config.gm',
    log: () => {},
    logError: () => {},
    readConfigFn: async () => {
      configReads += 1;
      if (configReads === 1) return { memoryConvergeEnabled: false };
      if (configReads === 2) {
        await staleConfigBlocked;
        return { memoryConvergeEnabled: false };
      }
      return { memoryConvergeEnabled: true };
    },
    assessFreshnessFn: async () => ({ state: 'ok', freshHeads: [] }),
    runMemoryCommandFn: async (argv: string[]) => {
      if (argv[0] === 'refresh') {
        refreshStarted = true;
        await refreshBlocked;
      }
      return 0;
    },
  });

  try {
    expect(await runner.runCycle()).toMatchObject({ state: 'disabled', gateOpen: true });
    expect(await runner.runStartupCycle(5)).toMatchObject({ state: 'store_deferred', gateOpen: false });

    _setMemoryPushGate(() => runner.isMemoryPushGateOpen());
    const enabledCycle = runner.runCycle();
    for (let i = 0; i < 100 && !refreshStarted; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(refreshStarted).toBe(true);
    expect(configReads).toBe(3);

    releaseStaleConfig();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(runner.isMemoryPushGateOpen()).toBe(false);

    await syncPendingFiles(
      'stale-config.gm',
      'test-key',
      'http://localhost:9999',
      projectRoot,
      getBrainAssetSources(projectRoot),
      { shouldSkip: () => false },
      'machine-id',
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.flat().some((file: any) => file.path === 'memory/MEMORY.md')).toBe(false);
    expect(requests.flat().some((file: any) => !file.path.startsWith('memory/'))).toBe(true);

    releaseRefresh();
    expect(await enabledCycle).toMatchObject({ state: 'ok', gateOpen: true });
  } finally {
    releaseStaleConfig?.();
    releaseRefresh?.();
    _setMemoryPushGate(() => true);
    delete process.env.AGENTBOOTUP_MEMORY_STORE;
  }
});

test('stale converge result sends no raw memory asset in the following request', async () => {
  const projectRoot = await makeQuarantineProject('stale-gate-filter-');
  await fsp.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'stale bytes must not leave\n');
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED = '1';
  process.env.AGENTBOOTUP_MEMORY_STORE = `file://${await fsp.mkdtemp(path.join(tmpBase, 'stale-store-'))}`;

  const requests: any[][] = [];
  globalThis.fetch = (async (_i: string | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    requests.push(body.files ?? []);
    return new Response(JSON.stringify({
      data: { results: (body.files ?? []).map((file: any) => ({ path: file.path, status: 'pushed' })) },
    }), { status: 200 });
  }) as typeof fetch;

  const { createConvergeRunner } = await import('../../lib/daemon/memory-converge.mjs');
  const runner = createConvergeRunner({
    projectRoot,
    brainId: 'stale-raw.gm',
    log: () => {},
    logError: () => {},
    assessFreshnessFn: async () => ({
      state: 'stale',
      localDirtyAgeMs: 72 * 60 * 60_000,
      freshHeads: [{ publisherId: 'fresh-machine', ageMs: 60_000 }],
    }),
    runMemoryCommandFn: async () => 0,
  });

  try {
    expect(await runner.runCycle()).toMatchObject({ state: 'stale', gateOpen: false });
    _setMemoryPushGate(() => runner.isMemoryPushGateOpen());
    await syncPendingFiles(
      'stale-raw.gm',
      'test-key',
      'http://localhost:9999',
      projectRoot,
      getBrainAssetSources(projectRoot),
      { shouldSkip: () => false },
      'machine-id',
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.flat().some((file: any) => file.path === 'memory/MEMORY.md')).toBe(false);
  } finally {
    _setMemoryPushGate(() => true);
    delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
    delete process.env.AGENTBOOTUP_MEMORY_STORE;
  }
});

test('publish conflict closes the runner gate so raw memory is excluded while non-memory assets continue', async () => {
  const projectRoot = await makeQuarantineProject('conflict-gate-filter-');
  await fsp.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'divergent bytes must not leave\n');
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'conflict-raw.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  const storeRoot = await fsp.mkdtemp(path.join(tmpBase, 'conflict-store-'));
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED = '1';
  process.env.AGENTBOOTUP_MEMORY_STORE = `file://${storeRoot}`;

  const requests: any[][] = [];
  globalThis.fetch = (async (_i: string | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    requests.push(body.files ?? []);
    return new Response(JSON.stringify({
      data: { results: (body.files ?? []).map((file: any) => ({ path: file.path, status: 'pushed' })) },
    }), { status: 200 });
  }) as typeof fetch;

  const { createConvergeRunner } = await import('../../lib/daemon/memory-converge.mjs');
  const runner = createConvergeRunner({
    projectRoot,
    brainId: 'conflict-raw.gm',
    log: () => {},
    logError: () => {},
    assessFreshnessFn: async () => ({ state: 'ok', freshHeads: [] }),
    runMemoryCommandFn: async (argv: string[]) => argv[0] === 'publish' ? 3 : 0,
  });

  try {
    expect(await runner.runCycle()).toMatchObject({ state: 'blocked_conflict', gateOpen: false });
    _setMemoryPushGate(() => runner.isMemoryPushGateOpen());
    await syncPendingFiles(
      'conflict-raw.gm',
      'test-key',
      'http://localhost:9999',
      projectRoot,
      getBrainAssetSources(projectRoot),
      { shouldSkip: () => false },
      'machine-id',
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.flat().some((file: any) => file.path === 'memory/MEMORY.md')).toBe(false);
    expect(requests.flat().some((file: any) => !file.path.startsWith('memory/'))).toBe(true);
  } finally {
    _setMemoryPushGate(() => true);
    delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
    delete process.env.AGENTBOOTUP_MEMORY_STORE;
  }
});

test('pending snapshot publish keeps raw memory excluded while non-memory assets continue', async () => {
  const projectRoot = await makeQuarantineProject('pending-publish-gate-filter-');
  await fsp.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'memory', 'MEMORY.md'), 'pending bytes must not leave\n');
  await fsp.writeFile(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'pending-raw.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED = '1';
  process.env.AGENTBOOTUP_MEMORY_STORE = `file://${await fsp.mkdtemp(path.join(tmpBase, 'pending-store-'))}`;

  let publishStarted = false;
  let releasePublish!: () => void;
  const publishBlocked = new Promise<void>((resolve) => { releasePublish = resolve; });
  const requests: any[][] = [];
  globalThis.fetch = (async (_i: string | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    requests.push(body.files ?? []);
    return new Response(JSON.stringify({
      data: { results: (body.files ?? []).map((file: any) => ({ path: file.path, status: 'pushed' })) },
    }), { status: 200 });
  }) as typeof fetch;

  const { createConvergeRunner } = await import('../../lib/daemon/memory-converge.mjs');
  const runner = createConvergeRunner({
    projectRoot,
    brainId: 'pending-raw.gm',
    log: () => {},
    logError: () => {},
    assessFreshnessFn: async () => ({ state: 'ok', freshHeads: [] }),
    runMemoryCommandFn: async (argv: string[]) => {
      if (argv[0] === 'publish') {
        publishStarted = true;
        await publishBlocked;
      }
      return 0;
    },
  });

  try {
    _setMemoryPushGate(() => runner.isMemoryPushGateOpen());
    const converge = runner.runCycle();
    for (let i = 0; i < 100 && !publishStarted; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(publishStarted).toBe(true);
    expect(runner.isMemoryPushGateOpen()).toBe(false);

    await syncPendingFiles(
      'pending-raw.gm',
      'test-key',
      'http://localhost:9999',
      projectRoot,
      getBrainAssetSources(projectRoot),
      { shouldSkip: () => false },
      'machine-id',
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.flat().some((file: any) => file.path === 'memory/MEMORY.md')).toBe(false);
    expect(requests.flat().some((file: any) => !file.path.startsWith('memory/'))).toBe(true);

    releasePublish();
    expect(await converge).toMatchObject({ state: 'ok', gateOpen: true });
  } finally {
    releasePublish?.();
    _setMemoryPushGate(() => true);
    delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
    delete process.env.AGENTBOOTUP_MEMORY_STORE;
  }
});

test('health record carries the converge health snapshot', () => {
  const projectRoot = path.join(tmpBase, 'converge-health-x');
  fs.mkdirSync(projectRoot, { recursive: true });
  try {
    _setConvergeHealthProvider(() => ({
      state: 'blocked_conflict',
      detail: 'raw=SENTINEL_PROVIDER_DETAIL',
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'publish',
        category: 'conflict',
        exit_code: 3,
      },
      enabled: true,
      configSource: 'default',
      store: 'server://converge-health.gm',
      gateOpen: true,
      lastCycleAt: '2026-07-24T00:00:00.000Z',
      blockedSince: '2026-07-23T23:45:00.000Z',
      escalated: false,
    }));
    const health = recordBrainSyncHealth('converge-health.gm', 0, 0, projectRoot);
    expect(health.memoryConverge?.state).toBe('blocked_conflict');
    expect(readBrainSyncHealth('converge-health.gm')?.memoryConverge?.state).toBe('blocked_conflict');
    expect(readBrainSyncHealth('converge-health.gm')?.memoryConverge).toMatchObject({
      enabled: true,
      configSource: 'default',
      store: 'server://converge-health.gm',
      gateOpen: true,
      blockedSince: '2026-07-23T23:45:00.000Z',
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'publish',
        category: 'conflict',
        exit_code: 3,
      },
    });
    expect(JSON.stringify(health)).not.toContain('SENTINEL_PROVIDER_DETAIL');
    expect(readBrainSyncHealth('converge-health.gm')?.memoryConverge?.lastCycleAt).toBe('2026-07-24T00:00:00.000Z');
    expect(readBrainSyncHealth('converge-health.gm')?.memoryConverge?.blockedSince).toBe('2026-07-23T23:45:00.000Z');
  } finally {
    _setConvergeHealthProvider(() => null);
  }
});

test('successful converge detail is state-bound across persistence and health routes', async () => {
  const brainId = 'safe-converge-detail.gm';
  const projectRoot = path.join(tmpBase, 'safe-converge-detail');
  fs.mkdirSync(projectRoot, { recursive: true });
  let detailReads = 0;
  const providerHealth = {
    state: 'ok', failure: null, enabled: true,
    configSource: 'default', store: `server://${brainId}`, gateOpen: true,
    lastCycleAt: '2026-08-12T00:00:00.000Z', freshnessState: 'ok',
    freshnessCheckedAt: '2026-08-12T00:00:00.000Z', freshnessHeadCount: 0, escalated: false,
  };
  Object.defineProperty(providerHealth, 'detail', {
    enumerable: true,
    get() { detailReads += 1; return 'SENTINEL_PROVIDER_DETAIL'; },
  });
  _setConvergeHealthProvider(() => providerHealth);
  const server = startHealthServer(brainId, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const recorded = recordBrainSyncHealth(brainId, 1, 0, projectRoot);
    const readback = readBrainSyncHealth(brainId);
    const health = await getHealthResponse(server, '/health');
    const status = await getHealthResponse(server, '/status');
    expect(recorded.memoryConverge?.detail).toBeNull();
    expect(readback?.memoryConverge?.detail).toBeNull();
    expect(health.body.syncHealth.memoryConverge.detail).toBeNull();
    expect(status.body.syncHealth.memoryConverge.detail).toBeNull();
    expect(JSON.stringify([recorded, readback, health.body, status.body])).not.toContain('SENTINEL');
    expect(detailReads).toBe(0);
  } finally {
    _setConvergeHealthProvider(() => null);
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('converge health boundary never invokes field accessors and closes descriptor traps', () => {
  const projectRoot = path.join(tmpBase, 'hostile-converge-fields');
  fs.mkdirSync(projectRoot, { recursive: true });
  const accessorReads: Record<string, number> = {};
  const accessors: Record<string, unknown> = {};
  const fieldKeys = ['state', 'detail', 'failure', 'enabled', 'configSource', 'store', 'gateOpen',
    'lastCycleAt', 'freshnessState', 'freshnessCheckedAt', 'freshnessHeadCount', 'blockedSince', 'escalated'];
  for (const key of fieldKeys) {
    Object.defineProperty(accessors, key, {
      enumerable: true,
      get() {
        accessorReads[key] = (accessorReads[key] ?? 0) + 1;
        return `SENTINEL_${key}`;
      },
    });
  }
  const descriptorReads: Record<string, number> = {};
  const descriptorTarget = {
    state: 'ok', detail: 'matches fleet', failure: null, enabled: true, configSource: 'default',
    store: 'server://descriptor.gm', gateOpen: true, lastCycleAt: '2026-08-12T00:00:00.000Z',
    freshnessState: 'ok', freshnessCheckedAt: '2026-08-12T00:00:00.000Z',
    freshnessHeadCount: 0, blockedSince: null, escalated: false,
  };
  const countedDescriptors = new Proxy(descriptorTarget, {
    getOwnPropertyDescriptor(target, key) {
      descriptorReads[String(key)] = (descriptorReads[String(key)] ?? 0) + 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get() { throw new Error('SENTINEL_PROXY_GET'); },
  });
  const trapping = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('SENTINEL_DESCRIPTOR_TRAP'); },
    get() { throw new Error('SENTINEL_PROXY_GET'); },
  });

  try {
    _setConvergeHealthProvider(() => accessors);
    const accessorHealth = recordBrainSyncHealth('accessor-converge.gm', 0, 0, projectRoot);
    expect(accessorReads).toEqual({});
    expect(accessorHealth.memoryConverge).toEqual({
      state: 'unknown', detail: null, failure: null, enabled: null, configSource: null,
      store: null, gateOpen: null, lastCycleAt: null, freshnessState: 'unknown',
      freshnessCheckedAt: null, freshnessHeadCount: null, blockedSince: null, escalated: false,
    });
    expect(JSON.stringify(accessorHealth)).not.toContain('SENTINEL');

    _setConvergeHealthProvider(() => countedDescriptors);
    const countedHealth = recordBrainSyncHealth('counted-converge.gm', 0, 0, projectRoot);
    expect(countedHealth.memoryConverge?.detail).toBe('matches fleet');
    expect(descriptorReads).toEqual(Object.fromEntries(fieldKeys.map((key) => [key, 1])));

    _setConvergeHealthProvider(() => trapping);
    let trappingHealth: ReturnType<typeof recordBrainSyncHealth> | null = null;
    expect(() => { trappingHealth = recordBrainSyncHealth('trapping-converge.gm', 0, 0, projectRoot); }).not.toThrow();
    expect(trappingHealth?.memoryConverge).toBeNull();
    expect(JSON.stringify(trappingHealth)).not.toContain('SENTINEL');
  } finally {
    _setConvergeHealthProvider(() => null);
  }
});

test('legitimate successful, disabled, and stale converge details survive bounded round trips', () => {
  const projectRoot = path.join(tmpBase, 'valid-converge-details');
  fs.mkdirSync(projectRoot, { recursive: true });
  const fixtures = [
    { state: 'ok', detail: 'matches fleet', enabled: true, configSource: 'default', gateOpen: true },
    { state: 'never_synced', detail: 'empty local tree, nothing published', enabled: true, configSource: 'default', gateOpen: true },
    { state: 'disabled', detail: 'SENTINEL_IGNORED_DISABLED_INPUT', enabled: false, configSource: 'persisted', gateOpen: true,
      expected: 'effective=false source=persisted' },
    { state: 'stale', detail: 'stale publication suppressed: local_dirty_age_ms=123.456 freshest_remote_head_age_ms=42 stale_publisher_heads=abc-123,def_456',
      enabled: true, configSource: 'default', gateOpen: false },
  ];
  try {
    for (let index = 0; index < fixtures.length; index += 1) {
      const fixture = fixtures[index];
      _setConvergeHealthProvider(() => ({
        ...fixture, failure: null, store: 'server://valid-details.gm',
        lastCycleAt: '2026-08-12T00:00:00.000Z', freshnessState: 'ok',
        freshnessCheckedAt: '2026-08-12T00:00:00.000Z', freshnessHeadCount: 0, escalated: false,
      }));
      const brainId = `valid-converge-detail-${index}.gm`;
      const expected = fixture.expected ?? fixture.detail;
      expect(recordBrainSyncHealth(brainId, 1, 0, projectRoot).memoryConverge?.detail).toBe(expected);
      expect(readBrainSyncHealth(brainId)?.memoryConverge?.detail).toBe(expected);
    }
  } finally {
    _setConvergeHealthProvider(() => null);
  }
});

test('stale converge detail rejects hostile and unbounded near misses', () => {
  const projectRoot = path.join(tmpBase, 'invalid-stale-details');
  fs.mkdirSync(projectRoot, { recursive: true });
  const details = [
    'stale publication suppressed: local_dirty_age_ms=-1 freshest_remote_head_age_ms=42 stale_publisher_heads=abc',
    'stale publication suppressed: local_dirty_age_ms=1 freshest_remote_head_age_ms=42 stale_publisher_heads=abc/SENTINEL',
    `stale publication suppressed: local_dirty_age_ms=1 freshest_remote_head_age_ms=42 stale_publisher_heads=${'a'.repeat(1_025)}`,
  ];
  try {
    for (let index = 0; index < details.length; index += 1) {
      _setConvergeHealthProvider(() => ({
        state: 'stale', detail: details[index], failure: null, enabled: true, configSource: 'default',
        store: 'server://invalid-stale.gm', gateOpen: false, lastCycleAt: '2026-08-12T00:00:00.000Z',
        freshnessState: 'stale', freshnessCheckedAt: '2026-08-12T00:00:00.000Z', freshnessHeadCount: 1, escalated: false,
      }));
      const health = recordBrainSyncHealth(`invalid-stale-${index}.gm`, 0, 0, projectRoot);
      expect(health.memoryConverge?.detail).toBeNull();
      expect(readBrainSyncHealth(`invalid-stale-${index}.gm`)?.memoryConverge?.detail).toBeNull();
      expect(JSON.stringify(health)).not.toContain('SENTINEL');
    }
  } finally {
    _setConvergeHealthProvider(() => null);
  }
});

test('blockedSince accepts only an own canonical timestamp without invoking accessors', () => {
  const projectRoot = path.join(tmpBase, 'blocked-since-sanitization');
  fs.mkdirSync(projectRoot, { recursive: true });
  const inherited = Object.create({ blockedSince: '2026-07-23T23:45:00.000Z' });
  Object.assign(inherited, {
    state: 'ok', detail: null, failure: null, enabled: true, configSource: 'default',
    store: 'server://blocked-since.gm', gateOpen: true, lastCycleAt: null, escalated: false,
  });
  let getterReads = 0;
  const accessor = { ...inherited };
  Object.defineProperty(accessor, 'blockedSince', {
    enumerable: true,
    get: () => {
      getterReads += 1;
      return 'SENTINEL_BLOCKED_SINCE_GETTER';
    },
  });

  const fixtures = [
    inherited,
    accessor,
    { ...inherited, blockedSince: '2026-07-23' },
    { ...inherited, blockedSince: 'not-a-timestamp-SENTINEL' },
    { ...inherited, blockedSince: '9'.repeat(10_000) },
  ];
  try {
    for (let index = 0; index < fixtures.length; index += 1) {
      _setConvergeHealthProvider(() => fixtures[index]);
      const health = recordBrainSyncHealth(`blocked-since-${index}.gm`, 0, 0, projectRoot);
      expect(health.memoryConverge?.blockedSince).toBeNull();
      expect(readBrainSyncHealth(`blocked-since-${index}.gm`)?.memoryConverge?.blockedSince).toBeNull();
      expect(JSON.stringify(health)).not.toContain('SENTINEL');
    }
    expect(getterReads).toBe(0);
  } finally {
    _setConvergeHealthProvider(() => null);
  }
});

test('persisted malformed failure falls back canonically and discards arbitrary legacy detail', () => {
  const brainId = 'malformed-converge-health.gm';
  const healthPath = getBrainSyncHealthPath(brainId);
  fs.mkdirSync(path.dirname(healthPath), { recursive: true });
  fs.writeFileSync(healthPath, JSON.stringify({
    brainId,
    pid: process.pid,
    memoryConverge: {
      state: 'publish_blocked',
      detail: 'token=SENTINEL_PERSISTED_DETAIL /absolute/SENTINEL_ROOT',
      enabled: true,
      configSource: 'default',
      store: 'server://malformed-converge-health.gm',
      gateOpen: false,
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'publish',
        category: 'authorization',
        exit_code: 1,
        stderr: 'SENTINEL_HOSTILE_FIELD',
      },
    },
  }));

  const health = readBrainSyncHealth(brainId);
  expect(health?.memoryConverge).toMatchObject({
    state: 'publish_blocked',
    gateOpen: false,
    failure: {
      schema: 'memory-convergence-failure/v1',
      phase: 'cycle',
      category: 'unknown',
      exit_code: null,
    },
  });
  expect(health?.memoryConverge?.detail).toBe(
    'cycle unknown failure; inspect sanitized daemon health and retry',
  );
  expect(JSON.stringify(health)).not.toContain('SENTINEL');
});

test('persisted oversized conflict fails closed without retaining its hostile path', () => {
  const brainId = 'oversized-conflict-health.gm';
  const healthPath = getBrainSyncHealthPath(brainId);
  const hostilePath = `memory/${'x'.repeat(1024 * 1024)}`;
  fs.mkdirSync(path.dirname(healthPath), { recursive: true });
  fs.writeFileSync(healthPath, JSON.stringify({
    brainId,
    pid: process.pid,
    memoryConverge: {
      state: 'blocked_conflict',
      detail: 'SENTINEL_OVERSIZED_PERSISTED_DETAIL',
      enabled: true,
      configSource: 'default',
      store: `server://${brainId}`,
      gateOpen: false,
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'publish',
        category: 'conflict',
        exit_code: 3,
        conflict: {
          schema: 'memory-conflict/v1',
          conflicts: [{ path: hostilePath, reason_code: 'store_changed_since_baseline' }],
          omitted_count: 0,
        },
      },
    },
  }));

  const health = readBrainSyncHealth(brainId);
  expect(health?.memoryConverge).toMatchObject({
    state: 'blocked_conflict',
    gateOpen: false,
    failure: {
      schema: 'memory-convergence-failure/v1',
      phase: 'cycle',
      category: 'unknown',
      exit_code: null,
    },
  });
  expect(health?.memoryConverge?.detail).toBe(
    'cycle unknown failure; inspect sanitized daemon health and retry',
  );
  expect(JSON.stringify(health)).not.toContain('SENTINEL');
  expect(JSON.stringify(health)).not.toContain(hostilePath);
});

test('persisted illegal child exits and hostile phases fall back without preserving category', () => {
  const fixtures = [
    {
      brainId: 'child-null-converge-health.gm',
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'publish',
        category: 'authorization',
        exit_code: null,
      },
    },
    {
      brainId: 'hostile-phase-converge-health.gm',
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'bogus',
        category: 'authorization',
        exit_code: 7,
      },
    },
  ];

  for (const { brainId, failure } of fixtures) {
    const healthPath = getBrainSyncHealthPath(brainId);
    fs.mkdirSync(path.dirname(healthPath), { recursive: true });
    fs.writeFileSync(healthPath, JSON.stringify({
      brainId,
      pid: process.pid,
      memoryConverge: {
        state: 'publish_blocked',
        detail: 'token=SENTINEL_ILLEGAL_PERSISTED_DETAIL',
        enabled: true,
        configSource: 'default',
        store: `server://${brainId}`,
        gateOpen: false,
        failure,
      },
    }));

    const health = readBrainSyncHealth(brainId);
    expect(health?.memoryConverge).toMatchObject({
      state: 'publish_blocked',
      gateOpen: false,
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'cycle',
        category: 'unknown',
        exit_code: null,
      },
    });
    expect(health?.memoryConverge?.detail).toBe(
      'cycle unknown failure; inspect sanitized daemon health and retry',
    );
    expect(JSON.stringify(health)).not.toContain('SENTINEL');
  }
});

test('persisted daemon lock observation preserves the prior safe state and gate', () => {
  const projectRoot = path.join(tmpBase, 'converge-lock-health');
  fs.mkdirSync(projectRoot, { recursive: true });
  _setConvergeHealthProvider(() => ({
    state: 'ok',
    detail: 'raw=SENTINEL_LOCK_DETAIL',
    failure: {
      schema: 'memory-convergence-failure/v1',
      phase: 'cycle',
      category: 'lock_held',
      exit_code: null,
    },
    enabled: true,
    configSource: 'default',
    store: 'server://converge-lock-health.gm',
    gateOpen: true,
  }));

  const health = recordBrainSyncHealth('converge-lock-health.gm', 0, 0, projectRoot);
  expect(health.memoryConverge).toMatchObject({
    state: 'ok',
    gateOpen: true,
    detail: 'another memory sync operator owns the convergence lock; retry shortly',
    failure: { phase: 'cycle', category: 'lock_held', exit_code: null },
  });
  expect(readBrainSyncHealth('converge-lock-health.gm')?.memoryConverge).toMatchObject({
    state: 'ok',
    gateOpen: true,
    failure: { phase: 'cycle', category: 'lock_held', exit_code: null },
  });
  expect(JSON.stringify(health)).not.toContain('SENTINEL_LOCK_DETAIL');
});
