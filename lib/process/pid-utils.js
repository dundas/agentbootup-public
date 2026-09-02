/**
 * Shared PID-file and process-liveness utilities.
 *
 * Used by brain-asset-sync.mjs, restore.js, and doctor.js
 * to prevent the same logic from drifting across four files.
 */

import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Resolve the daemon directory.
 * Override via AGENTBOOTUP_DAEMON_DIR for test isolation.
 * @returns {string}
 */
export function getDaemonDir() {
  return (
    process.env.AGENTBOOTUP_DAEMON_DIR ||
    path.join(os.homedir(), '.agentbootup', 'daemon')
  );
}

/**
 * Absolute path for a named daemon's PID file.
 * @param {string} name  e.g. 'brain-asset-sync' or 'transcript-sync'
 * @returns {string}
 */
export function getPidFilePath(name) {
  return path.join(getDaemonDir(), `${name}.pid`);
}

/**
 * Check if `pid` is alive by sending signal 0.
 * Returns true if the process exists (even if we lack permission to signal it).
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Read PID from a file asynchronously.
 * Returns null if the file is absent, empty, or unparseable.
 * @param {string} pidFile
 * @returns {Promise<number | null>}
 */
export async function readPid(pidFile) {
  try {
    const raw = await fsp.readFile(pidFile, 'utf-8');
    const pid = parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Read PID from a file synchronously.
 * Returns null if the file is absent, empty, or unparseable.
 * @param {string} pidFile
 * @returns {number | null}
 */
export function readPidSync(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8');
    const pid = parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort POSIX signal trigger for a named daemon discovered by PID file.
 *
 * Guards:
 * - Windows skips POSIX signals entirely. `process.kill(pid, 0)` is not a safe
 *   Windows-only stand-in for "will SIGUSR1 work", so the platform guard must
 *   happen before PID lookup/liveness checks.
 * - Known limitation: if a daemon dies uncleanly and leaves a stale PID file,
 *   PID reuse can target an unrelated process. This is an accepted risk shared
 *   by all current PID-file signaling in this repo.
 *
 * @param {string} name
 * @param {{
 *   signal?: NodeJS.Signals,
 *   platform?: NodeJS.Platform,
 *   signalNameForMessages?: string,
 * }} [opts]
 * @returns {{
 *   ok: true,
 *   signaled: boolean,
 *   pid?: number,
 *   pidFile?: string,
 *   reason?: string,
 *   code?: 'windows-unsupported' | 'missing-pid-file' | 'pid-not-alive' | 'signal-failed',
 *   errorCode?: string,
 * }}
 */
export function signalDaemonByPidFile(name, opts = {}) {
  const platform = opts.platform || process.platform;
  const signal = opts.signal || 'SIGUSR1';
  const signalName = opts.signalNameForMessages || signal;
  if (platform === 'win32') {
    return {
      ok: true,
      signaled: false,
      code: 'windows-unsupported',
      reason: `${signalName} unsupported on Windows`,
    };
  }
  const pidFile = getPidFilePath(name);
  const pid = readPidSync(pidFile);
  if (!pid) {
    return {
      ok: true,
      signaled: false,
      code: 'missing-pid-file',
      reason: `${name} PID file not found (${pidFile})`,
    };
  }
  if (!isProcessAlive(pid)) {
    return {
      ok: true,
      signaled: false,
      code: 'pid-not-alive',
      reason: `${name} PID ${pid} is not alive`,
    };
  }
  try {
    process.kill(pid, signal);
    return { ok: true, signaled: true, pid, pidFile };
  } catch (err) {
    return {
      ok: true,
      signaled: false,
      code: 'signal-failed',
      errorCode: err && typeof err === 'object' && 'code' in err ? err.code : undefined,
      reason: `${name} signal failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
