#!/usr/bin/env node
/**
 * Transcript Sync Daemon
 *
 * Watches AI CLI transcript directories and sends complete files that fit the
 * bounded legacy v1 request to POST /v1/sync/transcripts/push.
 *
 * Startup requirements:
 *   1. API credentials configured: `agentbootup auth login --api-key <key>`
 *   2. Either:
 *      - single-brain mode: `agentbootup config set-brain <id>`
 *      - multi-brain mode:  `agentbootup config set-network-root <path>`
 *
 * Existing byte offsets in ~/.agentbootup/sync-state.json are retained only as
 * `legacy_unverified` migration evidence. Growing files with a positive offset
 * fail closed until archive v2 can re-upload a verified complete generation;
 * v1 suffix uploads are never transmitted because they overwrite remote files.
 *
 * File watching:
 *   - fs.watch({ recursive: true }) on each CLI root (real-time events).
 *   - A 30-second polling fallback handles events that fs.watch may miss.
 *
 * A health/status HTTP server listens on 127.0.0.1:8766.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import { createHmac, randomBytes } from 'node:crypto';
import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { getBrainId } from '../config/config.js';
import { getMachineId, getMachineInfo } from '../machine-id/machine-id.js';
import { getNetworkProjects } from './daemon-registry.js';
import {
  buildTranscriptProjectIndex,
  normalizeProjectPath,
  resolveGitProjectRoot,
  resolveGitProjectRoots,
  resolveTranscriptBrainId,
} from './transcript-brain-routing.js';
import {
  readSyncState,
  writeSyncState,
  withSyncStateLock,
  getFileOffset,
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
  appendRedactionBlockEvent,
  reconcileRedactionBlockLedgerHealth,
  classifyLegacyOffsets,
} from '../sync-state/sync-state.js';
import { isPlausibleServerUrl, apiUrl } from '../auth/validate.js';
import { verifyBrainRegistered, isNotFoundBrainResponse } from './brain-quarantine.mjs';
import { isProcessAlive } from '../process/pid-utils.js';
import {
  CLI_TRANSCRIPT_SOURCES,
  discoverTranscriptInventory,
  getTranscriptSourceRoot as getCanonicalTranscriptSourceRoot,
} from '../brain/transcript-discovery.js';
import { createDenylistManager } from './redaction-denylist.js';
import { redactContent } from '../runtime-adapters/redaction.js';
import { findRawSecretViolations } from '../runtime-adapters/security.js';

// ── Errors ────────────────────────────────────────────────────────────────────

class WatchdogTimeoutError extends Error {}

// ── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;
/** 4 MB raw → ~5.3 MB base64, safely under the 10 MB server request limit. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_TRANSCRIPT_BATCH_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TRANSCRIPT_5XX_BACKOFF_BASE_MS = 30_000;
const DEFAULT_TRANSCRIPT_5XX_BACKOFF_CAP_MS = 5 * 60_000;
const DEFAULT_TRANSCRIPT_5XX_QUARANTINE_AFTER = 3;
const DEFAULT_TRANSCRIPT_5XX_QUARANTINE_RETRY_MS = 15 * 60_000;
const DEFAULT_REDACTION_BLOCK_RETRIES = 3;
const DEFAULT_TRANSCRIPT_STALE_PROGRESS_MS = 15 * 60_000;
const DEFAULT_TRANSCRIPT_MAX_BACKLOG_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_TRANSCRIPT_DEADLINE_FAILURES = 2;
const PUSH_TIMEOUT_MS = 30_000;
export const TRANSCRIPT_HEALTH_HOST = '127.0.0.1';
/** Max wall time before a cycle is invalidated and cancellation begins. */
const SYNC_OVERALL_TIMEOUT_MS = 600_000;
const LEGACY_CONTAINMENT_FAILURE_CODES = new Set([
  'legacy_delta_rejected',
  'legacy_file_too_large',
  'legacy_request_too_large',
]);
const BRAIN_404_COOLDOWN_MS =
  Number(process.env.AGENTBOOTUP_BRAIN_404_COOLDOWN_MS) || 15 * 60_000;
/** Health server port — must stay in sync with HEALTH_PORT in unified-daemon-cli.js. Override via AGENTBOOTUP_DAEMON_PORT. */
const HEALTH_PORT = Number(process.env.AGENTBOOTUP_DAEMON_PORT) || 8766;
const SYNC_DEBOUNCE_MS = 2_000;
const LOG_PREFIX = '[transcript-sync]';
const loggedUnmappedTranscriptPaths = new Set();
const loggedContainmentRejections = new Set();
const MAX_LOGGED_UNMAPPED_TRANSCRIPT_PATHS = 10_000;
let redactionLogHmacKey = randomBytes(32);

export function configureRedactionLogHmacKey(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    const error = new TypeError('redaction log HMAC secret must be non-empty');
    error.code = 'redaction_subsystem_unhealthy';
    throw error;
  }
  redactionLogHmacKey = createHmac('sha256', secret)
    .update('agentbootup:transcript-redaction-log:v1', 'utf8')
    .digest();
}

export function isTranscriptRedactionDisabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.AGENTBOOTUP_REDACT_DISABLE || '').trim().toLowerCase(),
  );
}

