/**
 * `agentbootup brain rotate-keys` — rotate the Ed25519 keypair for a brain.
 *
 * Shared core: `rotateKeysCore` is also called by pull.js `--rotate-identity` path,
 * so key rotation logic is not duplicated between the two commands.
 *
 * Unlike pull.js (which keeps new keys on ADMP failure), this command rolls back
 * config.secret.json to the old content if ADMP registration fails — the user's
 * intent was a complete rotation, not a half-done one.
 *
 * Usage:
 *   agentbootup brain rotate-keys <brain-id> [--path <dir>] [--yes] [--verbose]
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { resolveBrainMsgScript } from './resolve-brain-msg.js';
import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { provisionRegistryAccess } from '../network/registry-provisioning.js';
import { ProjectIdentityError, resolveProjectAgentId } from '../project-config.js';

const DEFAULT_SERVER_URL = 'https://agentbootup.fly.dev';

// ---------------------------------------------------------------------------
// Shared core — imported by pull.js for --rotate-identity path
// ---------------------------------------------------------------------------

/**
 * Core key rotation: clear existing identity from config files then provision a
 * new Ed25519 keypair via registry-provisioning.js.
 *
 * Returns the old config.secret.json content so callers can roll back if a
 * subsequent step (e.g. ADMP registration) fails.
 *
 * @param {string} brainDir   — project root (brain dir lives at brainDir/brain/)
 * @param {string} brainId    — brain agent ID
 * @param {{ stdout, stderr }} io
 * @param {{ verbose?: boolean }} [opts]
 * @param {object} [_deps]    — injectable deps for testing
 * @returns {Promise<{ ok: false, error: string } | { ok: true, provResult: object, oldSecretContent: string }>}
 */
