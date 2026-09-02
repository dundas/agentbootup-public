#!/usr/bin/env node
/**
 * Brain Asset Sync Daemon
 *
 * Watches project-scoped AI asset directories (skills, agents, commands,
 * memory, protocols, and root config files) and pushes changed files to the
 * agentbootup server via POST /v1/brain-assets/:brainId/push.
 *
 * Startup requirements:
 *   1. API credentials configured: `agentbootup auth login --api-key <key>`
 *   2. Brain ID configured:        `agentbootup config set-brain <id>`
 *
 * The daemon maintains mtime/size state in ~/.agentbootup/brain-sync-state.json
 * so that only files that have changed since the last push are transmitted on
 * each cycle. Full file content is pushed on each change (brain assets are
 * small config/markdown files, not append-only logs).
 *
 * File watching:
 *   - fs.watch({ recursive: true }) on each asset root (real-time events).
 *   - A 60-second polling fallback handles events that fs.watch may miss.
 *
 * A health/status HTTP server listens on 127.0.0.1:8767 unless disabled by
 * AGENTBOOTUP_DISABLE_HEALTH_SERVER=1 under process-managed launches.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { getBrainId, getNetworkRoot } from '../config/config.js';
import { getMachineId, getMachineInfo } from '../machine-id/machine-id.js';
import { isPlausibleServerUrl, apiUrl } from '../auth/validate.js';
import { getBrainAssetSources, WALK_SKIP_DIRS } from '../brain/asset-sources.js';
import { createSecretGuard } from '../brain/secret-guard.js';
import { evaluateDaemonSource } from '../brain/source-migration.js';
import { getDaemonDir, getPidFilePath, isProcessAlive } from '../process/pid-utils.js';
import { hasReplayQueue, readReplayQueue } from '../memory/replay-queue.js';
import {
  verifyBrainRegistered,
  isNotFoundBrainResponse,
  createQuarantineTracker,
} from './brain-quarantine.mjs';
import { createConvergeRunner, getConvergeIntervalMs } from './memory-converge.mjs';
import { brainAssetPushHeaders } from '../brain-asset-headers.js';
import { isConvergeHealthSafe } from '../memory/converge-safety.js';
import {
  formatMemoryConvergenceFailure,
  normalizeMemoryConvergenceFailure,
  snapshotMemoryConvergenceFailure,
} from '../memory/convergence-failure.js';
import { collectSelectedMemoryPaths, isPublishableMemoryPath } from '../memory/brain-backup-selection.js';
import {
  createBrainAssetSizeError,
  planBrainAssetPushBatches,
  sendBrainAssetBatchWith413Split,
} from '../brain/asset-transport.js';
import { stringifyJsonEnvelope } from '../json/safe-stringify.js';
import { createSupervisedRemoteLocalConnector } from './remote-local-connector.mjs';

// ── Mech Storage client builder ───────────────────────────────────────────────

/**
 * Build a minimal fetch-based MechClient compatible with MechStorageBackend.
 * Exported for tests.
 * @param {{ appId: string, apiKey: string, baseUrl: string }} opts
 * @returns {object}
 */
