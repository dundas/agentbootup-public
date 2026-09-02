import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * @returns {string} ~/.brain/mounts (override with AGENTBOOTUP_MOUNTS_BASE for tests / automation)
 */
export function getMountsBaseDir() {
  const override = process.env.AGENTBOOTUP_MOUNTS_BASE;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), '.brain', 'mounts');
}

/**
 * @param {string} environmentName from env config `environment` field
 * @param {string} brainKey stable id (typically project.id)
 */
export function getMountDirectory(environmentName, brainKey) {
  const safeEnv = sanitizeSegment(environmentName);
  const safeBrain = sanitizeSegment(brainKey);
  return path.join(getMountsBaseDir(), safeEnv, safeBrain);
}

/**
 * @param {string} s
 */
function sanitizeSegment(s) {
  const raw = String(s ?? 'unknown').trim() || 'unknown';
  let safe = raw.replace(/[^a-zA-Z0-9._-]+/g, '_');
  if (safe === '.' || safe === '..') {
    safe = 'unknown';
  }
  return safe;
}

/**
 * Ensure directory exists.
 * @param {string} dir
 */
export function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
