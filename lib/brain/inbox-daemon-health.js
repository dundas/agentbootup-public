/**
 * lib/brain/inbox-daemon-health.js
 *
 * Synchronous health check for a project's inbox daemon.
 *
 * Reads the PID/state file written by inbox-daemon.mjs at startup and
 * verifies the process is still alive with signal 0. No HTTP round-trip
 * needed — safe to call from synchronous doctor/status commands.
 *
 * State file location: ~/.agentbootup/inbox-daemons/<brainId>.json
 * Written by: lib/daemon/inbox-daemon.mjs on startup
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const STATE_DIR = path.join(os.homedir(), '.agentbootup', 'inbox-daemons');

/**
 * Return health info for a brain's inbox daemon.
 *
 * @param {string} brainId  — e.g. "bootup.gm"
 * @returns {{
 *   running: boolean,
 *   pid: number | null,
 *   port: number | null,
 *   brainId: string,
 *   startedAt: string | null,
 *   stale: boolean,
 * }}
 */
export function getInboxDaemonHealth(brainId) {
  const stateFile = path.join(STATE_DIR, `${brainId}.json`);

  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    return { running: false, pid: null, port: null, brainId, startedAt: null, stale: false };
  }

  const { pid, port, startedAt } = state;

  // Verify the process is still alive using signal 0 (no signal sent — just checks existence).
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    // ESRCH = process does not exist; EPERM = exists but owned by another user
    alive = err.code === 'EPERM';
  }

  if (!alive) {
    // State file is stale — process exited without cleaning up (e.g. SIGKILL).
    return { running: false, pid, port, brainId, startedAt, stale: true };
  }

  return { running: true, pid, port, brainId, startedAt, stale: false };
}
