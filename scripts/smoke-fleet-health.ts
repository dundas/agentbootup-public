/**
 * AC-5 smoke: kill-host → board flips Stuck within the stale window.
 * (PRD-0039 Task 5.0 — the primary acceptance gate)
 *
 * Exercises: reporter emits → board shows healthy → reporter stops (simulates
 * host death) → board flips Stuck within the stale window.
 *
 * Usage:
 *   bun scripts/smoke-fleet-health.ts
 *
 * Exits 0 on pass, 1 on failure.
 */

import { postHealthReport } from '../lib/brain/health-report-client.js';
import { buildHealthRecord } from '../lib/brain/health-record.js';

const SERVER_URL = process.env.AGENTBOOTUP_SERVER_URL || process.env.TEST_SERVER_URL;
const API_KEY = process.env.AGENTBOOTUP_API_KEY || process.env.TEST_API_KEY;
const AGENT_ID = process.env.TEST_AGENT_ID || `smoke-agent-${Date.now()}`;
const MACHINE_ID = process.env.TEST_MACHINE_ID || `smoke-machine-${Date.now()}`;

// Use a short stale window so the smoke doesn't take minutes.
// The server's actual window is set by AGENTBOOTUP_HEALTH_STALE_AFTER_SECONDS.
// This smoke passes --stale-seconds to communicate the expected window, defaulting
// to 30 s for a fast test loop.
const STALE_SECONDS = Number(process.env.TEST_STALE_SECONDS || 30);

async function poll(url: string, headers: Record<string, string>, agentId: string, machineId: string, expectedStatus: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${url}/v1/brains/${encodeURIComponent(agentId)}/health`, { headers });
    if (res.ok) {
      const body = await res.json() as { data?: { reports?: Array<{ machine_id: string; status: string }> } };
      const report = body.data?.reports?.find((r) => r.machine_id === machineId);
      if (report?.status === expectedStatus) return true;
      console.error(`  board shows: ${report?.status ?? 'no report'} (want ${expectedStatus})`);
    } else {
      console.error(`  board GET returned HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  if (!SERVER_URL || !API_KEY) {
    console.error('SKIP: AGENTBOOTUP_SERVER_URL and AGENTBOOTUP_API_KEY are required (or TEST_SERVER_URL / TEST_API_KEY)');
    console.error('Set AGENTBOOTUP_HEALTH_STALE_AFTER_SECONDS on the server to a short value (e.g. 30) for this smoke to run quickly.');
    process.exit(0); // skip rather than fail in environments without a live server
  }

  const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
  const ts = new Date().toISOString();
  const allPassChecks = {
    runtime_resolves: { state: 'pass' },
    identity_materializes: { state: 'pass' },
    credentials_authenticate: { state: 'pass' },
    messaging_round_trips: { state: 'pass' },
  };
  const healthyRecord = buildHealthRecord({ agent_id: AGENT_ID, machine_id: MACHINE_ID, ts, checks: allPassChecks });

  // Step 1: post a healthy report.
  console.error(`[smoke] POST healthy report for ${AGENT_ID}@${MACHINE_ID}`);
  await postHealthReport({ serverUrl: SERVER_URL, apiKey: API_KEY, record: healthyRecord });

  // Step 2: confirm board shows healthy.
  console.error('[smoke] polling for healthy...');
  const isHealthy = await poll(SERVER_URL, headers, AGENT_ID, MACHINE_ID, 'healthy', 15_000);
  if (!isHealthy) { console.error('FAIL: board did not show healthy after posting a healthy record'); process.exit(1); }
  console.error('[smoke] board: healthy ✓');

  // Step 3: stop reporting (simulate host death) — do nothing, just wait.
  // TEST_STALE_SECONDS must match the server's AGENTBOOTUP_HEALTH_STALE_AFTER_SECONDS.
  // If the server window > TEST_STALE_SECONDS, the smoke waits too briefly and exits 1 as a
  // false failure. Set both to the same value (e.g. 30) for a fast, valid test.
  console.error(`[smoke] host goes silent; waiting ${STALE_SECONDS + 5}s for staleness → Stuck (TEST_STALE_SECONDS=${STALE_SECONDS}; server AGENTBOOTUP_HEALTH_STALE_AFTER_SECONDS must match)...`);
  await new Promise((r) => setTimeout(r, (STALE_SECONDS + 5) * 1000));

  // Step 4: confirm board shows stuck.
  const isStuck = await poll(SERVER_URL, headers, AGENT_ID, MACHINE_ID, 'stuck', 15_000);
  if (!isStuck) { console.error('FAIL: board did not flip to stuck after the stale window'); process.exit(1); }
  console.error('[smoke] board: stuck ✓ — kill-host → Stuck acceptance gate PASSED');
}

main().catch((err) => { console.error('SMOKE ERROR:', err); process.exit(1); });
