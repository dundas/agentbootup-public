/**
 * Environment mount application (Phase 3) — settings policy, skills, mount.json
 */

import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from './io-utils.js';
import {
  hashFileSha256,
  resolveEnvironmentSkillsPath,
  isProjectAllowedForEnv,
} from './env-config.js';
import { stripPermissionRequestHooks } from './hooks-settings.js';
import { getMountDirectory, ensureDir, getMountsBaseDir } from './mount-paths.js';
import { normalizeMountRecord } from './mount-record.js';
import { reconcileMountWatcherRecord } from './mount-watcher-state.js';

export const DEFAULT_MANAGED_MOUNT_PATHS = ['.claude/settings.json', '.claude/skills'];

function walkTree(dir, root = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return out;
    throw err;
  }
  if (stat.isSymbolicLink()) return out;
  if (!stat.isDirectory()) {
    out.push(`${path.relative(root, dir)}:${stat.size}:${stat.mtimeMs}`);
    return out;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    walkTree(path.join(dir, entry), root, out);
  }
  return out;
}

function buildSourceSnapshot(sourceRoot, envSkillsPath, envSkillsOk) {
  const settingsPath = path.join(sourceRoot, '.claude', 'settings.json');
  const srcSkills = path.join(sourceRoot, '.claude', 'skills');
  const snapshot = [];
  if (fs.existsSync(settingsPath)) {
    try {
      const stat = fs.statSync(settingsPath);
      snapshot.push(`settings:${stat.size}:${stat.mtimeMs}`);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        snapshot.push('settings:missing');
      } else {
        throw err;
      }
    }
  } else {
    snapshot.push('settings:missing');
  }
  snapshot.push(...walkTree(srcSkills, srcSkills).map((entry) => `source-skill:${entry}`));
  if (envSkillsOk) {
    snapshot.push(...walkTree(envSkillsPath, envSkillsPath).map((entry) => `env-skill:${entry}`));
  } else {
    snapshot.push('env-skills:missing');
  }
  return snapshot.join('|');
}

