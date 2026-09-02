/**
 * Shared client/server contract for brain assets.
 *
 * Keep transport enums and the security-sensitive secret policy here so a CLI
 * release cannot advertise a type that the server validator does not accept.
 */

/** @type {readonly ['skill', 'agent', 'command', 'memory', 'protocol', 'config', 'script', 'runtime', 'secret']} */
export const ASSET_TYPES = Object.freeze([
  'skill',
  'agent',
  'command',
  'memory',
  'protocol',
  'config',
  'script',
  'runtime',
  'secret',
]);

/** @type {readonly ['claude', 'gemini', 'codex', 'cursor', 'shared']} */
export const ASSET_CLIS = Object.freeze([
  'claude',
  'gemini',
  'codex',
  'cursor',
  'shared',
]);

export const ASSET_CONTRACT_VERSION = 1;
export const SECRET_ASSET_TYPE = 'secret';
export const MAX_SECRET_BYTES = 1_048_576;
export const SECRET_TTL_MIN_SECONDS = 60;
export const SECRET_TTL_MAX_SECONDS = 2_592_000;

/** @type {readonly ['.env', '.dev.vars', 'brain/config.secret.json']} */
export const SECRET_REL_PATHS = Object.freeze([
  '.env',
  '.dev.vars',
  'brain/config.secret.json',
]);

/**
 * Host/device credentials are never portable brain assets. Keep this separate
 * from SECRET_REL_PATHS: secret sync has an explicit, audited workflow, while
 * host credentials have no sync, export, or restore workflow at all.
 */
export const HOST_LOCAL_CREDENTIAL_PREFIXES = Object.freeze([
  '.agenthost/',
  '.agent-host/',
  'brain/.agenthost/',
  'brain/.agent-host/',
]);

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Canonical policy advertised by the server and required by the client before
 * any secret payload is transferred. Keep this content-only: route-specific
 * URLs are transport metadata and do not belong in the shared policy.
 */
export const SECRET_CAPABILITY_POLICY = deepFreeze({
  supported: true,
  asset_type: SECRET_ASSET_TYPE,
  manual_only: true,
  exact_bytes: true,
  paths: SECRET_REL_PATHS,
  max_file_bytes: MAX_SECRET_BYTES,
  retention: {
    without_ttl: 'until_overwritten',
    expired_assets_restorable: false,
  },
  ttl: {
    supported: true,
    optional: true,
    min_seconds: SECRET_TTL_MIN_SECONDS,
    max_seconds: SECRET_TTL_MAX_SECONDS,
  },
  authorization: {
    principal: 'admin',
    bearer_required: true,
  },
  logging: {
    payload_logged: false,
    metadata_only: true,
  },
  restore: {
    explicit_pull_only: true,
    method: 'GET',
  },
  cleanup: {
    supported: true,
    method: 'DELETE',
    exact_brain_id_confirmation_required: true,
  },
});

const ASSET_TYPE_SET = new Set(ASSET_TYPES);
const ASSET_CLI_SET = new Set(ASSET_CLIS);
const SECRET_PATH_SET = new Set(SECRET_REL_PATHS);

/** @param {unknown} value */
export function isAssetType(value) {
  return typeof value === 'string' && ASSET_TYPE_SET.has(value);
}

/** @param {unknown} value */
export function isAssetCli(value) {
  return typeof value === 'string' && ASSET_CLI_SET.has(value);
}

/** @param {unknown} value */
export function isSecretAssetPath(value) {
  return typeof value === 'string' && SECRET_PATH_SET.has(value.replace(/\\/g, '/'));
}

/** @param {unknown} value */
export function isHostLocalCredentialPath(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (HOST_LOCAL_CREDENTIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  const basename = normalized.split('/').at(-1) ?? '';
  return /^agenthost[-_.](host|device|transport)[-_.].*(key|credential|secret|token)/i.test(basename);
}

/**
 * Buffer.from(value, 'base64') accepts malformed input. Brain assets require
 * canonical padded base64 so validation has identical behavior on both sides.
 *
 * @param {unknown} value
 */
export function isCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

/** @param {unknown} value */
export function isCanonicalUtcIsoTimestamp(value) {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
