/**
 * Unified daemon CLI for `agentbootup daemon <start|stop|status|logs>`.
 *
 * Consolidates the former `sync-daemon` (transcript sync) and `brain-daemon`
 * (brain asset sync) commands into a single entry-point backed by
 * @derivativelabs/agent-process for platform-native process management
 * (launchd on macOS, systemd on Linux, pm2 on Windows).
 *
 * Agent names:
 *   agentbootup-transcripts          — transcript-sync.mjs on port 8766
 *   agentbootup-brain                — brain-asset-sync.mjs without a dedicated health port
 *   agentbootup-brain-db-<id>        — brain-db-sync.mjs (one per provisioned project)
 *   agentbootup-inbox-<project-id>   — inbox-daemon.mjs (one per provisioned project, wake-on-message)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { agentStart, agentStop, agentStatus, agentLogs } from '@derivativelabs/agent-process';
import { readLivePersistedBrainSyncHealth } from './brain-asset-sync.mjs';
import { readLiveBrainDbSyncHealth } from './brain-db-health.js';
import { getAgentProcessPlatform, rotateManagedDaemonLogs } from './log-rotation.js';
import {
  readCredentials,
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { getBrainId, readConfig, writeConfig, getSkillsMode, setSkillsMode } from '../config/config.js';
import { apiUrl, isPlausibleServerUrl, isValidServerUrl } from '../auth/validate.js';
import {
  SCRIPTS,
  getNetworkProjects,
  getBrainAgentEntries,
  getBrainDbAgentEntries,
  getInboxAgentEntry,
  getInboxAgentEntries,
  getCustomAgentEntries,
  getExpectedServices,
} from './daemon-registry.js';
import {
  updatePortAndReRegister,
} from '../brain/webhook-secret.js';
import { assessMemoryFreshness } from '../memory/freshness.js';
import { resolveMemoryStore } from '../memory/store.js';
import {
  hasCompleteConvergeHealth,
  isConvergeHealthSafe,
} from '../memory/converge-safety.js';
import { normalizeProjectPath, resolveGitProjectRoot } from './transcript-brain-routing.js';
import { stringifyJsonEnvelope } from '../json/safe-stringify.js';

// Capture native fetch at module load time so test suites that replace
// globalThis.fetch with a mock do not affect real HTTP calls (e.g. inbox health probes).
// Bun 1.0+ always has native fetch; guard is defensive for non-Bun environments.
const _fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;

// Resolve the interpreter path so the daemons run under the same Bun binary
// as the CLI. Falls back to 'bun' for users whose PATH has it but who invoked
// us via a symlink (e.g. npx, global npm install).
const BUN_INTERPRETER = path.basename(process.execPath) === 'bun' ? process.execPath : 'bun';
const CLI_ENTRYPOINT = fileURLToPath(new URL('../../bootup.mjs', import.meta.url));

// ── Agent names & script paths ────────────────────────────────────────────────

const TRANSCRIPTS_NAME = 'agentbootup-transcripts';
const BRAIN_NAME = 'agentbootup-brain';

const TRANSCRIPTS_SCRIPT = SCRIPTS.transcripts;
const BRAIN_SCRIPT       = SCRIPTS.brainAsset;
const BRAIN_DB_SCRIPT    = SCRIPTS.brainDb;
const INBOX_DAEMON_SCRIPT = SCRIPTS.inbox;

const TRANSCRIPTS_PORT = 8766;
const START_RETRY_DELAY_MS = 750;
const STOP_VERIFY_POLL_MS = 200;
const VERIFY_FETCH_TIMEOUT_MS = 30_000;
const MAX_START_ATTEMPTS = 2;
const DAILY_NARRATIVE_TIMEOUT_MS = 120_000;
const DAILY_NARRATIVE_STDERR_LIMIT = 200;

function convergeBooleanLabel(value, trueLabel, falseLabel) {
  return typeof value === 'boolean' ? (value ? trueLabel : falseLabel) : 'unknown';
}

const defaultUnifiedDaemonRuntime = Object.freeze({
  runIndexTranscripts: (argv) => runIndexTranscriptsWithBun(argv),
  detectLogPlatform: () => getAgentProcessPlatform(),
  resolveSingleProjectScope: (cwd) => {
    // Scope variables are child-daemon inputs. An ambient value inherited by
    // this parent CLI must not redirect a new launch away from its cwd.
    const projectRoot = normalizeProjectPath(cwd);
    const repositoryRoot = resolveGitProjectRoot(projectRoot) || projectRoot;
    return { projectRoot, repositoryRoot };
  },
});

/**
 * Execute the Bun-only transcript indexer across an explicit process boundary.
 * The unified daemon CLI remains Node-compatible while automatic indexing runs
 * under the interpreter required by bun:sqlite.
 */
export async function runIndexTranscriptsWithBun(argv, { spawnImpl = null } = {}) {
  const spawnIndexer = spawnImpl ?? (await import('child_process')).spawn;
  return await new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawnIndexer(
      BUN_INTERPRETER,
      [CLI_ENTRYPOINT, 'brain', 'index-transcripts', ...argv],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.stderr?.on('data', (chunk) => { stderr += Buffer.from(chunk).toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Bun indexer exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

let unifiedDaemonRuntime = { ...defaultUnifiedDaemonRuntime };

export function setUnifiedDaemonRuntimeForTests(overrides = null) {
  if (!overrides || typeof overrides !== 'object') {
    unifiedDaemonRuntime = { ...defaultUnifiedDaemonRuntime };
    return;
  }
  unifiedDaemonRuntime = {
    ...defaultUnifiedDaemonRuntime,
    ...overrides,
  };
}

async function rotateDaemonLogsForConfig(effectiveConfig) {
  try {
    await rotateManagedDaemonLogs({
      serviceName: effectiveConfig.name,
      logDir: effectiveConfig.logDir,
      platform: unifiedDaemonRuntime.detectLogPlatform(),
    });
  } catch (err) {
    console.error(
      `Warning: log rotation skipped for ${effectiveConfig.name}: ${err?.message ?? String(err)}`
    );
  }
}

/**
 * Resolve the project-owned narrative runtime. Modern bundles materialize the
 * executable under brain/scripts/. The retired brain/ path remains a narrowly
 * scoped compatibility fallback for brains provisioned before that layout was
 * introduced; skill instruction trees are intentionally never executable roots.
 */
export function resolveDailyNarrativeRuntime(targetPath) {
  // targetPath is an operator-configured project root; every appended segment is fixed.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const canonicalPath = path.join(targetPath, 'brain', 'scripts', 'narrative-generator.ts');
  if (fs.existsSync(canonicalPath)) return canonicalPath;

  // The compatibility lookup uses the same trusted root and a single fixed legacy suffix.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const legacyPath = path.join(targetPath, 'brain', 'narrative-generator.ts');
  return fs.existsSync(legacyPath) ? legacyPath : null;
}

/**
 * Generate yesterday's narrative for one project without making daemon startup
 * depend on the result. Injectable process/timer hooks keep timeout and failure
 * behavior directly testable without waiting two minutes.
 */
export async function runDailyNarrativeGenerator({
  targetPath,
  label,
  yesterday,
  info = console.log,
  error = console.error,
  spawnImpl = null,
  timeoutMs = DAILY_NARRATIVE_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const scriptPath = resolveDailyNarrativeRuntime(targetPath);
  if (!scriptPath) return { status: 'runtime_missing' };

  // targetPath is the configured project root and yesterday is generated internally as YYYY-MM-DD.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const narrativePath = path.join(targetPath, 'memory', 'narratives', `${yesterday}.md`);
  if (fs.existsSync(narrativePath)) {
    if (process.env.AGENTBOOTUP_VERBOSE) {
      info(`[narrative] ${label}: already generated for ${yesterday}`);
    }
    return { status: 'already_exists', scriptPath };
  }

  info(`[narrative] ${label}: generating narrative for ${yesterday}`);
  try {
    const spawnNarrative = spawnImpl ?? (await import('child_process')).spawn;
    return await new Promise((resolve) => {
      let settled = false;
      let stderr = '';
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeoutImpl(timer);
        resolve(result);
      };
      const child = spawnNarrative(BUN_INTERPRETER, [scriptPath], {
        cwd: targetPath,
        env: { ...process.env },
        stdio: 'pipe',
      });
      child.stderr?.on('data', (chunk) => {
        if (stderr.length >= DAILY_NARRATIVE_STDERR_LIMIT) return;
        stderr += Buffer.from(chunk).toString().slice(0, DAILY_NARRATIVE_STDERR_LIMIT - stderr.length);
      });
      child.on('error', (err) => {
        if (settled) return;
        error(`[narrative] ${label}: spawn error — ${err.message} (non-fatal)`);
        finish({ status: 'spawn_error', scriptPath, error: err });
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code === 0) {
          info(`[narrative] ${label}: done`);
          finish({ status: 'generated', scriptPath });
        } else {
          const detail = stderr.trim();
          error(`[narrative] ${label}: exited ${code}${detail ? ` — ${detail}` : ''} (non-fatal)`);
          finish({ status: 'failed', scriptPath, exitCode: code });
        }
      });
      timer = setTimeoutImpl(() => {
        error(`[narrative] ${label}: timed out after ${Math.round(timeoutMs / 1000)}s (non-fatal)`);
        finish({ status: 'timed_out', scriptPath });
        try {
          child.kill();
        } catch (err) {
          error(`[narrative] ${label}: failed to stop timed-out process — ${err.message} (non-fatal)`);
        }
      }, timeoutMs);
    });
  } catch (err) {
    error(`[narrative] ${label}: failed (non-fatal): ${err.message}`);
    return { status: 'failed', scriptPath, error: err };
  }
}

function parseScopedProjectFilter(args) {
  const SKILLS_MODE_FLAG = '--skills-mode';
  const FLAGS = new Set([
    '--no-transcripts',
    '--no-brain',
    '--no-index-transcripts',
    '--no-brain-db',
    '--no-inbox',
    '--no-narrative',
    '--yes',
    '--all',
    '--json',
    SKILLS_MODE_FLAG,
  ]);
  const skipIndices = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === SKILLS_MODE_FLAG) {
      skipIndices.add(i);
      if (i + 1 < args.length) skipIndices.add(i + 1);
      continue;
    }
    if (arg.startsWith('--skills-mode=')) {
      skipIndices.add(i);
    }
  }
  return args.filter((a, idx) => {
    if (skipIndices.has(idx)) return false;
    if (FLAGS.has(a)) return false;
    return true;
  });
}

// ── Network config helpers ────────────────────────────────────────────────────
// getNetworkProjects, getBrainAgentEntries, getBrainDbAgentEntries,
// getInboxAgentEntries, and getCustomAgentEntries live in daemon-registry.js.

// ── Credential & consent checks ───────────────────────────────────────────────

function isTransientLaunchdStartError(err) {
  const msg = String(err?.message ?? '').toLowerCase();
  return (
    msg.includes('bootstrap failed: 5') ||
    msg.includes('input/output error') ||
    msg.includes('i/o error')
  );
}

async function reconcileRunningAgent(name) {
  try {
    const info = await agentStatus(name);
    if (info.state === 'online' && info.pid) {
      return info;
    }
  } catch {
    // Ignore status lookup failures during reconciliation.
  }
  return null;
}

function isRunningAgentState(info) {
  return !!info && (info.state === 'online' || info.state === 'running') && info.pid;
}

async function getRunningAgent(name) {
  try {
    const info = await agentStatus(name);
    if (isRunningAgentState(info)) {
      return info;
    }
  } catch (err) {
    if (process.env.AGENTBOOTUP_VERBOSE) {
      console.warn(`[daemon] pre-start status probe failed for ${name}: ${err?.message ?? err}`);
    }
  }
  return null;
}

function getStopVerifyTimeoutMs() {
  const raw = Number(process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

function getSigkillSettleMs() {
  const raw = Number(process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// OS-level "is this PID gone?" using kill -0. Unlike agentStatus(), this does not
// treat probe errors as "stopped" — only ESRCH (no such process) is confirmed dead.
// EPERM means the process exists but we don't own it (still alive).
// Set AGENTBOOTUP_DAEMON_NO_KILL_POLL=1 in tests when the PID is synthetic and
// kill -0 must not be used (e.g. to simulate an unkillable daemon).
async function pollProcessDead(pid, timeoutMs) {
  if (process.env.AGENTBOOTUP_DAEMON_NO_KILL_POLL === '1') return false;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
      // Process is alive — keep polling.
    } catch (err) {
      if (err?.code === 'ESRCH') return true; // confirmed dead
      // EPERM = exists but not ours; any other error = treat as alive.
    }
    if (Date.now() >= deadline) return false;
    const remainingMs = Math.max(0, deadline - Date.now());
    await sleep(Math.min(STOP_VERIFY_POLL_MS, remainingMs));
  }
}

async function waitForAgentStopped(name, timeoutMs = getStopVerifyTimeoutMs()) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const info = await agentStatus(name);
      if (!isRunningAgentState(info)) {
        return { stopped: true, info };
      }

      if (Date.now() >= deadline) {
        return { stopped: false, info };
      }
    } catch {
      return { stopped: true, info: null };
    }

    const remainingMs = Math.max(0, deadline - Date.now());
    await sleep(Math.min(STOP_VERIFY_POLL_MS, remainingMs));
  }
}