export async function rotateKeysCore(brainDir, brainId, io, opts = {}, _deps = {}) {
  const { verbose = false, commandLabel = 'brain rotate-keys' } = opts;
  const { provisionRegistryAccess: _provisionRegistryAccess = provisionRegistryAccess } = _deps;

  const secretConfigPath = path.join(brainDir, 'brain', 'config.secret.json'); // nosemgrep: path-join-resolve-traversal
  const configJsonPath = path.join(brainDir, 'brain', 'config.json'); // nosemgrep: path-join-resolve-traversal

  if (!fs.existsSync(secretConfigPath)) {
    io.stderr(`${commandLabel}: no keypair found at ${secretConfigPath}`);
    io.stderr('Nothing to rotate. Use `agentbootup brain pull <brain-id>` to provision first.');
    return { ok: false, error: 'no_secret' };
  }

  // Save existing secret for potential rollback by caller.
  let oldSecretContent;
  try {
    oldSecretContent = fs.readFileSync(secretConfigPath, 'utf-8');
  } catch (err) {
    io.stderr(`${commandLabel}: cannot read ${secretConfigPath}: ${err?.message ?? String(err)}`);
    return { ok: false, error: 'unreadable' };
  }

  // Save existing config.json for rollback (provisionRegistryAccess writes a new registry.identity).
  let oldConfigContent = null;
  try {
    if (fs.existsSync(configJsonPath)) {
      oldConfigContent = fs.readFileSync(configJsonPath, 'utf-8');
    }
  } catch (err) {
    if (verbose) io.stderr(`  [debug] config.json read for rollback failed: ${err?.message ?? String(err)}`);
    // non-fatal; rollback will restore what it can
  }

  // Clear registry.identity from config.json so provisionRegistryAccess regenerates.
  // Only attempt when we have the file content; absent config.json means no identity to clear.
  if (oldConfigContent) {
    try {
      const cfg = JSON.parse(oldConfigContent);
      if (cfg.registry?.identity) {
        delete cfg.registry.identity;
        fs.writeFileSync(configJsonPath, `${JSON.stringify(cfg, null, 2)}\n`);
      }
    } catch (err) {
      if (verbose) io.stderr(`  [debug] config.json identity clear failed: ${err?.message ?? String(err)}`);
      // best-effort; provisionRegistryAccess will regenerate identity regardless
    }
  }

  // Clear registry_private_key from config.secret.json.
  try {
    const secret = JSON.parse(oldSecretContent);
    if (secret.registry_private_key) {
      delete secret.registry_private_key;
      const tmpSecret = `${secretConfigPath}.rotate-tmp.${crypto.randomBytes(6).toString('hex')}`;
      fs.writeFileSync(tmpSecret, `${JSON.stringify(secret, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmpSecret, secretConfigPath);
    }
  } catch (err) {
    if (verbose) io.stderr(`  [debug] config.secret.json key clear failed: ${err?.message ?? String(err)}`);
    // best-effort clear; provisionRegistryAccess will detect the missing key
  }

  // Load project metadata from config.json for provisioning.
  let project = { agent_id: brainId };
  try {
    const cfg = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
    project = { ...cfg, agent_id: brainId };
  } catch { /* config.json absent — use brainId only */ }

  if (verbose) io.stdout('  rotating Ed25519 keypair...');

  let provResult;
  try {
    provResult = await _provisionRegistryAccess({ projectPath: brainDir, project, io });
  } catch (err) {
    io.stderr(`${commandLabel}: keypair provisioning failed: ${err?.message ?? String(err)}`);
    return { ok: false, error: 'provision_failed' };
  }

  if (!provResult.ok) {
    io.stderr(`${commandLabel}: keypair provisioning incomplete (${provResult.reason ?? 'unknown'})`);
    return { ok: false, error: 'provision_incomplete' };
  }

  // Guard against silent rotation no-op: if old key-clear failed, provisionRegistryAccess
  // reuses the existing key and returns secretChanged: false.
  if (!provResult.secretChanged) {
    io.stderr(`${commandLabel}: identity rotation failed — existing key was not replaced.`);
    io.stderr(`Recovery: check permissions on ${secretConfigPath} then re-run with --verbose`);
    return { ok: false, error: 'no_rotation' };
  }

  return { ok: true, provResult, oldSecretContent, oldConfigContent };
}

// ---------------------------------------------------------------------------
// ADMP helper — same contract as registerWithAdmp in pull.js.
// Defined here to avoid a circular import (pull.js imports rotateKeysCore from
// this file; importing registerWithAdmp back from pull.js would be circular).
// ---------------------------------------------------------------------------

function admpRegister(brainId, target, io, _spawnSync = spawnSync) {
  const brainMsgScript = resolveBrainMsgScript(target);
  if (!brainMsgScript) {
    io.stdout('  ADMP registration: skipped (brain-msg.ts not found under brain/ or .claude/skills/cross-brain-message/)');
    return { ok: true, skipped: true };
  }
  try {
    const result = _spawnSync(
      'bun',
      [brainMsgScript, 'register', '--agent', brainId, '--repo', target],
      { stdio: 'pipe', timeout: 15_000, encoding: 'utf-8' },
    );
    if (result.error) {
      io.stderr(`  ADMP registration failed: ${result.error.message}`);
      return { ok: false, skipped: false };
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').slice(0, 400);
      io.stderr(`  ADMP registration failed (exit ${result.status}): ${detail}`);
      return { ok: false, skipped: false };
    }
    return { ok: true, skipped: false };
  } catch (err) {
    io.stderr(`  ADMP registration failed: ${err?.message ?? String(err)}`);
    return { ok: false, skipped: false };
  }
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

function parseRotateKeysArgs(argv) {
  let brainIdArg = null;
  let target = process.cwd();
  let yes = false;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--path' || arg === '-p') {
      target = argv[++i] ?? target;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (!arg.startsWith('-')) {
      brainIdArg = arg;
    }
  }

  return { brainIdArg, target: path.resolve(target), yes, verbose }; // nosemgrep: path-join-resolve-traversal — user-supplied workspace path
}

// ---------------------------------------------------------------------------
// CLI handler
// ---------------------------------------------------------------------------

/**
 * Handle `agentbootup brain rotate-keys [...argv]`.
 *
 * @param {string[]} argv
 * @param {{ stdout, stderr }} [io]
 * @param {object} [_deps]  — injectable deps for testing
 * @returns {Promise<number>}  Exit code (0 = success)
 */
export async function runBrainRotateKeys(
  argv = [],
  io = { stdout: console.log, stderr: console.error },
  _deps = {},
) {
  const {
    inspectCredentials: _inspectCredentials = inspectCredentials,
    rotateKeysCore: _rotateKeysCore = rotateKeysCore,
    admpRegister: _admpRegister = admpRegister,
  } = _deps;

  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout('Usage: agentbootup brain rotate-keys <brain-id> [--path <dir>] [--yes] [--verbose]');
    io.stdout('');
    io.stdout('Rotate the Ed25519 keypair for a brain and re-register the new identity with ADMP.');
    io.stdout('');
    io.stdout('Options:');
    io.stdout('  --path <dir>   Brain project directory (default: current directory)');
    io.stdout('  --yes          Required — confirms destructive key replacement');
    io.stdout('  --verbose      Print debug details');
    return 0;
  }

  const { brainIdArg, target, yes, verbose } = parseRotateKeysArgs(argv);

  // Require --yes unconditionally — this is a destructive security operation.
  if (!yes) {
    io.stderr('brain rotate-keys requires --yes (this permanently replaces your Ed25519 keypair)');
    return 1;
  }

  // Authenticate.
  const credentialState = await _inspectCredentials();
  if (credentialState.state !== CREDS_STATE_OK) {
    io.stderr(
      formatCredentialsRecoveryMessage(credentialState, {
        missingMessage: 'No credentials. Run: agentbootup auth login --api-key <key>',
      }),
    );
    return 1;
  }

  // Resolve brain ID.
  let localBrainId = '';
  try {
    localBrainId = resolveProjectAgentId(target);
  } catch (err) {
    const missing =
      err instanceof ProjectIdentityError &&
      err.code === 'PROJECT_IDENTITY_MISSING';
    if (!missing || !brainIdArg) {
      io.stderr(`brain rotate-keys failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (brainIdArg && localBrainId && brainIdArg !== localBrainId) {
    io.stderr(
      `brain rotate-keys failed: requested brain "${brainIdArg}" conflicts with local project identity ` +
      `"${localBrainId}"; refusing to rotate keys for a different brain`,
    );
    return 1;
  }
  const brainId = brainIdArg || localBrainId;
  if (!brainId) {
    io.stderr('No brain ID. Usage: agentbootup brain rotate-keys <brain-id> [--path <dir>]');
    return 1;
  }

  io.stdout(`Brain: ${brainId}`);
  io.stdout(`Path:  ${target}`);
  io.stdout('');

  // Rotate keypair (shared core).
  const rotResult = await _rotateKeysCore(target, brainId, io, { verbose }, _deps);
  if (!rotResult.ok) return 1;

  // ADMP re-registration.
  // Unlike pull.js (which keeps new keys on ADMP failure), rotate-keys rolls back
  // both config.secret.json and config.json — the user's intent was a complete rotation.
  io.stdout('Registering new identity with ADMP...');
  const admpResult = await _admpRegister(brainId, target, io);
  if (!admpResult.ok) {
    io.stderr('brain rotate-keys: ADMP registration failed. Rolling back to previous keypair.');
    try {
      const secretConfigPath = path.join(target, 'brain', 'config.secret.json'); // nosemgrep: path-join-resolve-traversal
      const configJsonPath = path.join(target, 'brain', 'config.json'); // nosemgrep: path-join-resolve-traversal
      const tmpRollback = `${secretConfigPath}.rollback-tmp.${crypto.randomBytes(6).toString('hex')}`;
      fs.writeFileSync(tmpRollback, rotResult.oldSecretContent, { mode: 0o600 });
      fs.renameSync(tmpRollback, secretConfigPath);
      if (rotResult.oldConfigContent) {
        const tmpCfgRollback = `${configJsonPath}.rollback-tmp.${crypto.randomBytes(6).toString('hex')}`;
        fs.writeFileSync(tmpCfgRollback, rotResult.oldConfigContent);
        fs.renameSync(tmpCfgRollback, configJsonPath);
        io.stderr('Rollback complete. The previous keypair is restored.');
      } else if (fs.existsSync(configJsonPath)) {
        // config.json was absent before rotation; provisioning created it with a new identity
        // that is now orphaned (private key was rolled back). Remove registry.identity so the
        // two files remain consistent.
        let configCleanupOk = false;
        try {
          const cfg = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
          if (cfg.registry?.identity) {
            delete cfg.registry.identity;
            const tmpCfgOrphan = `${configJsonPath}.rollback-tmp.${crypto.randomBytes(6).toString('hex')}`;
            fs.writeFileSync(tmpCfgOrphan, `${JSON.stringify(cfg, null, 2)}\n`);
            fs.renameSync(tmpCfgOrphan, configJsonPath);
          }
          configCleanupOk = true;
        } catch { /* fall through to warning */ }
        if (configCleanupOk) {
          io.stderr('Rollback complete. config.secret.json restored to previous state.');
        } else {
          io.stderr('Rollback warning: config.secret.json restored, but orphaned registry.identity in config.json could not be cleared.');
          io.stderr('Warning: config.json may advertise an identity whose private key no longer exists.');
          io.stderr(`Recovery: manually remove registry.identity from ${configJsonPath}`);
        }
      } else {
        io.stderr('Rollback complete. config.secret.json restored to previous state.');
      }
    } catch (err) {
      io.stderr(`Rollback failed: ${err?.message ?? String(err)}`);
      io.stderr('Warning: config files may be in an inconsistent state.');
      io.stderr(`Recovery: re-run \`agentbootup brain rotate-keys ${brainId} --path ${target} --yes\``);
    }
    return 1;
  }

  if (admpResult.skipped) {
    io.stdout('');
    io.stdout('Warning: ADMP registration was skipped (brain-msg.ts not found).');
    io.stdout('The new keypair is written locally but the registry does not know about it.');
    io.stdout(`To complete registration, run: bun .claude/skills/cross-brain-message/brain-msg.ts register --agent ${brainId} --repo ${target}`);
    io.stdout('Until you register, this brain cannot authenticate with ADMP.');
    io.stdout('');
  }

  io.stdout('');
  io.stdout('Keypair rotated successfully.');
  io.stdout('');
  io.stdout(
    'Warning: Prior machine\'s ADMP identity is now invalid. ' +
    'If another machine has a daemon running for this brain, it will begin failing silently — ' +
    'restart or re-provision it.',
  );

  return 0;
}
