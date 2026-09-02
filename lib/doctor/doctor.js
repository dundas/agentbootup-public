/**
 * agentbootup doctor
 *
 * Runs a health audit and returns a structured list of issues. Each issue has:
 *   severity: 'error' | 'warning' | 'info'
 *   message: string
 *
 * Checks performed:
 *   1. Credentials file present and parseable
 *   2. brainId configured in config.json
 *   3. Server URL reachable (HEAD /, 3 s timeout)
 *   4. Daemon running (agentStatus from @derivativelabs/agent-process)
 *   5. sync-state.json readable and valid JSON
 *   6. Config _version field present (detects pre-migration installs)
 *   7. CLI native roots discoverable (lists which of claude/codex/gemini/cursor exist)
 *   8. Transcript archive present (warns if pull has never run)
 */

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { readConfig, getBrainId } from '../config/config.js';
import { readSyncState, getStateFilePath } from '../sync-state/sync-state.js';
import { isPlausibleServerUrl, isValidServerUrl } from '../auth/validate.js';
import { agentStatus } from '@derivativelabs/agent-process';
import { getCurrentRuntimeInfo, formatHandoffSupportMessage } from '../runtime-info.js';
import { runBranchModeDoctor } from './branch-mode.js';
import { checkBundleTargetIntegrity } from './runtime-check.js';
import { buildLiveDoctorReport, statusToExitCode } from './doctor-report.js';
import { extractCwd } from '../network/args.js';
import { getAgentId as getProjectAgentId } from '../project-config.js';
import { inspectAgentbootupInstalls, inventoryToDoctorIssues } from './install-inventory.js';
import { checkIdentityTrackingPolicy } from './identity-policy-check.js';
import { checkTranscriptRedactionDisabled } from './redaction-check.js';
import { discoverMemoryTransportSelectors } from './memory-transport-receipt.js';

function getCliNativeRoots() {
  return {
    claude: process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE ?? path.join(os.homedir(), '.claude', 'projects'),
    codex:  process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX  ?? path.join(os.homedir(), '.codex', 'sessions'),
    gemini: process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI ?? path.join(os.homedir(), '.gemini', 'tmp'),
    cursor: process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR ?? path.join(os.homedir(), '.cursor', 'projects'),
  };
}

const DEFAULT_ARCHIVE_DIR = path.join(os.homedir(), '.agentbootup', 'transcripts');
const CURRENT_RUNTIME = getCurrentRuntimeInfo(import.meta.url);

export { checkTranscriptRedactionDisabled } from './redaction-check.js';

/**
 * @returns {Promise<Array<{ severity: 'error'|'warning'|'info', message: string, category?: string }>>}
 */
