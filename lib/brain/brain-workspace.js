import { isObject, nonEmptyString } from './validate-utils.js';
import { WORKSPACE_VOLUME_STRATEGIES } from './brain-workspace-constants.js';

const VOLUME_STRATEGIES = new Set(WORKSPACE_VOLUME_STRATEGIES);
const PINNED_SHA_RE = /^[0-9a-f]{40}$/i;
const WORKSPACE_KEYS = new Set([
  'schema_version',
  'repo',
  'ref',
  'depth',
  'auth',
  'volume_strategy',
  'mount_path',
  'worktree_include',
  'env_allowlist',
  'output_paths',
  'post_clone',
]);
const AUTH_KEYS = new Set(['type', 'vault_secret']);

function rejectUnknownKeys(value, allowedKeys, field, errors) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${field}${key} is not allowed`);
    }
  }
}

function validateStringArray(value, field, errors) {
  if (value == null) return;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  for (const item of value) {
    if (!nonEmptyString(item)) {
      errors.push(`${field} entries must be non-empty strings`);
      break;
    }
  }
}

/**
 * Validate brain-workspace.json v1.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateBrainWorkspaceV1(raw) {
  const errors = [];
  if (!isObject(raw)) return { ok: false, errors: ['brain workspace must be a JSON object'] };
  const workspace = raw;
  rejectUnknownKeys(workspace, WORKSPACE_KEYS, '', errors);

  if (!nonEmptyString(workspace.schema_version) || !/^1\.\d+(\.\d+)?$/.test(workspace.schema_version)) {
    errors.push('schema_version must be a v1 version string');
  }
  if (!nonEmptyString(workspace.repo)) {
    errors.push('repo is required');
  }
  if (!nonEmptyString(workspace.ref) || !PINNED_SHA_RE.test(workspace.ref)) {
    errors.push('ref is required and must be a pinned full git SHA');
  }
  if (workspace.depth != null && (!Number.isInteger(workspace.depth) || workspace.depth < 1)) {
    errors.push('depth must be an integer >= 1');
  }
  if (!VOLUME_STRATEGIES.has(workspace.volume_strategy)) {
    errors.push(`volume_strategy must be one of: ${[...VOLUME_STRATEGIES].join(', ')}`);
  }
  if (!nonEmptyString(workspace.mount_path)) {
    errors.push('mount_path is required');
  }

  if (workspace.auth != null) {
    if (!isObject(workspace.auth)) {
      errors.push('auth must be an object');
    } else {
      rejectUnknownKeys(workspace.auth, AUTH_KEYS, 'auth.', errors);
      if (!nonEmptyString(workspace.auth.type)) {
        errors.push('auth.type is required when auth is set');
      }
      if (!nonEmptyString(workspace.auth.vault_secret)) {
        errors.push('auth.vault_secret is required when auth is set');
      }
    }
  }

  validateStringArray(workspace.worktree_include, 'worktree_include', errors);
  validateStringArray(workspace.env_allowlist, 'env_allowlist', errors);
  validateStringArray(workspace.output_paths, 'output_paths', errors);
  validateStringArray(workspace.post_clone, 'post_clone', errors);

  return errors.length === 0 ? { ok: true, value: workspace } : { ok: false, errors };
}
