/**
 * Brain discovery helpers — wraps GET /v1/brains on the agentbootup server.
 *
 * Used by `agentbootup config list-brains` to show a user which brain IDs
 * are registered under their API key so they can configure a new machine.
 */

import { isValidServerUrl, apiUrl } from '../auth/validate.js';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Fetch the list of brains from the server.
 *
 * Server response envelope: `{ data: { brains: Brain[], total: number } }`
 *
 * @param {{ apiKey: string, serverUrl: string }} creds
 * @returns {Promise<Array<{ id: string, name?: string, description?: string, [key: string]: unknown }>>}
 */
export async function listBrains(creds) {
  if (!isValidServerUrl(creds.serverUrl)) {
    throw new Error(`Invalid server URL: "${creds.serverUrl}". Must be http or https.`);
  }
  const url = apiUrl(creds.serverUrl, '/v1/brains');
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Server returned ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  // Response envelope: { data: { brains: [...], total: N } }
  return json.data?.brains ?? json.brains ?? [];
}

/**
 * Check whether one brain id is currently registered on the server under the
 * supplied credentials.
 *
 * @param {{ apiKey: string, serverUrl: string }} creds
 * @param {string} brainId
 * @returns {Promise<boolean>}
 */
export async function isBrainRegistered(creds, brainId) {
  if (!isValidServerUrl(creds.serverUrl)) {
    throw new Error(`Invalid server URL: "${creds.serverUrl}". Must be http or https.`);
  }
  const url = apiUrl(creds.serverUrl, `/v1/brains/${encodeURIComponent(brainId)}`);
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (resp.status === 404) return false;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Server returned ${resp.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

/**
 * Fetch the network config from the server.
 *
 * @param {{ apiKey: string, serverUrl: string }} creds
 * @returns {Promise<object|null>} Parsed config or null if none stored (404).
 */
export async function fetchNetworkConfig(creds) {
  if (!isValidServerUrl(creds.serverUrl)) {
    throw new Error(`Invalid server URL: "${creds.serverUrl}". Must be http or https.`);
  }
  const url = apiUrl(creds.serverUrl, '/v1/network-config');
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Server returned ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  return json.data ?? null;
}

/**
 * Push (upsert) network config to the server.
 * Strips `path` fields from projects before sending — paths are local-only.
 *
 * @param {{ apiKey: string, serverUrl: string }} creds
 * @param {object} config - Network config object (version, role, projects, etc.)
 * @returns {Promise<{ projectCount: number }>}
 */
export async function pushNetworkConfig(creds, config) {
  if (!isValidServerUrl(creds.serverUrl)) {
    throw new Error(`Invalid server URL: "${creds.serverUrl}". Must be http or https.`);
  }

  // Strip path fields — they are machine-local and should never be sent to server
  const stripped = {
    ...config,
    projects: (config.projects || []).map(({ path, ...rest }) => rest),
  };

  const url = apiUrl(creds.serverUrl, '/v1/network-config');
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(stripped),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Server returned ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  return json.data ?? { projectCount: 0 };
}
