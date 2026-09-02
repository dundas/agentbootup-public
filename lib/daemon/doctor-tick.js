/**
 * Doctor tick — push-on-tick health reporter (PRD-0039 Task 4.0, FR-7/8/9/10/10a/10b).
 *
 * Runs as a duty inside the unified daemon. On each tick:
 *   1. Freshly computes the §4 health record via `buildDoctorReport` (FR-10a: no
 *      cached record; each tick re-runs the runners and stamps a new `ts`).
 *   2. POSTs it to the central server's `POST /v1/health/report` (FR-7).
 *
 * Resilience (FR-9): a failed POST is logged and skipped; it NEVER crashes or blocks
 * other daemon duties. The server's `applyStaleness` detects silence and renders the
 * agent Stuck within the stale window — push failures naturally surface themselves.
 *
 * Kill-switch + off-by-default (FR-10b/AC-9): the tick does NOT run unless
 * `AGENTBOOTUP_DOCTOR_TICK_ENABLED=1`. Setting it to any other value (or omitting it)
 * keeps the daemon running its other duties unaffected. A running tick can be silenced
 * without stopping the daemon by unsetting the env var and sending SIGUSR1 (or restart).
 *
 * Probe amplification follow-up: live runners are now wired (agent-host readyz / vault /
 * chat), so the interval should stay bounded (FR-8: tick ≪ stale window) and the
 * GET /v1/doctor endpoint should eventually add a short-TTL cache to avoid amplifying
 * probe load from unbounded pollers.
 */

import { buildLiveDoctorReport } from '../doctor/doctor-report.js';
import { postHealthReport } from '../brain/health-report-client.js';

/** Default tick interval (60 s) is well inside the server's 5-min stale window (FR-8). */
const DEFAULT_TICK_MS = 60_000;

/**
 * Run the doctor tick duty inside the unified daemon.
 * Returns a stop function that cancels the interval cleanly.
 *
 * @param {object} [opts]
 * @param {string} opts.serverUrl
 * @param {string} opts.apiKey
 * @param {string} [opts.cwd]              Project root for live doctor resolution.
 * @param {number} [opts.tickMs]           Override the interval (mainly for tests).
 * @param {Function} [opts.buildReport]    Injectable for tests (default: buildLiveDoctorReport).
 * @param {Function} [opts.postReport]     Injectable for tests (default: postHealthReport).
 * @param {Function} [opts.log]            Injectable logger (default: console.error).
 * @returns {{ stop: () => void }}
 */
export function startDoctorTick({ serverUrl, apiKey, cwd, tickMs = DEFAULT_TICK_MS, buildReport = buildLiveDoctorReport, postReport = postHealthReport, log = console.error } = {}) {
  if (!serverUrl) throw new Error('startDoctorTick: serverUrl is required');
  if (!apiKey) throw new Error('startDoctorTick: apiKey is required');

  // Guard: tick ≪ stale window. Warn if the interval was configured too close to the
  // default stale window (5 min = 300 000 ms) — a tick at 4 min 50 s would flap on blips.
  const STALE_WINDOW_MS = 5 * 60_000;
  if (tickMs >= STALE_WINDOW_MS * 0.8) {
    log(`[doctor-tick] WARN: tickMs (${tickMs}ms) is >= 80% of the stale window (${STALE_WINDOW_MS}ms) — consider a shorter interval to avoid flapping`);
  }

  async function runTick() {
    const ts = new Date().toISOString(); // fresh ts each tick (FR-10a)
    let record;
    try {
      record = await buildReport({ ts, cwd });
    } catch (err) {
      log(`[doctor-tick] could not build health record: ${err instanceof Error ? err.message : String(err)}`);
      return; // retry next tick
    }
    try {
      await postReport({ serverUrl, apiKey, record });
    } catch (err) {
      // Delivery failure: logged, not thrown. Server staleness → Stuck detects silence.
      log(`[doctor-tick] health report delivery failed (will retry next tick): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Run once immediately so the board shows the agent before the first interval fires.
  runTick();
  const id = setInterval(runTick, tickMs);
  return { stop: () => clearInterval(id) };
}

/**
 * Whether the doctor tick is enabled. Opt-in (off by default — FR-10b, AC-9).
 * @returns {boolean}
 */
export function isDoctorTickEnabled() {
  return process.env.AGENTBOOTUP_DOCTOR_TICK_ENABLED === '1';
}
