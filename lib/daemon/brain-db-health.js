/**
 * Durable, per-brain completion evidence for the brain DB sync daemon.
 *
 * This is intentionally a small independent record: doctor must be able to
 * distinguish a live process with no successful remote completion from one
 * whose replica has actually converged.
 */
import fs from 'fs';
import path from 'path';
import { getDaemonDir, isProcessAlive } from '../process/pid-utils.js';

export function getBrainDbSyncHealthPath(brainId) {
  // path.basename confines a configured id to a single state-file name.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.join(getDaemonDir(), `brain-db-sync-health-${path.basename(brainId)}.json`);
}

export function recordBrainDbSyncHealth(brainId, { now = new Date(), pid = process.pid } = {}) {
  const health = {
    brainId,
    pid,
    lastSyncAt: new Date(now).toISOString(),
  };
  const healthPath = getBrainDbSyncHealthPath(brainId);
  fs.mkdirSync(path.dirname(healthPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${healthPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(health)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, healthPath);
  return health;
}

export function readLiveBrainDbSyncHealth(brainId, expectedPid = null) {
  try {
    const health = JSON.parse(fs.readFileSync(getBrainDbSyncHealthPath(brainId), 'utf8'));
    if (health.brainId !== brainId || !Number.isSafeInteger(health.pid) || health.pid <= 0) return null;
    if (expectedPid && health.pid !== expectedPid) return null;
    if (!isProcessAlive(health.pid)) return null;
    return typeof health.lastSyncAt === 'string' ? health : null;
  } catch {
    return null;
  }
}