export function readMountRecord(mountRoot) {
  const mountJsonPath = path.join(mountRoot, 'mount.json');
  if (!fs.existsSync(mountJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(mountJsonPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function updateMountRecord(mountRoot, mutate) {
  const current = readMountRecord(mountRoot);
  if (!current) return null;
  const next = mutate(current);
  if (!next || typeof next !== 'object') return null;
  writeFileAtomic(path.join(mountRoot, 'mount.json'), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function isPathInside(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative !== '' && relative !== '.' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function pruneEmptyParents(startPath, stopDir) {
  const root = path.resolve(stopDir);
  let current = startPath;
  while (isPathInside(root, current)) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    const stat = fs.statSync(current);
    if (!stat.isDirectory()) {
      return;
    }
    if (fs.readdirSync(current).length > 0) {
      return;
    }
    try {
      fs.rmdirSync(current);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTEMPTY') return;
      throw err;
    }
    current = path.dirname(current);
  }
}

function resolveManagedMountTarget(mountRoot, relPath) {
  if (typeof relPath !== 'string') return null;
  const trimmed = relPath.trim();
  if (!trimmed || trimmed === '.') return null;
  const root = path.resolve(mountRoot);
  const target = path.resolve(root, trimmed);
  if (!isPathInside(root, target)) {
    return null;
  }
  return target;
}

export function removeManagedMountFiles(mountRoot, record) {
  const managedPaths = Array.isArray(record?.managed_paths) && record.managed_paths.length > 0
    ? record.managed_paths
    : DEFAULT_MANAGED_MOUNT_PATHS;
  for (const rel of managedPaths) {
    const target = resolveManagedMountTarget(mountRoot, rel);
    if (!target) continue;
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    pruneEmptyParents(path.dirname(target), mountRoot);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.sourceRoot — brain project root (linked path)
 * @param {string} opts.envConfigPath — absolute path to env json
 * @param {object} opts.config — validated env config
 * @param {string} opts.configDir — dirname of env config file
 * @param {object} opts.project — network project entry
 * @param {boolean} [opts.bypassApprovals]
 * @param {{ stdout: (s: string) => void }} opts.io
 * @returns {{ mountRoot: string, noOp: boolean }}
 */
export function syncMountedEnvironment(opts) {
  const { sourceRoot, envConfigPath, config, configDir, project, bypassApprovals = false, io } = opts;
  const mountKind = opts.mountKind === 'watch' ? 'watch' : 'copy';
  const live = opts.live === true;
  const persistLifecycle = opts.persistLifecycle !== false;

  if (!isProjectAllowedForEnv(project, config.brains)) {
    throw new Error(
      `brain not in brains for environment "${config.environment}". Allowed: ${config.brains.join(', ')}`
    );
  }

  const approvalMode = config.approval_flow?.mode || 'none';
  if (approvalMode === 'teleporter_hook') {
    const varName = config.approval_flow.parent_session_id_var || 'TELEPORTATION_PARENT_SESSION_ID';
    const v = process.env[varName];
    if (!v || !String(v).trim()) {
      if (!bypassApprovals) {
        throw new Error(
          `ERROR: approval_flow.mechanism is "teleporter_hook" but ${varName} is not set.\n` +
            `Approvals will fire but be invisible to the user (execution hangs waiting for a decision\n` +
            `no one can see). Set ${varName} before mounting, or use --bypass-approvals\n` +
            `to explicitly opt into unsupervised execution.`
        );
      }
    }
  }

  const optional = config.environment_skills.optional === true;
  const envSkillsPath = resolveEnvironmentSkillsPath(configDir, config.environment_skills.path);
  let envSkillsOk = fs.existsSync(envSkillsPath);
  if (!envSkillsOk) {
    if (optional) {
      io.stdout(
        `[mount] warning: environment_skills path missing (${envSkillsPath}), skipping layer (optional: true)`
      );
    } else {
      throw new Error(`environment_skills path does not exist: ${envSkillsPath}`);
    }
  }

  const mountRoot = getMountDirectory(config.environment, project.id);
  const mountJsonPath = path.join(mountRoot, 'mount.json');
  const newHash = hashFileSha256(envConfigPath);
  const sourceSnapshot = buildSourceSnapshot(sourceRoot, envSkillsPath, envSkillsOk);

  if (fs.existsSync(mountJsonPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(mountJsonPath, 'utf-8'));
      const prev = existing.environment?.config_hash;
      if (prev === newHash && existing.source_snapshot === sourceSnapshot && existing.mount_kind === mountKind) {
        io.stdout(`[mount] env config unchanged (${newHash.slice(0, 12)}…), no-op`);
        return { mountRoot, noOp: true };
      }
      io.stdout(
        `[mount] env config or source changed (${(prev || '').slice(0, 12)}… → ${newHash.slice(0, 12)}…), reapplied policy`
      );
    } catch {
      io.stdout('[mount] mount.json unreadable; full reapply');
    }
  }

  ensureDir(mountRoot);
  ensureDir(path.join(mountRoot, '.claude'));

  const srcSettingsPath = path.join(sourceRoot, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(srcSettingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(srcSettingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  let outSettings = settings;
  if (approvalMode === 'orchestrate') {
    outSettings = stripPermissionRequestHooks(settings);
  } else {
    outSettings = JSON.parse(JSON.stringify(settings));
  }

  writeFileAtomic(
    path.join(mountRoot, '.claude', 'settings.json'),
    `${JSON.stringify(outSettings, null, 2)}\n`
  );

  const srcSkills = path.join(sourceRoot, '.claude', 'skills');
  const dstSkills = path.join(mountRoot, '.claude', 'skills');
  if (fs.existsSync(dstSkills)) {
    fs.rmSync(dstSkills, { recursive: true });
  }
  if (fs.existsSync(srcSkills)) {
    fs.cpSync(srcSkills, dstSkills, { recursive: true });
  } else {
    ensureDir(dstSkills);
  }
  if (envSkillsOk) {
    try {
      if (fs.existsSync(envSkillsPath) && fs.statSync(envSkillsPath).isDirectory()) {
        fs.cpSync(envSkillsPath, dstSkills, { recursive: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`environment_skills overlay failed: ${msg}`);
    }
  }

  const bypass =
    Boolean(bypassApprovals) && approvalMode === 'teleporter_hook';

  const mountedAt = new Date().toISOString();
  const mountRecord = {
    schema_version: '1.1',
    brain_id: project.agent_id || project.id,
    version: readPackageVersion(sourceRoot),
    mounted_at: mountedAt,
    source_snapshot: sourceSnapshot,
    source: path.resolve(sourceRoot),
    workspace_path: path.resolve(sourceRoot),
    cwd: mountRoot,
    managed_paths: DEFAULT_MANAGED_MOUNT_PATHS,
    environment: {
      name: config.environment,
      config_path: path.resolve(envConfigPath),
      config_hash: newHash,
      schema_version: config.schema_version,
      approval_flow_mode: approvalMode,
      bypass_approvals: bypass,
      skill_layers: ['core', 'brain', 'environment'],
      secret_source_namespace: config.secret_source?.namespace,
      ...(config.mount_base ? { mount_base: config.mount_base } : {}),
      routing: config.routing,
    },
  };
  if (persistLifecycle) {
    mountRecord.mount_kind = mountKind;
    mountRecord.live = live;
    mountRecord.last_synced_at = mountedAt;
  }

  writeFileAtomic(mountJsonPath, `${JSON.stringify(mountRecord, null, 2)}\n`);

  if (bypass) {
    io.stdout(
      '[mount] WARNING: --bypass-approvals: teleporter_hook without parent session id; unsupervised execution acknowledged.'
    );
  }

  io.stdout(`[mount] applied → ${mountRoot}`);
  return { mountRoot, noOp: false };
}

export function performEnvMount(opts) {
  return syncMountedEnvironment({ ...opts, mountKind: 'copy', live: false });
}

/**
 * @param {string} root
 */
function readPackageVersion(root) {
  try {
    const p = path.join(root, 'package.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (typeof j.version === 'string') return j.version;
  } catch {
    /* ignore */
  }
  return 'unknown';
}

/**
 * @returns {Array<{ envName: string, brainKey: string, mountRoot: string, record: object }>}
 */
export function enumerateMounts() {
  const base = getMountsBaseDir();
  if (!fs.existsSync(base)) {
    return [];
  }
  const out = [];
  for (const envName of fs.readdirSync(base)) {
    if (envName.startsWith('.')) continue;
    const envDir = path.join(base, envName);
    let st;
    try {
      st = fs.statSync(envDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const brainKey of fs.readdirSync(envDir)) {
      const mountRoot = path.join(envDir, brainKey);
      let mst;
      try {
        mst = fs.statSync(mountRoot);
      } catch {
        continue;
      }
      if (!mst.isDirectory()) continue;
      const mj = path.join(mountRoot, 'mount.json');
      if (!fs.existsSync(mj)) continue;
      try {
        const record = reconcileMountWatcherRecord(
          mountRoot,
          normalizeMountRecord(JSON.parse(fs.readFileSync(mj, 'utf-8')))
        );
        out.push({ envName, brainKey, mountRoot, record });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/**
 * @param {string} envConfigPath on disk
 * @param {object} record from mount.json
 */
export function envConfigHashMatchesDisk(envConfigPath, record) {
  if (!fs.existsSync(envConfigPath)) return 'missing_config';
  try {
    const disk = hashFileSha256(envConfigPath);
    const mounted = record?.environment?.config_hash;
    if (!mounted) return 'unknown';
    return disk === mounted ? 'current' : 'stale';
  } catch {
    return 'unknown';
  }
}
