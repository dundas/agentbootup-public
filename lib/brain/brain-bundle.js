import { isObject, nonEmptyString } from './validate-utils.js';

const CREDENTIAL_REFERENCE_FIELDS = new Set(['provider', 'namespace', 'name', 'key', 'key_id', 'env']);

const RAW_SECRET_KEYS = new Set([
  'secret',
  'secret_key',
  'token',
  'api_key',
  'apikey',
  'private_key',
  'privatekey',
  'password',
]);

const FORBIDDEN_ENV_KEYS = new Set([
  'workspace',
  'projects',
  'routing',
  'routing_target',
  'approval_flow',
  'environment',
  'mount_target',
  'location',
]);

function hasRawSecretKey(value, pathParts = []) {
  if (Array.isArray(value)) {
    return value.some((item, index) => hasRawSecretKey(item, [...pathParts, String(index)]));
  }
  if (!isObject(value)) return false;

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll('-', '_').toLowerCase();
    if (RAW_SECRET_KEYS.has(normalized)) return true;
    if (hasRawSecretKey(child, [...pathParts, key])) return true;
  }
  return false;
}

function validateCredentialReferences(value, errors) {
  if (value == null) return;
  if (!Array.isArray(value)) {
    errors.push('credential_references must be an array when set');
    return;
  }
  for (const [index, ref] of value.entries()) {
    if (!isObject(ref)) {
      errors.push(`credential_references[${index}] must be an object`);
      continue;
    }
    const keys = Object.keys(ref);
    const unknownKeys = keys.filter((key) => !CREDENTIAL_REFERENCE_FIELDS.has(key));
    if (unknownKeys.length > 0) {
      errors.push(`credential_references[${index}] contains unsupported fields: ${unknownKeys.join(', ')}`);
    }
    if (!keys.some((key) => CREDENTIAL_REFERENCE_FIELDS.has(key))) {
      errors.push(`credential_references[${index}] must include at least one reference field`);
    }
    if (hasRawSecretKey(ref)) {
      errors.push(`credential_references[${index}] must not contain raw secret fields`);
    }
  }
}

/**
 * Validate a brain-bundle.json v1 object without external schema dependencies.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateBrainBundleV1(raw) {
  const errors = [];
  if (!isObject(raw)) {
    return { ok: false, errors: ['brain bundle must be a JSON object'] };
  }
  const bundle = raw;

  if (bundle.manifest_version !== 1) {
    errors.push('manifest_version must be 1');
  }
  if (!nonEmptyString(bundle.brainId)) {
    errors.push('brainId is required');
  }

  if (bundle.identity != null) {
    if (!isObject(bundle.identity)) {
      errors.push('identity must be an object');
    } else if (!nonEmptyString(bundle.identity.projectId) && !nonEmptyString(bundle.identity.agentId)) {
      errors.push('identity must include projectId or agentId when set');
    }
  }

  for (const key of FORBIDDEN_ENV_KEYS) {
    if (key in bundle) {
      errors.push(`${key} does not belong in L1 brain-bundle.json`);
    }
  }

  validateCredentialReferences(bundle.credential_references, errors);

  if (hasRawSecretKey({ ...bundle, credential_references: undefined })) {
    errors.push('brain bundle must not contain raw secret fields; use credential_references');
  }

  return errors.length === 0 ? { ok: true, value: bundle } : { ok: false, errors };
}

/**
 * Create an additive L1 draft from an existing agentbootup.json v2-style config.
 *
 * @param {object} config
 * @param {{ brainId?: string, environmentId?: string }} [options]
 * @returns {object}
 */
export function migrateNetworkConfigToBrainBundleV1(config, options = {}) {
  if (!isObject(config)) {
    throw new Error('config must be an object');
  }
  const brainId = options.brainId || config.agent_id || config.id || (config.role === 'network' ? 'network' : '');
  if (!brainId) {
    throw new Error('brainId is required when config has no agent_id or id');
  }

  const identity = {
    ...(nonEmptyString(config.id) ? { projectId: String(config.id) } : {}),
    ...(nonEmptyString(config.agent_id) ? { agentId: String(config.agent_id) } : {}),
  };

  return {
    manifest_version: 1,
    brainId,
    source: {
      format: 'agentbootup.json',
      ...(config.version != null ? { version: String(config.version) } : {}),
    },
    ...(Object.keys(identity).length > 0 ? { identity } : {}),
  };
}
