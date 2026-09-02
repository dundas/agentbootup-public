import fs from 'fs';
import path from 'path';

const STATE_FILE = '.agentbootup-watch.json';
const INSTALL_FILE = '.agentbootup-watch.install.json';

export function getWatchStatePath(cwd) {
  return path.join(cwd, STATE_FILE);
}

export function getWatchInstallPath(cwd) {
  return path.join(cwd, INSTALL_FILE);
}

export function readWatchState(cwd) {
  const statePath = getWatchStatePath(cwd);
  if (!fs.existsSync(statePath)) return { running: false, installed: false, lastHeartbeatAt: '', lastTickAt: '', pid: 0 };
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return { running: false, installed: false, lastHeartbeatAt: '', lastTickAt: '', pid: 0 };
  }
}

export function writeWatchState(cwd, state) {
  fs.writeFileSync(getWatchStatePath(cwd), JSON.stringify(state, null, 2) + '\n');
}

export function installWatchAgent(cwd) {
  const installPath = getWatchInstallPath(cwd);
  fs.writeFileSync(
    installPath,
    JSON.stringify({ installedAt: new Date().toISOString(), runtime: '@derivativelabs/agent-process' }, null, 2) + '\n'
  );
  const current = readWatchState(cwd);
  writeWatchState(cwd, { ...current, installed: true });
  return installPath;
}

export function stopWatchAgent(cwd) {
  const current = readWatchState(cwd);
  writeWatchState(cwd, { ...current, running: false, pid: 0, stoppedAt: new Date().toISOString() });
}

export function startWatchAgent(cwd, services = {}, options = {}) {
  // Optional integration point: if @derivativelabs/agent-process is available,
  // we still keep this state file for doctor checks and lightweight local control.
  const persistent = options.persistent === true;
  const current = readWatchState(cwd);
  const now = new Date().toISOString();

  const pending = [];
  const runService = (handler) => {
    if (!handler) return;
    try {
      const maybePromise = handler();
      if (maybePromise && typeof maybePromise.then === 'function') {
        pending.push(maybePromise);
      }
    } catch {
      // best-effort; health file is still maintained
    }
  };
  runService(services.syncActiveTranscriptDeltas);
  runService(services.sendFleetHeartbeats);
  runService(services.syncChangedSkills);

  const baseState = {
    ...current,
    running: persistent,
    pid: persistent ? process.pid : 0,
    installed: current.installed || fs.existsSync(getWatchInstallPath(cwd)),
    startedAt: current.startedAt || now,
    lastTickAt: now,
    lastHeartbeatAt: pending.length === 0 ? now : (current.lastHeartbeatAt || ''),
    pendingServices: pending.length > 0,
  };
  writeWatchState(cwd, baseState);

  if (pending.length > 0) {
    Promise.allSettled(pending).then(() => {
      const fresh = readWatchState(cwd);
      writeWatchState(cwd, {
        ...fresh,
        running: persistent,
        pid: persistent ? process.pid : 0,
        pendingServices: false,
        lastTickAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      });
    });
  }
}

export function getWatchHealth(cwd) {
  const state = readWatchState(cwd);
  const pidAlive = isPidAlive(state.pid);
  const running = !!state.running && (state.pid ? pidAlive : true);
  const pendingServices = !!state.pendingServices;
  const heartbeatMs = state.lastHeartbeatAt ? Date.now() - new Date(state.lastHeartbeatAt).getTime() : null;
  return {
    running,
    installed: !!state.installed,
    pid: Number.isInteger(state.pid) ? state.pid : 0,
    lastHeartbeatAt: state.lastHeartbeatAt || '',
    heartbeatAgeMs: heartbeatMs,
    pendingServices,
    healthy: running && !pendingServices && heartbeatMs != null && heartbeatMs < 10 * 60 * 1000,
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