function getRedactionBlockRetries(runtime = {}) {
  const raw = Number(
    runtime.redactionBlockRetries
      ?? runtime.env?.AGENTBOOTUP_REDACT_BLOCK_RETRIES
      ?? process.env.AGENTBOOTUP_REDACT_BLOCK_RETRIES,
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_REDACTION_BLOCK_RETRIES;
}

function getScopedProjectIdsFromEnv(env = process.env) {
  const raw = env.AGENTBOOTUP_TRANSCRIPT_PROJECT_IDS;
  if (!raw || !raw.trim()) return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

export function scopeTranscriptProjects(projects, scopedIds) {
  if (!Array.isArray(projects) || projects.length === 0) return [];
  if (!scopedIds || scopedIds.length === 0) return projects;
  const allowed = new Set(scopedIds);
  return projects.filter((project) => allowed.has(project.id));
}

export function getUnknownScopedTranscriptProjectIds(projects, scopedIds) {
  if (!scopedIds || scopedIds.length === 0) return [];
  const knownIds = new Set((projects || []).map((project) => project.id));
  return scopedIds.filter((id) => !knownIds.has(id));
}

export function collectDenylistProjectRoots(projects = [], singleProjectScope = null, runtime = {}) {
  const roots = [];
  const addProjectRoots = (projectPath) => {
    if (!projectPath) return;
    roots.push(projectPath);
    const gitRoots = resolveGitProjectRoots(projectPath, runtime);
    if (gitRoots?.worktreeRoot) roots.push(gitRoots.worktreeRoot);
    if (gitRoots?.ownerRoot) roots.push(gitRoots.ownerRoot);
    if (!gitRoots) {
      const repositoryRoot = resolveGitProjectRoot(projectPath, runtime);
      if (repositoryRoot) roots.push(repositoryRoot);
    }
  };
  for (const project of projects || []) {
    if (!project?.path) continue;
    addProjectRoots(project.path);
  }
  addProjectRoots(singleProjectScope?.projectRoot);
  if (singleProjectScope?.repositoryRoot) roots.push(singleProjectScope.repositoryRoot);
  return [...new Set(roots)];
}

// ── CLI source definitions ───────────────────────────────────────────────────

/**
 * Each entry describes one CLI's transcript directory and the file matcher.
 * The daemon only collects from each CLI's own directory (not cross-tool).
 */
const CLI_SOURCES = CLI_TRANSCRIPT_SOURCES;

// ── Runtime stats ────────────────────────────────────────────────────────────

const stats = {
  startedAt: new Date().toISOString(),
  pushes: 0,
  errors: 0,
  filesWatched: 0,
  lastSyncAt: null,
  lastSkippedQuarantined: 0,
  lastSkippedBackoff: 0,
  lastQuarantinedBrains: {},
  lastQuarantinedFiles: {},
  detectedUnsupported: [],
  pendingFiles: 0,
  unmappedFiles: 0,
  oldestPendingAt: null,
  lastCompletedAt: null,
  lastSuccessfulProgressAt: null,
  lastRemoteErrorAt: null,
  activeFailureCount: 0,
  containmentFailureCount: 0,
  consecutiveFailedCycles: 0,
  consecutiveDeadlineOverruns: 0,
  syncQueueDepth: 0,
  coalescedSyncRequests: 0,
  throttleResponses: 0,
  retryAfterCooldowns: 0,
  redaction: {
    enabled: true,
    redaction_disabled: false,
    redaction_subsystem_unhealthy: false,
    redaction_ledger_unhealthy: false,
    redaction_blocked_permanent: false,
    denylist_size: 0,
    blocked_files: [],
    block_ledger: [],
    block_ledger_total: 0,
    block_ledger_truncated: false,
    total_replacements: 0,
  },
  // Legacy v1 can show transport activity, but it cannot prove an immutable,
  // replicated, read-back-verified archive. Phase 0 therefore remains
  // blocked_durability until archive v2 supplies authoritative evidence.
  durabilityBlocked: true,
};

export function assessTranscriptBackupHealth(snapshot, options = {}) {
  const now = options.now ?? Date.now();
  const staleProgressMs = options.staleProgressMs
    ?? (Number(process.env.AGENTBOOTUP_TRANSCRIPT_STALE_PROGRESS_MS)
      || DEFAULT_TRANSCRIPT_STALE_PROGRESS_MS);
  const deadlineFailureThreshold = options.deadlineFailureThreshold
    ?? (Number(process.env.AGENTBOOTUP_TRANSCRIPT_DEADLINE_FAILURES)
      || DEFAULT_TRANSCRIPT_DEADLINE_FAILURES);
  const maxBacklogAgeMs = options.maxBacklogAgeMs
    ?? (Number(process.env.AGENTBOOTUP_TRANSCRIPT_MAX_BACKLOG_AGE_MS)
      || DEFAULT_TRANSCRIPT_MAX_BACKLOG_AGE_MS);
  const reasons = [];
  if (snapshot?.redaction?.redaction_disabled) {
    reasons.push('redaction_disabled');
    return { healthy: false, state: 'blocked_redaction', reasons, authority: 'legacy_unverified' };
  }
  if (snapshot?.redaction?.redaction_ledger_unhealthy) {
    reasons.push('redaction_ledger_unhealthy');
    return { healthy: false, state: 'blocked_redaction', reasons, authority: 'legacy_unverified' };
  }
  if (snapshot?.redaction?.redaction_subsystem_unhealthy) {
    reasons.push('redaction_subsystem_unhealthy');
    return { healthy: false, state: 'blocked_redaction', reasons, authority: 'legacy_unverified' };
  }
  if (snapshot?.redaction?.redaction_blocked_permanent) {
    reasons.push('redaction_blocked_permanent');
    return { healthy: false, state: 'quarantined_redaction', reasons, authority: 'legacy_unverified' };
  }
  if ((snapshot?.redaction?.blocked_files?.length || 0) > 0) {
    reasons.push('redaction_failed');
    return { healthy: false, state: 'blocked_redaction', reasons, authority: 'legacy_unverified' };
  }
  const lastProgressMs = Date.parse(
    snapshot?.lastSuccessfulProgressAt || snapshot?.lastCompletedAt || snapshot?.startedAt || '',
  );
  const stale = (snapshot?.pendingFiles || 0) > 0
    && (!Number.isFinite(lastProgressMs) || now - lastProgressMs > staleProgressMs);
  const oldestPendingMs = Date.parse(snapshot?.oldestPendingAt || '');
  const backlogTooOld = (snapshot?.pendingFiles || 0) > 0
    && Number.isFinite(oldestPendingMs)
    && now - oldestPendingMs > maxBacklogAgeMs;

  if ((snapshot?.consecutiveDeadlineOverruns || 0) >= deadlineFailureThreshold) {
    reasons.push('repeated_deadline_overruns');
    return { healthy: false, state: 'error', reasons, authority: 'legacy_unverified' };
  }
  if (
    (snapshot?.consecutiveFailedCycles || 0) > 0
    || (snapshot?.activeFailureCount || 0) > 0
    || snapshot?.lastRemoteErrorAt
    || snapshot?.lastRemoteVerificationErrorAt
  ) {
    reasons.push(snapshot?.lastRemoteVerificationErrorAt ? 'remote_verification_error' : 'remote_sync_error');
    return { healthy: false, state: 'degraded_remote', reasons, authority: 'legacy_unverified' };
  }
  if ((snapshot?.unmappedFiles || 0) > 0) {
    reasons.push('unmapped_transcripts');
    return { healthy: false, state: 'blocked_identity', reasons, authority: 'legacy_unverified' };
  }
  // Known Phase-0 containment is not a transport outage. Keep this state ahead
  // of backlog aging so existing positive-offset files report the planned
  // durability block instead of a permanent false remote incident.
  if (
    snapshot?.durabilityBlocked !== false
    && (snapshot?.containmentFailureCount || 0) > 0
  ) {
    reasons.push('legacy_v1_has_no_archive_durability');
    return { healthy: false, state: 'blocked_durability', reasons, authority: 'legacy_unverified' };
  }
  if (stale) {
    reasons.push('stale_progress');
    return { healthy: false, state: 'working_backlog', reasons, authority: 'legacy_unverified' };
  }
  if (backlogTooOld) {
    reasons.push('backlog_age_exceeded');
    return { healthy: false, state: 'working_backlog', reasons, authority: 'legacy_unverified' };
  }
  if (snapshot?.durabilityBlocked !== false) {
    reasons.push('legacy_v1_has_no_archive_durability');
    return { healthy: false, state: 'blocked_durability', reasons, authority: 'legacy_unverified' };
  }
  return {
    healthy: true,
    state: (snapshot?.pendingFiles || 0) > 0 ? 'working_backlog' : 'caught_up',
    reasons,
    authority: 'archive_verified',
  };
}

export function applyTranscriptCycleHealthStats(snapshot, cycle, completedAt) {
  const activeFailureCount = cycle?.activeFailureCount || 0;
  const remoteErrCount = Math.max(
    0,
    (cycle?.errCount || 0) - (cycle?.containmentErrCount || 0) - (cycle?.redactionErrCount || 0),
  );
  const remoteActiveFailureCount = Math.max(
    0,
    activeFailureCount - (cycle?.redactionFailureCount || 0),
  );
  const hasFailureEvidence = remoteActiveFailureCount > 0
    || (cycle?.skippedQuarantined || 0) > 0;
  const cycleFailed = remoteErrCount > 0;
  const recovered = !cycleFailed && !hasFailureEvidence;
  const result = {
    pendingFiles: cycle?.pendingFiles || 0,
    activeFailureCount,
    containmentFailureCount: cycle?.containmentFailureCount || 0,
    lastCompletedAt: completedAt,
    consecutiveFailedCycles: cycleFailed
      ? (snapshot?.consecutiveFailedCycles || 0) + 1
      : (hasFailureEvidence ? Math.max(1, snapshot?.consecutiveFailedCycles || 0) : 0),
    lastRemoteErrorAt: cycleFailed
      ? completedAt
      : (hasFailureEvidence ? (snapshot?.lastRemoteErrorAt || completedAt) : null),
    lastSuccessfulProgressAt: snapshot?.lastSuccessfulProgressAt || null,
  };
  if (recovered && ((cycle?.pushCount || 0) > 0 || result.pendingFiles === 0)) {
    result.lastSuccessfulProgressAt = completedAt;
  }
  return result;
}

export function buildTranscriptHealthPayload(snapshot, uptime = process.uptime(), options = {}) {
  const backup = assessTranscriptBackupHealth(snapshot, options);
  return {
    healthy: backup.healthy,
    liveness: { healthy: true, uptime },
    backup,
    redaction: snapshot?.redaction || null,
  };
}

function redactionBlockedFilesFromState(state, now = Date.now()) {
  return Object.entries(state?.transcriptPushFailures || {})
    .filter(([file, failure]) => failure?.code === 'redaction_failed'
      && isTranscriptPushQuarantined(state, file, now))
    .map(([file, failure]) => ({
      path: file,
      code: failure.mode === 'permanent' ? 'redaction_blocked_permanent' : 'redaction_failed',
    }));
}

function redactionHealthLedgerView(ledger, env = process.env) {
  const configured = Number(env.AGENTBOOTUP_REDACTION_HEALTH_LEDGER_ENTRIES);
  const limit = Number.isSafeInteger(configured) && configured > 0 && configured <= 500
    ? configured
    : 100;
  const normalized = Array.isArray(ledger) ? ledger : [];
  return {
    entries: normalized.slice(-limit).map((entry) => ({
      ...entry,
      file: redactionLogFileId(entry.file),
    })),
    total: normalized.length,
    truncated: normalized.length > limit,
  };
}

export function hydrateRedactionHealthFromState(redactionHealth, state, options = {}) {
  const blockedFiles = redactionBlockedFilesFromState(state, options.now ?? Date.now());
  const ledger = redactionHealthLedgerView(state?.redactionBlockLedger, options.env);
  redactionHealth.blocked_files = blockedFiles;
  redactionHealth.block_ledger = ledger.entries;
  redactionHealth.block_ledger_total = ledger.total;
  redactionHealth.block_ledger_truncated = ledger.truncated;
  redactionHealth.redaction_blocked_permanent = blockedFiles
    .some((failure) => failure.code === 'redaction_blocked_permanent');
  redactionHealth.redaction_ledger_unhealthy = state?.redactionLedgerUnhealthy === true;
  redactionHealth.redaction_subsystem_unhealthy = state?.redactionLedgerUnhealthy === true;
  return redactionHealth;
}

export async function persistAcceptedTranscriptCheckpoint(
  nextState,
  writeState = writeSyncState,
) {
  // Once the remote accepted a write, its offset must survive even if the
  // watchdog invalidated this cycle while the response was being parsed. The
  // caller still holds both the remote-write lease and sync-state lock here.
  await writeState(nextState);
}

export async function persistTranscriptSyncResult(result, writeState = writeSyncState) {
  if (result.stateChanged) await writeState(result.nextState);
  if (result.redactionSubsystemError) {
    const error = new Error(result.redactionSubsystemError.message);
    error.code = result.redactionSubsystemError.code;
    error.persistedSyncState = result.nextState;
    throw error;
  }
  return result;
}

export async function prepareTranscriptRedactionLedgerState(
  state,
  options = {},
) {
  const changed = reconcileRedactionBlockLedgerHealth(
    state,
    options.now ?? Date.now(),
    options.redactionLedgerOptions,
  );
  if (state.redactionLedgerUnhealthy) {
    const error = new Error(
      'redaction block ledger has no reserved capacity; transcript pushes remain blocked',
    );
    error.code = 'redaction_subsystem_unhealthy';
    error.persistedSyncState = state;
    throw error;
  }
  if (changed) await (options.writeState ?? writeSyncState)(state);
  return state;
}

export async function hydrateStartupTranscriptRedactionHealth(
  redactionHealth,
  runtime = {},
) {
  try {
    await (runtime.withStateLock ?? withSyncStateLock)(async () => {
      hydrateRedactionHealthFromState(
        redactionHealth,
        await (runtime.readState ?? readSyncState)(),
      );
    });
    return true;
  } catch (error) {
    if (!String(error?.code || '').startsWith('redaction_')) throw error;
    redactionHealth.redaction_ledger_unhealthy = true;
    redactionHealth.redaction_subsystem_unhealthy = true;
    (runtime.logErrorFn ?? logError)('Startup sync-state redaction health is fail-closed', error);
    return false;
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`${new Date().toISOString()} ${LOG_PREFIX} ${msg}\n`);
}

function logError(msg, err) {
  process.stderr.write(
    `${new Date().toISOString()} ${LOG_PREFIX} ERROR ${msg}${err ? ': ' + err.message : ''}\n`
  );
}

// ── File discovery ───────────────────────────────────────────────────────────

/**
 * Async generator: yields all files under `dir` up to `maxDepth` levels deep.
 * Symbolic links are skipped to prevent infinite loops.
 * @param {string} dir
 * @param {number} depth
 * @yields {string}
 */
/**
 * Discover all transcript files across all watched CLI directories.
 * Source roots come from the canonical discovery registry, including explicit
 * AGENTBOOTUP_RESTORE_ROOT_* overrides when an installation redirects them.
 * @returns {Promise<{files: Array<{cli: string, path: string, filename: string, relative_path: string}>, unsupported: Array<object>}>>}
 */
async function discoverAllTranscripts() {
  return discoverTranscriptInventory();
}

// ── Sync logic ───────────────────────────────────────────────────────────────

/**
 * Tracks the currently-running _doSync call. Used by `shutdown` to await
 * completion, and by `syncPendingFiles` to skip concurrent invocations.
 *
 * Events that arrive while a sync is in flight are intentionally dropped rather
 * than queued — the 30-second poll ensures every change is picked up within
 * one cycle. This keeps the control flow simple at the cost of up-to-30 s
 * extra latency for very rapid writes during a long sync.
 */
let syncPromise = null;
let activeSyncCycle = null;
let nextSyncCycleId = 0;

export function getSyncOverallTimeoutMs(runtime = {}) {
  const configured = Number(
    runtime.timeoutMs ?? runtime.env?.AGENTBOOTUP_TRANSCRIPT_SYNC_TIMEOUT_MS
      ?? process.env.AGENTBOOTUP_TRANSCRIPT_SYNC_TIMEOUT_MS,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : SYNC_OVERALL_TIMEOUT_MS;
}

export function getSyncHardReleaseGraceMs(runtime = {}, timeoutMs = getSyncOverallTimeoutMs(runtime)) {
  const configured = Number(
    runtime.hardReleaseGraceMs
      ?? runtime.env?.AGENTBOOTUP_TRANSCRIPT_WATCHDOG_RELEASE_GRACE_MS
      ?? process.env.AGENTBOOTUP_TRANSCRIPT_WATCHDOG_RELEASE_GRACE_MS,
  );
  return Number.isFinite(configured) && configured >= 0 ? configured : timeoutMs;
}

export function getSyncRemoteWriteMaxRetentionMs(runtime = {}, timeoutMs = getSyncOverallTimeoutMs(runtime)) {
  const configured = Number(
    runtime.remoteWriteMaxRetentionMs
      ?? runtime.env?.AGENTBOOTUP_TRANSCRIPT_WATCHDOG_REMOTE_WRITE_MAX_RETENTION_MS
      ?? process.env.AGENTBOOTUP_TRANSCRIPT_WATCHDOG_REMOTE_WRITE_MAX_RETENTION_MS,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : timeoutMs * 3;
}

/**
 * Send safe complete v1 files and fail closed for legacy deltas or files that
 * exceed the complete-file request limit.
 *
 * If a sync is already in progress the call returns the existing Promise so
 * the caller can await it without starting a second concurrent sync.
 * This allows `shutdown()` to wait for an in-flight sync before the final flush.
 *
 * State is flushed once per full scan — see inline comment before writeSyncState.
 *
 * @param {string} brainId
 * @param {string} machineId
 * @param {string} apiKey
 * @param {string} serverUrl
 * @returns {Promise<void>}
 */
export async function syncPendingFiles(
  defaultBrainId,
  projectIndex,
  machineId,
  apiKey,
  serverUrl,
  runtime = {},
) {
  const logFn = runtime.logFn || log;
  const logErrorFn = runtime.logErrorFn || logError;
  const statsTarget = runtime.statsTarget || stats;
  if (activeSyncCycle) {
    statsTarget.coalescedSyncRequests = (statsTarget.coalescedSyncRequests || 0) + 1;
    statsTarget.syncQueueDepth = 1;
    logFn('Sync already in progress, skipping');
    return activeSyncCycle.publicPromise;
  }

  const id = ++nextSyncCycleId;
  statsTarget.syncQueueDepth = 1;
  const controller = new AbortController();
  const timeoutMs = getSyncOverallTimeoutMs(runtime);
  const remoteWriteMaxRetentionMs = getSyncRemoteWriteMaxRetentionMs(runtime, timeoutMs);
  const nowIso = runtime.nowIso || (() => new Date().toISOString());
  const execute = runtime.execute || _doSync;
  let timedOut = false;
  let timeoutId;
  let hardReleaseId;
  const cycle = {
    id,
    signal: controller.signal,
    isCurrent: () => activeSyncCycle?.id === id && !timedOut,
    remoteWritesInFlight: 0,
    beginRemoteWrite() {
      if (!this.isCurrent()) return false;
      this.remoteWritesInFlight += 1;
      return true;
    },
    endRemoteWrite() {
      this.remoteWritesInFlight = Math.max(0, this.remoteWritesInFlight - 1);
    },
  };

  const operation = Promise.resolve().then(() => execute(
    defaultBrainId,
    projectIndex,
    machineId,
    apiKey,
    serverUrl,
    cycle,
    runtime,
  ));
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      const releaseGraceMs = getSyncHardReleaseGraceMs(runtime, timeoutMs);
      const retentionPollMs = Math.max(1, releaseGraceMs);
      let elapsedSinceTimeoutMs = 0;
      const scheduleHardReleaseCheck = (delayMs) => {
        const boundedDelayMs = Math.max(0, delayMs);
        hardReleaseId = setTimeout(() => {
          elapsedSinceTimeoutMs += boundedDelayMs;
          attemptHardRelease();
        }, boundedDelayMs);
      };
      const attemptHardRelease = () => {
        if (activeSyncCycle?.id !== id) return;
        if (cycle.remoteWritesInFlight > 0) {
          if (elapsedSinceTimeoutMs >= remoteWriteMaxRetentionMs) {
            logFn(
              `WATCHDOG: remote write remained wedged for ${elapsedSinceTimeoutMs}ms; terminating for supervised restart`,
            );
            const terminate = runtime.onWedgedRemoteWrite || (() => process.exit(1));
            terminate({ cycleId: id, retentionMs: elapsedSinceTimeoutMs });
            // Production termination does not return. An injected/test handler
            // may return, so keep the lock and retry rather than permitting an
            // overlapping remote writer or silently wedging without escalation.
            scheduleHardReleaseCheck(retentionPollMs);
            return;
          }
          logFn(
            `WATCHDOG: retaining cycle ${id}; ${cycle.remoteWritesInFlight} remote write(s) still in flight`,
          );
          scheduleHardReleaseCheck(Math.min(
            retentionPollMs,
            remoteWriteMaxRetentionMs - elapsedSinceTimeoutMs,
          ));
          return;
        }
        if (elapsedSinceTimeoutMs < releaseGraceMs) {
          scheduleHardReleaseCheck(releaseGraceMs - elapsedSinceTimeoutMs);
          return;
        }
        activeSyncCycle = null;
        if (syncPromise === completion) syncPromise = null;
        logFn(`WATCHDOG: released wedged cycle ${id} after ${releaseGraceMs}ms cancellation grace`);
      };
      scheduleHardReleaseCheck(Math.min(releaseGraceMs, remoteWriteMaxRetentionMs));
      reject(new WatchdogTimeoutError(`sync exceeded ${timeoutMs}ms; cycle invalidated`));
    }, timeoutMs);
  });

  const publicPromise = Promise.race([operation, timeoutPromise]).catch((err) => {
    if (err instanceof WatchdogTimeoutError) {
      statsTarget.consecutiveDeadlineOverruns =
        (statsTarget.consecutiveDeadlineOverruns || 0) + 1;
      statsTarget.consecutiveFailedCycles = (statsTarget.consecutiveFailedCycles || 0) + 1;
      statsTarget.lastRemoteErrorAt = nowIso();
      logFn(`WATCHDOG: ${err.message}`);
    } else {
      statsTarget.consecutiveFailedCycles = (statsTarget.consecutiveFailedCycles || 0) + 1;
      statsTarget.lastRemoteErrorAt = nowIso();
      logErrorFn('Sync failed or timed out', err);
    }
  });

  // The public promise is allowed to settle at the watchdog deadline, but the
  // ownership lock is retained until the underlying operation actually stops.
  // This prevents the next poll from overlapping a timed-out cycle. The cycle
  // token also prevents late completion from publishing state or healthy stats.
  const completion = operation
    .catch((err) => {
      if (timedOut) logErrorFn('Timed-out sync stopped after watchdog', err);
    })
    .finally(() => {
      clearTimeout(timeoutId);
      clearTimeout(hardReleaseId);
      if (activeSyncCycle?.id === id) activeSyncCycle = null;
      if (syncPromise === completion) syncPromise = null;
      statsTarget.syncQueueDepth = 0;
    });
  activeSyncCycle = { id, publicPromise, completion };
  syncPromise = completion;
  return publicPromise;
}

