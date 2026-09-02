import fs from 'fs';
import path from 'path';
import { extractCwd, getFlagValue, hasFlag } from '../args.js';
import { readCredentials } from '../../auth/credentials.js';
import { apiUrl } from '../../auth/validate.js';
import { brainAssetPushHeaders } from '../../brain-asset-headers.js';
import { getBrainAssetSources, PORTABLE_POLICY_FILENAMES } from '../../brain/asset-sources.js';
import { createSecretGuard, isAllowedExtension } from '../../brain/secret-guard.js';
import { readConfig } from '../../config/config.js';
import {
  isRawMemoryPublicationAllowed,
  resolveConvergeSetting,
} from '../../memory/converge-safety.js';
import {
  resolveConfiguredProjectAgentId,
  resolveProjectAgentId,
} from '../../project-config.js';
import { collectSelectedMemoryPaths, isPublishableMemoryPath } from '../../memory/brain-backup-selection.js';
import {
  createBrainAssetSizeError,
  planBrainAssetPushBatches,
  sendBrainAssetBatchWith413Split,
} from '../../brain/asset-transport.js';

export const PUSH_BATCH_SIZE = 500;
const PUSH_TIMEOUT_MS = 30_000;
/** Maximum recursion depth for walkDirSync (safety guard; SKIP_DIR_NAMES prevents most deep traversals). */
const MAX_WALK_DEPTH = 12;

/** Directory names to skip during recursive traversal (common large/non-asset dirs). */
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '__pycache__', 'coverage']);
/** Map from --subset token → asset_type value used in sources. */
export const SUBSET_MAP = {
  memory: 'memory',
  skills: 'skill',
  config: 'config',
  protocols: 'protocol',
  agents: 'agent',
  commands: 'command',
  scripts: 'script',
  runtime: 'runtime',
};
const VERIFY_ASSET_TYPES = ['skill', 'agent', 'command', 'memory', 'protocol', 'config', 'script', 'runtime'];
const DEFAULT_BRANCH_ID = 'default';

function printUsage(io) {
  io.stdout('Usage: agentbootup brain <subcommand> [options]');
  io.stdout('');
  io.stdout('Subcommands:');
  io.stdout('  link      Link a brain to a local directory');
  io.stdout('  unlink    Remove local path (keep brain in registry)');
  io.stdout('  remove    Remove brain entirely from network config');
  io.stdout('  list      List all brains with link status');
  io.stdout('  branch    Create, list, or delete branch registry rows');
  io.stdout('  doctor    Run branch-mode runtime validation');
  io.stdout('  pull      Download brain assets from the server');
  io.stdout('  push      Push local brain assets to server');
  io.stdout('  restore   Materialize a brain into a target dir (--boot for non-interactive boot-time restore)');
  io.stdout('  verify    Compare local and remote hashes');
  io.stdout('  runtime verify  Compare local runtime files with a declared non-secret manifest');
  io.stdout('  runtime preflight  Dry-run an explicit source/target runtime bootstrap declaration');
  io.stdout('  remote-local enroll  Enroll this local daemon using a local sealed-runtime profile');
  io.stdout('  source    Inspect or explicitly select the authoritative watched source');
  io.stdout('');
  io.stdout('Options for push/verify:');
  io.stdout('  --path <dir>  Project directory (alias: --cwd)');
  io.stdout('  --subset  Comma-separated asset types. Valid values:');
  io.stdout('            memory, skills, config, protocols, agents, commands, scripts');
  io.stdout('Options for push:');
  io.stdout('  [brain-id]      Bootstrap ID for a fresh project; must match existing local identity');
  io.stdout('  --branch <id>   Target branch id (default: default)');
  io.stdout('  --dry-run       Preview discovered files only');
  io.stdout('  --initial       Bypass .gitignore for discovery (first-time seed).');
  io.stdout('                  Secret guard and extension allowlist remain active.');
  io.stdout('  --no-gitignore  Alias for --initial');
  io.stdout('  Request bodies default to an 8 MiB safety budget below the server limit.');
  io.stdout('  AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES may tune it up to the 9 MiB ceiling.');
  io.stdout('Branch commands:');
  io.stdout('  branch create <brain-id> --tenant <ref> [--branch <id>]');
  io.stdout('  branch list <brain-id> [--json]');
  io.stdout('  branch delete <brain-id> --branch <id> [--json]');
  io.stdout('  doctor --branch-mode --brain <id> --branch <id> [--json] [--cwd <path>]');
  io.stdout('Options for verify:');
  io.stdout('  --verbose  Show per-file status');
  io.stdout('  --quiet    Suppress output, return exit code only');
  io.stdout('  --json     Emit machine-readable JSON');
  io.stdout('  --asset-type  Comma-separated asset types to verify');
  io.stdout('               (uses raw types like skill,memory; differs from --subset aliases)');
  io.stdout('               (multiple values make one hashes request per type)');
  io.stdout('  --full     Local provisioning validator (no credentials required)');
  io.stdout('             Checks: skill runtimes, config files, agent/command/protocol docs');
  io.stdout('  --online   With --full: additionally ping ADMP hub for this brain identity');
  io.stdout('  --admp-url Override ADMP hub URL (used with --online)');
  io.stdout('Verify exit codes: 0=in sync / all checks passed, 1=drift / checks failed,');
  io.stdout('                   2=error, 3=never synced');
}

