import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { handlePushTranscripts } from '../../src/server/routes/sync.ts';
import { createDenylistManager } from '../../lib/daemon/redaction-denylist.js';
import { buildTranscriptProjectIndex } from '../../lib/daemon/transcript-brain-routing.js';
import {
  getUnknownScopedTranscriptProjectIds,
  resetUnmappedTranscriptLogThrottleForTests,
  resetContainmentRejectionLogThrottleForTests,
  scopeTranscriptProjects,
  syncDiscoveredTranscripts as syncDiscoveredTranscriptsImpl,
  assessTranscriptBackupHealth,
  applyTranscriptCycleHealthStats,
  buildTranscriptHealthPayload,
  getSyncOverallTimeoutMs,
  getSyncHardReleaseGraceMs,
  getSyncRemoteWriteMaxRetentionMs,
  syncPendingFiles,
  parseRetryAfterMs,
  computeTranscriptThrottleCooldownMs,
  collectDenylistProjectRoots,
  persistAcceptedTranscriptCheckpoint,
  persistTranscriptSyncResult,
  prepareTranscriptRedactionLedgerState,
  hydrateStartupTranscriptRedactionHealth,
  configureRedactionLogHmacKey,
  resolveSingleProjectScope,
  buildRedactionDecisionLog,
  runTranscriptRedactionCanary,
  startTranscriptRedactionSubsystem,
  TRANSCRIPT_HEALTH_HOST,
  hydrateRedactionHealthFromState,
} from '../../lib/daemon/transcript-sync.mjs';
import {
  recordTranscriptBrainFailure,
  recordTranscriptPushFailure,
  canonicalTranscriptOffsetKey,
  readSyncState,
  writeSyncState,
} from '../../lib/sync-state/sync-state.js';

const createdDirs = [];

async function makeTranscriptFile(name, content = '{"ok":true}\n') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-transcript-sync-')); // nosemgrep: path-join-resolve-traversal -- test helper creates temp dirs under the OS temp root
  createdDirs.push(dir);
  const filePath = path.join(dir, name); // nosemgrep: path-join-resolve-traversal -- test helper writes caller-controlled fixture names under its own temp dir
  await fsp.writeFile(filePath, content, 'utf8');
  return filePath;
}

afterAll(async () => {
  for (const dir of createdDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeState() {
  return { offsets: {}, transcriptFailures: {}, transcriptPushFailures: {} };
}

const EMPTY_DENYLIST_SNAPSHOT = Object.freeze({
  state: 'empty-by-config',
  revision: 1,
  managerGeneration: 'test-manager',
  additionRevision: 0,
  sourceValueCount: 0,
  values: new Set(),
  sourceMap: new Map(),
  derivedValues: new Set(),
  derivedSourceMap: new Map(),
});

function syncDiscoveredTranscripts(transcripts, options) {
  return syncDiscoveredTranscriptsImpl(transcripts, {
    ...options,
    runtime: { denylistSnapshot: EMPTY_DENYLIST_SNAPSHOT, logFn: () => {}, ...options.runtime },
  });
}

function makeBatchSuccessResponse(brainId, machineId, files) {
  return new Response(
    JSON.stringify({
      data: {
        pushed: files.length,
        appended: 0,
        errors: 0,
        results: files.map((file) => ({
          key: `transcripts/${brainId}/${machineId}/${file.cli}/${file.relative_path}`,
          status: 'pushed',
        })),
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('startup canary exercises exact, heuristic, payload, and post-verification layers in memory', async () => {
  let observedPayload;
  const result = await runTranscriptRedactionCanary({
    sink: (payload) => { observedPayload = payload; },
  });
  const decoded = Buffer.from(observedPayload.files[0].content_base64, 'base64').toString('utf8');
  expect(result.ok).toBe(true);
  expect(result.replacements).toBeGreaterThan(0);
  expect(result.heuristicHits).toBeGreaterThan(0);
  expect(decoded).toContain('REDACTED_ENV');
  expect(decoded).toContain('REDACTED_HEURISTIC');
  expect(TRANSCRIPT_HEALTH_HOST).toBe('127.0.0.1');
});

test('startup redaction subsystem stops and fails closed when canary verification fails', async () => {
  let stopped = false;
  const manager = {
    start: async () => ({ state: 'empty-by-config', values: new Set() }),
    stop: () => { stopped = true; },
  };
  await expect(startTranscriptRedactionSubsystem({
    createDenylistManagerImpl: () => manager,
    runCanaryImpl: () => runTranscriptRedactionCanary({
      redactContentImpl: (_content, options) => {
        options.onReplacement('env');
        options.onReplacement('heuristic');
        return {
          cleanContent: '{"note":"REDACTED_ENV","detail":"sk-proj-agentbootupCanaryHeuristic0123456789"}\n',
          replacements: 1,
          heuristicHits: 1,
          blocked: false,
        };
      },
    }),
  })).rejects.toMatchObject({ code: 'redaction_subsystem_unhealthy' });
  expect(stopped).toBe(true);
});

test('structured redaction decisions hash local file identity and contain no secret values', () => {
  configureRedactionLogHmacKey('synthetic-stable-log-key');
  const localPath = '/Users/example/.codex/sessions/private-session.jsonl';
  const secret = 'synthetic-log-secret-must-not-appear';
  const record = buildRedactionDecisionLog({
    file: localPath, cli: 'codex', replacements: 2, heuristicHits: 1,
    blocked: true, code: 'redaction_failed', secret,
  });
  const serialized = JSON.stringify(record);
  expect(record).toMatchObject({
    cli: 'codex',
    redaction: {
      enabled: true, replacements: 2, heuristic_hits: 1,
      blocked: true, code: 'redaction_failed',
    },
  });
  expect(record.file).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
  expect(serialized).not.toContain(localPath);
  expect(serialized).not.toContain(secret);
  expect(buildRedactionDecisionLog({ file: localPath, cli: 'codex', blocked: false }).file)
    .toBe(record.file);
});

test('invalid ledger configuration is classified as a fail-closed redaction failure', async () => {
  const health = {};
  const loaded = await hydrateStartupTranscriptRedactionHealth(health, {
    withStateLock: async (critical) => critical(),
    readState: async () => ({ redactionBlockLedger: [], redactionLedgerUnhealthy: true }),
    logErrorFn: () => {},
  });
  expect(loaded).toBe(true);
  const state = { redactionBlockLedger: [], redactionLedgerUnhealthy: true };
  await expect(prepareTranscriptRedactionLedgerState(state, {
    redactionLedgerOptions: { env: { AGENTBOOTUP_REDACTION_LEDGER_MAX_ENTRIES: 'invalid' } },
    writeState: async () => {},
  })).rejects.toMatchObject({ code: 'redaction_subsystem_unhealthy' });
});

test('redaction health hydrates blocked files and durable ledger before the first cycle', () => {
  const key = 'transcript:codex:project/session.jsonl';
  const event = {
    at: '2026-07-31T12:00:00.000Z', file: key, cli: 'codex',
    code: 'redaction_blocked_permanent', permanent: true,
  };
  const health = hydrateRedactionHealthFromState({
    enabled: true, blocked_files: [], block_ledger: [], redaction_blocked_permanent: false,
  }, {
    transcriptPushFailures: { [key]: { code: 'redaction_failed', mode: 'permanent' } },
    redactionBlockLedger: [event],
  });
  expect(health.blocked_files).toEqual([{ path: key, code: 'redaction_blocked_permanent' }]);
  expect(health.block_ledger).toEqual([{
    ...event,
    file: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
  }]);
  expect(JSON.stringify(health.block_ledger)).not.toContain(key);
  expect(health.block_ledger_total).toBe(1);
  expect(health.block_ledger_truncated).toBe(false);
  expect(health.redaction_blocked_permanent).toBe(true);
});

test('health reports a permanent redaction block as a stable quarantine, distinct from a transient failure', () => {
  const permanent = assessTranscriptBackupHealth({
    redaction: { redaction_blocked_permanent: true, blocked_files: [] },
  });
  expect(permanent).toMatchObject({
    healthy: false,
    state: 'quarantined_redaction',
    reasons: ['redaction_blocked_permanent'],
  });
  const transient = assessTranscriptBackupHealth({
    redaction: { redaction_blocked_permanent: false, blocked_files: [{ code: 'redaction_failed' }] },
  });
  expect(transient).toMatchObject({
    healthy: false,
    state: 'blocked_redaction',
    reasons: ['redaction_failed'],
  });
});

test('startup health stays online and fail-closed when the persisted ledger is unreadable', async () => {
  const health = { redaction_ledger_unhealthy: false, redaction_subsystem_unhealthy: false };
  const logged = [];
  const loaded = await hydrateStartupTranscriptRedactionHealth(health, {
    withStateLock: async (critical) => critical(),
    readState: async () => {
      const error = new Error('ledger exceeds capacity');
      error.code = 'redaction_subsystem_unhealthy';
      throw error;
    },
    logErrorFn: (...args) => logged.push(args),
  });
  expect(loaded).toBe(false);
  expect(health.redaction_ledger_unhealthy).toBe(true);
  expect(health.redaction_subsystem_unhealthy).toBe(true);
  expect(assessTranscriptBackupHealth({ redaction: health }).reasons)
    .toEqual(['redaction_ledger_unhealthy']);
  expect(logged).toHaveLength(1);
});

test('redaction health ignores expired transient failures during startup hydration', () => {
  const key = 'transcript:codex:project/expired.jsonl';
  const health = hydrateRedactionHealthFromState({}, {
    transcriptPushFailures: {
      [key]: {
        code: 'redaction_failed', mode: 'backoff',
        cooldownUntil: '2026-07-31T11:59:59.000Z',
      },
    },
    redactionBlockLedger: [],
  }, { now: Date.parse('2026-07-31T12:00:00.000Z') });
  expect(health.blocked_files).toEqual([]);
  expect(health.redaction_blocked_permanent).toBe(false);
});

test('redaction health exposes a capped recent ledger view with a durable total', () => {
  const ledger = Array.from({ length: 12 }, (_, index) => ({
    at: new Date(Date.parse('2026-07-31T12:00:00.000Z') + index).toISOString(),
    file: `transcript:codex:${index}.jsonl`, cli: 'codex', code: 'redaction_failed', permanent: false,
  }));
  const health = hydrateRedactionHealthFromState({}, {
    transcriptPushFailures: {}, redactionBlockLedger: ledger,
  }, { env: { AGENTBOOTUP_REDACTION_HEALTH_LEDGER_ENTRIES: '10' } });
  expect(health.block_ledger).toHaveLength(10);
  expect(health.block_ledger[0].file).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(health.block_ledger)).not.toContain('transcript:codex:2.jsonl');
  expect(health.block_ledger_total).toBe(12);
  expect(health.block_ledger_truncated).toBe(true);
});

test('redacts the complete payload before encoding while preserving local bytes and disk offset', async () => {
  const secret = 'synthetic-task3-canary-secret';
  const original = `${JSON.stringify({ message: `before ${secret} after` })}\n`;
  const transcriptFile = await makeTranscriptFile('task3-redaction.jsonl', original);
  const beforeHash = sha256(await fsp.readFile(transcriptFile));
  let payload;
  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task3-redaction.jsonl',
    relative_path: 'project/task3-redaction.jsonl',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      denylistSnapshot: {
        state: 'loaded',
        values: new Set([secret]),
        sourceMap: new Map([[secret, 'env']]),
        derivedValues: new Set(),
        derivedSourceMap: new Map(),
      },
      fetchImpl: async (_url, init) => {
        payload = JSON.parse(init.body);
        return makeBatchSuccessResponse('brain-1', 'machine-1', payload.files);
      },
    },
  });

  expect(result.pushCount).toBe(1);
  expect(result.totalReplacements).toBe(1);
  expect(payload.files).toHaveLength(1);
  const outbound = Buffer.from(payload.files[0].content_base64, 'base64');
  expect(outbound.toString('utf8')).not.toContain(secret);
  expect(outbound.toString('utf8')).toContain('REDACTED_ENV');
  expect(payload.files[0].byte_offset).toBe(0);
  expect(payload.files[0].total_size).toBe(outbound.length);
  expect(result.nextState.offsets[transcriptFile]).toBe(Buffer.byteLength(original));
  expect(sha256(await fsp.readFile(transcriptFile))).toBe(beforeHash);
  expect(Buffer.from(Buffer.from(original).toString('base64'), 'base64').toString('utf8')).toContain(secret);
});

test('failed or missing denylist state blocks the entire cycle before network access', async () => {
  const transcriptFile = await makeTranscriptFile('task3-failed-denylist.jsonl');
  let fetchCalls = 0;
  const options = {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: { fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); } },
  };
  const transcript = [{
    cli: 'codex', path: transcriptFile, filename: 'task3-failed-denylist.jsonl',
    relative_path: 'project/task3-failed-denylist.jsonl',
  }];
  await expect(syncDiscoveredTranscriptsImpl(transcript, options)).rejects.toThrow('denylist is unavailable');
  await expect(syncDiscoveredTranscriptsImpl(transcript, {
    ...options,
    runtime: {
      ...options.runtime,
      denylistSnapshot: { state: 'failed', values: new Set(), errorCode: 'synthetic_loader_failure' },
    },
  })).rejects.toThrow('denylist is unavailable');
  expect(fetchCalls).toBe(0);
});

test('unexpected or malformed redactor output blocks all previously queued network writes', async () => {
  const first = await makeTranscriptFile('task3-first.jsonl', '{"phase":"queue"}\n');
  const second = await makeTranscriptFile('task3-second.jsonl', '{"phase":"fail"}\n');
  let fetchCalls = 0;
  const baseOptions = {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      redactContentImpl: (content) => {
        if (content.includes('"phase":"fail"')) throw new Error('synthetic secret-bearing failure');
        return { cleanContent: content, replacements: 0, heuristicHits: 0, blocked: false, blockReason: null };
      },
    },
  };
  await expect(syncDiscoveredTranscripts([
    { cli: 'codex', path: first, filename: 'task3-first.jsonl', relative_path: 'project/task3-first.jsonl' },
    { cli: 'codex', path: second, filename: 'task3-second.jsonl', relative_path: 'project/task3-second.jsonl' },
  ], baseOptions)).rejects.toThrow('redaction subsystem failed');

  await expect(syncDiscoveredTranscripts([
    { cli: 'codex', path: first, filename: 'task3-first.jsonl', relative_path: 'project/task3-first.jsonl' },
    { cli: 'codex', path: second, filename: 'task3-second.jsonl', relative_path: 'project/task3-second.jsonl' },
  ], {
    ...baseOptions,
    runtime: {
      ...baseOptions.runtime,
      redactContentImpl: (content) => content.includes('"phase":"fail"')
        ? { blocked: false, cleanContent: undefined }
        : { cleanContent: content, replacements: 0, heuristicHits: 0, blocked: false, blockReason: null },
    },
  })).rejects.toThrow('redaction subsystem failed');

  expect(fetchCalls).toBe(0);
});

test('unsupported format blocks all queued network writes', async () => {
  const first = await makeTranscriptFile('task3-unsupported-source.jsonl');
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls += 1; throw new Error('must not fetch'); };

  await expect(syncDiscoveredTranscripts([{
    cli: 'unknown', path: first, filename: 'task3-unknown.bin', relative_path: 'project/task3-unknown.bin',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(), runtime: { fetchImpl },
  })).rejects.toThrow('unsupported transcript redaction format');
  expect(fetchCalls).toBe(0);
});

test('invalid UTF-8 is quarantined as a file-level redaction failure', async () => {
  const transcriptFile = await makeTranscriptFile('task3-invalid-utf8.jsonl');
  await fsp.writeFile(transcriptFile, Buffer.from([0xff, 0xfe, 0xfd]));
  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task3-invalid-utf8.jsonl',
    relative_path: 'project/task3-invalid-utf8.jsonl',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      logErrorFn: () => {},
    },
  });
  const key = canonicalTranscriptOffsetKey('codex', 'project/task3-invalid-utf8.jsonl');
  expect(result.nextState.transcriptPushFailures[key]).toMatchObject({
    code: 'redaction_failed',
    message: 'redaction_invalid_utf8',
  });
  expect(fetchCalls).toBe(0);
});

