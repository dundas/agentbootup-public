/**
 * `agentbootup brain restore` — download and write brain assets to a target project.
 *
 * Calls POST /v1/boot-bundle to fetch a brain's assets (skills, agents, commands,
 * memory, protocols, config) and writes them to the target project directory,
 * preserving the relative path structure from the server.
 *
 * Usage:
 *   agentbootup brain restore [--target <dir>|--to <dir>] [--branch <id>]
 *                             [--force] [--dry-run] [--verbose] [--subset <csv>]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { getBrainId, getNetworkRoot } from '../config/config.js';
import { isValidServerUrl, apiUrl } from '../auth/validate.js';
import { getPidFilePath, isProcessAlive, readPidSync } from '../process/pid-utils.js';
import { provisionBrainDb } from './brain-db.js';
import {
  loadNetworkConfig,
  resolveNetworkConfigPath,
  resolveProjectPath,
} from '../network/config.js';
import {
  ProjectIdentityError,
  resolveProjectAgentId,
} from '../project-config.js';
import {
  assertBrainBackupPolicyReady,
  resolveBrainBackupSelection,
} from '../memory/brain-backup-selection.js';
import {
  isCanonicalBase64,
  isSecretAssetPath,
} from './asset-contract.js';

/**
 * Maps server-supplied asset_type values to subset filter names.
 * Subset names correspond to the --subset flag values.
 */
const ASSET_TYPE_TO_SUBSET = {
  memory: 'memory',
  skill: 'skills',
  agent: 'agents',
  command: 'commands',
  protocol: 'protocols',
  config: 'config',
  script: 'scripts',
  runtime: 'runtime',
};

/** PID file for the brain-asset-sync daemon — resolved via shared pid-utils so it always matches unified-daemon-cli.js. */
const BRAIN_DAEMON_PID_FILE = getPidFilePath('brain-asset-sync');

const RESTORE_TIMEOUT_MS = 30_000;

/**
 * Build the boot-bundle request used by both interactive and container restore.
 *
 * Memory files needed by restore are already carried in `brain_assets`. Asking
 * BundleBuilder for its legacy top-level `memory` projection as well duplicates
 * that payload and can exhaust a small server while assembling large brains.
 */
export function buildRestoreBundleRequest(brainId, branchId = 'default') {
  return {
    brain_id: brainId,
    branch_id: branchId,
    include_brain_assets: true,
    include_memory: false,
    include_skills: false,
    include_credentials: false,
  };
}

/**
 * Build the full `Server returned N: …` line for failed boot-bundle responses.
 * Exported for unit tests; keep in sync with {@link runBrainRestore} error handling.
 *
 * @param {number} status HTTP status
 * @param {unknown} body Parsed JSON body, or `undefined` if `resp.json()` threw
 * @param {string} brainId Brain id (for 404 hint)
 * @returns {string}
 */
export function formatRestoreFailureLine(status, body, brainId) {
  let msg = '';
  if (body != null && typeof body === 'object') {
    msg = body?.error?.message || body?.message || '';
  }
  if (status === 404 && !msg) {
    msg =
      `Brain '${brainId}' not found in server registry. ` +
      'Local brain link state or cross-brain messaging (ADMP) registration is not enough. ' +
      'Register the brain server-side via POST /v1/brains or verify the brain ID and server URL.';
  } else if (!msg) {
    msg = `HTTP ${status}`;
  }
  return `Server returned ${status}: ${msg}`;
}

/**
 * Parse restore-specific flags from argv.
 * @param {string[]} argv
 * @returns {{ target: string, force: boolean, dryRun: boolean, verbose: boolean, subset: string[], brainIdArg: string | null, branchId: string }}
 */
export function parseRestoreArgs(argv) {
  let target = process.cwd();
  let force = false;
  let dryRun = false;
  let verbose = false;
  let brainIdArg = null;
  let branchId = 'default';
  let subset = ['memory', 'skills', 'agents', 'commands', 'protocols', 'config', 'scripts', 'runtime'];

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--target' || argv[i] === '--to') && argv[i + 1] !== undefined) {
      target = argv[++i];
    } else if (argv[i] === '--branch') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-') || !next.trim()) {
        throw new Error('brain restore failed: --branch requires a value');
      }
      branchId = next.trim();
      i += 1;
    } else if (argv[i] === '--force') {
      force = true;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if (argv[i] === '--verbose') {
      verbose = true;
    } else if (argv[i] === '--subset' && argv[i + 1] !== undefined) {
      subset = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (!argv[i].startsWith('-') && !brainIdArg) {
      brainIdArg = argv[i];
    }
  }

  return { target: path.resolve(target), force, dryRun, verbose, subset, brainIdArg: brainIdArg?.trim() || null, branchId }; // nosemgrep: path-join-resolve-traversal -- restore target is an explicit operator-selected local path
}

