/**
 * Fleet Health Board routes (PRD-0038 FR-8/9/10/11, Task 7.2/7.3).
 *
 *   POST /v1/health/report        — a host pushes a per-agent health report
 *   GET  /v1/health               — fleet board (all agents/machines), staleness applied
 *   GET  /v1/brains/:id/health    — one brain's reports across machines, staleness applied
 *
 * This is PUSH-first (the PRD's "nudge"). The server is the read-model AUTHORITY: it
 * RE-DERIVES the rendered status from the reported `checks` via the canonical reducer
 * (never trusts the host's self-reported `status`), and applies server-stamped staleness.
 * FOLLOW-UP (FR-8 reliability): add the PULL path (server polls each host's `GET /v1/doctor`)
 * so a host that goes silent is actively probed, not merely aged out.
 *
 * AUTHZ (PRD-0039 Task 6.0, FR-13/14/15):
 *   Mode is controlled by AGENTBOOTUP_HEALTH_REPORT_AUTHZ env var:
 *     "warn"    (default) — log unregistered agent_ids without rejecting (migration-safe).
 *     "enforce" — reject reports for unregistered agent_ids with 403 (MUST NOT ship until
 *                 per-agent key exchange is live and no legitimate reporter is locked out).
 *
 *   Today the only check is "is the agent_id a registered brain?". This is a registry
 *   check (weak), not caller-identity proof (strong). The strong binding (caller == agent,
 *   proved by the brain keypair / ADMP) requires per-agent key infrastructure that does
 *   not yet exist on the server. This task ships the warn-then-enforce SCAFFOLDING; full
 *   key-based binding is a follow-up on the Agent Identity spec.
 *
 *   FR-15 mandate: enforce mode MUST NOT be activated until a spike confirms no legitimate
 *   reporter is locked out. Warn mode never false-Stucks the fleet.
 */

import { HttpError, jsonSuccess, readJsonBody, ensureString, ensureIdentifier, ensureOptionalString } from '../errors';
import type { HealthStore, HealthReport, HealthStatus } from '../lib/health-store';
import type { BrainStore } from '../lib/brain-store';
// Canonical reducer lives in lib/ (JS) with a co-located .d.ts; the server re-derives status here.
import { reduceHealthStatus } from '../../../lib/brain/health-record.js';

const STATUSES: HealthStatus[] = ['healthy', 'degraded', 'stuck'];
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Report authz mode (FR-15). 'warn' never rejects; 'enforce' 403s unregistered agents. */
export type HealthReportAuthzMode = 'warn' | 'enforce';

export function resolveHealthReportAuthzMode(): HealthReportAuthzMode {
  const v = (process.env.AGENTBOOTUP_HEALTH_REPORT_AUTHZ ?? '').toLowerCase().trim();
  return v === 'enforce' ? 'enforce' : 'warn'; // default: warn (safe)
}

function ensureStatus(value: unknown): HealthStatus {
  if (typeof value !== 'string' || !STATUSES.includes(value as HealthStatus)) {
    throw new HttpError(400, 'invalid_request', `Field 'status' must be one of: ${STATUSES.join(', ')}.`);
  }
  return value as HealthStatus;
}

const MAX_CHECK_KEYS = 64;
const MAX_CHECK_BYTES = 16 * 1024;

