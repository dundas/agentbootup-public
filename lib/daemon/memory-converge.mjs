/**
 * Daemon memory convergence legs (PRD-0054 Slice B).
 *
 * INVOKES the PRD-0051 protocol via the memory CLI (`runMemoryCommand`) —
 * never reimplements apply/publish semantics. In-cycle order is fixed
 * (FR B-5): replay-queue drain → converge apply (per-page merge) →
 * publish-if-changed (content vs own head, FR 7c).
 *
 * Converge defaults ON. `agentbootup config set-converge off` persists an
 * operator default; environment wins over persisted config, and
 * `AGENTBOOTUP_MEMORY_CONVERGE_DISABLED=1` is the emergency kill switch.
 * Configuration is read lazily every cycle so a mid-boot enable immediately
 * re-closes the memory push gate until a converge pass completes.
 *
 * Health states (fixed vocabulary, PRD FR 7): disabled | ok |
 * blocked_conflict | store_deferred | publish_blocked | never_synced | stale.
 * (`quarantined_identity` belongs to Slice A.)
 */

import fs from 'fs';
import path from 'path';
import { runMemoryCommand } from '../memory/cli.js';
import { withMemorySyncLock, MemorySyncLockHeldError } from '../memory/sync-lock.js';
import { getMemoryStoreAdapter, resolveMemoryStore } from '../memory/store-adapter.js';
import { hasReplayQueue, readReplayQueueReadOnly } from '../memory/replay-queue.js';
import { collectMemoryFiles } from '../bundle/installer.js';
import { readConfig } from '../config/config.js';
import { assessMemoryFreshness } from '../memory/freshness.js';
import {
  isRawMemoryPublicationAllowed,
  resolveConvergeSetting,
} from '../memory/converge-safety.js';
import { snapshotNormalizedMemoryConflict } from '../memory/conflict.js';
import {
  classifyLegacyMemoryFailure,
  createMemoryConvergenceFailure,
  createMemoryConvergenceFailureFromEvidence,
  formatMemoryConvergenceFailure,
  normalizeMemoryConvergenceFailure,
  normalizeMemoryFailureHint,
} from '../memory/convergence-failure.js';

export { resolveConvergeSetting } from '../memory/converge-safety.js';

export function isConvergeEnabled(config = {}, env = process.env) {
  return resolveConvergeSetting(config, env).enabled;
}

export function getConvergeIntervalMs() {
  const raw = Number(process.env.AGENTBOOTUP_MEMORY_CONVERGE_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000;
}

function getEscalationMs() {
  const raw = Number(process.env.AGENTBOOTUP_MEMORY_CONFLICT_ESCALATION_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60_000;
}

function getCycleWatchdogMs() {
  const raw = Number(process.env.AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4 * 60_000;
}

function getStoreUrl(brainId) {
  const raw = process.env.AGENTBOOTUP_MEMORY_STORE;
  return raw && raw.trim() ? raw.trim() : `server://${brainId}`;
}

// Health/status is an operator-facing boundary. The memory CLI can include a
// path or a remote error string in stderr, neither of which belongs in a
// durable daemon report. Preserve the actionable class, never the raw line.
export function summarizeMemoryFailure(lines) {
  return classifyLegacyMemoryFailure(lines);
}

function classifyQueueInspectionFailure(error) {
  let code;
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (descriptor && typeof descriptor.value === 'string') code = descriptor.value;
    } catch {
      // A hostile error object is not trusted classification evidence.
    }
  }

  switch (code) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
    case 'EIO':
    case 'ESTALE':
      return 'local_precondition';
    case 'ETIMEDOUT':
      return 'timeout';
    default:
      return 'invalid_payload';
  }
}

/**
 * @param {{ projectRoot: string, brainId: string,
 *           log: (m: string) => void, logError: (m: string, e?: Error) => void,
 *           onEscalate?: (info: object) => void }} opts
 */
/**
 * True when local memory/ EXACTLY matches the merged fleet state (page set +
 * bytes). Content-true, never mtimes. Unknown/unreadable merge => false
 * (publish path decides; its own guards stay authoritative).
 */
