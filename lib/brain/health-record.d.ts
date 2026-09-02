// Type declarations for the canonical health-record reducer (JS) so TS consumers
// (e.g. the server's Health Board) get a typed import instead of @ts-expect-error.

export type CheckState = 'pass' | 'fail' | 'unknown';
export type HealthStatus = 'healthy' | 'degraded' | 'stuck';

export interface CheckResult {
  state?: CheckState | string;
  severity?: string;
  category?: string;
  message?: string;
  required?: boolean;
}

export interface ReducedHealth {
  status: HealthStatus;
  reason: string | null;
  checks: Record<string, CheckResult>;
}

export const CHECK_NAMES: readonly string[];
export const CHECK_STATES: readonly string[];
export const HEALTH_STATUSES: readonly string[];

export function checkContribution(name: string, check: CheckResult): HealthStatus;
export function reduceHealthStatus(
  checks?: Record<string, CheckResult>,
  opts?: { stale?: boolean; requiredChecks?: string[] },
): ReducedHealth;
export function buildHealthRecord(input: {
  agent_id: string;
  machine_id: string;
  environment?: string | null;
  ts: string;
  checks?: Record<string, CheckResult>;
  stale?: boolean;
  requiredChecks?: string[];
}): {
  agent_id: string;
  machine_id: string;
  environment: string | null;
  ts: string;
  status: HealthStatus;
  checks: Record<string, CheckResult>;
  reason: string | null;
};
