import { test, expect, beforeEach, afterAll } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import fs from 'fs';

// ── Isolation: each test gets its own state file via env var ─────────────────

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agentbootup-sync-state-test-')
);

// Dynamic import AFTER setting up tmpDir so we can override per-test via env.
const {
  readSyncState,
  writeSyncState,
  getFileOffset,
  getStateFilePath,
  withSyncStateLock,
  canonicalTranscriptOffsetKey,
  isCanonicalTranscriptOffsetKey,
  getTranscriptFailure,
  isTranscriptBrainQuarantined,
  recordTranscriptBrainFailure,
  clearTranscriptBrainFailure,
  pruneExpiredTranscriptFailures,
  getTranscriptPushFailure,
  isTranscriptPushQuarantined,
  recordTranscriptPushFailure,
  clearTranscriptPushFailure,
  pruneExpiredTranscriptPushFailures,
  appendRedactionBlockEvent,
  reconcileRedactionBlockLedgerHealth,
} =
  await import('../../lib/sync-state/sync-state.js');

function stateFile() {
  return process.env.AGENTBOOTUP_SYNC_STATE_FILE!;
}

beforeEach(async () => {
  const f = path.join(tmpDir, `state-${Date.now()}-${Math.random()}.json`);
  process.env.AGENTBOOTUP_SYNC_STATE_FILE = f;
  // Clean up any leftover from prior test.
  await fsp.unlink(f).catch(() => {});
});

