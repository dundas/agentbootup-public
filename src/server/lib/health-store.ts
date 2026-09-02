/**
 * Agentbootup Server — Fleet Health Board read-model store (PRD-0038 FR-8/9/11, Task 7.2/7.3).
 *
 * Cross-machine read-model: per-host doctor reports keyed by (agent_id, machine_id). The
 * server accepts reports (push) and renders Healthy/Degraded/Stuck per agent per machine
 * with a reason. Staleness (FR-11) is applied at READ time: a report not refreshed within
 * the stale window is rendered Stuck (report-staleness = a first-class Stuck reason) — the
 * missing "Stuck" detector (mech-plane's LivenessProvider always returns alive).
 */

import crypto from 'node:crypto';
import { MechClient } from './mech-client';

const COLLECTION = 'agentbootup_health_reports';

/** Default stale window: a host that has not reported within this is rendered Stuck. */
export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export type HealthStatus = 'healthy' | 'degraded' | 'stuck';

export interface HealthReport {
  agent_id: string;
  machine_id: string;
  environment: string | null;
  ts: string; // ISO — when the local doctor produced this report
  status: HealthStatus;
  checks: Record<string, unknown>;
  reason: string | null;
  received_at: string; // ISO — server receipt stamp (used for staleness)
}

// Deterministic, GLOBALLY-UNIQUE doc id (collection-prefixed hash) — so `getDocument(docId)`
// (the established store pattern across the server) resolves the row without a collection arg.
function docIdFor(agentId: string, machineId: string): string {
  const digest = crypto.createHash('sha256').update(JSON.stringify([agentId, machineId])).digest('hex');
  return `health_${digest}`;
}

// Extract an HTTP status from the common error shapes a client may surface.
function errorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const raw = e.status ?? e.statusCode ?? e.response?.status;
  return typeof raw === 'number' ? raw : null;
}

const VALID_STATUSES = new Set<HealthStatus>(['healthy', 'degraded', 'stuck']);

// Fail-safe on READ: an out-of-range stored status (corruption / legacy / future drift)
// coerces to `degraded` — never silently passes through as a (possibly green) bad value.
function coerceStatus(value: unknown): HealthStatus {
  return VALID_STATUSES.has(value as HealthStatus) ? (value as HealthStatus) : 'degraded';
}

export class HealthStore {
  constructor(private mech: MechClient) {}

  /** Upsert a per-host report (idempotent per (agent_id, machine_id) — latest wins). */
  async upsertReport(report: HealthReport): Promise<HealthReport> {
    const docId = docIdFor(report.agent_id, report.machine_id);
    const existing = await this.mech.getDocument(docId);
    if (existing) {
      await this.mech.updateDocument(docId, COLLECTION, report as unknown as Record<string, unknown>);
    } else {
      try {
        await this.mech.createDocumentWithId(COLLECTION, docId, report as unknown as Record<string, unknown>);
      } catch (err) {
        // Only a lost create RACE (409) falls back to update — a genuine create failure
        // (auth, malformed, transient) must surface, not be masked as a race. Check the
        // common status shapes so a real 409 is reliably detected.
        if (errorStatus(err) !== 409) throw err;
        await this.mech.updateDocument(docId, COLLECTION, report as unknown as Record<string, unknown>);
      }
    }
    return report;
  }

  /** All reports across the fleet, staleness applied. */
  async listFleet(now = new Date(), staleAfterMs = DEFAULT_STALE_AFTER_MS): Promise<HealthReport[]> {
    const docs = await this.mech.listDocuments(COLLECTION);
    return docs
      .map((doc) => applyStaleness(toHealthReport(doc.document), now, staleAfterMs))
      .sort((a, b) => a.agent_id.localeCompare(b.agent_id) || a.machine_id.localeCompare(b.machine_id));
  }

  /**
   * All reports for one brain (across machines), staleness applied.
   * NOTE: intentional full-collection scan + in-memory filter — fine at current fleet size;
   * switch to an agent_id-keyed query if report volume grows.
   */
  async listForBrain(agentId: string, now = new Date(), staleAfterMs = DEFAULT_STALE_AFTER_MS): Promise<HealthReport[]> {
    const fleet = await this.listFleet(now, staleAfterMs);
    return fleet.filter((r) => r.agent_id === agentId);
  }
}

/**
 * Project a stored document onto the public HealthReport shape via an ALLOWLIST — so internal
 * persistence fields (e.g. mech's `_collection`) never leak into board responses.
 */
function toHealthReport(raw: unknown): HealthReport {
  const r = (raw ?? {}) as Record<string, unknown>;
  const status = coerceStatus(r.status);
  const coerced = !VALID_STATUSES.has(r.status as HealthStatus);
  return {
    agent_id: String(r.agent_id ?? ''),
    machine_id: String(r.machine_id ?? ''),
    environment: typeof r.environment === 'string' ? r.environment : null,
    ts: String(r.ts ?? ''),
    status,
    checks: (r.checks ?? {}) as Record<string, unknown>,
    // If we had to coerce an invalid stored status, say so — don't render a stale/misleading reason.
    reason: coerced ? 'stored status invalid — coerced to degraded' : typeof r.reason === 'string' ? r.reason : null,
    received_at: String(r.received_at ?? ''),
  };
}

/**
 * Render staleness (FR-11): if the server has not received a fresh report within the stale
 * window, override the report to Stuck with a staleness reason — without mutating storage.
 * A report already Stuck stays Stuck.
 */
export function applyStaleness(report: HealthReport, now: Date, staleAfterMs: number): HealthReport {
  const received = Date.parse(report.received_at);
  const ageMs = Number.isFinite(received) ? now.getTime() - received : Infinity;
  if (ageMs > staleAfterMs) {
    const ageLabel = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s ago` : 'never';
    const staleReason = `report is stale (last received ${ageLabel}, window ${Math.round(staleAfterMs / 1000)}s)`;
    // Preserve the last-known cause whenever the report carried one (Stuck OR Degraded —
    // e.g. a credential failure) — staleness adds to it rather than hiding it.
    const reason = report.reason ? `${report.reason}; also ${staleReason}` : staleReason;
    return { ...report, status: 'stuck', reason };
  }
  return report;
}