// The registry-404 predicate is shared with brain-asset-sync so detection
// semantics cannot drift between the two daemons (PRD-0054 Slice A).
const isNotFoundTranscriptPush = isNotFoundBrainResponse;

function resolveTargetBrainId(transcript, defaultBrainId, projectIndex, runtime = {}) {
  if (typeof runtime.resolveBrainId === 'function') {
    return runtime.resolveBrainId(transcript);
  }
  return projectIndex
    ? resolveTranscriptBrainId(transcript, projectIndex)
    : defaultBrainId;
}

function logUnmappedTranscriptOnce(filePath, logFn) {
  if (loggedUnmappedTranscriptPaths.has(filePath)) return;
  if (loggedUnmappedTranscriptPaths.size >= MAX_LOGGED_UNMAPPED_TRANSCRIPT_PATHS) {
    loggedUnmappedTranscriptPaths.clear();
    logFn('Reset unmapped transcript log throttle after 10000 unique paths');
  }
  loggedUnmappedTranscriptPaths.add(filePath);
  logFn(`Skipping unmapped transcript: ${filePath}`);
}

export function resetUnmappedTranscriptLogThrottleForTests() {
  loggedUnmappedTranscriptPaths.clear();
}

function logContainmentRejectionOnce(transcriptKey, code, filePath, logErrorFn) {
  const key = `${code}\u0000${transcriptKey}`;
  if (loggedContainmentRejections.has(key)) return;
  if (loggedContainmentRejections.size >= MAX_LOGGED_UNMAPPED_TRANSCRIPT_PATHS) {
    loggedContainmentRejections.clear();
  }
  loggedContainmentRejections.add(key);
  logErrorFn(`Blocked legacy transcript ${path.basename(filePath)}`, new Error(code));
}

export function resetContainmentRejectionLogThrottleForTests() {
  loggedContainmentRejections.clear();
}

function getTranscriptBatchMaxBytes(env = process.env) {
  const raw = Number(env?.AGENTBOOTUP_TRANSCRIPT_BATCH_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRANSCRIPT_BATCH_MAX_BYTES;
}

function getTranscriptTransientFailurePolicy(runtime = {}) {
  const env = runtime.env || process.env;
  const configured = runtime.transientFailureConfig || {};
  const baseMs = Number(configured.baseMs ?? env.AGENTBOOTUP_TRANSCRIPT_5XX_BACKOFF_BASE_MS);
  const capMs = Number(configured.capMs ?? env.AGENTBOOTUP_TRANSCRIPT_5XX_BACKOFF_CAP_MS);
  const quarantineAfter = Number(
    configured.quarantineAfter ?? env.AGENTBOOTUP_TRANSCRIPT_5XX_QUARANTINE_AFTER
  );
  const quarantineRetryMs = Number(
    configured.quarantineRetryMs ?? env.AGENTBOOTUP_TRANSCRIPT_5XX_QUARANTINE_RETRY_MS
  );
  return {
    baseMs: Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_TRANSCRIPT_5XX_BACKOFF_BASE_MS,
    capMs: Number.isFinite(capMs) && capMs > 0 ? capMs : DEFAULT_TRANSCRIPT_5XX_BACKOFF_CAP_MS,
    quarantineAfter:
      Number.isFinite(quarantineAfter) && quarantineAfter > 0
        ? Math.floor(quarantineAfter)
        : DEFAULT_TRANSCRIPT_5XX_QUARANTINE_AFTER,
    quarantineRetryMs:
      Number.isFinite(quarantineRetryMs) && quarantineRetryMs > 0
        ? quarantineRetryMs
        : DEFAULT_TRANSCRIPT_5XX_QUARANTINE_RETRY_MS,
  };
}

function computeTranscriptPushFailureWindow(previous, policy) {
  const consecutiveFailures = (previous?.consecutiveFailures || 0) + 1;
  if (consecutiveFailures >= policy.quarantineAfter) {
    return {
      cooldownMs: policy.quarantineRetryMs,
      mode: 'quarantined',
      consecutiveFailures,
    };
  }
  return {
    cooldownMs: Math.min(policy.baseMs * 2 ** (consecutiveFailures - 1), policy.capMs),
    mode: 'backoff',
    consecutiveFailures,
  };
}

/** Retry-After accepts either delta-seconds or an HTTP date. Invalid values
 * return null for bounded exponential fallback; a past HTTP date means retry now. */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

export function computeTranscriptThrottleCooldownMs(previous, policy, retryAfterMs, random = Math.random) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;
  const window = computeTranscriptPushFailureWindow(previous, policy);
  // A small randomized tail prevents many daemons which received a 429 without
  // Retry-After from waking in lockstep. Keep the result bounded by the policy cap.
  const jitter = Math.floor(Math.max(0, random()) * Math.max(1, Math.floor(window.cooldownMs * 0.2)));
  return Math.min(policy.capMs, window.cooldownMs + jitter);
}

function recordPerFileTranscriptPushFailure(nextState, entry, result, policy, now, quarantinedFiles) {
  const storedPrevious = getTranscriptPushFailure(nextState, entry.transcriptKey);
  const previous = storedPrevious?.code === 'redaction_failed' ? null : storedPrevious;
  const window = computeTranscriptPushFailureWindow(previous, policy);
  const failure = recordTranscriptPushFailure(
    nextState,
    entry.transcriptKey,
    {
      status: Number(result?.httpStatus ?? result?.statusCode ?? result?.status) || 502,
      code: result?.status || result?.code || 'per_file_rejected',
      message: result?.error || result?.message || 'missing per-file success result',
    },
    window.cooldownMs,
    now,
    { mode: window.mode },
  );
  failure.consecutiveFailures = window.consecutiveFailures;
  if (failure.mode === 'quarantined') {
    quarantinedFiles[entry.transcriptKey] = failure;
  }
  return failure;
}

function transcriptRelativeSuffix(relativePath) {
  return String(relativePath || '')
    .split('/')
    .filter(Boolean)
    .join(path.sep);
}

function isLegacyTranscriptOffsetKeyForCli(key, transcript, suffix) {
  if (typeof key !== 'string' || !suffix) return false;
  if (!key.endsWith(path.sep + suffix)) return false;
  const cliRoot = getCanonicalTranscriptSourceRoot(transcript.cli);
  if (!cliRoot) return false;
  const rootPrefix = cliRoot.endsWith(path.sep) ? cliRoot : `${cliRoot}${path.sep}`;
  return key.startsWith(rootPrefix);
}

