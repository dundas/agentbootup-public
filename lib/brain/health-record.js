/**
 * Agent Fleet Doctor — per-agent health record + status reducer (PRD-0038 §4, §5).
 *
 * Shared data contract defined BEFORE the four checks exist (Task 1), so every check
 * emits one normalized shape and one reducer decides Healthy/Degraded/Stuck. This is
 * the highest-leverage anti-rework step from the PRD-0038 pairing session.
 *
 * Per-check shape (reuses the doctor's `{severity, category, message}`):
 *   { state: 'pass'|'fail'|'unknown', severity?, category?, message?, required? }
 * Only `state` and `required` drive the reducer; `severity`/`category`/`message` are
 * pass-through metadata validated by the emitting check, not by this module.
 *
 * Record shape (§4):
 *   { agent_id, machine_id, environment, ts, status, checks, reason }
 */

/** The four checks (PRD-0038 §1). */
export const CHECK_NAMES = Object.freeze([
  'runtime_resolves',
  'identity_materializes',
  'credentials_authenticate',
  'messaging_round_trips',
]);

const CORE_CHECK_SET = new Set(CHECK_NAMES);

export const CHECK_STATES = Object.freeze(['pass', 'fail', 'unknown']);
export const HEALTH_STATUSES = Object.freeze(['healthy', 'degraded', 'stuck']);

// Status precedence — the reducer takes the worst (highest) contribution.
const PRECEDENCE = Object.freeze({ healthy: 0, degraded: 1, stuck: 2 });

/**
 * The status a check's REQUIRED failure implies (PRD-0038 §5 reducer rules):
 *  - credentials/identity fail → stuck (the dead-key class; auth/identity is load-bearing)
 *  - runtime_resolves fail → stuck (no usable runtime: the agent cannot operate)
 *  - messaging_round_trips fail → degraded (runtime up but chat dead — AC-4: not Healthy,
 *    but not Stuck either)
 */
const CHECK_FAIL_STATUS = Object.freeze({
  credentials_authenticate: 'stuck',
  identity_materializes: 'stuck',
  runtime_resolves: 'stuck',
  messaging_round_trips: 'degraded',
});

/**
 * The status a single check contributes to the overall record.
 * Rules (PRD-0038 §5):
 *  - pass → healthy
 *  - unknown → degraded if required (unknown must NEVER yield healthy), else healthy
 *  - fail → the check's fail-status if required; optional failures cap at degraded
 * @param {string} name
 * @param {{state?: string, required?: boolean}} check
 * @returns {'healthy'|'degraded'|'stuck'}
 */
export function checkContribution(name, check) {
  // The four core checks are ALWAYS required — `required: false` is ignored for them so
  // the keystone (a revoked credential / failed identity) can never be downgraded from
  // Stuck to Degraded by a per-check flag. The optional dimension (open Q3) applies only
  // to EXTRA integration checks a caller adds, never to the core four.
  const isCore = CORE_CHECK_SET.has(name);
  const required = isCore || check?.required !== false;
  const state = check?.state ?? 'unknown';

  if (state === 'pass') return 'healthy';
  if (state === 'unknown') return required ? 'degraded' : 'healthy';
  // state === 'fail' (or any non-pass/unknown value, treated as fail — never implicit pass)
  if (!required) return 'degraded';
  return CHECK_FAIL_STATUS[name] ?? 'degraded';
}

/**
 * Reduce per-check results to an overall status + reason (PRD-0038 §5, fail-closed).
 *
 * - A stale report is Stuck regardless of check states (report staleness = first-class Stuck).
 * - Any REQUIRED check missing from `checks` is treated as `unknown`, never implicit pass.
 * - Worst contribution wins (stuck > degraded > healthy).
 *
 * @param {Record<string, {state?: string, required?: boolean, message?: string}>} checks
 * @param {{ stale?: boolean, requiredChecks?: string[] }} [opts]
 * @returns {{ status: 'healthy'|'degraded'|'stuck', reason: string|null, checks: object }}
 */
export function reduceHealthStatus(checks = {}, opts = {}) {
  // The core four are ALWAYS in the required set — a custom requiredChecks can ADD to it
  // but can never drop a core check (which would silently omit a load-bearing check from
  // the record). Union, don't replace.
  const requiredChecks = [...new Set([...CHECK_NAMES, ...(opts.requiredChecks ?? [])])];

  // Every emitted check has a `state` (default unknown) for shape consistency — a
  // malformed `{}` becomes `{state:'unknown'}`, never an implicit pass.
  const ensureState = (check) =>
    check && typeof check === 'object' ? { ...check, state: check.state ?? 'unknown' } : { state: 'unknown' };

  // Normalize: any required check not present becomes an explicit unknown (no silent pass).
  // Intentional per §5 (pairing-settled): a MISSING core check is `unknown` → degraded,
  // NOT stuck. "Didn't run" is not "proven dead"; escalating missing→stuck would flood
  // false-Stuck on infra blips (the cry-wolf failure mode). The reason still names the
  // absent check, so a never-run credential probe surfaces clearly without over-signaling.
  const normalized = {};
  for (const name of requiredChecks) {
    normalized[name] = name in checks ? ensureState(checks[name]) : { state: 'unknown', message: 'check did not run', required: true };
  }
  // Include any extra (e.g. optional) checks the caller supplied, normalized the same way.
  // Extras default to REQUIRED (fail-closed) unless they set `required:false` — an
  // unflagged extra failure contributes degraded, never silently ignored.
  for (const [name, check] of Object.entries(checks)) {
    if (!(name in normalized)) normalized[name] = ensureState(check);
  }

  if (opts.stale) {
    return { status: 'stuck', reason: 'report is stale', checks: normalized };
  }

  // Worst contribution wins; reason names the first check that pushed status to that
  // level (so it is always set whenever status rises above healthy). Reason determinism
  // relies on insertion order — fine here since all check names are non-integer strings
  // (core four first, then extras), which V8 preserves.
  let status = 'healthy';
  let reason = null;
  for (const [name, check] of Object.entries(normalized)) {
    const contribution = checkContribution(name, check);
    if (PRECEDENCE[contribution] > PRECEDENCE[status]) {
      status = contribution;
      reason = reasonFor(name, check);
    }
  }
  return { status, reason, checks: normalized };
}

function reasonFor(name, check) {
  const state = check?.state ?? 'unknown';
  const detail = check?.message ? `: ${check.message}` : '';
  return `${name} ${state}${detail}`;
}

/**
 * Assemble a normalized per-agent health record (PRD-0038 §4).
 * @param {object} input
 * @param {string} input.agent_id
 * @param {string} input.machine_id
 * @param {string} [input.environment]
 * @param {string} input.ts                 ISO timestamp (caller-supplied; not generated here)
 * @param {Record<string, object>} input.checks
 * @param {boolean} [input.stale]
 * @param {string[]} [input.requiredChecks]
 * @returns {{ agent_id, machine_id, environment, ts, status, checks, reason }}
 */
export function buildHealthRecord(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('buildHealthRecord requires an input object');
  }
  const { agent_id, machine_id, environment = null, ts, checks = {}, stale = false, requiredChecks } = input;
  if (!agent_id) throw new TypeError('buildHealthRecord requires agent_id');
  if (!machine_id) throw new TypeError('buildHealthRecord requires machine_id');
  if (!ts) throw new TypeError('buildHealthRecord requires ts (ISO timestamp)');

  const { status, reason, checks: normalized } = reduceHealthStatus(checks, { stale, requiredChecks });
  return { agent_id, machine_id, environment, ts, status, checks: normalized, reason };
}
