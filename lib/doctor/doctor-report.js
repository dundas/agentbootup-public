/**
 * Doctor report assembler (PRD-0039 Task 2.0, FR-1/FR-2/FR-4).
 *
 * The single place that turns the four active checks into a normalized §4 health record
 * (`{ agent_id, machine_id, environment, ts, status, checks, reason }`). Shared by:
 *  - the `agentbootup doctor --health` CLI surface (this task),
 *  - the host `GET /v1/doctor` endpoint (Task 3.0),
 *  - the push-on-tick reporter (Task 4.0).
 *
 * Identity resolution (FR-2, OQ-1 resolved): `agent_id` ← config brainId, `machine_id` ←
 * `getMachineId()` (a stable persisted UUID, stable across restarts so the board's
 * `(agent_id, machine_id)` key does not churn).
 *
 * Runners are INJECTABLE so this is exercised without live agent-host / vault / runtime
 * endpoints. When a runner is absent or its source is unreachable, `aggregateHealthRecord`
 * degrades that check to `unknown` (→ Degraded) — never a false-Stuck and never a false-green
 * (the safety-critical invariant: Healthy only when every check returned `pass`). Live
 * construction of the four runners from real endpoints is wired by the reporter (Task 4.0);
 * until then an unconfigured host honestly reports Degraded with `unknown` checks.
 */

import { aggregateHealthRecord } from './aggregate.js';
import { getBrainId } from '../config/config.js';
import { getMachineId } from '../machine-id/machine-id.js';
import { buildLiveDoctorRunners } from './live-runners.js';
import { createRegisteredProjectIdentitiesRunner } from './project-identities-check.js';
import { checkTranscriptRedactionHealth } from './redaction-check.js';

/** Map a health status to a process exit code (FR-4): healthy → 0, anything else → non-zero. */
export function statusToExitCode(status) {
  return status === 'healthy' ? 0 : 1;
}

/**
 * Assemble the §4 health record for this host's agent.
 * @param {object} [input]
 * @param {string} [input.ts]            ISO timestamp; caller-supplied (the CLI/daemon stamps it).
 * @param {Record<string, () => Promise<object>>} [input.runners]  The four check runners. Absent
 *        runners degrade to `unknown`. Injectable for tests and for the reporter's live wiring.
 * @param {string} [input.agentId]       Override the resolved brainId (mainly for tests).
 * @param {string} [input.machineId]     Override the resolved machine UUID (mainly for tests).
 * @param {string} [input.environment]   Free-form environment label.
 * @param {boolean} [input.stale]
 * @param {() => Promise<string>} [input.resolveAgentId]    Injectable id resolver (default: getBrainId).
 * @param {() => Promise<string>} [input.resolveMachineId]  Injectable id resolver (default: getMachineId).
 * @returns {Promise<{ agent_id, machine_id, environment, ts, status, checks, reason }>}
 */
export async function buildDoctorReport(input = {}) {
  const {
    ts,
    runners = {},
    environment,
    stale = false,
    requiredChecks,
    resolveAgentId = getBrainId,
    resolveMachineId = getMachineId,
  } = input;

  // Resolve identity (FR-2). agent_id is required for a meaningful record; if no brain is
  // configured we surface a clear error rather than emitting a record keyed to ''.
  // `getBrainId()` returns `null` (falsy) when no brain is configured — so this guard is
  // reachable in production, not only under the injected test stub. (A malformed config makes
  // readConfig throw; that propagates and is caught by the caller's error path → exit 1.)
  const agentId = input.agentId ?? (await resolveAgentId());
  if (!agentId) {
    throw new Error('no brain configured — run `agentbootup config set-brain <id>` before the doctor can report health');
  }
  const machineId = input.machineId ?? (await resolveMachineId());

  return aggregateHealthRecord({ agentId, machineId, environment, ts, runners, stale, requiredChecks });
}

/**
 * Build the §4 record using live runners resolved from the local project + credentials.
 * Keeps `buildDoctorReport()` pure and injectable while production callers opt into the
 * real probes explicitly.
 * @param {object} [input]
 * @param {string} [input.cwd]
 * @returns {Promise<{ agent_id, machine_id, environment, ts, status, checks, reason }>}
 */
export async function buildLiveDoctorReport(input = {}) {
  let runners = input.runners ?? await buildLiveDoctorRunners({
    cwd: input.cwd,
    agentId: input.agentId,
    readCredentialsFn: input.readCredentialsFn,
    readConfigFn: input.readConfigFn,
    getNetworkRootFn: input.getNetworkRootFn,
    readFile: input.readFile,
    fetch: input.fetch,
    vaultBaseUrl: input.vaultBaseUrl,
    agentStatusFn: input.agentStatusFn,
    readBrainAssetHealthFn: input.readBrainAssetHealthFn,
    readBrainDbHealthFn: input.readBrainDbHealthFn,
    now: input.now,
  });
  const projectIdentities = createRegisteredProjectIdentitiesRunner(input.cwd);
  if (projectIdentities && !runners.project_identities) {
    runners = { ...runners, project_identities: projectIdentities };
  }
  if (!runners.redaction_disabled) {
    runners = {
      ...runners,
      redaction_disabled: async () => checkTranscriptRedactionHealth(input.env ?? process.env),
    };
  }
  const requiredChecks = [
    ...(input.requiredChecks ?? []),
    ...(runners.project_identities ? ['project_identities'] : []),
    ...(runners.config_integrity ? ['config_integrity'] : []),
    ...(runners.memory_transport ? ['memory_transport'] : []),
    'redaction_disabled',
    ...['brain_asset_freshness', 'brain_db_freshness', 'memory_daemon_freshness', 'transcript_active_freshness'].filter((name) => runners[name]),
  ];
  return buildDoctorReport({ ...input, runners, requiredChecks });
}