test('file-level redaction failure enters cooldown without transmitting the file', async () => {
  const secret = 'synthetic-task3-unscrubbable-secret';
  const original = `{"message":"${secret}"`;
  const transcriptFile = await makeTranscriptFile('task3-blocked.jsonl', original);
  let fetchCalls = 0;
  const logs = [];
  const blockedAt = Date.parse('2026-07-31T12:00:00.000Z');
  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task3-blocked.jsonl',
    relative_path: 'project/task3-blocked.jsonl',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      now: blockedAt,
      denylistSnapshot: {
        state: 'loaded', values: new Set([secret]), sourceMap: new Map([[secret, 'denylist']]),
        derivedValues: new Set(), derivedSourceMap: new Map(),
      },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      logFn: (message) => logs.push(message),
      logErrorFn: () => {},
    },
  });
  const key = canonicalTranscriptOffsetKey('codex', 'project/task3-blocked.jsonl');
  expect(result).toMatchObject({
    pushCount: 0, errCount: 1, redactionErrCount: 1, containmentErrCount: 0, stateChanged: true,
  });
  expect(result.nextState.transcriptPushFailures[key]).toMatchObject({ code: 'redaction_failed' });
  expect(result.nextState.redactionBlockLedger).toEqual([{
    at: new Date(blockedAt).toISOString(),
    file: key,
    cli: 'codex',
    code: 'redaction_failed',
    permanent: false,
  }]);
  const decision = logs.map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((entry) => entry?.redaction?.blocked === true);
  expect(decision).toMatchObject({
    cli: 'codex', redaction: { enabled: true, blocked: true, code: 'redaction_failed' },
  });
  expect(decision.file).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(decision)).not.toContain(secret);
  expect(fetchCalls).toBe(0);
  expect(await fsp.readFile(transcriptFile, 'utf8')).toBe(original);
});

test('ledger capacity blocks network work while preserving the triggering file failure', async () => {
  const secret = 'synthetic-ledger-capacity-secret';
  const transcriptFile = await makeTranscriptFile('task5-ledger-capacity.jsonl', `{"message":"${secret}"`);
  const key = canonicalTranscriptOffsetKey('codex', 'project/task5-ledger-capacity.jsonl');
  const now = Date.parse('2026-07-31T12:00:00.000Z');
  const state = makeState();
  const unvisitedKey = 'transcript:codex:project/unvisited.jsonl';
  state.transcriptPushFailures[unvisitedKey] = {
    code: 'upstream_5xx', mode: 'backoff',
    cooldownUntil: '2026-07-31T13:00:00.000Z',
  };
  state.redactionBlockLedger = [{
    at: new Date(now).toISOString(), file: 'transcript:codex:prior.jsonl',
    cli: 'codex', code: 'redaction_failed', permanent: false,
  }];
  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task5-ledger-capacity.jsonl',
    relative_path: 'project/task5-ledger-capacity.jsonl',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state,
    runtime: {
      now,
      denylistSnapshot: {
        ...EMPTY_DENYLIST_SNAPSHOT,
        state: 'loaded', values: new Set([secret]), sourceMap: new Map([[secret, 'denylist']]),
      },
      redactionLedgerOptions: {
        retentionMs: 7 * 24 * 60 * 60_000, maxEntries: 1, maxBytes: 1024 * 1024, env: {},
      },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      logErrorFn: () => {},
    },
  });
  expect(fetchCalls).toBe(0);
  expect(result.redactionSubsystemError).toMatchObject({ code: 'redaction_subsystem_unhealthy' });
  expect(result.nextState.transcriptPushFailures[key]).toMatchObject({ code: 'redaction_failed' });
  expect(result.nextState.redactionLedgerUnhealthy).toBe(true);
  expect(result.nextState.redactionBlockLedger).toHaveLength(1);
  expect(result.nextState.transcriptPushFailures[unvisitedKey]).toMatchObject({
    code: 'upstream_5xx', mode: 'backoff',
  });

  const writes = [];
  await expect(persistTranscriptSyncResult(result, async (nextState) => {
    writes.push(structuredClone(nextState));
  })).rejects.toMatchObject({
    code: 'redaction_subsystem_unhealthy',
    persistedSyncState: result.nextState,
  });
  expect(writes).toHaveLength(1);
  expect(writes[0].transcriptPushFailures[key]).toMatchObject({ code: 'redaction_failed' });
  expect(writes[0].redactionLedgerUnhealthy).toBe(true);
});

test('a persisted unhealthy ledger blocks every later sync until reserved capacity returns', async () => {
  let fetchCalls = 0;
  const now = Date.parse('2026-07-31T12:00:00.000Z');
  const state = makeState();
  state.redactionBlockLedger = [{
    at: new Date(now).toISOString(), file: 'transcript:codex:prior.jsonl',
    cli: 'codex', code: 'redaction_failed', permanent: false,
  }];
  state.redactionLedgerUnhealthy = true;
  await expect(syncDiscoveredTranscripts([], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state,
    runtime: {
      now, denylistSnapshot: EMPTY_DENYLIST_SNAPSHOT,
      redactionLedgerOptions: {
        retentionMs: 7 * 24 * 60 * 60_000, maxEntries: 1, maxBytes: 1024 * 1024, env: {},
      },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    },
  })).rejects.toMatchObject({ code: 'redaction_subsystem_unhealthy' });
  expect(fetchCalls).toBe(0);

  state.redactionBlockLedger = [];
  const writes = [];
  await prepareTranscriptRedactionLedgerState(state, {
    now,
    redactionLedgerOptions: {
      retentionMs: 7 * 24 * 60 * 60_000, maxEntries: 1, maxBytes: 1024 * 1024, env: {},
    },
    writeState: async (nextState) => writes.push(structuredClone(nextState)),
  });
  expect(state.redactionLedgerUnhealthy).toBe(false);
  expect(writes).toHaveLength(1);
  expect(writes[0].redactionLedgerUnhealthy).toBe(false);
  expect(fetchCalls).toBe(0);
});

test('unrelated transport failures do not accelerate permanent redaction blocking', async () => {
  const secret = 'synthetic-task4-independent-redaction-counter';
  const transcriptFile = await makeTranscriptFile('task4-counter.jsonl', `{"message":"${secret}"`);
  const relativePath = 'project/task4-counter.jsonl';
  const key = canonicalTranscriptOffsetKey('codex', relativePath);
  const state = makeState();
  state.transcriptPushFailures[key] = {
    status: 503,
    code: 'upstream_5xx',
    consecutiveFailures: 99,
    mode: 'backoff',
    cooldownUntil: new Date(0).toISOString(),
  };

  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task4-counter.jsonl', relative_path: relativePath,
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state,
    runtime: {
      now: 1_000,
      denylistSnapshot: {
        ...EMPTY_DENYLIST_SNAPSHOT,
        state: 'loaded', values: new Set([secret]), sourceMap: new Map([[secret, 'denylist']]),
      },
      logErrorFn: () => {},
    },
  });

  expect(result.nextState.transcriptPushFailures[key]).toMatchObject({
    code: 'redaction_failed', consecutiveFailures: 1, redactionConsecutiveFailures: 1,
    mode: 'backoff',
  });
});

test('transport backoff restarts after a redaction block is safely revalidated', async () => {
  const transcriptFile = await makeTranscriptFile('task4-transport-after-redaction.jsonl', '{"ok":true}\n');
  const relativePath = 'project/task4-transport-after-redaction.jsonl';
  const key = canonicalTranscriptOffsetKey('codex', relativePath);
  const state = makeState();
  const stat = await fsp.stat(transcriptFile);
  state.transcriptPushFailures[key] = {
    status: 422, code: 'redaction_failed', consecutiveFailures: 9,
    redactionConsecutiveFailures: 9, mode: 'permanent', cooldownUntil: null,
    denylistManagerGeneration: 'older-manager', denylistAdditionRevision: 0,
    sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs,
  };

  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task4-transport-after-redaction.jsonl',
    relative_path: relativePath,
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state,
    runtime: {
      now: 1_000,
      denylistSnapshot: {
        ...EMPTY_DENYLIST_SNAPSHOT, managerGeneration: 'current-manager', additionRevision: 0,
      },
      transientFailureConfig: { baseMs: 10, capMs: 100, quarantineAfter: 3, quarantineRetryMs: 1_000 },
      fetchImpl: async () => new Response('temporary', { status: 503 }),
      logErrorFn: () => {},
    },
  });

  expect(result.nextState.transcriptPushFailures[key]).toMatchObject({
    code: 'upstream_5xx', consecutiveFailures: 1, mode: 'backoff', retryAfterMs: 10,
  });
});

