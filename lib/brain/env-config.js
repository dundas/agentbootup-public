/**
 * Environment contract config loader/validator.
 * Supports:
 * - legacy env-config v0.1 on disk
 * - canonical env-config v1 on disk
 * Internally normalizes both to the v1 field shape.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { isObject, nonEmptyString } from './validate-utils.js';

const SUPPORTED_SCHEMA_MAJOR = 1;

const APPROVAL_MODES = new Set(['none', 'orchestrate', 'teleporter_hook']);
const V0_ENV_CONFIG_FIELDS = new Set([
  'schema_version', 'environment', 'brain_allowlist', 'environment_skills',
  'local_tools_path', 'secret_source', 'routing_target', 'approval_flow',
]);
const V1_ENV_CONFIG_FIELDS = new Set([
  'schema_version', 'environment', 'brains', 'environment_skills', 'hooks_dir',
  'mount_base', 'local_tools_path', 'secret_source', 'routing', 'approval_flow',
]);
const APPROVAL_FLOW_FIELDS = new Set(['mode', 'endpoint', 'parent_session_id_var']);
const LEGACY_APPROVAL_FLOW_FIELDS = new Set(['mechanism', 'endpoint', 'parent_session_id_var']);
const ENVIRONMENT_SKILLS_FIELDS = new Set(['path', 'optional']);
const SECRET_SOURCE_FIELDS = new Set(['provider', 'namespace']);
const ROUTING_FIELDS = new Set(['provider', 'endpoint', 'approval_mode']);

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `${label}.${key} is not allowed`;
  }
  return null;
}

function isApprovalEndpoint(value) {
  // WHATWG URL parsing strips ASCII tabs and newlines before resolving a URL.
  // Reject them before the root-relative fast path so `/\t/host` cannot become
  // a scheme-relative authority when a downstream consumer resolves it.
  if (/[\\\t\r\n]/.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  if (/^(GET|POST|PUT|PATCH|DELETE) \/(?!\/)[^\s]*$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hasMountBaseLeafIdToken(value) {
  if (!nonEmptyString(value)) return false;
  const normalized = value.trim().replace(/[\\/]+$/, '');
  const leaf = normalized.split(/[\\/]+/).pop() || '';
  return leaf.includes('<id>');
}

function parseSchemaVersion(raw) {
  if (!nonEmptyString(raw)) {
    return { ok: false, error: 'schema_version is required' };
  }
  const trimmed = raw.trim();
  if (!/^\d+\.\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: `schema_version must look like "0.1" or "1.0" (major.minor[.patch]), got "${raw}"` };
  }
  const major = parseInt(trimmed.split('.')[0] || '', 10);
  if (Number.isNaN(major) || major < 0 || major > SUPPORTED_SCHEMA_MAJOR) {
    return { ok: false, error: `unsupported schema_version "${raw}" (supported major: ${SUPPORTED_SCHEMA_MAJOR})` };
  }
  return { ok: true, version: trimmed, major };
}

/**
 * @param {string} absPath
 * @returns {string} hex sha256 of file contents
 */
export function hashFileSha256(absPath) {
  const buf = fs.readFileSync(absPath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * @param {string} configDir Absolute directory containing the env config file
 * @param {string} skillsPath Relative or absolute path from spec (must stay within `configDir` when resolved)
 * @returns {string} absolute resolved path
 */
export function resolveEnvironmentSkillsPath(configDir, skillsPath) {
  const base = path.resolve(configDir);
  const resolved = path.isAbsolute(skillsPath)
    ? path.normalize(skillsPath)
    : path.resolve(base, skillsPath);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`environment_skills.path must be within the env config directory (got ${skillsPath})`);
  }
  return resolved;
}

/**
 * @param {string} configDir Absolute directory containing the env config file
 * @param {string} hooksDir Relative path from spec (must stay within `configDir` when resolved)
 * @returns {string} absolute resolved path
 */
export function resolveHooksDirPath(configDir, hooksDir) {
  const base = path.resolve(configDir);
  const resolved = path.resolve(base, hooksDir);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`hooks_dir must be within the env config directory (got ${hooksDir})`);
  }
  return resolved;
}

