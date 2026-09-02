/**
 * Hermetic two-checkout proof for the daemon converge legs (PRD-0054 Slice B).
 * Real store (temp file://), real protocol via runMemoryCommand — no mocks.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { createConvergeRunner, isConvergeEnabled, getConvergeIntervalMs, summarizeMemoryFailure } = await import('../../lib/daemon/memory-converge.mjs');
const { runMemoryCommand } = await import('../../lib/memory/cli.js');
const { enqueueReplayItem } = await import('../../lib/memory/replay-queue.js');
const { MemorySyncLockHeldError } = await import('../../lib/memory/sync-lock.js');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-converge-'));
const noop = () => {};
const io = { stdout: noop, stderr: noop };

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return true;
}

let storeRoot: string;
let A: string;
let B: string;

function makeCheckout(name: string): string {
  const dir = fs.mkdtempSync(path.join(tmpBase, name));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'converge-test.gm' }));
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'converge-test.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  return dir;
}

function runner(root: string, extra: Record<string, unknown> = {}) {
  return createConvergeRunner({ projectRoot: root, brainId: 'converge-test.gm', log: noop, logError: noop, ...extra });
}

let previousMachineIdFile: string | undefined;

test('daemon failure summaries retain classification but never raw CLI text', () => {
  expect(summarizeMemoryFailure(['memory publish conflict at memory/private.md: token=secret'])).toBe('conflict');
  expect(summarizeMemoryFailure(['remote request ETIMEDOUT after 30 seconds'])).toBe('timeout');
  expect(summarizeMemoryFailure(['HTTP 403 authorization denied over network'])).toBe('authorization');
  expect(summarizeMemoryFailure(['machine id unavailable; local precondition failed'])).toBe('local_precondition');
  expect(summarizeMemoryFailure(['unstructured remote detail: secret=not-for-status'])).toBeNull();
});

test('canonical failure capture prefers one structured hint and isolates each child command', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'cannot publish yet\n');
  const authoritative = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: {
      stderr: (line: string) => void;
      failure?: (hint: object) => void;
    }) => {
      if (argv[0] === 'publish') {
        commandIo.failure?.({ category: 'authorization' });
        commandIo.stderr('network unreachable token=SENTINEL_AUTH');
        return 7;
      }
      return 0;
    },
  });
  const authoritativeHealth = await authoritative.runCycle();
  expect(authoritativeHealth).toMatchObject({
    state: 'publish_blocked',
    gateOpen: false,
    failure: {
      schema: 'memory-convergence-failure/v1',
      phase: 'publish',
      category: 'authorization',
      exit_code: 7,
    },
  });
  expect(JSON.stringify(authoritativeHealth)).not.toContain('SENTINEL_AUTH');

  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'queued replay\n');
  enqueueReplayItem({
    projectRoot: B,
    store: { scheme: 'file', root: storeRoot },
    snapshotId: 'failure-capture-isolation',
  });
  const isolated = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: {
      stderr: (line: string) => void;
      failure?: (hint: object) => void;
    }) => {
      if (argv[0] === 'replay') commandIo.failure?.({ category: 'authorization' });
      if (argv[0] === 'refresh') {
        commandIo.stderr('ETIMEDOUT token=SENTINEL_REFRESH_ONLY');
        return 1;
      }
      return 0;
    },
  });
  const isolatedHealth = await isolated.runCycle();
  expect(isolatedHealth.failure).toEqual({
    schema: 'memory-convergence-failure/v1',
    phase: 'refresh',
    category: 'timeout',
    exit_code: 1,
  });
  expect(JSON.stringify(isolatedHealth)).not.toContain('SENTINEL_REFRESH_ONLY');
});

test('a duplicate or malformed structured hint falls back instead of using last-writer precedence', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'cannot publish yet\n');
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: {
      stderr: (line: string) => void;
      failure?: (hint: object) => void;
    }) => {
      if (argv[0] === 'publish') {
        commandIo.failure?.({ category: 'authorization' });
        commandIo.failure?.({ category: 'local_precondition' });
        commandIo.stderr('ETIMEDOUT raw=SENTINEL_DUPLICATE');
        return 1;
      }
      return 0;
    },
  });
  const health = await r.runCycle();
  expect(health.failure).toEqual({
    schema: 'memory-convergence-failure/v1',
    phase: 'publish',
    category: 'timeout',
    exit_code: 1,
  });
  expect(JSON.stringify(health)).not.toContain('SENTINEL_DUPLICATE');
});

test('structured callbacks synchronously own hints before caller mutation', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'cannot publish yet\n');
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: {
      failure?: (hint: object) => void;
      conflict?: (record: object) => void;
    }) => {
      if (argv[0] !== 'publish') return 0;

      const hint: { category: string; conflict?: object } = { category: 'authorization' };
      commandIo.failure?.(hint);
      hint.category = 'conflict';
      hint.conflict = {
        schema: 'memory-conflict/v1',
        conflicts: [{ path: 'memory/SENTINEL_HINT.md', reason_code: 'store_changed_since_baseline' }],
        omitted_count: 0,
      };
      return 7;
    },
  });

  expect(await r.runCycle()).toMatchObject({
    state: 'publish_blocked',
    failure: { phase: 'publish', category: 'authorization', exit_code: 7 },
  });

  const compatibility = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { conflict?: (record: object) => void }) => {
      if (argv[0] !== 'publish') return 0;
      const item = { path: 'memory/original.md', reason_code: 'store_changed_since_baseline' };
      const record = {
        schema: 'memory-conflict/v1',
        conflicts: [item],
        omitted_count: 0,
      };
      commandIo.conflict?.(record);
      item.path = 'memory/SENTINEL_MUTATED.md';
      item.reason_code = 'SENTINEL_REASON';
      record.conflicts.length = 0;
      record.omitted_count = 99;
      return 3;
    },
  });

  const health = await compatibility.runCycle();
  expect(health.failure).toMatchObject({
    phase: 'publish',
    category: 'conflict',
    conflict: {
      conflicts: [{ path: 'memory/original.md', reason_code: 'store_changed_since_baseline' }],
      omitted_count: 0,
    },
  });
  expect(JSON.stringify(health)).not.toContain('SENTINEL');

  const successful = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { failure?: (hint: object) => void }) => {
      if (argv[0] === 'publish') commandIo.failure?.({ category: 'authorization' });
      return 0;
    },
  });
  expect(await successful.runCycle()).toMatchObject({ state: 'ok', failure: null });
});

test('daemon health JSON remains canonical while global serialization prototypes are poisoned', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'cannot publish yet\n');
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { failure?: (hint: object) => void }) => {
      if (argv[0] === 'publish') {
        commandIo.failure?.({ category: 'authorization' });
        return 7;
      }
      return 0;
    },
  });
  const objectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let serialized = '';
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => ({ leaked: 'SENTINEL_OBJECT_TO_JSON' }),
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => ['SENTINEL_ARRAY_TO_JSON'],
    });
    serialized = JSON.stringify(await r.runCycle());
  } finally {
    if (objectToJSON) Object.defineProperty(Object.prototype, 'toJSON', objectToJSON);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    if (arrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', arrayToJSON);
    else delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
  }

  expect(JSON.parse(serialized)).toMatchObject({
    state: 'publish_blocked',
    failure: {
      schema: 'memory-convergence-failure/v1',
      phase: 'publish',
      category: 'authorization',
      exit_code: 7,
    },
  });
  expect(serialized).not.toContain('SENTINEL');
});

test('failure lifecycle clears on recovery and replaces lock evidence without changing prior state or gate', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'cannot publish yet\n');
  let failPublish = true;
  let lockHeld = false;
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { failure?: (hint: object) => void }) => {
      if (argv[0] === 'publish' && failPublish) {
        commandIo.failure?.({ category: 'local_precondition' });
        return 1;
      }
      return 0;
    },
    withMemorySyncLockFn: async (_options: object, callback: () => Promise<void>) => {
      if (lockHeld) throw new MemorySyncLockHeldError({ label: 'operator', pid: 123 });
      return callback();
    },
  });

  expect(await r.runCycle()).toMatchObject({
    state: 'publish_blocked', gateOpen: false, failure: { phase: 'publish', category: 'local_precondition' },
  });
  failPublish = false;
  expect(await r.runCycle()).toMatchObject({ state: 'ok', gateOpen: true, failure: null });
  lockHeld = true;
  expect(await r.runCycle()).toMatchObject({
    state: 'ok', gateOpen: true, failure: { phase: 'cycle', category: 'lock_held', exit_code: null },
  });
  lockHeld = false;
  expect(await r.runStartupCycle(100)).toMatchObject({ state: 'ok', gateOpen: false, failure: null });
  const prior = r.health();
  lockHeld = true;
  const locked = await r.runCycle();
  expect(locked).toMatchObject({
    state: prior.state,
    gateOpen: prior.gateOpen,
    failure: { phase: 'cycle', category: 'lock_held', exit_code: null },
  });
  expect(locked.detail).toBe('another memory sync operator owns the convergence lock; retry shortly');

  lockHeld = false;
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED = '1';
  expect(await r.runCycle()).toMatchObject({ state: 'disabled', gateOpen: true, failure: null });
});

test('re-enable lock contention keeps the unproven raw-memory gate closed without starting convergence', async () => {
  let lockAttempts = 0;
  let safetyWork = 0;
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'unchanged across lock contention\n');
  const before = fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'));
  const r = runner(B, {
    withMemorySyncLockFn: async () => {
      lockAttempts += 1;
      throw new MemorySyncLockHeldError({ label: 'operator', pid: 123 });
    },
    assessFreshnessFn: async () => {
      safetyWork += 1;
      return { state: 'fresh', heads: [] };
    },
    runMemoryCommandFn: async () => {
      safetyWork += 1;
      return 0;
    },
  });

  process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED = '1';
  expect(await r.runCycle()).toMatchObject({ state: 'disabled', enabled: false, gateOpen: true, failure: null });

  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;
  const locked = await r.runCycle();
  expect(locked).toMatchObject({
    state: 'disabled',
    enabled: true,
    gateOpen: false,
    failure: { phase: 'cycle', category: 'lock_held', exit_code: null },
  });
  expect(lockAttempts).toBe(1);
  expect(safetyWork).toBe(0);
  expect(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'))).toEqual(before);
});

test('daemon-local terminal phases bind canonical records without leaking thrown text', async () => {
  const configFailure = runner(B, {
    readConfigFn: async () => { throw new Error('token=SENTINEL_CONFIG'); },
  });
  expect(await configFailure.runCycle()).toMatchObject({
    state: 'store_deferred',
    failure: { phase: 'config', category: 'unknown', exit_code: null },
  });
  expect(JSON.stringify(configFailure.health())).not.toContain('SENTINEL_CONFIG');

  const headFailure = runner(B, {
    runMemoryCommandFn: async () => 0,
    getMemoryStoreAdapterFn: () => ({
      localMatchesOwnHeadAsync: async () => { throw new Error('raw=SENTINEL_HEAD'); },
    }),
  });
  expect(await headFailure.runCycle()).toMatchObject({
    state: 'store_deferred',
    failure: { phase: 'head_compare', category: 'unknown', exit_code: null },
  });
  expect(JSON.stringify(headFailure.health())).not.toContain('SENTINEL_HEAD');

  const cycleFailure = runner(B, {
    withMemorySyncLockFn: async () => { throw new Error('raw=SENTINEL_CYCLE'); },
  });
  expect(await cycleFailure.runCycle()).toMatchObject({
    state: 'store_deferred',
    failure: { phase: 'cycle', category: 'unknown', exit_code: null },
  });
  expect(JSON.stringify(cycleFailure.health())).not.toContain('SENTINEL_CYCLE');
});

test('operator health classifies only the failing command and never exposes captured stderr', async () => {
  const deferred = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { stderr: (line: string) => void }) => {
      if (argv[0] === 'refresh') commandIo.stderr('network ETIMEDOUT token=SENTINEL_REFRESH');
      return argv[0] === 'refresh' ? 1 : 0;
    },
  });
  const deferredHealth = await deferred.runCycle();
  expect(deferredHealth).toMatchObject({ state: 'store_deferred' });
  expect(deferredHealth.detail).toContain('timeout');
  expect(deferredHealth.detail).not.toContain('SENTINEL_REFRESH');

  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'queued replay\n');
  enqueueReplayItem({
    projectRoot: B,
    store: { scheme: 'file', root: storeRoot },
    snapshotId: 'capture-isolation',
  });
  const replayThenTimeout = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { stderr: (line: string) => void }) => {
      if (argv[0] === 'replay') commandIo.stderr('conflict from earlier successful phase');
      if (argv[0] === 'refresh') commandIo.stderr('network ETIMEDOUT token=SENTINEL_REPLAY_TIMEOUT');
      return argv[0] === 'refresh' ? 1 : 0;
    },
  });
  const replayThenTimeoutHealth = await replayThenTimeout.runCycle();
  expect(replayThenTimeoutHealth).toMatchObject({ state: 'store_deferred' });
  expect(replayThenTimeoutHealth.detail).toContain('timeout');
  expect(replayThenTimeoutHealth.detail).not.toContain('conflict');
  expect(replayThenTimeoutHealth.detail).not.toContain('SENTINEL_REPLAY_TIMEOUT');

  const publishConflict = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { stderr: (line: string) => void }) => {
      if (argv[0] === 'publish') commandIo.stderr('conflict token=SENTINEL_PUBLISH');
      return argv[0] === 'publish' ? 3 : 0;
    },
  });
  const publishConflictHealth = await publishConflict.runCycle();
  expect(publishConflictHealth).toMatchObject({ state: 'blocked_conflict' });
  expect(publishConflictHealth.detail).toContain('conflict');
  expect(publishConflictHealth.detail).not.toContain('SENTINEL_PUBLISH');

  const structured = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { conflict?: (record: object) => void }) => {
      if (argv[0] === 'publish') commandIo.conflict?.({ schema: 'memory-conflict/v1', conflicts: [{ path: 'memory/z.md', reason_code: 'store_changed_since_baseline' }, { path: '/private/SENTINEL_PATH', reason_code: 'store_changed_since_baseline' }, { path: 'memory/a.md', reason_code: 'local_not_strictly_newer' }], omitted_count: 0 });
      return argv[0] === 'publish' ? 3 : 0;
    },
  });
  const structuredHealth = await structured.runCycle();
  expect(structuredHealth.failure).toEqual({
    schema: 'memory-convergence-failure/v1',
    phase: 'publish',
    category: 'conflict',
    exit_code: 3,
  });
  expect(structuredHealth.detail).not.toContain('memory/z.md');
  expect(structuredHealth.detail).not.toContain('memory/a.md');
  expect(structuredHealth.detail).not.toContain('SENTINEL_PUBLISH');
  expect(structuredHealth.detail).not.toContain('SENTINEL_PATH');

  const getterReads = { path: 0, reason: 0, omitted: 0 };
  const statefulItem = {};
  Object.defineProperties(statefulItem, {
    path: {
      enumerable: true,
      get: () => (++getterReads.path === 1 ? 'memory/stateful.md' : '/private/SENTINEL_PATH'),
    },
    reason_code: {
      enumerable: true,
      get: () => (++getterReads.reason === 1 ? 'store_changed_since_baseline' : 'SENTINEL_REASON'),
    },
  });
  const statefulRecord = { schema: 'memory-conflict/v1', conflicts: [statefulItem] };
  Object.defineProperty(statefulRecord, 'omitted_count', {
    enumerable: true,
    get: () => (++getterReads.omitted === 1 ? 0 : -1),
  });
  const statefulCallback = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { conflict?: (record: object) => void }) => {
      if (argv[0] === 'publish') commandIo.conflict?.(statefulRecord);
      return argv[0] === 'publish' ? 3 : 0;
    },
  });
  const statefulHealth = await statefulCallback.runCycle();
  expect(getterReads).toEqual({ path: 1, reason: 1, omitted: 1 });
  expect(statefulHealth.failure).toMatchObject({
    phase: 'publish',
    category: 'conflict',
    conflict: {
      conflicts: [{ path: 'memory/stateful.md', reason_code: 'store_changed_since_baseline' }],
      omitted_count: 0,
    },
  });
  expect(JSON.stringify(statefulHealth)).not.toContain('SENTINEL');

  const legacyReplay = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { stderr: (line: string) => void }) => {
      if (argv[0] === 'replay') commandIo.stderr('conflict raw=SENTINEL_LEGACY_REPLAY');
      return argv[0] === 'replay' ? 3 : 0;
    },
  });
  const legacyReplayHealth = await legacyReplay.runCycle();
  expect(legacyReplayHealth).toMatchObject({ state: 'blocked_conflict' });
  expect(legacyReplayHealth.detail).toContain('replay memory conflict (exit 3)');
  expect(legacyReplayHealth.detail).not.toContain('SENTINEL_LEGACY_REPLAY');

  const arrayCallback = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { conflict?: (record: object) => void; stderr: (line: string) => void }) => {
      if (argv[0] === 'publish') {
        commandIo.conflict?.([{ path: 'memory/SENTINEL_ARRAY.md', reason_code: 'store_changed_since_baseline' }] as unknown as object);
        commandIo.stderr('conflict raw=SENTINEL_ARRAY_FALLBACK');
      }
      return argv[0] === 'publish' ? 3 : 0;
    },
  });
  const arrayCallbackHealth = await arrayCallback.runCycle();
  expect(arrayCallbackHealth).toMatchObject({ state: 'blocked_conflict' });
  expect(arrayCallbackHealth.detail).toContain('publish memory conflict (exit 3)');
  expect(arrayCallbackHealth.detail).not.toContain('SENTINEL_ARRAY');
});

beforeEach(() => {
  storeRoot = fs.mkdtempSync(path.join(tmpBase, 'store-'));
  A = makeCheckout('A-');
  B = makeCheckout('B-');
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED = '1';
  process.env.AGENTBOOTUP_MEMORY_STORE = `file://${storeRoot}`;
  // SAVE/RESTORE, never delete: the hermetic preload sets this globally and
  // bun test shares one process — deleting it strips the guard for every
  // later test file, which mints a machine id into real $HOME (CI hermetic
  // job caught exactly this).
  previousMachineIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(tmpBase, 'no-such-machine-id');
});

afterEach(() => {
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;
  delete process.env.AGENTBOOTUP_MEMORY_STORE;
  if (previousMachineIdFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  else process.env.AGENTBOOTUP_MACHINE_ID_FILE = previousMachineIdFile;
});

test('converge defaults active and the emergency kill switch explicitly disables it', async () => {
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
  expect(isConvergeEnabled()).toBe(true);
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED = '1';
  const r = runner(B);
  expect(isConvergeEnabled()).toBe(false);
  const h = await r.runCycle();
  expect(h.state).toBe('disabled');
  expect(h.enabled).toBe(false);
  expect(h.gateOpen).toBe(true);
  expect(h.configSource).toBe('env:AGENTBOOTUP_MEMORY_CONVERGE_DISABLED');
  expect(r.isMemoryPushGateOpen()).toBe(true);
});

test('fresh install without overrides logs converge active from the default source', async () => {
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
  const logs: string[] = [];
  const r = createConvergeRunner({
    projectRoot: B,
    brainId: 'converge-test.gm',
    log: (message: string) => logs.push(message),
    logError: noop,
    readConfigFn: async () => ({}),
  });
  await r.runCycle();
  expect(r.health()).toMatchObject({ enabled: true, configSource: 'default' });
  expect(logs.join('\n')).toContain(
    "Memory converge active for brain 'converge-test.gm' (source=default",
  );
});

test('persisted converge setting controls the default and environment takes precedence', async () => {
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
  const off = runner(B, { readConfigFn: async () => ({ memoryConvergeEnabled: false }) });
  expect((await off.runCycle()).state).toBe('disabled');
  expect(off.health()).toMatchObject({ enabled: false, configSource: 'persisted' });

  process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED = '1';
  const envOn = runner(B, { readConfigFn: async () => ({ memoryConvergeEnabled: false }) });
  await envOn.runCycle();
  expect(envOn.health()).toMatchObject({ enabled: true, configSource: 'env:AGENTBOOTUP_MEMORY_CONVERGE_ENABLED' });

  process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED = '1';
  const emergencyOff = runner(B, { readConfigFn: async () => ({ memoryConvergeEnabled: true }) });
  await emergencyOff.runCycle();
  expect(emergencyOff.health()).toMatchObject({ enabled: false, configSource: 'env:AGENTBOOTUP_MEMORY_CONVERGE_DISABLED' });
});

test('per-boot gate: closed until the first completed converge pass, open after (empty store counts)', async () => {
  const r = runner(B);
  expect(r.isMemoryPushGateOpen()).toBe(false); // armed (4a on), not yet satisfied
  const h = await r.runCycle();
  expect(r.isMemoryPushGateOpen()).toBe(true);  // empty/never-synced store satisfies (FR 4b bootstrap)
  expect(h.gateOpen).toBe(true);
  expect(h.state).toBe('never_synced'); // empty local tree, nothing published (FR B-5)
});

test('A edit -> B converge applies it; B republishes only when its own content changes (7c no ping-pong)', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'from A v1\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);

  const rB = runner(B);
  const h1 = await rB.runCycle();
  expect(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'), 'utf8')).toBe('from A v1\n');
  // Adopting fleet content must NOT mint a head (a same-bytes republish makes
  // other checkouts' next edits look baseline-conflicted).
  expect(h1.state).toBe('ok');
  expect(h1.detail).toBe('matches fleet');
  const h2 = await rB.runCycle();
  expect(h2.state).toBe('ok'); // repeat cycles stay no-ops
});

test('deletion on A propagates to B via tombstones', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'keep\n');
  fs.writeFileSync(path.join(A, 'memory', 'gone.md'), 'delete me\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);

  const rB = runner(B);
  await rB.runCycle();
  expect(fs.existsSync(path.join(B, 'memory', 'gone.md'))).toBe(true);

  fs.rmSync(path.join(A, 'memory', 'gone.md'));
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);
  await rB.runCycle();
  expect(fs.existsSync(path.join(B, 'memory', 'gone.md'))).toBe(false);
  expect(fs.existsSync(path.join(B, 'memory', 'MEMORY.md'))).toBe(true);
});

// Re-enabled with PR-2a (ruling msg-1784305375296): fast-forward publish
// allows only-local-moved edits; both-sides-moved stays blocked_conflict.
test('same-page conflict surfaces blocked_conflict with the exact next command — never auto-resolved', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'A line\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);
  const rB = runner(B);
  await rB.runCycle(); // B converges + publishes its head

  // Divergence: A and B both edit the same page; A publishes first.
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'A line 2\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'B line 2\n');

  const h = await rB.runCycle();
  expect(h.state).toBe('blocked_conflict');
  expect(h.detail).toContain('agentbootup memory publish');
  expect(h.blockedSince).not.toBeNull();
  // Local edit untouched (never auto-resolved).
  expect(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'), 'utf8')).toBe('B line 2\n');
});

test('escalation hook fires once after the window, and mid-boot enable re-closes the gate', async () => {
  process.env.AGENTBOOTUP_MEMORY_CONFLICT_ESCALATION_MS = '1';
  try {
    fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'A\n');
    expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);
    const escalations: object[] = [];
    const rB = runner(B, { onEscalate: (info: object) => escalations.push(info) });
    await rB.runCycle();
    fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'A2\n');
    expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);
    fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'B2\n');
    await rB.runCycle();
    await new Promise((r) => setTimeout(r, 5));
    await rB.runCycle();
    await rB.runCycle();
    expect(escalations.length).toBe(1); // once per blocked window, not per cycle

    // Mid-boot flag flip: off then on re-closes the gate (FR 4b).
    process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED = '1';
    await rB.runCycle();
    expect(rB.isMemoryPushGateOpen()).toBe(true); // disarmed = no behavior change
    delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;
    process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED = '1';
    expect(rB.isMemoryPushGateOpen()).toBe(false); // re-armed, gate re-closed
  } finally {
    delete process.env.AGENTBOOTUP_MEMORY_CONFLICT_ESCALATION_MS;
  }
});

test('single-side divergence today: publish conflict surfaces blocked_conflict; escalation fires once; mid-boot re-close', async () => {
  // Exercises the conflict, escalation, and gate paths under CURRENT publish
  // semantics (no PR-2a needed): B holds a local edit of a page the store
  // already has — publish exits 3 and the runner surfaces it, never
  // auto-resolving.
  process.env.AGENTBOOTUP_MEMORY_CONFLICT_ESCALATION_MS = '1';
  try {
    fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'A line\n');
    expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);
    const escalations: object[] = [];
    const rB = runner(B, { onEscalate: (info: object) => escalations.push(info) });
    fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'B local edit\n');

    const h = await rB.runCycle();
    expect(h.state).toBe('blocked_conflict');
    expect(h.detail).toContain('agentbootup memory publish');
    expect(h.blockedSince).not.toBeNull();
    expect(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'), 'utf8')).toBe('B local edit\n');
    expect(h.gateOpen).toBe(false);
    expect(rB.isMemoryPushGateOpen()).toBe(false);

    await new Promise((r) => setTimeout(r, 5));
    await rB.runCycle();
    await rB.runCycle();
    expect(escalations.length).toBe(1); // once per blocked window

    fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'A line\n');
    expect(await rB.runCycle()).toMatchObject({ state: 'ok', gateOpen: true });
    expect(rB.isMemoryPushGateOpen()).toBe(true);

    // Mid-boot flag flip re-closes the gate (FR 4b).
    process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED = '1';
    await rB.runCycle();
    expect(rB.isMemoryPushGateOpen()).toBe(true);
    delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;
    process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED = '1';
    expect(rB.isMemoryPushGateOpen()).toBe(false);
  } finally {
    delete process.env.AGENTBOOTUP_MEMORY_CONFLICT_ESCALATION_MS;
  }
});

test('interval default is 5 minutes and env-overridable lazily', () => {
  expect(getConvergeIntervalMs()).toBe(300_000);
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_INTERVAL_MS = '1234';
  try {
    expect(getConvergeIntervalMs()).toBe(1234);
  } finally {
    delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_INTERVAL_MS;
  }
});

test('startup timeout invalidates the late cycle and leaves the publication gate closed', async () => {
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const commands: string[] = [];
  const lateBaseline = path.join(B, '.brain', 'late-baseline.json');
  const lateHead = path.join(storeRoot, 'late-head.json');
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[], _io: unknown, options: { signal?: AbortSignal } = {}) => {
      commands.push(argv[0]);
      if (argv[0] === 'refresh') {
        await refreshBlocked;
        if (!options.signal?.aborted) {
          fs.mkdirSync(path.dirname(lateBaseline), { recursive: true });
          fs.writeFileSync(lateBaseline, 'late baseline\n');
          fs.writeFileSync(lateHead, 'late head\n');
        }
      }
      return 0;
    },
  });

  const h = await r.runStartupCycle(100);
  expect(h).toMatchObject({
    state: 'store_deferred',
    gateOpen: false,
    failure: { phase: 'startup', category: 'timeout', exit_code: null },
  });
  expect(h.detail).toContain('startup timeout');
  expect(r.isMemoryPushGateOpen()).toBe(false);

  releaseRefresh();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(r.isMemoryPushGateOpen()).toBe(false);
  expect(commands).toEqual(['refresh']);
  expect(fs.existsSync(lateBaseline)).toBe(false);
  expect(fs.existsSync(lateHead)).toBe(false);
});

test('startup queue inspection keeps blocked conflict state while reporting a legal local precondition', async () => {
  const commands: string[] = [];
  const escalations: object[] = [];
  process.env.AGENTBOOTUP_MEMORY_CONFLICT_ESCALATION_MS = '1';
  try {
    const r = runner(B, {
      runMemoryCommandFn: async (argv: string[]) => {
        commands.push(argv[0]);
        return 0;
      },
      readReplayQueueReadOnlyFn: () => ({
        items: [{ id: 'queued-conflict', last_outcome: { type: 'blocked_conflict' } }],
      }),
      onEscalate: (info: object) => escalations.push(info),
    });

    const health = await r.runStartupCycle(100);
    expect(health).toMatchObject({
      state: 'blocked_conflict',
      gateOpen: false,
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'queue_inspect',
        category: 'local_precondition',
        exit_code: null,
      },
    });
    expect(health.detail).toBe('local replay queue blocks raw memory publication');
    expect(commands).toEqual(['refresh']);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await r.runStartupCycle(100);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ state: 'blocked_conflict' });
    expect(commands).toEqual(['refresh', 'refresh']);
  } finally {
    delete process.env.AGENTBOOTUP_MEMORY_CONFLICT_ESCALATION_MS;
  }
});

test('an empty replay queue leaves startup closed until periodic safety proof', async () => {
  const r = runner(B, {
    runMemoryCommandFn: async () => 0,
    readReplayQueueReadOnlyFn: () => ({ items: [] }),
  });
  expect(await r.runStartupCycle(100)).toMatchObject({ state: 'ok', gateOpen: false });
});

test('startup refresh keeps same-page local drift behind the raw-memory gate', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'shared v1\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);
  const firstB = runner(B);
  expect((await firstB.runCycle()).state).toBe('ok');

  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'remote v2\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'local v2\n');

  const restartedB = runner(B);
  const startup = await restartedB.runStartupCycle(100);
  expect(startup).toMatchObject({ state: 'ok', gateOpen: false });
  expect(restartedB.isMemoryPushGateOpen()).toBe(false);
  expect(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'), 'utf8')).toBe('local v2\n');
});

test('an enabled periodic cycle closes an open gate before refresh settles', async () => {
  let refreshCalls = 0;
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[]) => {
      if (argv[0] === 'refresh' && ++refreshCalls === 2) await refreshBlocked;
      return 0;
    },
  });

  try {
    expect(await r.runCycle()).toMatchObject({ gateOpen: true });
    const periodic = r.runCycle();
    expect(await waitUntil(() => refreshCalls === 2)).toBe(true);
    expect(r.isMemoryPushGateOpen()).toBe(false);
    releaseRefresh();
    expect(await periodic).toMatchObject({ state: 'never_synced', gateOpen: true });
  } finally {
    releaseRefresh?.();
  }
});

test('a concurrent config flip cannot reopen the gate owned by an active cycle', async () => {
  let configReads = 0;
  let refreshStarted = false;
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const r = runner(B, {
    readConfigFn: async () => ({ memoryConvergeEnabled: ++configReads === 1 }),
    runMemoryCommandFn: async (argv: string[]) => {
      if (argv[0] === 'refresh') {
        refreshStarted = true;
        await refreshBlocked;
      }
      return 0;
    },
  });

  try {
    const active = r.runCycle();
    expect(await waitUntil(() => refreshStarted)).toBe(true);
    expect(r.isMemoryPushGateOpen()).toBe(false);
    expect(await r.runCycle()).toMatchObject({ gateOpen: false });
    expect(configReads).toBe(1);
    releaseRefresh();
    expect(await active).toMatchObject({ gateOpen: true });
  } finally {
    releaseRefresh?.();
  }
});

test('refresh failure closes a previously open gate until a clean cycle recovers', async () => {
  let refreshFails = false;
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[]) => argv[0] === 'refresh' && refreshFails ? 1 : 0,
  });

  expect(await r.runCycle()).toMatchObject({ gateOpen: true });
  refreshFails = true;
  expect(await r.runCycle()).toMatchObject({ state: 'store_deferred', gateOpen: false });
  expect(r.isMemoryPushGateOpen()).toBe(false);
  refreshFails = false;
  expect(await r.runCycle()).toMatchObject({ state: 'never_synced', gateOpen: true });
});

test('non-conflict publish failure reports publish_blocked with the gate closed', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'cannot publish yet\n');
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[]) => argv[0] === 'publish' ? 1 : 0,
  });

  expect(await r.runCycle()).toMatchObject({
    state: 'publish_blocked',
    gateOpen: false,
    failure: { phase: 'publish', category: 'unknown', exit_code: 1 },
  });
  expect(r.isMemoryPushGateOpen()).toBe(false);
});

test('a never_synced terminal outcome clears a prior canonical failure', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'cannot publish yet\n');
  let failPublish = true;
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { failure?: (hint: object) => void }) => {
      if (argv[0] === 'publish' && failPublish) {
        commandIo.failure?.({ category: 'authorization' });
        return 1;
      }
      return 0;
    },
    getMemoryStoreAdapterFn: () => ({
      localMatchesOwnHeadAsync: async () => failPublish
        ? { matches: false, reason: 'never_published' }
        : { matches: true, reason: 'empty_both' },
    }),
  });

  expect(await r.runCycle()).toMatchObject({
    state: 'publish_blocked',
    failure: { phase: 'publish', category: 'authorization', exit_code: 1 },
  });
  failPublish = false;
  expect(await r.runCycle()).toMatchObject({
    state: 'never_synced',
    gateOpen: true,
    failure: null,
  });
});

test('a stale terminal outcome clears a prior canonical failure', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'stale after failure\n');
  let stale = false;
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[], commandIo: { failure?: (hint: object) => void }) => {
      if (argv[0] === 'publish' && !stale) {
        commandIo.failure?.({ category: 'authorization' });
        return 1;
      }
      return 0;
    },
    assessFreshnessFn: async () => stale
      ? {
        state: 'stale',
        localDirtyAgeMs: 99,
        freshHeads: [{ publisherId: 'fresh', ageMs: 1 }],
        staleHeads: [{ publisherId: 'stale', ageMs: 99 }],
      }
      : { state: 'never_synced', heads: [] },
  });

  expect(await r.runCycle()).toMatchObject({
    state: 'publish_blocked', failure: { phase: 'publish', category: 'authorization' },
  });
  stale = true;
  expect(await r.runCycle()).toMatchObject({ state: 'stale', gateOpen: false, failure: null });
});

test('startup queue-inspection failure re-closes a previously open gate', async () => {
  let queueReadable = true;
  const r = runner(B, {
    runMemoryCommandFn: async () => 0,
    readReplayQueueReadOnlyFn: () => {
      if (!queueReadable) throw new Error('unreadable queue details');
      return { items: [] };
    },
  });

  expect(await r.runCycle()).toMatchObject({ gateOpen: true });
  queueReadable = false;
  expect(await r.runStartupCycle(100)).toMatchObject({ state: 'store_deferred', gateOpen: false });
  expect(r.health().detail).toBe('replay queue cannot be inspected safely');
  expect(r.health().failure).toEqual({
    schema: 'memory-convergence-failure/v1',
    phase: 'queue_inspect',
    category: 'invalid_payload',
    exit_code: null,
  });
});

for (const [errorCode, expectedCategory] of [
  ['EACCES', 'local_precondition'],
  ['EPERM', 'local_precondition'],
  ['EROFS', 'local_precondition'],
  ['EIO', 'local_precondition'],
  ['ESTALE', 'local_precondition'],
  ['ETIMEDOUT', 'timeout'],
] as const) {
  test(`startup queue inspection classifies ${errorCode} as ${expectedCategory}`, async () => {
    const commands: string[] = [];
    const rawSentinel = `SENTINEL_${errorCode}_PRIVATE_PATH`;
    const r = runner(B, {
      runMemoryCommandFn: async (argv: string[]) => {
        commands.push(argv[0]);
        return 0;
      },
      readReplayQueueReadOnlyFn: () => {
        const error: NodeJS.ErrnoException = new Error(`${rawSentinel} /private/queue/path`);
        error.code = errorCode;
        throw error;
      },
    });

    const health = await r.runStartupCycle(100);

    expect(health).toMatchObject({
      state: 'store_deferred',
      gateOpen: false,
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'queue_inspect',
        category: expectedCategory,
        exit_code: null,
      },
    });
    expect(commands).toEqual(['refresh']);
    expect(health.detail).toBe(expectedCategory === 'timeout'
      ? 'local replay queue inspection timed out; publication gate remains closed'
      : 'local replay queue blocks raw memory publication');
    expect(JSON.stringify(health)).not.toContain(rawSentinel);
    expect(JSON.stringify(health)).not.toContain('/private/queue/path');
  });
}

test('startup queue inspection ignores inherited, accessor, and trapping error codes', async () => {
  let accessorReads = 0;
  const inherited = Object.create({ code: 'EACCES' });
  Object.defineProperty(inherited, 'message', { value: 'SENTINEL_INHERITED_CODE' });
  const accessor = new Error('SENTINEL_ACCESSOR_CODE');
  Object.defineProperty(accessor, 'code', {
    get() {
      accessorReads += 1;
      return 'EACCES';
    },
  });
  const trapping = new Proxy(new Error('SENTINEL_TRAPPING_CODE'), {
    getOwnPropertyDescriptor() {
      throw new Error('SENTINEL_DESCRIPTOR_TRAP');
    },
  });

  for (const hostileError of [inherited, accessor, trapping]) {
    const r = runner(B, {
      runMemoryCommandFn: async () => 0,
      readReplayQueueReadOnlyFn: () => { throw hostileError; },
    });
    const health = await r.runStartupCycle(100);
    expect(health).toMatchObject({
      state: 'store_deferred',
      gateOpen: false,
      failure: { phase: 'queue_inspect', category: 'invalid_payload', exit_code: null },
    });
    expect(health.detail).toBe('replay queue cannot be inspected safely');
    expect(JSON.stringify(health)).not.toContain('SENTINEL');
  }
  expect(accessorReads).toBe(0);
});

test('replay conflict closes a previously open gate before refresh or publish', async () => {
  const commands: string[] = [];
  let replayConflicts = false;
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[]) => {
      commands.push(argv[0]);
      return argv[0] === 'replay' && replayConflicts ? 3 : 0;
    },
  });

  expect(await r.runCycle()).toMatchObject({ gateOpen: true });
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'queued replay\n');
  enqueueReplayItem({
    projectRoot: B,
    store: { scheme: 'file', root: storeRoot },
    snapshotId: 'gate-closes-on-replay-conflict',
  });
  replayConflicts = true;
  commands.length = 0;

  expect(await r.runCycle()).toMatchObject({ state: 'blocked_conflict', gateOpen: false });
  expect(r.isMemoryPushGateOpen()).toBe(false);
  expect(commands).toEqual(['replay']);
});

test('periodic safety watchdog re-closes a previously open gate and records store_deferred', async () => {
  let calls = 0;
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const previousWatchdog = process.env.AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS;
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS = '5';
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[]) => {
      if (argv[0] === 'refresh' && ++calls === 2) await refreshBlocked;
      return 0;
    },
  });

  try {
    expect(await r.runCycle()).toMatchObject({ gateOpen: true });
    const periodic = r.runCycle();
    expect(await waitUntil(() => r.health().state === 'store_deferred')).toBe(true);
    expect(r.health()).toMatchObject({ state: 'store_deferred', gateOpen: false });
    expect(r.health().detail).toContain('safety phase timeout');
    expect(r.health().failure).toMatchObject({ phase: 'cycle', category: 'timeout', exit_code: null });
    releaseRefresh();
    await periodic;
    expect(r.isMemoryPushGateOpen()).toBe(false);
  } finally {
    releaseRefresh?.();
    if (previousWatchdog === undefined) delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS;
    else process.env.AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS = previousWatchdog;
  }
});

test('startup is a bounded pull/apply phase and cannot leave a late publisher head or baseline write', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'local edit\n');
  let publishStarted = false;
  let releasePublish!: () => void;
  const publishBlocked = new Promise<void>((resolve) => { releasePublish = resolve; });
  const commands: string[] = [];
  const r = runner(B, {
    runMemoryCommandFn: async (argv: string[]) => {
      commands.push(argv[0]);
      if (argv[0] === 'publish') {
        publishStarted = true;
        await publishBlocked;
      }
      return 0;
    },
    assessFreshnessFn: async () => ({ state: 'never_synced', freshHeads: [] }),
  });

  const startup = await r.runStartupCycle(100);
  expect(startup.gateOpen).toBe(false);
  expect(commands).toEqual(['refresh']);
  expect(publishStarted).toBe(false);

  const periodic = r.runCycle();
  for (let i = 0; i < 20 && !publishStarted; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(publishStarted).toBe(true);
  expect(commands).toEqual(['refresh', 'refresh', 'publish']);
  expect(r.isMemoryPushGateOpen()).toBe(false);
  releasePublish();
  expect(await periodic).toMatchObject({ state: 'ok', gateOpen: true });
});

test('stale-local/fresh-remote evidence suppresses replay, snapshot publish, and raw-memory gate', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'stale local\n');
  enqueueReplayItem({
    projectRoot: B,
    store: { scheme: 'file', root: storeRoot },
    snapshotId: 'queued-before-stale-check',
  });
  const commands: string[] = [];
  const logs: string[] = [];
  const r = createConvergeRunner({
    projectRoot: B,
    brainId: 'converge-test.gm',
    log: (message: string) => logs.push(message),
    logError: noop,
    assessFreshnessFn: async () => ({
      state: 'stale',
      localDirtyAgeMs: 72 * 60 * 60_000,
      freshnessHours: 48,
      freshHeads: [{ publisherId: 'fresh-machine', ageMs: 60_000 }],
    }),
    runMemoryCommandFn: async (argv: string[]) => {
      commands.push(argv[0]);
      return 0;
    },
  });

  const h = await r.runCycle();
  expect(commands).toEqual(['refresh']);
  expect(h).toMatchObject({ state: 'stale', gateOpen: false });
  expect(r.isMemoryPushGateOpen()).toBe(false);
  expect(h.detail).toContain('local_dirty_age_ms=259200000');
  expect(h.detail).toContain('freshest_remote_head_age_ms=60000');
  expect(logs.join('\n')).toContain('local_dirty_age_ms=259200000');
  expect(logs.join('\n')).toContain('freshest_remote_head_age_ms=60000');
});

test('stale fleet-head evidence suppresses every publication path without a local dirty age', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'stale own head\n');
  enqueueReplayItem({
    projectRoot: B,
    store: { scheme: 'file', root: storeRoot },
    snapshotId: 'queued-behind-stale-own-head',
  });
  const commands: string[] = [];
  const r = runner(B, {
    assessFreshnessFn: async () => ({
      state: 'stale',
      localDirtyAgeMs: null,
      staleHeads: [{ publisherId: 'this-checkout', ageMs: 72 * 60 * 60_000 }],
      freshHeads: [{ publisherId: 'fresh-sibling', ageMs: 60_000 }],
    }),
    runMemoryCommandFn: async (argv: string[]) => {
      commands.push(argv[0]);
      return 0;
    },
  });

  const h = await r.runCycle();
  expect(commands).toEqual(['refresh']);
  expect(h).toMatchObject({ state: 'stale', gateOpen: false });
  expect(h.detail).toContain('local_dirty_age_ms=unknown');
  expect(h.detail).toContain('stale_publisher_heads=this-checkout');
});

test('stale evidence synchronously re-closes an open gate before refresh settles', async () => {
  let assessment = 0;
  let refreshCalls = 0;
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const r = runner(B, {
    assessFreshnessFn: async () => {
      assessment += 1;
      return assessment === 1
        ? { state: 'ok', freshHeads: [] }
        : {
            state: 'stale',
            localDirtyAgeMs: null,
            staleHeads: [{ publisherId: 'stale-checkout', ageMs: 72 * 60 * 60_000 }],
            freshHeads: [{ publisherId: 'fresh-sibling', ageMs: 60_000 }],
          };
    },
    runMemoryCommandFn: async (argv: string[]) => {
      if (argv[0] === 'refresh') {
        refreshCalls += 1;
        if (refreshCalls === 2) await refreshBlocked;
      }
      return 0;
    },
  });

  try {
    expect(await r.runCycle()).toMatchObject({ state: 'never_synced', gateOpen: true });
    const staleCycle = r.runCycle();
    for (let i = 0; i < 20 && refreshCalls < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(refreshCalls).toBe(2);
    expect(r.isMemoryPushGateOpen()).toBe(false);
    releaseRefresh();
    expect(await staleCycle).toMatchObject({ state: 'stale', gateOpen: false });
  } finally {
    releaseRefresh?.();
  }
});

test('watchdog is re-armed after replay settles so a subsequent hung refresh fails closed', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'queued payload\n');
  enqueueReplayItem({
    projectRoot: B,
    store: { scheme: 'file', root: storeRoot },
    snapshotId: 'replay-completes-before-hung-refresh',
  });
  const previousWatchdog = process.env.AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS;
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS = '5';
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const commands: string[] = [];
  const r = runner(B, {
    assessFreshnessFn: async () => ({ state: 'ok', freshHeads: [] }),
    runMemoryCommandFn: async (argv: string[]) => {
      commands.push(argv[0]);
      if (argv[0] === 'refresh') await refreshBlocked;
      return 0;
    },
  });

  try {
    const cycle = r.runCycle();
    expect(await waitUntil(() => r.health().state === 'store_deferred')).toBe(true);
    expect(commands).toEqual(['replay', 'refresh']);
    expect(r.health()).toMatchObject({ state: 'store_deferred', gateOpen: false });
    expect(r.health().detail).toContain('safety phase timeout');
    releaseRefresh();
    await cycle;
    expect(commands).toEqual(['replay', 'refresh']);
  } finally {
    releaseRefresh?.();
    if (previousWatchdog === undefined) delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS;
    else process.env.AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS = previousWatchdog;
  }
});

test('periodic cycle recovers from stale after freshness clears and only then publishes', async () => {
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'local edit\n');
  const commands: string[] = [];
  let assessment = 0;
  const r = runner(B, {
    assessFreshnessFn: async () => {
      assessment += 1;
      return assessment === 1
        ? {
            state: 'stale',
            localDirtyAgeMs: 72 * 60 * 60_000,
            freshHeads: [{ publisherId: 'fresh-machine', ageMs: 60_000 }],
          }
        : { state: 'ok', freshHeads: [{ publisherId: 'fresh-machine', ageMs: 60_000 }] };
    },
    runMemoryCommandFn: async (argv: string[]) => {
      commands.push(argv[0]);
      return 0;
    },
  });

  expect(await r.runCycle()).toMatchObject({ state: 'stale', gateOpen: false });
  expect(commands).toEqual(['refresh']);
  expect(await r.runCycle()).toMatchObject({ state: 'ok', gateOpen: true });
  expect(commands).toEqual(['refresh', 'refresh', 'publish']);
});

test('real store regression: stale local checkout creates zero publisher heads against fresh remote', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'fresh remote\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`], io)).toBe(0);
  const headsDir = path.join(storeRoot, 'converge-test.gm', 'heads');
  const beforeHeads = fs.readdirSync(headsDir).sort();

  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'stale local\n');
  const staleAt = new Date(Date.now() - 72 * 60 * 60_000);
  fs.utimesSync(path.join(B, 'memory', 'MEMORY.md'), staleAt, staleAt);
  fs.utimesSync(path.join(B, 'memory'), staleAt, staleAt);
  const logs: string[] = [];
  const r = createConvergeRunner({
    projectRoot: B,
    brainId: 'converge-test.gm',
    log: (message: string) => logs.push(message),
    logError: noop,
  });

  const h = await r.runCycle();
  expect(h).toMatchObject({ state: 'stale', gateOpen: false });
  expect(fs.readdirSync(headsDir).sort()).toEqual(beforeHeads);
  expect(logs.join('\n')).toMatch(
    /stale publication suppressed: local_dirty_age_ms=\d+ freshest_remote_head_age_ms=\d+/,
  );
});
