/**
 * Brain Link / Unlink / Remove — map brain identities to local directories.
 *
 * brain link <agent-id> [--path <dir>]   Map a brain to a local directory
 * brain unlink <agent-id>                Remove path but keep in registry
 * brain remove <agent-id>                Remove project entirely from config
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { getNetworkRoot } from '../config/config.js';
import { loadNetworkConfig, saveNetworkConfig, resolveNetworkConfigPath, resolveProjectPath, NETWORK_CONFIG_FILE } from '../network/config.js';
import { getFlagValue } from '../network/args.js';
import { inspectCredentials, CREDS_STATE_OK } from '../auth/credentials.js';
import { isBrainRegistered } from '../sync/brains.js';

/**
 * Load the raw (unresolved) network config JSON from disk.
 * Unlike loadNetworkConfig(), this does NOT resolve portable project paths to
 * absolute paths, so portable path strings (./..., ~/...) are preserved as-is.
 * @param {string} networkRoot
 * @returns {{ raw: object, configPath: string }}
 */
function loadRawNetworkConfig(networkRoot) {
  const configPath = resolveNetworkConfigPath(networkRoot);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ${NETWORK_CONFIG_FILE} in ${networkRoot}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}: ${err.message}`);
    }
    throw new Error(`Unable to read ${configPath}: ${err.message}`);
  }
  return { raw, configPath };
}

/**
 * Convert an absolute path to a portable format:
 * - If under networkRoot → ./relative
 * - If under homedir → ~/relative
 * - Otherwise → absolute
 */
function toPortablePath(absPath, networkRoot) {
  // Use realpath to resolve symlinks (e.g. /var -> /private/var on macOS)
  let normalized, realRoot;
  try { normalized = fs.realpathSync(path.resolve(absPath)); } catch { normalized = path.resolve(absPath); }
  try { realRoot = fs.realpathSync(networkRoot); } catch { realRoot = networkRoot; }

  // Check if under network root first (more specific)
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (normalized === realRoot || normalized.startsWith(rootWithSep)) {
    const rel = path.relative(realRoot, normalized);
    // Normalize separators to forward slashes for cross-platform portability
    const relFwd = rel.split(path.sep).join('/');
    return relFwd === '' ? './' : `./${relFwd}`;
  }

  // Check if under home directory
  const home = os.homedir();
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  if (normalized === home || normalized.startsWith(homeWithSep)) {
    const rel = path.relative(home, normalized);
    // Normalize separators to forward slashes for cross-platform portability
    const relFwd = rel.split(path.sep).join('/');
    return `~/${relFwd}`;
  }

  return normalized;
}

async function warnIfBrainUnregistered(agentId, io) {
  try {
    const credentialState = await inspectCredentials();
    if (credentialState.state !== CREDS_STATE_OK) return;
    const registered = await isBrainRegistered(credentialState.creds, agentId);
    if (!registered) {
      io.stderr(
        `Warning: ${agentId} is linked locally but not registered on the current server. ` +
        'Local brain link state is separate from server-side restore registration.',
      );
    }
  } catch (err) {
    const message = err?.message ?? String(err);
    io.stderr(`Warning: could not verify server-side registration for ${agentId}: ${message}`);
  }
}

/**
 * brain link <agent-id> [--path <dir>]
 */
export async function runBrainLink(args, io) {
  // Find positional agent id, skipping flags and their values (e.g. --path <dir>)
  let agentId;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--path') {
      i++; // skip the value following --path
      continue;
    }
    if (!a.startsWith('-')) {
      agentId = a;
      break;
    }
  }
  if (!agentId) {
    io.stderr('Usage: agentbootup brain link <agent-id> [--path <dir>]');
    return 1;
  }

  const networkRoot = await getNetworkRoot();
  if (!networkRoot) {
    io.stderr('brain link failed: no network root configured. Run: agentbootup config set-network-root <path>');
    return 1;
  }

  const explicitPath = getFlagValue(args, '--path');
  let targetPath = path.resolve(explicitPath || process.cwd());
  try { targetPath = fs.realpathSync(targetPath); } catch { /* use resolved path */ }

  if (!fs.existsSync(targetPath)) {
    io.stderr(`brain link failed: path does not exist: ${targetPath}`);
    return 1;
  }

  let rawConfig;
  try {
    ({ raw: rawConfig } = loadRawNetworkConfig(networkRoot));
  } catch (err) {
    io.stderr(`brain link failed: ${err.message}`);
    return 1;
  }

  if (rawConfig.role !== 'network') {
    io.stderr('brain link failed: config is not a network config');
    return 1;
  }

  const portablePath = toPortablePath(targetPath, networkRoot);
  const projects = rawConfig.projects || [];
  const existing = projects.find((p) => p.agent_id === agentId);

  if (existing) {
    const oldPath = existing.path;
    existing.path = portablePath;
    if (oldPath && oldPath !== portablePath) {
      io.stdout(`Warning: re-linking ${agentId} from ${oldPath} to ${portablePath}`);
    }
  } else {
    // Create minimal entry — derive id from agent_id (strip .gm suffix if present)
    const id = agentId.replace(/\.gm$/, '');
    projects.push({
      id,
      agent_id: agentId,
      path: portablePath,
      brain: true,
    });
    rawConfig.projects = projects;
  }

  try {
    saveNetworkConfig(rawConfig, networkRoot);
  } catch (err) {
    io.stderr(`brain link failed: could not save config: ${err.message}`);
    return 1;
  }

  io.stdout(`Linked ${agentId} -> ${portablePath}`);
  await warnIfBrainUnregistered(agentId, io);
  return 0;
}

/**
 * brain unlink <agent-id>
 */
export async function runBrainUnlink(args, io) {
  const agentId = args.find((a) => !a.startsWith('-'));
  if (!agentId) {
    io.stderr('Usage: agentbootup brain unlink <agent-id>');
    return 1;
  }

  const networkRoot = await getNetworkRoot();
  if (!networkRoot) {
    io.stderr('brain unlink failed: no network root configured');
    return 1;
  }

  let rawConfig;
  try {
    ({ raw: rawConfig } = loadRawNetworkConfig(networkRoot));
  } catch (err) {
    io.stderr(`brain unlink failed: ${err.message}`);
    return 1;
  }

  const project = (rawConfig.projects || []).find((p) => p.agent_id === agentId);

  if (!project) {
    io.stderr(`brain unlink failed: no project with agent_id "${agentId}"`);
    return 1;
  }

  delete project.path;

  try {
    saveNetworkConfig(rawConfig, networkRoot);
  } catch (err) {
    io.stderr(`brain unlink failed: could not save config: ${err.message}`);
    return 1;
  }

  io.stdout(`Unlinked ${agentId} (removed local path, kept in registry)`);
  return 0;
}

/**
 * brain remove <agent-id>
 */
export async function runBrainRemove(args, io) {
  const agentId = args.find((a) => !a.startsWith('-'));
  if (!agentId) {
    io.stderr('Usage: agentbootup brain remove <agent-id>');
    return 1;
  }

  const networkRoot = await getNetworkRoot();
  if (!networkRoot) {
    io.stderr('brain remove failed: no network root configured');
    return 1;
  }

  let rawConfig;
  try {
    ({ raw: rawConfig } = loadRawNetworkConfig(networkRoot));
  } catch (err) {
    io.stderr(`brain remove failed: ${err.message}`);
    return 1;
  }

  const projects = rawConfig.projects || [];
  const idx = projects.findIndex((p) => p.agent_id === agentId);

  if (idx === -1) {
    io.stderr(`brain remove failed: no project with agent_id "${agentId}"`);
    return 1;
  }

  projects.splice(idx, 1);
  rawConfig.projects = projects;

  try {
    saveNetworkConfig(rawConfig, networkRoot);
  } catch (err) {
    io.stderr(`brain remove failed: could not save config: ${err.message}`);
    return 1;
  }

  io.stdout(`Removed ${agentId} from network config`);
  return 0;
}

/**
 * brain list — show all brains with link status
 */
export async function runBrainList(args, io) {
  const networkRoot = await getNetworkRoot();
  if (!networkRoot) {
    io.stderr('brain list failed: no network root configured. Run: agentbootup config set-network-root <path>');
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(networkRoot);
  } catch (err) {
    io.stderr(`brain list failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  const projects = config.projects || [];

  if (projects.length === 0) {
    io.stdout('No brains registered. Use "brain link <agent-id> --path <dir>" to add one.');
    return 0;
  }

  io.stdout(`Brains (${projects.length}):`);
  io.stdout('');
  for (const project of projects) {
    const resolved = resolveProjectPath(project.path, networkRoot);
    const status = resolved ? 'linked' : 'not linked';
    const pathDisplay = resolved || '(no path)';
    io.stdout(`  ${project.agent_id}`);
    io.stdout(`    Path:   ${pathDisplay}`);
    io.stdout(`    Status: ${status}`);
  }

  return 0;
}