function isWithinProject(targetPath, projectPath, networkRoot) {
  if (!projectPath || typeof projectPath !== 'string') return false;
  const normalizedProjectPath = path.isAbsolute(projectPath)
    ? projectPath
    : path.resolve(networkRoot, projectPath); // nosemgrep: path-join-resolve-traversal -- network project paths come from trusted local config rooted at the operator's network dir
  const relative = path.relative(normalizedProjectPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readProjectMarker(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new ProjectIdentityError(
      `Project identity configuration contains invalid JSON at ${filePath}: ${err.message}.`,
      'PROJECT_IDENTITY_INVALID',
    );
  }
}

function findLocalTargetBrain(targetPath) {
  let current = path.resolve(targetPath); // nosemgrep: path-join-resolve-traversal -- targetPath is the local restore target already chosen by the operator
  while (true) {
    const projectConfigPath = path.join(current, 'agentbootup.json'); // nosemgrep: path-join-resolve-traversal -- probing fixed filenames while walking upward from a trusted local target path
    const brainConfigPath = path.join(current, 'brain', 'config.json'); // nosemgrep: path-join-resolve-traversal -- probing fixed filenames while walking upward from a trusted local target path
    const hasBrainConfig = fs.existsSync(brainConfigPath);
    if (hasBrainConfig) {
      return {
        brainId: resolveProjectAgentId(current),
        source: 'target-project-identity',
        projectRoot: current,
        configPath: brainConfigPath,
      };
    }

    if (fs.existsSync(projectConfigPath)) {
      const projectConfig = readProjectMarker(projectConfigPath);
      if (projectConfig?.role === 'network') return null;
      return {
        brainId: resolveProjectAgentId(current),
        source: 'target-project-identity',
        projectRoot: current,
        configPath: projectConfigPath,
      };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function resolveLinkedBrainIdFromTarget(targetPath) {
  const networkRoot = await getNetworkRoot();
  if (!networkRoot) return null;

  const configPath = resolveNetworkConfigPath(networkRoot);
  if (!fs.existsSync(configPath)) return null;

  const loaded = loadNetworkConfig(networkRoot);

  const project = (loaded.config.projects || []).find((row) => isWithinProject(targetPath, row.path, networkRoot));
  if (!project) return null;
  const projectRoot = resolveProjectPath(project.path, networkRoot);
  const brainId = resolveProjectAgentId(projectRoot);
  if (!brainId || brainId !== project.agent_id) {
    throw new ProjectIdentityError(
      `Conflicting project identity declarations: ${configPath} projects[].agent_id="${project.agent_id}" ` +
      `differs from the local identity "${brainId}" resolved from ${path.join(projectRoot, 'agentbootup.json')} ` +
      `or ${path.join(projectRoot, 'brain', 'config.json')}; refusing to choose a brain.`,
      'PROJECT_IDENTITY_CONFLICT',
    );
  }

  return {
    brainId,
    projectId: project.id,
    source: 'network-link',
    projectRoot,
  };
}

/**
 * Returns true if the brain-asset-sync daemon is currently running.
 * @returns {boolean}
 */
function isBrainDaemonRunning() {
  const pid = readPidSync(BRAIN_DAEMON_PID_FILE);
  return pid !== null && isProcessAlive(pid);
}

function assertSafeRestoreRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`brain restore refused: unsafe ${label}`);
  }
  return value;
}

/**
 * Validate every incoming memory asset against the policy carried by the
 * restore bundle (or an existing local policy) before any target byte is
 * written. Staging the candidate bytes also lets the shared resolver apply
 * the same secret, ignore, symlink, and selector rules used by publication.
 */
export function assertRestoreMemorySelection(assets, target, subset = ['memory']) {
  if (!subset.includes('memory')) return;
  const memoryAssets = assets.filter((asset) => asset?.asset_type === 'memory');
  if (memoryAssets.length === 0) return;

  const policyAsset = assets.find((asset) => asset?.path === 'brain-backup.json');
  const ignoreAsset = assets.find((asset) => asset?.path === '.brainignore');
  const localPolicy = path.join(path.resolve(target), 'brain-backup.json');
  if (!policyAsset && !fs.existsSync(localPolicy)) {
    throw new Error(
      'brain restore refused: memory payload requires brain-backup.json in the bundle or target; ' +
      'restore/publish the operator-owned backup policy first',
    );
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-restore-selection-'));
  try {
    const stagingStat = fs.lstatSync(staging);
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
      throw new Error('brain restore refused: selection staging root is not a real directory');
    }
    for (const asset of memoryAssets) {
      const rel = assertSafeRestoreRelativePath(asset.path, 'memory asset path');
      if (!rel.startsWith('memory/')) {
        throw new Error(`brain restore refused: memory asset is outside memory/: ${rel}`);
      }
      const dest = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Blob-backed assets are classified with a placeholder here; the
      // existing write path will warn/skip because it cannot dereference them.
      // Policy preflight must still happen before that compatibility behavior.
      fs.writeFileSync(
        dest,
        typeof asset.content_base64 === 'string'
          ? Buffer.from(asset.content_base64, 'base64')
          : Buffer.alloc(0),
      );
    }

    const writePolicySource = (source, filename) => {
      fs.rmSync(path.join(staging, filename), { force: true });
      if (!source) return;
      if (source.asset) {
        if (typeof source.asset.content_base64 !== 'string') {
          throw new Error(`brain restore refused: ${filename} must be an inline base64 asset`);
        }
        fs.writeFileSync(path.join(staging, filename), Buffer.from(source.asset.content_base64, 'base64'));
      } else {
        fs.copyFileSync(source.path, path.join(staging, filename));
      }
    };
    const validatePolicy = (policySource, ignoreSource, label) => {
      writePolicySource(policySource, 'brain-backup.json');
      writePolicySource(ignoreSource, '.brainignore');
      const selection = resolveBrainBackupSelection(staging);
      assertBrainBackupPolicyReady(selection, `brain restore (${label} policy)`);
      const selected = new Set(selection.selected.map((record) => record.path));
      const rejected = memoryAssets
        .map((asset) => asset.path)
        .filter((rel) => !selected.has(rel));
      if (rejected.length > 0) {
        throw new Error(
          `brain restore refused: payload contains memory path(s) outside ${label} selection: ${rejected.join(', ')}`,
        );
      }
    };

    if (policyAsset) {
      validatePolicy(
        { asset: policyAsset },
        ignoreAsset ? { asset: ignoreAsset } : null,
        'bundled',
      );
    }
    if (fs.existsSync(localPolicy)) {
      const localIgnore = path.join(path.resolve(target), '.brainignore');
      validatePolicy(
        { path: localPolicy },
        fs.existsSync(localIgnore) ? { path: localIgnore } : null,
        'local operator',
      );
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Write a list of brain assets to the target directory.
 *
 * This is extracted from runBrainRestore so it can be tested independently
 * without making HTTP calls.
 *
 * @param {Array<{ asset_type: string, path: string, content_base64: string }>} assets
 * @param {{ target: string, force: boolean, dryRun: boolean, verbose: boolean, subset: string[] }} opts
 * @returns {{ written: number, skipped: number, errors: number, dropped: number }}
 */
export function writeAssets(assets, opts) {
  const { target, force, dryRun, verbose, subset } = opts;
  assertRestoreMemorySelection(assets, target, subset);
  const resolvedTarget = path.resolve(target); // nosemgrep: path-join-resolve-traversal -- write target is a local operator-selected directory
  const blobRefSkippableTypes = new Set(['memory', 'protocol']);

  let written = 0;
  let skipped = 0;
  let errors = 0;
  let dropped = 0;

  for (const asset of assets) {
    const secretPath = isSecretAssetPath(asset.path);
    if (asset.asset_type === 'secret' || secretPath) {
      console.warn(`  warn: generic brain restore rejects secret asset: ${asset.path}`);
      dropped++;
      continue;
    }

    // Filter by subset: skip if this asset_type is not in the requested subset.
    const subsetKey = ASSET_TYPE_TO_SUBSET[asset.asset_type];
    if (!subsetKey || !subset.includes(subsetKey)) {
      if (verbose) {
        console.log(`  skip (subset) ${asset.path}`);
      }
      continue;
    }

    if (
      (asset.path === 'brain-backup.json' || asset.path === '.brainignore') &&
      fs.existsSync(path.join(resolvedTarget, asset.path))
    ) {
      skipped++;
      if (verbose) console.log(`  skip (local operator policy) ${asset.path}`);
      continue;
    }

    // Build destination path.
    const dest = path.join(resolvedTarget, asset.path); // nosemgrep: path-join-resolve-traversal -- asset.path is validated immediately below with path.relative traversal checks before writes

    // Path traversal guard: use path.relative() rather than startsWith so that
    // symlinks inside the target tree cannot escape the intended root.
    // startsWith is insufficient because a symlink pointing above the target
    // would resolve to a path that still appears to be inside it before the
    // OS follows the link at write time.
    const resolvedDest = path.resolve(dest); // nosemgrep: path-join-resolve-traversal -- resolved only to enforce the traversal guard before any write
    const rel = path.relative(resolvedTarget, resolvedDest);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.warn(
        `  warn: path traversal detected, skipping: ${asset.path}`,
      );
      dropped++;
      continue;
    }

    // Check if the file already exists.
    const exists = fs.existsSync(dest);
    if (exists && !force) {
      skipped++;
      if (verbose) {
        console.log(`  skip (exists) ${asset.path}`);
      }
      continue;
    }

    if (dryRun) {
      if (verbose) {
        const action = exists ? 'overwrite' : 'write';
        console.log(`  [dry-run] ${action} ${asset.path}`);
      }
      written++;
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (typeof asset.content_base64 !== 'string') {
        // Mech may externalize large document payloads as blob refs. Restore does
        // not currently have the storage credentials needed to dereference those
        // objects client-side, so warn and continue instead of failing the whole
        // bootstrap flow on one non-essential asset.
        if (asset.content_base64?.__type === 'blob_ref') {
          const message = `server returned blob_ref content that restore cannot inline yet`;
          if (blobRefSkippableTypes.has(asset.asset_type)) {
            console.warn(`  warn: skipping ${asset.path}: ${message}`);
            skipped++;
            continue;
          }
          console.error(`  error writing ${asset.path}: ${message}`);
          errors++;
          continue;
        }
        throw new TypeError(`unsupported content_base64 payload type: ${typeof asset.content_base64}`);
      }
      if (!isCanonicalBase64(asset.content_base64)) {
        throw new TypeError('content_base64 is not canonical base64');
      }
      const decoded = Buffer.from(asset.content_base64, 'base64');
      fs.writeFileSync(dest, decoded, asset.asset_type === 'secret' ? { mode: 0o600 } : undefined);
      if (asset.asset_type === 'secret') {
        fs.chmodSync(dest, 0o600);
      }
      if (verbose) {
        console.log(`  write ${asset.path}`);
      }
      written++;
    } catch (err) {
      console.error(`  error writing ${asset.path}: ${err.message}`);
      errors++;
    }
  }

  return { written, skipped, errors, dropped };
}

/**
 * Handle `agentbootup brain restore [...argv]`.
 * @param {string[]} argv  Args after `brain restore`
 */
export async function runBrainRestore(argv = []) {
  let args;
  try {
    args = parseRestoreArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { target, force, dryRun, verbose, subset, brainIdArg, branchId } = args;

  // 1. Read credentials.
  const credentialState = await inspectCredentials();
  if (credentialState.state !== CREDS_STATE_OK) {
    console.error(
      formatCredentialsRecoveryMessage(credentialState, {
        missingMessage: 'No credentials. Run: agentbootup auth login --api-key <key>',
      }),
    );
    process.exit(1);
  }
  const creds = credentialState.creds;

  // 2. Resolve any existing project target strictly before considering explicit
  //    or global fallback. Fresh targets may still use a positional/global ID,
  //    but a project checkout must never be restored under a guessed identity.
  const defaultBrainId = await getBrainId();
  let localTargetBrain;
  let linkedTargetBrain;
  try {
    localTargetBrain = findLocalTargetBrain(target);
    linkedTargetBrain = await resolveLinkedBrainIdFromTarget(target);
  } catch (err) {
    console.error(`brain restore failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (
    localTargetBrain &&
    linkedTargetBrain &&
    localTargetBrain.brainId !== linkedTargetBrain.brainId
  ) {
    console.error(
      `brain restore failed: target project brain ID ${localTargetBrain.brainId} from ${localTargetBrain.configPath} ` +
      `does not match linked network brain ID ${linkedTargetBrain.brainId} (${linkedTargetBrain.projectId}); ` +
      'refusing to choose a brain.',
    );
    process.exit(1);
  }
  const targetBrain = localTargetBrain || linkedTargetBrain;
  if (brainIdArg && targetBrain && brainIdArg !== targetBrain.brainId) {
    console.error(
      `brain restore failed: positional brain ID "${brainIdArg}" conflicts with target project identity ` +
      `"${targetBrain.brainId}"; refusing to choose a brain.`,
    );
    process.exit(1);
  }
  const brainId = brainIdArg || targetBrain?.brainId || defaultBrainId;
  if (!brainId) {
    console.error(
      'No brain ID. Usage: agentbootup brain restore <brain-id>\n' +
      'Or set a default: agentbootup config set-brain <id>',
    );
    process.exit(1);
  }
  if (brainIdArg) {
    console.log(`Using brain ID from argument: ${brainIdArg}`);
  } else if (targetBrain) {
    if (defaultBrainId && targetBrain.brainId !== defaultBrainId) {
      if (targetBrain.source === 'network-link') {
        console.log(
          `note: using project brain ID ${targetBrain.brainId} from target path (${targetBrain.projectId}) instead of global default ${defaultBrainId}`,
        );
      } else {
        console.log(
          `note: using target project brain ID ${targetBrain.brainId} from ${targetBrain.configPath} instead of global default ${defaultBrainId}`,
        );
      }
    } else if (!defaultBrainId) {
      if (targetBrain.source === 'network-link') {
        console.log(
          `note: using project brain ID ${targetBrain.brainId} from target path (${targetBrain.projectId})`,
        );
      } else {
        console.log(
          `note: using target project brain ID ${targetBrain.brainId} from ${targetBrain.configPath}`,
        );
      }
    }
  }

  const { apiKey, serverUrl } = creds;

  // 3. Validate server URL.
  if (!isValidServerUrl(serverUrl)) {
    console.error(
      `Invalid server URL in credentials: "${serverUrl}". Re-run auth login with a valid --server-url.`,
    );
    process.exit(1);
  }

  // 4. Call POST /v1/boot-bundle.
  const bundleUrl = apiUrl(serverUrl, '/v1/boot-bundle');
  let assets;
  try {
    const resp = await fetch(bundleUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildRestoreBundleRequest(brainId, branchId)),
      signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      let body;
      try {
        body = await resp.json();
      } catch {
        body = undefined;
      }
      console.error(formatRestoreFailureLine(resp.status, body, brainId));
      process.exit(1);
    }

    const bundle = await resp.json();
    const raw = bundle?.data?.brain_assets;
    if (raw === null || raw === undefined) {
      console.error(
        'Server returned no brain_assets. The server may not have brain asset support enabled.\n' +
        'Ensure the server is up to date and brain assets are configured.',
      );
      process.exit(1);
    }
    if (!Array.isArray(raw)) {
      console.error('Server returned malformed brain_assets: expected an array.');
      process.exit(1);
    }
    assets = raw;
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error(
        `Request timed out after ${RESTORE_TIMEOUT_MS / 1000}s. Check your network or server URL.`,
      );
    } else {
      console.error(`Failed to fetch brain bundle: ${err.message}`);
    }
    process.exit(1);
  }

  if (verbose) {
    console.log(`Fetched ${assets.length} asset(s) from brain: ${brainId}`);
  }

  // 5. Write assets.
  const { written, skipped, errors } = writeAssets(assets, {
    target,
    force,
    dryRun,
    verbose,
    subset,
  });

  // 6. Phase 4: Provision brain.db (non-fatal — degrade gracefully on failure).
  // Always run regardless of dryRun — provisionBrainDb handles the flag
  // internally (file writes skipped; server call previews what would be provisioned).
  let brainDbMessage = null;
  try {
    const result = await provisionBrainDb({ brainId, target, apiKey, serverUrl, force, dryRun, verbose });
    brainDbMessage = result.message;
  } catch (err) {
    console.warn(`\n  [brain-db] Provisioning failed: ${err.message} — skipping. Run restore again to retry.`);
  }

  // 7. Print summary.
  const dryRunLabel = dryRun ? ' (dry-run)' : '';
  console.log(`\nBrain restore complete${dryRunLabel} (brain: ${brainId}, branch: ${branchId})`);
  console.log(`  written:  ${written}`);
  console.log(
    `  skipped:  ${skipped}${skipped > 0 && !force ? '  (use --force to overwrite)' : ''}`,
  );
  console.log(`  errors:   ${errors}`);
  console.log(`Target: ${target}`);

  // 8. Print next steps (skip if dry-run to keep output clean).
  if (!dryRun) {
    if (brainDbMessage) {
      console.log(`\n  brain.db: ${brainDbMessage}`);
    }
    console.log('\nNext steps:');
    console.log('  - Restart Claude Code to reload agents, skills, and commands');
    console.log(
      '  - Run: agentbootup daemon start --yes         (to start brain + transcript + brain-db sync)',
    );
  }

  if (errors > 0) {
    process.exit(1);
  }
}