/**
 * @param {string} absConfigPath — path to env config JSON (absolute or resolvable)
 * @returns {{ ok: true, config: object, configDir: string, configPath: string } | { ok: false, error: string }}
 */
export function loadEnvConfigFile(absConfigPath) {
  const configPath = path.resolve(absConfigPath);
  if (!fs.existsSync(configPath)) {
    return { ok: false, error: `env config not found: ${configPath}` };
  }
  const st = fs.statSync(configPath);
  if (!st.isFile()) {
    return { ok: false, error: `env config is not a file: ${configPath}` };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `invalid JSON in env config: ${msg}` };
  }
  const configDir = path.dirname(configPath);
  const normalized = normalizeEnvConfig(raw);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  try {
    const esp = /** @type {Record<string, unknown>} */ (normalized.config.environment_skills);
    resolveEnvironmentSkillsPath(configDir, String(esp.path));
    if (normalized.config.hooks_dir != null) {
      resolveHooksDirPath(configDir, String(normalized.config.hooks_dir));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
  return {
    ok: true,
    config: normalized.config,
    configDir,
    configPath,
    warnings: normalized.warnings,
    sourceVersion: normalized.sourceVersion,
  };
}

/**
 * @deprecated Use normalizeEnvConfig() when callers need canonical v1 output,
 * warnings, or source-version awareness. This wrapper only preserves the legacy
 * boolean/error validation contract.
 *
 * @param {unknown} raw
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateEnvConfigV01(raw) {
  const normalized = normalizeEnvConfig(raw);
  return normalized.ok ? { ok: true } : { ok: false, error: normalized.error };
}

/**
 * Normalize env config data to the v1 internal shape.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, config: object, warnings: string[], sourceVersion: string } | { ok: false, error: string }}
 */
export function normalizeEnvConfig(raw) {
  if (!isObject(raw)) {
    return { ok: false, error: 'env config must be a JSON object' };
  }
  const c = /** @type {Record<string, unknown>} */ (raw);

  const parsed = parseSchemaVersion(c.schema_version);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const { major, version } = parsed;
  const warnings = [];
  const routingField = major >= 1 ? 'routing' : 'routing_target';

  const topLevelUnknown = rejectUnknownFields(
    c,
    major >= 1 ? V1_ENV_CONFIG_FIELDS : V0_ENV_CONFIG_FIELDS,
    'env config'
  );
  if (topLevelUnknown) return { ok: false, error: topLevelUnknown };

  if (typeof c.environment !== 'string' || !c.environment.trim()) {
    return { ok: false, error: 'environment is required (non-empty string)' };
  }

  const brains = major >= 1 ? c.brains : c.brain_allowlist;
  const brainsFieldName = major >= 1 ? 'brains' : 'brain_allowlist';
  if (!Array.isArray(brains)) {
    return { ok: false, error: `${brainsFieldName} is required (array)` };
  }
  for (const id of brains) {
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, error: `${brainsFieldName} entries must be non-empty strings` };
    }
  }

  const es = c.environment_skills;
  if (!isObject(es)) {
    return { ok: false, error: 'environment_skills is required (object)' };
  }
  const esp = /** @type {Record<string, unknown>} */ (es);
  const envSkillsUnknown = rejectUnknownFields(esp, ENVIRONMENT_SKILLS_FIELDS, 'environment_skills');
  if (envSkillsUnknown) return { ok: false, error: envSkillsUnknown };
  if (typeof esp.path !== 'string' || !esp.path.trim()) {
    return { ok: false, error: 'environment_skills.path is required' };
  }
  if (esp.optional != null && typeof esp.optional !== 'boolean') {
    return { ok: false, error: 'environment_skills.optional must be boolean when set' };
  }

  if (c.hooks_dir != null) {
    if (typeof c.hooks_dir !== 'string' || !c.hooks_dir.trim()) {
      return { ok: false, error: 'hooks_dir must be a non-empty string when set' };
    }
  }

  if (c.mount_base != null) {
    if (typeof c.mount_base !== 'string' || !c.mount_base.trim()) {
      return { ok: false, error: 'mount_base must be a non-empty string when set' };
    }
    if (!hasMountBaseLeafIdToken(c.mount_base)) {
      return { ok: false, error: 'mount_base leaf path must include "<id>" when set' };
    }
  }

  const ss = c.secret_source;
  if (!ss || typeof ss !== 'object') {
    return { ok: false, error: 'secret_source is required' };
  }
  const ssp = /** @type {Record<string, unknown>} */ (ss);
  const secretSourceUnknown = rejectUnknownFields(ssp, SECRET_SOURCE_FIELDS, 'secret_source');
  if (secretSourceUnknown) return { ok: false, error: secretSourceUnknown };
  if (ssp.provider !== 'mech-vault') {
    return { ok: false, error: `secret_source.provider must be "mech-vault" (got ${String(ssp.provider)})` };
  }
  if (typeof ssp.namespace !== 'string' || !/^[a-zA-Z0-9-]+$/.test(ssp.namespace)) {
    return { ok: false, error: 'secret_source.namespace must match ^[a-zA-Z0-9-]+$' };
  }

  const rt = major >= 1 ? c.routing : c.routing_target;
  if (!rt || typeof rt !== 'object') {
    return { ok: false, error: `${routingField} is required` };
  }
  const rtp = /** @type {Record<string, unknown>} */ (rt);
  const routingUnknown = rejectUnknownFields(rtp, ROUTING_FIELDS, routingField);
  if (routingUnknown) return { ok: false, error: routingUnknown };
  if (rtp.provider !== 'mech-plane') {
    return { ok: false, error: `${routingField}.provider must be "mech-plane" (got ${String(rtp.provider)})` };
  }
  if (typeof rtp.endpoint !== 'string' || !rtp.endpoint.trim()) {
    return { ok: false, error: `${routingField}.endpoint is required` };
  }
  const am = rtp.approval_mode;
  if (am != null) {
    if (!['full-auto', 'confidence', 'manual'].includes(String(am))) {
      return { ok: false, error: `${routingField}.approval_mode invalid: ${String(am)}` };
    }
  }

  const af = c.approval_flow;
  let normalizedApprovalFlow = { mode: 'none' };
  if (major >= 1) {
    if (af == null) {
      normalizedApprovalFlow = { mode: 'none' };
    } else if (typeof af === 'string') {
      if (!APPROVAL_MODES.has(af)) {
        return { ok: false, error: `approval_flow must be one of ${[...APPROVAL_MODES].join(', ')} (got ${af})` };
      }
      normalizedApprovalFlow = { mode: af };
    } else if (isObject(af)) {
      const afp = /** @type {Record<string, unknown>} */ (af);
      const unknown = rejectUnknownFields(afp, APPROVAL_FLOW_FIELDS, 'approval_flow');
      if (unknown) return { ok: false, error: unknown };
      const mode = String(afp.mode);
      if (!APPROVAL_MODES.has(mode)) {
        return { ok: false, error: `approval_flow.mode must be one of ${[...APPROVAL_MODES].join(', ')} (got ${mode})` };
      }
      if (mode === 'none') {
        if (afp.endpoint != null) {
          return { ok: false, error: 'approval_flow.endpoint is only valid for mode "orchestrate"' };
        }
        if (afp.parent_session_id_var != null) {
          return { ok: false, error: 'approval_flow.parent_session_id_var is only valid for mode "teleporter_hook"' };
        }
      }
      if (mode === 'orchestrate' && afp.parent_session_id_var != null) {
        return { ok: false, error: 'approval_flow.parent_session_id_var is only valid for mode "teleporter_hook"' };
      }
      if (mode === 'teleporter_hook' && afp.endpoint != null) {
        return { ok: false, error: 'approval_flow.endpoint is only valid for mode "orchestrate"' };
      }
      if (afp.endpoint != null && !nonEmptyString(afp.endpoint)) {
        return { ok: false, error: 'approval_flow.endpoint must be a non-empty string when set' };
      }
      if (afp.endpoint != null && !isApprovalEndpoint(String(afp.endpoint))) {
        return { ok: false, error: 'approval_flow.endpoint must be an absolute http(s) URL, root-relative path, or METHOD /path when set' };
      }
      if (afp.parent_session_id_var != null && !nonEmptyString(afp.parent_session_id_var)) {
        return { ok: false, error: 'approval_flow.parent_session_id_var must be a non-empty string when set' };
      }
      normalizedApprovalFlow = {
        mode,
        ...(afp.endpoint != null ? { endpoint: String(afp.endpoint) } : {}),
        ...(afp.parent_session_id_var != null ? { parent_session_id_var: String(afp.parent_session_id_var) } : {}),
      };
    } else {
      return { ok: false, error: 'approval_flow must be a string or object when set' };
    }
  } else {
    if (!af || typeof af !== 'object') {
      return { ok: false, error: 'approval_flow is required' };
    }
    const afp = /** @type {Record<string, unknown>} */ (af);
    const unknown = rejectUnknownFields(afp, LEGACY_APPROVAL_FLOW_FIELDS, 'approval_flow');
    if (unknown) return { ok: false, error: unknown };
    const mech = afp.mechanism;
    if (mech !== 'mech-plane' && mech !== 'teleporter_hook') {
      return { ok: false, error: `approval_flow.mechanism must be "mech-plane" or "teleporter_hook" (got ${String(mech)})` };
    }
    if (mech === 'mech-plane') {
      if (typeof afp.endpoint !== 'string' || !afp.endpoint.trim()) {
        return { ok: false, error: 'approval_flow.endpoint is required for mech-plane mechanism' };
      }
      if (!isApprovalEndpoint(afp.endpoint)) {
        return { ok: false, error: 'approval_flow.endpoint must be an absolute http(s) URL, root-relative path, or METHOD /path for mech-plane mechanism' };
      }
      if (afp.parent_session_id_var != null) {
        return { ok: false, error: 'approval_flow.parent_session_id_var is only valid for teleporter_hook mechanism' };
      }
      normalizedApprovalFlow = { mode: 'orchestrate', endpoint: afp.endpoint };
    } else {
      if (afp.endpoint != null) {
        return { ok: false, error: 'approval_flow.endpoint is only valid for mech-plane mechanism' };
      }
      const vname = afp.parent_session_id_var;
      if (typeof vname !== 'string' || !vname.trim()) {
        return { ok: false, error: 'approval_flow.parent_session_id_var must be a string' };
      }
      normalizedApprovalFlow = {
        mode: 'teleporter_hook',
        parent_session_id_var: String(vname),
      };
    }
    warnings.push(`env-config ${version} is deprecated; load it via compatibility mapping to v1`);
  }

  return {
    ok: true,
    sourceVersion: version,
    warnings,
    config: {
      schema_version: major >= 1 ? version : '1.0',
      environment: c.environment.trim(),
      brains: brains.map((id) => String(id).trim()),
      environment_skills: {
        path: String(esp.path),
        optional: esp.optional === true,
      },
      ...(c.hooks_dir != null ? { hooks_dir: String(c.hooks_dir) } : {}),
      ...(c.mount_base != null ? { mount_base: String(c.mount_base) } : {}),
      ...(c.local_tools_path != null ? { local_tools_path: String(c.local_tools_path) } : {}),
      secret_source: {
        provider: 'mech-vault',
        namespace: String(ssp.namespace),
      },
      routing: {
        provider: 'mech-plane',
        endpoint: String(rtp.endpoint),
        ...(am != null ? { approval_mode: String(am) } : {}),
      },
      approval_flow: normalizedApprovalFlow,
    },
  };
}

/**
 * @param {object} project — network project entry
 * @param {string[]} allowlist
 * @returns {boolean}
 */
export function isProjectAllowedForEnv(project, allowlist) {
  if (!project || typeof project !== 'object') return false;
  const set = new Set((allowlist || []).map((s) => String(s).trim()));
  if (project.id && set.has(String(project.id).trim())) return true;
  if (project.agent_id && set.has(String(project.agent_id).trim())) return true;
  return false;
}