async function startAgentWithRetry(config) {
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      const handle = await agentStart(config);
      return { handle, attempts, recovered: false };
    } catch (err) {
      const retryable = isTransientLaunchdStartError(err);
      if (retryable && attempt < MAX_START_ATTEMPTS) {
        await sleep(START_RETRY_DELAY_MS);
        continue;
      }

      const recovered = retryable ? await reconcileRunningAgent(config.name) : null;
      if (recovered) {
        return { handle: recovered, attempts, recovered: true };
      }

      if (err && typeof err === 'object') {
        err.attempts = attempts;
      }
      throw err;
    }
  }
}

async function ensureAgentStarted(config, metadata = {}, options = {}) {
  const effectiveLogDir = process.env.AGENTBOOTUP_DAEMON_LOG_DIR || config.logDir;
  const effectiveConfig = effectiveLogDir ? { ...config, logDir: effectiveLogDir } : config;
  const running = await getRunningAgent(config.name);
  const forceRestartRunning = options.forceRestartRunning === true;
  if (running) {
    if (forceRestartRunning) {
      try {
        // Restart callers already attempted a stop before reaching this path.
        // Recheck once without waiting so we only issue a second stop if the
        // daemon still appears live during the restart handoff.
        let shouldRetryStop = false;
        try {
          const stopProbe = await agentStatus(config.name);
          shouldRetryStop = isRunningAgentState(stopProbe);
        } catch {
          // Fail safe here: if the status probe itself errors, assume the
          // daemon may still be live and issue the final stop attempt.
          shouldRetryStop = true;
        }

        if (shouldRetryStop) {
          // If the daemon still appears live, do one final stop + verify pass
          // so we fail honestly instead of reporting a false restart.
          await agentStop(config.name);
          const finalStopResult = await waitForAgentStopped(config.name);
          if (!finalStopResult.stopped) {
            // Graceful stop timed out. Send SIGKILL if we have a PID and wait
            // for the kernel to confirm death before giving up. Long-running
            // daemons (days-old boot processes) can take longer than the stop
            // window to drain; SIGKILL is the last resort before stranding them.
            const pid = finalStopResult.info?.pid ?? null;
            let sigkillAttempted = false;
            // Re-verify PID identity immediately before SIGKILL to minimize the
            // reuse window. If agentStatus shows the daemon already stopped, start
            // directly. If the PID changed, skip SIGKILL (different process). If
            // the probe errors, take the residual risk and proceed with the original
            // PID. pollProcessDead uses kill -0 after SIGKILL; if the PID was reused
            // the new process appears alive and we return failure, not a false restart.
            let verifiedPid = null;
            if (Number.isSafeInteger(pid) && pid > 0) {
              try {
                const recheckInfo = await agentStatus(config.name);
                if (!isRunningAgentState(recheckInfo)) {
                  // Daemon stopped naturally — proceed to start without SIGKILL.
                  await rotateDaemonLogsForConfig(effectiveConfig);
                  const { handle, attempts, recovered } = await startAgentWithRetry(effectiveConfig);
                  return {
                    name: effectiveConfig.name,
                    label: metadata.label ?? effectiveConfig.name,
                    ok: true,
                    status: 'restarted',
                    pid: handle.pid ?? null,
                    port: handle.port ?? effectiveConfig.port ?? null,
                    attempts,
                    recovered,
                  };
                }
                verifiedPid = recheckInfo.pid === pid ? pid : null; // skip if PID changed
              } catch {
                // Service manager probe failed (transient error). Kill -0 gives OS-level
                // liveness: ESRCH = confirmed gone, alive = proceed with SIGKILL.
                //
                // Kill -0 alone cannot confirm the PID belongs to OUR daemon (a new process
                // could have recycled it), so this path carries residual risk. The safety net:
                // pollProcessDead (below) does its own kill -0 poll after SIGKILL; if the PID
                // is recycled the replacement process stays alive → pollProcessDead returns false
                // → we return {ok:false} rather than starting a duplicate daemon. Fail-closed
                // (skipping SIGKILL entirely on probe error) would leave long-running daemons
                // stranded in "not-installed" state, which is the bug this PR fixes.
                try {
                  process.kill(pid, 0); // throws ESRCH if gone
                  verifiedPid = pid; // a live process exists at this PID — proceed with SIGKILL
                } catch (probeErr) {
                  if (probeErr?.code === 'ESRCH') {
                    // Process is already gone — start directly without SIGKILL.
                    await rotateDaemonLogsForConfig(effectiveConfig);
                    const { handle, attempts, recovered } = await startAgentWithRetry(effectiveConfig);
                    return {
                      name: effectiveConfig.name,
                      label: metadata.label ?? effectiveConfig.name,
                      ok: true,
                      status: 'restarted',
                      pid: handle.pid ?? null,
                      port: handle.port ?? effectiveConfig.port ?? null,
                      attempts,
                      recovered,
                    };
                  }
                  // EPERM: process alive at this PID but caller lacks permission to signal
                  // it — skip SIGKILL to avoid targeting a recycled PID we can't own.
                  verifiedPid = null;
                }
              }
            }
            if (Number.isSafeInteger(verifiedPid) && verifiedPid > 0) {
              let killErr = null;
              try {
                process.kill(verifiedPid, 'SIGKILL');
                sigkillAttempted = true;
              } catch (err) {
                if (err?.code !== 'ESRCH') {
                  // EPERM means a process holds that PID (daemon or a reused PID).
                  // EINVAL / other = bad signal or PID. Still run the settle probe;
                  // the process may have died through other means. Surface the kill
                  // error only if the settle probe confirms something is still alive.
                  killErr = err;
                }
                // ESRCH = already gone before SIGKILL, safe to ignore.
              }
              // Use OS-level kill -0 poll rather than agentStatus so that transient
              // status probe errors cannot be mistaken for "confirmed dead".
              const killConfirmed = await pollProcessDead(verifiedPid, getSigkillSettleMs());
              if (killConfirmed) {
                await rotateDaemonLogsForConfig(effectiveConfig);
                const { handle, attempts, recovered } = await startAgentWithRetry(effectiveConfig);
                return {
                  name: effectiveConfig.name,
                  label: metadata.label ?? effectiveConfig.name,
                  ok: true,
                  status: 'restarted',
                  pid: handle.pid ?? null,
                  port: handle.port ?? effectiveConfig.port ?? null,
                  attempts,
                  recovered,
                };
              }
              if (killErr) {
                return {
                  name: config.name,
                  label: metadata.label ?? config.name,
                  ok: false,
                  status: 'failed',
                  pid: verifiedPid,
                  port: config.port ?? null,
                  attempts: 0,
                  recovered: false,
                  error: `SIGKILL could not be delivered (${killErr.code ?? killErr.message}) — daemon still running (PID ${verifiedPid})`,
                };
              }
            }
            const pidSuffix = pid ? ` (PID ${pid})` : '';
            const sigkillNote = sigkillAttempted ? ' (survived SIGKILL)' : '';
            return {
              name: config.name,
              label: metadata.label ?? config.name,
              ok: false,
              status: 'failed',
              pid,
              port: config.port ?? null,
              attempts: 0,
              recovered: false,
              error: `Daemon still running after restart stop verification${sigkillNote}${pidSuffix}`,
            };
          }
        }

        await rotateDaemonLogsForConfig(effectiveConfig);
        const { handle, attempts, recovered } = await startAgentWithRetry(effectiveConfig);
        return {
          name: effectiveConfig.name,
          label: metadata.label ?? effectiveConfig.name,
          ok: true,
          status: 'restarted',
          pid: handle.pid ?? null,
          port: handle.port ?? effectiveConfig.port ?? null,
          attempts,
          recovered,
        };
      } catch (err) {
        return {
          name: config.name,
          label: metadata.label ?? config.name,
          ok: false,
          status: 'failed',
          pid: null,
          port: config.port ?? null,
          attempts: err?.attempts ?? 0,
          recovered: false,
          error: err?.message ?? String(err),
        };
      }
    }

    return {
      name: effectiveConfig.name,
      label: metadata.label ?? effectiveConfig.name,
      ok: true,
      status: 'already_running',
      pid: running.pid ?? null,
      port: running.port ?? effectiveConfig.port ?? null,
      attempts: 0,
      recovered: false,
    };
  }

  try {
    await rotateDaemonLogsForConfig(effectiveConfig);
    const { handle, attempts, recovered } = await startAgentWithRetry(effectiveConfig);
    return {
      name: effectiveConfig.name,
      label: metadata.label ?? effectiveConfig.name,
      ok: true,
      status: 'started',
      pid: handle.pid ?? null,
      port: handle.port ?? effectiveConfig.port ?? null,
      attempts,
      recovered,
    };
  } catch (err) {
    return {
      name: config.name,
      label: metadata.label ?? config.name,
      ok: false,
      status: 'failed',
      pid: null,
      port: config.port ?? null,
      attempts: err?.attempts ?? 0,
      recovered: false,
      error: err?.message ?? String(err),
    };
  }
}

async function collectStopTargets(args) {
  const noTranscripts = args.includes('--no-transcripts');
  const noBrain = args.includes('--no-brain');
  const allFlag = args.includes('--all');

  // Collect positional args (non-flag) as project ID filters.
  const FLAGS = new Set([
    '--no-transcripts',
    '--no-brain',
    '--no-brain-db',
    '--no-inbox',
    '--yes',
    '--all',
  ]);
  const projectFilter = args.filter((a) => !FLAGS.has(a));

  const stopTranscripts = !noTranscripts && (allFlag || projectFilter.length === 0);
  const stopBrain = !noBrain;

  if (!stopTranscripts && !stopBrain) {
    console.error('Nothing to stop: both --no-transcripts and --no-brain were passed.');
    process.exit(1);
  }

  const targets = [];

  if (stopBrain) {
    let brainEntries = await getBrainAgentEntries();
    const isMultiBrain = brainEntries.length > 1;

    if (isMultiBrain && !allFlag && projectFilter.length === 0) {
      console.error('Multiple brains detected. Specify project IDs or use --all:');
      console.error('');
      console.error('  agentbootup daemon stop <project-id...>');
      console.error('  agentbootup daemon stop --all');
      console.error('');
      console.error('Available project IDs:');
      for (const e of brainEntries) console.error(`  ${e.key}`);
      process.exit(1);
    }

    if (!allFlag && projectFilter.length > 0) {
      const filterSet = new Set(projectFilter);
      const filtered = brainEntries.filter((e) => filterSet.has(e.key));
      if (filtered.length === 0) {
        console.error(`No matching projects found for: ${projectFilter.join(', ')}`);
        console.error('Available project IDs:');
        for (const e of brainEntries) console.error(`  ${e.key}`);
        process.exit(1);
      }
      brainEntries = filtered;
    }
    for (const entry of brainEntries) {
      targets.push({ name: entry.name, label: entry.label });
    }
  }

  if (stopTranscripts) targets.push({ name: TRANSCRIPTS_NAME, label: 'Transcript sync' });

  // Brain DB sync daemons.
  const noBrainDb = args.includes('--no-brain-db');
  if (!noBrainDb) {
    const brainDbEntries = await getBrainDbAgentEntries();
    for (const entry of brainDbEntries) {
      if (!allFlag && projectFilter.length > 0 && !projectFilter.includes(entry.key)) continue;
      targets.push({ name: entry.name, label: entry.label });
    }
  }

  // Inbox daemons — use allocate:false so stop target discovery never triggers
  // port allocation side effects while we are trying to shut services down.
  const noInbox = args.includes('--no-inbox');
  if (!noInbox) {
    const inboxEntries = await getInboxAgentEntries({ allocate: false });
    for (const entry of inboxEntries) {
      if (!allFlag && projectFilter.length > 0 && !projectFilter.includes(entry.key)) continue;
      targets.push({ name: entry.name, label: entry.label });
    }
  }

  // Custom brain daemons.
  const customEntries = await getCustomAgentEntries();
  for (const entry of customEntries) {
    if (!allFlag && projectFilter.length > 0 && !projectFilter.includes(entry.projectId)) continue;
    targets.push({ name: entry.name, label: entry.label });
  }

  return targets;
}