function resolveTranscriptStoredOffset(state, transcript) {
  const canonicalKey = canonicalTranscriptOffsetKey(transcript.cli, transcript.relative_path);
  if (canonicalKey) {
    const canonicalOffset = getFileOffset(state, canonicalKey);
    if (canonicalOffset > 0) return canonicalOffset;
  }

  const directOffset = getFileOffset(state, transcript.path);
  if (directOffset > 0) return directOffset;

  const offsets = state?.offsets && typeof state.offsets === 'object' ? state.offsets : {};
  const suffix = transcriptRelativeSuffix(transcript.relative_path);
  if (!suffix) return 0;

  let recovered = 0;
  for (const key of Object.keys(offsets)) {
    if (isCanonicalTranscriptOffsetKey(key)) continue;
    if (!isLegacyTranscriptOffsetKeyForCli(key, transcript, suffix)) continue;
    const candidate = getFileOffset(state, key);
    if (candidate > recovered) recovered = candidate;
  }
  return recovered;
}

function storeTranscriptOffset(state, transcript, offset) {
  state.offsets[transcript.path] = offset;
  const canonicalKey = canonicalTranscriptOffsetKey(transcript.cli, transcript.relative_path);
  if (canonicalKey) state.offsets[canonicalKey] = offset;
  if (!state.legacyTranscriptEvidence || typeof state.legacyTranscriptEvidence !== 'object') {
    state.legacyTranscriptEvidence = {};
  }
  for (const key of [transcript.path, canonicalKey].filter(Boolean)) {
    state.legacyTranscriptEvidence[key] = {
      state: 'legacy_unverified',
      byteOffset: offset,
      authority: false,
      evictionEligible: false,
    };
  }
}

function normalizeRedactionPartialMarker(value) {
  if (Number.isSafeInteger(value) && value >= 0) {
    return { kind: 'jsonl-partial', offset: value, observedSize: null, observedMtimeMs: null };
  }
  if (!value || typeof value !== 'object') return null;
  if (!Number.isSafeInteger(value.offset) || value.offset < 0) return null;
  return {
    kind: ['json-snapshot', 'json-rewrite'].includes(value.kind)
      ? value.kind
      : 'jsonl-partial',
    offset: value.offset,
    observedSize: Number.isSafeInteger(value.observedSize) && value.observedSize >= 0
      ? value.observedSize
      : null,
    observedMtimeMs: Number.isFinite(value.observedMtimeMs) && value.observedMtimeMs >= 0
      ? value.observedMtimeMs
      : null,
  };
}

function decodeUtf8ForRedaction(contentBytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let content;
  try {
    content = decoder.decode(contentBytes, { stream: true });
  } catch {
    return { state: 'invalid', content: null };
  }
  try {
    content += decoder.decode();
    return { state: 'decoded', content };
  } catch {
    // Streaming decode accepted every complete code point and only finalizing
    // failed, so the file ended midway through a UTF-8 sequence. A concurrent
    // writer can complete it next cycle; do not turn that into quarantine.
    return { state: 'incomplete-tail', content: null };
  }
}

function buildTranscriptBatchPayload(brainId, machineId, machineInfo, cli, files) {
  return {
    brain_id: brainId,
    machine_id: machineId,
    machine_info: machineInfo,
    cli,
    files,
  };
}

export function buildRedactionDecisionLog({ file, cli, replacements = 0, heuristicHits = 0, blocked, code }) {
  return {
    file: redactionLogFileId(file),
    cli: String(cli || ''),
    redaction: {
      enabled: true,
      replacements: Number(replacements) || 0,
      heuristic_hits: Number(heuristicHits) || 0,
      blocked: blocked === true,
      ...(code ? { code: String(code) } : {}),
    },
  };
}

function redactionLogFileId(file) {
  const digest = createHmac('sha256', redactionLogHmacKey)
    .update(String(file || ''), 'utf8')
    .digest('hex');
  return `hmac-sha256:${digest}`;
}

function logRedactionDecision(logFn, decision) {
  // Transcript logs are local daemon stdout/stderr today. Hash the file
  // identity regardless, so future log forwarding cannot expose local paths.
  logFn(JSON.stringify(buildRedactionDecisionLog(decision)));
}

const REDACTION_CANARY_EXACT = 'agentbootup-canary-exact-7f4c3d2a9b18';
const REDACTION_CANARY_HEURISTIC = ['sk', 'proj', 'agentbootupCanaryHeuristic0123456789'].join('-');

export async function runTranscriptRedactionCanary(options = {}) {
  const redactContentImpl = options.redactContentImpl || redactContent;
  const categories = [];
  const input = `${JSON.stringify({
    note: REDACTION_CANARY_EXACT,
    detail: REDACTION_CANARY_HEURISTIC,
  })}\n`;
  try {
    const result = redactContentImpl(input, {
      format: 'jsonl',
      denylist: new Set([REDACTION_CANARY_EXACT]),
      derivedDenylist: new Set(),
      sourceMap: new Map([[REDACTION_CANARY_EXACT, 'env']]),
      derivedSourceMap: new Map(),
      onReplacement: (category) => categories.push(category),
    });
    if (!result || result.blocked || typeof result.cleanContent !== 'string') {
      throw new Error('redactor did not produce a clean canary payload');
    }
    if (result.replacements < 1 || result.heuristicHits < 1
      || !categories.includes('env') || !categories.includes('heuristic')) {
      throw new Error('redactor did not exercise exact and heuristic canary layers');
    }
    if (result.cleanContent.includes(REDACTION_CANARY_EXACT)
      || result.cleanContent.includes(REDACTION_CANARY_HEURISTIC)) {
      throw new Error('raw canary remained after redaction');
    }
    if (!result.cleanContent.includes('REDACTED_ENV')
      || !result.cleanContent.includes('REDACTED_HEURISTIC')) {
      throw new Error('expected canary redaction markers are absent');
    }
    for (const line of result.cleanContent.split('\n').filter(Boolean)) {
      if (findRawSecretViolations(JSON.parse(line)).length > 0) {
        throw new Error('post-redaction verification found a canary violation');
      }
    }
    const file = {
      filename: 'in-memory-canary.jsonl',
      relative_path: 'canary/in-memory.jsonl',
      cli: 'canary',
      chunk_index: 0,
      total_chunks: 1,
      byte_offset: 0,
      total_size: Buffer.byteLength(result.cleanContent),
      content_base64: Buffer.from(result.cleanContent, 'utf8').toString('base64'),
    };
    const payload = buildTranscriptBatchPayload(
      'canary-brain', 'canary-machine', { canary: true }, 'canary', [file],
    );
    let captured = null;
    const sink = options.sink || ((value) => { captured = value; });
    await sink(payload);
    const observed = captured || payload;
    const serialized = JSON.stringify(observed);
    if (serialized.includes(REDACTION_CANARY_EXACT)
      || serialized.includes(REDACTION_CANARY_HEURISTIC)) {
      throw new Error('mock sink observed a raw canary');
    }
    return { ok: true, payload: observed, replacements: result.replacements, heuristicHits: result.heuristicHits };
  } catch (cause) {
    const error = new Error(`transcript redaction canary failed: ${cause.message}`);
    error.code = 'redaction_subsystem_unhealthy';
    throw error;
  }
}

export async function startTranscriptRedactionSubsystem(options = {}) {
  const createManager = options.createDenylistManagerImpl || createDenylistManager;
  const manager = createManager({
    projectRoots: options.projectRoots || [],
    manageProcessSignals: false,
    logger: options.logger || (() => {}),
  });
  let initialDenylist;
  try {
    initialDenylist = await manager.start();
  } catch (error) {
    manager.stop();
    throw error;
  }
  if (initialDenylist.state === 'failed') {
    const errorCode = initialDenylist.errorCode || 'redaction_denylist_load_failed';
    manager.stop();
    const error = new Error(`Transcript redaction unavailable (${errorCode}); refusing to start sync`);
    error.code = 'redaction_subsystem_unhealthy';
    throw error;
  }
  try {
    const canary = await (options.runCanaryImpl || runTranscriptRedactionCanary)({
      redactContentImpl: options.redactContentImpl,
      sink: options.canarySink,
    });
    return { manager, initialDenylist, canary };
  } catch (error) {
    manager.stop();
    throw error;
  }
}

function transcriptBatchPayloadBytes(brainId, machineId, machineInfo, cli, files) {
  return Buffer.byteLength(
    JSON.stringify(buildTranscriptBatchPayload(brainId, machineId, machineInfo, cli, files)),
    'utf8',
  );
}

function transcriptResultKey(brainId, machineId, file) {
  return `transcripts/${brainId}/${machineId}/${file.cli}/${file.relative_path}`;
}

function transcriptRedactionFormat(cli, filename) {
  const extension = path.extname(filename || '').toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.jsonl') return 'jsonl';
  if (cli === 'cursor' && extension === '.txt') return 'text';
  return null;
}

function assertUsableDenylistSnapshot(snapshot) {
  if (!snapshot || !['loaded', 'empty-by-config'].includes(snapshot.state) ||
      snapshot.health?.redaction_denylist_stale === true) {
    const error = new Error('redaction denylist is unavailable; transcript pushes are blocked');
    error.code = snapshot?.errorCode || 'redaction_denylist_failed';
    throw error;
  }
  return snapshot;
}

