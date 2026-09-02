/**
 * Shared brain-identity quarantine (PRD-0054 Slice A).
 *
 * One implementation of the "unregistered brain" failure class for both sync
 * daemons, so detection and cooldown semantics cannot drift between them:
 *   - isNotFoundBrainResponse: the registry-404 predicate (HTTP 404 AND
 *     error.code === 'not_found' — a proxy's plain 404 does not count).
 *   - verifyBrainRegistered: startup handshake against GET /v1/brains/:id.
 *     Fails OPEN on anything other than a definitive registry 404: the
 *     handshake is a fast-fail aid, never a new availability dependency.
 *   - createQuarantineTracker: in-memory per-brain cooldown. In-memory is
 *     deliberate for the asset path — a daemon restart re-runs the startup
 *     handshake, which covers the persistence gap without a second state
 *     file. (Transcript-sync keeps its persisted transcriptFailures state in
 *     lib/sync-state/sync-state.js unchanged; it shares the predicate here.)
 *
 * FR A-3: a repeated identical 404 re-records the failure, so the cooldown
 * horizon is always exactly one window from the LAST failure — it never
 * compounds, and a single registration-propagation race can never lock a
 * brain out for longer than one window after its final 404.
 */

import { apiUrl } from '../auth/validate.js';

const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * True when a response is a definitive brain-registry 404
 * (HTTP 404 with a JSON body carrying error.code === 'not_found').
 * @param {Response} resp
 * @param {string} body  Response body text (already read by the caller).
 */
export function isNotFoundBrainResponse(resp, body) {
  if (resp.status !== 404) return false;
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.code === 'not_found';
  } catch {
    return false;
  }
}

/**
 * Startup identity handshake: verify brainId exists in the server registry.
 *
 * @param {{ brainId: string, apiKey: string, serverUrl: string, timeoutMs?: number }} opts
 * @returns {Promise<{ outcome: 'registered'|'not_found'|'unavailable', detail?: string }>}
 *   'registered'  — the registry knows this brain.
 *   'not_found'   — definitive registry 404: quarantine loudly.
 *   'unavailable' — 5xx / network / timeout / malformed: FAIL OPEN.
 */
export async function verifyBrainRegistered({ brainId, apiKey, serverUrl, timeoutMs = HANDSHAKE_TIMEOUT_MS }) {
  try {
    const resp = await fetch(apiUrl(serverUrl, `/v1/brains/${encodeURIComponent(brainId)}`), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) return { outcome: 'registered' };
    const body = await resp.text().catch(() => '');
    if (isNotFoundBrainResponse(resp, body)) {
      return { outcome: 'not_found', detail: body.slice(0, 200) };
    }
    return { outcome: 'unavailable', detail: `HTTP ${resp.status}` };
  } catch (err) {
    return { outcome: 'unavailable', detail: err?.message || 'network error' };
  }
}

/**
 * In-memory per-brain quarantine tracker.
 *
 * `opts.cooldownMs` is read at each record() call (not captured at creation)
 * so callers may pass a getter-backed object for lazy env resolution — env
 * overrides set after module load must be respected (lazy-env rule).
 *
 * @param {{ cooldownMs: number }} opts
 */
export function createQuarantineTracker(opts) {
  /** @type {Map<string, {status:number, code:string, message:string, failedAt:string, cooldownUntil:string, consecutiveFailures:number}>} */
  const entries = new Map();
  return {
    record(brainId, failure, now = Date.now()) {
      const previous = entries.get(brainId);
      const entry = {
        status: failure.status,
        code: failure.code || 'unknown',
        message: failure.message || '',
        failedAt: new Date(now).toISOString(),
        cooldownUntil: new Date(now + opts.cooldownMs).toISOString(),
        consecutiveFailures: (previous?.consecutiveFailures || 0) + 1,
      };
      entries.set(brainId, entry);
      return entry;
    },
    isQuarantined(brainId, now = Date.now()) {
      const entry = entries.get(brainId);
      if (!entry) return false;
      const untilMs = Date.parse(entry.cooldownUntil);
      return Number.isFinite(untilMs) && untilMs > now;
    },
    get(brainId) {
      return entries.get(brainId) ?? null;
    },
    clear(brainId) {
      return entries.delete(brainId);
    },
  };
}
