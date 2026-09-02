import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { agentStart, agentStop } from '@derivativelabs/agent-process';
import { loadEnvConfigFile } from './env-config.js';
import { syncMountedEnvironment, updateMountRecord } from './mount-engine.js';
import {
  getMountWatcherAgentName,
  readMountWatcherState,
  writeMountWatcherState,
  getMountWatcherHealth,
  isPidAlive,
} from './mount-watcher-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHER_SCRIPT = path.join(__dirname, 'mount-watcher.mjs');
const BUN_INTERPRETER = path.basename(process.execPath) === 'bun' ? process.execPath : 'bun';

let watcherRuntime = { agentStart, agentStop };

export function setMountWatcherRuntimeForTests(runtime) {
  watcherRuntime = { ...watcherRuntime, ...runtime };
}

export function resetMountWatcherRuntimeForTests() {
  watcherRuntime = { agentStart, agentStop };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export const SERVICE_MANAGER_ERROR_SUBSTRINGS = [
  'systemctl --user daemon-reload',
  'systemctl: not found',
  'launchctl: not found',
];

function isMissingServiceManagerMessage(message) {
  const normalized = String(message || '').toLowerCase();
  return SERVICE_MANAGER_ERROR_SUBSTRINGS.some((s) => normalized.includes(s));
}

async function waitForPidExit(pid, timeoutMs = 5000) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (pid === process.pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleep(50);
  }
}

export async function startMountWatcher(opts) {
  const {
    mountRoot,
    envName,
    brainKey,
    sourceRoot,
    envConfigPath,
    project,
    bypassApprovals = false,
    intervalMs = 1000,
  } = opts;
  const agentName = getMountWatcherAgentName(envName, brainKey);
  const current = readMountWatcherState(mountRoot);

  try {
    await watcherRuntime.agentStop(agentName);
  } catch {
    /* best-effort restart */
  }
  await waitForPidExit(current.pid);

  let handle;
  try {
    handle = await watcherRuntime.agentStart({
      name: agentName,
      script: WATCHER_SCRIPT,
      interpreter: BUN_INTERPRETER,
      env: {
        AGENTBOOTUP_MOUNT_ROOT: mountRoot,
        AGENTBOOTUP_SOURCE_ROOT: sourceRoot,
        AGENTBOOTUP_ENV_CONFIG_PATH: envConfigPath,
        AGENTBOOTUP_PROJECT_ID: project.id,
        AGENTBOOTUP_AGENT_ID: project.agent_id || project.id,
        AGENTBOOTUP_MOUNT_WATCH_INTERVAL_MS: String(intervalMs),
        AGENTBOOTUP_MOUNT_BYPASS_APPROVALS: bypassApprovals ? '1' : '0',
        ...(process.env.AGENTBOOTUP_MOUNTS_BASE
          ? { AGENTBOOTUP_MOUNTS_BASE: process.env.AGENTBOOTUP_MOUNTS_BASE }
          : {}),
      },
    });
  } catch (err) {
    if (isMissingServiceManagerMessage(err?.message)) {
      err.code = 'SERVICE_MANAGER_UNAVAILABLE';
    }
    throw err;
  }
  if (!Number.isInteger(handle?.pid) || handle.pid <= 0) {
    throw new Error(`watcher start returned invalid pid for ${agentName}`);
  }

  const now = new Date().toISOString();
  writeMountWatcherState(mountRoot, {
    ...current,
    running: true,
    pid: handle.pid,
    agentName,
    startedAt: now,
    lastHeartbeatAt: now,
  });
  updateMountRecord(mountRoot, (current) => ({
    ...current,
    mount_kind: 'watch',
    live: true,
  }));
  return { agentName, pid: handle.pid };
}

export async function stopMountWatcher(opts) {
  const { mountRoot, envName, brainKey } = opts;
  const agentName = getMountWatcherAgentName(envName, brainKey);
  const current = readMountWatcherState(mountRoot);
  try {
    await watcherRuntime.agentStop(agentName);
  } catch {
    /* best-effort stop */
  }
  await waitForPidExit(current.pid);
  const stoppedAt = new Date().toISOString();
  writeMountWatcherState(mountRoot, {
    ...current,
    running: false,
    pid: 0,
    agentName,
    stoppedAt,
  });
  updateMountRecord(mountRoot, (current) => ({
    ...current,
    live: false,
  }));
}

export async function runMountWatcherTick(opts) {
  const {
    sourceRoot,
    envConfigPath,
    mountRoot,
    projectId,
    agentId,
    bypassApprovals = false,
    io = { stdout: () => {}, stderr: () => {} },
  } = opts;
  const loadedEnv = loadEnvConfigFile(envConfigPath);
  if (!loadedEnv.ok) {
    throw new Error(loadedEnv.error);
  }
  const result = syncMountedEnvironment({
    sourceRoot,
    envConfigPath,
    config: loadedEnv.config,
    configDir: loadedEnv.configDir,
    project: { id: projectId, agent_id: agentId, path: sourceRoot },
    bypassApprovals,
    mountKind: 'watch',
    live: true,
    io,
  });
  const now = new Date().toISOString();
  const current = readMountWatcherState(mountRoot);
  writeMountWatcherState(mountRoot, {
    ...current,
    running: true,
    pid: process.pid,
    lastHeartbeatAt: now,
    lastSyncedAt: result.noOp ? current.lastSyncedAt || now : now,
  });
  updateMountRecord(mountRoot, (record) => ({
    ...record,
    mount_kind: 'watch',
    live: true,
    last_synced_at: result.noOp ? record.last_synced_at || now : now,
  }));
  return result;
}

export async function runMountWatcherLoop(opts) {
  const intervalMs = Math.max(250, Number(opts.intervalMs) || 1000);
  let stopped = false;
  let timer = null;

  const sleep = () =>
    new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        resolve();
      }, intervalMs);
    });

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const state = readMountWatcherState(opts.mountRoot);
    writeMountWatcherState(opts.mountRoot, {
      ...state,
      running: false,
      pid: 0,
      stoppedAt: new Date().toISOString(),
    });
    updateMountRecord(opts.mountRoot, (record) => ({
      ...record,
      live: false,
    }));
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  while (!stopped) {
    try {
      await runMountWatcherTick(opts);
    } catch (err) {
      const state = readMountWatcherState(opts.mountRoot);
      writeMountWatcherState(opts.mountRoot, {
        ...state,
        running: true,
        pid: process.pid,
        lastHeartbeatAt: new Date().toISOString(),
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
    if (stopped) break;
    await sleep();
  }
}

export function readMountWatcherHealth(mountRoot) {
  return getMountWatcherHealth(mountRoot);
}
