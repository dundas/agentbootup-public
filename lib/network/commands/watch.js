import { runSyncCommand } from './sync.js';
import { extractCwd } from '../args.js';
import { getWatchHealth, installWatchAgent, startWatchAgent, stopWatchAgent } from '../runtime/watch-agent.js';

function parseIntervalToMs(raw) {
  if (!raw) return 60 * 60 * 1000;
  const match = /^([0-9]+)([smhd])$/.exec(raw);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2];
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return value * factor;
}

const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function runWatchCommand(args, io) {
  const extracted = extractCwd(args);
  const localArgs = extracted.args;
  let intervalRaw = '1h';
  let once = false;
  let install = false;
  let start = false;
  let stop = false;
  let status = false;

  for (let i = 0; i < localArgs.length; i++) {
    const arg = localArgs[i];
    if (arg === '--interval' && localArgs[i + 1]) intervalRaw = localArgs[++i];
    if (arg === '--once') once = true;
    if (arg === '--install') install = true;
    if (arg === '--start') start = true;
    if (arg === '--stop') stop = true;
    if (arg === '--status') status = true;
  }

  const modeCount = [once, install, start, stop, status].filter(Boolean).length;
  if (modeCount > 1) {
    io.stderr('watch failed: choose only one mode flag (--once, --install, --start, --stop, --status)');
    return 1;
  }

  if (once) {
    io.stdout('Watch once mode');
    const forwardArgs = localArgs.filter((arg) => arg !== '--once');
    if (extracted.cwd !== process.cwd()) {
      forwardArgs.push('--cwd', extracted.cwd);
    }
    return runSyncCommand(forwardArgs, io);
  }

  if (install) {
    const installPath = installWatchAgent(extracted.cwd);
    io.stdout(`Watch daemon installed: ${installPath}`);
    return 0;
  }

  if (start) {
    io.stdout('Watch daemon start');
    startWatchAgent(extracted.cwd, {
      syncActiveTranscriptDeltas: () => {
        const forwardArgs = [];
        if (extracted.cwd !== process.cwd()) forwardArgs.push('--cwd', extracted.cwd);
        runSyncCommand(forwardArgs, io);
      },
      sendFleetHeartbeats: () => {
        io.stdout('  - heartbeat tick sent');
      },
      syncChangedSkills: () => {
        io.stdout('  - skill sync tick complete');
      },
    }, { persistent: false });
    io.stdout('Watch start tick completed (non-persistent mode)');
    io.stdout('note: use watch --interval for a persistent in-process loop');
    return 0;
  }

  if (stop) {
    stopWatchAgent(extracted.cwd);
    io.stdout('Watch daemon stopped');
    return 0;
  }

  if (status) {
    const health = getWatchHealth(extracted.cwd);
    io.stdout(`Watch daemon status: ${health.running ? 'running' : 'stopped'}`);
    io.stdout(`Installed: ${health.installed ? 'yes' : 'no'}`);
    io.stdout(`PID: ${health.pid || 'none'}`);
    io.stdout(`Healthy: ${health.healthy ? 'yes' : 'no'}`);
    io.stdout(`Last heartbeat: ${health.lastHeartbeatAt || 'never'}`);
    return 0;
  }

  const intervalMs = parseIntervalToMs(intervalRaw);
  if (!intervalMs) {
    io.stderr('watch failed: invalid --interval value (use Ns, Nm, Nh, or Nd)');
    return 1;
  }
  if (intervalMs > MAX_INTERVAL_MS) {
    io.stderr('watch failed: --interval exceeds maximum (7d)');
    return 1;
  }

  io.stdout(`Watch loop started (interval ${intervalRaw})`);
  // Returning 0 here does not terminate watch mode; the active interval keeps the process alive.
  startWatchAgent(extracted.cwd, {}, { persistent: true });
  let cycleInFlight = false;
  const runCycle = () => {
    if (cycleInFlight) {
      io.stderr('watch warning: previous sync cycle still running, skipping tick');
      return;
    }
    cycleInFlight = true;
    try {
      const forwardArgs = stripWatchOnlyArgs(localArgs);
      if (extracted.cwd !== process.cwd()) {
        forwardArgs.push('--cwd', extracted.cwd);
      }
      const code = runSyncCommand(forwardArgs, io);
      if (code !== 0) {
        io.stderr(`watch warning: sync exited with code ${code}`);
      }
    } finally {
      cycleInFlight = false;
    }
  };

  runCycle();
  const timer = setInterval(runCycle, intervalMs);

  const shutdown = () => {
    clearInterval(timer);
    stopWatchAgent(extracted.cwd);
    io.stdout('Watch loop stopped');
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}

function stripWatchOnlyArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--interval') {
      i += 1;
      continue;
    }
    if (arg === '--once' || arg === '--install' || arg === '--start' || arg === '--stop' || arg === '--status') {
      continue;
    }
    out.push(arg);
  }
  return out;
}
