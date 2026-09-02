import path from 'path';
import fs from 'fs';
import { loadNetworkConfig, resolveProjectPath } from '../config.js';
import { extractCwd, getFlagValue, getPositionalArgs, hasFlag } from '../args.js';
import { loadEnvConfigFile } from '../../brain/env-config.js';
import {
  syncMountedEnvironment,
  enumerateMounts,
  envConfigHashMatchesDisk,
  removeManagedMountFiles,
  updateMountRecord,
} from '../../brain/mount-engine.js';
import { validateBrainBundleV1 } from '../../brain/brain-bundle.js';
import { validateBrainRuntimeV1 } from '../../brain/brain-runtime.js';
import { validateBrainWorkspaceV1 } from '../../brain/brain-workspace.js';
import { getApprovalFlowMode, getMountLifecycle } from '../../brain/mount-record.js';
import { startMountWatcher, stopMountWatcher, readMountWatcherHealth, SERVICE_MANAGER_ERROR_SUBSTRINGS } from '../../brain/mount-watcher.js';

const defaultMountCliRuntime = Object.freeze({
  startMountWatcher,
  stopMountWatcher,
  readMountWatcherHealth,
});

let mountCliRuntime = { ...defaultMountCliRuntime };

export function setMountCliRuntimeForTests(overrides = null) {
  if (!overrides || typeof overrides !== 'object') {
    mountCliRuntime = { ...defaultMountCliRuntime };
    return;
  }
  mountCliRuntime = {
    ...defaultMountCliRuntime,
    ...overrides,
  };
}

function printWarnings(loadedEnv, io, prefix) {
  for (const warning of loadedEnv.warnings || []) {
    io.stderr(`${prefix}: warning: ${warning}`);
  }
}

function toErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function withErrorCode(err, code) {
  if (err instanceof Error) {
    err.code = code;
    return err;
  }
  const wrapped = new Error(String(err));
  wrapped.code = code;
  return wrapped;
}

function getErrorCode(err) {
  if (!err || typeof err !== 'object') return '';
  return typeof err.code === 'string' ? err.code : '';
}

function normalizeCommandError(prefix, err) {
  const message = toErrorMessage(err);
  if (!prefix) return message;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return message.replace(new RegExp(`^${escapedPrefix}:\\s*`), '');
}

function isServiceManagerUnavailableError(err) {
  if (getErrorCode(err) === 'SERVICE_MANAGER_UNAVAILABLE') {
    return true;
  }
  const message = toErrorMessage(err).toLowerCase();
  return SERVICE_MANAGER_ERROR_SUBSTRINGS.some((s) => message.includes(s));
}

function isUnmountRecoverableValidationError(err) {
  const code = getErrorCode(err);
  if (code === 'PROJECT_LINK_MISSING' || code === 'PROJECT_PORTABILITY_INVALID' || code === 'ENOENT') {
    return true;
  }
  const message = toErrorMessage(err);
  return (
    message.includes('failed validation') ||
    message.includes('invalid JSON in') ||
    message.includes('has no linked path')
  );
}

function validatePortabilityFiles(sourceRoot, prefix) {
  for (const [filename, validator] of [
    ['brain-bundle.json', validateBrainBundleV1],
    ['brain-runtime.json', validateBrainRuntimeV1],
    ['brain-workspace.json', validateBrainWorkspaceV1],
  ]) {
    const filePath = path.join(sourceRoot, filename);
    if (!fs.existsSync(filePath)) continue;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      throw withErrorCode(new Error(`${prefix}: invalid JSON in ${filePath}: ${toErrorMessage(err)}`), 'PROJECT_PORTABILITY_INVALID');
    }
    const result = validator(parsed);
    if (!result.ok) {
      throw withErrorCode(
        new Error(`${prefix}: ${filename} failed validation: ${result.errors.join('; ')}`),
        'PROJECT_PORTABILITY_INVALID'
      );
    }
  }
}

