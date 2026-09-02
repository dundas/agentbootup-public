/**
 * Byte-offset sync state for incremental transcript uploads.
 *
 * Tracks the last successfully synced byte offset for each transcript file
 * so the daemon can push only new bytes on subsequent polls.
 *
 * State is stored in ~/.agentbootup/sync-state.json (mode 0o600).
 * Directory permissions are set to 0o700 on creation.
 *
 * The state file path can be overridden via AGENTBOOTUP_SYNC_STATE_FILE for
 * test isolation.
 *
 */

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { withFileLock } from '../util/file-lock.js';

const SYNC_STATE_LOCK_STALE_MS = 20 * 60_000;
const SYNC_STATE_LOCK_WAIT_MS = SYNC_STATE_LOCK_STALE_MS * 2 + 60_000;
const DEFAULT_REDACTION_LEDGER_RETENTION_MS = 8 * 24 * 60 * 60_000;
const DEFAULT_REDACTION_LEDGER_MAX_ENTRIES = 2_000;
const DEFAULT_REDACTION_LEDGER_MAX_BYTES = 1024 * 1024;
const HARD_REDACTION_LEDGER_MAX_ENTRIES = 10_000;
const HARD_REDACTION_LEDGER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Resolve the path to the sync-state file, evaluated lazily so test env vars
 * are respected even under ES module hoisting.
 * @returns {string}
 */
export function getStateFilePath() {
  return (
    process.env.AGENTBOOTUP_SYNC_STATE_FILE ||
    path.join(os.homedir(), '.agentbootup', 'sync-state.json')
  );
}

/**
 * Serialize the complete read-decide-write transaction for sync-state.json.
 * Callers must not perform a state read before entering this callback.
 */
export async function withSyncStateLock(critical, callerOptions) {
  if (callerOptions !== undefined) {
    throw new TypeError('sync-state lock timing is canonical and cannot be overridden by callers');
  }
  const stateDirectory = path.dirname(getStateFilePath());
  await fsp.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fsp.chmod(stateDirectory, 0o700);
  return withFileLock(getStateFilePath(), critical, {
    staleMs: SYNC_STATE_LOCK_STALE_MS,
    waitMs: SYNC_STATE_LOCK_WAIT_MS,
  });
}

// Keep the on-disk envelope at v2 so the currently deployed pre-PR daemon
// still recognizes the file as a structured state object on rollback. Newer
// fields like transcriptPushFailures and redactionPartialOffsets remain additive metadata that older
// binaries safely ignore while continuing to read the offset map.
const SYNC_STATE_VERSION = 2;
const TRANSCRIPT_OFFSET_KEY_PREFIX = 'transcript:';
export const LEGACY_TRANSCRIPT_EVIDENCE_STATE = 'legacy_unverified';

function normalizeRedactionBlockLedger(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const atMs = Date.parse(entry.at || '');
    const file = String(entry.file || '').slice(0, 1024);
    const cli = String(entry.cli || '').slice(0, 64);
    const code = String(entry.code || '').slice(0, 128);
    if (!Number.isFinite(atMs) || !file || !cli || !code) return [];
    return [{
      at: new Date(atMs).toISOString(),
      file,
      cli,
      code,
      permanent: entry.permanent === true,
    }];
  });
}

function boundedPositiveInteger(value, fallback, hardMax, name, minimum = 1) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > hardMax) {
    const error = new TypeError(`${name} must be an integer between ${minimum} and ${hardMax}`);
    error.code = 'redaction_subsystem_unhealthy';
    throw error;
  }
  return parsed;
}

function redactionLedgerPolicy(options = {}) {
  const env = options.env ?? process.env;
  return {
    retentionMs: boundedPositiveInteger(
      options.retentionMs ?? env.AGENTBOOTUP_REDACTION_LEDGER_RETENTION_MS,
      DEFAULT_REDACTION_LEDGER_RETENTION_MS,
      31 * 24 * 60 * 60_000,
      'AGENTBOOTUP_REDACTION_LEDGER_RETENTION_MS',
      7 * 24 * 60 * 60_000,
    ),
    maxEntries: boundedPositiveInteger(
      options.maxEntries ?? env.AGENTBOOTUP_REDACTION_LEDGER_MAX_ENTRIES,
      DEFAULT_REDACTION_LEDGER_MAX_ENTRIES,
      HARD_REDACTION_LEDGER_MAX_ENTRIES,
      'AGENTBOOTUP_REDACTION_LEDGER_MAX_ENTRIES',
    ),
    maxBytes: boundedPositiveInteger(
      options.maxBytes ?? env.AGENTBOOTUP_REDACTION_LEDGER_MAX_BYTES,
      DEFAULT_REDACTION_LEDGER_MAX_BYTES,
      HARD_REDACTION_LEDGER_MAX_BYTES,
      'AGENTBOOTUP_REDACTION_LEDGER_MAX_BYTES',
    ),
  };
}