function buildStartDiagnostics(results) {
  const started = results.filter((r) => r.status === 'started');
  const restarted = results.filter((r) => r.status === 'restarted');
  const alreadyRunning = results.filter((r) => r.status === 'already_running');
  const failed = results.filter((r) => r.status === 'failed');
  const retried = results.filter((r) => r.ok && r.attempts > 1);
  const recovered = results.filter((r) => r.ok && r.recovered);
  const exitCode = failed.length > 0 ? 1 : 0;

  return {
    requested: results.length,
    started,
    restarted,
    alreadyRunning,
    failed,
    retried,
    recovered,
    exitCode,
    diagnostics: [
      'agentbootup daemon status',
      'agentbootup daemon logs [transcripts|brain|brain-db]',
      'agentbootup daemon verify',
    ],
  };
}

/**
 * Validate that credentials exist. Optionally checks brain ID.
 * Exits process with a clear error message if missing.
 * @param {{ skipBrainIdCheck?: boolean }} [opts]
 * Returns { creds } if valid.
 */
export async function validateCredentials(opts = {}) {
  const credentialState = await inspectCredentials();
  if (credentialState.state !== CREDS_STATE_OK) {
    console.error(formatCredentialsRecoveryMessage(credentialState));
    process.exit(1);
  }
  const creds = credentialState.creds;
  if (!isPlausibleServerUrl(creds.serverUrl)) {
    console.error(
      `Invalid server URL in credentials: "${creds.serverUrl}". ` +
        'Port 0 or non-http(s) is not a valid target. Re-run: agentbootup auth login --server-url <url>'
    );
    process.exit(1);
  }
  if (!opts.skipBrainIdCheck) {
    const brainId = await getBrainId();
    if (!brainId) {
      console.error(
        'No brain ID configured. Run: agentbootup config set-brain <id>'
      );
      process.exit(1);
    }
  }
  return { creds };
}

/**
 * Ensure the user has acknowledged that transcript history will be transmitted.
 * Persists the acknowledgement to config on first --yes so future starts
 * don't require the flag again.
 */
export async function checkTranscriptConsent(creds, yesFlag) {
  const cfg = await readConfig();
  const hasAcknowledged = cfg.dataTransmissionAcknowledged === true;
  if (!hasAcknowledged && !yesFlag) {
    console.error(
      'IMPORTANT: The transcript sync daemon continuously uploads AI conversation history'
    );
    console.error(`  to ${creds.serverUrl}`);
    console.error('');
    console.error('To confirm you understand and agree, run:');
    console.error('  agentbootup daemon start --yes');
    process.exit(1);
  }
  if (yesFlag && !hasAcknowledged) {
    await writeConfig({ dataTransmissionAcknowledged: true });
  }
}

