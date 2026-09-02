/**
 * lib/project-config.js
 *
 * Single canonical read boundary for project identity and configuration.
 *
 * `agentbootup.json` remains the canonical project config. Identity resolution
 * also inspects the deployed `brain/config.json` copy for compatibility and
 * fails closed when the declarations disagree.
 *
 * Fields in agentbootup.json:
 *   agent_id    — canonical brain identifier (e.g. "bootup")
 *   type        — agent type (e.g. "service")
 *   reports_to  — parent agent (e.g. "decisive")
 *   network     — path to network root (e.g. "~/dev_env/decisive_redux")
 *   hub         — ADMP hub URL (e.g. "https://agentdispatch.fly.dev")
 *   capabilities — array of capability strings
 *   groups      — array of group memberships
 *   monitoring  — monitoring config
 *   selfImprovement — self-improvement config
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeFileAtomic } from './brain/io-utils.js';

const CONFIG_FILE = 'agentbootup.json';
const LEGACY_CONFIG_FILE = path.join('brain', 'config.json');
const CANONICAL_AGENT_ID_KEY = 'agent_id';
const COMPATIBLE_AGENT_ID_KEY = 'agentId';

export class ProjectIdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProjectIdentityError';
    this.code = code;
  }
}

function identityPaths(cwd) {
  const root = path.resolve(cwd);
  return [
    path.join(root, CONFIG_FILE),
    path.join(root, LEGACY_CONFIG_FILE),
  ];
}

function inspectedIdentityHint(paths) {
  return `Inspected ${paths.join(' and ')} for "${CANONICAL_AGENT_ID_KEY}" (canonical) or "${COMPATIBLE_AGENT_ID_KEY}" (compatibility).`;
}

function readIdentityConfig(configPath, allPaths) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new ProjectIdentityError(
      `Unable to read project identity configuration at ${configPath}: ${err.message}. ${inspectedIdentityHint(allPaths)}`,
      'PROJECT_IDENTITY_INVALID',
    );
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new ProjectIdentityError(
      `Project identity configuration contains invalid JSON at ${configPath}: ${err.message}. ${inspectedIdentityHint(allPaths)}`,
      'PROJECT_IDENTITY_INVALID',
    );
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ProjectIdentityError(
      `Project identity configuration at ${configPath} must be a JSON object. ${inspectedIdentityHint(allPaths)}`,
      'PROJECT_IDENTITY_INVALID',
    );
  }
  return config;
}

function readAgentIdCandidate(config, configPath, allPaths) {
  const candidates = [];
  for (const key of [CANONICAL_AGENT_ID_KEY, COMPATIBLE_AGENT_ID_KEY]) {
    const raw = config[key];
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) continue;
    if (typeof raw !== 'string') {
      throw new ProjectIdentityError(
        `Project identity key "${key}" in ${configPath} must be a non-empty string. ${inspectedIdentityHint(allPaths)}`,
        'PROJECT_IDENTITY_INVALID',
      );
    }
    candidates.push({ key, value: raw.trim(), configPath });
  }

  if (candidates.length === 2 && candidates[0].value !== candidates[1].value) {
    throw new ProjectIdentityError(
      `Conflicting project identity in ${configPath}: "${candidates[0].key}"="${candidates[0].value}" differs from ` +
      `"${candidates[1].key}"="${candidates[1].value}"; refusing to choose a brain. ${inspectedIdentityHint(allPaths)}`,
      'PROJECT_IDENTITY_CONFLICT',
    );
  }
  return candidates[0] ?? null;
}

/**
 * Resolve the supported identity keys from an already-parsed project config.
 *
 * This is the object-level half of the canonical read boundary. Callers that
 * already loaded JSON (for example network validation and doctor) must use the
 * same casing, type, and conflict rules as resolveProjectAgentId().
 *
 * @param {object} config
 * @param {string} [configPath]
 * @param {string[]} [allPaths]
 * @returns {string | null}
 */
export function resolveProjectAgentIdDeclaration(
  config,
  configPath = 'project configuration',
  allPaths = [configPath],
) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ProjectIdentityError(
      `Project identity configuration at ${configPath} must be a JSON object. ${inspectedIdentityHint(allPaths)}`,
      'PROJECT_IDENTITY_INVALID',
    );
  }
  return readAgentIdCandidate(config, configPath, allPaths)?.value ?? null;
}

