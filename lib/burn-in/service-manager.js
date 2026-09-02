/**
 * Managed lifecycle for one explicitly configured burn-in brain.
 *
 * The platform service adapter owns its generated unit/plist. This module never
 * writes a hand-edited service file and deliberately forwards no ambient
 * configuration beyond the explicit burn-in contract.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentStart, agentStop, agentStatus } from '@derivativelabs/agent-process';
import { loadBurnInConfig } from '../../scripts/burn-in/config.mjs';
import { assertSafeBrainId } from '../../scripts/burn-in/runtime-safety.mjs';
import { preflightBurnIn as defaultPreflight } from '../../scripts/burn-in/preflight.mjs';

const DAEMON_SCRIPT = fileURLToPath(new URL('../../scripts/burn-in-daemon.ts', import.meta.url));
const FORWARDED_KEYS = new Set([
  'AGENTBOOTUP_BURNIN_BRAIN',
  'AGENTBOOTUP_BURNIN_LOCAL_DIR',
  'AGENTBOOTUP_BURNIN_MINI_SSH',
  'AGENTBOOTUP_BURNIN_KNOWN_HOSTS',
  'AGENTBOOTUP_BURNIN_REMOTE_DIR',
  'AGENTBOOTUP_BURNIN_STORE',
  'AGENTBOOTUP_BURNIN_CANONICAL_REF',
  'AGENTBOOTUP_BURNIN_CANONICAL_COMMIT',
  'AGENTBOOTUP_BURNIN_STATE_ROOT',
  'AGENTBOOTUP_BURNIN_HEALTH_INTERVAL_MS',
  'AGENTBOOTUP_BURNIN_PROBE_INTERVAL_MS',
  'AGENTBOOTUP_BURNIN_PROPAGATION_WAIT_MS',
  'AGENTBOOTUP_BURNIN_SEVEN_DAY_MS',
  'AGENTBOOTUP_BURNIN_STALE_HEALTH_MS',
  'AGENTBOOTUP_BURNIN_BRAIN_MSG',
  // These are deliberately separate from the burn-in prefix: they bind the
  // managed verifier to the same selected source and daemon-health location
  // that preflight attests. They remain an allowlisted, explicit contract.
  'AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE',
  'AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT',
  'AGENTBOOTUP_DAEMON_DIR',
  'AGENTBOOTUP_CONFIG_FILE',
  'AGENTBOOTUP_NETWORK_ROOT',
  'AGENTBOOTUP_HOME',
]);

function explicitEnvironment(env) {
  const selected = {};
  for (const key of FORWARDED_KEYS) {
    if (typeof env[key] === 'string' && env[key].length > 0) selected[key] = env[key];
  }
  if (typeof env.PATH === 'string' && env.PATH) selected.PATH = env.PATH;
  return selected;
}

export function burnInServiceName(brain) {
  return `agentbootup-burn-in-${brain}`;
}

/**
 * The released adapter owns this platform-service artifact.  It is the only
 * write outside the explicit burn-in state root on macOS; AgentBootup never
 * hand-edits it. Other platforms remain adapter-owned and are deliberately
 * not guessed here.
 */
export function burnInServiceArtifact(config, platform = process.platform, home = os.homedir()) {
  if (platform !== 'darwin') return null;
  return path.join(home, 'Library', 'LaunchAgents', `com.dundas.${burnInServiceName(assertSafeBrainId(config.brain))}.plist`);
}

export function burnInServiceConfig(config, env = process.env) {
  return {
    name: burnInServiceName(config.brain),
    script: DAEMON_SCRIPT,
    workingDirectory: config.localDir,
    // Keep all service-manager output within the separately configured,
    // permission-restricted burn-in state root.
    logDir: path.join(config.stateRoot, 'service-logs'),
    restart: true,
    restartBackoff: 10_000,
    env: explicitEnvironment(env),
  };
}

function resolveOptions(options = {}) {
  const env = options.env ?? process.env;
  return { config: loadBurnInConfig(env), env, preflight: options.preflight ?? defaultPreflight };
}

function stopServiceName(options = {}) {
  const env = options.env ?? process.env;
  const brain = assertSafeBrainId(typeof env.AGENTBOOTUP_BURNIN_BRAIN === 'string'
    ? env.AGENTBOOTUP_BURNIN_BRAIN.trim()
    : '');
  return burnInServiceName(brain);
}

async function requireReady(config, preflight) {
  const result = await preflight(config);
  if (!result?.ready) throw new Error(`burn-in preflight failed: ${result?.code ?? 'not_ready'}`);
}

/** Install/start via the released platform adapter after read-only attestation. */
export async function installBurnInService(options = {}) {
  const { config, env, preflight } = resolveOptions(options);
  await requireReady(config, preflight);
  return agentStart(burnInServiceConfig(config, env));
}

export const startBurnInService = installBurnInService;

export async function stopBurnInService(options = {}) {
  // Rollback must remain available when the runtime, descriptor, remote trust,
  // or ledger configuration is itself what has become unhealthy.  Stop needs
  // only the bounded deterministic service identity; it intentionally does no
  // preflight or filesystem mutation.
  await agentStop(stopServiceName(options));
}

export async function restartBurnInService(options = {}) {
  const { config, env, preflight } = resolveOptions(options);
  await requireReady(config, preflight);
  await agentStop(burnInServiceName(config.brain));
  return agentStart(burnInServiceConfig(config, env));
}

function ledgerState(ledger, now, staleLedgerMs) {
  let text;
  try { text = fs.readFileSync(ledger, 'utf8'); } catch (err) { return err?.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  const rows = text.trim().split('\n').filter(Boolean);
  if (!rows.length) return 'empty';
  let newest = 0;
  try {
    for (const row of rows) {
      const ts = Date.parse(JSON.parse(row).ts);
      if (!Number.isFinite(ts)) return 'invalid';
      newest = Math.max(newest, ts);
    }
  } catch { return 'invalid'; }
  return newest < now - staleLedgerMs ? 'stale' : 'fresh';
}

export async function burnInServiceStatus(options = {}) {
  const { config } = resolveOptions(options);
  const now = options.now ?? Date.now();
  const staleLedgerMs = options.staleLedgerMs ?? 3 * 60 * 60_000;
  let service = 'unknown';
  try { service = (await agentStatus(burnInServiceName(config.brain))).state ?? 'unknown'; } catch { /* status is advisory */ }
  return { name: burnInServiceName(config.brain), service, ledger: ledgerState(config.ledger, now, staleLedgerMs) };
}