/**
 * Walk a directory shallowly (non-recursive), yielding absolute file paths.
 * Used for sources with watchRecursive: false (e.g. project-root config files)
 * to avoid traversing node_modules or large build artifact trees.
 * @param {string} dir
 * @yields {string}
 */
function* readdirShallow(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile()) {
      yield path.join(dir, e.name); // nosemgrep: path-join-resolve-traversal -- e.name comes from fs.readdirSync within the walked local asset tree
    }
  }
}

/**
 * Walk a directory recursively, yielding absolute file paths.
 * Skips symlinks to avoid loops.
 * @param {string} dir
 * @param {number} depth
 * @yields {string}
 */
function* walkDirSync(dir, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name); // nosemgrep: path-join-resolve-traversal -- e.name comes from fs.readdirSync within the walked local asset tree
    if (e.isDirectory()) {
      // Skip common large directories that will never contain brain assets.
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      yield* walkDirSync(full, depth + 1);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/**
 * Discover all brain assets, optionally filtered by subset of asset_types.
 * @param {string} projectRoot
 * @param {Set<string>|null} allowedTypes - set of asset_type strings, or null for all
 * @param {{ honorGitignore?: boolean, honorGitignoreNegations?: boolean }} [options]
 * @returns {Array<{ cli: string, asset_type: string, filePath: string, relFromProject: string }>}
 */
export function discoverAssets(projectRoot, allowedTypes, options = {}) {
  const sources = getBrainAssetSources(projectRoot);
  const secretGuard = createSecretGuard(projectRoot, {
    honorGitignore: options.honorGitignore !== false,
    honorGitignoreNegations: options.honorGitignoreNegations === true,
  });
  const projRoot = path.resolve(projectRoot); // nosemgrep: path-join-resolve-traversal -- projectRoot is an explicit local working directory chosen by the operator/caller
  const projRootNorm = projRoot.endsWith(path.sep) ? projRoot : projRoot + path.sep;

  const results = [];
  // Deduplicate: if two sources have overlapping rootFn() directories, a file
  // could be matched by both. A seen Set prevents pushing the same file twice.
  const seen = new Set();
  let selectedMemoryPaths = null;
  const memorySourceActive = sources.some((source) =>
    source.asset_type === 'memory' &&
    (!allowedTypes || allowedTypes.has('memory')) &&
    fs.existsSync(source.rootFn()),
  );
  if (memorySourceActive) {
    selectedMemoryPaths = collectSelectedMemoryPaths(projectRoot, 'brain asset discovery');
  }

  for (const source of sources) {
    if (allowedTypes && !allowedTypes.has(source.asset_type)) continue;

    const root = source.rootFn();
    if (source.asset_type === 'memory' && selectedMemoryPaths) {
      for (const relFromProject of selectedMemoryPaths.filter(isPublishableMemoryPath)) {
        const filePath = path.join(projRoot, ...relFromProject.split('/'));
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        results.push({
          cli: source.cli,
          asset_type: source.asset_type,
          filePath,
          relFromProject,
        });
      }
      continue;
    }

    // Warn if a category root is missing — emit and continue rather than fail (FR-4).
    // Skip the warning for the project root itself (config source) and for brain/config.json
    // since those paths may legitimately be absent on some machines.
    if (source.watchRecursive !== false && root !== projRoot) {
      try {
        fs.statSync(root);
      } catch {
        if (options.io) {
          options.io.stderr(`  warning: asset root not found, skipping (${path.relative(projRoot, root)})`);
        }
        continue;
      }
    }

    // Sources with watchRecursive: false (e.g. project-root config files) should
    // only enumerate top-level files to avoid traversing node_modules or large trees.
    const fileIter = source.watchRecursive === false ? readdirShallow(root) : walkDirSync(root);

    for (const filePath of fileIter) {
      if (!source.match(filePath)) continue;
      // Two-layer filter (PRD-0030 FR-2): allowlist first (fail-closed), then denylist.
      if (!isAllowedExtension(filePath) && !PORTABLE_POLICY_FILENAMES.has(path.basename(filePath))) continue;
      if (secretGuard.shouldSkip(filePath)) continue;

      // Skip files outside the project root (would restore to wrong location on pull).
      if (!filePath.startsWith(projRootNorm)) continue;
      // Skip duplicates from overlapping source roots.
      if (seen.has(filePath)) continue;
      seen.add(filePath);

      const relFromProject = filePath.slice(projRootNorm.length).split(path.sep).join('/');

      results.push({
        cli: source.cli,
        asset_type: source.asset_type,
        filePath,
        relFromProject,
      });
    }
  }

  results.sort((a, b) => a.relFromProject.localeCompare(b.relFromProject));
  return results;
}

function parseSubsetArg(args, io, contextLabel, errorCode = 1) {
  if (!hasFlag(args, '--subset')) return { allowedTypes: null, errorCode: null };

  const subsetRaw = getFlagValue(args, '--subset');
  if (!subsetRaw) {
    io.stderr(`${contextLabel}: --subset requires a value`);
    return { allowedTypes: null, errorCode };
  }

  const allowedTypes = new Set();
  for (const token of subsetRaw.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const mapped = SUBSET_MAP[trimmed];
    if (mapped) {
      allowedTypes.add(mapped);
    } else {
      io.stderr(`${contextLabel}: unknown --subset value "${trimmed}". Valid values: ${Object.keys(SUBSET_MAP).join(', ')}`);
      return { allowedTypes: null, errorCode };
    }
  }

  if (allowedTypes.size === 0) {
    io.stderr(`${contextLabel}: --subset value cannot be empty. Valid values: ${Object.keys(SUBSET_MAP).join(', ')}`);
    return { allowedTypes: null, errorCode };
  }

  return { allowedTypes, errorCode: null };
}

function parseAssetTypeArg(args, io, contextLabel, errorCode = 2) {
  if (!hasFlag(args, '--asset-type')) return { allowedTypes: null, errorCode: null };

  const raw = getFlagValue(args, '--asset-type');
  if (!raw) {
    io.stderr(`${contextLabel}: --asset-type requires a value`);
    return { allowedTypes: null, errorCode };
  }

  const allowedTypes = new Set();
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (VERIFY_ASSET_TYPES.includes(trimmed)) {
      allowedTypes.add(trimmed);
    } else {
      io.stderr(
        `${contextLabel}: unknown --asset-type value "${trimmed}". Valid values: ${VERIFY_ASSET_TYPES.join(', ')}`,
      );
      return { allowedTypes: null, errorCode };
    }
  }

  if (allowedTypes.size === 0) {
    io.stderr(`${contextLabel}: --asset-type value cannot be empty. Valid values: ${VERIFY_ASSET_TYPES.join(', ')}`);
    return { allowedTypes: null, errorCode };
  }

  return { allowedTypes, errorCode: null };
}