export function buildMechStorageClient({ appId, apiKey, baseUrl }) {
  const headers = () => ({
    'Content-Type': 'application/json',
    'X-App-ID': appId,
    Authorization: `Bearer ${apiKey}`,
  });

  async function checkResponse(resp) {
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const err = new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  return {
    async listDocuments(collection) {
      const url = `${baseUrl}/api/documents?collection=${encodeURIComponent(collection)}`;
      // Without a timeout, a scaled-to-zero or dead server hangs this fetch —
      // and with it the daemon's startup fail-fast check — indefinitely.
      const resp = await fetch(url, {
        method: 'GET',
        headers: headers(),
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      const json = await checkResponse(resp);
      return json.data ?? json ?? [];
    },
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000;
const PUSH_TIMEOUT_MS = 60_000;
/** Timeout for Mech Storage read requests (listDocuments). */
const LIST_TIMEOUT_MS = 30_000;
/** Default walk depth below each source root; overridable per source via walkDepth. */
const DEFAULT_WALK_DEPTH = 8;
/** Default watchdog: a single sync cycle may not hold the sync lock longer than this. */
const SYNC_WATCHDOG_DEFAULT_MS = 10 * 60_000;

/**
 * Watchdog interval, resolved lazily so env overrides set after module load
 * (tests, unified-daemon launches) are respected.
 * @returns {number}
 */
function getSyncWatchdogMs() {
  const raw = Number(process.env.AGENTBOOTUP_SYNC_WATCHDOG_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : SYNC_WATCHDOG_DEFAULT_MS;
}

/** Default bound for each shutdown wait (in-flight sync + final flush). */
const SHUTDOWN_SYNC_WAIT_DEFAULT_MS = 5_000;

/**
 * Bound on the memory-converge startup safety phase (the pre-sync pull/apply).
 * This is the single chokepoint that bounds the WHOLE startup converge phase
 * regardless of how many server fetches it makes, so an unresponsive server
 * cannot wedge daemon startup. The daemon must reach "Daemon running" within
 * startup must accommodate a verified cold snapshot containing hundreds of
 * pages. The timeout bounds only the pre-publication safety phase; on timeout
 * the publication gate stays closed and the periodic converge cycle retries.
 * Resolved lazily so env overrides set after module load are respected.
 * @returns {number}
 */
const CONVERGE_STARTUP_DEFAULT_MS = 60_000;
export function getConvergeStartupMs() {
  const raw = Number(process.env.AGENTBOOTUP_CONVERGE_STARTUP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CONVERGE_STARTUP_DEFAULT_MS;
}

/**
 * How long shutdown may wait on sync work. Deliberately much shorter than the
 * sync watchdog: orchestrator grace periods (docker stop 10s, k8s 30s,
 * systemd ~90s) are far below the 10-minute watchdog, so waiting that long
 * just converts a graceful shutdown into a SIGKILL. Resolved lazily.
 * @returns {number}
 */
function getShutdownSyncWaitMs() {
  const raw = Number(process.env.AGENTBOOTUP_SHUTDOWN_SYNC_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : SHUTDOWN_SYNC_WAIT_DEFAULT_MS;
}
/** Max files per push batch. Server allows up to 500 but smaller batches
 * avoid timeouts on large initial syncs and reduce per-request latency. */
const PUSH_BATCH_SIZE = 50;
/** Health server port for standalone runs. Override via AGENTBOOTUP_BRAIN_DAEMON_PORT. Under unified daemon launches this is irrelevant because AGENTBOOTUP_DISABLE_HEALTH_SERVER=1 prevents the server from starting. */
const HEALTH_PORT = Number(process.env.AGENTBOOTUP_BRAIN_DAEMON_PORT) || 8767;
const HEALTH_SERVER_DISABLED = process.env.AGENTBOOTUP_DISABLE_HEALTH_SERVER === '1';
const SYNC_DEBOUNCE_MS = 2_000;
const LOG_PREFIX = '[brain-asset-sync]';
const DEGRADED_AFTER_FAILED_CYCLES = 3;
const DAEMON_INSTANCE_ID = crypto.randomUUID();
const DATE_CONSTRUCTOR = Date;
const DATE_PARSE = Date.parse;
const DATE_TO_ISO_STRING = Function.call.bind(Date.prototype.toISOString);
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const ARRAY_IS_ARRAY = Array.isArray;
const HAS_OWN = Function.call.bind(Object.prototype.hasOwnProperty);
const CANONICAL_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
let liveSyncHealth = null;

function canonicalTimestamp(candidate) {
  if (
    typeof candidate !== 'string' ||
    candidate.length !== 24 ||
    !CANONICAL_ISO_TIMESTAMP.test(candidate)
  ) return null;
  const milliseconds = DATE_PARSE(candidate);
  if (!Number.isFinite(milliseconds)) return null;
  return DATE_TO_ISO_STRING(new DATE_CONSTRUCTOR(milliseconds)) === candidate ? candidate : null;
}

/**
 * Per-brain identity quarantine for the asset push path (PRD-0054 FR A-2).
 * In-memory by design: a daemon restart re-runs the startup handshake, which
 * covers persistence. Cooldown resolved lazily per record (lazy-env rule).
 * Exported for tests and for `daemon status` surfacing.
 */
export const assetIdentityQuarantine = createQuarantineTracker({
  get cooldownMs() {
    const raw = Number(process.env.AGENTBOOTUP_BRAIN_404_COOLDOWN_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
  },
});

/**
 * PRD-0054 FR 4b: the memory-push gate. Injected by main() from the converge
 * runner; defaults OPEN so importing this module (tests, CLI status readers)
 * never changes behavior. While CLOSED, memory/** sources are excluded from
 * the sync cycle entirely.
 */
let memoryPushGate = () => true;
export function _setMemoryPushGate(fn) { memoryPushGate = typeof fn === 'function' ? fn : () => true; }

/** Converge health snapshot provider (PRD-0054 Slice B), injected by main(). */
let convergeHealthProvider = () => null;
export function _setConvergeHealthProvider(fn) { convergeHealthProvider = typeof fn === 'function' ? fn : () => null; }

/** Log the quarantine skip once per cooldown entry, not every 60s tick. */
const loggedQuarantineWindows = new Map();
/** PRD-0059 FR-9 rollout switch. Off by default; see the call site. */
function isCanonicalSourceEnforced() {
  return process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE === '1';
}

const sourceQuarantineLogged = new Set();
/**
 * Last canonical-source verdict per brain, so `daemon status` can show WHY
 * publishing is blocked. An invisible quarantine is an outage with no symptom:
 * the identity-quarantine path already persists its state, and this must match it.
 */
const sourceQuarantineState = new Map();

function logSourceQuarantineOnce(brainId, verdict, { advisory = false } = {}) {
  const key = `${brainId}:${verdict.reason}:${advisory}`;
  if (sourceQuarantineLogged.has(key)) return;
  sourceQuarantineLogged.add(key);
  const detail = verdict.detail ? ` (${verdict.detail})` : '';
  const legacyAction = verdict.legacy_descriptor === 'present' || verdict.legacy_descriptor === 'unsafe'
    ? ' Legacy repository descriptor evidence was found but is never trusted; run `agentbootup brain source status --source <project>` then explicitly run `agentbootup brain source select`.'
    : '';
  if (advisory) {
    log(
      `NOTE canonical source not declared for '${brainId}': ${verdict.reason}${detail}. ` +
      'Publishing anyway because AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE is not set. ' +
      `Run \`agentbootup brain source status --source <project>\` and explicitly select the source before enabling enforcement.${legacyAction}`,
    );
    return;
  }
  log(
    `Skipping sync: canonical source quarantine for '${brainId}' — ${verdict.reason}${detail}. ` +
    `Declare an explicit source descriptor before this daemon may publish.${legacyAction}`,
  );
}

function logQuarantineSkipOnce(brainId) {
  const entry = assetIdentityQuarantine.get(brainId);
  if (!entry) return;
  if (loggedQuarantineWindows.get(brainId) === entry.cooldownUntil) return;
  loggedQuarantineWindows.set(brainId, entry.cooldownUntil);
  logError(
    `Brain '${brainId}' is not registered (404 not_found) — asset sync quarantined until ${entry.cooldownUntil}. ` +
      `Fix: agentbootup brain register ${brainId}`
  );
}

export function isEphemeralAssetPath(filePath, projectRoot) {
  const relative = path.relative(projectRoot, filePath).split(path.sep).join('/');
  const base = path.basename(filePath);
  return (
    base.endsWith('.loop.log') ||
    base.endsWith('.out.log') ||
    relative === 'memory/wiki-browser.html' ||
    relative.startsWith('memory/narratives/') ||
    relative.startsWith('memory/messages/')
  );
}

export function getBrainSyncHealthPath(brainId) {
  // path.basename confines a configured brain id to one state-file name.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.join(getDaemonDir(), `brain-sync-health-${path.basename(brainId)}.json`);
}

const FAILURE_BEARING_CONVERGE_STATES = new Set([
  'blocked_conflict',
  'store_deferred',
  'publish_blocked',
]);

const SUCCESS_CONVERGE_DETAILS = new Set([
  'startup pull/apply safety phase complete; publication gate awaits periodic safety proof',
  'match',
  'matches fleet',
  'empty_both',
  'empty local tree, nothing published',
  'published (never_published)',
  'published (head_unreadable)',
  'published (tombstone_only_head)',
  'published (page_set_differs)',
  'published (content_differs)',
]);
const STALE_CONVERGE_DETAIL =
  /^stale publication suppressed: local_dirty_age_ms=(?:unknown|(?:0|[1-9]\d{0,15})(?:\.\d{1,6})?) freshest_remote_head_age_ms=(?:0|[1-9]\d{0,15})(?:\.\d{1,6})? stale_publisher_heads=(?:unknown|[A-Za-z0-9._-]{1,64}(?:,[A-Za-z0-9._-]{1,64}){0,15})$/;
const CONVERGE_HEALTH_FIELDS = Object.freeze([
  'state', 'detail', 'failure', 'enabled', 'configSource', 'store', 'gateOpen',
  'lastCycleAt', 'freshnessState', 'freshnessCheckedAt', 'freshnessHeadCount',
  'blockedSince', 'escalated',
]);

function snapshotConvergeHealthFields(value) {
  try {
    if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value)) return null;
    const snapshot = OBJECT_CREATE(null);
    for (let index = 0; index < CONVERGE_HEALTH_FIELDS.length; index += 1) {
      const key = CONVERGE_HEALTH_FIELDS[index];
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
      const field = descriptor && HAS_OWN(descriptor, 'value') ? descriptor.value : undefined;
      OBJECT_DEFINE_PROPERTY(snapshot, key, {
        configurable: true, enumerable: true, writable: true, value: field,
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

function sanitizeConvergeDetail(snapshot, state, failure) {
  if (failure) return formatMemoryConvergenceFailure(failure);
  const detail = typeof snapshot.detail === 'string' ? snapshot.detail : null;
  if ((state === 'ok' || state === 'never_synced') && SUCCESS_CONVERGE_DETAILS.has(detail)) return detail;
  if (state === 'stale' && detail !== null && detail.length <= 1_024 && STALE_CONVERGE_DETAIL.test(detail)) {
    return detail;
  }
  if (state === 'disabled') {
    const source = typeof snapshot.configSource === 'string' ? snapshot.configSource : null;
    if (source === 'persisted' || source === 'env:AGENTBOOTUP_MEMORY_CONVERGE_DISABLED' ||
        source === 'env:AGENTBOOTUP_MEMORY_CONVERGE_ENABLED') {
      return `effective=false source=${source}`;
    }
  }
  return null;
}

function sanitizeMemoryConvergeHealth(value) {
  const snapshot = snapshotConvergeHealthFields(value);
  if (snapshot === null) return null;
  const state = typeof snapshot.state === 'string' ? snapshot.state : 'unknown';
  const failureBearing = FAILURE_BEARING_CONVERGE_STATES.has(state);
  const failureSnapshot = snapshotMemoryConvergenceFailure(snapshot.failure);
  const lockObservation = failureSnapshot !== null &&
    failureSnapshot.phase === 'cycle' &&
    failureSnapshot.category === 'lock_held' &&
    failureSnapshot.exit_code === null;
  const failure = failureBearing
    ? (failureSnapshot ?? normalizeMemoryConvergenceFailure(null))
    : lockObservation ? failureSnapshot : null;
  return {
    state,
    detail: sanitizeConvergeDetail(snapshot, state, failure),
    failure,
    enabled: typeof snapshot.enabled === 'boolean' ? snapshot.enabled : null,
    configSource: typeof snapshot.configSource === 'string' ? snapshot.configSource : null,
    store: typeof snapshot.store === 'string' ? snapshot.store : null,
    gateOpen: typeof snapshot.gateOpen === 'boolean' ? snapshot.gateOpen : null,
    lastCycleAt: typeof snapshot.lastCycleAt === 'string' ? snapshot.lastCycleAt : null,
    freshnessState: typeof snapshot.freshnessState === 'string' ? snapshot.freshnessState : 'unknown',
    freshnessCheckedAt: typeof snapshot.freshnessCheckedAt === 'string' ? snapshot.freshnessCheckedAt : null,
    freshnessHeadCount: Number.isInteger(snapshot.freshnessHeadCount) ? snapshot.freshnessHeadCount : null,
    blockedSince: canonicalTimestamp(snapshot.blockedSince),
    escalated: snapshot.escalated === true,
  };
}

export function readBrainSyncHealth(brainId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getBrainSyncHealthPath(brainId), 'utf8'));
    return {
      brainId: typeof parsed.brainId === 'string' ? parsed.brainId : null,
      consecutiveFailedCycles: Number(parsed.consecutiveFailedCycles) || 0,
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
      lastPushed: Number(parsed.lastPushed) || 0,
      lastErrors: Number(parsed.lastErrors) || 0,
      pid: Number.isInteger(parsed.pid) ? parsed.pid : null,
      instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : null,
      degraded: parsed.degraded === true,
      memoryConverge: sanitizeMemoryConvergeHealth(parsed.memoryConverge),
      quarantinedIdentity: parsed.quarantinedIdentity && typeof parsed.quarantinedIdentity === 'object'
        ? {
          status: Number(parsed.quarantinedIdentity.status) || null,
          code: typeof parsed.quarantinedIdentity.code === 'string' ? parsed.quarantinedIdentity.code : 'unknown',
          cooldownUntil: typeof parsed.quarantinedIdentity.cooldownUntil === 'string' ? parsed.quarantinedIdentity.cooldownUntil : null,
          consecutiveFailures: Number(parsed.quarantinedIdentity.consecutiveFailures) || 0,
        }
        : null,
      memoryReplay: parsed.memoryReplay && typeof parsed.memoryReplay === 'object'
        ? {
          pending: Number.isInteger(parsed.memoryReplay.pending) ? parsed.memoryReplay.pending : null,
          degraded: Number.isInteger(parsed.memoryReplay.degraded) ? parsed.memoryReplay.degraded : null,
          invalid: parsed.memoryReplay.invalid === true,
        }
        : null,
      // This reader is a whitelist, so a field added to the WRITER alone is
      // written to disk and then silently dropped on read. Writer and reader are
      // two halves of one contract; changing one without the other yields a value
      // that looks persisted and never comes back.
      quarantinedSource: parsed.quarantinedSource && typeof parsed.quarantinedSource === 'object'
        ? {
          reason: typeof parsed.quarantinedSource.reason === 'string' ? parsed.quarantinedSource.reason : null,
          detail: typeof parsed.quarantinedSource.detail === 'string' ? parsed.quarantinedSource.detail : null,
          enforced: parsed.quarantinedSource.enforced === true,
          watchedRoot: typeof parsed.quarantinedSource.watchedRoot === 'string' ? parsed.quarantinedSource.watchedRoot : null,
          legacyDescriptor: ['absent', 'present', 'unsafe', 'unknown'].includes(parsed.quarantinedSource.legacyDescriptor)
            ? parsed.quarantinedSource.legacyDescriptor
            : 'unknown',
        }
        : null,
    };
  } catch {
    return null;
  }
}

export function readCurrentBrainSyncHealth(brainId) {
  if (liveSyncHealth?.brainId === brainId) return liveSyncHealth;
  const health = readBrainSyncHealth(brainId);
  if (health?.instanceId !== DAEMON_INSTANCE_ID) return null;
  return health;
}

/**
 * Read health written by a currently-live daemon for consumption by another
 * process (for example the unified CLI). Unlike readCurrentBrainSyncHealth,
 * this cannot compare the writer's instance id with the reader's instance id.
 */
export function readLivePersistedBrainSyncHealth(brainId, expectedPid = null) {
  const health = readBrainSyncHealth(brainId);
  if (!health || health.brainId !== brainId || !Number.isSafeInteger(health.pid) || health.pid <= 0) return null;
  if (expectedPid && health.pid !== expectedPid) return null;
  return health.pid === process.pid || isProcessAlive(health.pid) ? health : null;
}

export function getMemoryReplayHealth(projectRoot) {
  try {
    if (!projectRoot || !hasReplayQueue(projectRoot)) return { pending: 0, degraded: 0, invalid: false };
    const queue = readReplayQueue(projectRoot);
    return {
      pending: queue.items.length,
      degraded: queue.items.filter((item) => ['blocked_conflict', 'degraded', 'failed_invalid_payload'].includes(item.last_outcome?.type)).length,
      invalid: false,
    };
  } catch {
    return { pending: null, degraded: 0, invalid: true };
  }
}

export async function syncAfterSafeConverge(convergePromise, syncFn, reportError = logError) {
  try {
    const health = await convergePromise;
    if (!health?.gateOpen) return false;
    // A caller may attach this continuation before the startup asset pass has
    // released the module-level single-flight promise. Joining that pass would
    // reuse discovery performed while the gate was closed. Drain any owner(s)
    // first, then invoke syncFn in a new turn so it must discover assets afresh.
    while (syncPromise) {
      const active = syncPromise;
      try { await active; } catch { /* the fresh pass below is the retry */ }
      if (syncPromise === active) await Promise.resolve();
    }
    await syncFn();
    return true;
  } catch (error) {
    reportError('Post-converge asset sync failed', error);
    return false;
  }
}

/** Bind health to a canonical real directory only. A symlinked leaf or parent
 * alias must not be converted into an attestation token. */
function runtimeRootBinding(projectRoot) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return null;
  try {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- projectRoot passed the absolute-path gate above; resolve only normalizes trailing separators before canonical identity comparison.
    const lexicalRoot = path.resolve(projectRoot);
    const stat = fs.lstatSync(lexicalRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const stableRoot = fs.realpathSync(lexicalRoot);
    if (lexicalRoot !== stableRoot) return null;
    return crypto.createHash('sha256').update(stableRoot).digest('hex');
  } catch {
    return null;
  }
}

export function recordBrainSyncHealth(brainId, pushed, errors, projectRoot = process.env.AGENTBOOTUP_PROJECT_ROOT || null) {
  const previous = liveSyncHealth?.brainId === brainId
    ? liveSyncHealth
    : readBrainSyncHealth(brainId);
  const consecutiveFailedCycles = pushed === 0 && errors > 0
    ? (previous?.instanceId === DAEMON_INSTANCE_ID ? previous.consecutiveFailedCycles : 0) + 1
    : 0;
  const health = {
    brainId,
    consecutiveFailedCycles,
    lastSyncAt: new Date().toISOString(),
    lastPushed: pushed,
    lastErrors: errors,
    pid: process.pid,
    instanceId: DAEMON_INSTANCE_ID,
    // This is deliberately an opaque binding rather than a pathname.  It lets
    // a read-only burn-in verifier prove that the *live* daemon was launched
    // for the declared checkout without leaking that checkout in health files.
    runtimeRootBinding: runtimeRootBinding(projectRoot),
    degraded: consecutiveFailedCycles >= DEGRADED_AFTER_FAILED_CYCLES,
    memoryReplay: getMemoryReplayHealth(projectRoot),
    quarantinedIdentity: assetIdentityQuarantine.get(brainId),
    quarantinedSource: sourceQuarantineState.get(brainId) ?? null,
    memoryConverge: sanitizeMemoryConvergeHealth(convergeHealthProvider()),
  };
  const healthPath = getBrainSyncHealthPath(brainId);
  try {
    fs.mkdirSync(path.dirname(healthPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${healthPath}.tmp`;
    fs.writeFileSync(temporaryPath, stringifyJsonEnvelope(health) + '\n', { mode: 0o600 });
    fs.renameSync(temporaryPath, healthPath);
    liveSyncHealth = null;
    return { ...health, persisted: true };
  } catch (persistenceError) {
    // Keep the active daemon truthful even when its state directory is unavailable.
    liveSyncHealth = health;
    return { ...health, persisted: false, persistenceError };
  }
}

/**
 * Format the fail-fast error message shown when Mech Storage has no skills for a brain.
 * Exported so tests can import the real string instead of constructing it locally.
 *
 * @param {string} brainId
 * @returns {string}
 */
export function formatFailFastMessage(brainId) {
  return `${LOG_PREFIX} ERROR: No skills found in Mech Storage for ${brainId}. Run: agentbootup skills migrate --from static --to mech-storage`;
}

// ── State file ────────────────────────────────────────────────────────────────

/**
 * Resolve the brain sync state file path, evaluated lazily so test env vars
 * are respected even under ES module hoisting.
 * @returns {string}
 */
function getStateFilePath() {
  if (process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE) {
    return process.env.AGENTBOOTUP_BRAIN_SYNC_STATE_FILE;
  }
  const brainId = process.env.AGENTBOOTUP_BRAIN_ID;
  const filename = brainId
    ? `brain-sync-state-${brainId}.json`
    : 'brain-sync-state.json';
  return path.join(os.homedir(), '.agentbootup', filename);
}

/**
 * Read brain sync state.
 * Returns {} if the file does not exist or cannot be parsed.
 * State shape: { [absoluteFilePath]: { mtime: number, size: number } }
 * @returns {Record<string, { mtime: number, size: number }>}
 */
function readState() {
  const stateFile = getStateFilePath();
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    // Strip internal version key if present.
    const { _version: _v, ...rest } = parsed;
    return rest;
  } catch {
    return {};
  }
}

/**
 * Persist brain sync state atomically.
 * @param {Record<string, { mtime: number, size: number }>} state
 */
function writeState(state) {
  const stateFile = getStateFilePath();
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpFile = stateFile + '.tmp';
  fs.writeFileSync(
    tmpFile,
    JSON.stringify(state, null, 2) + '\n',
    { mode: 0o600 }
  );
  fs.renameSync(tmpFile, stateFile);
}

// ── Runtime stats ─────────────────────────────────────────────────────────────

const stats = {
  startedAt: new Date().toISOString(),
  pushes: 0,
  errors: 0,
  filesWatched: 0,
  lastSyncAt: null,
};

// ── Logging ───────────────────────────────────────────────────────────────────

const daemonLogContext = new AsyncLocalStorage();

function defaultLog(msg) {
  process.stdout.write(`${new Date().toISOString()} ${LOG_PREFIX} ${msg}\n`);
}

function defaultLogError(msg, err) {
  process.stderr.write(
    `${new Date().toISOString()} ${LOG_PREFIX} ERROR ${msg}${err ? ': ' + err.message : ''}\n`
  );
}

function log(msg) { (daemonLogContext.getStore()?.log ?? defaultLog)(msg); }
function logError(msg, err) { (daemonLogContext.getStore()?.logError ?? defaultLogError)(msg, err); }

// ── File discovery ────────────────────────────────────────────────────────────

/**
 * Async generator: yields all files under `dir` up to `opts.maxDepth` levels deep.
 * Symbolic links are skipped to prevent infinite loops. Well-known non-asset
 * directories (node_modules, .git, vendor, ...) are pruned without descending —
 * match() already rejected their contents, so walking them only burned time
 * (on large repos, enough to wedge the initial sync). Exported for tests.
 *
 * @param {string} dir
 * @param {number} depth
 * @param {{ maxDepth?: number, signal?: AbortSignal }} opts
 * @yields {string}
 */
export async function* walkDir(dir, depth = 0, opts = {}) {
  // The default depth 8 is well beyond any real asset structure.
  // Acts as a runaway-recursion guard, not a meaningful tree limit.
  const maxDepth = opts.maxDepth ?? DEFAULT_WALK_DEPTH;
  if (depth > maxDepth) return;
  if (opts.signal?.aborted) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // Skip symlinks — they may point to already-watched directories and cause loops.
    if (e.isSymbolicLink()) continue;
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- e.name is a single Dirent basename returned by readdir; symlinks are rejected before recursion.
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (WALK_SKIP_DIRS.has(e.name)) continue;
      yield* walkDir(full, depth + 1, opts);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/**
 * Discover all brain asset files across all watched source directories.
 * Exported for tests.
 *
 * @param {ReturnType<typeof getBrainAssetSources>} sources
 * @param {ReturnType<typeof createSecretGuard>} secretGuard
 * @param {string} projectRoot
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{
 *   cli: string,
 *   asset_type: string,
 *   path: string,
 *   relative_path: string,
 * }>>}
 */
export async function discoverAllAssets(sources, secretGuard, projectRoot, signal) {
  const results = [];
  const memorySourceActive = sources.some((source) =>
    source.asset_type === 'memory' && fs.existsSync(source.rootFn()),
  );
  // Resolve one immutable policy snapshot per discovery pass. If the operator
  // edits the policy mid-pass, the next daemon cycle adopts it; mixing two
  // policy generations into one outbound inventory would be unsafe.
  const selectedMemoryPaths = memorySourceActive
    ? collectSelectedMemoryPaths(projectRoot, 'brain asset daemon discovery')
    : null;
  for (const source of sources) {
    const root = source.rootFn();
    if (source.asset_type === 'memory' && selectedMemoryPaths) {
      for (const relFromProject of selectedMemoryPaths.filter(isPublishableMemoryPath)) {
        throwIfAborted(signal);
        results.push({
          cli: source.cli,
          asset_type: source.asset_type,
          // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- selector output is validated by collectSelectedMemoryPaths: relative, slash-only, and no . or .. components.
          path: path.join(path.resolve(projectRoot), ...relFromProject.split('/')),
          relative_path: relFromProject.slice('memory/'.length),
        });
      }
      continue;
    }
    const walkOpts = { maxDepth: source.walkDepth ?? DEFAULT_WALK_DEPTH, signal };
    for await (const filePath of walkDir(root, 0, walkOpts)) {
      throwIfAborted(signal);
      if (!source.match(filePath)) continue;
      if (secretGuard.shouldSkip(filePath)) continue;
      if (isEphemeralAssetPath(filePath, projectRoot)) continue;
      try {
        if ((await fsp.stat(filePath)).size === 0) continue;
      } catch {
        continue;
      }

      // relative_path is relative to the *asset root* (e.g. '.claude/skills'),
      // NOT the project root. _doSync recomputes the project-root-relative path
      // from filePath before building the push payload; this value is only used
      // as a fallback for the (normally unreachable) case where filePath lies
      // outside the project root.
      const rootNorm = root.endsWith(path.sep) ? root : root + path.sep;
      const relative_path = filePath
        .slice(rootNorm.length)
        .split(path.sep)
        .join('/');

      results.push({
        cli: source.cli,
        asset_type: source.asset_type,
        path: filePath,
        relative_path,
      });
    }
  }
  // Sort by relative_path for deterministic ordering across platforms.
  results.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return results;
}

// ── Sync logic ────────────────────────────────────────────────────────────────

/**
 * Tracks the currently-running _doSync call. Used by `shutdown` to await
 * completion, and by `syncPendingFiles` to skip concurrent invocations.
 */
let syncPromise = null;

/** Throw the abort reason when the signal has fired. */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('sync aborted');
}

/**
 * Push changed brain assets to the server.
 *
 * If a sync is already in progress the call returns the existing Promise so
 * the caller can await it without starting a second concurrent sync.
 *
 * A watchdog bounds how long one cycle may hold the sync lock. Without it, a
 * single hung cycle (slow walk, unresponsive server) wedged the daemon
 * permanently: every subsequent tick saw the stale lock and skipped, so no
 * assets ever synced again until a manual restart. On timeout the cycle is
 * aborted AND the lock is force-released — even if the hung operation ignores
 * the abort signal — so the next tick starts fresh. An aborted cycle never
 * writes sync state or health (see _doSync), so an abandoned straggler cannot
 * race a newer cycle's writes.
 *
 * @param {string} brainId
 * @param {string} apiKey
 * @param {string} serverUrl
 * @param {string} projectRoot
 * @param {ReturnType<typeof getBrainAssetSources>} sources
 * @param {ReturnType<typeof createSecretGuard>} secretGuard
 * @returns {Promise<void>}
 */
export async function syncPendingFiles(brainId, apiKey, serverUrl, projectRoot, sources, secretGuard, machineId) {
  // Identity quarantine (FR A-2): an unregistered brain must not spin 404
  // cycles — skip entirely until the cooldown expires, logging once per
  // quarantine window rather than every tick.
  if (assetIdentityQuarantine.isQuarantined(brainId)) {
    logQuarantineSkipOnce(brainId);
    return;
  }
  // Canonical-source quarantine (PRD-0059 FR-9). A daemon with no explicit,
  // resolvable source declaration must not publish: without one, whatever branch
  // happens to be checked out becomes the fleet's source of truth.
  //
  // Enforcement is OPT-IN and defaults OFF. Every existing daemon predates the
  // descriptor, so enforcing by default would quarantine the entire fleet at once
  // on upgrade — a non-destructive rollout is a standing requirement, not a
  // preference. Off, this reports the verdict it WOULD have reached, which is what
  // makes the eventual flip an informed decision rather than a surprise.
  const sourceVerdict = evaluateDaemonSource(projectRoot);
  if (!sourceVerdict.may_publish) {
    sourceQuarantineState.set(brainId, {
      reason: sourceVerdict.reason ?? null,
      detail: sourceVerdict.detail ?? null,
      enforced: isCanonicalSourceEnforced(),
      watchedRoot: sourceVerdict.watched_root ?? projectRoot,
      legacyDescriptor: sourceVerdict.legacy_descriptor ?? 'unknown',
    });
    if (isCanonicalSourceEnforced()) {
      logSourceQuarantineOnce(brainId, sourceVerdict);
      // Persist BEFORE returning. A quarantine `daemon status` cannot see is an
      // outage with no symptom — the operator is told nothing while nothing
      // publishes. The identity-quarantine path already does this; skipping it
      // here would have been a regression against an existing guarantee.
      const health = recordBrainSyncHealth(brainId, 0, 0, projectRoot);
      if (!health.persisted) logError('Failed to persist sync health', health.persistenceError);
      return;
    }
    logSourceQuarantineOnce(brainId, sourceVerdict, { advisory: true });
  } else {
    sourceQuarantineState.delete(brainId);
  }
  if (syncPromise) {
    log('Sync already in progress, skipping');
    return syncPromise;
  }
  const watchdogMs = getSyncWatchdogMs();
  const controller = new AbortController();
  const cycle = _doSync(brainId, apiKey, serverUrl, projectRoot, sources, secretGuard, machineId, controller.signal);
  let watchdog;
  let guarded;
  // Every await on this cycle must settle when the watchdog fires — the
  // starter (main() awaits the initial sync before installing the poll
  // timer) AND any joiner handed the in-progress promise above. A cycle
  // that ignores abort and never settles would otherwise wedge its
  // awaiters forever even with the lock released, so the shared lock
  // promise is the watchdog-raced one, never the raw cycle.
  const watchdogFired = new Promise((resolve) => {
    watchdog = setTimeout(() => {
      logError(`Sync watchdog: cycle still running after ${watchdogMs}ms — aborting it and releasing the sync lock`);
      controller.abort(new Error(`sync watchdog timeout after ${watchdogMs}ms`));
      if (syncPromise === guarded) syncPromise = null;
      resolve();
    }, watchdogMs);
    watchdog.unref?.();
  });
  guarded = Promise.race([cycle, watchdogFired]).finally(() => {
    clearTimeout(watchdog);
    // Guard against clearing a newer cycle's lock: if the watchdog already
    // released this cycle and another one started, syncPromise is not ours.
    if (syncPromise === guarded) syncPromise = null;
  });
  syncPromise = guarded;
  return guarded;
}

async function _doSync(brainId, apiKey, serverUrl, projectRoot, sources, secretGuard, machineId, signal) {
  try {
    // FR 4b: while the memory-push gate is closed, memory/** never enters
    // discovery — a stale machine must converge before its memory reaches
    // the fleet. Non-memory assets sync normally.
    const effectiveSources = memoryPushGate() ? sources : sources.filter((s) => s.asset_type !== 'memory');
    const assets = await discoverAllAssets(effectiveSources, secretGuard, projectRoot, signal);
    stats.filesWatched = assets.length;

    const state = readState();
    const newState = { ...state };
    let pushCount = 0;
    let errCount = 0;
    let stateChanged = false;

    // Phase 1: collect all changed files in one pass before any network I/O.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- projectRoot is the daemon's configured CWD/root and this normalization is only used for later containment comparison.
    const projRoot = path.resolve(projectRoot);
    const projRootNorm = projRoot.endsWith(path.sep) ? projRoot : projRoot + path.sep;

    /** @type {Array<{filePath: string, stat: import('fs').Stats, entry: object}>} */
    const pendingFiles = [];

    for (const { cli, asset_type, path: filePath, relative_path } of assets) {
      throwIfAborted(signal);
      try {
        const stat = await fsp.stat(filePath);
        const storedEntry = newState[filePath];

        if (
          storedEntry &&
          storedEntry.mtime === stat.mtimeMs &&
          storedEntry.size === stat.size
        ) {
          continue;
        }

        if (stat.size === 0) continue;

        const content = await fsp.readFile(filePath);
        const content_base64 = content.toString('base64');
        const relFromProject = filePath.startsWith(projRootNorm)
          ? filePath.slice(projRootNorm.length).split(path.sep).join('/')
          : relative_path;

        pendingFiles.push({
          filePath,
          stat,
          entry: { path: relFromProject, content_base64, asset_type, cli },
        });
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        logError(`Failed to read ${path.basename(filePath)}`, err);
        errCount++;
      }
    }

    // Phase 2: serialize exact request bodies and bound by bytes as well as the
    // existing daemon file-count ceiling. Machine metadata is part of every
    // candidate payload, so its UTF-8 JSON overhead is included in the bound.
    const machineInfo = getMachineInfo();
    const makePayload = (batch) => ({
      files: batch.map((file) => file.entry),
      machine_id: machineId,
      machine_info: machineInfo,
    });
    let plan;
    try {
      plan = planBrainAssetPushBatches({
        items: pendingFiles,
        maxFiles: PUSH_BATCH_SIZE,
        makePayload,
      });
    } catch (error) {
      logError('Invalid brain asset transport policy', error);
      errCount += Math.max(1, pendingFiles.length);
      plan = { batches: [], oversized: [], budget: 0 };
    }
    for (const oversized of plan.oversized) {
      errCount++;
      logError(`Cannot transport ${oversized.path}`, createBrainAssetSizeError(oversized));
    }

    for (const plannedBatch of plan.batches) {
      throwIfAborted(signal);
      const settledPaths = new Set();
      try {
        await sendBrainAssetBatchWith413Split(plannedBatch, {
          makePayload,
          send: async (requestBatch) => {
            // Per-request timeout, composed with the cycle watchdog signal.
            const controller = new AbortController();
            const timerId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
            const onCycleAbort = () => controller.abort(signal?.reason);
            signal?.addEventListener('abort', onCycleAbort, { once: true });
            try {
              return await fetch(
                apiUrl(serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}/push`),
                {
                  method: 'POST',
                  headers: brainAssetPushHeaders(apiKey),
                  body: requestBatch.body,
                  signal: controller.signal,
                },
              );
            } finally {
              clearTimeout(timerId);
              signal?.removeEventListener('abort', onCycleAbort);
            }
          },
          onLeaf: async ({ batch, response: resp }) => {
            for (const file of batch.items) settledPaths.add(file.filePath);
            if (!resp.ok) {
              const body = await resp.text().catch(() => '');
              if (isNotFoundBrainResponse(resp, body)) {
                const entry = assetIdentityQuarantine.record(brainId, {
                  status: resp.status,
                  code: 'not_found',
                  message: body.slice(0, 200),
                });
                logQuarantineSkipOnce(brainId);
                throw new Error(`brain '${brainId}' not registered — quarantined until ${entry.cooldownUntil}`);
              }
              if (resp.status === 413) {
                const failed = batch.items[0];
                errCount++;
                logError(`Failed to sync ${failed.entry.path}`, createBrainAssetSizeError({
                  path: failed.entry.path,
                  encodedBytes: batch.encodedBytes,
                  budget: plan.budget,
                  status: 413,
                }));
                return;
              }
              errCount += batch.items.length;
              logError(`Failed to push batch of ${batch.items.length} files`, new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`));
              return;
            }

            if (assetIdentityQuarantine.get(brainId)) {
              assetIdentityQuarantine.clear(brainId);
              loggedQuarantineWindows.delete(brainId);
              log(`Brain '${brainId}' registration confirmed — identity quarantine cleared`);
            }

            const respJson = await resp.json().catch(() => null);
            const fileResults = respJson?.data?.results ?? [];
            const succeededPaths = new Set(
              fileResults
                .filter((result) => result.status === 'pushed' || result.status === 'updated')
                .map((result) => result.path),
            );
            for (const { filePath, stat, entry } of batch.items) {
              if (succeededPaths.has(entry.path)) {
                newState[filePath] = { mtime: stat.mtimeMs, size: stat.size };
                pushCount++;
                stateChanged = true;
              } else {
                errCount++;
                logError(`Server-side error syncing ${entry.path}`, new Error(
                  fileResults.find((result) => result.path === entry.path)?.error ?? 'unknown',
                ));
              }
            }
          },
        });
      } catch (err) {
        // A watchdog abort must stop the whole cycle, not fall through to the
        // state write below with partial results.
        throwIfAborted(signal);
        // An identity quarantine likewise ends the cycle — every remaining
        // batch would 404 the same way (already logged by the quarantine).
        if (assetIdentityQuarantine.isQuarantined(brainId)) throw err;
        const unsettled = plannedBatch.items.filter((file) => !settledPaths.has(file.filePath));
        logError(`Failed to push batch of ${unsettled.length} files`, err);
        errCount += unsettled.length;
      }
    }

    // An aborted cycle must not write state or health: an abandoned straggler
    // resuming later could otherwise race the writes of a newer cycle.
    throwIfAborted(signal);

    // GC: remove stale state keys for files that no longer exist.
    const currentPaths = new Set(assets.map((f) => f.path));
    const prunedState = Object.fromEntries(
      Object.entries(newState).filter(([k]) => currentPaths.has(k))
    );
    if (Object.keys(prunedState).length !== Object.keys(newState).length) {
      stateChanged = true;
    }

    // State is written once per full scan to minimise syscall overhead.
    if (stateChanged) writeState(prunedState);

    stats.pushes += pushCount;
    stats.errors += errCount;
    stats.lastSyncAt = new Date().toISOString();
    const health = recordBrainSyncHealth(brainId, pushCount, errCount, projectRoot);
    if (!health.persisted) logError('Failed to persist sync health', health.persistenceError);

    // Log every completed cycle — including idle ones. Without the idle line,
    // a healthy-but-quiet daemon and a permanently wedged one produce the same
    // log output, and operators cannot tell them apart.
    const cycleCount = health?.consecutiveFailedCycles ?? 'unavailable';
    log(`Sync complete: pushed=${pushCount} errors=${errCount} consecutive_failed_cycles=${cycleCount}`);

    // Auto-push network config if this daemon runs at the network root
    await maybeAutoPushNetworkConfig(apiKey, serverUrl, projectRoot);
  } catch (err) {
    // A watchdog abort is an expected recovery path the watchdog already
    // logged — don't double-log it as a sync error.
    if (signal?.aborted && err === signal.reason) return;
    // Same for an identity quarantine: logged once per window already — but
    // the quarantine must still reach the PERSISTED health record, or
    // `daemon status` (which reads it) never shows quarantined_identity for
    // a brain that has never completed a cycle.
    if (assetIdentityQuarantine.isQuarantined(brainId)) {
      const health = recordBrainSyncHealth(brainId, 0, 1, projectRoot);
      if (!health.persisted) logError('Failed to persist sync health', health.persistenceError);
      return;
    }
    logError('Sync error', err);
  }
}

/** Mtime of agentbootup.json at last successful network config push. */
let lastNetworkConfigMtime = 0;

/**
 * Reset the cached network config mtime to zero. For use in tests only.
 */
export function _resetNetworkConfigMtime() {
  lastNetworkConfigMtime = 0;
}

/**
 * If the daemon's project root is the network root and agentbootup.json has
 * changed since our last push, push it to the server (with paths stripped).
 */
export async function maybeAutoPushNetworkConfig(apiKey, serverUrl, projectRoot) {
  try {
    const networkRoot = await getNetworkRoot();
    if (!networkRoot) return;

    // Normalize both paths for comparison
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- both roots are compared only; no untrusted suffix is joined or written here.
    const resolvedProject = path.resolve(projectRoot);
    const resolvedNetwork = path.resolve(networkRoot);
    if (resolvedProject !== resolvedNetwork) return;

    const configPath = path.join(resolvedNetwork, 'agentbootup.json');
    let stat;
    try { stat = await fsp.stat(configPath); } catch { return; }

    if (stat.mtimeMs === lastNetworkConfigMtime) return;

    const { pushNetworkConfig } = await import('../sync/brains.js');
    const raw = await fsp.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);

    if (config.role !== 'network') return;

    await pushNetworkConfig({ apiKey, serverUrl }, config);
    lastNetworkConfigMtime = stat.mtimeMs;
    log(`Auto-pushed network config: ${(config.projects || []).length} project(s)`);
  } catch (err) {
    logError('Auto-push network config failed', err);
  }
}

// ── Health / status HTTP server ───────────────────────────────────────────────

/**
 * Start a minimal HTTP server on 127.0.0.1:HEALTH_PORT exposing:
 *   GET /health  → { healthy: true, uptime }
 *   GET /status  → { ...stats, uptime }
 * @returns {http.Server}
 */
export function startHealthServer(brainId, port = HEALTH_PORT) {
  const server = http.createServer((req, res) => {
    // Abort slow clients after 5 s to prevent slowloris-style connection hold.
    res.setTimeout(5_000, () => { res.destroy(); });
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (req.url === '/health') {
      const syncHealth = readCurrentBrainSyncHealth(brainId);
      const replayHealth = syncHealth?.memoryReplay;
      const healthy =
        !syncHealth?.degraded &&
        syncHealth?.lastErrors === 0 &&
        !replayHealth?.invalid &&
        !(replayHealth?.degraded > 0) &&
        !syncHealth?.quarantinedIdentity &&
        isConvergeHealthSafe(syncHealth?.memoryConverge);
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(stringifyJsonEnvelope({ healthy, uptime: process.uptime(), syncHealth }));
      return;
    }

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(stringifyJsonEnvelope({ ...stats, syncHealth: readCurrentBrainSyncHealth(brainId), uptime: process.uptime() }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.requestTimeout = 5_000;
  server.headersTimeout = 3_000;

  server.listen(port, '127.0.0.1', () => {
    log(`Health server listening on 127.0.0.1:${port}`);
  });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      // Distinguish between "our own daemon is running" and "something else owns this port".
      const pidFile = getPidFilePath('brain-asset-sync');
      const existingPid = await fsp
        .readFile(pidFile, 'utf-8')
        .then((s) => parseInt(s.trim(), 10))
        .catch(() => null);
      if (existingPid && Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
        process.stderr.write(
          `Brain asset sync daemon already running (PID ${existingPid}). ` +
            'Run `agentbootup daemon stop` first.\n'
        );
      } else {
        process.stderr.write(
          `Port ${port} is already in use by another process. ` +
            'Use AGENTBOOTUP_BRAIN_DAEMON_PORT env var to choose a different port.\n'
        );
      }
      process.exit(1);
    }
    logError('Health server error', err);
  });

  return server;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Build the remote-local part of the standard managed daemon.
 *
 * A local embedding process may pass `installHostExtensions` explicitly. It
 * is forwarded only through this local factory into the sealed runtime; it is
 * never read from environment/configuration state or remote input.
 */
export async function createManagedRemoteLocalConnector({ brainId, serverUrl, installHostExtensions, logErrorImpl = logError, createSupervisedConnector = createSupervisedRemoteLocalConnector } = {}) {
  return createSupervisedConnector({
    brainId,
    serverUrl,
    hostExtensionInstaller: installHostExtensions,
    // Mech Plane's continuation bridge intentionally runs through Bun. Keep
    // it behind the sealed, default-off v2 connector gate so the ordinary
    // Node CLI never evaluates the execution bridge.
    createHandler: async (config, { hostExtensionInstaller } = {}) => {
      const { createRemoteLocalMechPlaneRuntime } = await import('./remote-local-mech-plane-runtime.mjs');
      return createRemoteLocalMechPlaneRuntime(config.runtime, { installHostExtensions: hostExtensionInstaller }).handler;
    },
    logError: (message, error) => logErrorImpl(message, error),
  });
}

/** Start the standard managed daemon with optional local-only extensions. */
export async function startManagedBrainAssetSync({ installHostExtensions, logImpl, logErrorImpl } = {}) {
  // Keep a CLI's machine-readable stream uncontaminated without changing the
  // default daemon logs or leaking a process-global sink into another daemon.
  if (typeof logImpl === 'function' || typeof logErrorImpl === 'function') {
    return daemonLogContext.run({ log: logImpl ?? defaultLog, logError: logErrorImpl ?? defaultLogError }, () => startManagedBrainAssetSync({ installHostExtensions }));
  }
  log('Starting brain asset sync daemon');

  const credentialState = await inspectCredentials();
  if (credentialState.state !== CREDS_STATE_OK) {
    throw new Error(formatCredentialsRecoveryMessage(credentialState));
  }
  const creds = credentialState.creds;

  const brainId = process.env.AGENTBOOTUP_BRAIN_ID || await getBrainId();
  if (!brainId) {
    throw new Error('No brain ID configured. Run: agentbootup config set-brain <id>');
  }

  const machineId = await getMachineId();
  const { apiKey, serverUrl } = creds;

  if (!isPlausibleServerUrl(serverUrl)) {
    throw new Error(`Invalid server URL in credentials: "${serverUrl}". Port 0 or non-http(s) is not a valid target. Re-run auth login --server-url <url>.`);
  }

  log(`brain=${brainId} machine=${machineId} server=${serverUrl}`);
  log(
    `NOTE: brain assets (skills, agents, commands, memory, protocols) will be uploaded to ${serverUrl}`
  );

  // Project root is CWD — the daemon is expected to be launched from the
  // project directory (or with an appropriate CWD set by the CLI).
  const projectRoot = process.env.AGENTBOOTUP_PROJECT_ROOT || process.cwd();
  // The connector shares this managed daemon's lifecycle. It is explicitly
  // default-off and cannot turn the general API credential into device authority.
  const remoteLocalConnector = await createManagedRemoteLocalConnector({ brainId, serverUrl, installHostExtensions });

  // Startup identity handshake (PRD-0054 FR A-1): fail fast and loud on an
  // unregistered brain instead of 404-ing every cycle forever. Fails OPEN on
  // transient server trouble — this is a fast-fail aid, not a dependency.
  const handshake = await verifyBrainRegistered({ brainId, apiKey, serverUrl });
  if (handshake.outcome === 'not_found') {
    assetIdentityQuarantine.record(brainId, { status: 404, code: 'not_found', message: handshake.detail || '' });
    logQuarantineSkipOnce(brainId);
    // Persist immediately so `daemon status` shows the quarantine even
    // though no sync cycle will run while it holds.
    const health = recordBrainSyncHealth(brainId, 0, 0, projectRoot);
    if (!health.persisted) logError('Failed to persist sync health', health.persistenceError);
  } else if (handshake.outcome === 'unavailable') {
    log(`Identity handshake inconclusive (${handshake.detail}) — proceeding fail-open`);
  } else {
    log(`Identity handshake OK: brain '${brainId}' is registered`);
  }
  // Do not present device material to the relay until the daemon's existing
  // brain-identity check has at least ruled out a known missing brain.
  if (handshake.outcome !== 'not_found') remoteLocalConnector.start();

  // Fail-fast: when running in mech-storage mode, require at least one skill
  // in Mech Storage to prevent silent data loss from an empty migration.
  const skillsMode = process.env.AGENTBOOTUP_SKILLS_MODE;
  if (skillsMode === 'mech-storage') {
    const { MechStorageBackend } = await import('../skill-projection/backends/mech-storage.js');
    const mechBaseUrl = process.env.MECH_STORAGE_URL || 'https://storage.mechdna.net';
    const mechAppId = process.env.MECH_APP_ID || '';
    const mechApiKey = process.env.MECH_API_KEY || '';
    const mechClient = buildMechStorageClient({ appId: mechAppId, apiKey: mechApiKey, baseUrl: mechBaseUrl });
    const backend = new MechStorageBackend({ mechClient, agentId: brainId });
    let isEmpty;
    try {
      isEmpty = await backend.isEmptyStore();
    } catch (err) {
      throw new Error(`${LOG_PREFIX} ERROR: Could not check Mech Storage for ${brainId}: ${err.message}`);
    }
    if (isEmpty) {
      throw new Error(formatFailFastMessage(brainId));
    }
  }


  const sources = getBrainAssetSources(projectRoot);
  const secretGuard = createSecretGuard(projectRoot);

  const healthServer = HEALTH_SERVER_DISABLED ? null : startHealthServer(brainId);

  // Log all watched directories so users know exactly what the daemon collects.
  const watchedRoots = sources
    .map((s) => `  ${s.cli}/${s.asset_type}: ${s.rootFn()}`)
    .join('\n');
  log(`Watching brain asset directories:\n${watchedRoots}`);

  // fs.watch({ recursive: true }) is natively supported on macOS and Windows.
  // On Linux, recursive watching requires Node >= 22. We skip watcher setup on
  // unsupported platforms and rely solely on the 60-second poll fallback.
  const RECURSIVE_WATCH_SUPPORTED =
    process.platform === 'darwin' ||
    process.platform === 'win32' ||
    (process.platform === 'linux' && parseInt(process.versions.node, 10) >= 22);
  if (!RECURSIVE_WATCH_SUPPORTED) {
    log(
      `Real-time fs.watch disabled on ${process.platform} (requires macOS/Windows or Node >= 22). ` +
        'Syncing via 60s poll fallback only.'
    );
  }

  // Watch each asset root directory for real-time change events.
  const watchers = [];
  let debounceTimer = null;

  const scheduleSync = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      syncPendingFiles(brainId, apiKey, serverUrl, projectRoot, sources, secretGuard, machineId).catch(
        (err) => logError('Sync failed', err)
      );
    }, SYNC_DEBOUNCE_MS);
  };

  if (RECURSIVE_WATCH_SUPPORTED) {
    for (const source of sources) {
      const root = source.rootFn();
      if (!fs.existsSync(root)) continue;
      try {
        const watcher = fs.watch(root, { recursive: source.watchRecursive !== false }, (_, filename) => {
          // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- filename is an fs.watch event name; this path is passed only to a source matcher, never read or written.
          if (filename && source.match(path.join(root, filename))) {
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

  // Graceful shutdown: wait for any in-flight sync, then perform a final flush.
  // Installed BEFORE the awaited initial sync — otherwise a SIGTERM arriving
  // during a long initial cycle hits the default handler and kills the
  // process with no graceful path at all.
  let pollTimer = null;
  const shutdown = async () => {
    log('Shutting down...');
    if (pollTimer) clearInterval(pollTimer);
    if (convergeTimer) clearInterval(convergeTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) w.close();
    healthServer?.close();
    await remoteLocalConnector.stop();
    // Both shutdown waits (in-flight sync, then the final flush — which
    // starts a NEW cycle carrying the full sync watchdog) are bounded by the
    // much shorter shutdown wait: a wedged server must not be able to hold
    // the process past orchestrator grace periods. An interrupted flush just
    // means those files are re-pushed on next start.
    const boundedWait = (promise) => Promise.race([
      promise.catch(() => {}),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, getShutdownSyncWaitMs());
        timer.unref?.();
      }),
    ]);
    if (syncPromise) await boundedWait(syncPromise);
    // Only attempt the final flush when the lock is actually free — with a
    // still-wedged cycle holding it, syncPendingFiles would just rejoin the
    // stuck cycle, making "final flush" a false promise. Skipping is safe:
    // unrecorded files are re-pushed on next start.
    if (syncPromise) {
      log('In-flight sync still wedged past the shutdown wait — skipping final flush; files will re-push on next start');
    } else {
      await boundedWait(
        syncPendingFiles(brainId, apiKey, serverUrl, projectRoot, sources, secretGuard, machineId).catch(
          (err) =>
            logError('Final sync on shutdown failed — some files may be re-pushed on next start', err)
        )
      );
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
  process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));
  log('Signal handlers installed — starting initial sync');

  // Memory converge defaults active. The converge runner resolves persisted
  // config + environment precedence and drives the FR-4b gate. A bounded
  // startup cycle runs BEFORE initial asset sync so a stale machine pulls
  // before anything it holds can reach the fleet.
  const convergeRunner = createConvergeRunner({
    projectRoot,
    brainId,
    log,
    logError,
    onEscalate: (info) => {
      logError(
        `ESCALATION: memory blocked_conflict for '${info.brainId}' since ${info.blockedSince} — ${info.detail}`
      );
    },
  });
  _setMemoryPushGate(() => convergeRunner.isMemoryPushGateOpen());
  _setConvergeHealthProvider(() => convergeRunner.health());
  let convergeTimer = null;
  await convergeRunner.runStartupCycle(getConvergeStartupMs()).catch((err) => logError('Startup converge failed', err));
  // Startup is pull/apply-only and deliberately leaves raw memory closed.
  // Begin the complete terminal proof immediately, without delaying the
  // initial non-memory asset pass. Once the proof opens the gate, perform a
  // fresh discovery pass so memory does not wait for the periodic timer.
  const initialConvergeProof = convergeRunner.runCycle().catch((err) => {
    logError('Initial converge proof failed', err);
    return null;
  });
  convergeTimer = setInterval(() => {
    convergeRunner.runCycle().catch((err) => logError('Converge cycle failed', err));
  }, getConvergeIntervalMs());
  convergeTimer.unref?.();

  // Initial sync on startup, then periodic polling fallback.
  await syncPendingFiles(brainId, apiKey, serverUrl, projectRoot, sources, secretGuard, machineId).catch(
    (err) => logError('Initial sync failed', err)
  );
  void syncAfterSafeConverge(
    initialConvergeProof,
    () => syncPendingFiles(brainId, apiKey, serverUrl, projectRoot, sources, secretGuard, machineId),
    logError,
  );
  pollTimer = setInterval(() => {
    syncPendingFiles(brainId, apiKey, serverUrl, projectRoot, sources, secretGuard, machineId).catch(
      (err) => logError('Poll sync failed', err)
    );
  }, POLL_INTERVAL_MS);

  log('Daemon running');
}

// Only run as entry point — not when imported by tests or other modules.
if (import.meta.main) {
  startManagedBrainAssetSync().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
