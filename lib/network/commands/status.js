import { loadNetworkConfig } from '../config.js';
import { extractCwd, getFlagValue, getPositionalArgs } from '../args.js';
import { loadEnvManifest } from '../env-manifest.js';

export async function runStatusCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`status failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;

  const positionals = getPositionalArgs(extracted.args, ['--cwd', '--env']);
  const envName = getFlagValue(extracted.args, '--env');
  if (positionals.length >= 1 && envName) {
    io.stderr('status failed: use either <brain-id> or --env, not both');
    return 1;
  }
  if (positionals.length === 1 && !envName) {
    const { printBrainLifecycleStatus } = await import('../../brain/lifecycle-status.js');
    return printBrainLifecycleStatus(positionals[0], cwd, io);
  }

  io.stdout('Network Status');
  io.stdout(`Role: ${config.role}`);

  if (config.role === 'network') {
    let projects = config.projects || [];
    const envName = getFlagValue(extracted.args, '--env');
    if (envName) {
      let manifest;
      try {
        manifest = loadEnvManifest(cwd, envName, config);
      } catch (err) {
        io.stderr(`status failed: ${err.message}`);
        return 1;
      }
      const allow = new Set(manifest.orderedProjectIds);
      projects = projects.filter((p) => allow.has(p.id));
    }
    const trustedCount = projects.filter((p) => p.trusted === true).length;
    const brainCount = projects.filter((p) => p.brain !== false).length;

    io.stdout(`Projects: ${projects.length}`);
    io.stdout(`Trusted: ${trustedCount}`);
    io.stdout(`Brain Enabled: ${brainCount}`);
    io.stdout('Project Table: id | agent_id | trusted | path');

    for (const project of projects) {
      io.stdout(`${project.id} | ${project.agent_id} | ${project.trusted === true ? 'yes' : 'no'} | ${project.path || '(not linked)'}`);
    }
  } else {
    io.stdout(`Agent ID: ${config.agent_id}`);
    io.stdout(`Network: ${config.network || 'unset'}`);
    io.stdout(`Capabilities: ${(config.capabilities || []).join(', ') || 'none'}`);
  }

  return 0;
}
