import fs from 'node:fs';
import path from 'node:path';
import { loadNetworkConfig, resolveProjectPath } from '../network/config.js';
import { resolveProjectAgentId } from '../project-config.js';

function detectNetworkRoot(cwd) {
  const configPath = path.join(path.resolve(cwd), 'agentbootup.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
  return parsed?.role === 'network' ? configPath : null;
}

/**
 * Build the optional live-doctor runner that validates every project registered
 * in a selected network root. Returns null outside network-root mode.
 *
 * Identity failures return `unknown`, not `fail`: the fleet cannot safely
 * identify which brain to probe, so health is degraded rather than attributed
 * to a possibly wrong brain.
 *
 * @param {string} cwd
 * @returns {null | (() => Promise<object>)}
 */
export function createRegisteredProjectIdentitiesRunner(cwd = process.cwd()) {
  const networkConfigPath = detectNetworkRoot(cwd);
  if (!networkConfigPath) return null;

  return async () => {
    let config;
    try {
      ({ config } = loadNetworkConfig(path.resolve(cwd)));
    } catch (err) {
      return unknown(
        `registered project identity validation could not load ${networkConfigPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const failures = [];
    for (const project of config.projects ?? []) {
      const projectLabel = project.id || project.agent_id || '(unknown project)';
      if (!project.path) {
        failures.push(
          `${projectLabel}: ${networkConfigPath} projects[].path is missing; link the project so ` +
          'agentbootup.json and brain/config.json can be inspected for "agent_id" (canonical) or "agentId" (compatibility)',
        );
        continue;
      }

      let projectRoot;
      let resolvedAgentId;
      try {
        projectRoot = resolveProjectPath(project.path, path.resolve(cwd));
        resolvedAgentId = resolveProjectAgentId(projectRoot);
      } catch (err) {
        failures.push(`${projectLabel}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (resolvedAgentId !== project.agent_id) {
        failures.push(
          `${projectLabel}: ${networkConfigPath} projects[].agent_id="${project.agent_id}" conflicts with ` +
          `the project identity "${resolvedAgentId}" resolved from ${path.join(projectRoot, 'agentbootup.json')} ` +
          `or ${path.join(projectRoot, 'brain', 'config.json')}; align "agent_id" (canonical) and ` +
          '"agentId" (compatibility) before running network health checks',
        );
      }
    }

    if (failures.length > 0) {
      return unknown(
        `${failures.length} registered project identity failure${failures.length === 1 ? '' : 's'}: ${failures.join(' | ')}`,
      );
    }
    const count = config.projects?.length ?? 0;
    return {
      state: 'pass',
      severity: 'info',
      category: 'project_identities',
      message: `${count} registered project${count === 1 ? '' : 's'} resolved to non-empty, unambiguous identities`,
    };
  };
}

function unknown(message) {
  return {
    state: 'unknown',
    severity: 'warning',
    category: 'project_identities',
    message,
  };
}