function ensureProjectRootExists(sourceRoot, prefix) {
  let stat;
  try {
    stat = fs.statSync(sourceRoot);
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT' || (err instanceof Error && err.code === 'ENOENT')) {
      throw withErrorCode(new Error(`${prefix}: project root "${sourceRoot}" does not exist`), 'ENOENT');
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw withErrorCode(new Error(`${prefix}: project root "${sourceRoot}" is not a directory`), 'PROJECT_PORTABILITY_INVALID');
  }
}

function loadProjectForMount(cwd, projectId, prefix) {
  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    throw new Error(`${prefix}: ${err.message}`);
  }
  const { config } = loaded;
  if (config.role !== 'network') {
    throw new Error(`${prefix}: command requires role "network"`);
  }

  const project = (config.projects || []).find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`${prefix}: unknown project id "${projectId}"`);
  }
  if (!project.path) {
    throw withErrorCode(new Error(`${prefix}: project "${projectId}" has no linked path`), 'PROJECT_LINK_MISSING');
  }

  const sourceRoot = resolveProjectPath(project.path, cwd);
  ensureProjectRootExists(sourceRoot, prefix);
  validatePortabilityFiles(sourceRoot, prefix);
  return { config, project, sourceRoot };
}

function resolveMountedConfigPath(projectId, envName, prefix) {
  const matches = enumerateMounts().filter((row) => row.brainKey === projectId && row.envName === envName);
  if (matches.length === 0) {
    throw new Error(`${prefix}: no existing mount for project "${projectId}" in environment "${envName}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${prefix}: multiple mount records found for project "${projectId}" in environment "${envName}"; use --env-config <path> to disambiguate`
    );
  }
  const cfgPath = matches[0].record?.environment?.config_path;
  if (!cfgPath) {
    throw new Error(`${prefix}: existing mount for "${projectId}" in "${envName}" has no config_path`);
  }
  return cfgPath;
}

function resolveEnvConfigPath(cwd, args, projectId, prefix) {
  const envConfigRaw = getFlagValue(args, '--env-config');
  if (envConfigRaw) {
    return path.resolve(cwd, envConfigRaw);
  }
  const envName = getFlagValue(args, '--env');
  if (!envName) {
    throw new Error(`${prefix}: use --env-config <path> or --env <name>`);
  }
  return resolveMountedConfigPath(projectId, envName, prefix);
}

function deriveEnvironmentName(cwd, args, prefix, io) {
  const envName = getFlagValue(args, '--env');
  if (envName) return envName;
  const envConfigRaw = getFlagValue(args, '--env-config');
  if (!envConfigRaw) {
    throw new Error(`${prefix}: use --env <name> or --env-config <path>`);
  }
  const loadedEnv = loadEnvConfigFile(path.resolve(cwd, envConfigRaw));
  if (!loadedEnv.ok) {
    throw new Error(`${prefix}: ${loadedEnv.error}`);
  }
  printWarnings(loadedEnv, io, prefix);
  return loadedEnv.config.environment;
}

/**
 * @param {string[]} args argv after `mount`
 * @param {{ stdout: function, stderr: function }} io
 * @returns {number}
 */
