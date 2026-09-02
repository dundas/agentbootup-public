import path from 'path';
import { loadNetworkConfig, saveNetworkConfig, resolveNetworkConfigPath } from '../config.js';
import { getFlagValue, extractCwd } from '../args.js';
import { getNetworkRoot } from '../../config/config.js';
import fs from 'fs';

function isWritableNetworkRoot(cwd) {
  try {
    fs.accessSync(resolveNetworkConfigPath(cwd), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a project to the current network root.
 *
 * Defaults `trusted: true` when writing into a writable network root the
 * operator already owns. Pass `--untrusted` to opt out for third-party brains.
 */
export async function runAddCommand(args, io) {
  const extracted = extractCwd(args);
  let cwd = extracted.cwd;
  const localArgs = extracted.args;

  const id = localArgs[0];
  const projectPathArg = localArgs[1];
  const agentId = getFlagValue(localArgs, '--agent');
  const type = getFlagValue(localArgs, '--type') || 'service';
  const caps = getFlagValue(localArgs, '--capabilities');
  const reportsTo = getFlagValue(localArgs, '--reports-to') || 'decisive-gm';
  const untrusted = localArgs.includes('--untrusted');

  if (!id || !projectPathArg || !agentId) {
    io.stderr('Usage: agentbootup add <id> <path> --agent <agent-id> [--type <type>] [--capabilities "a,b"] [--reports-to <agent>] [--untrusted]');
    return 1;
  }

  // If the CWD has no agentbootup.json, fall back to the configured network root.
  if (!fs.existsSync(resolveNetworkConfigPath(cwd))) {
    const networkRoot = await getNetworkRoot();
    if (networkRoot && fs.existsSync(resolveNetworkConfigPath(networkRoot))) {
      cwd = networkRoot;
    }
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`add failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  if (config.role !== 'network') {
    io.stderr('add failed: command requires role "network"');
    return 1;
  }

  if ((config.projects || []).some((project) => project.id === id)) {
    io.stderr(`add failed: project ${id} already exists`);
    return 1;
  }

  const projectPath = path.resolve(projectPathArg);
  const project = {
    id,
    path: projectPath,
    agent_id: agentId,
    type,
    brain: true,
    trusted: !untrusted && isWritableNetworkRoot(cwd),
    reports_to: reportsTo,
    capabilities: caps ? caps.split(',').map((item) => item.trim()).filter(Boolean) : [],
  };

  config.projects = config.projects || [];
  config.projects.push(project);
  saveNetworkConfig(config, cwd);

  io.stdout(`Added project ${id}`);
  io.stdout(`Path: ${project.path}`);
  io.stdout(`Agent: ${project.agent_id}`);
  return 0;
}