/**
 * Resolve a non-empty, unambiguous project agent ID.
 *
 * Both project identity files are inspected so a stale fallback cannot silently
 * select a different brain. `agent_id` is canonical; the deployed `agentId`
 * spelling remains accepted during migration.
 *
 * @param {string} [cwd]
 * @returns {string}
 * @throws {ProjectIdentityError} when identity is missing, malformed, or ambiguous
 */
export function resolveProjectAgentId(cwd = process.cwd()) {
  const paths = identityPaths(cwd);
  const candidates = [];
  for (const configPath of paths) {
    const config = readIdentityConfig(configPath, paths);
    if (!config) continue;
    const value = resolveProjectAgentIdDeclaration(config, configPath, paths);
    if (value) {
      const canonical = config[CANONICAL_AGENT_ID_KEY];
      const key = typeof canonical === 'string' && canonical.trim()
        ? CANONICAL_AGENT_ID_KEY
        : COMPATIBLE_AGENT_ID_KEY;
      candidates.push({ key, value, configPath });
    }
  }

  if (candidates.length === 0) {
    throw new ProjectIdentityError(
      `No non-empty project agent ID was found. ${inspectedIdentityHint(paths)}`,
      'PROJECT_IDENTITY_MISSING',
    );
  }

  const first = candidates[0];
  const conflict = candidates.find((candidate) => candidate.value !== first.value);
  if (conflict) {
    throw new ProjectIdentityError(
      `Conflicting project identity declarations: ${first.configPath} "${first.key}"="${first.value}" differs from ` +
      `${conflict.configPath} "${conflict.key}"="${conflict.value}"; refusing to choose a brain. ${inspectedIdentityHint(paths)}`,
      'PROJECT_IDENTITY_CONFLICT',
    );
  }
  return first.value;
}

/**
 * Resolve identity when either supported project configuration file already
 * exists. A completely fresh directory returns null so commands with an
 * explicit brain ID can bootstrap it; once configuration exists, identity is
 * mandatory and all strict validation rules apply.
 *
 * @param {string} [cwd]
 * @returns {string | null}
 */
export function resolveConfiguredProjectAgentId(cwd = process.cwd()) {
  const paths = identityPaths(cwd);
  if (!paths.some((configPath) => fs.existsSync(configPath))) return null;
  return resolveProjectAgentId(cwd);
}

/**
 * Load and return the project config from agentbootup.json.
 *
 * @param {string} [cwd] — project root directory (defaults to process.cwd())
 * @returns {{ config: object, configPath: string }}
 * @throws if agentbootup.json is missing or unparseable
 */