function ensureTimestamp(value: unknown, field: string): string {
  // `ts` is advisory/echo-only — accept any parseable timestamp (incl. numeric offsets),
  // not just the narrow `...Z` form, so a non-critical field can't 400 the whole report.
  if (typeof value !== 'string' || (!TS_RE.test(value) && !Number.isFinite(Date.parse(value)))) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be a parseable timestamp.`);
  }
  return value;
}

export async function handleHealthReport(
  req: Request,
  store: HealthStore,
  now = new Date(),
  brainStore?: BrainStore,
  authzMode: HealthReportAuthzMode = 'warn',
): Promise<Response> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const agent_id = ensureIdentifier(ensureString(body.agent_id, 'agent_id', { maxLength: 128 }), 'agent_id', 128);
  const machine_id = ensureIdentifier(ensureString(body.machine_id, 'machine_id', { maxLength: 128 }), 'machine_id', 128);

  // Per-agent authz (PRD-0039 FR-13/15). Check that the reported agent_id is a registered
  // brain. This is a REGISTRY check, not caller-identity proof — the strong binding
  // (caller proves it IS the agent via keypair) requires the Agent Identity spec.
  // In 'warn' mode: log unregistered agents, never reject (FR-15 migration safety).
  // In 'enforce' mode: 403 on unregistered agent — MUST NOT be activated until the
  // per-agent key exchange is live and no legitimate reporter is locked out.
  // Guard: enforce without a brainStore is a misconfiguration — log visibly rather than silently
  // accepting (which would make enforce a no-op and give false confidence in the authz check).
  if (!brainStore && authzMode === 'enforce') {
    console.error('[health-report] WARN: authzMode=enforce but no brainStore provided — authz check skipped (misconfiguration).');
  }

  if (brainStore) {
    let isRegistered = false;
    try {
      const brain = await brainStore.get(agent_id);
      isRegistered = brain != null;
    } catch {
      // Registry lookup failure → treat as unknown (not registered). In warn mode this
      // logs; in enforce mode this rejects — but a transient registry error should not
      // block all reporters, so enforce mode should NOT be activated in unstable envs.
      isRegistered = false;
    }
    if (!isRegistered) {
      if (authzMode === 'enforce') {
        // Omit agent_id from the outward-facing 403 message — the caller already knows it,
        // and echoing it in error responses would surface unregistered IDs to proxies/monitors.
        throw new HttpError(403, 'forbidden', 'Unregistered agent — report rejected (enforce mode). Register the agent or set AGENTBOOTUP_HEALTH_REPORT_AUTHZ=warn.');
      }
      // warn mode: log and accept (AC-6a — migration-safe, never false-Stucks the fleet).
      console.error(`[health-report] WARN: agent_id '${agent_id}' is not in the brain registry — report accepted (warn mode). Set AGENTBOOTUP_HEALTH_REPORT_AUTHZ=enforce only after all reporters are registered.`);
    }
  }
  // `ts` is advisory/echo-only (the local doctor's production time); staleness is driven by
  // the server-stamped `received_at`. Validated for shape only.
  const ts = ensureTimestamp(body.ts, 'ts');
  const environment = ensureOptionalString(body.environment, 'environment', { maxLength: 128 }) ?? null;
  // `status` is still validated for shape, but it is NOT trusted: the server is the read-model
  // authority and RE-DERIVES the rendered status from `checks` via the canonical reducer, so an
  // inconsistent report (healthy claim + a failing check) renders by its checks, not its claim.
  ensureStatus(body.status);
  if (body.checks == null || typeof body.checks !== 'object' || Array.isArray(body.checks)) {
    throw new HttpError(400, 'invalid_request', "Field 'checks' must be an object.");
  }
  // Bound the input key count up front (cheap reject) — a host must not push a bloated
  // checks object that is persisted and echoed in every fleet response.
  if (Object.keys(body.checks).length > MAX_CHECK_KEYS) {
    throw new HttpError(400, 'invalid_request', `Field 'checks' may contain at most ${MAX_CHECK_KEYS} entries.`);
  }

  // The reducer runs on attacker-controlled object values across the lib/server boundary —
  // guard it so a malformed shape returns 400, never an unhandled 500.
  let reduced: { status: string; reason: string | null; checks: Record<string, unknown> };
  try {
    reduced = reduceHealthStatus(body.checks as Record<string, unknown>);
  } catch (err) {
    throw new HttpError(400, 'invalid_request', `Field 'checks' could not be reduced: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Bound the PERSISTED value (reduced.checks — what is stored + echoed), by true byte size.
  // Per-check VALUES are trusted reducer output (the local doctor's structured detail),
  // not allowlisted to a fixed shape — bounded by byte size, not schema, by design.
  if (Buffer.byteLength(JSON.stringify(reduced.checks), 'utf8') > MAX_CHECK_BYTES) {
    throw new HttpError(400, 'invalid_request', `Field 'checks' exceeds the ${MAX_CHECK_BYTES}-byte limit.`);
  }
  // Defensive: validate the reduced status before persisting so any contract drift fails
  // loudly, not silently.
  ensureStatus(reduced.status);

  const report: HealthReport = {
    agent_id,
    machine_id,
    environment,
    ts,
    status: reduced.status as HealthStatus,
    checks: reduced.checks as Record<string, unknown>,
    reason: reduced.reason ?? null, // always server-derived; the host's reason is not trusted
    received_at: now.toISOString(),
  };
  await store.upsertReport(report);
  return jsonSuccess(202, { accepted: true, agent_id, machine_id });
}

export async function handleFleetHealth(store: HealthStore, now = new Date(), staleAfterMs?: number): Promise<Response> {
  const reports = await store.listFleet(now, staleAfterMs);
  return jsonSuccess(200, { agents: reports, total: reports.length, generated_at: now.toISOString() });
}

export async function handleBrainHealth(brainId: string, store: HealthStore, now = new Date(), staleAfterMs?: number): Promise<Response> {
  // brainId is already decoded + validated by the server's path layer (decodeAndValidateIdentifier).
  const reports = await store.listForBrain(brainId, now, staleAfterMs);
  if (reports.length === 0) {
    throw new HttpError(404, 'not_found', `No health reports for brain '${brainId}'.`);
  }
  return jsonSuccess(200, { agent_id: brainId, reports, total: reports.length, generated_at: now.toISOString() });
}