async function acknowledgeDaemonConsents(yesFlag) {
  if (!yesFlag) return;
  try {
    const cfg = await readConfig();
    if (cfg.dataTransmissionAcknowledged === true && cfg.brainAssetTransmissionAcknowledged === true) {
      return;
    }
    await writeConfig({
      dataTransmissionAcknowledged: true,
      brainAssetTransmissionAcknowledged: true,
    });
  } catch (err) {
    console.error(`Failed to persist consent acknowledgement: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Ensure the user has acknowledged that brain assets will be transmitted.
 * Persists the acknowledgement to config on first --yes.
 */
export async function checkBrainConsent(creds, yesFlag) {
  const cfg = await readConfig();
  const hasAcknowledged = cfg.brainAssetTransmissionAcknowledged === true;
  if (!hasAcknowledged && !yesFlag) {
    console.error(
      'IMPORTANT: The brain asset daemon continuously uploads skills, agents, commands, memory and protocols'
    );
    console.error(`  to ${creds.serverUrl}`);
    console.error('');
    console.error('To confirm you understand and agree, run:');
    console.error('  agentbootup daemon start --yes');
    process.exit(1);
  }
  if (yesFlag && !hasAcknowledged) {
    await writeConfig({ brainAssetTransmissionAcknowledged: true });
  }
}

// ── Sub-command handlers ──────────────────────────────────────────────────────

/**
 * `agentbootup daemon start [project...|--all] [options] [--yes]`
 *
 * Starts one or both daemon agents. Credential pre-validation and consent
 * checks happen BEFORE any agentStart call so the user gets an immediate
 * actionable error rather than a silent timeout.
 */
async function handleStart(args, options = {}) {
  const jsonOutput = args.includes('--json');
  const info = (...parts) => {
    if (!jsonOutput) console.log(...parts);
  };
  const warn = (...parts) => {
    if (!jsonOutput) console.warn(...parts);
  };
  const error = (...parts) => {
    if (!jsonOutput) console.error(...parts);
  };
  const noTranscripts = args.includes('--no-transcripts');
  const noBrain = args.includes('--no-brain');
  const noIndexTranscripts = args.includes('--no-index-transcripts');
  const noNarrative = args.includes('--no-narrative');
  const yesFlag = args.includes('--yes');
  const forceRestartRunning = options.forceRestartRunning === true;
  const forceRestartNames = options.forceRestartNames instanceof Set ? options.forceRestartNames : null;
  const shouldForceRestart = (name) => forceRestartRunning || forceRestartNames?.has(name) === true;

  const allFlag = args.includes('--all');

  // Parse --skills-mode=<value> or --skills-mode <value>.
  let skillsMode = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--skills-mode=')) {
      skillsMode = arg.slice('--skills-mode='.length);
      break;
    }
    if (arg === '--skills-mode' && args[i + 1] !== undefined) {
      skillsMode = args[i + 1];
      break;
    }
  }

  if (skillsMode !== null) {
    if (skillsMode !== 'static' && skillsMode !== 'mech-storage') {
      console.error(`Invalid --skills-mode value: "${skillsMode}". Valid values: static, mech-storage`);
      process.exit(1);
    }
    await setSkillsMode(skillsMode);
  }

  const projectFilter = parseScopedProjectFilter(args);

  const startBrain = !noBrain;
  const startTranscripts = !noTranscripts;

  if (allFlag && projectFilter.length > 0) {
    console.error('Cannot combine --all with explicit project IDs.');
    process.exit(1);
  }

  if (!startTranscripts && !startBrain) {
    console.error('Nothing to start: both --no-transcripts and --no-brain were passed.');
    process.exit(1);
  }

  // Discover network projects for multi-brain mode.
  let networkProjects = (startBrain || startTranscripts) ? await getNetworkProjects() : null;

  await acknowledgeDaemonConsents(yesFlag);

  if (!networkProjects && projectFilter.length > 0) {
    console.error('Project-scoped daemon start requires a network root.');
    console.error('Run: agentbootup config set-network-root <path>');
    process.exit(1);
  }

  // In multi-brain mode, require either --all or explicit project IDs.
  if (networkProjects && startBrain && !allFlag && projectFilter.length === 0) {
    console.error('Multiple brains detected. Specify project IDs or use --all:');
    console.error('');
    console.error('  agentbootup daemon start <project-id...> [options] [--yes]');
    console.error('  agentbootup daemon start --all [options] [--yes]');
    console.error('');
    console.error('Note: project-scoped daemon starts also start scoped transcript sync unless --no-transcripts is passed.');
    console.error('');
    console.error('Available project IDs:');
    for (const p of networkProjects) console.error(`  ${p.id}`);
    process.exit(1);
  }

  // Apply project filter if specified.
  if (networkProjects && projectFilter.length > 0) {
    const filterSet = new Set(projectFilter);
    const allProjects = networkProjects;
    networkProjects = networkProjects.filter((p) => filterSet.has(p.id) || filterSet.has(p.agent_id));
    if (networkProjects.length === 0) {
      console.error(`No matching projects found for: ${projectFilter.join(', ')}`);
      console.error('Available project IDs:');
      for (const p of allProjects) console.error(`  ${p.id}`);
      process.exit(1);
    }
  }

  const isMultiBrain = !!networkProjects;
  const singleProjectScope = isMultiBrain
    ? null
    : unifiedDaemonRuntime.resolveSingleProjectScope(process.cwd());
  const singleProjectRoot = singleProjectScope?.projectRoot || null;
  const transcriptRoot = singleProjectScope?.repositoryRoot || singleProjectRoot;
  const transcriptProjectIds = isMultiBrain && projectFilter.length > 0
    ? networkProjects.map((p) => p.id)
    : null;

  // Resolve the effective skills mode (may have been set by --skills-mode above).
  const effectiveSkillsMode = await getSkillsMode();

  // Pre-validate credentials BEFORE calling agentStart so the user sees a clear
  // error immediately rather than a platform-level daemon failure.
  // In multi-brain mode, brain IDs come from the network config, not the global config.
  const { creds } = await validateCredentials({ skipBrainIdCheck: isMultiBrain });

  // Check consent for each enabled daemon — exits early if not acknowledged.
  if (startTranscripts) {
    await checkTranscriptConsent(creds, yesFlag);
  }
  if (startBrain) {
    await checkBrainConsent(creds, yesFlag);
  }

  // Start each daemon independently so a failure in one doesn't prevent the other.
  const results = [];
  if (startTranscripts) {
    const scopeLabel = transcriptProjectIds?.length
      ? ` for project(s): ${transcriptProjectIds.join(', ')}`
      : '';
    info(`Starting transcript sync daemon${scopeLabel}...`);
    info(`NOTE: conversation history will be transmitted to ${creds.serverUrl}`);
    const result = await ensureAgentStarted({
      name: TRANSCRIPTS_NAME,
      script: TRANSCRIPTS_SCRIPT,
      port: TRANSCRIPTS_PORT,
      interpreter: BUN_INTERPRETER,
      workingDirectory: transcriptRoot || undefined,
      env: transcriptProjectIds?.length
        ? { AGENTBOOTUP_TRANSCRIPT_PROJECT_IDS: transcriptProjectIds.join(',') }
        : transcriptRoot
          ? {
            AGENTBOOTUP_PROJECT_ROOT: singleProjectRoot,
            AGENTBOOTUP_REPOSITORY_ROOT: transcriptRoot,
          }
          : undefined,
    // Transcript cwd/env define a data-security boundary. The platform status
    // API does not expose enough launch configuration to compare that boundary,
    // so reapply it on every explicit start instead of accepting stale scope.
    }, { label: 'transcripts' }, {
      forceRestartRunning: forceRestartNames
        ? shouldForceRestart(TRANSCRIPTS_NAME)
        : true,
    });
    if (result.status === 'already_running') {
      info(`Transcript sync daemon already running (PID ${result.pid})`);
    } else if (result.ok) {
      info(`Transcript sync daemon started (PID ${result.pid})`);
    } else {
      error(`Failed to start transcript sync daemon: ${result.error}`);
    }
    results.push(result);
  }

  if (startBrain && isMultiBrain) {
    // Multi-brain mode: start one daemon per network project.
    if (networkProjects.length > 20) {
      info(`Warning: starting ${networkProjects.length} brain daemons — performance may degrade above 20`);
    }
    info(`Starting brain asset sync for ${networkProjects.length} project(s)...`);
    info(`NOTE: brain assets will be transmitted to ${creds.serverUrl}`);
    for (const project of networkProjects) {
      if (!project.id || !project.agent_id) {
        info(`  Skipping project with missing id/agent_id: ${JSON.stringify(project)}`);
        continue;
      }
      if (!project.path) {
        info(`  Skipping ${project.agent_id}: not linked (run 'brain link ${project.agent_id} --path <dir>')`);
        continue;
      }
      const agentName = `agentbootup-brain-${project.id}`;
      const result = await ensureAgentStarted({
          name: agentName,
          script: BRAIN_SCRIPT,
          interpreter: BUN_INTERPRETER,
          env: {
            AGENTBOOTUP_BRAIN_ID: project.agent_id,
            AGENTBOOTUP_PROJECT_ROOT: project.path,
            AGENTBOOTUP_SKILLS_MODE: effectiveSkillsMode,
            AGENTBOOTUP_DISABLE_HEALTH_SERVER: '1',
          },
        }, { label: project.agent_id }, { forceRestartRunning: shouldForceRestart(agentName) });
      if (result.status === 'already_running') {
        info(`  ${project.agent_id} already running (PID ${result.pid})`);
      } else if (result.ok) {
        info(`  ${project.agent_id} started (PID ${result.pid})`);
      } else {
        error(`  ${project.agent_id} failed: ${result.error}`);
      }
      results.push(result);
    }
  } else if (startBrain) {
    // Single-brain fallback: no network config, so only one daemon (current directory).
    info('');
    info('No network config: only one brain will sync (current directory).');
    info('To sync all brains on this machine:');
    info('  1. agentbootup config set-network-root <path>   # path to dir containing agentbootup.json');
    info('  2. agentbootup brain link <agent-id> --path <dir>   # for each brain');
    info('  3. agentbootup daemon start --all [--yes]');
    info('');
    info(`Starting brain asset sync daemon (project: ${process.cwd()})...`);
    info(`NOTE: brain assets (skills, agents, commands, memory and protocols) will be transmitted to ${creds.serverUrl}`);
    const singleBrainRoot = singleProjectRoot || process.cwd();
    const singleBrainId = await getBrainId();
    const result = await ensureAgentStarted({
      name: BRAIN_NAME,
      script: BRAIN_SCRIPT,
      interpreter: BUN_INTERPRETER,
      workingDirectory: singleBrainRoot,
      env: {
        AGENTBOOTUP_PROJECT_ROOT: singleBrainRoot,
        AGENTBOOTUP_BRAIN_ID: singleBrainId || '',
        AGENTBOOTUP_SKILLS_MODE: effectiveSkillsMode,
        AGENTBOOTUP_DISABLE_HEALTH_SERVER: '1',
      },
    }, { label: singleBrainId || BRAIN_NAME }, { forceRestartRunning: shouldForceRestart(BRAIN_NAME) });
    if (result.status === 'already_running') {
      info(`Brain asset sync daemon already running (PID ${result.pid})`);
    } else if (result.ok) {
      info(`Brain asset sync daemon started (PID ${result.pid})`);
    } else {
      error(`Failed to start brain asset sync daemon: ${result.error}`);
    }
    results.push(result);
  }

  // Start brain-db-sync daemons for provisioned projects (unless --no-brain-db).
  const noBrainDb = args.includes('--no-brain-db');
  // Collect provisioned project paths for post-start transcript indexing.
  let indexableProjects = [];
  if (!noBrainDb) {
    const brainDbEntries = await getBrainDbAgentEntries();
    if (brainDbEntries.length > 0) {
      // getBrainDbAgentEntries() already filters to provisioned projects only
      // (those with brain-schema.sql + BRAIN_DB_URL in .env). In the single-brain
      // path (no network config) it returns [] so this block is a no-op.
      // In multi-brain mode, honour the explicit project filter if provided.
      const filteredDbEntries = (projectFilter.length > 0 && isMultiBrain)
        ? brainDbEntries.filter((e) => projectFilter.includes(e.key))
        : brainDbEntries;

      // Collect paths for transcript indexing after daemons are started.
      indexableProjects = filteredDbEntries.filter((e) => e.path).map((e) => ({
        path: e.path,
        label: e.label ?? e.key ?? path.basename(e.path),
      }));

      for (const entry of filteredDbEntries) {
        const result = await ensureAgentStarted({
          name: entry.name,
          script: BRAIN_DB_SCRIPT,
          interpreter: BUN_INTERPRETER,
          env: entry.env,
        }, { label: entry.label }, { forceRestartRunning: shouldForceRestart(entry.name) });
        if (result.status === 'already_running') {
          info(`  ${entry.label} already running (PID ${result.pid})`);
        } else if (result.ok) {
          info(`  ${entry.label} started (PID ${result.pid})`);
        } else {
          error(`  ${entry.label} failed: ${result.error}`);
        }
        results.push(result);
      }
    }
  }

  // Start inbox daemons for provisioned projects (unless --no-inbox).
  const noInbox = args.includes('--no-inbox');
  if (!noInbox) {
    const inboxEntries = await getInboxAgentEntries({
      mechPlaneUrl: creds?.serverUrl ?? null,
      apiKey: creds?.apiKey ?? null,
    });
    const filteredInboxEntries = (projectFilter.length > 0 && isMultiBrain)
      ? inboxEntries.filter((e) => projectFilter.includes(e.key))
      : inboxEntries;

    // One-time check: warn if the claude binary is not findable, as inbox
    // daemons rely on it to spawn mech-run sessions.
    {
      const claudeBinDirs = [
        path.join(os.homedir(), '.claude', 'local', 'bin'),
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.bun', 'bin'),
      ];
      const claudeFoundInKnownDir = claudeBinDirs.some(
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- dir comes from fixed home-relative install locations; this only probes for a local binary.
        (dir) => fs.existsSync(path.join(dir, 'claude')),
      );
      if (!claudeFoundInKnownDir) {
        // Also check PATH entries for claude binary.
        const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const claudeFoundInPath = pathDirs.some(
          // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- PATH entries are not opened for user-chosen file access; this is a local executable existence check only.
          (dir) => fs.existsSync(path.join(dir, 'claude')),
        );
        if (!claudeFoundInPath) {
          error(
            '[warning] claude CLI not found — mech-run sessions will fail with "provider not available". ' +
            'Ensure claude is installed (https://claude.ai/download).',
          );
        }
      }
    }

    for (const entry of filteredInboxEntries) {
      const result = await ensureAgentStarted({
          name: entry.name,
          script: INBOX_DAEMON_SCRIPT,
          interpreter: BUN_INTERPRETER,
          port: parseInt(entry.env.AGENTBOOTUP_INBOX_PORT, 10),
          env: entry.env,
        }, { label: entry.label }, { forceRestartRunning: shouldForceRestart(entry.name) });
        if (result.status === 'already_running') {
          info(`  ${entry.label} already running (PID ${result.pid}, port ${result.port ?? entry.env.AGENTBOOTUP_INBOX_PORT})`);
        } else if (result.ok) {
          info(`  ${entry.label} started (PID ${result.pid}, port ${entry.env.AGENTBOOTUP_INBOX_PORT})`);
        } else {
          error(`  ${entry.label} failed: ${result.error}`);
        }
        results.push(result);

        if (result.status === 'failed') {
          continue;
        }

        // Poll the state file until the daemon writes it (up to 5 s, 200 ms intervals).
        // A fixed sleep is fragile on slow disks or cold Bun starts — polling is more robust.
        // Reading the state file is also more reliable than probing the expected port via HTTP:
        // if the daemon drifted to a different port due to EADDRINUSE, the HTTP probe fails and
        // drift goes undetected, whereas the state file always records the actual bound port.
        const inboxBrainId = entry.env.AGENTBOOTUP_BRAIN_ID;
        const expectedPort = parseInt(entry.env.AGENTBOOTUP_INBOX_PORT, 10);
        let stateData = { state: 'offline' };
        const statePollDeadline = Date.now() + 5000;
        while (Date.now() < statePollDeadline) {
          await sleep(200);
          stateData = readInboxDaemonState(inboxBrainId);
          if (stateData.state === 'online') break;
        }
        if (stateData.state === 'online' && stateData.port != null && stateData.port !== expectedPort) {
          // Daemon bound to a different port — delegate to shared helper that enforces
          // the portRegistryUpdated invariant (mech-plane only patched if local config write succeeds).
          const { portRegistryUpdated, registered } = await updatePortAndReRegister(
            inboxBrainId, stateData.port,
            { mechPlaneUrl: creds?.serverUrl ?? null, apiKey: creds?.apiKey ?? null, verbose: false },
          );
          if (portRegistryUpdated) {
            info(
              `  ${entry.label}: port drifted to :${stateData.port} — portRegistry updated` +
              (registered ? ', mech-plane re-registered' : ''),
            );
          } else {
            warn(`  ${entry.label}: port drifted to :${stateData.port} but portRegistry update failed`);
          }
        } else if (stateData.state === 'online') {
          info(`  ${entry.label}: port :${expectedPort} verified`);
        } else {
          // State file not yet written or daemon still initialising — drift check skipped.
          info(`  ${entry.label}: state file not ready (${stateData.state}) — drift check deferred`);
        }
    }
  }

  // Start custom brain daemons declared in brain/daemons.json per project.
  const customEntries = await getCustomAgentEntries();
  const filteredCustomEntries = (projectFilter.length > 0 && isMultiBrain)
    ? customEntries.filter((e) => projectFilter.includes(e.projectId))
    : customEntries;
  for (const entry of filteredCustomEntries) {
    const result = await ensureAgentStarted({
      name: entry.name,
      script: entry.script,
      interpreter: BUN_INTERPRETER,
      env: entry.env,
    }, { label: entry.label }, { forceRestartRunning: shouldForceRestart(entry.name) });
    if (result.status === 'already_running') {
      info(`  ${entry.label} already running (PID ${result.pid})`);
    } else if (result.ok) {
      info(`  ${entry.label} started (PID ${result.pid})`);
    } else {
      error(`  ${entry.label} failed: ${result.error}`);
    }
    results.push(result);
  }

  // Index transcripts into brain.db sequentially after daemons have started.
  // Indexing failures are logged but never prevent daemon start from completing.
  if (noIndexTranscripts) {
    info('[index-transcripts] skipped (--no-index-transcripts)');
  } else if (noBrainDb) {
    info('[index-transcripts] skipped (--no-brain-db)');
  } else if (indexableProjects.length > 0) {
    // Sequential intentionally: each project has its own brain.db so there is
    // no cross-project lock contention, but parallel I/O on startup could
    // overwhelm slower machines. Keep sequential and simple.
    for (const { path: targetPath, label } of indexableProjects) {
      info(`[brain-db] indexing transcripts for ${label}`);
      try {
        await unifiedDaemonRuntime.runIndexTranscripts(['--target', targetPath]);
      } catch (err) {
        error(`[index-transcripts] indexing failed for ${label} (non-fatal): ${err.message}`);
      }
    }
  } else {
    // noBrainDb=false, noIndexTranscripts=false, but no provisioned projects found.
    info('[index-transcripts] skipped (no provisioned projects)');
  }

  // Run narrative-generator once per day (after transcript indexing).
  // Generates yesterday's first-person inner monologue and uploads to AgentDrive.
  // Gated on: narrative file not yet existing for yesterday + runtime present in target.
  if (!noNarrative && indexableProjects.length > 0) {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    for (const { path: targetPath, label } of indexableProjects) {
      await runDailyNarrativeGenerator({ targetPath, label, yesterday, info, error });
    }
  }

  const diagnostics = buildStartDiagnostics(results);

  if (jsonOutput) {
    console.log(JSON.stringify({
      summary: {
        requested: diagnostics.requested,
        started: diagnostics.started.length,
        alreadyRunning: diagnostics.alreadyRunning.length,
        restarted: diagnostics.restarted.length,
        failed: diagnostics.failed.length,
        retried: diagnostics.retried.length,
        recovered: diagnostics.recovered.length,
        exitCode: diagnostics.exitCode,
      },
      services: results.map((result) => ({
        name: result.name,
        label: result.label,
        status: result.status,
        pid: result.pid ?? null,
        port: result.port ?? null,
        attempts: result.attempts ?? 0,
        recovered: !!result.recovered,
        error: result.error ?? null,
      })),
      diagnostics: diagnostics.diagnostics,
    }, null, 2));
  } else if (results.length > 0) {
    info('');
    info('Start summary:');
    info(`  Started: ${diagnostics.started.length}`);
    info(`  Already running: ${diagnostics.alreadyRunning.length}`);
    info(`  Restarted: ${diagnostics.restarted.length}`);
    info(`  Failed: ${diagnostics.failed.length}`);
    if (diagnostics.started.length > 0) {
      info(`  Started services: ${diagnostics.started.map((r) => r.label).join(', ')}`);
    }
    if (diagnostics.restarted.length > 0) {
      info(`  Restarted services: ${diagnostics.restarted.map((r) => r.label).join(', ')}`);
    }
    if (diagnostics.alreadyRunning.length > 0) {
      info(`  Already running services: ${diagnostics.alreadyRunning.map((r) => r.label).join(', ')}`);
    }
    if (diagnostics.retried.length > 0) {
      info(`  Retried (transient launchd): ${diagnostics.retried.map((r) => r.label).join(', ')}`);
    }
    if (diagnostics.recovered.length > 0) {
      info(`  Recovered after transient start failure: ${diagnostics.recovered.map((r) => r.label).join(', ')}`);
    }
    if (diagnostics.failed.length > 0) {
      info(`  Failed services: ${diagnostics.failed.map((r) => r.label).join(', ')}`);
      for (const failed of diagnostics.failed) {
        error(`  ${failed.label}: ${failed.error}`);
      }
    }
  }

  if (diagnostics.exitCode !== 0) {
    error('');
    error(`For diagnostics: ${diagnostics.diagnostics.join('; ')}`);
    process.exit(1);
  }

  // Doctor tick (PRD-0039 FR-7/10b): opt-in, off by default (AC-9).
  // Import is deferred inside the enabled branch so the module (and its transitive
  // imports) are never loaded when the feature is disabled — the default case.
  if (process.env.AGENTBOOTUP_DOCTOR_TICK_ENABLED === '1') {
    const tickMs = process.env.AGENTBOOTUP_DOCTOR_TICK_MS ? Number(process.env.AGENTBOOTUP_DOCTOR_TICK_MS) : undefined;
    try {
      const { startDoctorTick } = await import('./doctor-tick.js');
      // Fire-and-forget: startDoctorTick returns synchronously (starts a setInterval);
      // the first runTick() is called without await so handleStart is not blocked.
      // Runs on the same process so it shares the daemon lifecycle — stopping the
      // daemon stops the tick with it. Creds are guaranteed valid (validateCredentials
      // exits the process on failure before this point).
      startDoctorTick({
        serverUrl: creds.serverUrl,
        apiKey: creds.apiKey,
        cwd: process.env.AGENTBOOTUP_PROJECT_ROOT || process.cwd(),
        ...(tickMs ? { tickMs } : {}),
      });
      info('[doctor-tick] health reporter started (posting to the Fleet Health Board every tick)');
    } catch (err) {
      // Non-fatal: the daemon's primary duties (transcript/brain sync) are unaffected.
      error(`[doctor-tick] failed to start (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * `agentbootup daemon stop [--no-transcripts] [--no-brain]`
 *
 * Stops one or both daemons gracefully. Mirrors start's --no-transcripts /
 * --no-brain flags so individual daemons can be stopped independently.
 * Prints "not running" if a daemon is not registered or already stopped.
 * Exits 1 if a stop request returns but the daemon still appears to be running.
 *
 * Callers that pass `options.targets` are responsible for supplying a
 * prevalidated target list equivalent to `collectStopTargets(args)`.
 */
async function handleStop(args, options = {}) {
  const continueOnVerificationFailure = options.continueOnVerificationFailure === true;
  const targets = options.targets ?? await collectStopTargets(args);

  const verificationFailures = [];
  for (const { name, label } of targets) {
    try {
      await agentStop(name);
      const stopResult = await waitForAgentStopped(name);
      if (stopResult.stopped) {
        console.log(`${label} daemon stopped`);
        continue;
      }

      const pidSuffix = stopResult.info?.pid ? ` (PID ${stopResult.info.pid})` : '';
      const message = `${label} daemon stop requested but process is still running${pidSuffix}`;
      if (continueOnVerificationFailure) {
        console.log(`${message}; continuing with forced restart`);
      } else {
        console.error(message);
        verificationFailures.push({ name, label });
      }
    } catch (err) {
      // Treat "not loaded", "not found", or "not running" as graceful "not running".
      const msg = String(err.message ?? '').toLowerCase();
      const notRunning =
        msg.includes('not loaded') ||
        msg.includes('not found') ||
        msg.includes('not running') ||
        msg.includes('no such') ||
        msg.includes('esrch') ||
        msg.includes('3840') || // launchctl exit code for "not found"
        err.code === 'ESRCH';
      if (notRunning) {
        console.log(`${label} daemon: not running`);
      } else {
        console.error(`Failed to stop ${label} daemon: ${err.message}`);
      }
    }
  }

  if (verificationFailures.length > 0 && !continueOnVerificationFailure) {
    process.exit(1);
  }
}

/**
 * Read inbox daemon state from its state file and check PID liveness.
 *
 * Inbox daemons write `~/.agentbootup/inbox-daemons/<brainId>.json` on start
 * and delete it on clean exit.
 *
 * @param {string} brainId  e.g. "bootup.gm"
 * @returns {{ state: string, pid?: number, port?: number }}
 */
/**
 * Directory for per-brain inbox daemon JSON state (`<brainId>.json`).
 * `AGENTBOOTUP_INBOX_DAEMONS_DIR` is test-only: must be a non-empty string after trim.
 */
export function resolveInboxDaemonStateDir() {
  const raw = process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length > 0) return trimmed;
  return path.join(os.homedir(), '.agentbootup', 'inbox-daemons');
}

function readInboxDaemonState(brainId) {
  // State dir: default ~/.agentbootup/inbox-daemons; tests may set
  // AGENTBOOTUP_INBOX_DAEMONS_DIR (see resolveInboxDaemonStateDir).
  const stateDir = resolveInboxDaemonStateDir();
  // path.basename strips path-separator components from brainId, preventing
  // traversal via the brainId argument. stateDir is trusted (see above).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const stateFilePath = path.join(stateDir, path.basename(brainId) + '.json');

  let raw;
  try {
    raw = fs.readFileSync(stateFilePath, 'utf-8');
  } catch {
    return { state: 'offline' };
  }

  let stateData;
  try {
    stateData = JSON.parse(raw);
  } catch {
    return { state: 'offline' };
  }

  const { pid, port } = stateData;
  if (!pid) return { state: 'offline' };

  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }

  if (alive) {
    return { state: 'online', pid, port };
  }
  return { state: 'dead (stale state file)', pid, port };
}

/**
 * `agentbootup daemon status [--json]`
 *
 * Shows labelled status sections for both daemons.
 * With --json, emits a machine-readable JSON object.
 */
async function handleStatus(args) {
  const jsonOutput = args.includes('--json');

  const brainEntries = await getBrainAgentEntries();
  const brainDbEntries = await getBrainDbAgentEntries();
  const entries = [{ name: TRANSCRIPTS_NAME, label: 'Transcripts', key: 'transcripts' }];
  for (const entry of brainEntries) {
    entries.push({
      name: entry.name,
      label: entry.label,
      key: entry.key,
      brainId: entry.brainId,
      path: entry.path,
    });
  }
  for (const entry of brainDbEntries) {
    entries.push({
      name: entry.name,
      label: entry.label,
      key: `brain-db-${entry.key}`,
      brainId: entry.brainId,
      path: entry.path,
    });
  }

  // Collect inbox daemon entries (read-only, no port/secret allocation).
  const inboxEntries = await getInboxAgentEntries({ allocate: false });

  async function completionForEntry(entry, info) {
    const active = info?.state === 'online' || info?.state === 'running';
    if (!active) return null;
    if (entry.key === 'transcripts') {
      try {
        if (!_fetch) return null;
        const port = Number(info.port) || TRANSCRIPTS_PORT;
        const response = await _fetch(`http://127.0.0.1:${port}/status`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) return null;
        const status = await response.json();
        return {
          lastCompletedAt: typeof status.lastCompletedAt === 'string' ? status.lastCompletedAt : null,
          lastPushed: Number.isFinite(status.pushes) ? status.pushes : null,
          lastErrors: Number.isFinite(status.errors) ? status.errors : null,
        };
      } catch {
        return null;
      }
    }
    if (entry.key.startsWith('brain-db-')) {
      const brainId = entry.brainId ?? entry.key.slice('brain-db-'.length);
      const health = readLiveBrainDbSyncHealth(brainId, info.pid);
      return health ? { lastCompletedAt: health.lastSyncAt, lastPushed: null, lastErrors: null } : null;
    }
    const health = readLivePersistedBrainSyncHealth(entry.brainId ?? entry.key, info.pid);
    return health ? {
      lastCompletedAt: health.lastSyncAt,
      lastPushed: health.lastPushed,
      lastErrors: health.lastErrors,
      memoryConverge: health.memoryConverge ?? null,
    } : null;
  }

  if (jsonOutput) {
    const result = {};
    for (const { name, key, brainId, path: projPath } of entries) {
      if (projPath === null && key !== 'transcripts') {
        result[key] = { state: 'not linked', path: null };
        continue;
      }
      try {
        const info = await agentStatus(name);
        const entry = info.state === 'unknown' ? { state: 'not installed' } : { ...info };
        const completion = await completionForEntry({ key, brainId }, entry);
        if (completion) entry.completion = completion;
        if (projPath) entry.path = projPath;
        result[key] = entry;
      } catch (err) {
        const msg = String(err.message ?? '').toLowerCase();
        const notFound =
          msg.includes('not found') ||
          msg.includes('not installed') ||
          msg.includes('not loaded') ||
          msg.includes('no such');
        result[key] = notFound ? { state: 'not installed' } : { state: 'unknown', error: err.message };
        if (projPath) result[key].path = projPath;
      }
    }

    // Add inbox daemon entries to JSON output.
    for (const inboxEntry of inboxEntries) {
      const brainId = inboxEntry.env?.AGENTBOOTUP_BRAIN_ID ?? inboxEntry.key;
      const inboxState = readInboxDaemonState(brainId);
      const jsonKey = `inbox-${inboxEntry.key}`;
      result[jsonKey] = { ...inboxState, brainId };
    }

    console.log(stringifyJsonEnvelope(result, 2));
    return;
  }

  for (const { name, label, key, brainId, path: projPath } of entries) {
    console.log(`[${label}]`);
    if (projPath === null && key !== 'transcripts') {
      console.log('  State: not linked');
      console.log('');
      continue;
    }
    try {
      const info = await agentStatus(name);
      if (info.state === 'unknown') {
        console.log('  State: not installed');
      } else {
        console.log(`  State: ${info.state}`);
        if (info.pid) console.log(`  PID: ${info.pid}`);
        if (info.port) console.log(`  Port: ${info.port}`);
        if (info.memory) console.log(`  Memory: ${info.memory}`);
        if (info.uptime !== undefined) console.log(`  Uptime: ${Math.round(info.uptime / 1000)}s`);
        if (info.restarts !== undefined) console.log(`  Restarts: ${info.restarts}`);
        const completion = await completionForEntry({ key, brainId }, info);
        if (completion) {
          console.log(`  Last completion: ${completion.lastCompletedAt ?? 'unavailable'}`);
          if (completion.lastPushed !== null) console.log(`  Last pushed: ${completion.lastPushed}`);
          if (completion.lastErrors !== null) console.log(`  Last errors: ${completion.lastErrors}`);
          if (completion.memoryConverge) {
            const converge = completion.memoryConverge;
            console.log(
              `  Memory converge: ${converge.state} ` +
              `(effective=${convergeBooleanLabel(converge.enabled, 'on', 'off')}, ` +
              `source=${converge.configSource ?? 'unknown'}, ` +
              `gate=${convergeBooleanLabel(converge.gateOpen, 'open', 'closed')})`,
            );
            if (converge.store) console.log(`  Memory store: ${converge.store}`);
            if (converge.lastCycleAt) console.log(`  Last converge cycle: ${converge.lastCycleAt}`);
            console.log(
              `  Fleet/head freshness: ${converge.freshnessState ?? 'unknown'}` +
              `${converge.freshnessCheckedAt ? ` (checked ${converge.freshnessCheckedAt}` : ''}` +
              `${Number.isInteger(converge.freshnessHeadCount) ? `, heads=${converge.freshnessHeadCount}` : ''}` +
              `${converge.freshnessCheckedAt ? ')' : ''}`,
            );
            if (converge.detail) console.log(`  Memory detail: ${converge.detail}`);
          }
        }
      }
      if (projPath) console.log(`  Path: ${projPath}`);
    } catch (err) {
      const msg = String(err.message ?? '').toLowerCase();
      const notFound =
        msg.includes('not found') ||
        msg.includes('not installed') ||
        msg.includes('not loaded') ||
        msg.includes('no such');
      if (notFound) {
        console.log('  State: not installed');
      } else {
        console.log(`  State: unknown (${err.message})`);
      }
      if (projPath) console.log(`  Path: ${projPath}`);
    }
    console.log('');
  }

  // Add inbox daemon sections to text output.
  for (const inboxEntry of inboxEntries) {
    const brainId = inboxEntry.env?.AGENTBOOTUP_BRAIN_ID ?? inboxEntry.key;
    const inboxState = readInboxDaemonState(brainId);
    console.log(`[${inboxEntry.label}]`);
    console.log(`  State: ${inboxState.state}`);
    if (inboxState.pid) console.log(`  PID: ${inboxState.pid}`);
    if (inboxState.port) console.log(`  Port: ${inboxState.port}`);
    const secret = inboxEntry.env?.AGENTBOOTUP_INBOX_WEBHOOK_SECRET;
    if (inboxState.state === 'online') {
      // Show presence/absence only — no partial secret in terminal output, shell history,
      // or log aggregation. Use `agentbootup config` to inspect the actual value.
      console.log(`  Secret: ${secret ? 'configured' : '(none)'}`);
    }
    console.log('');
  }

  if (!jsonOutput) {
    console.log('Note: State above is process health only. Use "agentbootup daemon verify" to confirm cloud sync.');
  }
}

/**
 * `agentbootup daemon logs [transcripts|brain] [--lines N]`
 *
 * Shows logs for one or both daemons. When showing both, logs are printed
 * in separate labelled blocks, each preceded by a [transcripts] or [brain]
 * separator header.
 *
 * --lines N (or a bare integer positional) controls how many lines to show.
 * Defaults to 50.
 */
async function handleLogs(args) {
  // Parse --lines N flag.
  let lines = 50;
  const linesIdx = args.indexOf('--lines');
  if (linesIdx !== -1 && args[linesIdx + 1] !== undefined) {
    const parsed = parseInt(args[linesIdx + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) lines = parsed;
  }

  // Determine target: positional arg that is 'transcripts', 'brain', or a
  // bare integer (legacy line-count override — accepted for backward compat).
  // Use index-based loop so '--lines N' can be skipped regardless of position,
  // preventing early exit that would drop a target appearing after the flag.
  let target = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--lines') {
      i++; // skip the value (already parsed above)
      continue;
    }
    if (arg === 'transcripts' || arg === 'brain' || arg === 'brain-db') {
      target = arg;
      break;
    }
    const n = parseInt(arg, 10);
    if (Number.isFinite(n) && n > 0) {
      // Bare integer treated as line count (backward compat with sync-daemon logs N).
      lines = n;
    }
  }

  // Parse optional project filter after 'brain' (e.g., `daemon logs brain mech-browse`).
  let brainFilter = null;
  if (target === 'brain') {
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (a === '--lines') { j++; continue; }
      if (a === 'brain') continue;
      if (!a.startsWith('-')) { brainFilter = a; break; }
    }
  }

  const targets = [];
  if (!target || target === 'transcripts') {
    targets.push({ name: TRANSCRIPTS_NAME, sectionLabel: '[transcripts]' });
  }
  if (!target || target === 'brain') {
    const brainEntries = await getBrainAgentEntries();
    for (const entry of brainEntries) {
      if (brainFilter && entry.key !== brainFilter) continue;
      targets.push({ name: entry.name, sectionLabel: `[${entry.label.toLowerCase()}]` });
    }
  }
  if (!target || target === 'brain-db') {
    const brainDbEntries = await getBrainDbAgentEntries();
    for (const entry of brainDbEntries) {
      if (brainFilter && entry.key !== brainFilter) continue;
      targets.push({ name: entry.name, sectionLabel: `[${entry.label.toLowerCase()}]` });
    }
  }

  if (targets.length === 0) {
    console.error('Usage: agentbootup daemon logs [transcripts|brain] [--lines N]');
    process.exit(1);
  }

  for (const { name, sectionLabel } of targets) {
    if (targets.length > 1) {
      console.log(`${sectionLabel} ─────────────────────────────────────────`);
    }
    try {
      await agentLogs(name, { lines });
    } catch (err) {
      const msg = String(err.message ?? '').toLowerCase();
      const notFound =
        msg.includes('not found') ||
        msg.includes('no log') ||
        msg.includes('not installed') ||
        msg.includes('not loaded');
      if (notFound) {
        console.log(`${sectionLabel} No logs available (daemon may not have been started yet)`);
      } else {
        console.error(`${sectionLabel} Error fetching logs: ${err.message}`);
      }
    }
    if (targets.length > 1) {
      console.log('');
    }
  }
}

function formatVerifyState(state) {
  if (state === 'present') return 'present';
  if (state === 'inventory_present_unverified') return 'inventory_present_unverified';
  if (state === 'empty') return 'empty';
  return 'error';
}

function formatMemoryVerifyState(state) {
  if (state === 'ok' || state === 'idle' || state === 'stale' || state === 'never_synced') return state;
  return 'error';
}

function resolveVerifyMemoryStore() {
  const raw = typeof process.env.AGENTBOOTUP_MEMORY_STORE === 'string'
    ? process.env.AGENTBOOTUP_MEMORY_STORE.trim()
    : '';
  return raw ? resolveMemoryStore(raw) : null;
}

async function fetchBrainCloudState(serverUrl, apiKey, brainId) {
  const endpoint = apiUrl(serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}/hashes`);
  const resp = await fetch(endpoint, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { state: 'error', error: `HTTP ${resp.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
  }
  const payload = await resp.json().catch(() => null);
  const files = payload?.data?.files;
  if (!Array.isArray(files)) {
    return { state: 'error', error: 'invalid server response (missing data.files array)' };
  }
  return { state: files.length > 0 ? 'present' : 'empty', count: files.length };
}

async function fetchTranscriptCloudState(serverUrl, apiKey, brainId) {
  const endpoint = `${apiUrl(serverUrl, '/v1/sync/transcripts/pull')}?brain_id=${encodeURIComponent(brainId)}`;
  const resp = await fetch(endpoint, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { state: 'error', error: `HTTP ${resp.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
  }
  const payload = await resp.json().catch(() => null);
  const transcripts = payload?.data?.files ?? payload?.data?.transcripts ?? payload?.transcripts;
  if (!Array.isArray(transcripts)) {
    return { state: 'error', error: 'invalid server response (missing data.files array)' };
  }
  return {
    state: transcripts.length > 0 ? 'inventory_present_unverified' : 'empty',
    count: transcripts.length,
    archiveAuthority: false,
    evictionEligible: false,
  };
}

function getVerifyEntryExitCode(info, currentExitCode) {
  if (info.state === 'error') return 2;
  if (info.memory?.state === 'error') return 2;
  if (info.state === 'empty' && currentExitCode === 0) return 1;
  if (
    (
      info.memory?.state === 'stale'
      || info.memory?.state === 'never_synced'
      || info.memory?.clockSkewStatus === 'degraded'
    )
    && currentExitCode === 0
  ) return 1;
  return currentExitCode;
}

function resolveVerifyProjects(projects, projectFilter) {
  if (!Array.isArray(projects) || projects.length === 0) return null;
  if (projectFilter.length === 0) return projects;
  const requestedProjects = projects.filter((project) => projectFilter.includes(project.id));
  if (requestedProjects.length === 0) {
    console.error(`No matching projects found for: ${projectFilter.join(', ')}`);
    process.exit(2);
  }
  return requestedProjects;
}

function isVerifyEntry(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.state === 'string';
}

function isVerifyEntryMap(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length > 0
    && Object.values(value).every(isVerifyEntry);
}

function printVerifyEntry(label, value) {
  console.log(`[${label}]`);
  if (value.brainId) console.log(`  Brain ID: ${value.brainId}`);
  console.log(`  Cloud state: ${formatVerifyState(value.state)}`);
  if (typeof value.count === 'number') {
    console.log(`  Remote files: ${value.count}`);
  }
  if (value.memory) {
    console.log(`  Memory freshness: ${formatMemoryVerifyState(value.memory.state)}`);
    if (value.memory.reason) console.log(`  Memory reason: ${value.memory.reason}`);
    if (value.memory.clockSkewStatus && value.memory.clockSkewStatus !== 'ok') {
      console.log(`  Memory clock skew: ${value.memory.clockSkewStatus}`);
    }
    if (Array.isArray(value.memory.retirementCandidates) && value.memory.retirementCandidates.length > 0) {
      for (const candidate of value.memory.retirementCandidates) {
        console.log(`  Retirement candidate: ${candidate.exactCommand}`);
      }
    }
  }
  if (value.error) {
    console.log(`  Error: ${value.error}`);
  }
  console.log('');
}

async function buildVerifyMemoryState(projectRoot, store) {
  if (!store || !projectRoot) return null;
  try {
    const assessment = await assessMemoryFreshness({ projectRoot, store });
    const state = assessment.clockSkewStatus === 'degraded' ? 'stale' : assessment.state;
    const reason = assessment.reason
      ?? (assessment.clockSkewStatus === 'degraded' ? 'publisher head clock skew exceeds 5m' : null);
    return {
      state,
      reason,
      headCount: assessment.headCount,
      clockSkewStatus: assessment.clockSkewStatus,
      retirementCandidates: assessment.retirementCandidates,
    };
  } catch (err) {
    return {
      state: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleVerify(args) {
  const jsonOutput = args.includes('--json');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const target = positional[0] === 'brain' || positional[0] === 'transcripts' ? positional[0] : null;
  const projectFilter = target ? positional.slice(1) : positional;

  const credentialState = await inspectCredentials();
  if (credentialState.state !== CREDS_STATE_OK) {
    console.error(formatCredentialsRecoveryMessage(credentialState));
    process.exit(2);
  }
  const creds = credentialState.creds;
  if (!isValidServerUrl(creds.serverUrl)) {
    console.error(`Invalid server URL in credentials: "${creds.serverUrl}"`);
    process.exit(2);
  }

  const result = {};
  let exitCode = 0;
  const projects = await getNetworkProjects();
  const hasNetworkProjects = !!(projects && projects.length > 0);
  const memoryStore = resolveVerifyMemoryStore();

  if (!target && projectFilter.length > 0) {
    console.error(
      `Ambiguous verify target: ${projectFilter.join(', ')}. ` +
      'Use `agentbootup daemon verify brain <project-id...>` or ' +
      '`agentbootup daemon verify transcripts <project-id...>`.'
    );
    process.exit(2);
  }

  if (target && projectFilter.length > 0 && !hasNetworkProjects) {
    console.error(
      `Project filters require a network config: ${projectFilter.join(', ')}. ` +
      `Use \`agentbootup daemon verify ${target}\` without project ids in single-brain mode.`
    );
    process.exit(2);
  }

  if (!target || target === 'transcripts') {
    if (hasNetworkProjects) {
      const requestedProjects = resolveVerifyProjects(projects, target === 'transcripts' ? projectFilter : []);
      const transcriptResults = {};
      for (const project of requestedProjects) {
        const info = await fetchTranscriptCloudState(creds.serverUrl, creds.apiKey, project.agent_id);
        transcriptResults[project.id] = { brainId: project.agent_id, ...info };
        exitCode = getVerifyEntryExitCode(info, exitCode);
      }
      if (target === 'transcripts') {
        Object.assign(result, transcriptResults);
      } else {
        result.transcripts = transcriptResults;
      }
    } else {
      const brainId = await getBrainId();
      if (!brainId) {
        result.transcripts = { state: 'error', error: 'No brain ID configured' };
        exitCode = 2;
      } else {
        const info = await fetchTranscriptCloudState(creds.serverUrl, creds.apiKey, brainId);
        result.transcripts = { brainId, ...info };
        exitCode = getVerifyEntryExitCode(info, exitCode);
      }
    }
  }

  if (!target || target === 'brain') {
    if (hasNetworkProjects) {
      const requestedProjects = resolveVerifyProjects(projects, target === 'brain' ? projectFilter : []);
      const brainResults = {};
      for (const project of requestedProjects) {
        const info = await fetchBrainCloudState(creds.serverUrl, creds.apiKey, project.agent_id);
        const entry = { brainId: project.agent_id, ...info };
        const memory = await buildVerifyMemoryState(project.path, memoryStore);
        if (memory) entry.memory = memory;
        brainResults[project.id] = entry;
        exitCode = getVerifyEntryExitCode(entry, exitCode);
      }
      if (target === 'brain') {
        Object.assign(result, brainResults);
      } else {
        result.brain = brainResults;
      }
    } else {
      const brainId = await getBrainId();
      if (!brainId) {
        result.brain = { state: 'error', error: 'No brain ID configured' };
        exitCode = 2;
      } else {
        const info = await fetchBrainCloudState(creds.serverUrl, creds.apiKey, brainId);
        const entry = { brainId, ...info };
        const memory = await buildVerifyMemoryState(process.cwd(), memoryStore);
        if (memory) entry.memory = memory;
        result.brain = entry;
        exitCode = getVerifyEntryExitCode(entry, exitCode);
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const [key, value] of Object.entries(result)) {
      if (isVerifyEntryMap(value)) {
        for (const entry of Object.values(value)) {
          const scopedLabel = key === 'transcripts' ? `Transcripts: ${entry.brainId}` : `Brain: ${entry.brainId}`;
          printVerifyEntry(scopedLabel, entry);
        }
        continue;
      }

      if (target === 'transcripts' && key !== 'transcripts' && isVerifyEntry(value)) {
        printVerifyEntry(`Transcripts: ${value.brainId}`, value);
        continue;
      }

      const label = key === 'transcripts' ? 'Transcripts' : key === 'brain' ? 'Brain' : `Brain: ${value.brainId}`;
      printVerifyEntry(label, value);
    }
  }

  if (exitCode !== 0) process.exit(exitCode);
}

// ── Restart ───────────────────────────────────────────────────────────────────

/**
 * Stop all services for the specified brain(s), then re-provision and start
 * them fresh with current env vars.
 *
 * Delegates entirely to handleStop + handleStart to stay in sync with their
 * logic without duplicating it.
 *
 * @param {string[]} args  Args after 'restart' (project IDs, --all, --yes, etc.)
 */
async function handleRestart(args) {
  const allFlag = args.includes('--all');
  const jsonOutput = args.includes('--json');
  const noTranscripts = args.includes('--no-transcripts');
  const noBrain = args.includes('--no-brain');
  const projectFilter = parseScopedProjectFilter(args);

  if (jsonOutput) {
    console.error('--json is not supported by daemon restart');
    process.exit(1);
  }

  // In multi-brain mode require --all or explicit project IDs (same guard as start/stop).
  const networkProjects = await getNetworkProjects();
  if (networkProjects && !allFlag && projectFilter.length === 0) {
    console.error('Multiple brains detected. Specify project IDs or use --all:');
    console.error('  agentbootup daemon restart <project-id...>');
    console.error('  agentbootup daemon restart --all');
    for (const p of networkProjects) console.error(`  ${p.id}`);
    process.exit(1);
  }

  console.log('Stopping services...');
  const stopArgs = [];
  if (allFlag) stopArgs.push('--all');
  stopArgs.push(...projectFilter);
  if (noTranscripts) stopArgs.push('--no-transcripts');
  if (noBrain) stopArgs.push('--no-brain');
  // Pass --yes to skip any interactive prompts inside handleStop.
  const stopTargets = await collectStopTargets([...stopArgs, '--yes']);
  const forceRestartNames = new Set(stopTargets.map((target) => target.name));
  await handleStop([...stopArgs, '--yes'], {
    continueOnVerificationFailure: true,
    targets: stopTargets,
  });

  // Poll transcript-sync until it stops (up to 5 s, 200 ms intervals). Once the
  // shared transcript-sync daemon exits, poll inbox state files for each target
  // brain until they all report offline/dead (see second loop below), so that
  // inbox port binds are released before the new start attempt.
  if (forceRestartNames.has(TRANSCRIPTS_NAME)) {
    const restartGrace = Date.now() + 5000;
    while (Date.now() < restartGrace) {
      await sleep(200);
      try {
        const info = await agentStatus(TRANSCRIPTS_NAME);
        if (info.state !== 'running' && info.state !== 'online') break;
      } catch { break; } // agent not registered = fully stopped
    }
  }
  // Extra pass: poll inbox state files for each target brain until they all
  // report offline/dead (or timeout). This avoids a fixed sleep while ensuring
  // inbox daemon ports are released before the new start attempt.
  // Match on either p.id (slug) or p.agent_id (full id with dots) so that
  // passing e.g. 'bootup.gm' works the same as 'bootup'. Consistent with
  // the filter in handleReconcile.
  const restartTargetSet = new Set(projectFilter);
  const restartTargets = networkProjects
    ? (allFlag
        ? networkProjects
        : networkProjects.filter((p) => restartTargetSet.has(p.id) || restartTargetSet.has(p.agent_id)))
    : [];
  // Poll inbox state files: only 'online' means still running. 'offline', 'dead
  // (stale state file)', or missing state file all indicate the process has exited.
  const inboxGrace = Date.now() + 3000;
  while (restartTargets.length > 0 && Date.now() < inboxGrace) {
    await sleep(150);
    const stillRunning = restartTargets.some((p) => {
      const s = readInboxDaemonState(p.agent_id);
      return s.state === 'online';
    });
    if (!stillRunning) break;
  }

  console.log('Starting services...');
  await handleStart([...args, '--yes'], { forceRestartNames });

  console.log('Restart complete.');
}

// ── Reconcile ─────────────────────────────────────────────────────────────────

/**
 * Compare expected services vs running state for a single brain.
 *
 * Returns a diff object with three categories:
 *   - missing: expected but not running
 *   - running: expected and confirmed healthy
 *   - drifted: inbox is running but on a different port than portRegistry says
 *
 * Does NOT start, stop, or modify any services — pure read/compare.
 *
 * @param {string} brainId
 * @returns {Promise<{
 *   missing: Array<Object>,
 *   running: Array<Object>,
 *   drifted: Array<Object & { actualPort: number }>,
 * }>}
 */
async function computeReconcileDiff(brainId) {
  const expected = await getExpectedServices(brainId, { includeUnprovisionedInbox: true });
  const missing = [];
  const running = [];
  const drifted = [];

  for (const svc of expected) {
    if (svc.type === 'inbox') {
      // Use the shared readInboxDaemonState helper to check PID liveness and
      // read the port the process actually bound to.
      // svc.brainId is set by getExpectedServices; fall back to the outer brainId
      // parameter for callers that haven't yet adopted svc.brainId.
      const inboxState = readInboxDaemonState(svc.brainId ?? brainId);

      if (inboxState.state === 'online') {
        const actualPort = inboxState.port ?? null;
        if (actualPort === null) {
          // State file written before port was assigned (partial write) — indeterminate.
          // Do NOT treat as missing: the process is alive (state === 'online') and
          // starting a second instance would conflict. Skip this service; the next
          // reconcile pass will re-evaluate once the port is filled in.
          // Log a warning so operators can detect a daemon stuck in this state
          // (e.g., crashed after writing the state file but before writing the port).
          console.warn(`  [reconcile] ${svc.brainId ?? brainId} inbox: partial state file (online, port missing) — skipping, will retry next reconcile`);
        } else if (actualPort !== svc.port) {
          // Process is alive but on a different port than portRegistry expects.
          drifted.push({ ...svc, actualPort });
        } else {
          running.push(svc);
        }
      } else {
        // 'offline' or 'dead (stale state file)' both count as missing.
        missing.push(svc);
      }
    } else if (svc.type === 'brain-asset-sync') {
      try {
        const info = await agentStatus(svc.name);
        const isRunning = info.state === 'running' || info.state === 'online';
        if (isRunning) {
          running.push(svc);
        } else {
          missing.push(svc);
        }
      } catch {
        missing.push(svc);
      }
    }
  }

  return { missing, running, drifted };
}

/**
 * `agentbootup daemon reconcile [brain...|--all] [--dry-run]`
 *
 * Compares expected services against running ones:
 *   - Starts missing services (unless --dry-run)
 *   - Logs drifted inbox ports and re-patches mech-plane (unless --dry-run)
 *   - Orphan detection (running services not in expected) is Phase 2 / --prune flag
 *
 * @param {string[]} args  Args after 'reconcile'.
 */
async function handleReconcile(args) {
  const dryRun = args.includes('--dry-run');
  const allFlag = args.includes('--all');
  const FLAGS = new Set(['--all', '--dry-run', '--yes']);
  const projectFilter = args.filter((a) => !FLAGS.has(a));

  const projects = await getNetworkProjects();
  if (!projects) {
    console.log('No network config found — reconcile requires a network config.');
    return;
  }

  const onMachine = projects.filter((p) => p.path && fs.existsSync(p.path));

  // Filter to requested brains.
  let targets = onMachine;
  if (!allFlag && projectFilter.length > 0) {
    const filterSet = new Set(projectFilter);
    targets = onMachine.filter(
      (p) => filterSet.has(p.id) || filterSet.has(p.agent_id),
    );
    if (targets.length === 0) {
      console.error(`No matching brains found for: ${projectFilter.join(', ')}`);
      process.exit(1);
    }
  } else if (!allFlag && projectFilter.length === 0) {
    console.error('Specify brain IDs or use --all:');
    console.error('  agentbootup daemon reconcile <brain...>');
    console.error('  agentbootup daemon reconcile --all');
    process.exit(1);
  }

  // Load credentials for mech-plane re-registration — non-fatal if unavailable.
  let creds = null;
  try {
    const result = await validateCredentials({ skipBrainIdCheck: true });
    creds = result.creds;
  } catch {
    // Credentials unavailable — drifted port re-registration will be skipped.
  }

  let totalMissing = 0;
  let totalDrifted = 0;

  // Hoist registry lookups outside the per-brain loop to avoid redundant per-brain calls.
  const brainEntriesForReconcile = await getBrainAgentEntries();
  const inboxEntriesForReconcile = new Map();
  for (const target of targets) {
    const entry = await getInboxAgentEntry(target.id, {
      mechPlaneUrl: creds?.serverUrl ?? null,
      apiKey: creds?.apiKey ?? null,
      allocate: false,
      persistExistingProvisionedEnrollment: false,
    });
    if (entry) {
      inboxEntriesForReconcile.set(target.id, entry);
    }
  }

  for (const p of targets) {
    const diff = await computeReconcileDiff(p.agent_id);
    if (!dryRun) {
      await getInboxAgentEntry(p.id, {
        mechPlaneUrl: creds?.serverUrl ?? null,
        apiKey: creds?.apiKey ?? null,
        allocate: false,
        persistExistingProvisionedEnrollment: true,
      });
    }
    console.log(`\nBrain: ${p.agent_id}`);

    for (const svc of diff.running) {
      const portStr = svc.port ? ` (port ${svc.port})` : '';
      console.log(`  ${svc.type}${portStr}`.padEnd(35) + '\u2713 running');
    }

    for (const svc of diff.drifted) {
      totalDrifted++;
      const action = dryRun ? '[dry-run] would re-register' : 're-registering';
      console.log(
        `  ${svc.type} (port ${svc.port})`.padEnd(35) +
          `\u26a0 drifted (running on ${svc.actualPort}) \u2192 ${action}`,
      );
      if (!dryRun) {
        // Drift is already confirmed — update portRegistry and re-register with
        // mech-plane via the shared helper (enforces portRegistryUpdated invariant:
        // mech-plane is only patched if the local config write succeeds).
        // updatePortAndReRegister swallows all internal errors; no outer try/catch needed.
        await updatePortAndReRegister(svc.brainId, svc.actualPort, {
          mechPlaneUrl: creds?.serverUrl ?? null,
          apiKey: creds?.apiKey ?? null,
          verbose: false,
        });
      }
    }

    for (const svc of diff.missing) {
      totalMissing++;
      const action = dryRun ? '[dry-run] would start' : 'starting';
      console.log(`  ${svc.type}`.padEnd(35) + `\u2717 missing \u2192 ${action}`);

      if (!dryRun) {
        try {
          if (svc.type === 'brain-asset-sync') {
            const entry = brainEntriesForReconcile.find((e) => e.key === svc.projectId);
            if (entry) {
              await agentStart({
                name: entry.name,
                script: BRAIN_SCRIPT,
                interpreter: BUN_INTERPRETER,
                env: entry.env || {},
              });
              console.log('    \u2192 started');
            } else {
              console.error('    \u2192 could not find entry in registry');
            }
          } else if (svc.type === 'inbox') {
            // Use the pre-hoisted inboxEntriesForReconcile (allocate:false — port is already
            // provisioned in portRegistry; don't re-allocate and overwrite mech-plane registration).
            // If a legacy provisioned brain is missing its first inbox bootstrap, there may be no
            // pre-existing port/secret yet — fall back to the write-capable registry path once so
            // reconcile can enroll it instead of leaving it dark forever.
            let entry = inboxEntriesForReconcile.get(svc.projectId);
            if (!entry) {
              entry = await getInboxAgentEntry(svc.projectId, {
                mechPlaneUrl: creds?.serverUrl ?? null,
                apiKey: creds?.apiKey ?? null,
                allocate: true,
              });
            } else {
              entry = await getInboxAgentEntry(svc.projectId, {
                mechPlaneUrl: creds?.serverUrl ?? null,
                apiKey: creds?.apiKey ?? null,
                allocate: false,
                persistExistingProvisionedEnrollment: true,
              });
            }
            if (entry) {
              await agentStart({
                name: entry.name,
                script: INBOX_DAEMON_SCRIPT,
                interpreter: BUN_INTERPRETER,
                env: entry.env || {},
              });
              console.log('    \u2192 started');
            } else {
              console.error('    \u2192 could not find entry in registry');
            }
          }
        } catch (err) {
          console.error(`    \u2192 failed to start: ${err.message}`);
        }
      }
    }
  }

  if (dryRun) {
    console.log(
      `\n[dry-run] Would start ${totalMissing} missing, re-register ${totalDrifted} drifted`,
    );
  } else {
    console.log(
      `\nReconcile complete. Started ${totalMissing} missing, re-registered ${totalDrifted} drifted.`,
    );
  }
}

/**
 * `agentbootup daemon health [--json]`
 *
 * Fleet-wide health sweep: shows which services are up/down across all brains
 * on this machine. For each brain, checks brain-asset-sync via agentStatus and
 * inbox via HTTP /health. Transcript-sync is shared and counted once overall.
 *
 * Note: `daemon status` uses PID liveness (process.kill(pid, 0) + state file) while
 * `daemon health` uses HTTP GET /health on the registered port. These signals can
 * diverge — e.g. a daemon alive but on the wrong port will show status:online but
 * health:✗. HTTP is the authoritative signal for health since it reflects the port
 * that external traffic (mech-plane webhooks) actually reaches. Use `--json` for
 * machine-readable output; terminal symbols (✓/✗) are not stable across locales.
 */
async function handleHealth(args) {
  const jsonOutput = args.includes('--json');
  const projects = await getNetworkProjects();
  if (!projects) {
    console.log('No network config found — single-brain mode has no fleet health view.');
    return;
  }

  const onMachine = projects.filter((p) => p.path && fs.existsSync(p.path));

  const results = [];
  let totalServices = 0;
  let healthyCount = 0;

  // Check transcript-sync (shared daemon).
  let transcriptsLive = false;
  let transcriptBackup = {
    healthy: false,
    state: 'error',
    reasons: ['daemon_not_running'],
    authority: 'legacy_unverified',
  };
  try {
    const info = await agentStatus(TRANSCRIPTS_NAME);
    transcriptsLive = info.state === 'running' || info.state === 'online';
  } catch { /* not running */ }
  if (transcriptsLive) {
    try {
      if (!_fetch) throw new Error('fetch not available');
      const resp = await _fetch(`http://127.0.0.1:${TRANSCRIPTS_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      const payload = resp.ok ? await resp.json() : null;
      if (payload?.backup && typeof payload.backup.healthy === 'boolean') {
        transcriptBackup = payload.backup;
      } else {
        transcriptBackup = {
          healthy: false,
          state: 'error',
          reasons: ['invalid_backup_health_response'],
          authority: 'legacy_unverified',
        };
      }
    } catch {
      transcriptBackup = {
        healthy: false,
        state: 'error',
        reasons: ['backup_health_unreachable'],
        authority: 'legacy_unverified',
      };
    }
  }
  const transcriptsHealthy = transcriptsLive && transcriptBackup.healthy === true;

  for (const p of onMachine) {
    const services = await getExpectedServices(p.agent_id);
    const brainResult = { brainId: p.agent_id, services: [] };

    for (const svc of services) {
      totalServices++;
      let healthy = false;
      let detail = '';

      if (svc.type === 'inbox') {
        try {
          if (!_fetch) throw new Error('fetch not available');
          const resp = await _fetch(`http://127.0.0.1:${svc.port}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          if (resp.ok) {
            healthy = true;
            detail = `:${svc.port}`;
          } else {
            detail = `:${svc.port} (HTTP ${resp.status})`;
          }
        } catch (err) {
          // Distinguish environment error (fetch unavailable) from connectivity error.
          detail = err.message === 'fetch not available'
            ? `:${svc.port} (fetch unavailable — Bun required)`
            : `:${svc.port} (no response)`;
        }
      } else if (svc.type === 'brain-asset-sync') {
        try {
          const info = await agentStatus(svc.name);
          healthy = info.state === 'running' || info.state === 'online';
          const syncHealth = healthy && Number.isSafeInteger(info.pid) && info.pid > 0
            ? readLivePersistedBrainSyncHealth(p.agent_id, info.pid)
            : null;
          const replayHealth = syncHealth?.memoryReplay;
          const converge = syncHealth?.memoryConverge;
          if (replayHealth?.invalid || replayHealth?.degraded > 0) {
            healthy = false;
            detail = replayHealth.invalid
              ? '(memory replay queue invalid)'
              : `(memory replay degraded, ${replayHealth.degraded} item(s))`;
          } else if (healthy && !hasCompleteConvergeHealth(converge)) {
            healthy = false;
            detail = `(memory converge health unknown/incomplete: ` +
              `effective=${convergeBooleanLabel(converge?.enabled, 'on', 'off')} ` +
              `gate=${convergeBooleanLabel(converge?.gateOpen, 'open', 'closed')})`;
          } else if (converge && !isConvergeHealthSafe(converge)) {
            healthy = false;
            detail = `(memory ${converge.state}${converge.escalated ? ', ESCALATED' : ''}: ` +
              `effective=${convergeBooleanLabel(converge.enabled, 'on', 'off')} ` +
              `gate=${convergeBooleanLabel(converge.gateOpen, 'open', 'closed')}; ` +
              `${converge.detail || 'see daemon log'})`;
          } else if (syncHealth?.quarantinedIdentity) {
            healthy = false;
            detail = `(quarantined_identity: brain not registered — run: agentbootup brain register ${p.agent_id})`;
          } else if (syncHealth?.degraded) {
            healthy = false;
            detail = `(degraded, ${syncHealth.consecutiveFailedCycles} fails)`;
          } else if (replayHealth?.pending > 0) {
            detail = `(memory replay pending, ${replayHealth.pending} item(s))`;
          } else {
            detail = healthy ? '' : `(${info.state})`;
          }
          svc.syncHealth = syncHealth;
        } catch {
          detail = '(error)';
        }
      }

      if (healthy) healthyCount++;
      brainResult.services.push({ ...svc, healthy, detail });
    }

    // Transcript-sync is shared — track per-brain for display but count once overall.
    brainResult.transcriptsHealthy = transcriptsHealthy;
    brainResult.transcriptsLiveness = { healthy: transcriptsLive };
    brainResult.transcriptBackup = transcriptBackup;
    results.push(brainResult);
  }

  // Count transcript-sync once in the total — only if there are brains on this machine
  // (avoids "0 brains, 1 services" display on machines with no checked-out projects).
  if (onMachine.length > 0) {
    totalServices++;
    if (transcriptsHealthy) healthyCount++;
  }

  if (jsonOutput) {
    console.log(stringifyJsonEnvelope({
      machine: os.hostname(),
      brains: results,
      summary: {
        total: totalServices,
        healthy: healthyCount,
        unhealthy: totalServices - healthyCount,
      },
      transcripts: {
        liveness: { healthy: transcriptsLive },
        backup: transcriptBackup,
      },
    }, 2));
    return;
  }

  // Text output.
  const hostname = os.hostname();
  console.log(`\nFleet Health — ${hostname} — ${onMachine.length} brains, ${totalServices} services\n`);

  const col = (s, w) => String(s).padEnd(w);
  console.log(`  ${col('Brain', 20)} ${col('inbox', 14)} ${col('brain-sync', 12)} transcript backup`);
  console.log(`  ${'-'.repeat(60)}`);

  for (const r of results) {
    const inboxSvc = r.services.find((s) => s.type === 'inbox');
    const brainSvc = r.services.find((s) => s.type === 'brain-asset-sync');
    // Pad the text portion separately so ✓/✗ symbols (variable terminal width) don't
    // misalign columns. Symbol is prepended after padding.
    const inboxText = inboxSvc ? inboxSvc.detail : '—';
    const inboxMark = inboxSvc ? (inboxSvc.healthy ? '✓' : '✗') : ' ';
    const brainText = brainSvc ? (brainSvc.healthy ? '' : brainSvc.detail) : '—';
    const brainMark = brainSvc ? (brainSvc.healthy ? '✓' : '✗') : ' ';
    const transcriptMark = r.transcriptsHealthy ? '✓' : '✗';
    const transcriptDetail = `${r.transcriptBackup.state}; process ${r.transcriptsLiveness.healthy ? 'live' : 'down'}`;
    console.log(`  ${col(r.brainId, 20)} ${inboxMark} ${col(inboxText, 12)} ${brainMark} ${col(brainText, 10)} ${transcriptMark} (${transcriptDetail})`);
  }

  const missing = totalServices - healthyCount;
  console.log(`\nSummary: ${healthyCount}/${totalServices} healthy${missing > 0 ? `, ${missing} unhealthy` : ''}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Dispatch `agentbootup daemon <sub>` to the appropriate handler.
 * @param {string[]} argv  Full argv (argv[0] === 'daemon').
 */
export async function runDaemonCommand(argv) {
  const sub = argv[1];

  if (sub === 'start') return handleStart(argv.slice(2));
  if (sub === 'stop') return handleStop(argv.slice(2));
  if (sub === 'restart') return handleRestart(argv.slice(2));
  if (sub === 'status') return handleStatus(argv.slice(2));
  if (sub === 'logs') return handleLogs(argv.slice(2));
  if (sub === 'verify') return handleVerify(argv.slice(2));
  if (sub === 'reconcile') return handleReconcile(argv.slice(2));
  if (sub === 'health') return handleHealth(argv.slice(2));

  console.error(
    'Usage: agentbootup daemon <start [project...|--all] [--yes] [--json] [--no-transcripts] [--no-brain] [--no-brain-db] [--no-index-transcripts] [--no-inbox] [--no-narrative] [--skills-mode=static|mech-storage]|stop [project...|--all] [--no-transcripts] [--no-brain]|restart [project...|--all] [--yes]|status [--json]|logs [transcripts|brain|brain-db] [--lines N]|verify [transcripts|brain] [project...|--json]|reconcile [project...|--all] [--dry-run]|health [--json]>'
  );
  console.error('Note: in multi-brain mode, `daemon start <project-id>` also starts scoped transcript sync unless --no-transcripts is passed.');
  process.exit(1);
}
