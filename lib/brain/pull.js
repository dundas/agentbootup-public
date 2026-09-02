/**
 * `agentbootup brain pull` — download brain assets from server using hash-based
 * incremental sync.
 *
 * Implements FR-6 steps 1–7 of the checkpointed pull sequence:
 *   1. Authenticate with portfolio key
 *   2. Fetch brain asset hash index from server
 *   3. Compute local hashes; skip files that match; download others via temp+rename
 *   4. Write brain/config.json if absent or --force is set
 *   5. Generate Ed25519 keypair via registry-provisioning.js (skip if present unless --rotate-identity)
 *   6. Register with ADMP (only on new keypair or --rotate-identity)
 *   7. Start daemon if not already running (skip with --no-daemon)
 *
 * Usage:
 *   agentbootup brain pull <brain-id> [--path <dir>] [--force] [--dry-run] [--verbose]
 *     [--rotate-identity] [--yes] [--no-daemon]
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveBrainMsgScript } from './resolve-brain-msg.js';
import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { isValidServerUrl, apiUrl } from '../auth/validate.js';
import { provisionRegistryAccess } from '../network/registry-provisioning.js';
import { rotateKeysCore } from './rotate-keys.js';
import { resolveConfiguredProjectAgentId } from '../project-config.js';

const PULL_TIMEOUT_MS = 30_000;
const HASHES_TIMEOUT_MS = 15_000;
const DEFAULT_SERVER_URL = 'https://agentbootup.fly.dev';

// Resolved at module load time — pull.js lives at lib/brain/pull.js → root is ../../
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOTUP_MJS_PATH = path.resolve(__dirname, '../../bootup.mjs');

/**
 * Parse brain pull flags from argv.
 * @param {string[]} argv
 */
export function parsePullArgs(argv) {
  let brainIdArg = null;
  let target = process.cwd();
  let force = false;
  let dryRun = false;
  let verbose = false;
  let rotateIdentity = false;
  let yes = false;
  let noDaemon = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path' && argv[i + 1] !== undefined) {
      target = argv[++i];
    } else if (argv[i] === '--force') {
      force = true;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if (argv[i] === '--verbose') {
      verbose = true;
    } else if (argv[i] === '--rotate-identity') {
      rotateIdentity = true;
    } else if (argv[i] === '--yes' || argv[i] === '-y') {
      yes = true;
    } else if (argv[i] === '--no-daemon') {
      noDaemon = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      // handled by caller
    } else if (!argv[i].startsWith('-') && !brainIdArg) {
      brainIdArg = argv[i];
    }
  }

  return { brainIdArg, target: path.resolve(target), force, dryRun, verbose, rotateIdentity, yes, noDaemon }; // nosemgrep: path-join-resolve-traversal — CLI tool; target is a user-supplied workspace path
}

/**
 * Fetch the remote hash index for a brain.
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {string} brainId
 * @returns {Promise<{ ok: true, files: Array } | { ok: false, error: string }>}
 */
