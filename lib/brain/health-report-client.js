/**
 * Health report client (PRD-0039 Task 4.0, FR-7/FR-9).
 *
 * Thin client that POSTs a §4 health record to the central server's
 * `POST /v1/health/report` endpoint. NAT-safe (host→server outbound, matching
 * the established daemon-client direction). Injectable `fetch` for tests.
 */

/**
 * @param {object} opts
 * @param {string} opts.serverUrl          e.g. "https://agentbootup.fly.dev"
 * @param {string} opts.apiKey             Bearer token for the server API key.
 * @param {object} opts.record             The §4 health record to POST.
 * @param {typeof globalThis.fetch} [opts.fetch]  Injectable for tests.
 * @param {number} [opts.timeoutMs]        Request timeout (default 10 000).
 * @returns {Promise<void>}               Resolves on any 2xx; throws on any failure.
 */
export async function postHealthReport({ serverUrl, apiKey, record, fetch: _fetch = globalThis.fetch, timeoutMs = 10_000 }) {
  const base = serverUrl.replace(/\/$/, '');
  const url = `${base}/v1/health/report`;
  let res;
  try {
    res = await _fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`health report delivery failed (network): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = '';
    try { const t = await res.text(); detail = t ? ` — ${t.slice(0, 200)}` : ''; } catch { /* ignore */ }
    throw new Error(`health report delivery failed: HTTP ${res.status}${detail}`);
  }
}