function redactionLedgerCapacityError() {
  const error = new Error('redaction block ledger capacity exceeded; transcript pushes remain blocked');
  error.code = 'redaction_subsystem_unhealthy';
  return error;
}

function boundedRedactionBlockLedger(value, now = Date.now(), options = {}) {
  const policy = redactionLedgerPolicy(options);
  const cutoff = now - policy.retentionMs;
  const ledger = normalizeRedactionBlockLedger(value)
    .filter((entry) => Date.parse(entry.at) >= cutoff);
  if (ledger.length > policy.maxEntries
    || Buffer.byteLength(JSON.stringify(ledger), 'utf8') > policy.maxBytes) {
    throw redactionLedgerCapacityError();
  }
  return ledger;
}

export function reconcileRedactionBlockLedgerHealth(state, now = Date.now(), options = {}) {
  const policy = redactionLedgerPolicy(options);
  const before = JSON.stringify(state.redactionBlockLedger || []);
  state.redactionBlockLedger = boundedRedactionBlockLedger(
    state.redactionBlockLedger,
    now,
    options,
  );
  let changed = before !== JSON.stringify(state.redactionBlockLedger);
  if (state.redactionLedgerUnhealthy !== true) return changed;

  // Reserve enough room for the largest normalized event. Recovery is safe only
  // when the next block is guaranteed to be durable, not merely when the current
  // ledger happens to fit under its ceiling. NUL costs six serialized bytes per
  // UTF-16 code unit (`\\u0000`), covering JSON escaping's worst case.
  const capacityProbe = {
    at: new Date(now).toISOString(),
    file: '\0'.repeat(1024),
    cli: '\0'.repeat(64),
    code: '\0'.repeat(128),
    permanent: true,
  };
  const candidate = [...state.redactionBlockLedger, capacityProbe];
  if (candidate.length <= policy.maxEntries
    && Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= policy.maxBytes) {
    state.redactionLedgerUnhealthy = false;
    changed = true;
  }
  return changed;
}

function emptyState() {
  return {
    offsets: {},
    transcriptFailures: {},
    transcriptPushFailures: {},
    redactionPartialOffsets: {},
    redactionBlockLedger: [],
    redactionLedgerUnhealthy: false,
  };
}

export function classifyLegacyOffsets(offsets, existing = {}) {
  // Evidence is derived from the live offset map. Do not retain entries whose
  // offsets were pruned after their transcript disappeared, or this metadata
  // grows by one entry for every historical session forever.
  const evidence = {};
  for (const [key, raw] of Object.entries(offsets || {})) {
    const byteOffset = raw && typeof raw === 'object' && typeof raw.lastOffset === 'number'
      ? raw.lastOffset
      : raw;
    if (typeof byteOffset !== 'number' || !Number.isFinite(byteOffset) || byteOffset < 0) continue;
    evidence[key] = {
      state: LEGACY_TRANSCRIPT_EVIDENCE_STATE,
      byteOffset,
      authority: false,
      evictionEligible: false,
    };
  }
  return evidence;
}

export function canonicalTranscriptOffsetKey(cli, relativePath) {
  const cliKey = String(cli || '').trim();
  const relKey = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!cliKey || !relKey) return null;
  return `${TRANSCRIPT_OFFSET_KEY_PREFIX}${cliKey}:${relKey}`;
}

export function isCanonicalTranscriptOffsetKey(key) {
  return typeof key === 'string' && key.startsWith(TRANSCRIPT_OFFSET_KEY_PREFIX);
}

