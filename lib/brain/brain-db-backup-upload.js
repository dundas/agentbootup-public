/**
 * Upload a brain.db file snapshot to mech-plane brain-assets (same JSON push as secrets).
 * PRD-0014 FR-10: brain-db-backup/<brain_id>/<YYYY-MM-DD-HHmmss>.db
 */

import { stat, readFile } from 'fs/promises';
import { apiUrl, isValidServerUrl } from '../auth/validate.js';
import { brainAssetPushHeaders } from '../brain-asset-headers.js';

const PUSH_TIMEOUT_MS = 120_000;
/** Same transport as secrets push — keep under typical API limits; huge DBs need manual backup. */
export const MAX_BRAIN_DB_BACKUP_BYTES = 32 * 1024 * 1024;

/**
 * @param {Date} [d]
 * @returns {string}
 */
export function formatBrainDbBackupTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Upload brain.db bytes to /v1/brain-assets/:id/push (asset_type config, path brain-db-backup/...).
 *
 * @param {{ brainDbPath: string, brainId: string, serverUrl: string, apiKey: string }} args
 * @returns {Promise<{ ok: true, remotePath: string } | { ok: false, error: string }>}
 */
export async function uploadBrainDbBackupToMechPlane(args) {
  const { brainDbPath, brainId, serverUrl, apiKey } = args;
  if (!isValidServerUrl(serverUrl)) {
    return { ok: false, error: 'invalid server URL' };
  }
  let st;
  try {
    st = await stat(brainDbPath);
  } catch (err) {
    return { ok: false, error: `cannot stat brain.db: ${err?.message ?? String(err)}` };
  }
  if (!st.isFile()) {
    return { ok: false, error: 'brain.db path is not a file' };
  }
  if (st.size > MAX_BRAIN_DB_BACKUP_BYTES) {
    return {
      ok: false,
      error: `brain.db is ${st.size} bytes (max ${MAX_BRAIN_DB_BACKUP_BYTES} for automatic backup) — back up manually, then set AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP=1 to migrate`,
    };
  }

  let buf;
  try {
    buf = await readFile(brainDbPath);
  } catch (err) {
    return { ok: false, error: `cannot read brain.db: ${err?.message ?? String(err)}` };
  }

  const ts = formatBrainDbBackupTimestamp();
  const remotePath = `brain-db-backup/${brainId}/${ts}.db`;

  const payload = {
    files: [
      {
        path: remotePath,
        content_base64: buf.toString('base64'),
        asset_type: 'config',
        cli: 'shared',
      },
    ],
  };

  const endpoint = apiUrl(serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}/push`);
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: brainAssetPushHeaders(apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timerId);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 400)}` };
    }
    return { ok: true, remotePath };
  } catch (err) {
    clearTimeout(timerId);
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'request timed out' };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}
