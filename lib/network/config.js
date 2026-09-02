import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveProjectAgentIdDeclaration } from '../project-config.js';

export const NETWORK_CONFIG_FILE = 'agentbootup.json';
const NETWORK_HUB_PLACEHOLDER = '${network.hub}';
const LEGACY_HUB_PLACEHOLDER = '${portfolio.hub}';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns the role unchanged. Retained as an extension point for future
 * normalization (e.g. aliased role variants) without requiring call-site changes.
 */
export function normalizeRole(role) {
  return role;
}

export function resolveNetworkConfigPath(cwd = process.cwd()) {
  return path.join(cwd, NETWORK_CONFIG_FILE);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateTranscriptSync(config, errors) {
  if (config.transcriptSync == null) return;
  if (!config.transcriptSync || typeof config.transcriptSync !== 'object') {
    errors.push('transcriptSync must be an object');
    return;
  }

  const { enabled, clis, retentionDays } = config.transcriptSync;
  if (enabled != null && typeof enabled !== 'boolean') {
    errors.push('transcriptSync.enabled must be boolean');
  }
  if (clis != null) {
    if (!Array.isArray(clis) || clis.some((cli) => !['claude', 'codex', 'gemini', 'cursor'].includes(cli))) {
      errors.push('transcriptSync.clis must be an array of: claude, codex, gemini, cursor');
    }
  }
  if (retentionDays != null && (!Number.isInteger(retentionDays) || retentionDays <= 0)) {
    errors.push('transcriptSync.retentionDays must be a positive integer');
  }
}

function validateAppsAccess(config, errors) {
  if (config.apps_access == null) return;
  if (typeof config.apps_access !== 'object' || Array.isArray(config.apps_access)) {
    errors.push('apps_access must be a plain object');
    return;
  }

  for (const [appId, entry] of Object.entries(config.apps_access)) {
    if (!isNonEmptyString(appId)) {
      errors.push('apps_access key must be a non-empty string');
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`apps_access.${appId} must be an object`);
      continue;
    }
    if (!Array.isArray(entry.projects)) {
      errors.push(`apps_access.${appId}.projects must be an array`);
      continue;
    }
    if (entry.projects.some((projectId) => !isNonEmptyString(projectId))) {
      errors.push(`apps_access.${appId}.projects entries must be non-empty strings`);
    }
  }
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a project path using portable path conventions.
 *
 * Supported formats:
 *   null/undefined → null (unlinked project)
 *   ~/...          → expand home directory
 *   /absolute      → return as-is
 *   ./relative     → resolve against networkRoot
 *   anything else  → throw (unsupported format)
 */
export function resolveProjectPath(projectPath, networkRoot) {
  if (projectPath == null) return null;
  if (typeof projectPath !== 'string' || projectPath.trim() === '') return null;

  if (projectPath === '~' || projectPath.startsWith('~/')) {
    return expandHome(projectPath);
  }
  if (path.isAbsolute(projectPath)) {
    return projectPath;
  }
  if (projectPath.startsWith('./')) {
    if (!networkRoot) {
      throw new Error('networkRoot is required to resolve relative paths');
    }
    const resolved = path.resolve(networkRoot, projectPath);
    const rel = path.relative(networkRoot, resolved);
    if (rel.startsWith('..') || rel === '..') {
      throw new Error(`Path "${projectPath}" escapes the network root "${networkRoot}". Use an absolute path or a path within the network root.`);
    }
    return resolved;
  }
  throw new Error(`Unsupported path format: "${projectPath}". Use ./ for relative, ~/ for home-relative, or an absolute path.`);
}

function resolveProjectRootPath(projectConfig, cwd) {
  const root = projectConfig.network;
  if (!isNonEmptyString(root)) {
    throw new Error('project role requires network path');
  }
  const expanded = expandHome(root);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function resolveProjectHub(config, cwd) {
  if (config.role !== 'project') return config;

  const resolved = { ...config };

  if (resolved.hub === LEGACY_HUB_PLACEHOLDER) {
    throw new Error(
      'Stale hub placeholder "${portfolio.hub}" detected — re-run `agentbootup provision` to update brain/config.json to "${network.hub}"'
    );
  }

  if (resolved.hub && resolved.hub !== NETWORK_HUB_PLACEHOLDER) {
    return resolved;
  }

  const networkRoot = resolveProjectRootPath(resolved, cwd);
  const networkConfigPath = resolveNetworkConfigPath(networkRoot);
  if (!fs.existsSync(networkConfigPath)) {
    throw new Error(`Unable to resolve network hub: missing ${NETWORK_CONFIG_FILE} at ${networkRoot}`);
  }

  let networkConfig;
  try {
    networkConfig = JSON.parse(fs.readFileSync(networkConfigPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Unable to resolve network hub: invalid JSON at ${networkConfigPath}`);
  }

  if (networkConfig.role !== 'network') {
    throw new Error('Unable to resolve network hub: referenced config is not a network config');
  }
  if (!isNonEmptyString(networkConfig.hub)) {
    throw new Error('Unable to resolve network hub: hub is missing from network config');
  }

  resolved.hub = networkConfig.hub;
  return resolved;
}

export function validateNetworkConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['config must be an object'] };
  }

  const role = config.role;
  if (!role) {
    errors.push('role is required');
  } else if (role !== 'network' && role !== 'project') {
    errors.push('role must be "network" or "project"');
  }

  if (!config.version) {
    errors.push('version is required');
  }

  if (config.hub != null && !isNonEmptyString(config.hub)) {
    errors.push('hub must be a non-empty string');
  }

  if (config.skills_source != null && !isNonEmptyString(config.skills_source)) {
    errors.push('skills_source must be a non-empty string');
  }

  validateTranscriptSync(config, errors);
  validateAppsAccess(config, errors);

  if (config.machine_id != null && !UUID_RE.test(config.machine_id)) {
    errors.push('machine_id must be a valid UUID v4');
  }

  if (role === 'network') {
    if (!Array.isArray(config.projects)) {
      errors.push('network role requires projects array');
    } else {
      const ids = new Set();
      const agentIds = new Set();
      for (const project of config.projects) {
        if (!project || typeof project !== 'object') {
          errors.push('project entries must be objects');
          continue;
        }
        if (!project.id) errors.push('project.id is required');
        if (project.path != null && typeof project.path !== 'string') {
          errors.push(`project.path must be a string (project: ${project.id || 'unknown'})`);
        }
        if (!project.agent_id) errors.push('project.agent_id is required');
        if (project.branch != null && !isNonEmptyString(project.branch)) {
          errors.push(`project.branch must be a non-empty string (project: ${project.id || 'unknown'})`);
        }
        if (project.id && ids.has(project.id)) {
          errors.push(`duplicate project id: ${project.id}`);
        }
        if (project.id) ids.add(project.id);
        if (project.agent_id && agentIds.has(project.agent_id)) {
          errors.push(`duplicate project agent_id: ${project.agent_id}`);
        }
        if (project.agent_id) agentIds.add(project.agent_id);
      }
    }
  }

  if (role === 'project') {
    let agentId = null;
    let identityError = false;
    try {
      agentId = resolveProjectAgentIdDeclaration(config, 'project configuration');
    } catch (err) {
      identityError = true;
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (!agentId && !identityError) {
      errors.push('project role requires agent_id (canonical) or agentId (compatibility)');
    }
    if (!config.network) {
      errors.push('project role requires network path');
    }
    if (config.hub != null && config.hub !== NETWORK_HUB_PLACEHOLDER && !isNonEmptyString(config.hub)) {
      errors.push('project role hub must be a non-empty string or ${network.hub}');
    }
    if (config.apps_access != null) {
      errors.push('apps_access is only valid on network role');
    }
    if (config.machine_id != null) {
      errors.push('machine_id is only valid on network role');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function loadNetworkConfig(cwd = process.cwd()) {
  const configPath = resolveNetworkConfigPath(cwd);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ${NETWORK_CONFIG_FILE} in ${cwd}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}: ${err.message}`);
    }
    throw new Error(`Unable to read ${configPath}: ${err.message}`);
  }

  let normalized = parsed;

  if (parsed?.role === 'project') {
    const agentId = resolveProjectAgentIdDeclaration(parsed, configPath);
    if (agentId) {
      normalized = { ...parsed, agent_id: agentId };
      delete normalized.agentId;
    }
  }

  // Resolve project paths (~/..., ./..., /absolute, or null for unlinked)
  if (Array.isArray(normalized.projects)) {
    normalized.projects = normalized.projects.map((p) => ({
      ...p,
      path: typeof p.path === 'string' ? resolveProjectPath(p.path, cwd) : p.path,
    }));
  }

  const validation = validateNetworkConfig(normalized);
  if (!validation.valid) {
    throw new Error(`Invalid ${NETWORK_CONFIG_FILE}: ${validation.errors.join('; ')}`);
  }

  const resolved = resolveProjectHub(normalized, cwd);
  return { config: resolved, configPath };
}

export function saveNetworkConfig(config, cwd = process.cwd()) {
  let normalized = { ...config };
  if (normalized.role === 'project') {
    const agentId = resolveProjectAgentIdDeclaration(normalized, resolveNetworkConfigPath(cwd));
    if (agentId) {
      normalized = { ...normalized, agent_id: agentId };
      delete normalized.agentId;
    }
  }
  const validation = validateNetworkConfig(normalized);
  if (!validation.valid) {
    throw new Error(`Cannot save invalid config: ${validation.errors.join('; ')}`);
  }

  const configPath = resolveNetworkConfigPath(cwd);
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2) + '\n');
  return configPath;
}
