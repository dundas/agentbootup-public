import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'node:child_process';
import { discoverTranscriptFiles } from '../brain/transcript-discovery.js';
import { createSecretGuard } from '../brain/secret-guard.js';
import { handleDaemonRestore } from '../sync/restore.js';
import { extractCwd, getFlagValue, getPositionalArgs, hasFlag } from '../network/args.js';
import { getShareConfig, normalizeShareConfig, setShareConfig } from '../config/config.js';
import { getMachineId } from '../machine-id/machine-id.js';
import { loadNetworkConfig, resolveNetworkConfigPath, resolveProjectPath, validateNetworkConfig } from '../network/config.js';
import {
  backupBrainSecret,
  getBrainSecretPath,
  getVaultSecretPath,
  mergeVaultBrainSecret,
  mergePortableAdmpIdentity,
  readProjectBrainSecret,
  validatePortableAgentId,
  writeProjectBrainSecret,
} from '../network/brain/config-portability.js';
import { resolveProjectMetadataPath, restoreFileSnapshot, snapshotFile } from '../network/brain/project-state.js';
import {
  getAgentId,
  loadProjectConfig,
  resolveProjectAgentId,
} from '../project-config.js';
import os from 'os';
import { discoverAssets } from '../network/commands/brain.js';

const STATE_FILE = '.brain/share-state.json';
const DEFAULT_BRAIN_ROOT = 'brains';
const LOCK_STALE_MS = 5 * 60 * 1000;
const VALID_PROVIDERS = new Set(['smb', 'nfs', 'local']);
const SHARE_ROOT_SPECS = [
  {
    relDir: 'brain',
    match: (relFromProject) => relFromProject !== 'brain/config.secret.json',
  },
  {
    relDir: '.claude/skills',
    match: () => true,
  },
  {
    relDir: '.claude/agents',
    match: () => true,
  },
  {
    relDir: '.claude/commands',
    match: () => true,
  },
  {
    relDir: '.brain/scripts',
    match: () => true,
  },
  {
    relDir: '.agents/skills',
    match: () => true,
  },
  {
    relDir: '.agents/agents',
    match: () => true,
  },
  {
    relDir: '.agents/commands',
    match: () => true,
  },
];
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '__pycache__', 'coverage']);

function printUsage(io) {
  io.stdout('Usage: agentbootup share <subcommand> [options]');
  io.stdout('');
  io.stdout('Subcommands:');
  io.stdout('  configure --provider <smb|nfs|local> --path <path> [--remote <remote>] [--mount-point <path>] [--brain-root <dir>]');
  io.stdout('  mount');
  io.stdout('  unmount');
  io.stdout('  status [--json]');
  io.stdout('  push [project-id] [--cwd <path>] [--dry-run]');
  io.stdout('  pull [project-id] [--cwd <path>] [--dry-run]');
}

function resolveSharePath(share) {
  if (!share) return '';
  if (share.provider === 'local') return share.path;
  return share.mount_point || share.path;
}

