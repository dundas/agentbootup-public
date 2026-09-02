import { extractCwd, getFlagValue, hasFlag } from '../args.js';
import { loadNetworkConfig, saveNetworkConfig } from '../config.js';
import { getMachineId } from '../../machine-id/machine-id.js';

const APP_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function printUsage(io) {
  io.stdout('Usage: agentbootup app access <grant|revoke|list> [<app>] [--project <project-id>] [--json] [--cwd <path>]');
}

function validateAppId(appId) {
  if (typeof appId !== 'string' || appId.trim() === '') {
    return 'app id is required';
  }
  if (appId.length > 63) {
    return 'app id must be 63 characters or fewer';
  }
  if (!APP_ID_RE.test(appId)) {
    return 'app id must match /^[a-z0-9][a-z0-9_-]*$/i';
  }
  return null;
}

function validateProjectId(projectId) {
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    return 'project id is required';
  }
  if (projectId.length > 255) {
    return 'project id must be 255 characters or fewer';
  }
  return null;
}

function ensureNetworkConfig(config) {
  if (config.role !== 'network') {
    throw new Error('command requires role "network"');
  }
}

function bumpConfigVersion(config, mutatedKeyWasAbsent) {
  if (mutatedKeyWasAbsent && config.version === '2.0') {
    return '2.1';
  }
  return config.version;
}

function cloneAppsAccess(appsAccess = {}) {
  const cloned = {};
  for (const [appId, entry] of Object.entries(appsAccess)) {
    cloned[appId] = { projects: Array.isArray(entry?.projects) ? [...entry.projects] : [] };
  }
  return cloned;
}

async function runGrant(args, io, cwd) {
  const appId = args[0] || '';
  const projectId = getFlagValue(args, '--project');
  const appError = validateAppId(appId);
  if (appError) {
    io.stderr(`app access grant failed: ${appError}`);
    return 1;
  }
  const projectError = validateProjectId(projectId);
  if (projectError) {
    io.stderr(`app access grant failed: ${projectError}`);
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
    ensureNetworkConfig(loaded.config);
  } catch (err) {
    io.stderr(`app access grant failed: ${err.message}`);
    return 1;
  }

  const config = { ...loaded.config };
  const hadMachineId = typeof config.machine_id === 'string' && config.machine_id.trim() !== '';
  const appsAccess = cloneAppsAccess(config.apps_access);
  const hadAppsAccess = config.apps_access != null;
  const entry = appsAccess[appId] || { projects: [] };
  if (entry.projects.includes(projectId)) {
    io.stdout(`Already granted ${appId} access to project ${projectId}`);
    return 0;
  }

  entry.projects.push(projectId);
  appsAccess[appId] = entry;
  config.apps_access = appsAccess;
  config.machine_id = config.machine_id ?? await getMachineId();
  config.version = bumpConfigVersion(config, !hadAppsAccess || !hadMachineId);

  try {
    saveNetworkConfig(config, cwd);
  } catch (err) {
    io.stderr(`app access grant failed: ${err.message}`);
    return 1;
  }

  io.stdout(`Granted ${appId} access to project ${projectId}`);
  return 0;
}

async function runRevoke(args, io, cwd) {
  const appId = args[0] || '';
  const projectId = getFlagValue(args, '--project');
  const appError = validateAppId(appId);
  if (appError) {
    io.stderr(`app access revoke failed: ${appError}`);
    return 1;
  }
  const projectError = validateProjectId(projectId);
  if (projectError) {
    io.stderr(`app access revoke failed: ${projectError}`);
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
    ensureNetworkConfig(loaded.config);
  } catch (err) {
    io.stderr(`app access revoke failed: ${err.message}`);
    return 1;
  }

  const currentEntry = loaded.config.apps_access?.[appId];
  if (!currentEntry || !Array.isArray(currentEntry.projects) || !currentEntry.projects.includes(projectId)) {
    io.stdout(`Not granted ${appId} access to project ${projectId}`);
    return 0;
  }

  const config = { ...loaded.config };
  const hadMachineId = typeof config.machine_id === 'string' && config.machine_id.trim() !== '';
  const hadAppsAccess = config.apps_access != null;
  const appsAccess = cloneAppsAccess(config.apps_access);
  const entry = appsAccess[appId];
  entry.projects = entry.projects.filter((candidate) => candidate !== projectId);
  if (entry.projects.length === 0) {
    delete appsAccess[appId];
  } else {
    appsAccess[appId] = entry;
  }
  if (Object.keys(appsAccess).length === 0) {
    delete config.apps_access;
  } else {
    config.apps_access = appsAccess;
  }
  config.machine_id = config.machine_id ?? await getMachineId();
  config.version = bumpConfigVersion(config, !hadAppsAccess || !hadMachineId);

  try {
    saveNetworkConfig(config, cwd);
  } catch (err) {
    io.stderr(`app access revoke failed: ${err.message}`);
    return 1;
  }

  io.stdout(`Revoked ${appId} access to project ${projectId}`);
  return 0;
}

function renderTable(appsAccess, io) {
  io.stdout('APP             PROJECTS');
  for (const [appId, entry] of Object.entries(appsAccess)) {
    io.stdout(`${appId.padEnd(15)} ${entry.projects.join(', ')}`);
  }
}

async function runList(args, io, cwd) {
  const json = hasFlag(args, '--json');
  const appId = args[0] && !args[0].startsWith('-') ? args[0] : '';

  if (appId) {
    const appError = validateAppId(appId);
    if (appError) {
      io.stderr(`app access list failed: ${appError}`);
      return 1;
    }
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
    ensureNetworkConfig(loaded.config);
  } catch (err) {
    io.stderr(`app access list failed: ${err.message}`);
    return 1;
  }

  const appsAccess = loaded.config.apps_access ?? {};
  if (json) {
    io.stdout(JSON.stringify(appsAccess, null, 2));
    return 0;
  }

  if (appId) {
    const projects = appsAccess[appId]?.projects ?? [];
    if (projects.length === 0) {
      io.stdout(`No projects granted for ${appId}.`);
      return 0;
    }
    for (const projectId of projects) {
      io.stdout(projectId);
    }
    return 0;
  }

  if (Object.keys(appsAccess).length === 0) {
    io.stdout('No apps have been granted access.');
    return 0;
  }

  renderTable(appsAccess, io);
  return 0;
}

export async function runAppCommand(argv, io) {
  const extracted = extractCwd(argv);
  const args = extracted.args;

  if (args.length === 0 || hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printUsage(io);
    return 0;
  }

  if (args[0] !== 'access') {
    io.stderr(`app failed: unknown subcommand "${args[0]}"`);
    printUsage(io);
    return 1;
  }

  const action = args[1];
  const localArgs = args.slice(2);
  switch (action) {
    case 'grant':
      return runGrant(localArgs, io, extracted.cwd);
    case 'revoke':
      return runRevoke(localArgs, io, extracted.cwd);
    case 'list':
      return runList(localArgs, io, extracted.cwd);
    default:
      io.stderr(`app access failed: unknown action "${action || ''}"`);
      printUsage(io);
      return 1;
  }
}