export async function syncDiscoveredTranscripts(
  transcripts,
  {
    defaultBrainId = null,
    projectIndex = null,
    machineId,
    apiKey,
    serverUrl,
    state,
    runtime = {},
  }
) {
  const fetchImpl = runtime.fetchImpl || fetch;
  const now = runtime.now ?? Date.now();
  const logFn = runtime.logFn || log;
  const logErrorFn = runtime.logErrorFn || logError;
  const machineInfo = runtime.machineInfo || getMachineInfo();
  const maxBatchBytes = runtime.maxBatchBytes ?? getTranscriptBatchMaxBytes(runtime.env);
  const transientFailurePolicy = getTranscriptTransientFailurePolicy(runtime);
  const random = runtime.random || Math.random;
  const cycleSignal = runtime.signal;
  if (isTranscriptRedactionDisabled(runtime.env || process.env)) {
    const error = new Error('transcript redaction is disabled; raw transcript pushes remain blocked');
    error.code = 'redaction_disabled';
    throw error;
  }
  const denylistSnapshot = assertUsableDenylistSnapshot(runtime.denylistSnapshot);
  const redactContentImpl = runtime.redactContentImpl || redactContent;
  const redactionBlockRetries = getRedactionBlockRetries(runtime);
  const assertDenylistSnapshotCurrent = () => {
    if (typeof runtime.isDenylistSnapshotCurrent !== 'function') return;
    let current = false;
    try {
      current = runtime.isDenylistSnapshotCurrent(denylistSnapshot);
    } catch {
      current = false;
    }
    if (!current) {
      const error = new Error('redaction denylist changed after payload preparation; transcript pushes are blocked');
      error.code = 'redaction_denylist_changed';
      throw error;
    }
  };

  const nextState = {
    offsets: { ...(state?.offsets || {}) },
    redactionPartialOffsets: { ...(state?.redactionPartialOffsets || {}) },
    transcriptFailures: { ...(state?.transcriptFailures || {}) },
    transcriptPushFailures: { ...(state?.transcriptPushFailures || {}) },
    redactionBlockLedger: Array.isArray(state?.redactionBlockLedger)
      ? [...state.redactionBlockLedger]
      : [],
    redactionLedgerUnhealthy: state?.redactionLedgerUnhealthy === true,
    legacyTranscriptEvidence: classifyLegacyOffsets(state?.offsets, state?.legacyTranscriptEvidence),
  };
  if (nextState.redactionLedgerUnhealthy) {
    const error = new Error(
      'redaction block ledger has no reserved capacity; transcript pushes remain blocked',
    );
    error.code = 'redaction_subsystem_unhealthy';
    throw error;
  }
  let pushCount = 0;
  let errCount = 0;
  let redactionErrCount = 0;
  let skippedQuarantined = 0;
  let skippedBackoff = 0;
  let pendingFiles = 0;
  let containmentErrCount = 0;
  let unmappedFiles = 0;
  let throttleResponses = 0;
  let retryAfterCooldowns = 0;
  let totalReplacements = 0;
  let redactionSubsystemError = null;
  let oldestPendingAt = null;
  let stateChanged = JSON.stringify(state?.legacyTranscriptEvidence || {})
    !== JSON.stringify(nextState.legacyTranscriptEvidence);
  const pendingByTarget = new Map();
  const pendingTranscriptKeys = new Set();
  for (const [fileKey, failure] of Object.entries(nextState.transcriptPushFailures)) {
    if (
      failure?.code === 'redaction_failed'
      && failure?.mode === 'permanent'
      && (
        (
          failure?.denylistManagerGeneration === denylistSnapshot.managerGeneration
          && Number.isSafeInteger(failure?.denylistAdditionRevision)
          && Number.isSafeInteger(denylistSnapshot.additionRevision)
          && denylistSnapshot.additionRevision > failure.denylistAdditionRevision
        )
      )
    ) {
      delete nextState.transcriptPushFailures[fileKey];
      stateChanged = true;
    }
  }
  if (pruneExpiredTranscriptFailures(nextState, now)) {
    stateChanged = true;
  }
  const seenQuarantinedBrains = new Set();
  const quarantinedBrains = {};
  const quarantinedFiles = {};

  for (const { cli, path: filePath, filename, relative_path } of transcripts) {
    if (cycleSignal?.aborted) break;
    try {
      const transcriptKey = canonicalTranscriptOffsetKey(cli, relative_path) || filePath;
      const targetBrainId = resolveTargetBrainId(
        { cli, path: filePath, filename, relative_path },
        defaultBrainId,
        projectIndex,
        runtime
      );
      if (!targetBrainId) {
        unmappedFiles++;
        logUnmappedTranscriptOnce(filePath, logFn);
        continue;
      }

      const stat = await fsp.stat(filePath);
      const format = transcriptRedactionFormat(cli, filename);
      if (!format) {
        const error = new Error(`unsupported transcript redaction format for ${cli}`);
        error.code = 'redaction_unsupported_format';
        throw error;
      }
      const storedOffset = resolveTranscriptStoredOffset(nextState, {
        cli,
        path: filePath,
        relative_path,
      });

      const offsetReset = stat.size < storedOffset;
      const redactionPartialMarker = normalizeRedactionPartialMarker(
        nextState.redactionPartialOffsets[transcriptKey],
      );
      const waitingOnUnchangedPartial = redactionPartialMarker
        && storedOffset === redactionPartialMarker.offset
        && redactionPartialMarker.observedSize === stat.size
        && redactionPartialMarker.observedMtimeMs === stat.mtimeMs;
      if (waitingOnUnchangedPartial) {
        if (redactionPartialMarker.kind === 'json-snapshot') continue;
        pendingFiles++;
        pendingTranscriptKeys.add(transcriptKey);
        const pendingAt = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : now;
        oldestPendingAt = oldestPendingAt === null ? pendingAt : Math.min(oldestPendingAt, pendingAt);
        continue;
      }
      const retryCompleteOverwrite = storedOffset > 0 && (
        redactionPartialMarker?.offset === storedOffset
        || (format === 'json' && !redactionPartialMarker)
      );
      const lastOffset = offsetReset || retryCompleteOverwrite ? 0 : storedOffset;
      const existingPushFailure = getTranscriptPushFailure(nextState, transcriptKey);
      const existingFailureAt = Date.parse(existingPushFailure?.failedAt || '');
      const permanentSourceChanged = existingPushFailure?.mode === 'permanent'
        && Number.isFinite(existingPushFailure.sourceSize)
        && Number.isFinite(existingPushFailure.sourceMtimeMs)
        && (
          existingPushFailure.sourceSize !== stat.size
          || existingPushFailure.sourceMtimeMs !== stat.mtimeMs
        );
      const failurePredatesFile = Number.isFinite(existingFailureAt)
        && Number.isFinite(stat.mtimeMs)
        && existingFailureAt <= stat.mtimeMs;
      if (
        (permanentSourceChanged || ((offsetReset || retryCompleteOverwrite) && failurePredatesFile))
        && clearTranscriptPushFailure(nextState, transcriptKey)
      ) {
        delete quarantinedFiles[transcriptKey];
        stateChanged = true;
      }
      if (format === 'json' && offsetReset && storedOffset > 0 && stat.size === 0) {
        nextState.redactionPartialOffsets[transcriptKey] = {
          kind: 'json-rewrite',
          offset: storedOffset,
          observedSize: stat.size,
          observedMtimeMs: stat.mtimeMs,
        };
        stateChanged = true;
        pendingFiles++;
        pendingTranscriptKeys.add(transcriptKey);
        const pendingAt = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : now;
        oldestPendingAt = oldestPendingAt === null ? pendingAt : Math.min(oldestPendingAt, pendingAt);
        continue;
      }
      if (lastOffset >= stat.size) continue;
      pendingFiles++;
      pendingTranscriptKeys.add(transcriptKey);
      const priorFailureAt = Date.parse(
        getTranscriptPushFailure(nextState, transcriptKey)?.failedAt || '',
      );
      const pendingAt = Number.isFinite(priorFailureAt)
        ? Math.min(Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : now, priorFailureAt)
        : (Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : now);
      oldestPendingAt = oldestPendingAt === null ? pendingAt : Math.min(oldestPendingAt, pendingAt);

      if (isTranscriptBrainQuarantined(nextState, targetBrainId, now)) {
        skippedQuarantined += 1;
        const failure = getTranscriptFailure(nextState, targetBrainId);
        quarantinedBrains[targetBrainId] = failure;
        if (!seenQuarantinedBrains.has(targetBrainId)) {
          logFn(
            `Skipping transcript sync for ${targetBrainId} until ${failure.cooldownUntil} after ${failure.code}`
          );
          seenQuarantinedBrains.add(targetBrainId);
        }
        continue;
      }

      const currentPushFailure = getTranscriptPushFailure(nextState, transcriptKey);
      const needsRestartRedactionRevalidation = currentPushFailure?.code === 'redaction_failed'
        && currentPushFailure?.mode === 'permanent'
        && currentPushFailure?.denylistManagerGeneration !== denylistSnapshot.managerGeneration;
      if (isTranscriptPushQuarantined(nextState, transcriptKey, now)
        && !needsRestartRedactionRevalidation) {
        skippedBackoff += 1;
        const failure = currentPushFailure;
        if (['quarantined', 'permanent'].includes(failure?.mode)) {
          quarantinedFiles[transcriptKey] = failure;
        }
        continue;
      }

      // Phase-0 containment: v1's one-chunk route overwrites objects. Sending only
      // bytes after a persisted offset would therefore replace the complete remote
      // object with a suffix while reporting success. Preserve the offset as
      // unverified migration evidence, but never transmit the delta.
      if (lastOffset > 0) {
        const failure = recordTranscriptPushFailure(
          nextState,
          transcriptKey,
          {
            status: 409,
            code: 'legacy_delta_rejected',
            message: 'Legacy v1 byte-offset deltas are disabled; re-upload through archive v2.',
          },
          transientFailurePolicy.quarantineRetryMs,
          now,
          { mode: 'quarantined' },
        );
        quarantinedFiles[transcriptKey] = failure;
        stateChanged = true;
        errCount++;
        containmentErrCount++;
        logContainmentRejectionOnce(
          transcriptKey, 'legacy_delta_rejected', filePath, logErrorFn,
        );
        continue;
      }

      // A v1 single-chunk upload must be the complete object. Larger files need
      // archive v2; chunking them here would reintroduce truncating overwrite risk.
      if (stat.size > MAX_CHUNK_BYTES) {
        const failure = recordTranscriptPushFailure(
          nextState,
          transcriptKey,
          {
            status: 409,
            code: 'legacy_file_too_large',
            message: `Legacy v1 complete-file limit is ${MAX_CHUNK_BYTES} bytes; use archive v2.`,
          },
          transientFailurePolicy.quarantineRetryMs,
          now,
          { mode: 'quarantined' },
        );
        quarantinedFiles[transcriptKey] = failure;
        stateChanged = true;
        errCount++;
        containmentErrCount++;
        logContainmentRejectionOnce(
          transcriptKey, 'legacy_file_too_large', filePath, logErrorFn,
        );
        continue;
      }

      const bytesToRead = stat.size;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const fh = await fsp.open(filePath, 'r');
      let bytesRead = 0;
      try {
        ({ bytesRead } = await fh.read(buffer, 0, bytesToRead, lastOffset));
      } finally {
        await fh.close();
      }

      if (bytesRead === 0) continue;

      let contentBytes = buffer.subarray(0, bytesRead);
      let nextOffset = lastOffset + bytesRead;
      let hasTrailingPartial = false;
      let unterminatedSingleJsonlLine = false;
      if (format === 'jsonl' && contentBytes.at(-1) !== 0x0a) {
        const lastNewline = contentBytes.lastIndexOf(0x0a);
        if (lastNewline >= 0) {
          contentBytes = contentBytes.subarray(0, lastNewline + 1);
          nextOffset = lastOffset + lastNewline + 1;
          hasTrailingPartial = true;
        } else {
          unterminatedSingleJsonlLine = true;
        }
      }
      if (
        retryCompleteOverwrite
        && hasTrailingPartial
        && nextOffset <= redactionPartialMarker.offset
      ) {
        nextState.redactionPartialOffsets[transcriptKey] = {
          kind: 'jsonl-partial',
          offset: redactionPartialMarker.offset,
          observedSize: stat.size,
          observedMtimeMs: stat.mtimeMs,
        };
        stateChanged = true;
        continue;
      }
      if (contentBytes.length === 0) continue;
      const decoded = decodeUtf8ForRedaction(contentBytes);
      if (decoded.state === 'incomplete-tail') {
        if (format === 'json' && storedOffset > 0) {
          nextState.redactionPartialOffsets[transcriptKey] = {
            kind: 'json-rewrite',
            offset: storedOffset,
            observedSize: stat.size,
            observedMtimeMs: stat.mtimeMs,
          };
          stateChanged = true;
        }
        continue;
      }
      const decodedContent = decoded.content;
      if (format === 'json' && decodedContent !== null) {
        try {
          JSON.parse(decodedContent);
        } catch {
          // Whole-JSON transcript sources are rewritten in place. A readable
          // UTF-8 prefix can still be a mid-write snapshot; advancing its v1
          // offset would strand the completed replacement as a forbidden delta.
          if (storedOffset > 0) {
            nextState.redactionPartialOffsets[transcriptKey] = {
              kind: 'json-rewrite',
              offset: storedOffset,
              observedSize: stat.size,
              observedMtimeMs: stat.mtimeMs,
            };
            stateChanged = true;
          }
          continue;
        }
      }
      let redaction;
      let redactedBytes;
      if (decodedContent === null) {
        redaction = {
          blocked: true,
          blockReason: 'redaction_invalid_utf8',
          replacements: 0,
          heuristicHits: 0,
        };
      } else {
        try {
          const candidate = redactContentImpl(decodedContent, {
            format,
            denylist: denylistSnapshot,
            derivedDenylist: {
              state: denylistSnapshot.state,
              values: denylistSnapshot.derivedValues,
            },
            sourceMap: denylistSnapshot.sourceMap,
            derivedSourceMap: denylistSnapshot.derivedSourceMap,
            warn: (warning) => logFn(`Redaction warning for ${path.basename(filePath)}: ${warning.code}`),
          });
          if (!candidate || typeof candidate.blocked !== 'boolean') {
            throw new TypeError('redactor returned an invalid result');
          }
          if (candidate.blocked) {
            redaction = {
              blocked: true,
              blockReason: typeof candidate.blockReason === 'string'
                ? candidate.blockReason
                : 'redaction_cannot_prove_scrubbed',
              replacements: Number(candidate.replacements) || 0,
              heuristicHits: Number(candidate.heuristicHits) || 0,
            };
          } else {
            if (typeof candidate.cleanContent !== 'string') {
              throw new TypeError('redactor returned invalid clean content');
            }
            redactedBytes = Buffer.from(candidate.cleanContent, 'utf8');
            redaction = {
              blocked: false,
              blockReason: null,
              replacements: Number(candidate.replacements) || 0,
              heuristicHits: Number(candidate.heuristicHits) || 0,
            };
            if (unterminatedSingleJsonlLine) {
              try {
                JSON.parse(decodedContent);
                // Valid JSON is not yet a complete JSONL record until its line
                // terminator is durable. Uploading now would advance the v1
                // offset and strand the writer's later newline/records.
                continue;
              } catch {
                if (redaction.replacements > 0 || redaction.heuristicHits > 0) {
                  redaction = {
                    ...redaction,
                    blocked: true,
                    blockReason: 'redaction_unterminated_secret_line',
                  };
                  redactedBytes = undefined;
                } else {
                  continue;
                }
              }
            }
          }
        } catch {
          const error = new Error('transcript redaction subsystem failed');
          error.code = 'redaction_subsystem_unhealthy';
          throw error;
        }
      }
      if (redaction.blocked) {
        const previous = getTranscriptPushFailure(nextState, transcriptKey);
        const previousRedactionFailures = previous?.code === 'redaction_failed'
          ? (previous.redactionConsecutiveFailures ?? previous.consecutiveFailures ?? 0)
          : 0;
        const window = computeTranscriptPushFailureWindow(
          { consecutiveFailures: previousRedactionFailures },
          transientFailurePolicy,
        );
        const failure = recordTranscriptPushFailure(
          nextState,
          transcriptKey,
          {
            status: 422,
            code: 'redaction_failed',
            message: redaction.blockReason || 'redaction could not prove the transcript safe',
          },
          window.cooldownMs,
          now,
          { mode: window.mode },
        );
        failure.denylistRevision = denylistSnapshot.revision;
        failure.denylistManagerGeneration = denylistSnapshot.managerGeneration;
        failure.denylistAdditionRevision = denylistSnapshot.additionRevision;
        failure.denylistSourceValueCount = denylistSnapshot.sourceValueCount;
        failure.sourceSize = stat.size;
        failure.sourceMtimeMs = stat.mtimeMs;
        failure.redactionConsecutiveFailures = previousRedactionFailures + 1;
        failure.consecutiveFailures = failure.redactionConsecutiveFailures;
        if (failure.redactionConsecutiveFailures >= redactionBlockRetries) {
          failure.mode = 'permanent';
          failure.cooldownUntil = null;
          failure.retryAfterMs = null;
          quarantinedFiles[transcriptKey] = failure;
          if (previous?.mode !== 'permanent') {
            logErrorFn(
              `Transcript redaction permanently blocked ${path.basename(filePath)}; add denylist coverage or repair the native source`,
              new Error('redaction_blocked_permanent'),
            );
          }
        } else if (failure.mode === 'quarantined') {
          quarantinedFiles[transcriptKey] = failure;
        }
        const redactionCode = failure.mode === 'permanent'
          ? 'redaction_blocked_permanent'
          : 'redaction_failed';
        try {
          appendRedactionBlockEvent(nextState, {
            file: transcriptKey,
            cli,
            code: redactionCode,
            permanent: failure.mode === 'permanent',
          }, now, runtime.redactionLedgerOptions);
          nextState.redactionLedgerUnhealthy = false;
        } catch (error) {
          if (error?.code !== 'redaction_subsystem_unhealthy') throw error;
          nextState.redactionLedgerUnhealthy = true;
          redactionSubsystemError = {
            code: 'redaction_subsystem_unhealthy',
            message: error.message,
          };
        }
        logRedactionDecision(logFn, {
          file: transcriptKey,
          cli,
          replacements: redaction.replacements,
          heuristicHits: redaction.heuristicHits,
          blocked: true,
          code: redactionCode,
        });
        stateChanged = true;
        errCount++;
        redactionErrCount++;
        logErrorFn(`Failed to redact ${path.basename(filePath)}`, new Error('redaction_failed'));
        if (redactionSubsystemError) break;
        continue;
      }
      totalReplacements += redaction.replacements;
      logRedactionDecision(logFn, {
        file: transcriptKey,
        cli,
        replacements: redaction.replacements,
        heuristicHits: redaction.heuristicHits,
        blocked: false,
      });
      if (redactedBytes.length > MAX_CHUNK_BYTES) {
        const failure = recordTranscriptPushFailure(
          nextState,
          transcriptKey,
          {
            status: 413,
            code: 'legacy_file_too_large',
            message: `Redacted legacy v1 complete-file limit is ${MAX_CHUNK_BYTES} bytes; use archive v2.`,
          },
          transientFailurePolicy.quarantineRetryMs,
          now,
          { mode: 'quarantined' },
        );
        quarantinedFiles[transcriptKey] = failure;
        stateChanged = true;
        errCount++;
        containmentErrCount++;
        logContainmentRejectionOnce(
          transcriptKey, 'legacy_file_too_large', filePath, logErrorFn,
        );
        continue;
      }
      const content_base64 = redactedBytes.toString('base64');
      const batchKey = `${targetBrainId}\u0000${cli}`;
      const entry = {
        batchKey,
        targetBrainId,
        transcriptKey,
        filePath,
        stat,
        nextOffset,
        hasTrailingPartial,
        fileFormat: format,
        file: {
          filename,
          relative_path,
          cli,
          chunk_index: 0,
          total_chunks: 1,
          byte_offset: 0,
          total_size: redactedBytes.length,
          content_base64,
        },
      };
      const itemRequestBytes = transcriptBatchPayloadBytes(
        targetBrainId,
        machineId,
        machineInfo,
        cli,
        [entry.file],
      );
      if (itemRequestBytes > maxBatchBytes) {
        const failure = recordTranscriptPushFailure(
          nextState,
          transcriptKey,
          {
            status: 413,
            code: 'legacy_request_too_large',
            message: `Encoded legacy request is ${itemRequestBytes} bytes, exceeding configured maxBatchBytes=${maxBatchBytes}.`,
          },
          transientFailurePolicy.quarantineRetryMs,
          now,
          { mode: 'quarantined' },
        );
        quarantinedFiles[transcriptKey] = failure;
        stateChanged = true;
        errCount++;
        containmentErrCount++;
        logContainmentRejectionOnce(
          transcriptKey, 'legacy_request_too_large', filePath, logErrorFn,
        );
        continue;
      }
      const pending = pendingByTarget.get(batchKey) || [];
      pending.push(entry);
      pendingByTarget.set(batchKey, pending);

      const remaining = stat.size - (lastOffset + bytesRead);
      if (remaining > 0) {
        logFn(
          `${path.basename(filePath)}: ${(remaining / 1024) | 0}KB remaining — will sync next cycle`
        );
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      if (['redaction_subsystem_unhealthy', 'redaction_unsupported_format'].includes(err.code)) {
        throw err;
      }
      logErrorFn(`Failed to sync ${path.basename(filePath)}`, err);
      errCount++;
    }
  }

  if (redactionSubsystemError) pendingByTarget.clear();
  for (const [batchKey, batchEntries] of pendingByTarget.entries()) {
    if (cycleSignal?.aborted) break;
    const [brainId, batchCli] = batchKey.split('\u0000');
    let batch = [];
    const flushBatch = async () => {
      if (batch.length === 0) return false;
      assertDenylistSnapshotCurrent();
      const payload = buildTranscriptBatchPayload(
        brainId,
        machineId,
        machineInfo,
        batchCli,
        batch.map((entry) => entry.file),
      );
      const controller = new AbortController();
      const abortForCycle = () => controller.abort();
      if (cycleSignal?.aborted) controller.abort();
      else cycleSignal?.addEventListener('abort', abortForCycle, { once: true });
      const timerId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
      let remoteWriteStarted = false;
      try {
        if (typeof runtime.beginRemoteWrite === 'function') {
          remoteWriteStarted = runtime.beginRemoteWrite();
          if (!remoteWriteStarted) {
            batch = [];
            return false;
          }
        }
        const resp = await fetchImpl(apiUrl(serverUrl, '/v1/sync/transcripts/push'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          if (isNotFoundTranscriptPush(resp, body)) {
            const failure = recordTranscriptBrainFailure(
              nextState,
              brainId,
              {
                status: resp.status,
                code: 'not_found',
                message: body.slice(0, 200),
              },
              BRAIN_404_COOLDOWN_MS,
              now
            );
            quarantinedBrains[brainId] = failure;
            stateChanged = true;
            errCount += batch.length;
            logFn(
              `Quarantined transcript sync for ${brainId} until ${failure.cooldownUntil} after 404 not_found`
            );
            batch = [];
            return true;
          }
          if (resp.status === 429 || (resp.status >= 500 && resp.status <= 599)) {
            if (resp.status === 429) throttleResponses++;
            const retryAfterMs = resp.status === 429
              ? parseRetryAfterMs(resp.headers.get('retry-after'), now)
              : null;
            if (retryAfterMs !== null) retryAfterCooldowns++;
            for (const entry of batch) {
              const storedPrevious = getTranscriptPushFailure(nextState, entry.transcriptKey);
              const previous = storedPrevious?.code === 'redaction_failed' ? null : storedPrevious;
              const window = computeTranscriptPushFailureWindow(previous, transientFailurePolicy);
              const cooldownMs = resp.status === 429
                ? computeTranscriptThrottleCooldownMs(previous, transientFailurePolicy, retryAfterMs, random)
                : window.cooldownMs;
              const failure = recordTranscriptPushFailure(
                nextState,
                entry.transcriptKey,
                {
                  status: resp.status,
                  code: resp.status === 429 ? 'upstream_throttled' : 'upstream_5xx',
                  message: body.slice(0, 200) || `HTTP ${resp.status}`,
                },
                cooldownMs,
                now,
                { mode: window.mode }
              );
              failure.consecutiveFailures = window.consecutiveFailures;
              if (failure.mode === 'quarantined') {
                quarantinedFiles[entry.transcriptKey] = failure;
              }
            }
            stateChanged = true;
          }
          throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
        }

        if (clearTranscriptBrainFailure(nextState, brainId)) {
          stateChanged = true;
        }
        delete quarantinedBrains[brainId];
        const respJson = await resp.json().catch(() => null);
        const results = Array.isArray(respJson?.data?.results) ? respJson.data.results : null;
        if (!results) {
          throw new Error('HTTP 200: missing transcript batch results payload');
        }
        const resultsByKey = new Map(results.map((result) => [result.key, result]));
        for (const entry of batch) {
          const result = resultsByKey.get(transcriptResultKey(brainId, machineId, entry.file));
          if (result?.status === 'pushed' || result?.status === 'appended') {
            if (clearTranscriptPushFailure(nextState, entry.transcriptKey)) {
              stateChanged = true;
            }
            delete quarantinedFiles[entry.transcriptKey];
            storeTranscriptOffset(
              nextState,
              { cli: entry.file.cli, path: entry.filePath, relative_path: entry.file.relative_path },
              entry.nextOffset,
            );
            if (entry.fileFormat === 'json') {
              nextState.redactionPartialOffsets[entry.transcriptKey] = {
                kind: 'json-snapshot',
                offset: entry.nextOffset,
                observedSize: entry.stat.size,
                observedMtimeMs: entry.stat.mtimeMs,
              };
            } else if (entry.hasTrailingPartial) {
              nextState.redactionPartialOffsets[entry.transcriptKey] = {
                kind: 'jsonl-partial',
                offset: entry.nextOffset,
                observedSize: entry.stat.size,
                observedMtimeMs: entry.stat.mtimeMs,
              };
            } else {
              delete nextState.redactionPartialOffsets[entry.transcriptKey];
            }
            stateChanged = true;
            pushCount++;
          } else {
            recordPerFileTranscriptPushFailure(
              nextState,
              entry,
              result,
              transientFailurePolicy,
              now,
              quarantinedFiles,
            );
            stateChanged = true;
            errCount++;
            logErrorFn(
              `Failed to sync ${path.basename(entry.filePath)}`,
              new Error(result?.error || 'missing per-file success result'),
            );
          }
        }
        // A later batch can fail closed if the denylist revision changes. Persist
        // this accepted batch while the caller still holds the sync-state lock so
        // those remote writes are not replayed on the next cycle.
        if (typeof runtime.checkpointState === 'function') {
          await runtime.checkpointState(nextState);
        }
        batch = [];
        return false;
      } catch (err) {
        if (['redaction_denylist_changed', 'redaction_subsystem_unhealthy'].includes(err.code)) {
          batch = [];
          throw err;
        }
        logErrorFn(`Failed to push transcript batch of ${batch.length} files for ${brainId}`, err);
        errCount += batch.length;
        batch = [];
        return false;
      } finally {
        clearTimeout(timerId);
        if (remoteWriteStarted) runtime.endRemoteWrite?.();
        cycleSignal?.removeEventListener('abort', abortForCycle);
      }
    };

    for (const entry of batchEntries) {
      if (cycleSignal?.aborted) break;
      const candidateFiles = [...batch, entry].map((item) => item.file);
      const candidateBytes = transcriptBatchPayloadBytes(
        brainId,
        machineId,
        machineInfo,
        batchCli,
        candidateFiles,
      );
      if (batch.length > 0 && candidateBytes > maxBatchBytes) {
        const stopBrain = await flushBatch();
        if (stopBrain) break;
      }
      batch.push(entry);
    }

    if (!cycleSignal?.aborted && batch.length > 0) {
      await flushBatch();
    }
  }

  const currentPaths = new Set(transcripts.map((f) => f.path));
  const currentCanonicalKeys = new Set(
    transcripts
      .map((f) => canonicalTranscriptOffsetKey(f.cli, f.relative_path))
      .filter(Boolean)
  );
  const prunedOffsets = Object.fromEntries(
    Object.entries(nextState.offsets).filter(([k]) => {
      if (currentPaths.has(k)) return true;
      if (isCanonicalTranscriptOffsetKey(k)) return currentCanonicalKeys.has(k);
      return false;
    })
  );
  if (Object.keys(prunedOffsets).length !== Object.keys(nextState.offsets).length) {
    nextState.offsets = prunedOffsets;
    stateChanged = true;
  }
  const prunedPartialOffsets = Object.fromEntries(
    Object.entries(nextState.redactionPartialOffsets || {}).filter(([key]) => {
      if (currentPaths.has(key)) return true;
      if (isCanonicalTranscriptOffsetKey(key)) return currentCanonicalKeys.has(key);
      return false;
    }),
  );
  if (
    Object.keys(prunedPartialOffsets).length !==
    Object.keys(nextState.redactionPartialOffsets || {}).length
  ) {
    nextState.redactionPartialOffsets = prunedPartialOffsets;
    stateChanged = true;
  }
  const prunedLegacyEvidence = classifyLegacyOffsets(
    nextState.offsets,
    nextState.legacyTranscriptEvidence,
  );
  if (JSON.stringify(prunedLegacyEvidence) !== JSON.stringify(nextState.legacyTranscriptEvidence || {})) {
    nextState.legacyTranscriptEvidence = prunedLegacyEvidence;
    stateChanged = true;
  }
  const currentTranscriptFailureKeys = new Set(
    transcripts.map((f) => canonicalTranscriptOffsetKey(f.cli, f.relative_path) || f.path)
  );
  // A ledger-capacity abort ends discovery early. Preserve failures for files we
  // did not visit; pruning them from an incomplete inventory would discard valid
  // quarantine/backoff state and cause premature retries after recovery.
  const prunedPushFailures = redactionSubsystemError
    ? nextState.transcriptPushFailures
    : Object.fromEntries(
      Object.entries(nextState.transcriptPushFailures || {}).filter(([key]) => {
        if (!currentTranscriptFailureKeys.has(key)) return false;
        if (pendingTranscriptKeys.has(key)) return true;
        return false;
      })
    );
  if (
    Object.keys(prunedPushFailures).length !==
    Object.keys(nextState.transcriptPushFailures || {}).length
  ) {
    nextState.transcriptPushFailures = prunedPushFailures;
    stateChanged = true;
  }
  const activeFailureCount = Object.keys(nextState.transcriptFailures || {}).length
    + Object.values(nextState.transcriptPushFailures || {}).filter(
      (failure) => !LEGACY_CONTAINMENT_FAILURE_CODES.has(failure?.code),
    ).length;
  const containmentFailureCount = Object.values(nextState.transcriptPushFailures || {}).filter(
    (failure) => LEGACY_CONTAINMENT_FAILURE_CODES.has(failure?.code),
  ).length;
  const redactionBlockedFiles = redactionBlockedFilesFromState(nextState, now);

  return {
    nextState,
    pushCount,
    errCount,
    containmentErrCount,
    redactionErrCount,
    containmentFailureCount,
    redactionFailureCount: redactionBlockedFiles.length,
    redactionBlockedFiles,
    redactionBlockLedger: nextState.redactionBlockLedger,
    redactionLedgerUnhealthy: nextState.redactionLedgerUnhealthy,
    redactionSubsystemError,
    skippedQuarantined,
    skippedBackoff,
    quarantinedBrains,
    quarantinedFiles,
    pendingFiles,
    unmappedFiles,
    oldestPendingAt: oldestPendingAt === null ? null : new Date(oldestPendingAt).toISOString(),
    activeFailureCount,
    throttleResponses,
    retryAfterCooldowns,
    totalReplacements,
    stateChanged,
  };
}

async function _doSync(defaultBrainId, projectIndex, machineId, apiKey, serverUrl, cycle = null, runtime = {}) {
  try {
    if (isTranscriptRedactionDisabled(runtime.env || process.env)) {
      const error = new Error('transcript redaction is disabled; raw transcript pushes remain blocked');
      error.code = 'redaction_disabled';
      throw error;
    }
    const denylistSnapshot = assertUsableDenylistSnapshot(runtime.denylistManager?.snapshot());
    stats.redaction.denylist_size = denylistSnapshot.values?.size || 0;
    const cycleResult = await withSyncStateLock(async () => {
      const state = await readSyncState();
      await prepareTranscriptRedactionLedgerState(state, {
        redactionLedgerOptions: runtime.redactionLedgerOptions,
      });
      if (cycle && !cycle.isCurrent()) return null;

      // Discovery remains behind the durable ledger-recovery gate. No local
      // transcript is opened and no network work can begin while the persisted
      // fail-closed latch is still active.
      const inventory = await discoverAllTranscripts();
      if (cycle && !cycle.isCurrent()) return null;
      const result = await syncDiscoveredTranscripts(inventory.files, {
        defaultBrainId,
          // A supplied single-project index is a security boundary: unmatched
          // global CLI transcripts must not fall back to the default brain,
          // because their owning project's denylist was not loaded.
          projectIndex: runtime.projectIndex ?? projectIndex,
        machineId,
        apiKey,
        serverUrl,
        state,
        runtime: {
          ...runtime,
          signal: cycle?.signal,
          beginRemoteWrite: cycle ? () => cycle.beginRemoteWrite() : undefined,
          endRemoteWrite: cycle ? () => cycle.endRemoteWrite() : undefined,
          denylistSnapshot,
          isDenylistSnapshotCurrent: (snapshot) => runtime.denylistManager.isSnapshotCurrent(snapshot),
          checkpointState: (nextState) => persistAcceptedTranscriptCheckpoint(nextState),
        },
      });

      if (cycle && !cycle.isCurrent()) return null;

      // Hold the shared cross-process lock from the state read through this
      // publication. Mitigation can therefore clear a quarantine entry without
      // racing a daemon cycle that was computed from an older snapshot.
      return {
        syncResult: await persistTranscriptSyncResult(result),
        inventory,
      };
    });

    if (!cycleResult) return;
    const { syncResult, inventory } = cycleResult;
    stats.filesWatched = inventory.files.length;
    stats.detectedUnsupported = inventory.unsupported;
    const {
      pushCount,
      errCount,
      containmentErrCount,
      redactionErrCount,
      containmentFailureCount,
      redactionFailureCount,
      redactionBlockedFiles,
      redactionBlockLedger,
      redactionLedgerUnhealthy,
      skippedQuarantined,
      skippedBackoff,
      quarantinedBrains,
      quarantinedFiles,
      pendingFiles,
      unmappedFiles,
      oldestPendingAt,
      activeFailureCount,
      throttleResponses,
      retryAfterCooldowns,
      totalReplacements,
    } = syncResult;

    if (cycle && !cycle.isCurrent()) return;

    if (cycle && !cycle.isCurrent()) return;

    stats.pushes += pushCount;
    stats.errors += errCount;
    stats.lastSyncAt = new Date().toISOString();
    stats.lastSkippedQuarantined = skippedQuarantined;
    stats.lastSkippedBackoff = skippedBackoff;
    stats.lastQuarantinedBrains = quarantinedBrains;
    stats.lastQuarantinedFiles = quarantinedFiles;
    stats.redaction.blocked_files = redactionBlockedFiles;
    const healthLedger = redactionHealthLedgerView(redactionBlockLedger);
    stats.redaction.block_ledger = healthLedger.entries;
    stats.redaction.block_ledger_total = healthLedger.total;
    stats.redaction.block_ledger_truncated = healthLedger.truncated;
    stats.redaction.redaction_ledger_unhealthy = redactionLedgerUnhealthy;
    stats.redaction.redaction_blocked_permanent = redactionBlockedFiles
      .some((failure) => failure.code === 'redaction_blocked_permanent');
    stats.redaction.redaction_subsystem_unhealthy = false;
    stats.pendingFiles = pendingFiles;
    stats.unmappedFiles = unmappedFiles;
    stats.oldestPendingAt = oldestPendingAt;
    stats.throttleResponses += throttleResponses;
    stats.retryAfterCooldowns += retryAfterCooldowns;
    stats.redaction.total_replacements += totalReplacements;
    const completedAt = new Date().toISOString();
    stats.consecutiveDeadlineOverruns = 0;
    Object.assign(stats, applyTranscriptCycleHealthStats(stats, {
      pushCount,
      errCount,
      containmentErrCount,
      redactionErrCount,
      containmentFailureCount,
      redactionFailureCount,
      skippedBackoff,
      skippedQuarantined,
      pendingFiles,
      activeFailureCount,
    }, completedAt));

    if (pushCount > 0 || errCount > 0 || skippedQuarantined > 0 || skippedBackoff > 0) {
      log(
        `Sync complete: pushed=${pushCount} errors=${errCount} quarantined_skips=${skippedQuarantined} backoff_skips=${skippedBackoff}`
      );
    }
  } catch (err) {
    if (cycle && !cycle.isCurrent()) return;
    if (err?.code === 'redaction_disabled') {
      stats.redaction.enabled = false;
      stats.redaction.redaction_disabled = true;
      logError('Sync blocked by redaction policy', err);
      return;
    }
    if (String(err?.code || '').startsWith('redaction_') && err?.code !== 'redaction_disabled') {
      if (err.persistedSyncState) {
        hydrateRedactionHealthFromState(stats.redaction, err.persistedSyncState);
      }
      stats.redaction.redaction_subsystem_unhealthy = true;
      logError('Sync blocked by redaction subsystem', err);
      return;
    }
    stats.consecutiveFailedCycles++;
    stats.lastRemoteErrorAt = new Date().toISOString();
    logError('Sync error', err);
  }
}

// ── Health / status HTTP server ──────────────────────────────────────────────

/**
 * Start a minimal HTTP server on 127.0.0.1:HEALTH_PORT exposing:
 *   GET /health  → { healthy: true, uptime }
 *   GET /status  → { ...stats, uptime }
 * @returns {http.Server}
 */
function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildTranscriptHealthPayload(stats)));
      return;
    }

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...stats, uptime: process.uptime() }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(HEALTH_PORT, TRANSCRIPT_HEALTH_HOST, () => {
    log(`Health server listening on ${TRANSCRIPT_HEALTH_HOST}:${HEALTH_PORT}`);
  });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      // Distinguish between "our own daemon is running" and "something else owns this port".
      const daemonDir = process.env.AGENTBOOTUP_DAEMON_DIR
        || path.join(os.homedir(), '.agentbootup', 'daemon');
      const pidFile = path.join(daemonDir, 'transcript-sync.pid');
      const existingPid = await fsp.readFile(pidFile, 'utf-8')
        .then((s) => parseInt(s.trim(), 10))
        .catch(() => null);
      if (existingPid && Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
        process.stderr.write(
          `Transcript sync daemon already running (PID ${existingPid}). ` +
          'Run `agentbootup daemon stop` first.\n'
        );
      } else {
        process.stderr.write(
          `Port ${HEALTH_PORT} is already in use by another process. ` +
          'Use AGENTBOOTUP_DAEMON_PORT env var to choose a different port.\n'
        );
      }
      process.exit(1);
    }
    logError('Health server error', err);
  });

  return server;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function resolveSingleProjectScope(
  environment = process.env,
  cwd = process.cwd(),
  runtime = {},
) {
  const configuredProjectRoot = environment.AGENTBOOTUP_PROJECT_ROOT?.trim();
  const projectRoot = normalizeProjectPath(configuredProjectRoot || cwd);
  const configuredRepositoryRoot = environment.AGENTBOOTUP_REPOSITORY_ROOT?.trim();
  const repositoryRoot = configuredRepositoryRoot
    ? normalizeProjectPath(configuredRepositoryRoot)
    : (resolveGitProjectRoot(projectRoot, runtime) || projectRoot);
  return { projectRoot, repositoryRoot };
}

