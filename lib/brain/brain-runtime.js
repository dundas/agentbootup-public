import { isObject, nonEmptyString } from './validate-utils.js';
import { NON_LOCAL_AGENT_LOCATION_TYPES, WORKSPACE_VOLUME_STRATEGIES } from './brain-workspace-constants.js';

const LOCATION_TYPES = new Set(['local', 'http', 'fly', 'admp', 'agent-host']);
const NON_LOCAL_LOCATION_TYPES = new Set(NON_LOCAL_AGENT_LOCATION_TYPES);
const VOLUME_STRATEGIES = new Set(WORKSPACE_VOLUME_STRATEGIES);
const VAULT_PATH_REF_RE = /^[^\s/]+(?:\/[^\s/]+)+$/;
const AGENT_HOST_KEYS = new Set(['internal_auth_token_ref']);
const ENV_VAR_REF_KEYS = new Set(['vault_ref']);
const ENV_ALLOWLIST_KEYS = new Set([
  'description',
  'env_var',
  'redemption_recipient_brain_id',
  'required',
  'source',
  'ttl',
  'value',
  'vault_path',
  'vault_secret_id',
]);
const ENV_ALLOWLIST_SOURCES = new Set(['vault_redemption', 'literal']);
const MODEL_ROUTING_DEFAULT_KEYS = new Set(['provider', 'task_model', 'chat_model']);
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
export const SECRET_ENV_VAR_RE =
  /(^|_)(KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWORDS|CREDENTIAL|CREDENTIALS|PRIVATE|AUTH|JWT|SESSION|COOKIE|SIGNING|SALT|HASH|PEM|DSN|BEARER|PASSPHRASE|CERT|CERTIFICATE|APIKEY|ACCESSKEY|SECRETKEY|SSHKEY|CONNECTION_STRING)(_|$)|^(DATABASE|REDIS|MONGO|MONGODB|POSTGRES|POSTGRESQL|MYSQL|AMQP|KAFKA)_(URL|URI)$/;
// Simple unit only; compound durations like 1h30m are intentionally not part of this contract.
const DURATION_RE = /^(?!0+(?:ms|s|m|h|d)$)\d+(ms|s|m|h|d)$/;

function validateLocation(location, prefix, errors) {
  if (location == null) return;
  if (!isObject(location)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!LOCATION_TYPES.has(location.type)) {
    errors.push(`${prefix}.type must be one of: ${[...LOCATION_TYPES].join(', ')}`);
  }
  if (location.type === 'local' && location.cwd != null && !nonEmptyString(location.cwd)) {
    errors.push(`${prefix}.cwd must be a non-empty string when set`);
  }
  if (location.type === 'http' && (!Number.isInteger(location.port) || location.port < 1 || location.port > 65535)) {
    errors.push(`${prefix}.port is required for http and must be 1-65535`);
  }
  if (location.type === 'agent-host' && !nonEmptyString(location.baseUrl)) {
    errors.push(`${prefix}.baseUrl is required for agent-host`);
  }
  if (NON_LOCAL_LOCATION_TYPES.has(location.type) && !nonEmptyString(location.agentId)) {
    errors.push(`${prefix}.agentId is required when type is not local`);
  }
}

function validateStateTree(stateTree, errors) {
  if (stateTree == null) return;
  if (!isObject(stateTree)) {
    errors.push('state_tree must be an object');
    return;
  }
  if (stateTree.volume_strategy != null && !VOLUME_STRATEGIES.has(stateTree.volume_strategy)) {
    errors.push(`state_tree.volume_strategy must be one of: ${[...VOLUME_STRATEGIES].join(', ')}`);
  }
}

function validateAgentHost(agentHost, errors) {
  if (agentHost == null) return;
  if (!isObject(agentHost)) {
    errors.push('agent_host must be an object');
    return;
  }
  for (const key of Object.keys(agentHost)) {
    if (!AGENT_HOST_KEYS.has(key)) {
      errors.push(`agent_host.${key} is not allowed`);
    }
  }
  if (!nonEmptyString(agentHost.internal_auth_token_ref)) {
    errors.push('agent_host.internal_auth_token_ref must be a non-empty vault path reference');
  } else if (!VAULT_PATH_REF_RE.test(agentHost.internal_auth_token_ref)) {
    errors.push('agent_host.internal_auth_token_ref must be a vault path reference like agent-host/staging/KEY');
  }
}