afterAll(async () => {
  delete process.env.AGENTBOOTUP_SYNC_STATE_FILE;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('readSyncState returns empty structured state when file does not exist', async () => {
  const state = await readSyncState();
  expect(state).toEqual({
    offsets: {}, transcriptFailures: {}, transcriptPushFailures: {}, redactionPartialOffsets: {},
    redactionBlockLedger: [],
    redactionLedgerUnhealthy: false,
  });
});

test('redaction block ledger survives a restart round trip without secret material', async () => {
  const recordedAt = Date.now();
  const recordedAtIso = new Date(recordedAt).toISOString();
  const state = {
    offsets: {}, transcriptFailures: {}, transcriptPushFailures: {}, redactionPartialOffsets: {},
    redactionBlockLedger: [],
    redactionLedgerUnhealthy: false,
  };
  appendRedactionBlockEvent(state, {
    file: 'transcript:codex:project/session.jsonl',
    cli: 'codex',
    code: 'redaction_blocked_permanent',
    permanent: true,
    secret: 'synthetic-secret',
  }, recordedAt);
  await writeSyncState(state);
  const restored = await readSyncState();
  expect(restored.redactionBlockLedger).toEqual([{
    at: recordedAtIso,
    file: 'transcript:codex:project/session.jsonl',
    cli: 'codex',
    code: 'redaction_blocked_permanent',
    permanent: true,
  }]);
  expect(await fsp.readFile(stateFile(), 'utf8')).not.toContain('synthetic-secret');
});

test('redaction block ledger prunes expired evidence and fails closed at its in-window cap', () => {
  const now = Date.parse('2026-07-31T12:00:00.000Z');
  const state = {
    redactionBlockLedger: [{
      at: '2026-07-20T12:00:00.000Z', file: 'transcript:codex:expired.jsonl',
      cli: 'codex', code: 'redaction_failed', permanent: false,
    }],
  };
  const options = {
    retentionMs: 7 * 24 * 60 * 60_000,
    maxEntries: 2,
    maxBytes: 1024 * 1024,
    env: {},
  };
  appendRedactionBlockEvent(state, {
    file: 'transcript:codex:first.jsonl', cli: 'codex', code: 'redaction_failed',
  }, now, options);
  appendRedactionBlockEvent(state, {
    file: 'transcript:codex:second.jsonl', cli: 'codex', code: 'redaction_failed',
  }, now + 1, options);
  expect(state.redactionBlockLedger).toHaveLength(2);
  expect(state.redactionBlockLedger.some((entry) => entry.file.includes('expired'))).toBe(false);
  let capacityError;
  try {
    appendRedactionBlockEvent(state, {
      file: 'transcript:codex:third.jsonl', cli: 'codex', code: 'redaction_failed',
    }, now + 2, options);
  } catch (error) {
    capacityError = error;
  }
  expect(capacityError).toMatchObject({ code: 'redaction_subsystem_unhealthy' });
  expect(state.redactionBlockLedger).toHaveLength(2);
});

test('redaction block ledger fails closed before exceeding its byte ceiling', () => {
  const state = { redactionBlockLedger: [] };
  let capacityError;
  try {
    appendRedactionBlockEvent(state, {
      file: `transcript:codex:${'x'.repeat(512)}.jsonl`, cli: 'codex', code: 'redaction_failed',
    }, Date.parse('2026-07-31T12:00:00.000Z'), {
      retentionMs: 7 * 24 * 60 * 60_000,
      maxEntries: 10,
      maxBytes: 128,
      env: {},
    });
  } catch (error) {
    capacityError = error;
  }
  expect(capacityError).toMatchObject({ code: 'redaction_subsystem_unhealthy' });
  expect(state.redactionBlockLedger).toEqual([]);
});

test('redaction ledger health recovers only after capacity for a worst-case event returns', () => {
  const now = Date.parse('2026-07-31T12:00:00.000Z');
  const state = {
    redactionBlockLedger: [{
      at: new Date(now).toISOString(), file: 'transcript:codex:blocked.jsonl',
      cli: 'codex', code: 'redaction_failed', permanent: false,
    }],
    redactionLedgerUnhealthy: true,
  };
  expect(reconcileRedactionBlockLedgerHealth(state, now, {
    retentionMs: 7 * 24 * 60 * 60_000, maxEntries: 1, maxBytes: 1024 * 1024, env: {},
  })).toBe(false);
  expect(state.redactionLedgerUnhealthy).toBe(true);

  state.redactionBlockLedger = [];
  expect(reconcileRedactionBlockLedgerHealth(state, now, {
    retentionMs: 7 * 24 * 60 * 60_000, maxEntries: 1, maxBytes: 1024 * 1024, env: {},
  })).toBe(true);
  expect(state.redactionLedgerUnhealthy).toBe(false);
});

test('writeSyncState creates file and readSyncState reads it back', async () => {
  const initial = { offsets: { '/a/b/c.jsonl': 1024 }, transcriptFailures: {} };
  await writeSyncState(initial);
  const state = await readSyncState();
  expect(state.offsets['/a/b/c.jsonl']).toBe(1024);
});

test('getFileOffset returns 0 for unknown file', () => {
  const state: Record<string, number> = {};
  expect(getFileOffset(state, '/missing.jsonl')).toBe(0);
});

test('getFileOffset returns stored value', () => {
  const state: Record<string, number> = { '/x/y.jsonl': 4096 };
  expect(getFileOffset(state, '/x/y.jsonl')).toBe(4096);
});

test('getFileOffset treats negative values as 0', () => {
  const state: Record<string, number> = { '/x/y.jsonl': -1 };
  expect(getFileOffset(state, '/x/y.jsonl')).toBe(0);
});


test('writeSyncState creates parent directory with mode 0o700', async () => {
  const nested = path.join(tmpDir, `nested-${Date.now()}`);
  process.env.AGENTBOOTUP_SYNC_STATE_FILE = path.join(nested, 'state.json');
  await writeSyncState({ '/f.jsonl': 1 });
  const dirStat = await fsp.stat(nested);
  expect(dirStat.mode & 0o777).toBe(0o700);
  const raw = JSON.parse(await fsp.readFile(path.join(nested, 'state.json'), 'utf-8'));
  expect(raw.offsets['/f.jsonl']).toBe(1);
});

test('state file is created with mode 0o600', async () => {
  await writeSyncState({ '/f.jsonl': 42 });
  const stat = await fsp.stat(stateFile());
  expect(stat.mode & 0o777).toBe(0o600);
});

test('writeSyncState corrects permissions on pre-existing file with wrong mode', async () => {
  await fsp.writeFile(stateFile(), '{}', { mode: 0o644 });
  await writeSyncState({ '/a.jsonl': 1 });
  const stat = await fsp.stat(stateFile());
  expect(stat.mode & 0o777).toBe(0o600);
});

test('withSyncStateLock serializes complete cross-process-style transactions', async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withSyncStateLock(async () => {
    events.push('first-enter');
    markEntered();
    await release;
    events.push('first-exit');
  });
  await entered;
  const second = withSyncStateLock(async () => { events.push('second-enter'); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual(['first-enter']);
  releaseFirst();
  await Promise.all([first, second]);
  expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);
});

test('withSyncStateLock rejects caller-specific stale timing', async () => {
  await expect(withSyncStateLock(async () => {}, { staleMs: 1, waitMs: 2 })).rejects.toThrow(
    'timing is canonical',
  );
});

test('readSyncState returns {} on malformed JSON', async () => {
  await fsp.writeFile(stateFile(), '{ bad json }', 'utf-8');
  const state = await readSyncState();
  expect(state).toEqual({
    offsets: {}, transcriptFailures: {}, transcriptPushFailures: {}, redactionPartialOffsets: {},
    redactionBlockLedger: [],
    redactionLedgerUnhealthy: false,
  });
});

test('getStateFilePath reflects AGENTBOOTUP_SYNC_STATE_FILE env var', () => {
  const custom = '/tmp/custom-state.json';
  process.env.AGENTBOOTUP_SYNC_STATE_FILE = custom;
  expect(getStateFilePath()).toBe(custom);
});

// ── Schema versioning ─────────────────────────────────────────────────────────

test('writeSyncState includes version field in file', async () => {
  await writeSyncState({ offsets: { '/a.jsonl': 10 }, transcriptFailures: {} });
  const raw = JSON.parse(await fsp.readFile(stateFile(), 'utf-8'));
  expect(raw.version).toBe(2);
  expect(raw.offsets['/a.jsonl']).toBe(10);
});

test('readSyncState strips version field into structured object', async () => {
  await writeSyncState({ offsets: { '/a.jsonl': 10 }, transcriptFailures: {} });
  const state = await readSyncState();
  expect((state as Record<string, unknown>).version).toBeUndefined();
  expect(state.offsets['/a.jsonl']).toBe(10);
  expect(state.transcriptFailures).toEqual({});
  expect(state.transcriptPushFailures).toEqual({});
  expect(state.redactionPartialOffsets).toEqual({});
});

test('writeSyncState preserves redaction-owned partial offsets across a restart round trip', async () => {
  const key = 'transcript:codex:project/session.jsonl';
  await writeSyncState({
    offsets: { [key]: 42 },
    transcriptFailures: {},
    transcriptPushFailures: {},
    redactionPartialOffsets: { [key]: { offset: 42, observedSize: 55, observedMtimeMs: 1234 } },
  });
  const state = await readSyncState();
  expect(state.offsets[key]).toBe(42);
  expect(state.redactionPartialOffsets[key]).toEqual({
    offset: 42,
    observedSize: 55,
    observedMtimeMs: 1234,
  });
});

test('readSyncState migrates v0/v1 bare-map files transparently', async () => {
  await fsp.writeFile(stateFile(), JSON.stringify({ '/b.jsonl': 99 }), 'utf-8');
  const state = await readSyncState();
  expect(state.offsets['/b.jsonl']).toBe(99);
  expect(state.legacyTranscriptEvidence['/b.jsonl']).toEqual({
    state: 'legacy_unverified',
    byteOffset: 99,
    authority: false,
    evictionEligible: false,
  });
  expect((state as Record<string, unknown>).version).toBeUndefined();
});

test('legacy transcript evidence is pruned with removed offsets', async () => {
  await fsp.writeFile(
    stateFile(),
    JSON.stringify({
      version: 2,
      offsets: { '/live.jsonl': 10 },
      transcriptFailures: {},
      transcriptPushFailures: {},
      legacyTranscriptEvidence: {
        '/live.jsonl': { state: 'legacy_unverified', byteOffset: 10 },
        '/deleted.jsonl': { state: 'legacy_unverified', byteOffset: 99 },
      },
    }),
    'utf-8',
  );

  const state = await readSyncState();
  expect(Object.keys(state.legacyTranscriptEvidence)).toEqual(['/live.jsonl']);
  await writeSyncState(state);
  const raw = JSON.parse(await fsp.readFile(stateFile(), 'utf-8'));
  expect(raw.legacyTranscriptEvidence['/deleted.jsonl']).toBeUndefined();
});

test('readSyncState migrates v2 structured files transparently', async () => {
  await fsp.writeFile(
    stateFile(),
    JSON.stringify({
      version: 2,
      offsets: { '/b.jsonl': 99 },
      transcriptFailures: {
        alpha: {
          status: 404,
          code: 'not_found',
          message: 'missing brain',
          failedAt: '2026-04-27T07:00:00.000Z',
          cooldownUntil: '2026-04-27T07:01:00.000Z',
          consecutiveFailures: 1,
        },
      },
    }),
    'utf-8'
  );
  const state = await readSyncState();
  expect(state.offsets['/b.jsonl']).toBe(99);
  expect(state.transcriptFailures.alpha?.code).toBe('not_found');
  expect(state.transcriptPushFailures).toEqual({});
});

test('readSyncState migrates v3 structured files with transcript push failures transparently', async () => {
  await fsp.writeFile(
    stateFile(),
    JSON.stringify({
      version: 3,
      offsets: { '/b.jsonl': 99 },
      transcriptFailures: {},
      transcriptPushFailures: {
        'transcript:codex:alpha/session.jsonl': {
          status: 502,
          code: 'bad_gateway',
          message: 'proxy body limit',
          failedAt: '2026-04-27T07:00:00.000Z',
          cooldownUntil: '2026-04-27T07:01:00.000Z',
          consecutiveFailures: 2,
          mode: 'quarantined',
          retryAfterMs: 60_000,
        },
      },
    }),
    'utf-8'
  );
  const state = await readSyncState();
  expect(state.transcriptPushFailures['transcript:codex:alpha/session.jsonl']?.mode).toBe('quarantined');
});

test('writeSyncState stays rollback-safe for the currently deployed v2 reader', async () => {
  const stateToWrite = {
    offsets: {
      '/tmp/legacy-session.jsonl': 99,
      'transcript:codex:alpha/session.jsonl': 123,
    },
    transcriptFailures: {
      alpha: {
        status: 404,
        code: 'not_found',
        message: 'missing brain',
        failedAt: '2026-04-27T07:00:00.000Z',
        cooldownUntil: '2026-04-27T07:01:00.000Z',
        consecutiveFailures: 1,
      },
    },
    transcriptPushFailures: {
      'transcript:codex:alpha/session.jsonl': {
        status: 502,
        code: 'bad_gateway',
        message: 'proxy body limit',
        failedAt: '2026-04-27T07:00:00.000Z',
        cooldownUntil: '2026-04-27T07:01:00.000Z',
        consecutiveFailures: 2,
        mode: 'quarantined',
        retryAfterMs: 60_000,
      },
    },
  };
  await writeSyncState(stateToWrite);
  const raw = JSON.parse(await fsp.readFile(stateFile(), 'utf-8'));

  const migrateLikeCurrentMain = (parsed: Record<string, unknown>) => {
    if (parsed?.version === 2) {
      return {
        offsets:
          parsed.offsets && typeof parsed.offsets === 'object' ? parsed.offsets : {},
        transcriptFailures:
          parsed.transcriptFailures && typeof parsed.transcriptFailures === 'object'
            ? parsed.transcriptFailures
            : {},
      };
    }
    const { version: _v, ...rest } = parsed;
    return {
      offsets: rest,
      transcriptFailures: {},
    };
  };

  const rolledBack = migrateLikeCurrentMain(raw);
  expect(rolledBack.offsets['/tmp/legacy-session.jsonl']).toBe(99);
  expect(rolledBack.offsets['transcript:codex:alpha/session.jsonl']).toBe(123);
  expect(rolledBack.transcriptFailures.alpha?.code).toBe('not_found');
});

test('canonicalTranscriptOffsetKey normalizes cli-relative transcript identities', () => {
  expect(canonicalTranscriptOffsetKey('codex', '/nested\\session.jsonl')).toBe(
    'transcript:codex:nested/session.jsonl'
  );
  expect(canonicalTranscriptOffsetKey('  ', 'nested/session.jsonl')).toBeNull();
  expect(canonicalTranscriptOffsetKey('codex', '')).toBeNull();
});

test('isCanonicalTranscriptOffsetKey recognizes canonical transcript keys only', () => {
  expect(isCanonicalTranscriptOffsetKey('transcript:codex:nested/session.jsonl')).toBe(true);
  expect(isCanonicalTranscriptOffsetKey('/tmp/session.jsonl')).toBe(false);
  expect(isCanonicalTranscriptOffsetKey('')).toBe(false);
});

// ── Migration shim: nested hook format ───────────────────────────────────────

test('getFileOffset handles nested { lastOffset } format from old hooks', () => {
  const legacyState = {
    '/home/user/.claude/session.jsonl': { lastOffset: 512, lastPushedAt: '2025-01-01' },
  } as unknown as Record<string, number>;
  expect(getFileOffset(legacyState, '/home/user/.claude/session.jsonl')).toBe(512);
});

test('getFileOffset returns 0 for nested format with negative lastOffset', () => {
  const legacyState = {
    '/path/file.jsonl': { lastOffset: -1 },
  } as unknown as Record<string, number>;
  expect(getFileOffset(legacyState, '/path/file.jsonl')).toBe(0);
});

test('getFileOffset returns 0 for nested format with no lastOffset field', () => {
  const legacyState = {
    '/path/file.jsonl': { lastPushedAt: '2025-01-01' },
  } as unknown as Record<string, number>;
  expect(getFileOffset(legacyState, '/path/file.jsonl')).toBe(0);
});

test('recordTranscriptBrainFailure stores cooldown metadata', () => {
  const state = { offsets: {}, transcriptFailures: {} };
  const failure = recordTranscriptBrainFailure(
    state,
    'infinitrade',
    { status: 404, code: 'not_found', message: 'missing brain' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );

  expect(failure.code).toBe('not_found');
  expect(failure.cooldownUntil).toBe('2026-04-27T07:01:00.000Z');
  expect(getTranscriptFailure(state, 'infinitrade')?.consecutiveFailures).toBe(1);
  expect(isTranscriptBrainQuarantined(state, 'infinitrade', Date.parse('2026-04-27T07:00:30.000Z'))).toBe(true);
  expect(isTranscriptBrainQuarantined(state, 'infinitrade', Date.parse('2026-04-27T07:01:01.000Z'))).toBe(false);
});

test('recordTranscriptBrainFailure increments consecutiveFailures on repeated errors', () => {
  const state = { offsets: {}, transcriptFailures: {} };
  recordTranscriptBrainFailure(
    state,
    'infinitrade',
    { status: 404, code: 'not_found', message: 'missing brain' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );
  const second = recordTranscriptBrainFailure(
    state,
    'infinitrade',
    { status: 404, code: 'not_found', message: 'still missing' },
    60_000,
    Date.parse('2026-04-27T07:02:00.000Z')
  );
  expect(second.consecutiveFailures).toBe(2);
  expect(second.failedAt).toBe('2026-04-27T07:02:00.000Z');
});

test('clearTranscriptBrainFailure removes cooldown metadata', () => {
  const state = { offsets: {}, transcriptFailures: {} };
  recordTranscriptBrainFailure(
    state,
    'infinitrade',
    { status: 404, code: 'not_found', message: 'missing brain' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );
  expect(clearTranscriptBrainFailure(state, 'infinitrade')).toBe(true);
  expect(getTranscriptFailure(state, 'infinitrade')).toBeNull();
  expect(clearTranscriptBrainFailure(state, 'infinitrade')).toBe(false);
});

test('pruneExpiredTranscriptFailures removes expired cooldown entries', () => {
  const state = { offsets: {}, transcriptFailures: {} };
  recordTranscriptBrainFailure(
    state,
    'expired',
    { status: 404, code: 'not_found', message: 'missing brain' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );
  recordTranscriptBrainFailure(
    state,
    'active',
    { status: 404, code: 'not_found', message: 'missing brain' },
    300_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );
  expect(pruneExpiredTranscriptFailures(state, Date.parse('2026-04-27T07:01:30.000Z'))).toBe(true);
  expect(getTranscriptFailure(state, 'expired')).toBeNull();
  expect(getTranscriptFailure(state, 'active')).not.toBeNull();
});

test('recordTranscriptPushFailure stores cooldown metadata and quarantine mode', () => {
  const state = { offsets: {}, transcriptFailures: {}, transcriptPushFailures: {} };
  const failure = recordTranscriptPushFailure(
    state,
    'transcript:codex:alpha/session.jsonl',
    { status: 502, code: 'bad_gateway', message: 'proxy limit' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z'),
    { mode: 'quarantined' }
  );

  expect(failure.code).toBe('bad_gateway');
  expect(failure.mode).toBe('quarantined');
  expect(failure.cooldownUntil).toBe('2026-04-27T07:01:00.000Z');
  expect(getTranscriptPushFailure(state, 'transcript:codex:alpha/session.jsonl')?.consecutiveFailures).toBe(1);
  expect(isTranscriptPushQuarantined(state, 'transcript:codex:alpha/session.jsonl', Date.parse('2026-04-27T07:00:30.000Z'))).toBe(true);
});

test('clearTranscriptPushFailure removes per-file cooldown metadata', () => {
  const state = { offsets: {}, transcriptFailures: {}, transcriptPushFailures: {} };
  recordTranscriptPushFailure(
    state,
    'transcript:codex:alpha/session.jsonl',
    { status: 502, code: 'bad_gateway', message: 'proxy limit' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );
  expect(clearTranscriptPushFailure(state, 'transcript:codex:alpha/session.jsonl')).toBe(true);
  expect(getTranscriptPushFailure(state, 'transcript:codex:alpha/session.jsonl')).toBeNull();
  expect(clearTranscriptPushFailure(state, 'transcript:codex:alpha/session.jsonl')).toBe(false);
});

test('permanent transcript failures remain quarantined and survive expiry pruning', () => {
  const key = 'transcript:codex:alpha/permanent.jsonl';
  const state = {
    offsets: {},
    transcriptFailures: {},
    transcriptPushFailures: {
      [key]: {
        code: 'redaction_failed',
        mode: 'permanent',
        cooldownUntil: null,
      },
    },
  };

  expect(isTranscriptPushQuarantined(state, key, Date.now())).toBe(true);
  expect(pruneExpiredTranscriptPushFailures(state, Date.now())).toBe(false);
  expect(state.transcriptPushFailures[key]?.mode).toBe('permanent');
});

test('pruneExpiredTranscriptPushFailures removes expired per-file cooldown entries', () => {
  const state = { offsets: {}, transcriptFailures: {}, transcriptPushFailures: {} };
  recordTranscriptPushFailure(
    state,
    'transcript:codex:expired/session.jsonl',
    { status: 502, code: 'bad_gateway', message: 'proxy limit' },
    60_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );
  recordTranscriptPushFailure(
    state,
    'transcript:codex:active/session.jsonl',
    { status: 503, code: 'unavailable', message: 'transient upstream' },
    300_000,
    Date.parse('2026-04-27T07:00:00.000Z')
  );
  expect(pruneExpiredTranscriptPushFailures(state, Date.parse('2026-04-27T07:01:30.000Z'))).toBe(true);
  expect(getTranscriptPushFailure(state, 'transcript:codex:expired/session.jsonl')).toBeNull();
  expect(getTranscriptPushFailure(state, 'transcript:codex:active/session.jsonl')).not.toBeNull();
});