function defaultRunner(command) {
  const proc = spawnSync(command[0], command.slice(1), { encoding: 'utf-8' });
  return {
    code: proc.status ?? 1,
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim(),
  };
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function safeJoin(base, ...parts) {
  const resolved = path.resolve(base, ...parts);
  const root = path.resolve(base);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path traversal detected: ${resolved}`);
  }
  return resolved;
}

function* walkFiles(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function discoverShareAssets(projectRoot) {
  const root = path.resolve(projectRoot);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  const secretGuard = createSecretGuard(root, { honorGitignore: false, honorGitignoreNegations: true });
  const seen = new Set();
  // `discoverAssets()` covers the canonical sync surface. SHARE_ROOT_SPECS adds
  // share-only portable roots such as the broader `brain/` subtree and nested
  // CLI runtime trees that the server sync surface intentionally omits.
  const assets = discoverAssets(projectRoot, null, {
    honorGitignore: false,
    honorGitignoreNegations: true,
  }).map((asset) => ({
    filePath: asset.filePath,
    relFromProject: asset.relFromProject,
  }));

  for (const asset of assets) {
    seen.add(asset.filePath);
  }

  for (const spec of SHARE_ROOT_SPECS) {
    const absDir = path.join(root, spec.relDir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) continue;
    for (const filePath of walkFiles(absDir)) {
      if (!filePath.startsWith(rootPrefix)) continue;
      if (seen.has(filePath)) continue;
      if (secretGuard.shouldSkip(filePath)) continue;
      const relFromProject = filePath.slice(rootPrefix.length).split(path.sep).join('/');
      if (!spec.match(relFromProject)) continue;
      seen.add(filePath);
      assets.push({
        filePath,
        relFromProject,
      });
    }
  }

  assets.sort((a, b) => a.relFromProject.localeCompare(b.relFromProject));
  return assets;
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizePathSegment(value, fallback = 'unknown') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim().replaceAll(/[^A-Za-z0-9._-]/g, '-');
  return cleaned || fallback;
}

function validateBrainId(brainId) {
  return validatePortableAgentId(brainId);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function resolveProjectEffectiveBrainId(project, networkRoot = '') {
  if (!project || typeof project !== 'object') return '';
  const metadataPath = resolveProjectMetadataPath(project, networkRoot);
  if (metadataPath) return getAgentId(metadataPath) || '';
  return project.agent_id || '';
}

function loadProjectsForNetworkRoot(networkRoot) {
  if (!networkRoot) return { projects: [], loadedRoot: '' };
  try {
    const loaded = loadNetworkConfig(networkRoot);
    if (loaded.config.role !== 'network') return { projects: [], loadedRoot: '' };
    return { projects: loaded.config.projects || [], loadedRoot: networkRoot };
  } catch {
    return { projects: [], loadedRoot: '' };
  }
}

function findAgentIdOwner(projects, projectPath, projectId, brainId, networkRoot = '') {
  if (!brainId) return null;
  const resolvedProjectPath = projectPath ? path.resolve(projectPath) : '';
  return projects.find((row) => {
    if (!row || typeof row !== 'object') return false;
    if (projectId && row.id === projectId) return false;
    if (projectPath && typeof row.path === 'string') {
      if (row.path === projectPath) return false;
      if (networkRoot) {
        try {
          if (resolveProjectPath(row.path, networkRoot) === resolvedProjectPath) return false;
        } catch {
          // Ignore malformed paths and continue ownership detection.
        }
      }
    }
    return row.agent_id === brainId || resolveProjectEffectiveBrainId(row, networkRoot) === brainId;
  }) || null;
}

function findProjectByResolvedPath(projects, projectPath, networkRoot = '') {
  if (!projectPath || !networkRoot) return null;
  const resolvedProjectPath = path.resolve(projectPath);
  return projects.find((row) => {
    if (!row || typeof row.path !== 'string') return false;
    try {
      return resolveProjectPath(row.path, networkRoot) === resolvedProjectPath;
    } catch {
      return false;
    }
  }) || null;
}

async function writeJson(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

async function withShareLock(lockDir, fn) {
  await fsp.mkdir(path.dirname(lockDir), { recursive: true });
  try {
    await fsp.mkdir(lockDir);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const stat = await fsp.stat(lockDir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fsp.rm(lockDir, { recursive: true, force: true });
        await fsp.mkdir(lockDir);
      } else {
        throw new Error('share sync is locked by another process');
      }
    } else {
      throw err;
    }
  }

  try {
    return await fn();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveProjectContext(projectId, cwd) {
  let projects = [];
  let networkRoot = '';
  let localProjectMatch = null;
  try {
    const loaded = loadNetworkConfig(cwd);
    if (loaded.config.role === 'network') {
      projects = loaded.config.projects || [];
      networkRoot = cwd;
    } else if (loaded.config.role === 'project') {
      networkRoot = resolveProjectNetworkRoot(cwd);
      const loadedNetwork = loadProjectsForNetworkRoot(networkRoot);
      projects = loadedNetwork.projects;
      localProjectMatch = findProjectByResolvedPath(projects, cwd, loadedNetwork.loadedRoot || networkRoot);
    }
  } catch {
    projects = [];
  }

  if (projectId) {
    const projectRoot = path.resolve(cwd);
    const fallbackLocalBrainId = getAgentId(projectRoot) || '';
    const fallbackLocalLabel = localProjectMatch?.id || path.basename(projectRoot);
    if (projectId === fallbackLocalBrainId || projectId === fallbackLocalLabel) {
      const requiredLocalBrainId = resolveProjectAgentId(projectRoot);
      const owner = findAgentIdOwner(
        projects,
        projectRoot,
        localProjectMatch?.id || '',
        requiredLocalBrainId,
        networkRoot,
      );
      if (owner) {
        throw new Error(`local brain id ${requiredLocalBrainId} already belongs to project ${owner.id || '(unknown)'}`);
      }
      return {
        projectRoot,
        brainId: requiredLocalBrainId,
        legacyBrainId: localProjectMatch?.agent_id || '',
        networkRoot,
        label: localProjectMatch?.id || fallbackLocalLabel,
      };
    }
    const project = projects.find((row) => row.id === projectId || row.agent_id === projectId)
      || (localProjectMatch && (localProjectMatch.id === projectId || localProjectMatch.agent_id === projectId)
        ? localProjectMatch
        : null);
    if (!project || !project.path) {
      throw new Error(`unknown project ${projectId}`);
    }
    const linkedProjectRoot = resolveProjectMetadataPath(project, networkRoot) || project.path;
    const claimedBrainId = resolveProjectAgentId(linkedProjectRoot);
    const owner = findAgentIdOwner(projects, linkedProjectRoot, project.id, claimedBrainId, networkRoot);
    if (owner) {
      throw new Error(`local brain id ${claimedBrainId} already belongs to project ${owner.id || '(unknown)'}`);
    }
    return {
      projectRoot: linkedProjectRoot,
      brainId: claimedBrainId,
      legacyBrainId: project.agent_id || '',
      networkRoot,
      label: project.id,
    };
  }

  const cwdResolved = path.resolve(cwd);
  const match = projects.find((row) => {
    if (!row.path) return false;
    const root = path.resolve(row.path);
    return cwdResolved === root || cwdResolved.startsWith(root + path.sep);
  });
  if (match && match.path) {
    const matchedProjectRoot = resolveProjectMetadataPath(match, networkRoot) || match.path;
    const claimedBrainId = resolveProjectAgentId(matchedProjectRoot);
    const owner = findAgentIdOwner(projects, matchedProjectRoot, match.id, claimedBrainId, networkRoot);
    if (owner) {
      throw new Error(`local brain id ${claimedBrainId} already belongs to project ${owner.id || '(unknown)'}`);
    }
    return {
      projectRoot: matchedProjectRoot,
      brainId: claimedBrainId,
      legacyBrainId: match.agent_id || '',
      networkRoot,
      label: match.id,
    };
  }

  const projectRoot = path.resolve(cwd);
  const brainId = getAgentId(projectRoot);
  if (!brainId) {
    throw new Error('unable to resolve project brain id from --cwd or agentbootup.json');
  }
  const projectNetworkRoot = resolveProjectNetworkRoot(projectRoot);
  const { projects: networkProjects, loadedRoot } = loadProjectsForNetworkRoot(projectNetworkRoot);
  const projectMatch = findProjectByResolvedPath(networkProjects, projectRoot, loadedRoot);
  const owner = findAgentIdOwner(
    networkProjects,
    projectRoot,
    projectMatch?.id || '',
    brainId,
    projectNetworkRoot
  );
  if (owner) {
    throw new Error(`local brain id ${brainId} already belongs to project ${owner.id || '(unknown)'}`);
  }
  return {
    projectRoot,
    brainId,
    legacyBrainId: projectMatch?.agent_id || '',
    networkRoot: projectNetworkRoot,
    label: projectMatch?.id || path.basename(projectRoot),
  };
}

function getStatePath(projectRoot) {
  return path.join(projectRoot, STATE_FILE);
}

async function readLocalState(projectRoot) {
  return readJson(getStatePath(projectRoot), { files: {}, last_pulled_at: '', last_pushed_at: '' });
}

async function writeLocalState(projectRoot, state) {
  await writeJson(getStatePath(projectRoot), state);
}

function resolveNetworkRoot(cwd) {
  try {
    const loaded = loadNetworkConfig(cwd);
    if (loaded.config.role === 'network') return cwd;
  } catch {
    // Treat non-network cwd as a project-only invocation.
  }
  return '';
}

function resolveProjectNetworkRoot(projectRoot) {
  try {
    const { config } = loadProjectConfig(projectRoot);
    const networkRaw = typeof config.network === 'string' ? config.network.trim() : '';
    if (!networkRaw) return '';
    return networkRaw.startsWith('~')
      ? networkRaw.replace(/^~(\/|$)/, os.homedir() + path.sep)
      : path.resolve(projectRoot, networkRaw);
  } catch {
    return '';
  }
}

function validateShareNetworkRoot(networkRoot, io) {
  if (!networkRoot) return '';
  try {
    const loaded = loadNetworkConfig(networkRoot);
    if (loaded.config.role !== 'network') {
      io.stderr(`share push: skipped portable ADMP vault backup because ${networkRoot} is not a network root`);
      return '';
    }
    return networkRoot;
  } catch (err) {
    io.stderr(`share push: skipped portable ADMP vault backup because network root is invalid (${err.message})`);
    return '';
  }
}

function snapshotDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return {
      exists: false,
      restore(targetPath) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      },
      cleanup() {},
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-share-root-'));
  const snapshotPath = path.join(tempRoot, 'snapshot');
  fs.cpSync(dirPath, snapshotPath, { recursive: true });
  return {
    exists: true,
    restore(targetPath) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.cpSync(snapshotPath, targetPath, { recursive: true });
    },
    cleanup() {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function preparePortableAdmpOwnership(projectRoot, brainId, legacyBrainId, networkRoot, io, options = {}) {
  if (options.dryRun) {
    return {
      ok: true,
      commit: () => ({ ok: true, rollback() {} }),
    };
  }
  let secret = {};
  let secretReadFailed = false;
  try {
    secret = readProjectBrainSecret(projectRoot);
  } catch (err) {
    io.stderr(`share push: failed to read brain secret inventory (${err.message})`);
    secretReadFailed = true;
  }
  if (secretReadFailed) {
    return {
      ok: true,
      commit: () => {
        io.stderr('share push: skipped portable ADMP secret migration because brain secret inventory is malformed');
        return { ok: true, rollback() {} };
      },
    };
  }
  const validatedNetworkRoot = validateShareNetworkRoot(networkRoot, io);
  const secretPath = getBrainSecretPath(projectRoot);
  const secretSnapshot = snapshotFile(secretPath);
  const vaultPath = validatedNetworkRoot ? getVaultSecretPath(validatedNetworkRoot, brainId) : '';
  const vaultSnapshot = vaultPath ? snapshotFile(vaultPath) : null;
  const rollback = () => {
    try {
      restoreFileSnapshot(secretPath, secretSnapshot);
      if (vaultPath) restoreFileSnapshot(vaultPath, vaultSnapshot);
    } catch (err) {
      io.stderr(`share push: failed to roll back portable ADMP state (${err.message})`);
    }
  };

  const merged = mergePortableAdmpIdentity(secret, brainId, {
    fallbackIds: [legacyBrainId],
    refresh: true,
  });
  const effectiveSecret = merged.secret;
  const hasPortableAdmpIdentity = typeof effectiveSecret.secret_key === 'string' && effectiveSecret.secret_key.trim() !== '';
  return {
    ok: true,
    commit: () => {
      if (merged.changed) {
        let writtenSecretPath = '';
        try {
          writtenSecretPath = writeProjectBrainSecret(projectRoot, effectiveSecret);
        } catch (err) {
          io.stderr(`share push: failed to write brain secret inventory (${err.message})`);
          rollback();
          return { ok: false, rollback };
        }
        io.stdout(`share push: captured portable ADMP identity in ${writtenSecretPath}`);
      }

      if (!validatedNetworkRoot || !hasPortableAdmpIdentity) return { ok: true, rollback };
      try {
        const backedUpVaultPath = mergeVaultBrainSecret(validatedNetworkRoot, brainId, effectiveSecret, {
          fallbackIds: [legacyBrainId],
        });
        io.stdout(`share push: backed up portable ADMP identity to ${backedUpVaultPath}`);
        return { ok: true, rollback };
      } catch (err) {
        io.stderr(`share push: failed to back up portable ADMP identity (${err.message})`);
        rollback();
        return { ok: false, rollback };
      }
    },
  };
}

function normalizeNetworkProjectAgentId(networkRoot, projectRoot, brainId, legacyBrainId, io) {
  if (!networkRoot || !brainId || !legacyBrainId || brainId === legacyBrainId) {
    return { ok: true, changed: false, previousRaw: '' };
  }
  try {
    const configPath = resolveNetworkConfigPath(networkRoot);
    const previousRaw = fs.readFileSync(configPath, 'utf-8');
    const raw = JSON.parse(previousRaw);
    if (!Array.isArray(raw.projects)) return { ok: true, changed: false, previousRaw: '' };
    const project = raw.projects.find((row) =>
      typeof row?.path === 'string' && resolveProjectPath(row.path, networkRoot) === projectRoot
    );
    if (!project || project.agent_id === brainId) return { ok: true, changed: false, previousRaw: '' };
    const duplicate = raw.projects.find((row) =>
      row !== project &&
      typeof row?.agent_id === 'string' &&
      row.agent_id === brainId
    );
    if (duplicate) {
      throw new Error(`agent_id ${brainId} already belongs to project ${duplicate.id || '(unknown)'}`);
    }
    project.agent_id = brainId;
    const validation = validateNetworkConfig(raw);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    io.stdout(`share: updated network config agent_id ${legacyBrainId} -> ${brainId}`);
    return { ok: true, changed: true, previousRaw };
  } catch (err) {
    io.stderr(`share: failed to update network config agent_id (${err.message})`);
    return { ok: false, changed: false, previousRaw: '' };
  }
}

function rollbackNetworkProjectAgentId(networkRoot, previousRaw, io) {
  if (!networkRoot || !previousRaw) return;
  try {
    fs.writeFileSync(resolveNetworkConfigPath(networkRoot), previousRaw);
    io.stderr('share: rolled back network config agent_id update');
  } catch (err) {
    io.stderr(`share: failed to roll back network config agent_id (${err.message})`);
  }
}

async function migrateShareBrainRoot(sharePath, brainRoot, fromBrainId, toBrainId) {
  if (!sharePath || !fromBrainId || !toBrainId || fromBrainId === toBrainId) return;
  const fromRoot = getBrainShareRoot(sharePath, brainRoot, fromBrainId);
  const toRoot = getBrainShareRoot(sharePath, brainRoot, toBrainId);
  if (!fs.existsSync(fromRoot)) return;
  if (fs.existsSync(toRoot)) {
    throw new Error(`target share root already exists for ${toBrainId}`);
  }
  await fsp.mkdir(path.dirname(toRoot), { recursive: true });
  try {
    await fsp.rename(fromRoot, toRoot);
  } catch (err) {
    if (err && err.code !== 'EXDEV') throw err;
    await fsp.cp(fromRoot, toRoot, { recursive: true });
    await fsp.rm(fromRoot, { recursive: true, force: true });
  }
}

function getBrainShareRoot(sharePath, brainRoot, brainId) {
  return path.join(sharePath, brainRoot || DEFAULT_BRAIN_ROOT, validateBrainId(brainId));
}

function uniqueBrainIds(brainIds = []) {
  const seen = new Set();
  const values = [];
  for (const brainId of brainIds) {
    const value = typeof brainId === 'string' ? brainId.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function resolveShareBrainRoot(sharePath, brainRoot, preferredBrainId, fallbackBrainIds = []) {
  const roots = uniqueBrainIds([preferredBrainId, ...fallbackBrainIds]).map((brainId) => ({
    brainId,
    root: getBrainShareRoot(sharePath, brainRoot, brainId),
  }));
  if (roots.length === 0) {
    throw new Error('invalid brain id');
  }
  const existingRoots = roots.filter((entry) => fs.existsSync(entry.root));
  if (existingRoots.length > 1) {
    throw new Error(
      `multiple share roots exist for this brain migration (${existingRoots.map((entry) => entry.brainId).join(', ')}); reconcile them before syncing`
    );
  }
  return existingRoots[0] || roots[0];
}

async function readManifest(brainShareRoot) {
  return readJson(path.join(brainShareRoot, 'manifest.json'), {
    brain_id: path.basename(brainShareRoot),
    updated_at: '',
    files: {},
  });
}

async function writeManifest(brainShareRoot, manifest) {
  manifest.updated_at = new Date().toISOString();
  await writeJson(path.join(brainShareRoot, 'manifest.json'), manifest);
}

async function copyFileIfChanged(src, dest) {
  const srcBuf = await fsp.readFile(src);
  const srcHash = sha256Buffer(srcBuf);
  const destHash = await fsp.readFile(dest).then((buf) => sha256Buffer(buf)).catch(() => '');
  if (destHash === srcHash) return false;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, srcBuf);
  return true;
}

async function pushAssets(projectRoot, brainShareRoot, brainId, machineId, dryRun, io) {
  const manifest = await readManifest(brainShareRoot);
  manifest.brain_id = brainId;
  const localState = await readLocalState(projectRoot);
  const assets = discoverShareAssets(projectRoot);
  const safeMachineId = sanitizePathSegment(machineId);

  let pushed = 0;
  let conflicts = 0;
  for (const asset of assets) {
    const rel = asset.relFromProject;
    const localHash = sha256File(asset.filePath);
    const shared = manifest.files[rel];
    const baseline = localState.files[rel]?.shared_hash || '';

    if (shared && baseline && shared.sha256 !== baseline && localHash !== baseline && localHash !== shared.sha256) {
      conflicts++;
      const conflictDest = safeJoin(
        path.join(brainShareRoot, 'conflicts'),
        `${Date.now()}__${safeMachineId}__${rel.replaceAll('/', '__')}`
      );
      if (!dryRun) {
        await fsp.mkdir(path.dirname(conflictDest), { recursive: true });
        await fsp.copyFile(asset.filePath, conflictDest);
      }
      io.stderr(`share push: conflict preserved for ${rel}`);
      continue;
    }

    if (shared && shared.sha256 === localHash) {
      localState.files[rel] = {
        shared_hash: localHash,
        shared_updated_at: shared.updated_at || '',
      };
      continue;
    }

    if (!dryRun) {
      const dest = safeJoin(path.join(brainShareRoot, 'assets'), rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(asset.filePath, dest);
      manifest.files[rel] = {
        sha256: localHash,
        size: fs.statSync(asset.filePath).size,
        updated_at: new Date().toISOString(),
        source_machine_id: machineId,
      };
      localState.files[rel] = {
        shared_hash: localHash,
        shared_updated_at: manifest.files[rel].updated_at,
      };
    }
    pushed++;
  }

  if (!dryRun) {
    localState.last_pushed_at = new Date().toISOString();
  }
  return { pushed, conflicts, manifest, localState };
}

async function pushTranscripts(projectRoot, brainShareRoot, machineId, dryRun) {
  const transcripts = await discoverTranscriptFiles({ projectRoot });
  const safeMachineId = sanitizePathSegment(machineId);
  let copied = 0;
  for (const transcript of transcripts) {
    const dest = safeJoin(
      path.join(brainShareRoot, 'transcripts'),
      safeMachineId,
      transcript.cli,
      transcript.relative_path
    );
    if (!dryRun) {
      const changed = await copyFileIfChanged(transcript.path, dest);
      if (changed) copied++;
    } else {
      copied++;
    }
  }
  return copied;
}

async function pullAssets(projectRoot, brainShareRoot, dryRun, io) {
  const manifest = await readManifest(brainShareRoot);
  const localState = await readLocalState(projectRoot);
  let pulled = 0;
  let conflicts = 0;

  for (const [rel, shared] of Object.entries(manifest.files || {})) {
    const src = safeJoin(path.join(brainShareRoot, 'assets'), rel);
    const dest = safeJoin(projectRoot, rel);
    const localExists = fs.existsSync(dest);
    const localHash = localExists ? sha256File(dest) : '';
    const baseline = localState.files[rel]?.shared_hash || '';

    if (localExists && baseline && localHash !== baseline && shared.sha256 !== baseline && localHash !== shared.sha256) {
      conflicts++;
      const conflictPath = `${dest}.conflict.${sanitizePathSegment(shared.source_machine_id || 'share')}.${Date.now()}`;
      if (!dryRun) {
        await fsp.mkdir(path.dirname(conflictPath), { recursive: true });
        await fsp.copyFile(src, conflictPath);
      }
      io.stderr(`share pull: conflict preserved for ${rel}`);
      continue;
    }

    if (localExists && localHash === shared.sha256) {
      localState.files[rel] = {
        shared_hash: shared.sha256,
        shared_updated_at: shared.updated_at || '',
      };
      continue;
    }

    if (!dryRun) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      localState.files[rel] = {
        shared_hash: shared.sha256,
        shared_updated_at: shared.updated_at || '',
      };
    }
    pulled++;
  }

  if (!dryRun) {
    localState.last_pulled_at = new Date().toISOString();
    await writeLocalState(projectRoot, localState);
  }
  return { pulled, conflicts };
}

async function pullTranscripts(brainShareRoot, dryRun, io, runtime = {}) {
  const transcriptRoot = path.join(brainShareRoot, 'transcripts');
  if (!fs.existsSync(transcriptRoot)) return 0;
  if (dryRun) {
    io.stdout(`share pull: transcripts ready from ${transcriptRoot}`);
    return 1;
  }
  const restoreTranscripts = runtime.handleDaemonRestore || handleDaemonRestore;
  await restoreTranscripts(['--input-dir', transcriptRoot, '--force'], io, { exitOnError: false });
  return 1;
}

async function commandConfigure(args, io) {
  const provider = getFlagValue(args, '--provider');
  const sharePath = getFlagValue(args, '--path');
  const remote = getFlagValue(args, '--remote');
  const mountPoint = getFlagValue(args, '--mount-point');
  const brainRoot = getFlagValue(args, '--brain-root') || DEFAULT_BRAIN_ROOT;

  if (!VALID_PROVIDERS.has(provider)) {
    io.stderr('share configure failed: --provider must be one of smb, nfs, local');
    return 1;
  }
  if (!sharePath) {
    io.stderr('share configure failed: --path <path> is required');
    return 1;
  }
  if (provider !== 'local' && !mountPoint) {
    io.stderr('share configure failed: --mount-point <path> is required for smb/nfs');
    return 1;
  }

  try {
    await setShareConfig({
      provider,
      remote,
      mount_point: mountPoint,
      path: sharePath,
      brain_root: brainRoot,
    });
  } catch (err) {
    io.stderr(`share configure failed: ${err.message}`);
    return 1;
  }
  io.stdout(`share configured: provider=${provider} path=${sharePath}`);
  return 0;
}

async function commandStatus(args, io) {
  const share = normalizeShareConfig(await getShareConfig());
  if (!share) {
    io.stderr('share status failed: no share config — run `agentbootup share configure ...`');
    return 1;
  }
  const json = hasFlag(args, '--json');
  const sharePath = resolveSharePath(share);
  const status = {
    provider: share.provider,
    remote: share.remote,
    mount_point: share.mount_point,
    path: sharePath,
    brain_root: share.brain_root,
    reachable: !!sharePath && fs.existsSync(sharePath),
    bridge_enabled: share.bridge_enabled === true,
  };
  if (json) {
    io.stdout(JSON.stringify(status, null, 2));
  } else {
    io.stdout(`Provider: ${status.provider}`);
    io.stdout(`Remote: ${status.remote || '(none)'}`);
    io.stdout(`Mount point: ${status.mount_point || '(none)'}`);
    io.stdout(`Path: ${status.path || '(none)'}`);
    io.stdout(`Brain root: ${status.brain_root}`);
    io.stdout(`Reachable: ${status.reachable ? 'yes' : 'no'}`);
  }
  return 0;
}

async function commandMount(args, io, runtime = {}) {
  const share = normalizeShareConfig(await getShareConfig());
  if (!share) {
    io.stderr('share mount failed: no share config — run `agentbootup share configure ...`');
    return 1;
  }
  const runCommand = runtime.runCommand || defaultRunner;
  const sharePath = resolveSharePath(share);

  if (share.provider === 'local') {
    if (!sharePath || !fs.existsSync(sharePath)) {
      io.stderr(`share mount failed: local path not found: ${sharePath}`);
      return 1;
    }
    io.stdout(`share mount: using local path ${sharePath}`);
    return 0;
  }

  if (!share.remote || !share.mount_point) {
    io.stderr('share mount failed: remote and mount_point are required');
    return 1;
  }

  ensureDirSync(share.mount_point);
  const command =
    share.provider === 'smb'
      ? process.platform === 'darwin'
        ? ['mount_smbfs', share.remote, share.mount_point]
        : ['mount', '-t', 'cifs', share.remote, share.mount_point]
      : ['mount', '-t', 'nfs', share.remote, share.mount_point];
  const result = runCommand(command);
  if (result.code !== 0) {
    io.stderr(`share mount failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    return 1;
  }
  io.stdout(`share mounted at ${share.mount_point}`);
  return 0;
}

