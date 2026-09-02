import fs from 'fs';
import path from 'path';

/**
 * Load and validate `environments/<name>.json` against the network config (PRD-0017).
 * @param {string} networkRoot
 * @param {string} envName
 * @param {{ projects?: Array<{ id: string }> }} config Loaded network config (`agentbootup.json`).
 */
export function loadEnvManifest(networkRoot, envName, config) {
  const safeName = String(envName || '').trim();
  if (!safeName) {
    throw new Error('environment name is required');
  }
  if (safeName.includes('..') || safeName.includes('/') || safeName.includes('\\')) {
    throw new Error(`invalid environment name "${envName}"`);
  }

  const filePath = path.join(networkRoot, 'environments', `${safeName}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`environment manifest not found: ${filePath}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`environment manifest invalid JSON (${filePath}): ${msg}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error(`environment manifest must be a JSON object (${filePath})`);
  }

  const { id, version, projects, install_order: installOrder } = raw;

  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`environment manifest "${filePath}" requires string field "id"`);
  }
  if (id.trim() !== safeName) {
    throw new Error(`environment manifest id "${id}" must match filename "${safeName}.json"`);
  }

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`environment manifest "${filePath}" requires integer field "version" >= 1`);
  }

  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error(`environment manifest "${filePath}" requires non-empty "projects" array`);
  }

  for (const p of projects) {
    if (typeof p !== 'string' || !p.trim()) {
      throw new Error(`environment manifest "${filePath}" requires "projects" to be non-empty strings`);
    }
  }

  const projectSet = new Set();
  for (const p of projects) {
    if (projectSet.has(p)) {
      throw new Error(`environment manifest "${filePath}" duplicate project id "${p}"`);
    }
    projectSet.add(p);
  }

  const configProjects = config.projects || [];
  const configIds = new Set(configProjects.map((p) => p.id));

  for (const pid of projects) {
    if (!configIds.has(pid)) {
      throw new Error(`environment "${safeName}": unknown project id "${pid}" (not in agentbootup.json)`);
    }
  }

  let orderedProjectIds;
  if (installOrder != null) {
    if (!Array.isArray(installOrder)) {
      throw new Error(`environment manifest "${filePath}" field "install_order" must be an array`);
    }
    const orderSeen = new Set();
    for (const pid of installOrder) {
      if (typeof pid !== 'string' || !pid.trim()) {
        throw new Error(`environment manifest "${filePath}" install_order entries must be non-empty strings`);
      }
      if (!projectSet.has(pid)) {
        throw new Error(`environment manifest "${filePath}" install_order contains unknown id "${pid}"`);
      }
      if (orderSeen.has(pid)) {
        throw new Error(`environment manifest "${filePath}" duplicate id "${pid}" in install_order`);
      }
      orderSeen.add(pid);
    }
    if (orderSeen.size !== projectSet.size) {
      throw new Error(
        `environment manifest "${filePath}" install_order must list each project in "projects" exactly once`
      );
    }
    orderedProjectIds = [...installOrder];
  } else {
    orderedProjectIds = [...projects];
  }

  return {
    id: safeName,
    version,
    projects: [...projects],
    orderedProjectIds,
    filePath,
  };
}
