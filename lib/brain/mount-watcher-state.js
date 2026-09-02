import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from './io-utils.js';

const STATE_FILE = '.agentbootup-mount-watcher.json';

function sanitizeServiceSegment(value) {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

export function getMountWatcherAgentName(envName, brainKey) {
  return `agentbootup-mount-watcher-${sanitizeServiceSegment(envName)}-${sanitizeServiceSegment(brainKey)}`;
}

export function getMountWatcherStatePath(mountRoot) {
  return path.join(mountRoot, STATE_FILE);
}

export function readMountWatcherState(mountRoot) {
  const statePath = getMountWatcherStatePath(mountRoot);
  if (!fs.existsSync(statePath)) {
    return {
      running: false,
      pid: 0,
      lastHeartbeatAt: '',
      lastSyncedAt: '',
      agentName: '',
    };
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return {
      running: false,
      pid: 0,
      lastHeartbeatAt: '',
      lastSyncedAt: '',
      agentName: '',
    };
  }
}

export function writeMountWatcherState(mountRoot, state) {
  fs.mkdirSync(mountRoot, { recursive: true });
  writeFileAtomic(getMountWatcherStatePath(mountRoot), `${JSON.stringify(state, null, 2)}\n`);
}

export function removeMountWatcherState(mountRoot) {
  try {
    fs.rmSync(getMountWatcherStatePath(mountRoot), { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && typeof err === 'object' && err.code === 'EPERM';
  }
}

export function getMountWatcherHealth(mountRoot) {
  const state = readMountWatcherState(mountRoot);
  const alive = !!state.running && isPidAlive(state.pid);
  return {
    ...state,
    running: alive,
    watcherStatus: alive ? 'online' : 'offline',
    healthy: alive,
  };
}

export function reconcileMountWatcherRecord(mountRoot, record) {
  if (record?.mount_kind !== 'watch') return record;
  const health = getMountWatcherHealth(mountRoot);
  return {
    ...record,
    live: health.running,
    watcher_status: health.watcherStatus,
    last_synced_at: health.lastSyncedAt || record?.last_synced_at || null,
  };
}