export async function fetchHashIndex(serverUrl, apiKey, brainId) {
  const endpoint = apiUrl(serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}/hashes`);
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), HASHES_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timerId);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 400)}` };
    }
    const json = await resp.json().catch(() => null);
    const files = json?.data?.files;
    if (!Array.isArray(files)) {
      return { ok: false, error: 'invalid server response (missing data.files array)' };
    }
    return { ok: true, files };
  } catch (err) {
    clearTimeout(timerId);
    if (err?.name === 'AbortError') {
      return { ok: false, error: `request timed out after ${HASHES_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Download a single brain asset file by path.
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {string} brainId
 * @param {string} remotePath
 * @param {string} [assetType]  — optional; passed for efficient server-side lookup
 * @returns {Promise<{ ok: true, buffer: Buffer } | { ok: false, error: string }>}
 */
export async function downloadAsset(serverUrl, apiKey, brainId, remotePath, assetType) {
  const q = new URLSearchParams({ path: remotePath });
  if (assetType) q.set('asset_type', assetType);
  const endpoint = apiUrl(
    serverUrl,
    `/v1/brain-assets/${encodeURIComponent(brainId)}?${q.toString()}`,
  );
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timerId);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 400)}` };
    }
    const json = await resp.json().catch(() => null);
    const files = json?.data?.files;
    const b64 = files?.[0]?.content_base64;
    if (typeof b64 !== 'string' || !b64.length) {
      return { ok: false, error: 'invalid pull response (missing file content)' };
    }
    return { ok: true, buffer: Buffer.from(b64, 'base64') };
  } catch (err) {
    clearTimeout(timerId);
    if (err?.name === 'AbortError') {
      return { ok: false, error: `request timed out after ${PULL_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Compute SHA-256 of a local file. Returns null if the file does not exist or is unreadable.
 * @param {string} filePath
 * @returns {string | null}
 */
export function computeLocalHash(filePath) {
  try {
    const raw = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(raw).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Write a buffer to `destPath` atomically via a temp file in the same directory.
 * If the write succeeds, returns { ok: true }. On failure, cleans up the temp file
 * and returns { ok: false, error }.
 *
 * @param {string} destPath
 * @param {Buffer} buffer
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function atomicWrite(destPath, buffer) {
  const dir = path.dirname(destPath);
  const tmpPath = path.join(dir, `.pull-tmp-${crypto.randomBytes(8).toString('hex')}`); // nosemgrep: path-join-resolve-traversal
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, destPath);
    return { ok: true };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    return { ok: false, error: err.message };
  }
}

/**
 * Register this brain with ADMP (AgentDispatch) using brain-msg.ts.
 *
 * Returns true if registration succeeded or was skipped (brain-msg.ts not found).
 * Returns false only on a definitive failure.
 *
 * @param {string} brainId
 * @param {string} target  — project root (brain dir lives at target/brain/)
 * @param {{ stdout: (l:string)=>void, stderr: (l:string)=>void }} io
 * @returns {boolean}
 */
export function registerWithAdmp(brainId, target, io, _spawnSync = spawnSync) {
  const brainMsgScript = resolveBrainMsgScript(target);
  if (!brainMsgScript) {
    io.stdout('  ADMP registration: skipped (brain-msg.ts not found under brain/ or .claude/skills/cross-brain-message/)');
    io.stdout(
      `  Recovery: after brain pull, run: bun brain/brain-msg.ts register --agent ${brainId} --repo ${target}`,
    );
    return true; // non-fatal — brain-msg.ts may not yet be present on first pull
  }
  try {
    const result = _spawnSync(
      'bun',
      [brainMsgScript, 'register', '--agent', brainId, '--repo', target],
      { stdio: 'pipe', timeout: 15_000, encoding: 'utf-8' },
    );
    if (result.error) {
      io.stderr(`  ADMP registration failed: ${result.error.message}`);
      return false;
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').slice(0, 400);
      io.stderr(`  ADMP registration failed (exit ${result.status}): ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    io.stderr(`  ADMP registration failed: ${err?.message ?? String(err)}`);
    return false;
  }
}

/**
 * Start the daemon for a brain if it is not already running.
 *
 * Returns { ok: true, alreadyRunning: false } on successful start.
 * Returns { ok: true, alreadyRunning: true } if the daemon was already running.
 * Returns { ok: false, alreadyRunning: false, error } on failure.
 *
 * @param {string} brainId
 * @param {string} target  — project root; passed as cwd so single-brain mode resolves the right dir
 * @param {{ stdout: (l:string)=>void, stderr: (l:string)=>void }} io
 * @returns {{ ok: boolean, alreadyRunning: boolean, error?: string }}
 */
export function startDaemon(brainId, target, io, _spawnSync = spawnSync) {
  try {
    const result = _spawnSync(
      'bun',
      [BOOTUP_MJS_PATH, 'daemon', 'start', brainId, '--yes'],
      { stdio: 'pipe', timeout: 30_000, encoding: 'utf-8', cwd: target },
    );
    const combined = (result.stdout || '') + (result.stderr || '');
    if (result.error) {
      return { ok: false, alreadyRunning: false, error: result.error.message };
    }
    const alreadyRunning = combined.toLowerCase().includes('already running');
    if (result.status !== 0 && !alreadyRunning) {
      return { ok: false, alreadyRunning: false, error: combined.slice(0, 400) };
    }
    return { ok: true, alreadyRunning };
  } catch (err) {
    return { ok: false, alreadyRunning: false, error: err?.message ?? String(err) };
  }
}

/**
 * Handle `agentbootup brain pull [...argv]`.
 *
 * Implements FR-6 steps 1–7:
 *   1. Auth check
 *   2. Fetch remote hash index
 *   3. Hash-compare; download mismatches via temp+rename; clean up temps on error
 *   4. Write brain/config.json if absent or --force
 *   5. Generate Ed25519 keypair (skip if config.secret.json present and no --rotate-identity)
 *   6. Register with ADMP (only when new keypair generated or --rotate-identity)
 *   7. Start daemon (skip if --no-daemon or already running)
 *
 * @param {string[]} argv  Args after `brain pull`
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} [io]
 * @param {object} [_deps]  Injectable dependencies for testing
 * @returns {Promise<number>}  Exit code (0 = success)
 */
export async function runBrainPull(argv = [], io = { stdout: console.log, stderr: console.error }, _deps = {}) {
  const {
    inspectCredentials: _inspectCredentials = inspectCredentials,
    provisionRegistryAccess: _provisionRegistryAccess = provisionRegistryAccess,
    rotateKeysCore: _rotateKeysCore = rotateKeysCore,
    registerWithAdmp: _registerWithAdmp = registerWithAdmp,
    startDaemon: _startDaemon = startDaemon,
  } = _deps;

  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout('Usage: agentbootup brain pull <brain-id> [--path <dir>] [--force] [--dry-run] [--verbose]');
    io.stdout('       [--rotate-identity] [--yes] [--no-daemon]');
    io.stdout('');
    io.stdout('Download brain assets from server using hash-based incremental sync.');
    io.stdout('');
    io.stdout('Options:');
    io.stdout('  <brain-id>         Brain ID to pull (default: strict project identity in --path)');
    io.stdout('  --path <dir>       Target directory (created if absent)');
    io.stdout('  --force            Overwrite brain/config.json even if it exists');
    io.stdout('  --dry-run          Show what would be written without making any changes');
    io.stdout('  --verbose          Print per-file actions');
    io.stdout('  --rotate-identity  Generate a new Ed25519 keypair and re-register with ADMP');
    io.stdout('  --yes              Required with --rotate-identity in non-interactive mode');
    io.stdout('  --no-daemon        Skip daemon start after pull completes');
    return 0;
  }

  const { brainIdArg, target, force, dryRun, verbose, rotateIdentity, yes, noDaemon } = parsePullArgs(argv);

  // Guard: --rotate-identity always requires --yes (destructive, no interactive prompt).
  if (rotateIdentity && !yes) {
    io.stderr('brain pull --rotate-identity requires --yes (this permanently replaces your Ed25519 keypair)');
    return 1;
  }

  // Step 1: Authenticate with portfolio key.
  const credentialState = await _inspectCredentials();
  if (credentialState.state !== CREDS_STATE_OK) {
    io.stderr(
      formatCredentialsRecoveryMessage(credentialState, {
        missingMessage: 'No credentials. Run: agentbootup auth login --api-key <key>',
      }),
    );
    return 1;
  }
  const { apiKey, serverUrl: rawServerUrl } = credentialState.creds;
  const serverUrl = rawServerUrl || DEFAULT_SERVER_URL;

  if (!isValidServerUrl(serverUrl)) {
    io.stderr(
      `Invalid server URL in credentials: "${serverUrl}". Re-run auth login with a valid --server-url.`,
    );
    return 1;
  }

  // Existing configuration is authoritative even when a positional ID is
  // supplied. Explicit IDs are only a bootstrap input for a fresh target.
  let localBrainId;
  try {
    localBrainId = resolveConfiguredProjectAgentId(target);
  } catch (err) {
    io.stderr(`brain pull failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (brainIdArg && localBrainId && brainIdArg !== localBrainId) {
    io.stderr(
      `brain pull failed: requested brain "${brainIdArg}" conflicts with local project identity ` +
      `"${localBrainId}"; refusing to choose a brain.`,
    );
    return 1;
  }
  const brainId = brainIdArg || localBrainId;
  if (!brainId) {
    io.stderr('No brain ID. Usage: agentbootup brain pull <brain-id> [--path <dir>]');
    return 1;
  }

  // Create target directory upfront (FR-9); skip in dry-run.
  if (!dryRun) {
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (err) {
      io.stderr(`brain pull failed: cannot create target directory ${target}: ${err.message}`);
      return 1;
    }
  }

  io.stdout(`Brain: ${brainId}`);
  io.stdout(`Server: ${serverUrl}`);
  if (dryRun) io.stdout('[dry-run] no files will be written');

  // Step 2: Fetch remote hash index.
  const hashResult = await fetchHashIndex(serverUrl, apiKey, brainId);
  if (!hashResult.ok) {
    io.stderr(`brain pull failed: ${hashResult.error}`);
    return 1;
  }
  const remoteFiles = hashResult.files;

  if (remoteFiles.length === 0) {
    io.stdout('No remote assets found — run `agentbootup brain push` first.');
    return 0;
  }

  if (verbose) {
    io.stdout(`Remote assets: ${remoteFiles.length}`);
  }

  // Step 3: Hash-compare and download.
  // brain/config.json is handled separately in Step 4; exclude it here.
  const CONFIG_JSON_REL = 'brain/config.json';
  const configJsonAbsDest = path.resolve(path.join(target, CONFIG_JSON_REL)); // nosemgrep: path-join-resolve-traversal

  let matched = 0;
  let skipped = 0;  // existence-based skip (identity preservation), distinct from hash-match
  let downloaded = 0;
  let errors = 0;
  let pullFailed = false;

  for (const remote of remoteFiles) {
    if (
      typeof remote.path !== 'string' ||
      !remote.path ||
      typeof remote.hash !== 'string'
    ) {
      io.stderr('  warning: invalid hash record from server, skipping');
      continue;
    }

    // nosemgrep: path-join-resolve-traversal
    const destAbsPath = path.resolve(path.join(target, remote.path));

    // Path traversal guard — use sep-precise check to avoid false positive on files
    // whose name starts with '..' (e.g. '..config.md') but are legitimately inside target.
    const rel = path.relative(target, destAbsPath);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      io.stderr(`  warning: path traversal detected, skipping: ${remote.path}`);
      continue;
    }

    // brain/config.json is handled in Step 4.
    if (destAbsPath === configJsonAbsDest) continue;

    // Skip if local file already matches remote hash.
    const localHash = computeLocalHash(destAbsPath);
    if (localHash !== null && localHash === remote.hash) {
      matched++;
      if (verbose) io.stdout(`  skip (match) ${remote.path}`);
      continue;
    }

    if (dryRun) {
      const action = localHash === null ? 'write' : 'update';
      io.stdout(`  [dry-run] ${action} ${remote.path}`);
      downloaded++;
      continue;
    }

    // Download then write atomically via temp+rename (atomicWrite handles cleanup on failure).
    const result = await downloadAsset(serverUrl, apiKey, brainId, remote.path, remote.asset_type);
    if (!result.ok) {
      io.stderr(`  error downloading ${remote.path}: ${result.error}`);
      errors++;
      pullFailed = true;
      continue;
    }

    const writeResult = atomicWrite(destAbsPath, result.buffer);
    if (!writeResult.ok) {
      io.stderr(`  error writing ${remote.path}: ${writeResult.error}`);
      errors++;
      pullFailed = true;
      continue;
    }

    if (verbose) io.stdout(`  write ${remote.path}`);
    downloaded++;
  }

  // Step 4: Write brain/config.json if absent or --force.
  // Use normalized path comparison to handle server paths like './brain/config.json'.
  const remoteConfig = remoteFiles.find((f) => {
    if (typeof f.path !== 'string') return false;
    // nosemgrep: path-join-resolve-traversal
    return path.resolve(path.join(target, f.path)) === configJsonAbsDest;
  });
  if (remoteConfig) {
    const configExists = fs.existsSync(configJsonAbsDest);
    if (configExists && !force) {
      if (verbose) io.stdout(`  skip (exists) brain/config.json (use --force to overwrite)`);
      // Intentional: config.json is skipped to preserve brain identity, not because the hash matched.
      skipped++;
    } else if (dryRun) {
      const action = configExists ? 'overwrite (--force) brain/config.json' : 'write brain/config.json';
      io.stdout(`  [dry-run] ${action}`);
      downloaded++;
    } else {
      const result = await downloadAsset(
        serverUrl, apiKey, brainId, CONFIG_JSON_REL, remoteConfig.asset_type,
      );
      if (!result.ok) {
        io.stderr(`  error downloading brain/config.json: ${result.error}`);
        errors++;
        pullFailed = true;
      } else {
        const writeResult = atomicWrite(configJsonAbsDest, result.buffer);
        if (!writeResult.ok) {
          io.stderr(`  error writing brain/config.json: ${writeResult.error}`);
          errors++;
          pullFailed = true;
        } else {
          if (verbose) io.stdout(`  write brain/config.json`);
          downloaded++;
        }
      }
    }
  }

  // Summary for steps 1-4.
  const dryRunLabel = dryRun ? ' (dry-run)' : '';
  io.stdout(`\nBrain pull complete${dryRunLabel} (brain: ${brainId})`);
  io.stdout(`  matched:    ${matched} files (hash match, skipped)`);
  if (skipped > 0) io.stdout(`  skipped:    ${skipped} files (identity preserved, use --force to overwrite)`);
  io.stdout(`  downloaded: ${downloaded} files`);
  if (errors > 0) io.stdout(`  errors:     ${errors}`);
  io.stdout(`Target: ${target}`);

  if (pullFailed || errors > 0) return 1;

  // Steps 5–7 are skipped in dry-run (summary line already printed above).
  if (dryRun) {
    // nosemgrep: path-join-resolve-traversal
    const secretConfigPath = path.join(target, 'brain', 'config.secret.json');
    const secretExists = fs.existsSync(secretConfigPath);
    if (rotateIdentity && secretExists) {
      io.stdout('  [dry-run] would rotate keypair and re-register with ADMP');
    } else if (!secretExists) {
      io.stdout('  [dry-run] would generate new keypair');
    } else {
      io.stdout('  [dry-run] existing keypair preserved');
    }
    if (!noDaemon) io.stdout('  [dry-run] would check and start daemon if needed');
    return 0;
  }

  // Step 5: Ed25519 keypair generation via registry-provisioning.js.
  //
  // provisionRegistryAccess handles key generation idempotently:
  //   - First run (config.secret.json absent): generates keypair, writes at 0o600
  //   - Subsequent runs: reuses existing keypair (secretChanged: false)
  //
  // Step 5: Ed25519 keypair.
  //
  // --rotate-identity: delegates to rotateKeysCore (shared with `brain rotate-keys`).
  // First provision (no secret yet): calls provisionRegistryAccess directly.
  // Deliberate: on ADMP failure (step 6), keep new keys — pull is a sync, not an explicit rotation.
  const secretConfigPath = path.join(target, 'brain', 'config.secret.json'); // nosemgrep: path-join-resolve-traversal
  const secretExists = fs.existsSync(secretConfigPath);

  let keyCreated = false;

  if (secretExists && !rotateIdentity) {
    if (verbose) io.stdout('\nStep 5: existing keypair preserved (use --rotate-identity to generate a new one)');
  } else if (rotateIdentity) {
    // Rotation path: shared core from rotate-keys.js.
    if (verbose) io.stdout('\nStep 5: rotating Ed25519 keypair via shared rotateKeysCore...');
    const rotResult = await _rotateKeysCore(target, brainId, io, { verbose, commandLabel: 'brain pull' }, _deps);
    if (!rotResult.ok) return 1;
    keyCreated = true;
    if (verbose) io.stdout('  keypair: rotated');
  } else {
    // First provision: no existing secret — call provisionRegistryAccess directly.
    const configJsonPath = path.join(target, 'brain', 'config.json'); // nosemgrep: path-join-resolve-traversal
    let project = { agent_id: brainId };
    try {
      const cfg = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
      project = { ...cfg, agent_id: brainId };
    } catch { /* config.json absent — use brainId only */ }

    if (verbose) io.stdout('\nStep 5: generating Ed25519 keypair...');
    let provResult;
    try {
      provResult = await _provisionRegistryAccess({ projectPath: target, project, io });
    } catch (err) {
      io.stderr(`brain pull: keypair provisioning failed: ${err?.message ?? String(err)}`);
      io.stderr(`Recovery: re-run \`agentbootup brain pull ${brainId} --path ${target}\``);
      return 1;
    }
    if (!provResult.ok) {
      io.stderr(`brain pull: keypair provisioning incomplete (${provResult.reason ?? 'unknown'})`);
      io.stderr(`Recovery: re-run \`agentbootup brain pull ${brainId} --path ${target}\``);
      return 1;
    }
    keyCreated = provResult.secretChanged;
    if (verbose) io.stdout(`  keypair: ${keyCreated ? 'generated new' : 'existing (preserved by registry)'}`);
  }

  // Step 6: ADMP registration — only when a new keypair was generated or --rotate-identity.
  //
  // Idempotency: on re-pull with unchanged keys, ADMP is NOT called.
  // Finding from task 4.2: ADMP register is called via brain-msg.ts which upserts by agent_id.
  if (keyCreated) {
    if (verbose) io.stdout('\nStep 6: registering with ADMP...');
    const admpOk = _registerWithAdmp(brainId, target, io);
    if (!admpOk) {
      io.stderr(`brain pull: ADMP registration failed. Keys are kept — to retry ADMP only:`);
      io.stderr(`  bun ${path.join(target, '.claude/skills/cross-brain-message/brain-msg.ts')} register --agent ${brainId} --repo ${target}`); // nosemgrep: path-join-resolve-traversal — recovery message display only; target is user-supplied workspace path
      return 1;
    }
    if (verbose) io.stdout('  ADMP: registered');
  } else if (verbose) {
    io.stdout('\nStep 6: ADMP registration skipped (keypair unchanged)');
  }

  // Step 7: Start daemon if not already running.
  if (noDaemon) {
    if (verbose) io.stdout('\nStep 7: daemon start skipped (--no-daemon)');
    return 0;
  }

  if (verbose) io.stdout('\nStep 7: starting daemon...');
  const daemonResult = _startDaemon(brainId, target, io);
  if (daemonResult.alreadyRunning) {
    io.stdout(`daemon already running — restart if you need it to pick up new assets: agentbootup daemon start ${brainId} --yes`);
  } else if (!daemonResult.ok) {
    io.stderr(`brain pull: daemon start failed: ${daemonResult.error ?? 'unknown error'}`);
    io.stderr(`Recovery: agentbootup daemon start ${brainId} --yes`);
    return 1;
  } else if (verbose) {
    io.stdout('  daemon: started');
  }

  return 0;
}