async function main() {
  log('Starting transcript sync daemon');

  const credentialState = await inspectCredentials();
  if (credentialState.state !== CREDS_STATE_OK) {
    process.stderr.write(
      `${formatCredentialsRecoveryMessage(credentialState)}\n`
    );
    process.exit(1);
  }
  const creds = credentialState.creds;
  configureRedactionLogHmacKey(creds.apiKey);

  const scopedProjectIds = getScopedProjectIdsFromEnv();
  const networkProjects = await getNetworkProjects();
  const scopedNetworkProjects = scopeTranscriptProjects(networkProjects, scopedProjectIds);
  const unknownScopedProjectIds = getUnknownScopedTranscriptProjectIds(networkProjects, scopedProjectIds);
  if (unknownScopedProjectIds.length > 0) {
    process.stderr.write(
      `Unknown scoped transcript project IDs: ${unknownScopedProjectIds.join(', ')}\n`
    );
    process.exit(1);
  }
  const normalizedScopedProjects = scopedNetworkProjects
    ?.filter((project) => project?.path && project?.agent_id)
    .map((project) => ({
      ...project,
      path: normalizeProjectPath(project.path),
    }));
  const projectIndex = scopedNetworkProjects?.length
    ? buildTranscriptProjectIndex(normalizedScopedProjects)
    : null;
  const singleProjectScope = !networkProjects
    ? resolveSingleProjectScope()
    : null;
  const singleProjectRoot = singleProjectScope?.projectRoot || null;
  const denylistProjectRoots = collectDenylistProjectRoots(
    normalizedScopedProjects,
    singleProjectScope,
  );

  const redactionDisabled = isTranscriptRedactionDisabled();
  stats.redaction.enabled = !redactionDisabled;
  stats.redaction.redaction_disabled = redactionDisabled;
  let denylistManager = null;
  if (!redactionDisabled) {
    const redactionSubsystem = await startTranscriptRedactionSubsystem({
      projectRoots: denylistProjectRoots,
      logger: (event) => {
        if (event.event === 'redaction_denylist_loaded') {
          log(`Redaction denylist loaded: source_values=${event.count} derived_values=${event.derivedCount}`);
        } else {
          logError('Redaction denylist reload failed', new Error(event.code || 'reload_failed'));
        }
      },
    });
    denylistManager = redactionSubsystem.manager;
    const initialDenylist = redactionSubsystem.initialDenylist;
    stats.redaction.denylist_size = initialDenylist.values?.size || 0;
  }
  const brainId = projectIndex ? null : await getBrainId();
  if (!projectIndex && !brainId) {
    process.stderr.write(
      'No brain ID configured. Run: agentbootup config set-brain <id>\n'
    );
    process.exit(1);
  }
  const singleProjectIndex = singleProjectRoot && brainId
    ? buildTranscriptProjectIndex([{
      id: brainId,
      agent_id: brainId,
      path: singleProjectRoot,
    }])
    : null;
  await hydrateStartupTranscriptRedactionHealth(stats.redaction);
  const syncRuntime = {
    denylistManager,
    projectIndex: singleProjectIndex || undefined,
  };

  // Use a stable UUID stored in ~/.agentbootup/machine-id rather than
  // os.hostname(), which is unreliable in containers and cloud VMs.
  const machineId = await getMachineId();
  const { apiKey, serverUrl } = creds;

  if (!isPlausibleServerUrl(serverUrl)) {
    process.stderr.write(
      `Invalid server URL in credentials: "${serverUrl}". Port 0 or non-http(s) is not a valid target. Re-run auth login --server-url <url>.\n`
    );
    process.exit(1);
  }

  const modeLabel = projectIndex
    ? `multi-brain(${projectIndex.projects.length}${scopedProjectIds?.length ? ` scoped=${scopedProjectIds.join(',')}` : ''})`
    : `single-brain(${brainId})`;
  log(`mode=${modeLabel} machine=${machineId} server=${serverUrl}`);
  log(
    `NOTE: transcript content (conversation history) will be transmitted to ${serverUrl}`
  );

  // Startup identity handshake (PRD-0054 FR A-1) for single-brain mode: the
  // configured brain is checked once, loudly, at startup. Multi-brain mode
  // resolves per-transcript targets, which keep the existing lazy per-brain
  // 404 quarantine (persisted in sync state) — handshaking all N would turn
  // startup into N registry calls for brains that may never sync this boot.
  if (brainId) {
    const handshake = await verifyBrainRegistered({ brainId, apiKey, serverUrl });
    if (handshake.outcome === 'not_found') {
      logError(
        `Brain '${brainId}' is not registered (404 not_found) — transcript pushes will quarantine. ` +
          `Fix: agentbootup brain register ${brainId}`
      );
    } else if (handshake.outcome === 'unavailable') {
      log(`Identity handshake inconclusive (${handshake.detail}) — proceeding fail-open`);
    } else {
      log(`Identity handshake OK: brain '${brainId}' is registered`);
    }
  }

  const healthServer = startHealthServer();

  // Log watched directories so users know exactly what data the daemon collects.
  const watchedRoots = CLI_SOURCES.map((s) => `  ${s.cli}: ${s.rootFn()}`).join('\n');
  log(`Watching transcript directories:\n${watchedRoots}`);

  // fs.watch({ recursive: true }) is natively supported on macOS and Windows.
  // On Linux, recursive watching requires Node >= 22; older Node silently
  // degrades to non-recursive (missing files in subdirectories). We skip
  // watcher setup on unsupported platforms/versions entirely and rely on the
  // 30-second poll fallback, which is correct on all platforms.
  const RECURSIVE_WATCH_SUPPORTED =
    process.platform === 'darwin' ||
    process.platform === 'win32' ||
    (process.platform === 'linux' && parseInt(process.versions.node, 10) >= 22);
  if (!RECURSIVE_WATCH_SUPPORTED) {
    log(
      `Real-time fs.watch disabled on ${process.platform} (requires macOS/Windows or Node >= 22). ` +
        'Syncing via 30s poll fallback only.'
    );
  }

  // Watch each CLI root directory for real-time change events.
  const watchers = [];
  let debounceTimer = null;

  const scheduleSync = () => {
    if (debounceTimer) {
      stats.coalescedSyncRequests += 1;
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      syncPendingFiles(brainId, projectIndex, machineId, apiKey, serverUrl, syncRuntime).catch((err) =>
        logError('Sync failed', err)
      );
    }, SYNC_DEBOUNCE_MS);
  };

  if (RECURSIVE_WATCH_SUPPORTED) {
    for (const source of CLI_SOURCES) {
      const root = source.rootFn();
      if (!fs.existsSync(root)) continue;
      try {
        const watcher = fs.watch(root, { recursive: true }, (_, filename) => {
          if (filename && source.match(path.join(root, filename))) { // nosemgrep
            scheduleSync();
          }
        });
        watcher.on('error', (err) => logError(`Watcher error for ${root}`, err));
        watchers.push(watcher);
        log(`Watching ${root}`);
      } catch (err) {
        logError(`Failed to watch ${root}`, err);
      }
    }
  }

  // Initial sync on startup, then periodic polling fallback.
  await syncPendingFiles(brainId, projectIndex, machineId, apiKey, serverUrl, syncRuntime).catch((err) =>
    logError('Initial sync failed', err)
  );
  const pollTimer = setInterval(() => {
    syncPendingFiles(brainId, projectIndex, machineId, apiKey, serverUrl, syncRuntime).catch((err) =>
      logError('Poll sync failed', err)
    );
  }, POLL_INTERVAL_MS);

  const reloadDenylist = () => {
    if (!denylistManager) return;
    void denylistManager.reloadAndRefreshWatchers()
      .catch((err) => logError('Redaction denylist reload failed', err));
  };
  process.on('SIGHUP', reloadDenylist);

  // Graceful shutdown: wait for any in-flight sync, then perform a final flush.
  const shutdown = async () => {
    log('Shutting down...');
    clearInterval(pollTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    // watchers is empty when RECURSIVE_WATCH_SUPPORTED is false — the loop is
    // a no-op in that case, which is correct (polling was the only mechanism).
    for (const w of watchers) w.close();
    healthServer.close();
    process.off('SIGHUP', reloadDenylist);
    // If a sync is in flight, wait for it to complete so we don't skip the
    // final flush (syncPendingFiles returns early if syncPromise is set).
    if (syncPromise) await syncPromise.catch(() => {});
    await syncPendingFiles(brainId, projectIndex, machineId, apiKey, serverUrl, syncRuntime).catch((err) =>
      logError('Final sync on shutdown failed — some bytes may be re-pushed on next start', err)
    );
    denylistManager?.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
  process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));

  log('Daemon running');
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