async function commandUnmount(args, io, runtime = {}) {
  const share = normalizeShareConfig(await getShareConfig());
  if (!share) {
    io.stderr('share unmount failed: no share config');
    return 1;
  }
  if (share.provider === 'local') {
    io.stdout('share unmount: local provider has nothing to unmount');
    return 0;
  }
  const mountPoint = share.mount_point;
  if (!mountPoint) {
    io.stderr('share unmount failed: no mount_point configured');
    return 1;
  }
  const runCommand = runtime.runCommand || defaultRunner;
  const result = runCommand(process.platform === 'darwin'
    ? ['diskutil', 'unmount', mountPoint]
    : ['umount', mountPoint]);
  if (result.code !== 0) {
    io.stderr(`share unmount failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    return 1;
  }
  io.stdout(`share unmounted ${mountPoint}`);
  return 0;
}

async function commandPush(args, io, runtime = {}) {
  const extracted = extractCwd(args);
  const localArgs = extracted.args;
  const dryRun = hasFlag(localArgs, '--dry-run');
  const [projectId = ''] = getPositionalArgs(localArgs, ['--cwd']);
  const share = normalizeShareConfig(await getShareConfig());
  if (!share) {
    io.stderr('share push failed: no share config');
    return 1;
  }
  const sharePath = resolveSharePath(share);
  if (!sharePath || !fs.existsSync(sharePath)) {
    io.stderr(`share push failed: share path is not reachable: ${sharePath}`);
    return 1;
  }

  let ctx;
  try {
    ctx = resolveProjectContext(projectId, extracted.cwd);
  } catch (err) {
    io.stderr(`share push failed: ${err.message}`);
    return 1;
  }
  let shareTarget;
  try {
    shareTarget = resolveShareBrainRoot(
      sharePath,
      share.brain_root,
      ctx.brainId,
      [ctx.legacyBrainId]
    );
  } catch (err) {
    io.stderr(`share push failed: ${err.message}`);
    return 1;
  }
  let brainShareRoot = shareTarget.root;
  const localStateSnapshot = dryRun ? null : snapshotFile(getStatePath(ctx.projectRoot));
  const machineId = await getMachineId();
  const networkRoot = ctx.networkRoot || resolveNetworkRoot(extracted.cwd) || resolveProjectNetworkRoot(ctx.projectRoot);
  const ownership = preparePortableAdmpOwnership(ctx.projectRoot, ctx.brainId, ctx.legacyBrainId, networkRoot, io, { dryRun });
  if (!ownership.ok) {
    io.stderr('share push failed: unable to migrate portable ADMP identity safely');
    return 1;
  }

  let shareRootSnapshot = null;

  const rollbackShareRoot = () => {
    if (!shareRootSnapshot) return;
    try {
      const migratedRoot = getBrainShareRoot(sharePath, share.brain_root, ctx.brainId);
      if (migratedRoot !== shareTarget.root) {
        fs.rmSync(migratedRoot, { recursive: true, force: true });
      }
      shareRootSnapshot.restore(shareTarget.root);
      fs.rmSync(path.join(shareTarget.root, 'locks', 'sync.lock'), { recursive: true, force: true });
    } catch (err) {
      io.stderr(`share push: failed to roll back shared state (${err.message})`);
    } finally {
      shareRootSnapshot.cleanup();
    }
  };

  const rollbackLocalState = () => {
    if (!localStateSnapshot) return;
    try {
      restoreFileSnapshot(getStatePath(ctx.projectRoot), localStateSnapshot);
    } catch (err) {
      io.stderr(`share push: failed to roll back local share state (${err.message})`);
    }
  };

  const result = await withShareLock(path.join(brainShareRoot, 'locks', 'sync.lock'), async () => {
    shareRootSnapshot = dryRun ? null : snapshotDirectory(brainShareRoot);
    let normalization = { ok: true, changed: false, previousRaw: '' };
    let committedOwnership = null;
    try {
      const assetResult = await pushAssets(ctx.projectRoot, brainShareRoot, ctx.brainId, machineId, dryRun, io);
      const transcriptCount = await pushTranscripts(ctx.projectRoot, brainShareRoot, machineId, dryRun);
      const syncResult = { ...assetResult, transcriptCount };

      if (!dryRun) {
        if (shareTarget.brainId !== ctx.brainId) {
          await migrateShareBrainRoot(sharePath, share.brain_root, shareTarget.brainId, ctx.brainId);
          brainShareRoot = getBrainShareRoot(sharePath, share.brain_root, ctx.brainId);
        }
        normalization = normalizeNetworkProjectAgentId(networkRoot, ctx.projectRoot, ctx.brainId, ctx.legacyBrainId, io);
        if (!normalization.ok) {
          throw new Error('unable to update network config agent_id safely');
        }
        committedOwnership = ownership.commit();
        if (!committedOwnership.ok) {
          throw new Error('unable to migrate portable ADMP identity safely');
        }
        await writeManifest(brainShareRoot, syncResult.manifest);
        await writeLocalState(ctx.projectRoot, syncResult.localState);
        shareRootSnapshot.cleanup();
      }
      return syncResult;
    } catch (err) {
      if (normalization.changed) rollbackNetworkProjectAgentId(networkRoot, normalization.previousRaw, io);
      committedOwnership?.rollback?.();
      rollbackShareRoot();
      rollbackLocalState();
      throw err;
    }
  }).catch((err) => {
    io.stderr(`share push failed: ${err.message}`);
    return null;
  });
  if (!result) {
    return 1;
  }

  io.stdout(
    `share push: ${ctx.label} assets=${result.pushed} transcripts=${result.transcriptCount} conflicts=${result.conflicts}${dryRun ? ' (dry-run)' : ''}`
  );
  return 0;
}

async function commandPull(args, io, runtime = {}) {
  const extracted = extractCwd(args);
  const localArgs = extracted.args;
  const dryRun = hasFlag(localArgs, '--dry-run');
  const [projectId = ''] = getPositionalArgs(localArgs, ['--cwd']);
  const share = normalizeShareConfig(await getShareConfig());
  if (!share) {
    io.stderr('share pull failed: no share config');
    return 1;
  }
  const sharePath = resolveSharePath(share);
  if (!sharePath || !fs.existsSync(sharePath)) {
    io.stderr(`share pull failed: share path is not reachable: ${sharePath}`);
    return 1;
  }

  let ctx;
  try {
    ctx = resolveProjectContext(projectId, extracted.cwd);
  } catch (err) {
    io.stderr(`share pull failed: ${err.message}`);
    return 1;
  }
  let brainShareRoot;
  try {
    brainShareRoot = resolveShareBrainRoot(
      sharePath,
      share.brain_root,
      ctx.brainId,
      [ctx.legacyBrainId]
    ).root;
  } catch (err) {
    io.stderr(`share pull failed: ${err.message}`);
    return 1;
  }
  if (!fs.existsSync(brainShareRoot)) {
    io.stderr(`share pull failed: no shared brain found for ${ctx.brainId}`);
    return 1;
  }

  const result = await withShareLock(path.join(brainShareRoot, 'locks', 'sync.lock'), async () => {
    const assetResult = await pullAssets(ctx.projectRoot, brainShareRoot, dryRun, io);
    const transcriptResult = await pullTranscripts(brainShareRoot, dryRun, io, runtime);
    return { ...assetResult, transcriptResult };
  }).catch((err) => {
    io.stderr(`share pull failed: ${err.message}`);
    return null;
  });
  if (!result) return 1;

  io.stdout(
    `share pull: ${ctx.label} assets=${result.pulled} transcripts=${result.transcriptResult ? 'restored' : 'none'} conflicts=${result.conflicts}${dryRun ? ' (dry-run)' : ''}`
  );
  return 0;
}

export async function runShareCommand(argv, io, runtime = {}) {
  if (!argv || argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printUsage(io);
    return 0;
  }
  const [subcommand, ...args] = argv;
  switch (subcommand) {
    case 'configure':
      return await commandConfigure(args, io);
    case 'status':
      return await commandStatus(args, io);
    case 'mount':
      return await commandMount(args, io, runtime);
    case 'unmount':
      return await commandUnmount(args, io, runtime);
    case 'push':
      return await commandPush(args, io, runtime);
    case 'pull':
      return await commandPull(args, io, runtime);
    default:
      io.stderr(`Unknown share subcommand: ${subcommand}`);
      printUsage(io);
      return 1;
  }
}
