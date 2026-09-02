/**
 * FR-7 — aggregate the four checks into one normalized per-agent health record
 * (PRD-0038 Task 7 / §2). Composes Tasks 1–5: it runs each check, applies the §5 reducer,
 * and emits the §4 record.
 *
 * GRACEFUL DEGRADATION (the FR-7 keystone, from the pairing session): a check whose source
 * is unavailable — not wired, or its probe errors (e.g. mech-run `GET /v1/doctor` 404, an
 * unreachable agent-host) — becomes `unknown`, NEVER a `fail`. Infra-absence is not
 * proven-failure: an unshipped cross-team endpoint must yield Degraded, never make every
 * agent look Stuck. (A check that RUNS and proves failure, e.g. a revoked credential, still
 * fails → Stuck — that is the load-bearing distinction.)
 *
 * RUNNER CONTRACT (load-bearing — see adversarial review fr7-aggregate):
 *  - THROW  = "source unavailable / could not determine" → mapped to `unknown` (degrade).
 *  - RETURN `{state:'fail'}` = "completed and PROVEN failed" → kept as fail (→ Stuck for
 *    the load-bearing checks). A proven failure must be RETURNED, never thrown, or it would
 *    be downgraded to unknown.
 * The aggregator preserves the only safety-critical invariant unconditionally: it can never
 * emit Healthy unless every check explicitly returned `{state:'pass'}` (unknown ≠ pass).
 * FOLLOW-UP (live-wiring task): mech-run/agent-host runners must propagate source-unreachable
 * as a THROW so FR-7's degrade holds end-to-end (a naive `() => checkRuntimeResolves(...)`
 * wiring would over-Stuck, since that check returns fail — not throws — on a readyz error).
 */

import { CHECK_NAMES, buildHealthRecord } from '../brain/health-record.js';

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one check runner with graceful degradation: absent runner or a throwing runner →
 * `unknown` (source unavailable / could not complete), never fail.
 * @param {string} name
 * @param {undefined | (() => Promise<object>)} runner
 * @returns {Promise<object>} a per-check result
 */
async function runOne(name, runner) {
  if (typeof runner !== 'function') {
    return { state: 'unknown', severity: 'warning', category: name, message: `${name}: check source not available` };
  }
  try {
    const result = await runner();
    if (!result || typeof result !== 'object') {
      return { state: 'unknown', severity: 'warning', category: name, message: `${name}: check returned no usable result` };
    }
    return result;
  } catch (err) {
    // Source errored (404 / unreachable / timeout) → unknown, not fail (graceful degrade).
    return { state: 'unknown', severity: 'warning', category: name, message: `${name}: check could not complete: ${errMessage(err)}` };
  }
}

/**
 * Aggregate the four checks into a normalized §4 health record.
 * @param {object} input
 * @param {string} input.agentId
 * @param {string} input.machineId
 * @param {string} [input.environment]
 * @param {string} input.ts                                   ISO timestamp (caller-supplied)
 * @param {Record<string, () => Promise<object>>} input.runners
 *        Per-check runner functions keyed by check name (the four CHECK_NAMES). Any check
 *        whose runner is absent or throws degrades to `unknown` (never fail).
 * @param {boolean} [input.stale]
 * @param {string[]} [input.requiredChecks]  Override the load-bearing set forwarded to the
 *        reducer. The core four are always required (unioned), but a caller may ADD extra
 *        required checks. Behavior-altering: a required check's failure dominates the status.
 * @returns {Promise<{agent_id, machine_id, environment, ts, status, checks, reason}>}
 * Note: a runner that RETURNS a sparse result (e.g. `{state:'pass'}` with no category) is
 * passed through; `buildHealthRecord` fills missing fields (only `state`/`required` drive
 * the reducer). Only the degrade path synthesizes a full `{state,severity,category,message}`.
 */
export async function aggregateHealthRecord(input = {}) {
  const { agentId, machineId, environment, ts, runners = {}, stale = false, requiredChecks } = input;

  // Run the core four PLUS any extra (e.g. optional integration) runners the caller wired,
  // so an extra runner is never silently dropped. Each degrades independently to unknown.
  const names = [...new Set([...CHECK_NAMES, ...Object.keys(runners)])];
  const checks = {};
  await Promise.all(
    names.map(async (name) => {
      checks[name] = await runOne(name, runners[name]);
    }),
  );

  return buildHealthRecord({ agent_id: agentId, machine_id: machineId, environment, ts, checks, stale, requiredChecks });
}
