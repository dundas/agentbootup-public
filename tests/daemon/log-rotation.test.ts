import { test, expect } from 'bun:test';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getAgentProcessPlatform,
  resolveManagedLogTargets,
  rotateManagedDaemonLogs,
} from '../../lib/daemon/log-rotation.js';

test('resolveManagedLogTargets returns launchd stdout and stderr targets plus direct daemon logs', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-log-targets-'));
  const launchdDir = path.join(root, 'launchd');
  const daemonDir = path.join(root, 'daemon');
  await fsp.mkdir(launchdDir, { recursive: true });
  await fsp.mkdir(daemonDir, { recursive: true });
  await fsp.writeFile(path.join(daemonDir, 'memory-sync.log'), 'x');

  const result = await resolveManagedLogTargets({
    serviceName: 'agentbootup-transcripts',
    platform: 'launchd',
    logDir: launchdDir,
    daemonDir,
  });

  expect(result.skipped).toEqual([]);
  expect(result.rotatable).toEqual([
    path.join(daemonDir, 'memory-sync.log'),
    path.join(launchdDir, 'agentbootup-transcripts.err.log'),
    path.join(launchdDir, 'agentbootup-transcripts.out.log'),
  ]);

  await fsp.rm(root, { recursive: true, force: true });
});

test('resolveManagedLogTargets marks systemd journald services as explicit skips', async () => {
  const result = await resolveManagedLogTargets({
    serviceName: 'agentbootup-transcripts',
    platform: 'systemd',
    daemonDir: path.join(os.tmpdir(), 'no-daemon-dir-needed'),
  });

  expect(result.rotatable).toEqual([]);
  expect(result.skipped).toEqual([{ serviceName: 'agentbootup-transcripts', reason: 'journald' }]);
});

test('resolveManagedLogTargets resolves pm2 defaults when no explicit log files are configured', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-pm2-targets-'));
  const pm2Home = path.join(root, 'pm2-home');
  const daemonDir = path.join(root, 'daemon');
  await fsp.mkdir(path.join(pm2Home, 'configs'), { recursive: true });
  await fsp.mkdir(daemonDir, { recursive: true });
  await fsp.writeFile(
    path.join(pm2Home, 'configs', 'dundas-agentbootup-transcripts.json'),
    JSON.stringify({ apps: [{ name: 'dundas-agentbootup-transcripts' }] }),
    'utf8',
  );

  const result = await resolveManagedLogTargets({
    serviceName: 'agentbootup-transcripts',
    platform: 'pm2',
    pm2Home,
    daemonDir,
  });

  expect(result.rotatable).toEqual([
    path.join(pm2Home, 'logs', 'dundas-agentbootup-transcripts-error.log'),
    path.join(pm2Home, 'logs', 'dundas-agentbootup-transcripts-out.log'),
  ]);

  await fsp.rm(root, { recursive: true, force: true });
});

test('rotateManagedDaemonLogs rotates oversized files and retains bounded generations', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-log-rotate-'));
  const launchdDir = path.join(root, 'launchd');
  await fsp.mkdir(launchdDir, { recursive: true });
  const outPath = path.join(launchdDir, 'agentbootup-transcripts.out.log');
  const errPath = path.join(launchdDir, 'agentbootup-transcripts.err.log');
  await fsp.writeFile(outPath, '0123456789', 'utf8');
  await fsp.writeFile(`${outPath}.1`, 'older', 'utf8');
  await fsp.writeFile(errPath, 'ok', 'utf8');

  const result = await rotateManagedDaemonLogs({
    serviceName: 'agentbootup-transcripts',
    platform: 'launchd',
    logDir: launchdDir,
    daemonDir: path.join(root, 'daemon'),
    maxBytes: 5,
    generations: 2,
  });

  expect(result.rotated).toBe(1);
  expect(fs.existsSync(`${outPath}.1`)).toBe(true);
  expect(fs.existsSync(`${outPath}.2`)).toBe(true);
  expect(fs.existsSync(outPath)).toBe(false);
  expect(await fsp.readFile(`${outPath}.1`, 'utf8')).toBe('0123456789');
  expect(await fsp.readFile(`${outPath}.2`, 'utf8')).toBe('older');
  expect(await fsp.readFile(errPath, 'utf8')).toBe('ok');

  await fsp.rm(root, { recursive: true, force: true });
});

test('getAgentProcessPlatform matches the adapter routing contract', () => {
  expect(getAgentProcessPlatform('darwin')).toBe('launchd');
  expect(getAgentProcessPlatform('linux', false)).toBe('systemd');
  expect(getAgentProcessPlatform('linux', true)).toBe('pm2');
  expect(getAgentProcessPlatform('win32')).toBe('pm2');
});

test('getAgentProcessPlatform auto-detects WSL on linux hosts from /proc/version', () => {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = ((filePath, encoding) => {
    if (filePath === '/proc/version' && encoding === 'utf8') {
      return 'Linux version 5.15.153.1-microsoft-standard-WSL2';
    }
    return originalReadFileSync(filePath, encoding);
  }) as typeof fs.readFileSync;

  try {
    expect(getAgentProcessPlatform('linux')).toBe('pm2');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});
