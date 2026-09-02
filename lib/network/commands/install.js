import path from 'path';
import { extractCwd, getFlagValue, getPositionalArgs, hasFlag } from '../args.js';
import { loadNetworkConfig } from '../config.js';
import { loadEnvManifest } from '../env-manifest.js';
import { runProvisionCommand, provisionSingleProject } from './provision.js';
import { loadEnvConfigFile } from '../../brain/env-config.js';
import { runMountCommand } from './mount-cli.js';

function forwardArgsToProvision(localArgs) {
  const out = [];
  for (let i = 0; i < localArgs.length; i++) {
    const a = localArgs[i];
    if (a === '--env') {
      i += 1;
      continue;
    }
    if (a === '--dry-run') continue;
    out.push(a);
  }
  return out;
}

function stripEnvConfigFlags(args) {
  const hasEnvConfig = args.includes('--env-config');
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--env-config') {
      i += 1;
      continue;
    }
    if (hasEnvConfig && a === '--env') {
      if (i + 1 < args.length) i += 1;
      continue;
    }
    if (a === '--bypass-approvals') continue;
    out.push(a);
  }
  return out;
}

/**
 * `install <project-id> --env-config <path>` — provision single project + env mount (Phase 3).
 */
async function runInstallWithEnvConfig(cwd, localArgs, io) {
  const envConfigRaw = getFlagValue(localArgs, '--env-config');
  const envConfigPath = path.resolve(cwd, envConfigRaw);
  const bypass = hasFlag(localArgs, '--bypass-approvals');
  const dryRun = hasFlag(localArgs, '--dry-run');

  const positionals = getPositionalArgs(localArgs, [
    '--cwd',
    '--env',
    '--dry-run',
    '--env-config',
    '--portfolio-protocols',
    '--bypass-approvals',
  ]);
  if (positionals.length < 1) {
    io.stderr('install failed: usage: install <project-id> --env-config <path> [--cwd <dir>] [--dry-run]');
    return 1;
  }
  const projectId = positionals[0];

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`install failed: ${err.message}`);
    return 1;
  }
  const { config } = loaded;
  if (config.role !== 'network') {
    io.stderr('install failed: command requires role "network"');
    return 1;
  }

  const loadedEnv = loadEnvConfigFile(envConfigPath);
  if (!loadedEnv.ok) {
    io.stderr(`install failed: ${loadedEnv.error}`);
    return 1;
  }
  for (const warning of loadedEnv.warnings || []) {
    io.stderr(`install: warning: ${warning}`);
  }

  const project = (config.projects || []).find((p) => p.id === projectId);
  if (!project) {
    io.stderr(`install failed: unknown project id "${projectId}"`);
    return 1;
  }

  if (dryRun) {
    io.stdout(
      `install --dry-run: would provision "${projectId}" then apply env mount from ${envConfigPath}`
    );
    return 0;
  }

  const provArgs = stripEnvConfigFlags(localArgs);
  const code = await provisionSingleProject(cwd, config, project, provArgs, io);
  if (code !== 0) return code;

  return await runMountCommand(
    [projectId, '--env-config', envConfigPath, ...(bypass ? ['--bypass-approvals'] : []), '--cwd', cwd],
    io
  );
}

export async function runInstallCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;
  const localArgs = extracted.args;

  if (getFlagValue(localArgs, '--env-config')) {
    return await runInstallWithEnvConfig(cwd, localArgs, io);
  }

  const envName = getFlagValue(localArgs, '--env');
  if (!envName) {
    io.stderr(
      'install failed: use --env <manifest-name> for portfolio environments/, or install <project-id> --env-config <path> for Phase 3 env contract'
    );
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`install failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  if (config.role !== 'network') {
    io.stderr('install failed: command requires role "network"');
    return 1;
  }

  let manifest;
  try {
    manifest = loadEnvManifest(cwd, envName, config);
  } catch (err) {
    io.stderr(`install failed: ${err.message}`);
    return 1;
  }

  if (hasFlag(localArgs, '--dry-run')) {
    io.stdout(`install --dry-run: environment "${manifest.id}" (${manifest.orderedProjectIds.length} project(s))`);
    for (const id of manifest.orderedProjectIds) {
      io.stdout(`  would provision: ${id}`);
    }
    return 0;
  }

  const forwarded = forwardArgsToProvision(localArgs);
  const argv = ['--env', envName, '--cwd', cwd, ...forwarded];
  return await runProvisionCommand(argv, io);
}