function parseBranchFlag(args, io, contextLabel, errorCode = 1) {
  if (!hasFlag(args, '--branch')) {
    return { branchId: DEFAULT_BRANCH_ID, errorCode: null };
  }
  const branchId = getFlagValue(args, '--branch')?.trim();
  if (!branchId || branchId.startsWith('-')) {
    io.stderr(`${contextLabel}: --branch requires a value`);
    return { branchId: DEFAULT_BRANCH_ID, errorCode };
  }
  return { branchId, errorCode: null };
}

function parseOptionalBrainIdArg(args) {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--subset' || token === '--asset-type' || token === '--path' || token === '--cwd' || token === '--branch') {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token.trim();
  }
  return null;
}

function slugifyBranchId(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

async function readRequiredCredentials(io, contextLabel) {
  const creds = await readCredentials();
  if (!creds) {
    io.stderr(`${contextLabel}: no credentials — run: agentbootup auth login`);
    return null;
  }
  const { apiKey, serverUrl } = creds;
  if (!apiKey || !serverUrl) {
    io.stderr(`${contextLabel}: credentials are incomplete — run: agentbootup auth login`);
    return null;
  }
  return { apiKey, serverUrl };
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

/**
 * runBrainPush — implements `agentbootup brain push`.
 *
 * @param {string[]} args
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 * @param {string} cwd - working directory with --cwd already extracted by caller
 * @returns {Promise<number>} exit code
 */
export async function runBrainPush(args, io, cwd) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printUsage(io);
    return 0;
  }

  // -- Flags (validated first for fast feedback on typos) --------------------
  const dryRun = hasFlag(args, '--dry-run');
  const isInitial = hasFlag(args, '--initial') || hasFlag(args, '--no-gitignore');

  const subset = parseSubsetArg(args, io, 'brain push failed');
  if (subset.errorCode !== null) return subset.errorCode;
  const allowedTypes = subset.allowedTypes;
  const parsedBranch = parseBranchFlag(args, io, 'brain push failed');
  if (parsedBranch.errorCode !== null) return parsedBranch.errorCode;
  const branchId = parsedBranch.branchId;

  // -- Credentials -----------------------------------------------------------
  const creds = await readRequiredCredentials(io, 'brain push failed');
  if (!creds) {
    return 1;
  }
  const { apiKey, serverUrl } = creds;

  // -- Brain config ----------------------------------------------------------
  const requestedBrainId = parseOptionalBrainIdArg(args);
  let localBrainId;
  try {
    localBrainId = resolveConfiguredProjectAgentId(cwd);
  } catch (err) {
    io.stderr(`brain push failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (requestedBrainId && localBrainId && requestedBrainId !== localBrainId) {
    io.stderr(
      `brain push failed: requested brain "${requestedBrainId}" conflicts with local project identity ` +
      `"${localBrainId}"; refusing to choose a brain.`,
    );
    return 1;
  }
  const brainId = requestedBrainId || localBrainId;
  if (!brainId) {
    try {
      resolveProjectAgentId(cwd);
    } catch (err) {
      io.stderr(`brain push failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    io.stderr('brain push failed: no project identity exists; add agent_id (canonical) or agentId (compatibility)');
    return 1;
  }

  // -- Discover assets -------------------------------------------------------
  if (isInitial) {
    io.stderr('warning: gitignore bypass is active (--initial / --no-gitignore). Secret guard and extension allowlist remain active.');
  }
  let discoveredAssets;
  try {
    discoveredAssets = discoverAssets(cwd, allowedTypes, { io, honorGitignore: !isInitial });
  } catch (error) {
    io.stderr(`brain push failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let assets = discoveredAssets;
  const rawMemoryCount = assets.filter((asset) => asset.asset_type === 'memory').length;
  if (rawMemoryCount > 0) {
    let setting;
    try {
      setting = resolveConvergeSetting(await readConfig());
    } catch (err) {
      setting = { enabled: true, source: 'config_error_fail_closed' };
      io.stderr(`warning: converge config read failed; raw memory publication fails closed: ${err?.message || err}`);
    }
    // A one-shot CLI process has not completed the daemon's boot-and-arm
    // pull/apply pass, so its process-local gate is closed. The explicit
    // converge-off rollback is the sole exception.
    if (!isRawMemoryPublicationAllowed(setting, false)) {
      assets = assets.filter((asset) => asset.asset_type !== 'memory');
      io.stderr(
        `warning: raw memory publication suppressed for ${rawMemoryCount} file${rawMemoryCount === 1 ? '' : 's'} ` +
        `(memory converge is on; source=${setting.source}). ` +
        'Use `agentbootup memory publish` for snapshot convergence. ' +
        'An explicit `agentbootup config set-converge off` rollback re-enables the legacy raw path.'
      );
    }
  }

  if (assets.length === 0) {
    if (discoveredAssets.length === 0) {
      io.stderr('warning: no brain assets found in this directory');
      io.stderr('  Expected: .claude/skills/, memory/, .ai/protocols/, CLAUDE.md');
      io.stderr('  Is this a project directory with a provisioned brain?');
      return 0;
    } else {
      io.stderr('warning: no publishable brain assets remain after convergence safety filtering');
    }
    // Preserve dry-run as an identity/prerequisite check even when convergence
    // safety suppresses every discovered raw-memory asset.
    if (!dryRun) return 0;
  }

  // -- Dry run ---------------------------------------------------------------
  if (dryRun) {
    io.stdout(`Brain push (dry-run): ${brainId} [branch: ${branchId}] → ${serverUrl}`);

    // Per-category counts (PRD-0030 FR-3)
    const counts = {};
    for (const a of assets) {
      counts[a.asset_type] = (counts[a.asset_type] ?? 0) + 1;
    }
    const typeOrder = ['skill', 'agent', 'command', 'memory', 'protocol', 'script', 'config'];
    for (const t of typeOrder) {
      if (counts[t]) io.stdout(`  ${t}: ${counts[t]} file${counts[t] === 1 ? '' : 's'}`);
    }
    for (const t of Object.keys(counts).sort()) {
      if (!typeOrder.includes(t)) io.stdout(`  ${t}: ${counts[t]} file${counts[t] === 1 ? '' : 's'}`);
    }
    io.stdout(`  Total: ${assets.length} file${assets.length === 1 ? '' : 's'}`);
    io.stdout('');
    io.stdout('  Files that would be pushed:');
    for (const a of assets) {
      let size = 0;
      try {
        size = fs.statSync(a.filePath).size;
      } catch {
        // ignore
      }
      io.stdout(`    ${a.relFromProject} (${size} bytes)`);
    }
    return 0;
  }

  // -- Push ------------------------------------------------------------------
  io.stdout(`Brain push: ${brainId} [branch: ${branchId}] → ${serverUrl}`);
  io.stdout(`  Discovered ${assets.length} files`);

  let totalPushed = 0;
  let totalErrors = 0;
  const errorDetails = [];
  let batchCount = 0;

  const files = [];
  for (const a of assets) {
    try {
      const buf = fs.readFileSync(a.filePath);
      files.push({
        path: a.relFromProject,
        content_base64: buf.toString('base64'),
        asset_type: a.asset_type,
        cli: a.cli,
      });
    } catch (err) {
      totalErrors++;
      errorDetails.push(`${a.relFromProject}: failed to read file: ${err.message}`);
    }
  }

  const makePayload = (batchFiles) => ({ branch_id: branchId, files: batchFiles });
  let plan;
  try {
    plan = planBrainAssetPushBatches({ items: files, maxFiles: PUSH_BATCH_SIZE, makePayload });
  } catch (err) {
    io.stderr(`brain push failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (const oversized of plan.oversized) {
    totalErrors++;
    errorDetails.push(createBrainAssetSizeError(oversized).message);
  }

  const endpoint = apiUrl(serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}/push`);
  for (const plannedBatch of plan.batches) {
    const settledPaths = new Set();
    try {
      await sendBrainAssetBatchWith413Split(plannedBatch, {
        makePayload,
        send: async (requestBatch) => {
          batchCount++;
          io.stdout(`  Pushing batch ${batchCount}...`);
          const controller = new AbortController();
          const timerId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
          try {
            return await fetch(endpoint, {
              method: 'POST',
              headers: brainAssetPushHeaders(apiKey),
              body: requestBatch.body,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timerId);
          }
        },
        onLeaf: async ({ batch: leafBatch, response: resp }) => {
          for (const file of leafBatch.items) settledPaths.add(file.path);
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            const errMsg = resp.status === 413
              ? createBrainAssetSizeError({
                  path: leafBatch.items[0].path,
                  encodedBytes: leafBatch.encodedBytes,
                  budget: plan.budget,
                  status: 413,
                }).message
              : `HTTP ${resp.status}: ${body.slice(0, 200)}`;
            for (const file of leafBatch.items) {
              totalErrors++;
              errorDetails.push(resp.status === 413 ? errMsg : `${file.path}: ${errMsg}`);
            }
            return;
          }
          const respJson = await resp.json().catch(() => null);
          const fileResults = respJson?.data?.results ?? null;
          if (!fileResults) {
            io.stderr(`  warning: server returned no per-file results for batch ${batchCount}; assuming all pushed`);
            totalPushed += leafBatch.items.length;
            return;
          }
          const resultByPath = new Map(fileResults.map((result) => [result.path, result]));
          for (const file of leafBatch.items) {
            const result = resultByPath.get(file.path);
            if (result?.status === 'pushed' || result?.status === 'updated') totalPushed++;
            else {
              totalErrors++;
              errorDetails.push(`${file.path}: ${result?.error ?? 'server error'}`);
            }
          }
        },
      });
    } catch (err) {
      const errMsg = err.name === 'AbortError' ? 'timeout after 30s' : err.message;
      for (const file of plannedBatch.items.filter((item) => !settledPaths.has(item.path))) {
        totalErrors++;
        errorDetails.push(`${file.path}: ${errMsg}`);
      }
    }
  }

  // -- Summary ---------------------------------------------------------------
  if (totalErrors === 0) {
    io.stdout(`  Pushed ${totalPushed} file${totalPushed !== 1 ? 's' : ''} in ${batchCount} batch${batchCount !== 1 ? 'es' : ''}`);
    io.stdout('  Errors: 0');
  } else {
    io.stderr(`  Pushed ${totalPushed} file${totalPushed !== 1 ? 's' : ''}, ${totalErrors} error${totalErrors !== 1 ? 's' : ''}:`);
    for (const detail of errorDetails) {
      io.stderr(`    - ${detail}`);
    }
  }
  // Done. goes to stderr on errors so scripts can detect failures on a single stream.
  if (totalErrors > 0) {
    io.stderr('Done.');
  } else {
    io.stdout('Done.');
  }

  return totalErrors > 0 ? 1 : 0;
}

function parseBranchCommandArgs(args) {
  const action = args[0];
  const rest = args.slice(1);
  let brainId = null;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--tenant' || token === '--branch') {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    brainId = token.trim();
    break;
  }
  return { action, rest, brainId };
}

export async function runBrainBranchCommand(args, io) {
  if (!args.length || hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printUsage(io);
    return 0;
  }

  const { action, rest, brainId } = parseBranchCommandArgs(args);
  const creds = await readRequiredCredentials(io, 'brain branch failed');
  if (!creds) return 1;
  const { apiKey, serverUrl } = creds;

  if (!brainId) {
    io.stderr('brain branch failed: missing <brain-id>');
    return 1;
  }

  if (action === 'list') {
    const asJson = hasFlag(rest, '--json');
    const { response, body } = await fetchJson(
      apiUrl(serverUrl, `/v1/brains/${encodeURIComponent(brainId)}/branches`),
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!response.ok) {
      io.stderr(`brain branch list failed: ${body?.error?.message ?? `HTTP ${response.status}`}`);
      return 1;
    }
    if (asJson) {
      io.stdout(JSON.stringify(body?.data ?? {}, null, 2));
      return 0;
    }
    const branches = body?.data?.branches ?? [];
    io.stdout(`Brain branches: ${brainId}`);
    for (const branch of branches) {
      io.stdout(`  ${branch.branch_id}  tenant=${branch.tenant_ref ?? '-'}  status=${branch.status}`);
    }
    io.stdout(`  total: ${branches.length}`);
    return 0;
  }

  if (action === 'create') {
    const tenantRef = getFlagValue(rest, '--tenant')?.trim();
    if (!tenantRef) {
      io.stderr('brain branch create failed: --tenant <ref> is required');
      return 1;
    }
    const branchId = getFlagValue(rest, '--branch')?.trim() || slugifyBranchId(tenantRef);
    if (!branchId) {
      io.stderr('brain branch create failed: could not derive a valid branch id; pass --branch <id>');
      return 1;
    }
    const payload = { branch_id: branchId, tenant_ref: tenantRef };
    const { response, body } = await fetchJson(
      apiUrl(serverUrl, `/v1/brains/${encodeURIComponent(brainId)}/branches`),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      io.stderr(`brain branch create failed: ${body?.error?.message ?? `HTTP ${response.status}`}`);
      return 1;
    }
    io.stdout(`Created branch ${branchId} for ${brainId} (tenant: ${tenantRef})`);
    return 0;
  }

  if (action === 'delete') {
    const branchId = getFlagValue(rest, '--branch')?.trim();
    if (!branchId) {
      io.stderr('brain branch delete failed: --branch <id> is required');
      return 1;
    }
    const asJson = hasFlag(rest, '--json');
    const { response, body } = await fetchJson(
      apiUrl(serverUrl, `/v1/brains/${encodeURIComponent(brainId)}/branches/${encodeURIComponent(branchId)}`),
      { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!response.ok) {
      io.stderr(`brain branch delete failed: ${body?.error?.message ?? `HTTP ${response.status}`}`);
      return 1;
    }
    if (asJson) {
      io.stdout(JSON.stringify(body?.data ?? {}, null, 2));
      return 0;
    }
    io.stdout(`Deleted branch ${branchId} for ${brainId}`);
    return 0;
  }

  io.stderr(`Unknown brain branch subcommand: ${action}`);
  printUsage(io);
  return 1;
}

export async function runBrainVerify(args, io, cwd) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printUsage(io);
    return 0;
  }

  const verbose = hasFlag(args, '--verbose');
  const quiet = hasFlag(args, '--quiet');
  const asJson = hasFlag(args, '--json');
  const full = hasFlag(args, '--full');
  const online = hasFlag(args, '--online');

  // ── --full mode: local provisioning validator (FR-15, FR-16) ─────────────────
  if (full) {
    try {
      const { runVerifyFull } = await import('../../brain/verify.js');
      const admpUrl = getFlagValue(args, '--admp-url');
      const failures = await runVerifyFull(cwd, { online, admpUrl: admpUrl ?? undefined });

      if (asJson) {
        io.stdout(JSON.stringify({ ok: failures.length === 0, failures }));
        return failures.length > 0 ? 1 : 0;
      }

      if (failures.length === 0) {
        if (!quiet) io.stdout('brain verify --full: all checks passed');
        return 0;
      }

      if (!quiet) {
        io.stdout(`brain verify --full: ${failures.length} check(s) failed`);
        for (const f of failures) {
          io.stdout(`  [${f.check}] ${f.error}`);
        }
      }
      return 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (asJson) {
        io.stdout(JSON.stringify({ ok: false, error: message }));
      } else {
        io.stderr(`brain verify --full failed: ${message}`);
      }
      return 2;
    }
  }

  if (hasFlag(args, '--subset') && hasFlag(args, '--asset-type')) {
    io.stderr('brain verify failed: use either --subset or --asset-type, not both');
    return 2;
  }

  const assetTypeFilter = parseAssetTypeArg(args, io, 'brain verify failed', 2);
  if (assetTypeFilter.errorCode !== null) return assetTypeFilter.errorCode;

  const subset = parseSubsetArg(args, io, 'brain verify failed', 2);
  if (subset.errorCode !== null) return subset.errorCode;

  const allowedTypes = assetTypeFilter.allowedTypes ?? subset.allowedTypes;

  const creds = await readCredentials();
  if (!creds) {
    io.stderr('brain verify failed: no credentials - run: agentbootup auth login');
    return 2;
  }
  const { apiKey, serverUrl } = creds;
  if (!apiKey || !serverUrl) {
    io.stderr('brain verify failed: credentials are incomplete - run: agentbootup auth login');
    return 2;
  }

  let brainId;
  try {
    brainId = resolveProjectAgentId(cwd);
  } catch (err) {
    io.stderr(`brain verify failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const { computeLocalHashes, diffInventories, formatVerifyOutput } = await import('../../brain/verify.js');
  let localMap;
  try {
    localMap = computeLocalHashes(cwd, allowedTypes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`brain verify failed: ${message}`);
    return 2;
  }

  const remoteFiles = [];
  const typeFilters = allowedTypes ? [...allowedTypes] : [null];
  try {
    for (const assetType of typeFilters) {
      const query = assetType ? `?asset_type=${encodeURIComponent(assetType)}` : '';
      const endpoint = apiUrl(serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}/hashes${query}`);
      const resp = await fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        io.stderr(`brain verify failed: HTTP ${resp.status}: ${body.slice(0, 200)}`);
        return 2;
      }
      const payload = await resp.json().catch(() => null);
      const files = payload?.data?.files;
      if (!Array.isArray(files)) {
        io.stderr('brain verify failed: invalid server response (missing data.files array)');
        return 2;
      }
      for (const file of files) {
        if (
          typeof file?.path !== 'string' ||
          typeof file?.hash !== 'string' ||
          typeof file?.size !== 'number'
        ) {
          io.stderr('brain verify failed: invalid server response (invalid hash record)');
          return 2;
        }
      }
      remoteFiles.push(...files);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`brain verify failed: ${message}`);
    return 2;
  }

  const result = diffInventories(localMap, remoteFiles);
  const formatted = formatVerifyOutput(result, brainId, serverUrl, {
    verbose,
    quiet,
    json: asJson,
  });

  if (!quiet && formatted.text) {
    // Verify output is primary command output; keep all formatted results on stdout.
    io.stdout(formatted.text);
  }

  return formatted.exitCode;
}

/**
 * runBrainCommand — dispatcher for `agentbootup brain <subcommand>`.
 *
 * @param {string[]} args  — argv after 'brain'
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 * @returns {Promise<number>}
 */
export async function runBrainCommand(args, io) {
  if (!args || args.length === 0 || (args.length === 1 && (hasFlag(args, '--help') || hasFlag(args, '-h')))) {
    printUsage(io);
    return 0;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  const extracted = extractCwd(subArgs);
  const cwd = path.resolve(extracted.cwd); // nosemgrep: path-join-resolve-traversal -- --cwd is an explicit local working directory chosen by the operator
  const remainingArgs = extracted.args;

  switch (subcommand) {
    case 'pull': {
      const { runBrainPull } = await import('../../brain/pull.js');
      return runBrainPull([...remainingArgs, '--path', cwd], io);
    }
    case 'push':
      return runBrainPush(remainingArgs, io, cwd);
    case 'verify':
      return runBrainVerify(remainingArgs, io, cwd);
    case 'runtime': {
      const { runBrainRuntime } = await import('../../brain/runtime-cli.js');
      return runBrainRuntime([...remainingArgs, '--cwd', cwd], io);
    }
    case 'remote-local': {
      const { runRemoteLocalEnrollment } = await import('../../daemon/remote-local-enrollment-cli.mjs');
      return runRemoteLocalEnrollment(remainingArgs, io);
    }
    case 'source': {
      const { runBrainSource } = await import('../../brain/source-cli.js');
      return runBrainSource(remainingArgs, io);
    }
    case 'branch':
      return runBrainBranchCommand(remainingArgs, io);
    case 'doctor': {
      const { handleDoctor } = await import('../../doctor/doctor.js');
      return handleDoctor(remainingArgs, {
        log: (line) => io.stdout(line),
      });
    }
    case 'link':
    case 'unlink':
    case 'remove':
    case 'list': {
      const { runBrainLink, runBrainUnlink, runBrainRemove, runBrainList } = await import('../../brain/link.js');
      if (subcommand === 'link') return runBrainLink(remainingArgs, io);
      if (subcommand === 'unlink') return runBrainUnlink(remainingArgs, io);
      if (subcommand === 'remove') return runBrainRemove(remainingArgs, io);
      return runBrainList(remainingArgs, io);
    }
    default:
      io.stderr(`Unknown brain subcommand: ${subcommand}`);
      printUsage(io);
      return 1;
  }
}
