/**
 * Environment-scoped toolset capability contract for boot bundles.
 *
 * The toolset policy is keyed by ENVIRONMENT (the host the agent runs on —
 * e.g. `circle_computer`, `mac-mini`, `macbook-pro-5`), because what an agent is
 * allowed to do depends on where it runs: a phone shell has a different safe
 * surface than a full dev machine. Each environment declares an allowlist and/or
 * an explicit disabled list (Blank-Slate-style capability contract).
 *
 * NOTE on layering: pi-package pinning (which pi packages tune the pi harness for
 * a given model, incl. the mandatory @mech/pi-gate) is NOT here — that is a
 * mech-plane concern (it selects harness × model and resolves the model's
 * extensions at route time). The bundle carries only the agent-level toolset
 * policy per environment.
 */

export interface EnvToolsetPolicy {
  allowlist?: string[];
  disabled_toolsets?: string[];
}

/** Map of environment id → policy. e.g. { "circle_computer": {...}, "mac-mini": {...} } */
export type ToolsetConfig = Record<string, EnvToolsetPolicy>;

export class ToolsetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolsetValidationError';
  }
}

// Environment ids are DNS-label-ish: lowercase alphanumerics, dot, underscore, hyphen.
const ENV_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function validateStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new ToolsetValidationError(`${label} must be a string array`);
  }
  return value as string[];
}

function validateEnvPolicy(raw: unknown, envId: string): EnvToolsetPolicy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolsetValidationError(`toolsets['${envId}'] must be a plain object`);
  }
  const p = raw as Record<string, unknown>;
  const allowedKeys = ['allowlist', 'disabled_toolsets'];
  const extra = Object.keys(p).filter((k) => !allowedKeys.includes(k));
  if (extra.length) {
    throw new ToolsetValidationError(
      `toolsets['${envId}']: unexpected propert${extra.length > 1 ? 'ies' : 'y'} ${extra.join(', ')} (additionalProperties:false)`,
    );
  }
  const result: EnvToolsetPolicy = {};
  if (p.allowlist !== undefined) result.allowlist = validateStringArray(p.allowlist, `toolsets['${envId}'].allowlist`);
  if (p.disabled_toolsets !== undefined) {
    result.disabled_toolsets = validateStringArray(p.disabled_toolsets, `toolsets['${envId}'].disabled_toolsets`);
  }
  return result;
}

/**
 * Validate the environment-keyed toolset config. Returns undefined when absent
 * (toolsets are optional — an agent with no per-environment policy is allowed).
 */
export function validateToolsetConfig(raw: unknown): ToolsetConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolsetValidationError('toolsets must be a plain object keyed by environment id');
  }
  const t = raw as Record<string, unknown>;
  const result: ToolsetConfig = {};
  for (const [envId, policy] of Object.entries(t)) {
    if (!ENV_ID_RE.test(envId)) {
      throw new ToolsetValidationError(
        `toolsets: invalid environment id '${envId}' (must match ${ENV_ID_RE})`,
      );
    }
    result[envId] = validateEnvPolicy(policy, envId);
  }
  return result;
}