/**
 * Migrate a parsed sync-state to the current schema version.
 * v0/v1: bare map of filePath → offset (plus optional version field).
 * v2/v3/v4: structured object with offsets + transcriptFailures, with
 * transcriptPushFailures and redactionPartialOffsets accepted as additive forward-only metadata.
 * @param {Record<string, unknown>} parsed
 * @returns {{ offsets: Record<string, number>, transcriptFailures: Record<string, unknown>, transcriptPushFailures: Record<string, unknown>, redactionPartialOffsets: Record<string, unknown> }}
 */
function migrateSyncState(parsed) {
  if (parsed?.version === SYNC_STATE_VERSION) {
    const migrated = {
      offsets:
        parsed.offsets && typeof parsed.offsets === 'object' ? parsed.offsets : {},
      transcriptFailures:
        parsed.transcriptFailures && typeof parsed.transcriptFailures === 'object'
          ? parsed.transcriptFailures
          : {},
      transcriptPushFailures:
        parsed.transcriptPushFailures && typeof parsed.transcriptPushFailures === 'object'
          ? parsed.transcriptPushFailures
          : {},
      redactionPartialOffsets:
        parsed.redactionPartialOffsets && typeof parsed.redactionPartialOffsets === 'object'
          ? parsed.redactionPartialOffsets
          : {},
      redactionBlockLedger: boundedRedactionBlockLedger(parsed.redactionBlockLedger),
      redactionLedgerUnhealthy: parsed.redactionLedgerUnhealthy === true,
    };
    const evidence = classifyLegacyOffsets(migrated.offsets, parsed.legacyTranscriptEvidence);
    if (Object.keys(evidence).length > 0) migrated.legacyTranscriptEvidence = evidence;
    return migrated;
  }
  if (parsed?.version === 2 || parsed?.version === 3) {
    const migrated = {
      offsets:
        parsed.offsets && typeof parsed.offsets === 'object' ? parsed.offsets : {},
      transcriptFailures:
        parsed.transcriptFailures && typeof parsed.transcriptFailures === 'object'
          ? parsed.transcriptFailures
          : {},
      transcriptPushFailures:
        parsed.transcriptPushFailures && typeof parsed.transcriptPushFailures === 'object'
          ? parsed.transcriptPushFailures
          : {},
      redactionPartialOffsets:
        parsed.redactionPartialOffsets && typeof parsed.redactionPartialOffsets === 'object'
          ? parsed.redactionPartialOffsets
          : {},
      redactionBlockLedger: boundedRedactionBlockLedger(parsed.redactionBlockLedger),
      redactionLedgerUnhealthy: parsed.redactionLedgerUnhealthy === true,
    };
    const evidence = classifyLegacyOffsets(migrated.offsets, parsed.legacyTranscriptEvidence);
    if (Object.keys(evidence).length > 0) migrated.legacyTranscriptEvidence = evidence;
    return migrated;
  }
  // v0/v1: no structured state yet — treat the whole object as the offset map.
  const { version: _v, ...rest } = parsed;
  const migrated = {
    offsets: rest,
    transcriptFailures: {},
    transcriptPushFailures: {},
    redactionPartialOffsets: {},
    redactionBlockLedger: [],
    redactionLedgerUnhealthy: false,
  };
  const evidence = classifyLegacyOffsets(migrated.offsets);
  if (Object.keys(evidence).length > 0) migrated.legacyTranscriptEvidence = evidence;
  return migrated;
}

/**
 * Read the full sync-state object.
 * Returns an empty structured state if the file does not exist or cannot be parsed.
 * @returns {Promise<{ offsets: Record<string, number>, transcriptFailures: Record<string, unknown>, transcriptPushFailures: Record<string, unknown>, redactionPartialOffsets: Record<string, unknown> }>}
 */
export async function readSyncState() {
  const stateFile = getStateFilePath();
  try {
    const raw = await fsp.readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return migrateSyncState(parsed);
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return emptyState();
    throw err;
  }
}

/**
 * Persist the full sync-state object.
 *
 * Writes atomically via a `.tmp` file + `rename()` to avoid leaving a
 * partially-written JSON file on SIGKILL mid-write.
 *
 * Creates the parent directory (mode 0o700) if it does not exist.
 * chmod after mkdir/writeFile corrects permissions on pre-existing
 * directories and files (mode in mkdir/writeFile only applies to new ones).
 * @param {{ offsets?: Record<string, number>, transcriptFailures?: Record<string, unknown>, transcriptPushFailures?: Record<string, unknown>, redactionPartialOffsets?: Record<string, unknown> } | Record<string, number>} state
 */