test('redaction failures remain permanent until the same manager observes a denylist addition', async () => {
  const transcriptFile = await makeTranscriptFile('task4-permanent.jsonl', '{"ok":true}\n');
  const transcript = {
    cli: 'codex', path: transcriptFile, filename: 'task4-permanent.jsonl',
    relative_path: 'project/task4-permanent.jsonl',
  };
  const key = canonicalTranscriptOffsetKey('codex', transcript.relative_path);
  let state = makeState();
  let redactorCalls = 0;
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await syncDiscoveredTranscripts([transcript], {
      defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
      serverUrl: 'https://example.com', state,
      runtime: {
        now: 1_000 + attempt * 10,
        redactionBlockRetries: 3,
        transientFailureConfig: { baseMs: 1, capMs: 1, quarantineAfter: 99, quarantineRetryMs: 1 },
        denylistSnapshot: { ...EMPTY_DENYLIST_SNAPSHOT, revision: 7 },
        redactContentImpl: () => {
          redactorCalls += 1;
          return { blocked: true, blockReason: 'synthetic_block', replacements: 0, heuristicHits: 1 };
        },
        fetchImpl: async () => { throw new Error('must not fetch'); },
        logErrorFn: (message) => errors.push(message),
      },
    });
    state = result.nextState;
  }

  expect(state.transcriptPushFailures[key]).toMatchObject({
    code: 'redaction_failed', mode: 'permanent', consecutiveFailures: 3, denylistRevision: 7,
    denylistManagerGeneration: 'test-manager', denylistAdditionRevision: 0,
    denylistSourceValueCount: 0,
  });
  expect(state.transcriptPushFailures[key].sourceSize).toBeGreaterThan(0);
  expect(state.transcriptPushFailures[key].sourceMtimeMs).toBeGreaterThan(0);
  expect(errors.filter((message) => message.includes('permanently blocked'))).toHaveLength(1);
  expect(errors.join('\n')).toContain('add denylist coverage or repair the native source');
  expect(errors.join('\n')).not.toContain('mitigate-remote-copy');

  const stillBlocked = await syncDiscoveredTranscripts([transcript], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state,
    runtime: {
      now: 2_000,
      denylistSnapshot: { ...EMPTY_DENYLIST_SNAPSHOT, revision: 8 },
      redactContentImpl: () => { redactorCalls += 1; throw new Error('must stay blocked'); },
    },
  });
  expect(stillBlocked.skippedBackoff).toBe(1);
  expect(redactorCalls).toBe(3);

  const afterRestart = await syncDiscoveredTranscripts([transcript], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: stillBlocked.nextState,
    runtime: {
      now: 2_500,
      denylistSnapshot: {
        ...EMPTY_DENYLIST_SNAPSHOT, revision: 1, managerGeneration: 'replacement-manager', additionRevision: 0,
      },
      redactContentImpl: () => {
        redactorCalls += 1;
        return { blocked: true, blockReason: 'still_unsafe', replacements: 0, heuristicHits: 1 };
      },
      logErrorFn: () => {},
    },
  });
  expect(afterRestart.skippedBackoff).toBe(0);
  expect(redactorCalls).toBe(4);
  expect(afterRestart.nextState.transcriptPushFailures[key]).toMatchObject({
    code: 'redaction_failed', mode: 'permanent',
    denylistManagerGeneration: 'replacement-manager', denylistAdditionRevision: 0,
  });

  let fetchCalls = 0;
  const recovered = await syncDiscoveredTranscripts([transcript], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: afterRestart.nextState,
    runtime: {
      now: 3_000,
      denylistSnapshot: { ...EMPTY_DENYLIST_SNAPSHOT, revision: 9, additionRevision: 1 },
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        const payload = JSON.parse(init.body);
        return makeBatchSuccessResponse('brain-1', 'machine-1', payload.files);
      },
    },
  });
  expect(fetchCalls).toBe(1);
  expect(recovered.nextState.transcriptPushFailures[key]).toBeUndefined();
});

test('editing a permanently blocked source causes a fresh redaction attempt', async () => {
  const transcriptFile = await makeTranscriptFile('task4-edited-permanent.jsonl', '{"blocked":true}\n');
  const transcript = {
    cli: 'codex', path: transcriptFile, filename: 'task4-edited-permanent.jsonl',
    relative_path: 'project/task4-edited-permanent.jsonl',
  };
  const key = canonicalTranscriptOffsetKey('codex', transcript.relative_path);
  const before = await fsp.stat(transcriptFile);
  const state = makeState();
  state.transcriptPushFailures[key] = {
    code: 'redaction_failed', mode: 'permanent', consecutiveFailures: 3,
    failedAt: new Date(before.mtimeMs).toISOString(), sourceSize: before.size,
    sourceMtimeMs: before.mtimeMs, denylistManagerGeneration: 'test-manager',
    denylistAdditionRevision: 0,
  };
  await fsp.writeFile(transcriptFile, '{"safe":true,"edited":true}\n');

  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts([transcript], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state,
    runtime: {
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        const payload = JSON.parse(init.body);
        return makeBatchSuccessResponse('brain-1', 'machine-1', payload.files);
      },
    },
  });
  expect(fetchCalls).toBe(1);
  expect(result.nextState.transcriptPushFailures[key]).toBeUndefined();
});

test('AGENTBOOTUP_REDACT_DISABLE blocks all transcript pushes', async () => {
  const transcriptFile = await makeTranscriptFile('task4-disabled.jsonl');
  let fetchCalls = 0;
  await expect(syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task4-disabled.jsonl',
    relative_path: 'project/task4-disabled.jsonl',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      env: { AGENTBOOTUP_REDACT_DISABLE: '1' },
      denylistSnapshot: { state: 'failed', errorCode: 'redaction_denylist_load_failed' },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    },
  })).rejects.toThrow('raw transcript pushes remain blocked');
  expect(fetchCalls).toBe(0);
});

test('a denylist reload after queueing aborts the cycle before fetch', async () => {
  const transcriptFile = await makeTranscriptFile('task3-live-denylist-failure.jsonl');
  let fetchCalls = 0;
  let guardCalls = 0;
  await expect(syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task3-live-denylist-failure.jsonl',
    relative_path: 'project/task3-live-denylist-failure.jsonl',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      isDenylistSnapshotCurrent: () => { guardCalls += 1; return false; },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    },
  })).rejects.toThrow('denylist changed after payload preparation');
  expect(guardCalls).toBe(1);
  expect(fetchCalls).toBe(0);
});

test('accepted batch offsets are checkpointed before a later denylist revision abort', async () => {
  const alphaFile = await makeTranscriptFile('task3-checkpoint-alpha.jsonl', '{"alpha":true}\n');
  const betaFile = await makeTranscriptFile('task3-checkpoint-beta.jsonl', '{"beta":true}\n');
  const checkpoints = [];
  let guardCalls = 0;
  let fetchCalls = 0;

  await expect(syncDiscoveredTranscripts([
    { cli: 'codex', path: alphaFile, filename: 'task3-checkpoint-alpha.jsonl', relative_path: 'alpha/session.jsonl' },
    { cli: 'codex', path: betaFile, filename: 'task3-checkpoint-beta.jsonl', relative_path: 'beta/session.jsonl' },
  ], {
    machineId: 'machine-1', apiKey: 'synthetic-api-key', serverUrl: 'https://example.com',
    state: makeState(),
    runtime: {
      machineInfo: { hostname: 'test-host' },
      resolveBrainId: (transcript) => transcript.relative_path.startsWith('alpha/') ? 'alpha' : 'beta',
      isDenylistSnapshotCurrent: () => ++guardCalls === 1,
      checkpointState: async (nextState) => {
        checkpoints.push(structuredClone(nextState));
      },
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        const payload = JSON.parse(init.body);
        return makeBatchSuccessResponse(payload.brain_id, 'machine-1', payload.files);
      },
    },
  })).rejects.toThrow('denylist changed after payload preparation');

  expect(fetchCalls).toBe(1);
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0].offsets[canonicalTranscriptOffsetKey('codex', 'alpha/session.jsonl')])
    .toBe(Buffer.byteLength('{"alpha":true}\n'));
});

test('direct daemon root resolution preserves nested project scope and discovers its repository', () => {
  const root = path.join(path.sep, 'synthetic', 'repo');
  const nested = path.join(root, 'packages', 'worker');
  const existing = new Set([path.join(root, '.git')]);

  expect(resolveSingleProjectScope({}, nested, {
    existsSync: (candidate) => existing.has(candidate),
  })).toEqual({ projectRoot: nested, repositoryRoot: root });
  expect(resolveSingleProjectScope({
    AGENTBOOTUP_PROJECT_ROOT: '/explicit/project',
    AGENTBOOTUP_REPOSITORY_ROOT: '/explicit/repository',
  }, nested)).toEqual({
    projectRoot: path.resolve('/explicit/project'),
    repositoryRoot: path.resolve('/explicit/repository'),
  });
  expect(resolveSingleProjectScope({}, path.join(path.sep, 'non-git-project'), {
    existsSync: () => false,
  })).toEqual({
    projectRoot: path.join(path.sep, 'non-git-project'),
    repositoryRoot: path.join(path.sep, 'non-git-project'),
  });
});

test('network denylist roots include each selected project and its repository root', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-network-roots-'));
  createdDirs.push(fixture);
  const repo = path.join(fixture, 'network-repo');
  const alpha = path.join(repo, 'apps', 'alpha');
  const standalone = path.join(fixture, 'standalone');
  await fsp.mkdir(path.join(repo, '.git'), { recursive: true });
  await fsp.mkdir(alpha, { recursive: true });
  await fsp.mkdir(standalone, { recursive: true });

  expect(collectDenylistProjectRoots([
    { path: alpha },
    { path: standalone },
  ])).toEqual([alpha, repo, standalone]);
});

test('denylist roots include a linked worktree and its owner repository', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-worktree-roots-'));
  createdDirs.push(fixture);
  const owner = path.join(fixture, 'owner');
  const worktree = path.join(fixture, 'worktree');
  const gitDir = path.join(owner, '.git', 'worktrees', 'feature');
  await fsp.mkdir(gitDir, { recursive: true });
  await fsp.mkdir(worktree, { recursive: true });
  await fsp.writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  await fsp.writeFile(path.join(gitDir, 'commondir'), '../..\n');

  expect(collectDenylistProjectRoots([{ path: worktree }])).toEqual([worktree, owner]);
});

test('denylist root collection fails closed on corrupt linked-worktree metadata', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-corrupt-worktree-'));
  createdDirs.push(fixture);
  const worktree = path.join(fixture, 'worktree');
  await fsp.mkdir(worktree, { recursive: true });
  await fsp.writeFile(path.join(worktree, '.git'), 'not-a-gitdir-record\n');

  expect(() => collectDenylistProjectRoots([{ path: worktree }]))
    .toThrow('Git worktree metadata is invalid');
});

test('an accepted transcript checkpoint persists after watchdog cycle invalidation', async () => {
  let cycleCurrent = true;
  const writes = [];
  const acceptedState = {
    ...makeState(),
    offsets: { [canonicalTranscriptOffsetKey('codex', 'alpha/session.jsonl')]: 17 },
  };

  // Model the response boundary: the remote accepted the write, then the
  // watchdog invalidated the cycle before the checkpoint ran.
  cycleCurrent = false;
  await persistAcceptedTranscriptCheckpoint(acceptedState, async (state) => {
    writes.push(structuredClone(state));
  });

  expect(cycleCurrent).toBe(false);
  expect(writes).toEqual([acceptedState]);
});

test('a real manager blocking reload failure invalidates queued payloads before fetch', async () => {
  const fixturePath = await makeTranscriptFile('task3-blocking-reload.jsonl');
  const root = await fsp.realpath(path.dirname(fixturePath));
  const transcriptFile = path.join(root, path.basename(fixturePath));
  const explicitPath = path.join(root, 'redact-denylist');
  await fsp.writeFile(path.join(root, '.env'), 'TOKEN=synthetic-manager-env-secret\n', { mode: 0o600 });
  await fsp.writeFile(explicitPath, 'synthetic-manager-history-one\n', { mode: 0o600 });
  const manager = createDenylistManager({
    projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
    maxSourceValues: 2, manageProcessSignals: false,
  });
  let fetchCalls = 0;
  try {
    const queuedSnapshot = await manager.start();
    expect(manager.isSnapshotCurrent(queuedSnapshot)).toBe(true);
    await fsp.writeFile(
      explicitPath,
      'synthetic-manager-history-one\nsynthetic-manager-history-two\n',
      { mode: 0o600 },
    );
    const failedSnapshot = await manager.reload();
    expect(failedSnapshot).toMatchObject({
      state: 'failed',
      errorCode: 'redaction_denylist_overflow',
    });
    expect(manager.isSnapshotCurrent(queuedSnapshot)).toBe(false);

    await expect(syncDiscoveredTranscriptsImpl([{
      cli: 'codex', path: transcriptFile, filename: 'task3-blocking-reload.jsonl',
      relative_path: 'project/task3-blocking-reload.jsonl',
    }], {
      defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
      serverUrl: 'https://example.com', state: makeState(),
      runtime: {
        denylistSnapshot: queuedSnapshot,
        isDenylistSnapshotCurrent: (snapshot) => manager.isSnapshotCurrent(snapshot),
        fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
        logFn: () => {},
      },
    })).rejects.toThrow('denylist changed after payload preparation');
    expect(fetchCalls).toBe(0);
  } finally {
    manager.stop();
  }
});

test('denylist addition revision changes only when the running manager gains coverage', async () => {
  const fixturePath = await makeTranscriptFile('task4-addition-revision.jsonl');
  const root = await fsp.realpath(path.dirname(fixturePath));
  const explicitPath = path.join(root, 'task4-addition-denylist');
  await fsp.writeFile(explicitPath, 'synthetic-manager-history-one\n', { mode: 0o600 });
  const manager = createDenylistManager({
    projectRoots: [], filePath: explicitPath, environment: {}, agentbootupRoot: null,
    manageProcessSignals: false, managerGeneration: 'stable-test-manager',
  });
  try {
    const initial = await manager.start();
    const unchanged = await manager.reload();
    expect(unchanged.managerGeneration).toBe(initial.managerGeneration);
    expect(unchanged.additionRevision).toBe(initial.additionRevision);

    await fsp.writeFile(explicitPath, '# agentbootup-record-v1:not-a-valid-hash\n', { mode: 0o600 });
    const failed = await manager.reload();
    expect(failed.state).toBe('failed');

    await fsp.writeFile(
      explicitPath,
      'synthetic-manager-history-one\nsynthetic-manager-history-two\n',
      { mode: 0o600 },
    );
    const expanded = await manager.reload();
    expect(expanded.additionRevision).toBe(initial.additionRevision + 1);
  } finally {
    manager.stop();
  }
});