export async function runDoctor(options = {}) {
  if (options.branchMode) {
    return runBranchModeDoctor(options);
  }

  const issues = [];
  const redactionDisabledIssue = checkTranscriptRedactionDisabled(options.env || process.env);
  if (redactionDisabledIssue) issues.push(redactionDisabledIssue);

  // 1. Credentials
  let creds = null;
  try {
    const credentialState = await inspectCredentials();
    if (credentialState.state !== CREDS_STATE_OK) {
      issues.push({
        severity: 'error',
        message: formatCredentialsRecoveryMessage(credentialState, { includeErrorDetail: true }),
      });
    } else {
      creds = credentialState.creds;
    }
    if (creds && !isValidServerUrl(creds.serverUrl)) {
      issues.push({ severity: 'error', message: `Invalid serverUrl in credentials: "${creds.serverUrl}"` });
    } else if (creds && !isPlausibleServerUrl(creds.serverUrl)) {
      issues.push({
        severity: 'error',
        message: `Server URL has port 0 or is not a valid target: "${creds.serverUrl}". Re-run: agentbootup auth login --server-url <url>`,
      });
    }
  } catch (err) {
    issues.push({ severity: 'error', message: `Failed to read credentials: ${err.message}` });
  }

  issues.push({
    severity: 'info',
    message: `Current agentbootup runtime: ${CURRENT_RUNTIME.source} (${CURRENT_RUNTIME.root})`,
  });
  issues.push({
    severity: 'info',
    message: formatHandoffSupportMessage(CURRENT_RUNTIME),
  });

  // 2. brainId
  let config = {};
  try {
    config = await readConfig();
    if (!config.brainId) {
      issues.push({ severity: 'error', message: 'No brain ID configured. Run: agentbootup config set-brain <id>' });
    }
  } catch (err) {
    issues.push({ severity: 'warning', message: `Failed to read config: ${err.message}` });
  }

  // 3. Config version field
  try {
    const raw = await fsp.readFile(
      process.env.AGENTBOOTUP_CONFIG_FILE ?? path.join(os.homedir(), '.agentbootup', 'config.json'),
      'utf-8',
    ).catch(() => null);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed._version) {
        issues.push({ severity: 'info', message: 'config.json has no _version field — will be upgraded on next write.' });
      }
    }
  } catch {
    // Parse error already caught above
  }

  // 4. Server reachability — test actual connectivity. Unreachable = error so doctor
  // does not report "all green" when credentials point at localhost:0 or a down server.
  // 5xx = server broken (warning); 4xx/3xx = reachable.
  if (creds?.serverUrl && isPlausibleServerUrl(creds.serverUrl)) {
    try {
      const resp = await fetch(creds.serverUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.status >= 500) {
        issues.push({ severity: 'warning', message: `Server returned ${resp.status} — may be misconfigured: ${creds.serverUrl}` });
      }
    } catch (err) {
      issues.push({
        severity: 'error',
        message: `Server unreachable at ${creds.serverUrl}. Check URL and network: ${err.message}`,
      });
    }
  }

  // 5. Transcript daemon running — degrade gracefully if agentStatus unavailable
  try {
    const status = await agentStatus('agentbootup-transcripts');
    if (status.state !== 'online') {
      issues.push({ severity: 'info', message: 'Sync daemon is not running. Start with: agentbootup daemon start' });
    }
  } catch {
    issues.push({ severity: 'info', message: 'Sync daemon is not running. Start with: agentbootup daemon start' });
  }

  // 6. sync-state.json
  try {
    const stateFile = getStateFilePath();
    const raw = await fsp.readFile(stateFile, 'utf-8').catch(() => null);
    if (!raw) {
      issues.push({ severity: 'info', message: 'sync-state.json does not exist yet — will be created on first sync.' });
    } else {
      const parsed = JSON.parse(raw);
      if (!parsed.version) {
        issues.push({ severity: 'info', message: 'sync-state.json has no version field — will be upgraded on next sync.' });
      }
    }
  } catch (err) {
    issues.push({ severity: 'warning', message: `sync-state.json is unreadable or invalid: ${err.message}` });
  }

  // 7. CLI native roots
  const foundClis = [];
  const missingClis = [];
  for (const [cli, root] of Object.entries(getCliNativeRoots())) {
    const exists = await fsp.access(root).then(() => true).catch(() => false);
    if (exists) foundClis.push(cli);
    else missingClis.push(cli);
  }
  if (foundClis.length === 0) {
    issues.push({ severity: 'warning', message: 'No AI CLI native directories found. Install Claude, Cursor, Gemini, or Codex first.' });
  } else {
    issues.push({ severity: 'info', message: `CLI roots found: ${foundClis.join(', ')}` });
    if (missingClis.length > 0) {
      issues.push({ severity: 'info', message: `CLI roots not found (not installed?): ${missingClis.join(', ')}` });
    }
  }

  // 8. Transcript archive
  const archiveDir = process.env.AGENTBOOTUP_TRANSCRIPTS_DIR ?? DEFAULT_ARCHIVE_DIR;
  const archiveExists = await fsp.access(archiveDir).then(() => true).catch(() => false);
  if (!archiveExists) {
    issues.push({ severity: 'info', message: `Transcript archive not found at ${archiveDir}. Run: agentbootup transcripts restore` });
  }

  // 9. Brain asset daemon running (only warn if a brain ID is configured).
  // If agentStatus throws, assume running to avoid false-positive warnings.
  try {
    const brainId = await getBrainId();
    if (brainId) {
      let daemonRunning = true; // optimistic default: don't warn if agentStatus is unavailable
      try {
        const status = await agentStatus('agentbootup-brain');
        daemonRunning = status.state === 'online';
      } catch {
        // agentStatus unavailable — leave daemonRunning = true (no false-positive warning)
      }
      if (!daemonRunning) {
        issues.push({
          severity: 'warning',
          message: 'Brain asset daemon not running — changes won\'t sync to server. Run: agentbootup daemon start --yes',
        });
      }
    }
  } catch {
    // Non-fatal: skip brain daemon check on unexpected error
  }

  // 10. Bundle target integrity — the install ledger records intent, not state;
  // verify required bundle targets (runtime payload especially) still exist on disk.
  // Scans the cwd's canonical installed skill and protocol bundle manifests; run
  // doctor from the repo root.
  try {
    issues.push(...checkBundleTargetIntegrity(process.cwd()));
  } catch (err) {
    issues.push({ severity: 'warning', message: `Bundle target integrity check failed: ${err.message}` });
  }

  // 11. Multi-install inventory. This is detection-only: the inventory module has no
  // process-signal dependency and returns an exact operator command for each stray.
  try {
    const inspectInventory = options.inspectInstallInventory ?? inspectAgentbootupInstalls;
    const inventory = await inspectInventory({
      currentRoot: CURRENT_RUNTIME.root,
      ...(options.installInventoryDeps ?? {}),
    });
    issues.push(...inventoryToDoctorIssues(inventory));
  } catch (err) {
    issues.push({
      severity: 'warning',
      category: 'multi-install',
      message: `agentbootup install/process inventory failed: ${err.message}`,
    });
  }

  // 12. Identity-tracking policy (advisory). Surfaces drift from the canonical model
  // (agentbootup.json = tracked identity; brain/config.json = gitignored runtime-local) as a
  // WARNING, never an error — enforcement is deferred until the secrets transport contract is
  // live-verified. See docs/BRAIN_IDENTITY_POLICY.md + lib/doctor/identity-policy-check.js.
  try {
    issues.push(...checkIdentityTrackingPolicy({ projectRoot: process.cwd() }));
  } catch (err) {
    issues.push({ severity: 'warning', category: 'identity-policy', message: `identity-policy check failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  return issues;
}

/**
 * CLI entry point for `agentbootup doctor [--json]`.
 * @param {string[]} args
 * @param {{ log?: (line: string) => void }} [io]
 * @param {{ branchMode?: boolean, brainId?: string, branchId?: string, env?: Record<string, string>, fetchBranchRecord?: Function }} [options]
 * @returns {Promise<number>}
 */
export async function handleDoctor(args = [], io = console, options = {}) {
  const asJson = args.includes('--json');
  const branchMode = args.includes('--branch-mode');

  // Active health record (PRD-0039 FR-1): the four fail-closed checks → §4 record. Additive
  // and opt-in via `--health` so the default `doctor` remains the passive local audit (FR-2.5).
  if (args.includes('--health')) {
    return handleHealthReport(args, io, options);
  }

  const brainId = readFlagValue(args, '--brain');
  const branchId = readFlagValue(args, '--branch');
  const doctorRunner = options.doctorRunner ?? runDoctor;
  const issues = await doctorRunner({
    ...options,
    branchMode,
    brainId,
    branchId,
  });
  if (args.includes('--discover')) {
    const { cwd } = extractCwd(args);
    const discovery = await discoverMemoryTransportSelectors({ cwd, readFile: options.readFile ?? fsp.readFile });
    if (!discovery.available) {
      issues.push({ severity: 'info', category: 'memory-transport', message: 'No memory transport receipt is available for discovery.' });
    } else if (discovery.selectors.length === 0) {
      issues.push({ severity: 'info', category: 'memory-transport', message: 'No proposed memory transport selectors.' });
    } else {
      issues.push({ severity: 'info', category: 'memory-transport', message: `Proposed memory transport selectors: ${discovery.selectors.join(', ')}` });
    }
  }
  const exitCode = issues.some((i) => i.severity === 'error') ? 1 : 0;

  if (asJson) {
    io.log(JSON.stringify({ issues }, null, 2));
    process.exitCode = exitCode;
    return exitCode;
  }

  if (issues.length === 0) {
    io.log('No issues detected.');
    process.exitCode = 0;
    return 0;
  }

  for (const issue of issues) {
    const prefix = issue.severity === 'error' ? 'ERROR' : issue.severity.toUpperCase();
    const category = issue.category ? ` [${issue.category}]` : '';
    io.log(`${prefix}${category}: ${issue.message}`);
  }
  if (!branchMode && issues.length > 0) {
    io.log('To confirm sync data is in the cloud: agentbootup daemon verify');
  }

  process.exitCode = exitCode;
  return exitCode;
}

/**
 * `agentbootup doctor --health [--json]` — run the four active checks and emit the §4 health
 * record (PRD-0039 FR-1/FR-4). Exit code: 0 when healthy, non-zero when degraded/stuck, so the
 * command is usable as a scripted gate. `--json` prints the full record regardless of status.
 *
 * CLI-ONLY: like `handleDoctor`, this mutates `process.exitCode` and is the intended terminal
 * caller. Non-CLI consumers (the host `GET /v1/doctor` endpoint in Task 3.0, the reporter in
 * Task 4.0) MUST call the pure `buildDoctorReport` directly rather than this handler, so they
 * never inherit the process-exit side effect.
 *
 * `--json` has TWO shapes, discriminated by `status`:
 *   - success: the full §4 record `{ agent_id, machine_id, environment, ts, status, checks, reason }`
 *     where `status` ∈ {healthy, degraded, stuck};
 *   - error:   `{ status: 'error', error: <message> }` with NO `checks`/identity keys (the record
 *     could not be built, e.g. no brain configured).
 * A consumer should branch on `status === 'error'` before reading `checks`.
 * @param {string[]} args
 * @param {{ log?: (line: string) => void }} io
 * @param {{ runners?: object, environment?: string, ts?: string, buildReport?: Function }} options
 * @returns {Promise<number>}
 */
export async function handleHealthReport(args = [], io = console, options = {}) {
  const extracted = extractCwd(args);
  const scopedArgs = extracted.args;
  const asJson = scopedArgs.includes('--json');
  const build = options.buildReport ?? buildLiveDoctorReport;
  // `ts` is injectable for deterministic tests; the live CLI stamps production time.
  const ts = options.ts ?? new Date().toISOString();
  let localProjectAgentId;
  try {
    localProjectAgentId = getProjectAgentId(extracted.cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) io.log(JSON.stringify({ status: 'error', error: message }, null, 2));
    else io.log(`ERROR: ${message}`);
    process.exitCode = 1;
    return 1;
  }
  const requestedAgentId = readFlagValue(scopedArgs, '--agent');
  const legacyBrainId = readFlagValue(scopedArgs, '--brain');
  if (requestedAgentId && legacyBrainId && requestedAgentId !== legacyBrainId) {
    const message = `--agent ${requestedAgentId} conflicts with --brain ${legacyBrainId}`;
    if (asJson) io.log(JSON.stringify({ status: 'error', error: message }, null, 2));
    else io.log(`ERROR: ${message}`);
    process.exitCode = 1;
    return 1;
  }
  // --agent is the explicit Phase A spelling. Keep --brain as a compatible
  // alias, while selecting the committed local project identity by default.
  // runners/buildReport are intentionally test injection points; production
  // callers use the local declaration unless they provide an explicit target.
  const agentIdOverride = requestedAgentId || legacyBrainId || options.agentId ||
    (!options.runners && !options.buildReport ? localProjectAgentId : null);

  let record;
  try {
    if (agentIdOverride && !options.runners && !options.buildReport && localProjectAgentId && localProjectAgentId !== agentIdOverride) {
      throw new Error(
        `--brain ${agentIdOverride} does not match the selected project agent ${localProjectAgentId}; ` +
        'live health checks must run against the project that owns the local identity material',
      );
    }
    record = await build({
      ts,
      runners: options.runners,
      environment: options.environment,
      cwd: extracted.cwd,
      ...(agentIdOverride ? { agentId: agentIdOverride } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) {
      // Include `status: 'error'` so a JSON consumer keying on `.status` sees a recognizable
      // terminal state on the error path (the success path always carries a status).
      io.log(JSON.stringify({ status: 'error', error: message }, null, 2));
    } else {
      io.log(`ERROR: ${message}`);
    }
    process.exitCode = 1;
    return 1;
  }

  const exitCode = statusToExitCode(record.status);

  if (asJson) {
    io.log(JSON.stringify(record, null, 2));
    process.exitCode = exitCode;
    return exitCode;
  }

  io.log(`health: ${record.status.toUpperCase()}${record.reason ? ` — ${record.reason}` : ''}`);
  io.log(`  agent: ${record.agent_id}  machine: ${record.machine_id}${record.environment ? `  env: ${record.environment}` : ''}`);
  for (const [name, check] of Object.entries(record.checks)) {
    const state = (check?.state ?? 'unknown').toUpperCase();
    io.log(`  ${state.padEnd(7)} ${name}${check?.message ? ` — ${check.message}` : ''}`);
  }
  // When EVERY check is unknown, nothing is wired on this host yet (the state until the
  // reporter wires live runners). Say so, so an operator does not read `DEGRADED` as a real
  // degradation — a false-degraded signal would be the same class of problem this PRD removes.
  const checkValues = Object.values(record.checks);
  if (checkValues.length > 0 && checkValues.every((c) => c?.state === 'unknown')) {
    io.log('  note: no health checks are wired on this host yet — DEGRADED here means "cannot prove", not "broken".');
  }
  process.exitCode = exitCode;
  return exitCode;
}

function readFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return '';
  const value = args[index + 1];
  return value.startsWith('-') ? '' : value.trim();
}