export async function writeSyncState(state) {
  const stateFile = getStateFilePath();
  const dir = path.dirname(stateFile);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
  const tmpFile = stateFile + '.tmp';
  const legacyTranscriptEvidence = state && typeof state === 'object' && 'offsets' in state
    ? classifyLegacyOffsets(state.offsets, state.legacyTranscriptEvidence)
    : {};
  const normalized =
    state && typeof state === 'object' && 'offsets' in state
      ? {
          offsets:
            state.offsets && typeof state.offsets === 'object' ? state.offsets : {},
          transcriptFailures:
            state.transcriptFailures && typeof state.transcriptFailures === 'object'
              ? state.transcriptFailures
              : {},
          transcriptPushFailures:
            state.transcriptPushFailures && typeof state.transcriptPushFailures === 'object'
              ? state.transcriptPushFailures
              : {},
          redactionPartialOffsets:
            state.redactionPartialOffsets && typeof state.redactionPartialOffsets === 'object'
              ? state.redactionPartialOffsets
              : {},
          redactionBlockLedger: boundedRedactionBlockLedger(state.redactionBlockLedger),
          redactionLedgerUnhealthy: state.redactionLedgerUnhealthy === true,
          ...(Object.keys(legacyTranscriptEvidence).length > 0
            ? { legacyTranscriptEvidence }
            : {}),
        }
      : {
          offsets: state || {}, transcriptFailures: {}, transcriptPushFailures: {},
          redactionPartialOffsets: {}, redactionBlockLedger: [],
          redactionLedgerUnhealthy: false,
        };
  // Write with version field so future schema changes have a migration path.
  await fsp.writeFile(
    tmpFile,
    JSON.stringify({ version: SYNC_STATE_VERSION, ...normalized }, null, 2) + '\n',
    { mode: 0o600 }
  );
  // rename() is atomic on POSIX; the destination inherits the tmp file's mode.
  await fsp.rename(tmpFile, stateFile);
  await fsp.chmod(stateFile, 0o600);
}

/**
 * Get the stored byte offset for a file, defaulting to 0.
 * @param {{ offsets?: Record<string, number> } | Record<string, number>} state
 * @param {string} filePath  Absolute file path used as the map key.
 * @returns {number}
 */
