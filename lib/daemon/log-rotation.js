import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_GENERATIONS = 5;
const DEFAULT_LAUNCHD_LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'dundas');
const DEFAULT_PM2_HOME = path.join(os.homedir(), '.dundas', 'pm2');
const DEFAULT_DAEMON_DIR = path.join(os.homedir(), '.agentbootup', 'daemon');
const PM2_NAMESPACE = 'dundas';

export function getDaemonLogRotationConfig(env = process.env) {
  const maxBytes = Number(env.AGENTBOOTUP_DAEMON_LOG_MAX_BYTES);
  const generations = Number(env.AGENTBOOTUP_DAEMON_LOG_GENERATIONS);
  return {
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_LOG_MAX_BYTES,
    generations:
      Number.isFinite(generations) && generations > 0
        ? Math.floor(generations)
        : DEFAULT_LOG_GENERATIONS,
  };
}

function detectWslHost(platform = process.platform) {
  if (platform !== 'linux') return false;
  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

export function getAgentProcessPlatform(platform = process.platform, isWsl = undefined) {
  const effectiveWsl = typeof isWsl === 'boolean' ? isWsl : detectWslHost(platform);
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return effectiveWsl ? 'pm2' : 'systemd';
  return 'pm2';
}

function getLaunchdLogTargets(serviceName, logDir) {
  return [
    path.join(logDir, `${serviceName}.out.log`),
    path.join(logDir, `${serviceName}.err.log`),
  ];
}

function getPm2ProcessName(serviceName) {
  return `${PM2_NAMESPACE}-${serviceName}`;
}

async function getPm2LogTargets(serviceName, pm2Home) {
  const processName = getPm2ProcessName(serviceName);
  const configPath = path.join(pm2Home, 'configs', `${processName}.json`);
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const app = Array.isArray(parsed?.apps) ? parsed.apps[0] : null;
    const explicit = [app?.out_file, app?.error_file].filter(
      (entry) => typeof entry === 'string' && entry.trim()
    );
    if (explicit.length > 0) return explicit;
  } catch {
    // Fall through to pm2 defaults.
  }
  return [
    path.join(pm2Home, 'logs', `${processName}-out.log`),
    path.join(pm2Home, 'logs', `${processName}-error.log`),
  ];
}

async function getDirectDaemonLogTargets(daemonDir) {
  try {
    const entries = await fsp.readdir(daemonDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
      .map((entry) => path.join(daemonDir, entry.name));
  } catch {
    return [];
  }
}

export async function resolveManagedLogTargets({
  serviceName,
  platform = getAgentProcessPlatform(),
  logDir = DEFAULT_LAUNCHD_LOG_DIR,
  pm2Home = DEFAULT_PM2_HOME,
  daemonDir = process.env.AGENTBOOTUP_DAEMON_DIR || DEFAULT_DAEMON_DIR,
} = {}) {
  const direct = await getDirectDaemonLogTargets(daemonDir);
  const deduped = new Set(direct);
  const skipped = [];

  if (serviceName) {
    if (platform === 'launchd') {
      for (const target of getLaunchdLogTargets(serviceName, logDir)) deduped.add(target);
    } else if (platform === 'systemd') {
      skipped.push({
        serviceName,
        reason: 'journald',
      });
    } else {
      for (const target of await getPm2LogTargets(serviceName, pm2Home)) deduped.add(target);
    }
  }

  return {
    rotatable: [...deduped].sort(),
    skipped,
  };
}

export async function rotateLogFile(filePath, { maxBytes, generations }) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { rotated: false, missing: true };
    throw err;
  }
  if (!stat.isFile() || stat.size <= maxBytes) {
    return { rotated: false, missing: false };
  }

  const maxGeneration = Math.max(1, generations);
  const oldest = `${filePath}.${maxGeneration}`;
  await fsp.rm(oldest, { force: true }).catch(() => {});

  for (let gen = maxGeneration - 1; gen >= 1; gen -= 1) {
    const current = `${filePath}.${gen}`;
    const next = `${filePath}.${gen + 1}`;
    try {
      await fsp.rename(current, next);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  await fsp.rename(filePath, `${filePath}.1`);
  return { rotated: true, missing: false };
}

export async function rotateManagedDaemonLogs(options = {}) {
  const config = {
    ...getDaemonLogRotationConfig(options.env),
    ...options,
  };
  const { rotatable, skipped } = await resolveManagedLogTargets(options);
  let rotated = 0;
  let examined = 0;
  for (const target of rotatable) {
    examined += 1;
    const result = await rotateLogFile(target, config);
    if (result.rotated) rotated += 1;
  }
  return {
    examined,
    rotated,
    skipped,
    rotatable,
  };
}