async function localMatchesFleet(projectRoot, adapter) {
  let merged;
  try {
    merged = await adapter.fetchMergedAsync({ projectRoot });
  } catch {
    return false;
  }
  if (!merged || !(merged.pages instanceof Map)) return false;
  const local = collectMemoryFiles(projectRoot);
  if (local.length !== merged.pages.size) return false;
  const checkout = path.resolve(projectRoot);
  for (const rel of local) {
    const entry = merged.pages.get(rel);
    if (!entry?.srcFile) return false;
    try {
      if (!fs.readFileSync(path.join(checkout, rel)).equals(fs.readFileSync(entry.srcFile))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function createConvergeRunner({
  projectRoot,
  brainId,
  log,
  logError,
  onEscalate,
  readConfigFn = readConfig,
  runMemoryCommandFn = runMemoryCommand,
  assessFreshnessFn = assessMemoryFreshness,
  readReplayQueueReadOnlyFn = readReplayQueueReadOnly,
  withMemorySyncLockFn = withMemorySyncLock,
  getMemoryStoreAdapterFn = getMemoryStoreAdapter,
}) {
  let state = 'starting';
  let detail = null;
  let failure = null;
  let lastCycleAt = null;
  let gateOpen = false;      // FR 4b: per-(boot × flag-enable)
  let persistedConvergeEnabled;
  let effectiveSetting = resolveConvergeSetting();
  // Every runner starts unarmed so the first effective-on cycle records its
  // activation and explicitly establishes a new gate window.
  let wasEnabled = false;
  let running = false;
  let configEvaluationPending = false;
  let configEvaluationGeneration = 0;
  let configSafetyUnknown = false;
  let blockedSince = null;   // FR 7 escalation window
  let escalatedFor = null;
  let freshnessState = 'unknown';
  let freshnessCheckedAt = null;
  let freshnessHeadCount = null;

  let generation = 0; // stale-cycle guard: a watchdogged cycle's late writes are no-ops

  function health() {
    const snapshot = {
      state,
      detail,
      failure: failure ? normalizeMemoryConvergenceFailure(failure) : null,
      enabled: effectiveSetting.enabled,
      configSource: effectiveSetting.source,
      store: getStoreUrl(brainId),
      gateOpen: isMemoryPushGateOpen(),
      lastCycleAt,
      freshnessState,
      freshnessCheckedAt,
      freshnessHeadCount,
      blockedSince: blockedSince ? new Date(blockedSince).toISOString() : null,
      escalated: escalatedFor !== null,
    };
    Object.defineProperty(snapshot, 'toJSON', { value() { return this; } });
    return snapshot;
  }

  /**
   * FR 4b: while the kill switch is OFF the gate is not armed — memory/**
   * asset push behaves exactly as today. While ON, push is gated on this
   * boot-and-enable-window's first completed converge pass.
   */
  function isMemoryPushGateOpen() {
    const current = resolveConvergeSetting(
      typeof persistedConvergeEnabled === 'boolean'
        ? { memoryConvergeEnabled: persistedConvergeEnabled }
        : {},
    );
    // A persisted OFF → ON transition is unknowable until the asynchronous
    // config read settles. Treat that evaluation window as closed. The named
    // environment kill switch is the sole synchronous rollback exception.
    if (configEvaluationPending || configSafetyUnknown) {
      return current.source === 'env:AGENTBOOTUP_MEMORY_CONVERGE_DISABLED';
    }
    if (!current.enabled) return true;
    // A synchronous env flip from off → on must close the gate before the
    // next asset cycle can race the async config refresh.
    if (!effectiveSetting.enabled) return false;
    return isRawMemoryPublicationAllowed(current, gateOpen);
  }

  function setBlocked(newState, record, live = () => true) {
    if (!live()) return;
    gateOpen = false;
    state = newState;
    failure = normalizeMemoryConvergenceFailure(record);
    detail = formatMemoryConvergenceFailure(failure);
    if (newState === 'blocked_conflict') {
      blockedSince ??= Date.now();
      if (Date.now() - blockedSince >= getEscalationMs() && escalatedFor !== blockedSince) {
        escalatedFor = blockedSince;
        logError(`Memory converge blocked_conflict for brain '${brainId}' has persisted past the escalation window`);
        try { onEscalate?.({ brainId, projectRoot, state: newState, detail, blockedSince: new Date(blockedSince).toISOString() }); }
        catch (err) { logError('Conflict escalation hook failed', err); }
      }
    }
  }

  function clearBlocked() {
    blockedSince = null;
    escalatedFor = null;
  }

  function openGate(live = () => true) {
    if (!live()) return;
    if (!gateOpen) {
      gateOpen = true;
      log(`Memory converge gate open for brain '${brainId}' — memory/** may sync`);
    }
  }

  async function runCycle(now = Date.now(), cycleOptions = {}) {
    const startupSafetyOnly = cycleOptions.startupSafetyOnly === true;
    const externalSignal = cycleOptions.signal;
    // The active cycle owns every gate transition until it settles. In
    // particular, a concurrent invocation must not read a newly-disabled
    // config and reopen the legacy path while safety work is still pending.
    if (running || configEvaluationPending) return health();
    const priorState = state;
    const priorGateOpen = gateOpen;
    // FR13 preserves lock-contention state within an already-armed enable
    // window. A disabled window is different: its open gate is the explicit
    // legacy rollback path, not convergence proof that may survive OFF -> ON.
    const priorEnableWindowWasArmed = wasEnabled;
    // A newly-started/config-evaluating cycle never reuses terminal evidence
    // from the prior cycle. Its terminal path below will install fresh evidence.
    failure = null;
    const configGen = ++configEvaluationGeneration;
    configEvaluationPending = true;
    configSafetyUnknown = true;
    const cachedSetting = resolveConvergeSetting(
      typeof persistedConvergeEnabled === 'boolean'
        ? { memoryConvergeEnabled: persistedConvergeEnabled }
        : {},
    );
    // Close synchronously before the first await. A periodic asset cycle must
    // never discover raw memory while refresh/head comparison/publish is still
    // deciding whether the local bytes are safe. The explicit disabled path
    // below remains open and unchanged.
    if (cachedSetting.enabled) gateOpen = false;
    let config;
    try {
      config = await readConfigFn();
    } catch (err) {
      if (configGen !== configEvaluationGeneration) return health();
      configEvaluationPending = false;
      effectiveSetting = { enabled: true, source: 'config_error_fail_closed' };
      state = 'store_deferred';
      failure = createMemoryConvergenceFailureFromEvidence({
        phase: 'config',
        legacyCategory: summarizeMemoryFailure([err?.message || err]),
      });
      detail = formatMemoryConvergenceFailure(failure);
      gateOpen = false;
      wasEnabled = true;
      return health();
    }
    if (configGen !== configEvaluationGeneration) return health();
    configEvaluationPending = false;
    configSafetyUnknown = false;
    persistedConvergeEnabled = typeof config?.memoryConvergeEnabled === 'boolean'
      ? config.memoryConvergeEnabled
      : undefined;
    const nextSetting = resolveConvergeSetting(config);
    effectiveSetting = nextSetting;
    if (!nextSetting.enabled) {
      // Flag off (or flipped off): disarm — a later re-enable re-closes the gate.
      state = 'disabled';
      detail = `effective=false source=${nextSetting.source}`;
      failure = null;
      // Explicit rollback restores the legacy raw-memory path. Report that
      // gate truthfully even though disabled remains an unsafe health state.
      gateOpen = true;
      wasEnabled = false;
      return health();
    }
    if (!wasEnabled) {
      // Fresh arm (boot, or mid-boot flag flip): the gate re-closes until a
      // converge pass completes (FR 4b mid-boot rule).
      wasEnabled = true;
      gateOpen = false;
      log(
        `Memory converge active for brain '${brainId}' ` +
        `(source=${nextSetting.source}, store=${getStoreUrl(brainId)})`,
      );
    }
    gateOpen = false;
    running = true;
    const gen = ++generation;
    const cycleController = new AbortController();
    const forwardExternalAbort = () => cycleController.abort(externalSignal?.reason);
    if (externalSignal?.aborted) forwardExternalAbort();
    else externalSignal?.addEventListener('abort', forwardExternalAbort, { once: true });
    const cycleSignal = cycleController.signal;
    const live = () => gen === generation && !cycleSignal.aborted;
    let lastCommandEvidence = null;
    const runMemoryCommandCaptured = async (argv) => {
      // A command's classification must describe only that command. In
      // particular, a successful replay's output cannot relabel a later
      // refresh/publish failure.
      const captured = [];
      let conflictState = 'unused';
      let conflictSnapshot = null;
      let failureState = 'unused';
      let failureSnapshot = null;
      const io = {
        stdout: (m) => { captured.push(String(m)); },
        stderr: (m) => { captured.push(String(m)); },
        conflict: (record) => {
          if (conflictState !== 'unused') {
            conflictState = 'malformed';
            conflictSnapshot = null;
            return;
          }
          conflictSnapshot = snapshotNormalizedMemoryConflict(record);
          conflictState = conflictSnapshot === null ? 'malformed' : 'valid';
        },
        failure: (hint) => {
          if (failureState !== 'unused') {
            failureState = 'malformed';
            failureSnapshot = null;
            return;
          }
          failureSnapshot = normalizeMemoryFailureHint(hint);
          failureState = failureSnapshot === null ? 'malformed' : 'valid';
        },
      };
      const exitCode = await runMemoryCommandFn(argv, io, { signal: cycleSignal });
      let hint = failureState === 'valid' ? failureSnapshot : null;
      if (failureState === 'unused' && conflictState === 'valid') {
        hint = normalizeMemoryFailureHint({ category: 'conflict', conflict: conflictSnapshot });
      }
      lastCommandEvidence = {
        hint,
        legacyCategory: summarizeMemoryFailure(captured),
      };
      return exitCode;
    };
    const commandFailure = (phase, exitCode) => {
      return createMemoryConvergenceFailureFromEvidence({
        phase,
        exitCode,
        hint: lastCommandEvidence?.hint ?? null,
        legacyCategory: lastCommandEvidence?.legacyCategory ?? null,
      });
    };
    const set = (st, dt) => {
      if (live()) {
        state = st;
        detail = dt;
        failure = null;
      }
    };
    // Cycle watchdog (bound-every-awaiter, #322 lesson): a cycle wedged in
    // store I/O must not hold `running` forever — that would silently stop
    // all future cycles AND pin the FR-4b gate closed. Force-clear the
    // single-flight flag after the watchdog; the in-process lock still
    // prevents overlapping work (a new cycle waiting on it reports
    // lock-held), and the straggler's own finally is a harmless no-op.
    const watchdogMs = getCycleWatchdogMs();
    let watchdog = null;
    const cancelWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
    };
    const armWatchdog = () => {
      cancelWatchdog();
      watchdog = setTimeout(() => {
        if (running && live()) {
          logError(`Memory converge cycle for '${brainId}' exceeded ${watchdogMs}ms — releasing single-flight flag`);
          cycleController.abort(new Error(`memory converge safety phase timed out after ${watchdogMs}ms`));
          state = 'store_deferred';
          failure = createMemoryConvergenceFailure({ phase: 'cycle', category: 'timeout', exitCode: null });
          detail = formatMemoryConvergenceFailure(failure);
          gateOpen = false;
          configSafetyUnknown = true;
          lastCycleAt = new Date(now).toISOString();
          configEvaluationGeneration++;
          generation++; // invalidate the straggler: its future writes are no-ops
          running = false;
        }
      }, watchdogMs);
      watchdog.unref?.();
    };
    armWatchdog();
    try {
      const storeUrl = getStoreUrl(brainId);

      await withMemorySyncLockFn({ projectRoot, holderLabel: 'daemon-converge', waitMs: 30_000 }, async () => {
        const store = resolveMemoryStore(storeUrl);
        let stalePublicationEvidence = null;
        try {
          const freshness = await assessFreshnessFn({ projectRoot, store });
          if (live()) {
            freshnessState = typeof freshness?.state === 'string' ? freshness.state : 'unknown';
            freshnessCheckedAt = new Date(now).toISOString();
            freshnessHeadCount = Number.isInteger(freshness?.headCount)
              ? freshness.headCount
              : Array.isArray(freshness?.heads)
                ? freshness.heads.length
                : null;
          }
          if (freshness?.state === 'stale' && Array.isArray(freshness.freshHeads) && freshness.freshHeads.length > 0) {
            const freshestRemoteHeadAgeMs = Math.min(
              ...freshness.freshHeads.map((head) => Number(head.ageMs)).filter(Number.isFinite),
            );
            if (Number.isFinite(freshestRemoteHeadAgeMs)) {
              stalePublicationEvidence = {
                localDirtyAgeMs: Number.isFinite(freshness.localDirtyAgeMs)
                  ? freshness.localDirtyAgeMs
                  : null,
                freshestRemoteHeadAgeMs,
                stalePublisherIds: Array.isArray(freshness.staleHeads)
                  ? freshness.staleHeads
                      .map((head) => String(head?.publisherId || ''))
                      .filter(Boolean)
                      .sort()
                  : [],
              };
              // This runner may have opened the raw-memory gate on an earlier
              // cycle. Re-close it in the same continuation that establishes
              // stale evidence, before refresh (or any other operation) can
              // yield control to a concurrent asset-sync cycle.
              if (live()) gateOpen = false;
            }
          }
        } catch {
          if (live()) {
            freshnessState = 'unknown';
            freshnessCheckedAt = new Date(now).toISOString();
            freshnessHeadCount = null;
          }
          // Refresh remains authoritative; freshness is observability and an
          // additional stale-publication guard, never a new availability gate.
        }

        // Stale evidence closes EVERY publication path. In particular, do not
        // drain immutable replay payloads before checking it: replay is a
        // remote head write just as surely as a live publish is. We still run
        // refresh below so a later periodic cycle can observe recovery.
        //
        // Startup is a bounded pull/apply safety phase. It never starts replay
        // or publish, so timing out startup cannot abandon an in-flight remote
        // commit that lands after the gate has been reported closed.
        if (!startupSafetyOnly && !stalePublicationEvidence && hasReplayQueue(projectRoot)) {
          // Replay is a publication commit. Once any publication phase begins,
          // never watchdog-abandon it: the caller remains joined until the
          // remote outcome is known, so a head cannot land after we reported
          // the cycle aborted.
          cancelWatchdog();
          const rc = await runMemoryCommandCaptured(['replay', '--cwd', projectRoot, '--store', storeUrl]);
          if (!live()) return;
          if (rc === 3) {
            setBlocked('blocked_conflict', commandFailure('replay', rc), live);
            return;
          }
          if (rc !== 0 && rc !== 4) {
            setBlocked('store_deferred', commandFailure('replay', rc), live);
            return;
          }
          // Replay is joined until its remote outcome is known. Once it has
          // settled, refresh becomes a fresh pull/apply safety phase and must
          // regain its watchdog.
          armWatchdog();
        }

        // 2. Converge apply: per-page merge across all publisher heads.
        const refreshRc = await runMemoryCommandCaptured(['refresh', '--from-store', '--cwd', projectRoot, '--store', storeUrl]);
        if (!live()) return;
        if (refreshRc !== 0) {
          setBlocked('store_deferred', commandFailure('refresh', refreshRc), live);
          return;
        }

        if (stalePublicationEvidence) {
          const evidence =
            `stale publication suppressed: local_dirty_age_ms=${stalePublicationEvidence.localDirtyAgeMs ?? 'unknown'} ` +
            `freshest_remote_head_age_ms=${stalePublicationEvidence.freshestRemoteHeadAgeMs} ` +
            `stale_publisher_heads=${stalePublicationEvidence.stalePublisherIds.join(',') || 'unknown'}`;
          set('stale', evidence);
          log(`Memory converge ${evidence}; replay, snapshot publication, and raw memory publication skipped`);
          return;
        }

        // A startup safety phase deliberately does not replay, because replay
        // is a publication commit. It must not, however, open the raw-memory
        // publication gate while an immutable FIFO item is still pending:
        // that would bypass a conflict or terminal replay head through the
        // legacy asset path. Read-only inspection preserves queue evidence.
        if (startupSafetyOnly) {
          let pendingReplay;
          try {
            pendingReplay = readReplayQueueReadOnlyFn(projectRoot).items;
          } catch (error) {
            setBlocked('store_deferred', createMemoryConvergenceFailure({
              phase: 'queue_inspect', category: classifyQueueInspectionFailure(error), exitCode: null,
            }), live);
            return;
          }
          if (pendingReplay.length > 0) {
            const outcome = pendingReplay[0]?.last_outcome?.type;
            const replayState = outcome === 'blocked_conflict' ? 'blocked_conflict' : 'store_deferred';
            // queue_inspect cannot legally claim conflict; a blocked queue head
            // is local prerequisite evidence at this phase.
            setBlocked(replayState, createMemoryConvergenceFailure({
              phase: 'queue_inspect', category: 'local_precondition', exitCode: null,
            }), live);
            return;
          }
        }

        if (startupSafetyOnly) {
          // Refresh alone cannot prove that same-page local drift is safe to
          // expose. Keep raw memory closed until the first periodic cycle
          // completes head comparison and, when needed, snapshot publish.
          set('ok', 'startup pull/apply safety phase complete; publication gate awaits periodic safety proof');
          clearBlocked();
          return;
        }

        // The bounded pull/apply safety phase is complete. From this point
        // forward, keep the single-flight joined until publication settles;
        // aborting an already-sent remote commit cannot prove that the server
        // did not install it.
        cancelWatchdog();

        // 3. Publish only when this checkout has something NEW to say (FR 7c):
        //    skip when content matches our own head (unchanged since our last
        //    publish) OR the merged fleet state (adopting fleet content must
        //    not mint a head — a same-bytes republish under a new head makes
        //    every OTHER checkout's next honest edit look baseline-conflicted;
        //    found by the hermetic two-checkout proof). Never publish an
        //    empty, never-published tree (FR B-5).
        const adapter = getMemoryStoreAdapterFn(store);
        let match;
        try {
          match = await adapter.localMatchesOwnHeadAsync({ projectRoot });
        } catch (error) {
          setBlocked('store_deferred', createMemoryConvergenceFailureFromEvidence({
            phase: 'head_compare',
            legacyCategory: summarizeMemoryFailure([error?.message || error]),
          }), live);
          return;
        }
        if (!live()) return;
        if (match.matches) {
          openGate(live);
          set(match.reason === 'empty_both' ? 'never_synced' : 'ok', match.reason);
          if (live()) clearBlocked();
          return;
        }
        if (await localMatchesFleet(projectRoot, adapter)) {
          if (!live()) return;
          openGate(live);
          set('ok', 'matches fleet');
          if (live()) clearBlocked();
          return;
        }
        // TOCTOU guard only (PR-329 review): localMemoryMatchesOwnHead returns
        // 'never_published' solely for a NON-empty tree ('empty_both' covers
        // empty), so this triggers only if the tree empties between the two
        // scans. Kept as a cheap safety net against publishing a just-emptied
        // never-published tree.
        if (match.reason === 'never_published' && collectMemoryFiles(projectRoot).length === 0) {
          openGate(live);
          set('never_synced', 'empty local tree, nothing published');
          if (live()) clearBlocked();
          return;
        }
        const publishRc = await runMemoryCommandCaptured(['publish', '--cwd', projectRoot, '--store', storeUrl]);
        if (!live()) return;
        if (publishRc === 0) {
          openGate(live);
          set('ok', `published (${match.reason})`);
          if (live()) clearBlocked();
          return;
        }
        if (publishRc === 3) {
          setBlocked('blocked_conflict', commandFailure('publish', publishRc), live);
          logError(`Memory converge blocked_conflict for '${brainId}': ${detail}`);
          return;
        }
        setBlocked('publish_blocked', commandFailure('publish', publishRc), live);
      });
    } catch (err) {
      if (err instanceof MemorySyncLockHeldError) {
        if (live()) {
          state = priorState;
          gateOpen = priorEnableWindowWasArmed ? priorGateOpen : false;
          failure = createMemoryConvergenceFailure({ phase: 'cycle', category: 'lock_held', exitCode: null });
          detail = formatMemoryConvergenceFailure(failure);
        }
      } else {
        setBlocked('store_deferred', createMemoryConvergenceFailureFromEvidence({
          phase: 'cycle',
          legacyCategory: summarizeMemoryFailure([err?.message || err]),
        }), live);
        logError(`Memory converge cycle failed for '${brainId}'`, err);
      }
    } finally {
      cancelWatchdog();
      externalSignal?.removeEventListener('abort', forwardExternalAbort);
      if (live()) {
        running = false;
        lastCycleAt = new Date(now).toISOString();
      }
    }
    return health();
  }

  async function runStartupCycle(timeoutMs = 60_000) {
    const controller = new AbortController();
    let timer;
    const cycle = runCycle(Date.now(), { startupSafetyOnly: true, signal: controller.signal });
    const timedOut = await Promise.race([
      cycle.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (!timedOut) return health();

    controller.abort(new Error(`startup timeout after ${timeoutMs}ms`));
    configEvaluationGeneration++;
    configEvaluationPending = false;
    configSafetyUnknown = true;
    generation++;
    running = false;
    gateOpen = false;
    state = 'store_deferred';
    failure = createMemoryConvergenceFailure({ phase: 'startup', category: 'timeout', exitCode: null });
    detail = formatMemoryConvergenceFailure(failure);
    lastCycleAt = new Date().toISOString();
    logError(`Memory converge startup timeout for '${brainId}' after ${timeoutMs}ms — publication gate remains closed`);
    return health();
  }

  return { runCycle, runStartupCycle, health, isMemoryPushGateOpen };
}