export function getFileOffset(state, filePath) {
  const offsets =
    state && typeof state === 'object' && 'offsets' in state ? state.offsets || {} : state || {};
  const v = offsets[filePath];
  // Migration shim: the session-end hooks (PR #32) stored offsets as nested
  // objects `{ lastOffset: number, lastPushedAt: string }` rather than the
  // flat `{ [filePath]: number }` that this module uses.
  // Handle both so upgrading users don't re-push already-synced bytes.
  if (v !== null && typeof v === 'object' && typeof v.lastOffset === 'number') {
    return v.lastOffset >= 0 ? v.lastOffset : 0;
  }
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function getTranscriptFailure(state, brainId) {
  if (!state || typeof state !== 'object' || !brainId) return null;
  const failures = state.transcriptFailures;
  if (!failures || typeof failures !== 'object') return null;
  const entry = failures[brainId];
  return entry && typeof entry === 'object' ? entry : null;
}

export function isTranscriptBrainQuarantined(state, brainId, now = Date.now()) {
  const failure = getTranscriptFailure(state, brainId);
  if (!failure) return false;
  const untilMs = Date.parse(failure.cooldownUntil || '');
  return Number.isFinite(untilMs) && untilMs > now;
}

export function recordTranscriptBrainFailure(state, brainId, failure, cooldownMs, now = Date.now()) {
  if (!state.transcriptFailures || typeof state.transcriptFailures !== 'object') {
    state.transcriptFailures = {};
  }
  const previous = getTranscriptFailure(state, brainId);
  const failedAt = new Date(now).toISOString();
  const cooldownUntil = new Date(now + cooldownMs).toISOString();
  state.transcriptFailures[brainId] = {
    status: failure.status,
    code: failure.code || 'unknown',
    message: failure.message || '',
    failedAt,
    cooldownUntil,
    consecutiveFailures: (previous?.consecutiveFailures || 0) + 1,
  };
  return state.transcriptFailures[brainId];
}

export function clearTranscriptBrainFailure(state, brainId) {
  if (!state.transcriptFailures || typeof state.transcriptFailures !== 'object') return false;
  if (!(brainId in state.transcriptFailures)) return false;
  delete state.transcriptFailures[brainId];
  return true;
}

export function pruneExpiredTranscriptFailures(state, now = Date.now()) {
  if (!state.transcriptFailures || typeof state.transcriptFailures !== 'object') return false;
  let changed = false;
  for (const [brainId, failure] of Object.entries(state.transcriptFailures)) {
    const untilMs = Date.parse(failure?.cooldownUntil || '');
    if (!Number.isFinite(untilMs) || untilMs <= now) {
      delete state.transcriptFailures[brainId];
      changed = true;
    }
  }
  return changed;
}

export function getTranscriptPushFailure(state, fileKey) {
  if (!state || typeof state !== 'object' || !fileKey) return null;
  const failures = state.transcriptPushFailures;
  if (!failures || typeof failures !== 'object') return null;
  const entry = failures[fileKey];
  return entry && typeof entry === 'object' ? entry : null;
}

export function appendRedactionBlockEvent(state, event, now = Date.now(), options = {}) {
  const policy = redactionLedgerPolicy(options);
  state.redactionBlockLedger = boundedRedactionBlockLedger(state.redactionBlockLedger, now, options);
  const file = String(event?.file || '').slice(0, 1024);
  const cli = String(event?.cli || '').slice(0, 64);
  const code = String(event?.code || 'redaction_failed').slice(0, 128);
  if (!file || !cli) throw new TypeError('redaction block events require file and cli');
  const entry = {
    at: new Date(now).toISOString(),
    file,
    cli,
    code,
    permanent: event?.permanent === true,
  };
  const candidate = [...state.redactionBlockLedger, entry];
  const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
  if (candidate.length > policy.maxEntries || candidateBytes > policy.maxBytes) {
    throw redactionLedgerCapacityError();
  }
  state.redactionBlockLedger = candidate;
  return entry;
}

export function isTranscriptPushQuarantined(state, fileKey, now = Date.now()) {
  const failure = getTranscriptPushFailure(state, fileKey);
  if (!failure) return false;
  if (failure.mode === 'permanent') return true;
  const untilMs = Date.parse(failure.cooldownUntil || '');
  return Number.isFinite(untilMs) && untilMs > now;
}

export function recordTranscriptPushFailure(state, fileKey, failure, cooldownMs, now = Date.now(), metadata = {}) {
  if (!state.transcriptPushFailures || typeof state.transcriptPushFailures !== 'object') {
    state.transcriptPushFailures = {};
  }
  const previous = getTranscriptPushFailure(state, fileKey);
  const failedAt = new Date(now).toISOString();
  const cooldownUntil = new Date(now + cooldownMs).toISOString();
  state.transcriptPushFailures[fileKey] = {
    status: failure.status,
    code: failure.code || 'unknown',
    message: failure.message || '',
    failedAt,
    cooldownUntil,
    consecutiveFailures: (previous?.consecutiveFailures || 0) + 1,
    mode: metadata.mode || previous?.mode || 'backoff',
    retryAfterMs: cooldownMs,
  };
  return state.transcriptPushFailures[fileKey];
}

export function clearTranscriptPushFailure(state, fileKey) {
  if (!state.transcriptPushFailures || typeof state.transcriptPushFailures !== 'object') return false;
  if (!(fileKey in state.transcriptPushFailures)) return false;
  delete state.transcriptPushFailures[fileKey];
  return true;
}

export function pruneExpiredTranscriptPushFailures(state, now = Date.now()) {
  if (!state.transcriptPushFailures || typeof state.transcriptPushFailures !== 'object') return false;
  let changed = false;
  for (const [fileKey, failure] of Object.entries(state.transcriptPushFailures)) {
    if (failure?.mode === 'permanent') continue;
    const untilMs = Date.parse(failure?.cooldownUntil || '');
    if (!Number.isFinite(untilMs) || untilMs <= now) {
      delete state.transcriptPushFailures[fileKey];
      changed = true;
    }
  }
  return changed;
}
