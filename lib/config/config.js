/**
 * Global agentbootup configuration.
 *
 * Stored at ~/.agentbootup/config.json with permissions 0o600.
 * Directory permissions are set to 0o700 on every write.
 *
 * Fields:
 *   brainId  — agentbootup brain identifier used when pushing transcript deltas.
 *              Set via `agentbootup config set-brain <id>`.
 *   memoryConvergeEnabled — persisted default for memory convergence.
 *                           Set via `agentbootup config set-converge <on|off>`.
 */

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Resolve the config file path lazily so the AGENTBOOTUP_CONFIG_FILE env var
 * is respected even under ES module hoisting (used for test isolation).
 * @returns {string}
 */
function getConfigFilePath() {
  return (
    process.env.AGENTBOOTUP_CONFIG_FILE ||
    path.join(os.homedir(), '.agentbootup', 'config.json')
  );
}

const CONFIG_VERSION = 1;
const VALID_SHARE_PROVIDERS = new Set(['smb', 'nfs', 'local']);
const DEFAULT_SHARE_BRAIN_ROOT = 'brains';

/**
 * Migrate a parsed config to the current schema version.
 * v0 (no version field): existing fields are valid — add version on next write.
 * @param {Record<string, unknown>} parsed
 * @returns {Record<string, unknown>}
 */
function migrateConfig(parsed) {
  // Strip internal version key — callers get a clean config object.
  const { _version: _v, ...rest } = parsed;
  return rest;
}

/**
 * Read the global config. Returns an empty object if the file does not exist
 * or cannot be parsed.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readConfig() {
  try {
    const raw = await fsp.readFile(getConfigFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return migrateConfig(parsed);
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return {};
    throw err;
  }
}

/**
 * Write the global config, merging over existing values.
 *
 * Writes atomically via a `.tmp` file + `rename()` to avoid leaving a
 * partially-written JSON file on SIGKILL mid-write.
 *
 * NOTE: The read-modify-write pattern is not protected by a file lock. The
 * CLI is single-threaded so concurrent calls are not expected in practice.
 * @param {Record<string, unknown>} patch
 */
export async function writeConfig(patch) {
  const configFile = getConfigFilePath();
  const configDir = path.dirname(configFile);
  const existing = await readConfig();
  const merged = { ...existing, ...patch };
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
  // chmod corrects permissions on pre-existing directories (mkdir mode only
  // applies when the directory is newly created).
  await fsp.chmod(configDir, 0o700);
  const tmpFile = configFile + '.tmp';
  // Persist _version so future schema changes have a migration path.
  await fsp.writeFile(tmpFile, JSON.stringify({ _version: CONFIG_VERSION, ...merged }, null, 2) + '\n', {
    mode: 0o600,
  });
  // rename() is atomic on POSIX; the destination inherits the tmp file's mode.
  await fsp.rename(tmpFile, configFile);
}

/**
 * Get the configured brain ID, or null if not set.
 * @returns {Promise<string | null>}
 */
export async function getBrainId() {
  const config = await readConfig();
  return typeof config.brainId === 'string' ? config.brainId : null;
}

/**
 * Persist a brain ID to the global config.
 * @param {string} brainId
 */
export async function setBrainId(brainId) {
  await writeConfig({ brainId });
}

/**
 * Get the configured network root path, or null if not set.
 * Env var AGENTBOOTUP_NETWORK_ROOT takes precedence over the config file.
 * @returns {Promise<string | null>}
 */
export async function getNetworkRoot() {
  if (process.env.AGENTBOOTUP_NETWORK_ROOT) {
    return process.env.AGENTBOOTUP_NETWORK_ROOT;
  }
  const config = await readConfig();
  return typeof config.networkRoot === 'string' ? config.networkRoot : null;
}

/**
 * Persist the network root path to the global config.
 * @param {string} rootPath
 */
export async function setNetworkRoot(rootPath) {
  await writeConfig({ networkRoot: rootPath });
}

/**
 * Persist the memory-converge default.
 * Environment overrides remain authoritative at runtime.
 * @param {boolean} enabled
 */
export async function setMemoryConvergeEnabled(enabled) {
  await writeConfig({ memoryConvergeEnabled: enabled === true });
}

/**
 * Get the configured skills mode.
 * @returns {Promise<'static'|'mech-storage'>}
 */
export async function getSkillsMode() {
  const config = await readConfig();
  return config.skills_mode === 'mech-storage' ? 'mech-storage' : 'static';
}

/**
 * Set the skills mode.
 * @param {'static'|'mech-storage'} mode
 */
export async function setSkillsMode(mode) {
  await writeConfig({ skills_mode: mode });
}

/**
 * Check whether the inbox daemon is enabled for a given brain.
 * Returns true only if explicitly enabled via setInboxEnabled.
 * @param {string} agentId  e.g. "decisive.gm"
 * @returns {Promise<boolean>}
 */
export async function getInboxEnabled(agentId) {
  const config = await readConfig();
  const map = config.inboxEnabled;
  if (!map || typeof map !== 'object') return false;
  return map[agentId] === true;
}

/**
 * Enable or disable the inbox daemon for a given brain.
 * Merges into the existing inboxEnabled map.
 * @param {string} agentId
 * @param {boolean} enabled
 */
export async function setInboxEnabled(agentId, enabled) {
  const config = await readConfig();
  const map = typeof config.inboxEnabled === 'object' && config.inboxEnabled !== null
    ? config.inboxEnabled
    : {};
  await writeConfig({ inboxEnabled: { ...map, [agentId]: enabled } });
}

export function normalizeShareConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = typeof raw.provider === 'string' ? raw.provider : '';
  if (!VALID_SHARE_PROVIDERS.has(provider)) return null;
  return {
    provider,
    remote: typeof raw.remote === 'string' ? raw.remote : '',
    mount_point: typeof raw.mount_point === 'string' ? raw.mount_point : '',
    path: typeof raw.path === 'string' ? raw.path : '',
    brain_root: typeof raw.brain_root === 'string' && raw.brain_root.trim()
      ? raw.brain_root.trim()
      : DEFAULT_SHARE_BRAIN_ROOT,
    bridge_enabled: raw.bridge_enabled === true,
  };
}

export async function getShareConfig() {
  const config = await readConfig();
  return normalizeShareConfig(config.share);
}

export async function setShareConfig(share) {
  const current = await readConfig();
  // `provider` is required when writing share config so invalid/partial payloads
  // fail fast instead of silently coercing to a default transport.
  const merged = normalizeShareConfig({
    ...(typeof current.share === 'object' && current.share !== null ? current.share : {}),
    ...share,
  });
  if (!merged) {
    throw new Error('invalid share config');
  }
  await writeConfig({ share: merged });
}