test('redaction expansion beyond the complete-file cap is quarantined before fetch', async () => {
  const transcriptFile = await makeTranscriptFile('task3-expanded-too-large.jsonl');
  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task3-expanded-too-large.jsonl',
    relative_path: 'project/task3-expanded-too-large.jsonl',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      redactContentImpl: () => ({
        cleanContent: 'x'.repeat(4 * 1024 * 1024 + 1),
        replacements: 1,
        heuristicHits: 0,
        blocked: false,
        blockReason: null,
      }),
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      logErrorFn: () => {},
    },
  });
  const key = canonicalTranscriptOffsetKey('codex', 'project/task3-expanded-too-large.jsonl');
  expect(result).toMatchObject({ pushCount: 0, errCount: 1, stateChanged: true });
  expect(result.nextState.transcriptPushFailures[key]).toMatchObject({
    code: 'legacy_file_too_large',
    mode: 'quarantined',
  });
  expect(fetchCalls).toBe(0);
});

test('drops a trailing partial JSONL line and advances only through the last newline', async () => {
  const complete = '{"phase":"complete"}\n';
  const partial = '{"token":"synthetic-trailing-partial-secret"';
  const transcriptFile = await makeTranscriptFile('task3-trailing-partial.jsonl', complete + partial);
  const baseNow = Date.parse('2026-07-31T12:00:00.000Z');
  let payload;
  let failOverwrite = false;
  const outboundContents = [];
  const transcripts = [{
    cli: 'codex', path: transcriptFile, filename: 'task3-trailing-partial.jsonl',
    relative_path: 'project/task3-trailing-partial.jsonl',
  }];
  const options = {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      now: baseNow,
      denylistSnapshot: {
        state: 'loaded', revision: 1,
        values: new Set(['synthetic-trailing-partial-secret']),
        sourceMap: new Map([['synthetic-trailing-partial-secret', 'env']]),
        derivedValues: new Set(), derivedSourceMap: new Map(),
      },
      fetchImpl: async (_url, init) => {
        payload = JSON.parse(init.body);
        outboundContents.push(Buffer.from(payload.files[0].content_base64, 'base64').toString('utf8'));
        if (failOverwrite) return new Response('synthetic overwrite failure', { status: 500 });
        return makeBatchSuccessResponse('brain-1', 'machine-1', payload.files);
      },
      logErrorFn: () => {},
    },
  };
  const roundTripState = async (state) => {
    const previousStateFile = process.env.AGENTBOOTUP_SYNC_STATE_FILE;
    process.env.AGENTBOOTUP_SYNC_STATE_FILE = path.join(path.dirname(transcriptFile), 'sync-state.json');
    try {
      await writeSyncState(state);
      return await readSyncState();
    } finally {
      if (previousStateFile === undefined) delete process.env.AGENTBOOTUP_SYNC_STATE_FILE;
      else process.env.AGENTBOOTUP_SYNC_STATE_FILE = previousStateFile;
    }
  };
  const result = await syncDiscoveredTranscripts(transcripts, options);
  expect(Buffer.from(payload.files[0].content_base64, 'base64').toString('utf8')).toBe(complete);
  expect(result.nextState.offsets[transcriptFile]).toBe(Buffer.byteLength(complete));
  expect(result.nextState.redactionPartialOffsets[
    canonicalTranscriptOffsetKey('codex', 'project/task3-trailing-partial.jsonl')
  ]).toMatchObject({
    offset: Buffer.byteLength(complete),
    observedSize: Buffer.byteLength(complete + partial),
  });
  expect(result.nextState.transcriptPushFailures).toEqual({});

  const unchangedResult = await syncDiscoveredTranscripts(transcripts, {
    ...options,
    state: await roundTripState(result.nextState),
  });
  expect(unchangedResult.pushCount).toBe(0);
  expect(unchangedResult.pendingFiles).toBe(1);
  expect(outboundContents).toHaveLength(1);

  await fsp.appendFile(transcriptFile, '-still-partial');
  const extendedPartialResult = await syncDiscoveredTranscripts(transcripts, {
    ...options,
    state: unchangedResult.nextState,
  });
  expect(extendedPartialResult.pushCount).toBe(0);
  expect(outboundContents).toHaveLength(1);
  expect(extendedPartialResult.nextState.redactionPartialOffsets[
    canonicalTranscriptOffsetKey('codex', 'project/task3-trailing-partial.jsonl')
  ]).toMatchObject({
    offset: Buffer.byteLength(complete),
    observedSize: Buffer.byteLength(complete + partial + '-still-partial'),
  });

  await fsp.writeFile(transcriptFile, '{}\n');
  failOverwrite = true;
  const restartedPartialState = await roundTripState(extendedPartialResult.nextState);
  const failedOverwrite = await syncDiscoveredTranscripts(transcripts, {
    ...options,
    state: restartedPartialState,
  });
  const partialKey = canonicalTranscriptOffsetKey('codex', 'project/task3-trailing-partial.jsonl');
  expect(failedOverwrite.pushCount).toBe(0);
  expect(failedOverwrite.nextState.redactionPartialOffsets[partialKey]).toMatchObject({
    offset: Buffer.byteLength(complete),
    observedSize: Buffer.byteLength(complete + partial + '-still-partial'),
  });

  await fsp.writeFile(
    transcriptFile,
    `${complete}{"token":"synthetic-trailing-partial-secret"}\n`,
  );
  failOverwrite = false;
  const restartedFailedState = await roundTripState(failedOverwrite.nextState);
  const completedResult = await syncDiscoveredTranscripts(transcripts, {
    ...options,
    state: restartedFailedState,
    runtime: { ...options.runtime, now: baseNow + 120_000 },
  });
  const completedContent = await fsp.readFile(transcriptFile, 'utf8');
  const completedOutbound = Buffer.from(payload.files[0].content_base64, 'base64').toString('utf8');
  expect(completedOutbound).toContain(complete);
  expect(completedOutbound).not.toContain('synthetic-trailing-partial-secret');
  expect(completedResult.nextState.offsets[transcriptFile]).toBe(Buffer.byteLength(completedContent));
  expect(completedResult.nextState.redactionPartialOffsets).toEqual({});
  expect(completedResult.nextState.transcriptPushFailures).toEqual({});
  expect(outboundContents).toHaveLength(3);
  expect(outboundContents.every((content) => !content.includes('synthetic-trailing-partial-secret'))).toBe(true);
});

test('defers an incomplete UTF-8 code point at the live file tail without quarantine', async () => {
  const transcriptFile = await makeTranscriptFile('task3-incomplete-utf8-tail.json', '');
  await fsp.writeFile(
    transcriptFile,
    Buffer.concat([Buffer.from('{"message":"live'), Buffer.from([0xf0, 0x9f])]),
  );
  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task3-incomplete-utf8-tail.json',
    relative_path: 'project/task3-incomplete-utf8-tail.json',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      logErrorFn: () => {},
    },
  });

  expect(fetchCalls).toBe(0);
  expect(result.pushCount).toBe(0);
  expect(result.nextState.transcriptPushFailures).toEqual({});
});

test('defers a structurally incomplete whole-JSON snapshot until the rewrite completes', async () => {
  const transcriptFile = await makeTranscriptFile('task3-incomplete-snapshot.json', '{"messages":[');
  const transcript = {
    cli: 'gemini', path: transcriptFile, filename: 'task3-incomplete-snapshot.json',
    relative_path: 'project/task3-incomplete-snapshot.json',
  };
  const payloads = [];
  const options = {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      fetchImpl: async (_url, init) => {
        const payload = JSON.parse(init.body);
        payloads.push(payload);
        return makeBatchSuccessResponse('brain-1', 'machine-1', payload.files);
      },
    },
  };

  const deferred = await syncDiscoveredTranscripts([transcript], options);
  expect(deferred.pushCount).toBe(0);
  expect(deferred.pendingFiles).toBe(1);
  expect(deferred.nextState.offsets).toEqual({});
  expect(payloads).toHaveLength(0);

  const complete = '{"messages":[]}';
  await fsp.writeFile(transcriptFile, complete);
  const completed = await syncDiscoveredTranscripts([transcript], {
    ...options,
    state: deferred.nextState,
  });
  expect(completed.pushCount).toBe(1);
  expect(completed.nextState.offsets[transcriptFile]).toBe(Buffer.byteLength(complete));
  expect(payloads).toHaveLength(1);
});

test('whole-JSON mid-write snapshots durably retry from zero after prior upload', async () => {
  const initial = '{"messages":[{"text":"initial"}]}';
  const transcriptFile = await makeTranscriptFile('task3-json-rewrite.json', initial);
  const transcript = {
    cli: 'gemini', path: transcriptFile, filename: 'task3-json-rewrite.json',
    relative_path: 'project/task3-json-rewrite.json',
  };
  const payloads = [];
  const options = {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      fetchImpl: async (_url, init) => {
        const payload = JSON.parse(init.body);
        payloads.push(payload);
        return makeBatchSuccessResponse('brain-1', 'machine-1', payload.files);
      },
    },
  };
  const uploaded = await syncDiscoveredTranscripts([transcript], options);

  const key = canonicalTranscriptOffsetKey('gemini', 'project/task3-json-rewrite.json');
  const midWriteSnapshots = [
    Buffer.alloc(0),
    Buffer.concat([Buffer.from('{"messages":[{"text":"'), Buffer.from([0xf0, 0x9f])]),
    Buffer.from('{"messages":['),
    Buffer.from(`{"messages":[${'x'.repeat(Buffer.byteLength(initial) + 50)}`),
    Buffer.from('{'.padEnd(Buffer.byteLength(initial), ' ')),
  ];
  for (const [index, snapshot] of midWriteSnapshots.entries()) {
    await fsp.writeFile(transcriptFile, snapshot);
    const observedAt = new Date(Date.now() + (index + 1) * 10_000);
    await fsp.utimes(transcriptFile, observedAt, observedAt);
    const cycleState = structuredClone(uploaded.nextState);
    if (index === 0) {
      cycleState.transcriptPushFailures[key] = {
        status: 502,
        code: 'upstream_5xx',
        message: 'stale failure from prior snapshot',
        failedAt: '2000-01-01T00:00:00.000Z',
        cooldownUntil: '2099-01-01T00:00:00.000Z',
        consecutiveFailures: 3,
        mode: 'quarantined',
      };
    }
    const deferred = await syncDiscoveredTranscripts([transcript], {
      ...options,
      state: cycleState,
    });
    expect(deferred.pushCount).toBe(0);
    expect(deferred.nextState.redactionPartialOffsets[key]).toMatchObject({
      kind: 'json-rewrite',
      offset: Buffer.byteLength(initial),
    });
    expect(deferred.pendingFiles).toBe(1);
    expect(deferred.nextState.transcriptPushFailures[key]).toBeUndefined();

    const replacement = JSON.stringify({
      messages: [{ text: `replacement ${index} that is longer than the initial snapshot` }],
    });
    await fsp.writeFile(transcriptFile, replacement);
    const completed = await syncDiscoveredTranscripts([transcript], {
      ...options,
      state: deferred.nextState,
    });
    expect(completed.pushCount).toBe(1);
    expect(completed.nextState.offsets[transcriptFile]).toBe(Buffer.byteLength(replacement));
    expect(completed.nextState.redactionPartialOffsets[key]).toMatchObject({
      kind: 'json-snapshot',
      offset: Buffer.byteLength(replacement),
    });
    expect(Buffer.from(payloads.at(-1).files[0].content_base64, 'base64').toString('utf8'))
      .toBe(replacement);
  }
});

test('blocks a lone malformed secret-bearing JSONL line instead of silently deferring it', async () => {
  const secret = 'synthetic-unterminated-line-secret';
  const transcriptFile = await makeTranscriptFile('task3-lone-partial.jsonl', `{"token":"${secret}"`);
  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task3-lone-partial.jsonl',
    relative_path: 'project/task3-lone-partial.jsonl',
  }], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      denylistSnapshot: {
        state: 'loaded', revision: 1, values: new Set([secret]),
        sourceMap: new Map([[secret, 'env']]), derivedValues: new Set(), derivedSourceMap: new Map(),
      },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      logErrorFn: () => {},
    },
  });
  const key = canonicalTranscriptOffsetKey('codex', 'project/task3-lone-partial.jsonl');
  expect(result.nextState.offsets[transcriptFile]).toBeUndefined();
  expect(result.nextState.transcriptPushFailures[key]).toMatchObject({
    code: 'redaction_failed',
  });
  expect(fetchCalls).toBe(0);
});

test('defers a valid lone JSONL record until its trailing newline arrives', async () => {
  const content = '{"message":"complete-value"}';
  const transcriptFile = await makeTranscriptFile('task3-lone-valid.jsonl', content);
  const transcript = {
    cli: 'codex', path: transcriptFile, filename: 'task3-lone-valid.jsonl',
    relative_path: 'project/task3-lone-valid.jsonl',
  };
  const payloads = [];
  const options = {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state: makeState(),
    runtime: {
      fetchImpl: async (_url, init) => {
        const payload = JSON.parse(init.body);
        payloads.push(payload);
        return makeBatchSuccessResponse('brain-1', 'machine-1', payload.files);
      },
    },
  };

  const deferred = await syncDiscoveredTranscripts([transcript], options);
  expect(deferred.pushCount).toBe(0);
  expect(deferred.pendingFiles).toBe(1);
  expect(deferred.nextState.offsets).toEqual({});
  expect(payloads).toHaveLength(0);

  await fsp.appendFile(transcriptFile, '\n');
  const completed = await syncDiscoveredTranscripts([transcript], {
    ...options,
    state: deferred.nextState,
  });
  expect(completed.pushCount).toBe(1);
  expect(completed.nextState.offsets[transcriptFile]).toBe(Buffer.byteLength(`${content}\n`));
  expect(payloads).toHaveLength(1);
});