export function loadProjectConfig(cwd = process.cwd()) {
  const configPath = path.join(path.resolve(cwd), CONFIG_FILE);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(`No agentbootup.json found at ${configPath}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`agentbootup.json is invalid JSON at ${configPath}`);
  }
  return { config, configPath };
}

/**
 * Return the resolved project agent ID, or null if no identity is declared.
 * Invalid or conflicting declarations throw so fallback callers cannot silently
 * select another brain.
 *
 * @param {string} [cwd]
 * @returns {string | null}
 */

/**
 * Ensure the canonical repo-root agentbootup.json exists with a `projects:[self]`
 * entry so this brain can run its own session-start fleet/hygiene scan
 * (repo-hygiene `check`, which reads `projects` via `discoverFleetTargets`).
 * Idempotent: preserves all existing fields, only sets `agent_id` when missing
 * and appends a self-target when absent. Does NOT touch the deployed
 * brain/config.json or run identity-resolution disagreement checks — this is a
 * provision-time scaffold of the canonical file, not a re-resolve.
 *
 * The self-target uses `path: "."` (portable — resolves to the repo root at
 * runtime via realpath; no machine-local path). `brain: true` satisfies
 * discoverFleetTargets' "at least one live brain target" invariant.
 *
 * @param {string} repoPath — absolute path to the brain's repo root
 * @param {{ agentId: string, projectId?: string }} opts
 * @returns {{ configPath: string, created: boolean, changed: boolean, wipedCorrupt: boolean, backedUp: boolean, staleAgentId: boolean }}
 */
export function ensureProjectConfig(repoPath, { agentId, projectId }) {
  const configPath = path.join(path.resolve(repoPath), CONFIG_FILE);
  let config = {};
  let existed = false;
  let wipedCorrupt = false;
  let backedUp = false;
  if (fs.existsSync(configPath)) {
    existed = true;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('non-object config');
      }
    } catch {
      // Corrupt config (syntax error OR parseable-but-non-object like null/[]/42):
      // preserve the corrupt bytes for diagnosis, then rebuild from the identity
      // facts we have. Dropping fields is unavoidable here, but the operator can
      // recover from the .corrupt backup. Mirrors the guards in loadProjectConfig /
      // readIdentityConfig (reject non-object configs, not just syntax errors).
      wipedCorrupt = true;
      let backedUpNow = false;
      try { fs.copyFileSync(configPath, configPath + '.corrupt'); backedUpNow = true; } catch {}
      backedUp = backedUpNow;
      // Do NOT destroy the only copy of corrupt bytes when the backup failed.
      // Leave the corrupt file untouched and surface the failure to the caller.
      if (!backedUpNow) {
        return { configPath, created: false, changed: false, wipedCorrupt: true, backedUp: false };
      }
      config = {};
    }
  }
  let changed = false;
  let staleAgentId = false;
  if (typeof config.agent_id !== 'string' || !config.agent_id) {
    config.agent_id = agentId;
    changed = true;
  } else if (config.agent_id !== agentId) {
    // Existing repo-root agent_id disagrees with the provisioned agentId. Don't
    // silently overwrite (would mask a real mis-provision) — surface it so the
    // operator resolves the identity conflict deliberately. The brain/config.json
    // writer (provision) overwrites unconditionally; here we preserve the existing
    // identity and report, because resolveProjectAgentId fails closed on conflict.
    staleAgentId = true;
  }
  const id = projectId || agentId;
  config.projects = Array.isArray(config.projects) ? config.projects : [];
  const hasSelf = config.projects.some(
    (p) => p && (p.id === id || p.agent_id === agentId) && p.brain === true,
  );
  if (!hasSelf) {
    config.projects.push({ id, agent_id: agentId, path: '.', brain: true });
    changed = true;
  }
  if (changed || !existed) {
    writeFileAtomic(configPath, JSON.stringify(config, null, 2) + '\n');
  }
  return { configPath, created: !existed, changed, wipedCorrupt, backedUp, staleAgentId };
}

export function getAgentId(cwd = process.cwd()) {
  try {
    return resolveProjectAgentId(cwd);
  } catch (err) {
    // Missing identity remains nullable for discovery/fallback callers. Invalid
    // or conflicting declarations are never discarded: callers must fail closed
    // rather than selecting a fallback brain.
    if (!(err instanceof ProjectIdentityError) || err.code !== 'PROJECT_IDENTITY_MISSING') {
      throw err;
    }
    return null;
  }
}

/**
 * Resolve the hub URL, expanding the "${network.hub}" indirection if present.
 *
 * Project brains can delegate their hub address to the network root rather than
 * hardcoding it. In agentbootup.json:
 *
 *   "network": "~/dev_env/decisive_redux",   // path to the network root project
 *   "hub": "${network.hub}"                  // sentinel — read hub from network root
 *
 * resolveHub() detects the sentinel string and reads the network root's own
 * agentbootup.json to return its "hub" value. This means only the network root
 * needs to be updated when the hub URL changes; all project brains inherit it
 * automatically.
 *
 * If "hub" is a plain URL (no "${...}"), it is returned as-is.
 *
 * @param {object} config — result of loadProjectConfig().config
 * @param {string} cwd — project root (used to resolve relative network path)
 * @returns {string | null}
 */
export function resolveHub(config, cwd = process.cwd()) {
  const hub = config.hub;
  if (!hub) return null;
  if (!hub.includes('${network.hub}')) return hub;

  // Resolve network root path
  const networkRaw = config.network;
  if (!networkRaw) return null;
  const networkPath = networkRaw.startsWith('~')
    ? networkRaw.replace(/^~(\/|$)/, os.homedir() + path.sep)
    : path.resolve(cwd, networkRaw);

  try {
    const { config: networkConfig } = loadProjectConfig(networkPath);
    return typeof networkConfig.hub === 'string' ? networkConfig.hub : null;
  } catch {
    return null;
  }
}
