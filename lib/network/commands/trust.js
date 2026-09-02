import { loadNetworkConfig, saveNetworkConfig } from '../config.js';
import { extractCwd, getPositionalArgs, hasFlag } from '../args.js';

export function runTrustCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;
  const localArgs = extracted.args;
  const trustAll = hasFlag(localArgs, '--all');
  const [targetId = ''] = getPositionalArgs(localArgs);

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`trust failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  if (config.role !== 'network') {
    io.stdout('trust project mode: already local');
    return 0;
  }

  if (trustAll && targetId) {
    io.stderr('trust failed: use either --all or a project-id, not both');
    return 1;
  }

  const projects = config.projects || [];
  if (trustAll) {
    for (const project of projects) project.trusted = true;
    saveNetworkConfig(config, cwd);
    io.stdout(`Trusted ${projects.length} project(s)`);
    return 0;
  }

  if (!targetId) {
    io.stderr('Usage: agentbootup trust <project-id> | --all');
    return 1;
  }

  const project = projects.find((item) => item.id === targetId);
  if (!project) {
    io.stderr(`trust failed: unknown project ${targetId}`);
    return 1;
  }

  project.trusted = true;
  saveNetworkConfig(config, cwd);
  io.stdout(`Trusted ${targetId}`);
  return 0;
}