test('single-project routing never falls back to the default brain for an unmatched transcript', async () => {
  const transcriptFile = await makeTranscriptFile(
    'task3-unmatched-single-project.jsonl',
    '{"type":"session_meta","payload":{"cwd":"/synthetic/unrelated-project"}}\n',
  );
  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts([{
    cli: 'codex', path: transcriptFile, filename: 'task3-unmatched-single-project.jsonl',
    relative_path: '2026/07/31/rollout-2026-07-31T00-00-00-00000000-0000-0000-0000-000000000000.jsonl',
  }], {
    defaultBrainId: 'brain-1',
    projectIndex: buildTranscriptProjectIndex([{
      id: 'brain-1', agent_id: 'brain-1', path: '/synthetic/expected-project',
    }]),
    machineId: 'machine-1', apiKey: 'synthetic-api-key', serverUrl: 'https://example.com',
    state: makeState(),
    runtime: {
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      logFn: () => {},
    },
  });
  expect(result.unmappedFiles).toBe(1);
  expect(result.pushCount).toBe(0);
  expect(fetchCalls).toBe(0);
});

test('prunes redaction partial-offset markers when the transcript disappears', async () => {
  const key = canonicalTranscriptOffsetKey('codex', 'project/disappeared.jsonl');
  const state = makeState();
  state.offsets[key] = 17;
  state.redactionPartialOffsets = { [key]: 17 };
  const result = await syncDiscoveredTranscripts([], {
    defaultBrainId: 'brain-1', machineId: 'machine-1', apiKey: 'synthetic-api-key',
    serverUrl: 'https://example.com', state,
  });
  expect(result.nextState.offsets).toEqual({});
  expect(result.nextState.redactionPartialOffsets).toEqual({});
  expect(result.stateChanged).toBe(true);
});

test('transcript health separates live process from blocked legacy backup authority', () => {
  const payload = buildTranscriptHealthPayload({
    startedAt: '2026-07-19T12:00:00.000Z',
    pendingFiles: 0,
    durabilityBlocked: true,
  }, 42, { now: Date.parse('2026-07-19T12:01:00.000Z') });

  expect(payload.liveness).toEqual({ healthy: true, uptime: 42 });
  expect(payload.healthy).toBe(false);
  expect(payload.backup).toMatchObject({ healthy: false, state: 'blocked_durability' });
});

test('transcript health reports redaction policy blocks without fabricating a remote outage', () => {
  const payload = buildTranscriptHealthPayload({
    startedAt: '2026-07-19T12:00:00.000Z',
    pendingFiles: 0,
    durabilityBlocked: false,
    consecutiveFailedCycles: 0,
    lastRemoteErrorAt: null,
    redaction: {
      enabled: false,
      redaction_disabled: true,
      redaction_subsystem_unhealthy: false,
      redaction_blocked_permanent: false,
      denylist_size: 2,
      blocked_files: [{ path: 'transcript:codex:project/session.jsonl', code: 'redaction_failed' }],
      block_ledger: [{
        at: '2026-07-19T12:00:00.000Z', file: 'transcript:codex:project/session.jsonl',
        cli: 'codex', code: 'redaction_failed', permanent: false,
      }],
      total_replacements: 4,
    },
  }, 42);

  expect(payload.healthy).toBe(false);
  expect(payload.backup).toMatchObject({
    healthy: false,
    state: 'blocked_redaction',
    reasons: ['redaction_disabled'],
  });
  expect(payload.redaction.blocked_files).toBeArray();
  expect(payload.redaction.block_ledger).toHaveLength(1);
});

test('redaction failures do not create remote-outage counters', () => {
  const result = applyTranscriptCycleHealthStats({}, {
    pushCount: 0,
    errCount: 1,
    redactionErrCount: 1,
    redactionFailureCount: 1,
    activeFailureCount: 1,
    skippedBackoff: 1,
    skippedQuarantined: 0,
    pendingFiles: 1,
  }, '2026-07-19T12:01:00.000Z');

  expect(result).toMatchObject({
    consecutiveFailedCycles: 0,
    lastRemoteErrorAt: null,
    activeFailureCount: 1,
  });
  expect(assessTranscriptBackupHealth({
    ...result,
    durabilityBlocked: false,
    redaction: { blocked_files: [{ path: 'transcript:codex:test.jsonl', code: 'redaction_failed' }] },
  })).toMatchObject({
    state: 'blocked_redaction', reasons: ['redaction_failed'],
  });
});

test('transcript backup health degrades stale backlog, remote errors, and repeated deadlines', () => {
  const now = Date.parse('2026-07-19T12:30:00.000Z');
  expect(assessTranscriptBackupHealth({
    pendingFiles: 3,
    lastSuccessfulProgressAt: '2026-07-19T12:00:00.000Z',
    durabilityBlocked: false,
  }, { now, staleProgressMs: 60_000 })).toMatchObject({
    healthy: false, state: 'working_backlog', reasons: ['stale_progress'],
  });
  expect(assessTranscriptBackupHealth({
    consecutiveFailedCycles: 2,
    durabilityBlocked: false,
  }, { now })).toMatchObject({ healthy: false, state: 'degraded_remote' });
  expect(assessTranscriptBackupHealth({
    consecutiveDeadlineOverruns: 2,
    durabilityBlocked: false,
  }, { now, deadlineFailureThreshold: 2 })).toMatchObject({ healthy: false, state: 'error' });
  expect(assessTranscriptBackupHealth({
    pendingFiles: 1,
    lastSuccessfulProgressAt: '2026-07-19T12:29:30.000Z',
    oldestPendingAt: '2026-07-18T12:00:00.000Z',
    durabilityBlocked: false,
  }, { now, staleProgressMs: 60_000, maxBacklogAgeMs: 60_000 })).toMatchObject({
    healthy: false, state: 'working_backlog', reasons: ['backlog_age_exceeded'],
  });
});

test('transcript cycle health preserves remote degradation while failed files remain pending', () => {
  const previous = {
    consecutiveFailedCycles: 1,
    lastRemoteErrorAt: '2026-07-19T12:00:00.000Z',
    lastSuccessfulProgressAt: null,
  };
  const afterSkip = applyTranscriptCycleHealthStats(previous, {
    pushCount: 0,
    errCount: 0,
    skippedBackoff: 1,
    skippedQuarantined: 0,
    pendingFiles: 1,
    activeFailureCount: 1,
  }, '2026-07-19T12:01:00.000Z');

  expect(afterSkip).toMatchObject({
    consecutiveFailedCycles: 1,
    lastRemoteErrorAt: '2026-07-19T12:00:00.000Z',
    pendingFiles: 1,
    activeFailureCount: 1,
  });
  expect(assessTranscriptBackupHealth({ ...afterSkip, durabilityBlocked: false })).toMatchObject({
    healthy: false,
    state: 'degraded_remote',
  });

  const afterRecovery = applyTranscriptCycleHealthStats(afterSkip, {
    pushCount: 1,
    errCount: 0,
    skippedBackoff: 0,
    skippedQuarantined: 0,
    pendingFiles: 0,
    activeFailureCount: 0,
  }, '2026-07-19T12:02:00.000Z');
  expect(afterRecovery).toMatchObject({
    consecutiveFailedCycles: 0,
    lastRemoteErrorAt: null,
    activeFailureCount: 0,
    lastSuccessfulProgressAt: '2026-07-19T12:02:00.000Z',
  });
});

test('legacy containment reports blocked durability without a false remote outage', () => {
  const completedAt = '2026-07-19T12:01:00.000Z';
  const result = applyTranscriptCycleHealthStats({}, {
    pushCount: 0,
    errCount: 1,
    containmentErrCount: 1,
    containmentFailureCount: 1,
    skippedBackoff: 1,
    skippedQuarantined: 0,
    pendingFiles: 1,
    activeFailureCount: 0,
  }, completedAt);

  expect(result).toMatchObject({
    consecutiveFailedCycles: 0,
    lastRemoteErrorAt: null,
    activeFailureCount: 0,
  });
  expect(assessTranscriptBackupHealth({
    ...result,
    oldestPendingAt: '2026-07-18T12:00:00.000Z',
    durabilityBlocked: true,
  }, {
    now: Date.parse('2026-07-19T12:30:00.000Z'),
    staleProgressMs: 1,
    maxBacklogAgeMs: 1,
  })).toMatchObject({
    healthy: false,
    state: 'blocked_durability',
    reasons: ['legacy_v1_has_no_archive_durability'],
  });
});

test('historical containment never masks a new remote failure', () => {
  const result = applyTranscriptCycleHealthStats({}, {
    pushCount: 0,
    errCount: 1,
    containmentErrCount: 0,
    containmentFailureCount: 1,
    skippedBackoff: 1,
    skippedQuarantined: 0,
    pendingFiles: 2,
    activeFailureCount: 1,
  }, '2026-07-19T12:01:00.000Z');

  expect(result).toMatchObject({
    consecutiveFailedCycles: 1,
    lastRemoteErrorAt: '2026-07-19T12:01:00.000Z',
    containmentFailureCount: 1,
  });
  expect(assessTranscriptBackupHealth({ ...result, durabilityBlocked: true })).toMatchObject({
    healthy: false,
    state: 'degraded_remote',
  });
});

test('Phase-0 durability warning does not hide an ordinary stale upload backlog', () => {
  expect(assessTranscriptBackupHealth({
    pendingFiles: 1,
    containmentFailureCount: 0,
    lastSuccessfulProgressAt: '2026-07-19T12:00:00.000Z',
    durabilityBlocked: true,
  }, {
    now: Date.parse('2026-07-19T12:30:00.000Z'),
    staleProgressMs: 60_000,
  })).toMatchObject({
    healthy: false,
    state: 'working_backlog',
    reasons: ['stale_progress'],
  });
});

test('watchdog fences late completion and retains cycle ownership until work settles', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let starts = 0;
  let publishedSuccesses = 0;
  const watchdogStats = {
    consecutiveDeadlineOverruns: 0,
    consecutiveFailedCycles: 0,
    lastRemoteErrorAt: null,
  };
  const execute = async (_brain, _projects, _machine, _key, _url, cycle) => {
    starts += 1;
    if (starts === 1) await firstGate;
    if (cycle.isCurrent()) {
      publishedSuccesses += 1;
      watchdogStats.consecutiveDeadlineOverruns = 0;
      watchdogStats.consecutiveFailedCycles = 0;
      watchdogStats.lastRemoteErrorAt = null;
    }
  };
  const runtime = {
    timeoutMs: 5,
    statsTarget: watchdogStats,
    execute,
    nowIso: () => '2026-07-19T12:00:00.000Z',
    logFn: () => {},
    logErrorFn: () => {},
  };

  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', runtime);
  expect(watchdogStats).toMatchObject({
    consecutiveDeadlineOverruns: 1,
    consecutiveFailedCycles: 1,
    lastRemoteErrorAt: '2026-07-19T12:00:00.000Z',
  });

  // The watchdog settles callers promptly, but a second trigger must not start
  // another cycle while the invalidated operation is still winding down.
  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', runtime);
  expect(starts).toBe(1);

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(publishedSuccesses).toBe(0);
  expect(watchdogStats.consecutiveDeadlineOverruns).toBe(1);
  expect(watchdogStats.consecutiveFailedCycles).toBe(1);

  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', {
    ...runtime,
    timeoutMs: 50,
  });
  expect(starts).toBe(2);
  expect(publishedSuccesses).toBe(1);
});

test('watchdog releases ownership after cancellation grace when work never settles', async () => {
  let starts = 0;
  const logs = [];
  const runtime = {
    timeoutMs: 5,
    hardReleaseGraceMs: 5,
    statsTarget: {
      consecutiveDeadlineOverruns: 0,
      consecutiveFailedCycles: 0,
      lastRemoteErrorAt: null,
    },
    execute: async () => {
      starts += 1;
      if (starts === 1) await new Promise(() => {});
    },
    nowIso: () => '2026-07-19T12:00:00.000Z',
    logFn: (message) => logs.push(message),
    logErrorFn: () => {},
  };

  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', runtime);
  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', runtime);
  expect(starts).toBe(1);

  await new Promise((resolve) => setTimeout(resolve, 15));
  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', {
    ...runtime,
    timeoutMs: 50,
  });

  expect(starts).toBe(2);
  expect(logs.some((message) => message.includes('released wedged cycle'))).toBe(true);
});