export async function runMountCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;
  const localArgs = extracted.args;
  const envConfigRaw = getFlagValue(localArgs, '--env-config');
  if (!envConfigRaw) {
    io.stderr('mount failed: --env-config <path> is required');
    return 1;
  }
  const envConfigPath = path.resolve(cwd, envConfigRaw);
  const bypass = hasFlag(localArgs, '--bypass-approvals');

  const positionals = getPositionalArgs(localArgs, ['--cwd', '--env-config', '--bypass-approvals']);
  if (positionals.length < 1) {
    io.stderr('mount failed: missing <project-id>');
    return 1;
  }
  const projectId = positionals[0];

  try {
    const { project, sourceRoot } = loadProjectForMount(cwd, projectId, 'mount failed');
    const loadedEnv = loadEnvConfigFile(envConfigPath);
    if (!loadedEnv.ok) {
      io.stderr(`mount failed: ${loadedEnv.error}`);
      return 1;
    }
    printWarnings(loadedEnv, io, 'mount');

    const { mountRoot, noOp } = syncMountedEnvironment({
      sourceRoot,
      envConfigPath,
      config: loadedEnv.config,
      configDir: loadedEnv.configDir,
      project,
      bypassApprovals: bypass,
      mountKind: 'watch',
      live: false,
      persistLifecycle: false,
      io,
    });
    const current = enumerateMounts().find((row) => row.mountRoot === mountRoot);
    const watcherHealth = mountCliRuntime.readMountWatcherHealth(mountRoot);
    if (noOp && current?.record?.mount_kind === 'watch' && watcherHealth.running) {
      io.stdout(`[mount] watcher already live → ${mountRoot}`);
      return 0;
    }
    const watcher = await mountCliRuntime.startMountWatcher({
      mountRoot,
      envName: loadedEnv.config.environment,
      brainKey: project.id,
      sourceRoot,
      envConfigPath,
      project,
      bypassApprovals: bypass,
    });
    io.stdout(`[mount] watcher started (${watcher.agentName}) pid=${watcher.pid}`);
  } catch (err) {
    if (isServiceManagerUnavailableError(err)) {
      io.stderr(
        `mount: warning: background mount watcher unavailable on this host; continuing with static mount only (${normalizeCommandError('', err)})`
      );
      return 0;
    }
    io.stderr(`mount failed: ${normalizeCommandError('mount failed', err)}`);
    return 1;
  }

  return 0;
}

/**
 * @param {string[]} args argv after `update`
 * @param {{ stdout: function, stderr: function }} io
 * @returns {number}
 */
export async function runUpdateCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;
  const localArgs = extracted.args;
  const bypass = hasFlag(localArgs, '--bypass-approvals');

  const positionals = getPositionalArgs(localArgs, ['--cwd', '--env', '--env-config', '--bypass-approvals']);
  if (positionals.length < 1) {
    io.stderr('update failed: missing <project-id>');
    return 1;
  }
  const projectId = positionals[0];

  let mountRoot;
  try {
    const { project, sourceRoot } = loadProjectForMount(cwd, projectId, 'update failed');
    const envConfigPath = resolveEnvConfigPath(cwd, localArgs, projectId, 'update failed');
    const loadedEnv = loadEnvConfigFile(envConfigPath);
    if (!loadedEnv.ok) {
      io.stderr(`update failed: ${loadedEnv.error}`);
      return 1;
    }
    printWarnings(loadedEnv, io, 'update');

    ({ mountRoot } = syncMountedEnvironment({
      sourceRoot,
      envConfigPath,
      config: loadedEnv.config,
      configDir: loadedEnv.configDir,
      project,
      bypassApprovals: bypass,
      mountKind: 'watch',
      live: false,
      persistLifecycle: false,
      io,
    }));
    const watcher = await mountCliRuntime.startMountWatcher({
      mountRoot,
      envName: loadedEnv.config.environment,
      brainKey: project.id,
      sourceRoot,
      envConfigPath,
      project,
      bypassApprovals: bypass,
    });
    io.stdout(`[update] watcher refreshed (${watcher.agentName}) pid=${watcher.pid}`);
  } catch (err) {
    if (isServiceManagerUnavailableError(err)) {
      if (mountRoot) {
        updateMountRecord(mountRoot, (current) => ({ ...current, mount_kind: 'copy', live: false }));
      }
      io.stderr(
        `update: warning: background mount watcher unavailable on this host; environment files were updated without live watcher support (${normalizeCommandError('', err)})`
      );
      return 0;
    }
    io.stderr(`update failed: ${normalizeCommandError('update failed', err)}`);
    return 1;
  }

  return 0;
}

/**
 * @param {string[]} args argv after `unmount`
 * @param {{ stdout: function, stderr: function }} io
 * @returns {number}
 */