function validateEnvVarRefs(envVarRefs, errors) {
  if (envVarRefs == null) return;
  if (!isObject(envVarRefs)) {
    errors.push('env_var_refs must be an object');
    return;
  }
  for (const [envName, ref] of Object.entries(envVarRefs)) {
    if (!nonEmptyString(envName)) {
      errors.push('env_var_refs keys must be non-empty env var names');
      continue;
    }
    if (!isObject(ref)) {
      errors.push(`env_var_refs.${envName} must be an object with vault_ref`);
      continue;
    }
    for (const key of Object.keys(ref)) {
      if (!ENV_VAR_REF_KEYS.has(key)) {
        errors.push(`env_var_refs.${envName}.${key} is not allowed`);
      }
    }
    if (!nonEmptyString(ref.vault_ref)) {
      errors.push(`env_var_refs.${envName}.vault_ref must be a non-empty vault path reference`);
    } else if (!VAULT_PATH_REF_RE.test(ref.vault_ref)) {
      errors.push(`env_var_refs.${envName}.vault_ref must be a vault path reference like mech/staging/KEY`);
    }
  }
}

function validateEnvAllowlist(envAllowlist, errors) {
  if (envAllowlist == null) return;
  if (!Array.isArray(envAllowlist)) {
    errors.push('env_allowlist must be an array');
    return;
  }
  const seenEnvVars = new Set();
  for (const [index, entry] of envAllowlist.entries()) {
    const prefix = `env_allowlist[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!ENV_ALLOWLIST_KEYS.has(key)) {
        errors.push(`${prefix}.${key} is not allowed`);
      }
    }
    if (!nonEmptyString(entry.env_var) || !ENV_VAR_NAME_RE.test(entry.env_var)) {
      errors.push(`${prefix}.env_var must be an uppercase environment variable name`);
    } else if (seenEnvVars.has(entry.env_var)) {
      errors.push(`${prefix}.env_var duplicates another env_allowlist entry`);
    } else {
      seenEnvVars.add(entry.env_var);
    }
    if (!ENV_ALLOWLIST_SOURCES.has(entry.source)) {
      errors.push(`${prefix}.source must be one of: ${[...ENV_ALLOWLIST_SOURCES].join(', ')}`);
    }
    if (entry.required == null) {
      errors.push(`${prefix}.required is required`);
    } else if (typeof entry.required !== 'boolean') {
      errors.push(`${prefix}.required must be a boolean`);
    }
    if (entry.description != null && !nonEmptyString(entry.description)) {
      errors.push(`${prefix}.description must be a non-empty string when set`);
    }
    if (entry.ttl != null && (!nonEmptyString(entry.ttl) || !DURATION_RE.test(entry.ttl))) {
      errors.push(`${prefix}.ttl must be a duration string like 1h, 30m, or 10s when set`);
    }
    if (entry.vault_secret_id != null && !nonEmptyString(entry.vault_secret_id)) {
      errors.push(`${prefix}.vault_secret_id must be a non-empty string when set`);
    }

    if (entry.source === 'vault_redemption') {
      if (!nonEmptyString(entry.vault_path)) {
        errors.push(`${prefix}.vault_path must be a non-empty vault path reference`);
      } else if (!VAULT_PATH_REF_RE.test(entry.vault_path)) {
        errors.push(`${prefix}.vault_path must be a vault path reference like agent-host/staging/KEY`);
      }
      if (!nonEmptyString(entry.redemption_recipient_brain_id)) {
        errors.push(`${prefix}.redemption_recipient_brain_id must be a non-empty brain id`);
      }
      if (entry.value != null) {
        errors.push(`${prefix}.value is not allowed for vault_redemption entries`);
      }
    } else if (entry.source === 'literal') {
      if (!nonEmptyString(entry.value)) {
        errors.push(`${prefix}.value must be a non-empty string for literal entries`);
      }
      if (nonEmptyString(entry.env_var) && SECRET_ENV_VAR_RE.test(entry.env_var)) {
        errors.push(`${prefix}.source literal is not allowed for secret-like env vars`);
      }
      if (entry.vault_path != null) {
        errors.push(`${prefix}.vault_path is not allowed for literal entries`);
      }
      if (entry.vault_secret_id != null) {
        errors.push(`${prefix}.vault_secret_id is not allowed for literal entries`);
      }
      if (entry.redemption_recipient_brain_id != null) {
        errors.push(`${prefix}.redemption_recipient_brain_id is not allowed for literal entries`);
      }
      if (entry.ttl != null) {
        errors.push(`${prefix}.ttl is not allowed for literal entries`);
      }
    }
  }
}

function validateEnvReferenceConsistency(runtime, errors) {
  const allowlistEntries = Array.isArray(runtime.env_allowlist)
    ? runtime.env_allowlist.filter((entry) => isObject(entry) && nonEmptyString(entry.env_var))
    : [];

  const sharedKeyEntry = allowlistEntries.find((entry) => entry.env_var === 'AGENT_HOST_SHARED_KEY');
  if (sharedKeyEntry && !nonEmptyString(runtime.agent_host?.internal_auth_token_ref)) {
    errors.push('agent_host.internal_auth_token_ref is required when env_allowlist includes AGENT_HOST_SHARED_KEY');
  }
  if (nonEmptyString(runtime.agent_host?.internal_auth_token_ref)) {
    if (!sharedKeyEntry) {
      errors.push('env_allowlist must include AGENT_HOST_SHARED_KEY when agent_host.internal_auth_token_ref is set');
    } else if (sharedKeyEntry.source !== 'vault_redemption') {
      errors.push('env_allowlist AGENT_HOST_SHARED_KEY must use vault_redemption');
    } else if (sharedKeyEntry.vault_path !== runtime.agent_host.internal_auth_token_ref) {
      errors.push('env_allowlist AGENT_HOST_SHARED_KEY vault_path must match agent_host.internal_auth_token_ref');
    }
  }
}

function validateModelRoutingDefaults(modelRoutingDefaults, errors) {
  if (modelRoutingDefaults == null) return;
  if (!isObject(modelRoutingDefaults)) {
    errors.push('model_routing_defaults must be an object');
    return;
  }
  for (const key of Object.keys(modelRoutingDefaults)) {
    if (!MODEL_ROUTING_DEFAULT_KEYS.has(key)) {
      errors.push(`model_routing_defaults.${key} is not allowed`);
    }
  }
  for (const key of MODEL_ROUTING_DEFAULT_KEYS) {
    if (modelRoutingDefaults[key] != null && !nonEmptyString(modelRoutingDefaults[key])) {
      errors.push(`model_routing_defaults.${key} must be a non-empty string`);
    }
  }
}

/**
 * Validate brain-runtime.json v1.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateBrainRuntimeV1(raw) {
  const errors = [];
  if (!isObject(raw)) return { ok: false, errors: ['brain runtime must be a JSON object'] };
  const runtime = raw;

  if (!nonEmptyString(runtime.schema_version) || !/^1\.\d+(\.\d+)?$/.test(runtime.schema_version)) {
    errors.push('schema_version must be a v1 version string');
  }

  if (!Number.isInteger(runtime.max_execution_ms) || runtime.max_execution_ms < 1000) {
    errors.push('max_execution_ms must be an integer >= 1000');
  }

  if (!isObject(runtime.runtime)) {
    errors.push('runtime is required');
  } else if (!isObject(runtime.runtime.required) || Object.keys(runtime.runtime.required).length === 0) {
    errors.push('runtime.required is required and must be a non-empty object');
  } else {
    for (const [name, range] of Object.entries(runtime.runtime.required)) {
      if (!nonEmptyString(name) || !nonEmptyString(range)) {
        errors.push('runtime.required entries must be non-empty runtime name/range strings');
      }
    }
  }

  if (runtime.wake_policy != null) {
    if (!isObject(runtime.wake_policy)) {
      errors.push('wake_policy must be an object');
    } else if ('delivery' in runtime.wake_policy || 'push' in runtime.wake_policy || 'poll' in runtime.wake_policy) {
      errors.push('wake trigger delivery semantics are deferred to Phase B');
    }
  }

  validateLocation(runtime.mount_target, 'mount_target', errors);
  validateStateTree(runtime.state_tree, errors);
  validateAgentHost(runtime.agent_host, errors);
  validateEnvAllowlist(runtime.env_allowlist, errors);
  validateEnvVarRefs(runtime.env_var_refs, errors);
  validateEnvReferenceConsistency(runtime, errors);
  validateModelRoutingDefaults(runtime.model_routing_defaults, errors);

  return errors.length === 0 ? { ok: true, value: runtime } : { ok: false, errors };
}