test('watchdog never hard-releases ownership while a remote write is in flight', async () => {
  let starts = 0;
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let releaseLocalWork;
  const localWorkGate = new Promise((resolve) => { releaseLocalWork = resolve; });
  const logs = [];
  const runtime = {
    timeoutMs: 5,
    hardReleaseGraceMs: 5,
    remoteWriteMaxRetentionMs: 100,
    statsTarget: {
      consecutiveDeadlineOverruns: 0,
      consecutiveFailedCycles: 0,
      lastRemoteErrorAt: null,
    },
    execute: async (_brain, _projects, _machine, _key, _url, cycle) => {
      starts += 1;
      if (starts > 1) return;
      expect(cycle.beginRemoteWrite()).toBe(true);
      await writeGate;
      cycle.endRemoteWrite();
      await localWorkGate;
    },
    nowIso: () => '2026-07-19T12:00:00.000Z',
    logFn: (message) => logs.push(message),
    logErrorFn: () => {},
  };

  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', runtime);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', runtime);

  expect(starts).toBe(1);
  expect(logs.some((message) => message.includes('remote write(s) still in flight'))).toBe(true);
  releaseWrite();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', {
    ...runtime,
    timeoutMs: 50,
  });
  expect(starts).toBe(2);
  expect(logs.some((message) => message.includes('released wedged cycle'))).toBe(true);
  releaseLocalWork();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('watchdog requests supervised restart instead of overlapping a permanently wedged remote write', async () => {
  let starts = 0;
  let terminateCalls = 0;
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const runtime = {
    timeoutMs: 5,
    hardReleaseGraceMs: 5,
    remoteWriteMaxRetentionMs: 10,
    statsTarget: {
      consecutiveDeadlineOverruns: 0,
      consecutiveFailedCycles: 0,
      lastRemoteErrorAt: null,
    },
    execute: async (_brain, _projects, _machine, _key, _url, cycle) => {
      starts += 1;
      expect(cycle.beginRemoteWrite()).toBe(true);
      await writeGate;
      cycle.endRemoteWrite();
    },
    onWedgedRemoteWrite: () => { terminateCalls += 1; },
    nowIso: () => '2026-07-19T12:00:00.000Z',
    logFn: () => {},
    logErrorFn: () => {},
  };

  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', runtime);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', runtime);

  expect(terminateCalls).toBeGreaterThanOrEqual(1);
  expect(starts).toBe(1);
  releaseWrite();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('transcript watchdog timeout accepts only positive finite overrides', () => {
  expect(getSyncOverallTimeoutMs({ timeoutMs: 7 })).toBe(7);
  expect(getSyncOverallTimeoutMs({ timeoutMs: 0 })).toBe(600_000);
  expect(getSyncOverallTimeoutMs({ timeoutMs: -1 })).toBe(600_000);
  expect(getSyncOverallTimeoutMs({ timeoutMs: Number.NaN })).toBe(600_000);
});

test('transcript watchdog hard-release grace is configurable and bounded', () => {
  expect(getSyncHardReleaseGraceMs({ hardReleaseGraceMs: 7 }, 100)).toBe(7);
  expect(getSyncHardReleaseGraceMs({ env: {
    AGENTBOOTUP_TRANSCRIPT_WATCHDOG_RELEASE_GRACE_MS: '11',
  } }, 100)).toBe(11);
  expect(getSyncHardReleaseGraceMs({ hardReleaseGraceMs: -1, env: {} }, 100)).toBe(100);
});

test('transcript watchdog remote-write retention is configurable and positive', () => {
  expect(getSyncRemoteWriteMaxRetentionMs({ remoteWriteMaxRetentionMs: 11 }, 100)).toBe(11);
  expect(getSyncRemoteWriteMaxRetentionMs({ env: {
    AGENTBOOTUP_TRANSCRIPT_WATCHDOG_REMOTE_WRITE_MAX_RETENTION_MS: '13',
  } }, 100)).toBe(13);
  expect(getSyncRemoteWriteMaxRetentionMs({ remoteWriteMaxRetentionMs: 0, env: {} }, 100)).toBe(300);
});

test('remote-write retention shorter than release grace is enforced first', async () => {
  let restartRequests = 0;
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  await syncPendingFiles('brain', null, 'machine', 'key', 'https://example.com', {
    timeoutMs: 5,
    hardReleaseGraceMs: 50,
    remoteWriteMaxRetentionMs: 5,
    statsTarget: {
      consecutiveDeadlineOverruns: 0,
      consecutiveFailedCycles: 0,
      lastRemoteErrorAt: null,
    },
    execute: async (_brain, _projects, _machine, _key, _url, cycle) => {
      cycle.beginRemoteWrite();
      await writeGate;
      cycle.endRemoteWrite();
    },
    onWedgedRemoteWrite: () => { restartRequests += 1; },
    nowIso: () => '2026-07-19T12:00:00.000Z',
    logFn: () => {}, logErrorFn: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  expect(restartRequests).toBeGreaterThanOrEqual(1);
  releaseWrite();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

class ContractBrainStore {
  constructor(ids = []) {
    this.brains = new Set(ids);
  }

  async get(id) {
    return this.brains.has(id) ? { id } : null;
  }

  async updateSyncInfo() {}
}

class ContractTranscriptStore {
  async upload(brainId, machineId, cli, filename, content) {
    return { key: `transcripts/${brainId}/${machineId}/${cli}/${filename}`, status: 'pushed' };
  }

  async appendChunk(brainId, machineId, cli, filename, chunk, _byteOffset, isFinal) {
    return {
      key: `transcripts/${brainId}/${machineId}/${cli}/${filename}`,
      status: isFinal ? 'pushed' : 'appended',
    };
  }
}

test('scopeTranscriptProjects keeps only explicitly scoped project ids', () => {
  const projects = [
    { id: 'alpha', path: '/tmp/alpha' },
    { id: 'beta', path: '/tmp/beta' },
    { id: 'gamma', path: '/tmp/gamma' },
  ];

  expect(scopeTranscriptProjects(projects, ['alpha', 'gamma'])).toEqual([
    { id: 'alpha', path: '/tmp/alpha' },
    { id: 'gamma', path: '/tmp/gamma' },
  ]);
});

test('scopeTranscriptProjects returns all projects when no scope is set', () => {
  const projects = [
    { id: 'alpha', path: '/tmp/alpha' },
    { id: 'beta', path: '/tmp/beta' },
  ];

  expect(scopeTranscriptProjects(projects, null)).toEqual(projects);
  expect(scopeTranscriptProjects(projects, [])).toEqual(projects);
});

test('getUnknownScopedTranscriptProjectIds reports partial unknown ids', () => {
  const projects = [
    { id: 'alpha', path: '/tmp/alpha' },
    { id: 'beta', path: '/tmp/beta' },
  ];

  expect(getUnknownScopedTranscriptProjectIds(projects, ['alpha', 'gamma'])).toEqual(['gamma']);
  expect(getUnknownScopedTranscriptProjectIds(projects, ['alpha', 'beta'])).toEqual([]);
});

test('syncDiscoveredTranscripts quarantines 404 brains without blocking healthy brains', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json');
  const betaFile = await makeTranscriptFile('beta.json');
  const requests = [];

  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'gemini', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.json' },
      { cli: 'gemini', path: betaFile, filename: 'beta.json', relative_path: 'beta/session.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        now: Date.parse('2026-04-27T07:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: (transcript) => (transcript.path === alphaFile ? 'alpha' : 'beta'),
        fetchImpl: async (_url, init) => {
          const payload = JSON.parse(init.body);
          requests.push(payload.brain_id);
          if (payload.brain_id === 'alpha') {
            return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing brain' } }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            });
          }
          return makeBatchSuccessResponse(payload.brain_id, payload.machine_id, payload.files);
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(requests).toEqual(['alpha', 'beta']);
  expect(result.pushCount).toBe(1);
  expect(result.errCount).toBe(1);
  expect(result.quarantinedBrains.alpha.code).toBe('not_found');
  expect(result.nextState.offsets[betaFile]).toBe(fs.statSync(betaFile).size);
  expect(result.nextState.offsets[alphaFile]).toBeUndefined();
});

test('syncDiscoveredTranscripts includes top-level cli in batched push payloads', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json');
  const requests = [];

  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'gemini', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        now: Date.parse('2026-04-27T07:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async (_url, init) => {
          const payload = JSON.parse(init.body);
          requests.push(payload);
          return makeBatchSuccessResponse(payload.brain_id, payload.machine_id, payload.files);
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(result.pushCount).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0].cli).toBe('gemini');
  expect(requests[0].files[0].cli).toBe('gemini');
});

test('syncDiscoveredTranscripts batches same-brain transcripts separately per cli', async () => {
  const alphaClaudeFile = await makeTranscriptFile('alpha-claude.json');
  const alphaCodexFile = await makeTranscriptFile('alpha-codex.json');
  const requests = [];

  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'claude', path: alphaClaudeFile, filename: 'alpha-claude.json', relative_path: 'alpha/claude.json' },
      { cli: 'codex', path: alphaCodexFile, filename: 'alpha-codex.json', relative_path: 'alpha/codex.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        now: Date.parse('2026-04-27T07:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async (_url, init) => {
          const payload = JSON.parse(init.body);
          requests.push(payload);
          return makeBatchSuccessResponse(payload.brain_id, payload.machine_id, payload.files);
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(result.pushCount).toBe(2);
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => request.cli).sort()).toEqual(['claude', 'codex']);
  for (const request of requests) {
    expect(request.files).toHaveLength(1);
    expect(request.files[0].cli).toBe(request.cli);
  }
});

test('syncDiscoveredTranscripts payload is accepted by the real push route for mixed-cli same-brain batches', async () => {
  const alphaClaudeFile = await makeTranscriptFile('alpha-claude.json', '"claude-1"\n');
  const alphaCodexFile = await makeTranscriptFile('alpha-codex.json', '"codex-1"\n');
  const brainStore = new ContractBrainStore(['alpha']);
  const transcriptStore = new ContractTranscriptStore();

  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'claude', path: alphaClaudeFile, filename: 'alpha-claude.json', relative_path: 'alpha/claude.json' },
      { cli: 'codex', path: alphaCodexFile, filename: 'alpha-codex.json', relative_path: 'alpha/codex.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        now: Date.parse('2026-07-19T04:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async (url, init) => {
          const req = new Request(url, {
            method: init.method,
            headers: init.headers,
            body: init.body,
          });
          return handlePushTranscripts(req, brainStore, transcriptStore);
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(result.pushCount).toBe(2);
  expect(result.errCount).toBe(0);
  expect(result.nextState.offsets[alphaClaudeFile]).toBe(fs.statSync(alphaClaudeFile).size);
  expect(result.nextState.offsets[alphaCodexFile]).toBe(fs.statSync(alphaCodexFile).size);
});

test('syncDiscoveredTranscripts does not advance offsets on malformed 2xx batch responses', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json', '"line-1"\n');

  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'gemini', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        now: Date.parse('2026-07-19T04:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async () =>
          new Response('not-json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(result.pushCount).toBe(0);
  expect(result.errCount).toBe(1);
  expect(result.nextState.offsets[alphaFile]).toBeUndefined();
});

test('syncDiscoveredTranscripts does not quarantine non-JSON 404 responses', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json');
  let fetchCalls = 0;

  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'gemini', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        now: Date.parse('2026-04-27T07:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response('<html>gateway 404</html>', {
            status: 404,
            headers: { 'content-type': 'text/html' },
          });
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(fetchCalls).toBe(1);
  expect(result.errCount).toBe(1);
  expect(result.quarantinedBrains.alpha).toBeUndefined();
  expect(result.nextState.transcriptFailures.alpha).toBeUndefined();
});

test('syncDiscoveredTranscripts skips actively quarantined brains before cooldown expiry', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json');
  const state = makeState();
  recordTranscriptBrainFailure(
    state,
    'alpha',
    { status: 404, code: 'not_found', message: 'missing brain' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );

  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'gemini', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: {
        now: Date.parse('2026-04-27T07:00:30.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response('{}', { status: 200 });
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(fetchCalls).toBe(0);
  expect(result.skippedQuarantined).toBe(1);
  expect(result.quarantinedBrains.alpha.code).toBe('not_found');
});

test('syncDiscoveredTranscripts retries after cooldown expiry and clears quarantine on success', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json');
  const state = makeState();
  recordTranscriptBrainFailure(
    state,
    'alpha',
    { status: 404, code: 'not_found', message: 'missing brain' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );

  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'gemini', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: {
        now: Date.parse('2026-04-27T07:01:30.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async () => {
          fetchCalls += 1;
          return makeBatchSuccessResponse('alpha', 'machine-1', [
            { cli: 'gemini', relative_path: 'alpha/session.json' },
          ]);
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(fetchCalls).toBe(1);
  expect(result.pushCount).toBe(1);
  expect(result.nextState.transcriptFailures.alpha).toBeUndefined();
  expect(result.quarantinedBrains.alpha).toBeUndefined();
  expect(result.nextState.offsets[alphaFile]).toBe(fs.statSync(alphaFile).size);
});

test('truncated transcript starts a fresh backlog age and clears the old file failure', async () => {
  const transcriptFile = await makeTranscriptFile('rotated.jsonl', 'new\n');
  const transcriptKey = canonicalTranscriptOffsetKey('codex', 'project/rotated.jsonl');
  const state = makeState();
  state.offsets[transcriptKey] = 100;
  const newFileMtime = Date.parse('2026-07-19T12:00:00.000Z');
  recordTranscriptPushFailure(
    state,
    transcriptKey,
    { status: 503, code: 'upstream_5xx', message: 'old file failed' },
    60 * 60_000,
    newFileMtime,
  );
  await fsp.utimes(transcriptFile, newFileMtime / 1000, newFileMtime / 1000);

  const result = await syncDiscoveredTranscripts(
    [{
      cli: 'codex', path: transcriptFile, filename: 'rotated.jsonl',
      relative_path: 'project/rotated.jsonl',
    }],
    {
      machineId: 'machine-1', apiKey: 'test-key', serverUrl: 'https://example.com', state,
      runtime: {
        now: Date.parse('2026-07-19T12:01:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async (_url, init) => {
          const payload = JSON.parse(init.body);
          return makeBatchSuccessResponse(payload.brain_id, payload.machine_id, payload.files);
        },
        logFn: () => {}, logErrorFn: () => {},
      },
    },
  );

  expect(result.oldestPendingAt).toBe(new Date(newFileMtime).toISOString());
  expect(result.nextState.transcriptPushFailures[transcriptKey]).toBeUndefined();
  expect(result.pushCount).toBe(1);
});

test('truncated transcript retains new-file backoff on later reset cycles', async () => {
  const transcriptFile = await makeTranscriptFile('rotated-backoff.jsonl', 'new\n');
  const transcriptKey = canonicalTranscriptOffsetKey('codex', 'project/rotated-backoff.jsonl');
  const state = makeState();
  state.offsets[transcriptKey] = 100;
  const newFileMtime = Date.parse('2026-07-19T11:59:00.000Z');
  await fsp.utimes(transcriptFile, newFileMtime / 1000, newFileMtime / 1000);
  let fetchCalls = 0;
  const options = (nextState, now) => ({
    machineId: 'machine-1', apiKey: 'test-key', serverUrl: 'https://example.com', state: nextState,
    runtime: {
      now,
      machineInfo: { hostname: 'test-host' },
      resolveBrainId: () => 'alpha',
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response('temporary', { status: 503 });
      },
      logFn: () => {}, logErrorFn: () => {},
    },
  });

  const first = await syncDiscoveredTranscripts(
    [{
      cli: 'codex', path: transcriptFile, filename: 'rotated-backoff.jsonl',
      relative_path: 'project/rotated-backoff.jsonl',
    }],
    options(state, Date.parse('2026-07-19T12:00:00.000Z')),
  );
  const second = await syncDiscoveredTranscripts(
    [{
      cli: 'codex', path: transcriptFile, filename: 'rotated-backoff.jsonl',
      relative_path: 'project/rotated-backoff.jsonl',
    }],
    options(first.nextState, Date.parse('2026-07-19T12:00:01.000Z')),
  );

  expect(fetchCalls).toBe(1);
  expect(second.skippedBackoff).toBe(1);
  expect(second.nextState.transcriptPushFailures[transcriptKey]).toMatchObject({
    code: 'upstream_5xx',
    consecutiveFailures: 1,
  });
});

test('syncDiscoveredTranscripts fails closed instead of uploading a growing-file byte delta', async () => {
  const originalFile = await makeTranscriptFile('session.jsonl', 'line-1\n');
  const movedFile = await makeTranscriptFile('session.jsonl', 'line-1\nline-2\n');
  const requests = [];

  const initial = await syncDiscoveredTranscripts(
    [
      {
        cli: 'codex',
        path: originalFile,
        filename: 'session.jsonl',
        relative_path: 'project/session.jsonl',
      },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        now: Date.parse('2026-04-27T07:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async (_url, init) => {
          const payload = JSON.parse(init.body);
          requests.push(payload);
          return makeBatchSuccessResponse(payload.brain_id, payload.machine_id, payload.files);
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  const canonicalKey = canonicalTranscriptOffsetKey('codex', 'project/session.jsonl');
  expect(initial.nextState.offsets[originalFile]).toBe(fs.statSync(originalFile).size);
  expect(initial.nextState.offsets[canonicalKey]).toBe(fs.statSync(originalFile).size);

  const resumed = await syncDiscoveredTranscripts(
    [
      {
        cli: 'codex',
        path: movedFile,
        filename: 'session.jsonl',
        relative_path: 'project/session.jsonl',
      },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: initial.nextState,
      runtime: {
        now: Date.parse('2026-04-27T07:01:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async (_url, init) => {
          const payload = JSON.parse(init.body);
          requests.push(payload);
          return makeBatchSuccessResponse(payload.brain_id, payload.machine_id, payload.files);
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(requests).toHaveLength(1);
  expect(resumed.pushCount).toBe(0);
  expect(resumed.errCount).toBe(1);
  expect(resumed.nextState.transcriptPushFailures[canonicalKey].code).toBe('legacy_delta_rejected');
  expect(resumed.nextState.offsets[originalFile]).toBeUndefined();
  expect(resumed.nextState.offsets[movedFile]).toBeUndefined();
  expect(resumed.nextState.offsets[canonicalKey]).toBe(fs.statSync(originalFile).size);
  expect(resumed.nextState.legacyTranscriptEvidence[canonicalKey]).toMatchObject({
    state: 'legacy_unverified',
    byteOffset: fs.statSync(originalFile).size,
  });
});

test('legacy containment rejection logging is deduplicated across retry windows', async () => {
  resetContainmentRejectionLogThrottleForTests();
  const transcriptFile = await makeTranscriptFile('growing.jsonl', 'line-1\nline-2\n');
  const transcriptKey = canonicalTranscriptOffsetKey('codex', 'project/growing.jsonl');
  const state = makeState();
  state.offsets[transcriptKey] = Buffer.byteLength('line-1\n');
  const errors = [];
  const transcript = {
    cli: 'codex', path: transcriptFile, filename: 'growing.jsonl', relative_path: 'project/growing.jsonl',
  };
  const options = (nextState, now) => ({
    machineId: 'machine-1', apiKey: 'test-key', serverUrl: 'https://example.com', state: nextState,
    runtime: {
      now,
      machineInfo: { hostname: 'test-host' },
      resolveBrainId: () => 'alpha',
      fetchImpl: async () => { throw new Error('containment must not use the network'); },
      logFn: () => {},
      logErrorFn: (message, error) => errors.push([message, error.message]),
    },
  });

  const first = await syncDiscoveredTranscripts(
    [transcript], options(state, Date.parse('2026-07-19T12:00:00.000Z')),
  );
  await syncDiscoveredTranscripts(
    [transcript], options(first.nextState, Date.parse('2026-07-19T12:16:00.000Z')),
  );

  expect(errors).toHaveLength(1);
  expect(errors[0]).toEqual(['Blocked legacy transcript growing.jsonl', 'legacy_delta_rejected']);
});

test('syncDiscoveredTranscripts classifies and rejects a legacy absolute-path offset', async () => {
  const movedFile = await makeTranscriptFile('session.jsonl', 'line-1\nline-2\n');
  const requests = [];
  const legacyKey = movedFile;
  const state = makeState();
  state.offsets[legacyKey] = Buffer.byteLength('line-1\n');

  const result = await syncDiscoveredTranscripts(
    [
      {
        cli: 'codex',
        path: movedFile,
        filename: 'session.jsonl',
        relative_path: 'project/session.jsonl',
      },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: {
        now: Date.parse('2026-04-27T07:01:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async (_url, init) => {
          const payload = JSON.parse(init.body);
          requests.push(payload);
          return makeBatchSuccessResponse(payload.brain_id, payload.machine_id, payload.files);
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(requests).toHaveLength(0);
  expect(result.errCount).toBe(1);
  expect(result.nextState.transcriptPushFailures[canonicalTranscriptOffsetKey('codex', 'project/session.jsonl')].code).toBe('legacy_delta_rejected');
  expect(result.nextState.offsets[legacyKey]).toBe(Buffer.byteLength('line-1\n'));
  expect(result.nextState.legacyTranscriptEvidence[legacyKey]).toMatchObject({
    state: 'legacy_unverified',
    byteOffset: Buffer.byteLength('line-1\n'),
  });
});

test('syncDiscoveredTranscripts persists legacy classification even when an offset is caught up', async () => {
  const transcriptFile = await makeTranscriptFile('caught-up.jsonl', 'complete\n');
  const state = makeState();
  state.offsets[transcriptFile] = fs.statSync(transcriptFile).size;

  const result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: transcriptFile, filename: 'caught-up.jsonl', relative_path: 'caught-up.jsonl' }],
    {
      machineId: 'machine-1', apiKey: 'test-key', serverUrl: 'https://example.com', state,
      runtime: { resolveBrainId: () => 'alpha', logFn: () => {}, logErrorFn: () => {} },
    },
  );

  expect(result.stateChanged).toBe(true);
  expect(result.nextState.legacyTranscriptEvidence[transcriptFile]).toMatchObject({
    state: 'legacy_unverified', authority: false, evictionEligible: false,
  });
});

test('syncDiscoveredTranscripts never sends an incomplete one-chunk body for a large v1 file', async () => {
  const transcriptFile = await makeTranscriptFile('large.jsonl', 'x'.repeat(4 * 1024 * 1024 + 1));
  let fetchCalls = 0;

  const result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: transcriptFile, filename: 'large.jsonl', relative_path: 'large.jsonl' }],
    {
      machineId: 'machine-1', apiKey: 'test-key', serverUrl: 'https://example.com', state: makeState(),
      runtime: {
        now: Date.parse('2026-07-19T12:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async () => { fetchCalls += 1; return new Response('{}'); },
        logFn: () => {}, logErrorFn: () => {},
      },
    },
  );

  expect(fetchCalls).toBe(0);
  expect(result.pushCount).toBe(0);
  expect(result.errCount).toBe(1);
  expect(result.nextState.transcriptPushFailures[canonicalTranscriptOffsetKey('codex', 'large.jsonl')].code).toBe('legacy_file_too_large');
});

test('syncDiscoveredTranscripts does not reuse a cross-cli legacy absolute-path offset for the same relative suffix', async () => {
  const transcriptFile = await makeTranscriptFile('session.jsonl', 'line-1\nline-2\n');
  const requests = [];
  const conflictingLegacyKey = path.join(os.homedir(), '.codex', 'sessions', 'project', 'session.jsonl');
  const state = makeState();
  state.offsets[conflictingLegacyKey] = Buffer.byteLength('line-1\n');

  const result = await syncDiscoveredTranscripts(
    [
      {
        cli: 'gemini',
        path: transcriptFile,
        filename: 'session.jsonl',
        relative_path: 'project/session.jsonl',
      },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: {
        now: Date.parse('2026-04-27T07:01:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(requests).toHaveLength(1);
  expect(requests[0].files[0].byte_offset).toBe(0);
  expect(Buffer.from(requests[0].files[0].content_base64, 'base64').toString('utf8')).toBe('line-1\nline-2\n');
  expect(result.nextState.offsets[conflictingLegacyKey]).toBeUndefined();
});

test('syncDiscoveredTranscripts prunes expired transcript failures before syncing', async () => {
  const betaFile = await makeTranscriptFile('beta.json');
  const state = makeState();
  recordTranscriptBrainFailure(
    state,
    'expired-brain',
    { status: 404, code: 'not_found', message: 'missing brain' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );

  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'gemini', path: betaFile, filename: 'beta.json', relative_path: 'beta/session.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: {
        now: Date.parse('2026-04-27T07:02:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'beta',
        fetchImpl: async () =>
          makeBatchSuccessResponse('beta', 'machine-1', [
            { cli: 'gemini', relative_path: 'beta/session.json' },
          ]),
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(result.nextState.transcriptFailures['expired-brain']).toBeUndefined();
  expect(result.stateChanged).toBe(true);
  expect(result.pushCount).toBe(1);
});

test('syncDiscoveredTranscripts prunes expired per-file cooldowns before syncing', async () => {
  const betaFile = await makeTranscriptFile('beta.json', '"beta"\n');
  const transcriptKey = canonicalTranscriptOffsetKey('codex', 'beta/session.json');
  const state = makeState();
  state.transcriptPushFailures[transcriptKey] = {
    status: 502,
    code: 'upstream_5xx',
    message: 'bad gateway',
    failedAt: '2026-04-27T07:00:00.000Z',
    cooldownUntil: '2026-04-27T07:00:30.000Z',
    consecutiveFailures: 2,
    mode: 'backoff',
    retryAfterMs: 30_000,
  };

  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'codex', path: betaFile, filename: 'beta.json', relative_path: 'beta/session.json' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: {
        now: Date.parse('2026-04-27T07:01:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'beta',
        fetchImpl: async () =>
          makeBatchSuccessResponse('beta', 'machine-1', [
            { cli: 'codex', relative_path: 'beta/session.json' },
          ]),
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(result.nextState.transcriptPushFailures[transcriptKey]).toBeUndefined();
  expect(result.stateChanged).toBe(true);
  expect(result.pushCount).toBe(1);
});

test('expired per-file failure does not degrade a caught-up transcript', async () => {
  const transcriptFile = await makeTranscriptFile('caught-up-expired.jsonl', 'done\n');
  const transcriptKey = canonicalTranscriptOffsetKey('codex', 'caught-up-expired.jsonl');
  const state = makeState();
  state.offsets[transcriptKey] = fs.statSync(transcriptFile).size;
  state.transcriptPushFailures[transcriptKey] = {
    status: 502,
    code: 'upstream_5xx',
    message: 'expired failure',
    failedAt: '2026-07-19T11:00:00.000Z',
    cooldownUntil: '2026-07-19T11:01:00.000Z',
    consecutiveFailures: 1,
    mode: 'backoff',
    retryAfterMs: 60_000,
  };

  const result = await syncDiscoveredTranscripts(
    [{
      cli: 'codex', path: transcriptFile, filename: 'caught-up-expired.jsonl',
      relative_path: 'caught-up-expired.jsonl',
    }],
    {
      machineId: 'machine-1', apiKey: 'test-key', serverUrl: 'https://example.com', state,
      runtime: {
        now: Date.parse('2026-07-19T12:00:00.000Z'),
        resolveBrainId: () => 'alpha',
        logFn: () => {}, logErrorFn: () => {},
      },
    },
  );

  expect(result.nextState.transcriptPushFailures[transcriptKey]).toBeUndefined();
  expect(result.activeFailureCount).toBe(0);
  expect(result.containmentFailureCount).toBe(0);
  expect(result.stateChanged).toBe(true);
});

test('syncDiscoveredTranscripts splits oversized encoded batches deterministically', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json', JSON.stringify('a'.repeat(1022)));
  const betaFile = await makeTranscriptFile('beta.json', JSON.stringify('b'.repeat(1022)));
  const requests = [];

  const result = await syncDiscoveredTranscripts(
    [
      { cli: 'codex', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.jsonl' },
      { cli: 'codex', path: betaFile, filename: 'beta.json', relative_path: 'beta/session.jsonl' },
    ],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        maxBatchBytes: 2500,
        now: Date.parse('2026-04-27T07:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async (_url, init) => {
          const payload = JSON.parse(init.body);
          requests.push(payload);
          return new Response(
            JSON.stringify({
              data: {
                pushed: payload.files.length,
                appended: 0,
                errors: 0,
                results: payload.files.map((file) => ({
                  key: `transcripts/alpha/machine-1/${file.cli}/${file.relative_path}`,
                  status: 'pushed',
                })),
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(requests).toHaveLength(2);
  expect(requests[0].files).toHaveLength(1);
  expect(requests[1].files).toHaveLength(1);
  expect(result.pushCount).toBe(2);
  expect(result.errCount).toBe(0);
  expect(result.nextState.offsets[alphaFile]).toBe(fs.statSync(alphaFile).size);
  expect(result.nextState.offsets[betaFile]).toBe(fs.statSync(betaFile).size);
});

test('syncDiscoveredTranscripts fails closed when one encoded item exceeds maxBatchBytes', async () => {
  const alphaFile = await makeTranscriptFile('over-cap.json', JSON.stringify('a'.repeat(1022)));
  let fetchCalls = 0;

  const result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: alphaFile, filename: 'over-cap.json', relative_path: 'alpha/over-cap.jsonl' }],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        maxBatchBytes: 100,
        now: Date.parse('2026-07-19T12:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async () => { fetchCalls += 1; return new Response('{}'); },
        logFn: () => {},
        logErrorFn: () => {},
      },
    },
  );

  expect(fetchCalls).toBe(0);
  expect(result.pushCount).toBe(0);
  expect(result.errCount).toBe(1);
  expect(result.pendingFiles).toBe(1);
  expect(result.nextState.transcriptPushFailures[
    canonicalTranscriptOffsetKey('codex', 'alpha/over-cap.jsonl')
  ]?.code).toBe('legacy_request_too_large');
});

test('syncDiscoveredTranscripts honors Retry-After on 429 responses', async () => {
  const alphaFile = await makeTranscriptFile('throttled.json', '"alpha"\n');
  const now = Date.parse('2026-04-27T07:00:00.000Z');
  const result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: alphaFile, filename: 'throttled.json', relative_path: 'alpha/throttled.jsonl' }],
    {
      machineId: 'machine-1', apiKey: 'test-key', serverUrl: 'https://example.com', state: makeState(),
      runtime: {
        now, machineInfo: { hostname: 'test-host' }, resolveBrainId: () => 'alpha',
        fetchImpl: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '12' } }),
        logFn: () => {}, logErrorFn: () => {},
      },
    },
  );
  const key = canonicalTranscriptOffsetKey('codex', 'alpha/throttled.jsonl');
  expect(result.errCount).toBe(1);
  expect(result.nextState.transcriptPushFailures[key]).toMatchObject({
    code: 'upstream_throttled', cooldownUntil: new Date(now + 12_000).toISOString(),
  });
  expect(result.throttleResponses).toBe(1);
  expect(result.retryAfterCooldowns).toBe(1);
});

test('429 fallback is jittered, bounded, and Retry-After parsing accepts HTTP dates', () => {
  const now = Date.parse('2026-04-27T07:00:00.000Z');
  const policy = { baseMs: 1_000, capMs: 8_000, quarantineAfter: 3, quarantineRetryMs: 60_000 };
  expect(parseRetryAfterMs('Wed, 27 Apr 2026 07:00:05 GMT', now)).toBe(5_000);
  expect(parseRetryAfterMs('invalid', now)).toBeNull();
  expect(computeTranscriptThrottleCooldownMs(null, policy, null, () => 0.5)).toBe(1_100);
  expect(computeTranscriptThrottleCooldownMs(null, policy, 9_000, () => 0)).toBe(9_000);
});

test('syncDiscoveredTranscripts backs off repeated 5xxs per file and then quarantines on a slow retry interval', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json', '"alpha"\n');
  let fetchCalls = 0;
  let state = makeState();
  const runtime = {
    now: Date.parse('2026-04-27T07:00:00.000Z'),
    machineInfo: { hostname: 'test-host' },
    resolveBrainId: () => 'alpha',
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('bad gateway', { status: 502 });
    },
    logFn: () => {},
    logErrorFn: () => {},
    transientFailureConfig: {
      baseMs: 1_000,
      capMs: 8_000,
      quarantineAfter: 3,
      quarantineRetryMs: 60_000,
    },
  };

  let result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.jsonl' }],
    { machineId: 'machine-1', apiKey: 'test-key', serverUrl: 'https://example.com', state, runtime }
  );
  state = result.nextState;
  const transcriptKey = canonicalTranscriptOffsetKey('codex', 'alpha/session.jsonl');
  expect(fetchCalls).toBe(1);
  expect(state.transcriptPushFailures[transcriptKey]?.mode).toBe('backoff');
  expect(state.transcriptPushFailures[transcriptKey]?.consecutiveFailures).toBe(1);

  result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.jsonl' }],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: { ...runtime, now: Date.parse('2026-04-27T07:00:02.000Z') },
    }
  );
  state = result.nextState;
  expect(fetchCalls).toBe(2);
  expect(state.transcriptPushFailures[transcriptKey]?.mode).toBe('backoff');
  expect(state.transcriptPushFailures[transcriptKey]?.consecutiveFailures).toBe(2);

  result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.jsonl' }],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: { ...runtime, now: Date.parse('2026-04-27T07:00:05.000Z') },
    }
  );
  state = result.nextState;
  expect(fetchCalls).toBe(3);
  expect(state.transcriptPushFailures[transcriptKey]?.mode).toBe('quarantined');
  expect(state.transcriptPushFailures[transcriptKey]?.consecutiveFailures).toBe(3);

  result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.jsonl' }],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: {
        ...runtime,
        now: Date.parse('2026-04-27T07:00:30.000Z'),
        fetchImpl: async () => {
          fetchCalls += 1;
          return makeBatchSuccessResponse('alpha', 'machine-1', [
            { cli: 'codex', relative_path: 'alpha/session.jsonl' },
          ]);
        },
      },
    }
  );

  expect(fetchCalls).toBe(3);
  expect(result.skippedBackoff).toBe(1);
  expect(result.pendingFiles).toBe(1);
  expect(result.activeFailureCount).toBe(1);
  expect(result.quarantinedFiles[transcriptKey]?.mode).toBe('quarantined');
});

test('syncDiscoveredTranscripts retries a quarantined 5xx file after cooldown expiry and clears it on success', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json', '"alpha"\n');
  const transcriptKey = canonicalTranscriptOffsetKey('codex', 'alpha/session.jsonl');
  const state = makeState();
  state.transcriptPushFailures[transcriptKey] = {
    status: 502,
    code: 'upstream_5xx',
    message: 'bad gateway',
    failedAt: '2026-04-27T07:00:05.000Z',
    cooldownUntil: '2026-04-27T07:01:05.000Z',
    consecutiveFailures: 3,
    mode: 'quarantined',
    retryAfterMs: 60_000,
  };

  let fetchCalls = 0;
  const result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.jsonl' }],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state,
      runtime: {
        now: Date.parse('2026-04-27T07:01:06.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async () => {
          fetchCalls += 1;
          return makeBatchSuccessResponse('alpha', 'machine-1', [
            { cli: 'codex', relative_path: 'alpha/session.jsonl' },
          ]);
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(fetchCalls).toBe(1);
  expect(result.pushCount).toBe(1);
  expect(result.nextState.transcriptPushFailures[transcriptKey]).toBeUndefined();
});

test('syncDiscoveredTranscripts applies per-file backoff when a 2xx batch includes a rejected file result', async () => {
  const alphaFile = await makeTranscriptFile('alpha.json', '"alpha"\n');
  const transcriptKey = canonicalTranscriptOffsetKey('codex', 'alpha/session.jsonl');

  let result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.jsonl' }],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: makeState(),
      runtime: {
        now: Date.parse('2026-04-27T07:00:00.000Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async () =>
          new Response(JSON.stringify({
            data: {
              results: [{
                key: `transcripts/alpha/machine-1/codex/alpha/session.jsonl`,
                status: 'rejected',
                error: 'too large',
                httpStatus: 413,
              }],
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        logFn: () => {},
        logErrorFn: () => {},
        transientFailureConfig: {
          baseMs: 1_000,
          capMs: 8_000,
          quarantineAfter: 3,
          quarantineRetryMs: 60_000,
        },
      },
    }
  );

  expect(result.pushCount).toBe(0);
  expect(result.errCount).toBe(1);
  expect(result.nextState.offsets[alphaFile]).toBeUndefined();
  expect(result.nextState.transcriptPushFailures[transcriptKey]?.mode).toBe('backoff');
  expect(result.nextState.transcriptPushFailures[transcriptKey]?.status).toBe(413);
  expect(result.nextState.transcriptPushFailures[transcriptKey]?.consecutiveFailures).toBe(1);

  result = await syncDiscoveredTranscripts(
    [{ cli: 'codex', path: alphaFile, filename: 'alpha.json', relative_path: 'alpha/session.jsonl' }],
    {
      machineId: 'machine-1',
      apiKey: 'test-key',
      serverUrl: 'https://example.com',
      state: result.nextState,
      runtime: {
        now: Date.parse('2026-04-27T07:00:00.500Z'),
        machineInfo: { hostname: 'test-host' },
        resolveBrainId: () => 'alpha',
        fetchImpl: async () => {
          throw new Error('should not retry during backoff');
        },
        logFn: () => {},
        logErrorFn: () => {},
      },
    }
  );

  expect(result.skippedBackoff).toBe(1);
});

test('syncDiscoveredTranscripts logs the same unmapped transcript path only once per process', async () => {
  resetUnmappedTranscriptLogThrottleForTests();
  const logs = [];
  const transcript = {
    cli: 'codex',
    path: '/tmp/agentbootup-unmapped-repeat/session.jsonl',
    filename: 'session.jsonl',
    relative_path: 'session.jsonl',
  };

  const options = {
    machineId: 'machine-1',
    apiKey: 'test-key',
    serverUrl: 'https://example.com',
    state: makeState(),
    runtime: {
      resolveBrainId: () => null,
      fetchImpl: async () => {
        throw new Error('unmapped transcripts should not be pushed');
      },
      logFn: (message) => logs.push(message),
      logErrorFn: () => {},
    },
  };

  await syncDiscoveredTranscripts([transcript], options);
  await syncDiscoveredTranscripts([transcript], options);

  expect(logs).toEqual([
    'Skipping unmapped transcript: /tmp/agentbootup-unmapped-repeat/session.jsonl',
  ]);
});

test('syncDiscoveredTranscripts resets unmapped transcript log throttle after cap', async () => {
  resetUnmappedTranscriptLogThrottleForTests();
  const logs = [];
  const transcripts = Array.from({ length: 10_001 }, (_, i) => ({
    cli: 'codex',
    path: `/tmp/agentbootup-unmapped-cap/session-${i}.jsonl`,
    filename: `session-${i}.jsonl`,
    relative_path: `session-${i}.jsonl`,
  }));

  await syncDiscoveredTranscripts(transcripts, {
    machineId: 'machine-1',
    apiKey: 'test-key',
    serverUrl: 'https://example.com',
    state: makeState(),
    runtime: {
      resolveBrainId: () => null,
      fetchImpl: async () => {
        throw new Error('unmapped transcripts should not be pushed');
      },
      logFn: (message) => logs.push(message),
      logErrorFn: () => {},
    },
  });

  expect(logs).toContain('Reset unmapped transcript log throttle after 10000 unique paths');
  expect(logs.filter((message) => message.startsWith('Skipping unmapped transcript: '))).toHaveLength(10_001);
});