export async function runUnmountCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;
  const localArgs = extracted.args;
  const purge = hasFlag(localArgs, '--purge');
  const positionals = getPositionalArgs(localArgs, ['--cwd', '--env', '--env-config', '--purge']);
  if (positionals.length < 1) {
    io.stderr('unmount failed: missing <project-id>');
    return 1;
  }
  const projectId = positionals[0];

  try {
    // Attempt project validation first, but stale mounts must remain removable
    // even if the original checkout no longer resolves cleanly.
    try {
      loadProjectForMount(cwd, projectId, 'unmount failed');
    } catch (validationErr) {
      if (!isUnmountRecoverableValidationError(validationErr)) {
        throw validationErr;
      }
      io.stderr(
        `unmount: warning: continuing despite validation failure: ${
          normalizeCommandError('unmount failed', validationErr)
        }`
      );
    }
    const envName = deriveEnvironmentName(cwd, localArgs, 'unmount failed', io);
    const mounts = enumerateMounts();
    const matches = mounts.filter((row) => row.brainKey === projectId && row.envName === envName);
    if (matches.length === 0) {
      throw new Error(`unmount failed: no active mount for project "${projectId}" in environment "${envName}"`);
    }
    for (const match of matches) {
      await mountCliRuntime.stopMountWatcher({ mountRoot: match.mountRoot, envName, brainKey: projectId });
      if (purge) {
        fs.rmSync(match.mountRoot, { recursive: true, force: true });
        io.stdout(`[unmount] purged ${match.mountRoot}`);
        continue;
      }
      removeManagedMountFiles(match.mountRoot, match.record);
      fs.rmSync(path.join(match.mountRoot, 'mount.json'), { force: true });
      fs.rmSync(path.join(match.mountRoot, '.agentbootup-mount-watcher.json'), { force: true });
      try {
        if (fs.existsSync(match.mountRoot) && fs.readdirSync(match.mountRoot).length === 0) {
          fs.rmdirSync(match.mountRoot);
        }
      } catch (err) {
        if (err && typeof err === 'object' && (err.code === 'ENOENT' || err.code === 'ENOTEMPTY')) {
          /* preserve leftover operator files and benign races */
        } else {
          io.stderr(
            `[unmount] warning: could not remove empty mount root ${match.mountRoot}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      io.stdout(`[unmount] detached ${match.mountRoot}`);
    }
  } catch (err) {
    io.stderr(`unmount failed: ${normalizeCommandError('unmount failed', err)}`);
    return 1;
  }

  return 0;
}

/**
 * @param {string[]} args argv after `list-mounts`
 * @param {{ stdout: function, stderr: function }} io
 * @returns {number}
 */
export function runListMountsCommand(args, io) {
  if (args.includes('--cwd')) {
    io.stderr(
      'list-mounts: --cwd is ignored; mounts are listed from AGENTBOOTUP_MOUNTS_BASE or ~/.brain/mounts\n'
    );
  }
  const positionals = getPositionalArgs(args, ['--cwd']);
  const filterBrain = positionals[0] || '';

  const rows = enumerateMounts();
  const filtered = filterBrain
    ? rows.filter((r) => r.brainKey === filterBrain || r.record?.brain_id === filterBrain)
    : rows;

  const lines = filtered.map((r) => {
    const lifecycle = getMountLifecycle(r.record);
    const cfgPath = r.record?.environment?.config_path;
    let hashStatus = 'unknown';
    if (cfgPath && fs.existsSync(cfgPath)) {
      hashStatus = envConfigHashMatchesDisk(cfgPath, r.record);
    } else if (cfgPath) {
      hashStatus = 'missing_config';
    }
    return {
      environment: r.envName,
      brain_key: r.brainKey,
      brain_id: r.record?.brain_id,
      mounted_at: r.record?.mounted_at,
      mount_kind: lifecycle.mountKind,
      live: lifecycle.live,
      watcher_status: lifecycle.watcherStatus,
      last_synced_at: lifecycle.lastSyncedAt,
      approval_mode: getApprovalFlowMode(r.record),
      config_hash_status: hashStatus,
      mount_root: r.mountRoot,
    };
  });

  io.stdout(JSON.stringify({ mounts: lines }, null, 2));
  return 0;
}
