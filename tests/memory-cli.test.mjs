import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClient } from '@libsql/client';
import { runMemoryCommand, triggerBrainDbSyncSignal } from '../lib/memory/cli.js';
import { runBrainDbMigrations, readSchemaVersion } from '../lib/brain/brain-db-migrate.js';
import { getPidFilePath, signalDaemonByPidFile } from '../lib/process/pid-utils.js';

const tempRoots = [];
const originalHome = process.env.HOME;
const originalDaemonDir = process.env.AGENTBOOTUP_DAEMON_DIR;

afterEach(() => {
  if (originalHome == null) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDaemonDir == null) delete process.env.AGENTBOOTUP_DAEMON_DIR;
  else process.env.AGENTBOOTUP_DAEMON_DIR = originalDaemonDir;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
    out,
    err,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

test('memory capture records pages into brain.db and refresh restores a missing page without clobbering drift', async () => {
  const root = tempDir('ab-memory-cli-');
  const home = tempDir('ab-memory-home-');
  process.env.HOME = home;
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: 'memory-brain' });
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'canon\n', 'utf8');
  fs.writeFileSync(path.join(root, 'memory', 'daily', '2026-07-12.md'), 'entry\n', 'utf8');

  let cap = captureIo();
  let code = await runMemoryCommand(['capture', '--cwd', root], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join('\n')).toContain('Captured 2 memory page(s)');

  fs.rmSync(path.join(root, 'memory', 'daily', '2026-07-12.md'));
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'local drift\n', 'utf8');

  cap = captureIo();
  code = await runMemoryCommand(['refresh', '--cwd', root], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join('\n')).toContain('restored:        1');
  expect(cap.out.join('\n')).toContain('drifted:         1');
  expect(cap.err.join('\n')).toContain('drifted page left untouched: memory/MEMORY.md');
  expect(fs.readFileSync(path.join(root, 'memory', 'daily', '2026-07-12.md'), 'utf8')).toBe('entry\n');
  expect(fs.readFileSync(path.join(root, 'memory', 'MEMORY.md'), 'utf8')).toBe('local drift\n');
});

test('memory capture records deletions only when prune is explicit so refresh does not resurrect intentionally removed pages', async () => {
  const root = tempDir('ab-memory-delete-');
  const home = tempDir('ab-memory-delete-home-');
  process.env.HOME = home;
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: 'memory-brain' });
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'daily', '2026-07-12.md'), 'entry\n', 'utf8');

  let cap = captureIo();
  let code = await runMemoryCommand(['capture', '--cwd', root], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join('\n')).toContain('deleted:   0');

  fs.rmSync(path.join(root, 'memory', 'daily', '2026-07-12.md'));
  cap = captureIo();
  code = await runMemoryCommand(['capture', '--cwd', root, '--prune-missing'], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join('\n')).toContain('deleted:   1');

  cap = captureIo();
  code = await runMemoryCommand(['refresh', '--cwd', root], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join('\n')).toContain('available_pages: 0');
  expect(fs.existsSync(path.join(root, 'memory', 'daily', '2026-07-12.md'))).toBe(false);
});

test('memory capture without prune leaves absent canonical pages intact', async () => {
  const root = tempDir('ab-memory-no-prune-');
  const home = tempDir('ab-memory-no-prune-home-');
  process.env.HOME = home;
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: 'memory-brain' });
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'daily', '2026-07-12.md'), 'entry\n', 'utf8');

  let cap = captureIo();
  let code = await runMemoryCommand(['capture', '--cwd', root], cap.io);
  expect(code).toBe(0);

  fs.rmSync(path.join(root, 'memory', 'daily', '2026-07-12.md'));
  cap = captureIo();
  code = await runMemoryCommand(['capture', '--cwd', root], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join('\n')).toContain('deleted:   0');

  cap = captureIo();
  code = await runMemoryCommand(['refresh', '--cwd', root], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join('\n')).toContain('restored:        1');
  expect(fs.readFileSync(path.join(root, 'memory', 'daily', '2026-07-12.md'), 'utf8')).toBe('entry\n');
});

test('memory refresh --force overwrites drifted files from brain.db', async () => {
  const root = tempDir('ab-memory-force-');
  const home = tempDir('ab-memory-force-home-');
  process.env.HOME = home;
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: 'memory-brain' });
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'canon\n', 'utf8');

  let cap = captureIo();
  let code = await runMemoryCommand(['capture', '--cwd', root], cap.io);
  expect(code).toBe(0);

  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'drift\n', 'utf8');
  cap = captureIo();
  code = await runMemoryCommand(['refresh', '--cwd', root, '--force'], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join('\n')).toContain('overwritten:     1');
  expect(fs.readFileSync(path.join(root, 'memory', 'MEMORY.md'), 'utf8')).toBe('canon\n');
});

test('brain-db migrate upgrades a v3 database to v4 with canonical memory tables', async () => {
  const dbPath = path.join(tempDir('ab-memory-migrate-'), 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  try {
    await db.execute('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await db.execute("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '3')");
    await runBrainDbMigrations(db, {
      skipBackup: true,
      log: () => {},
      error: () => {},
    });
    expect(await readSchemaVersion(db)).toBe(4);
    const pages = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_pages'");
    const events = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_events'");
    expect(pages.rows?.[0]?.name).toBe('memory_pages');
    expect(events.rows?.[0]?.name).toBe('memory_events');
  } finally {
    await db.close();
  }
});

test('memory capture upgrades schema metadata to v4 before writing tables', async () => {
  const root = tempDir('ab-memory-schema-');
  const home = tempDir('ab-memory-schema-home-');
  process.env.HOME = home;
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: 'memory-brain' });
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'canon\n', 'utf8');

  const dbPath = path.join(root, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  try {
    await db.execute('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await db.execute("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '3')");
  } finally {
    await db.close();
  }

  const cap = captureIo();
  const code = await runMemoryCommand(['capture', '--cwd', root], cap.io);
  expect(code).toBe(0);

  const verifyDb = createClient({ url: `file:${dbPath}` });
  try {
    expect(await readSchemaVersion(verifyDb)).toBe(4);
  } finally {
    await verifyDb.close();
  }
});

test('memory flush captures locally and reports local-only when no brain-db-sync daemon is running', async () => {
  const root = tempDir('ab-memory-flush-local-');
  const home = tempDir('ab-memory-flush-home-');
  process.env.HOME = home;
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: 'memory-brain' });
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'canon\n', 'utf8');

  const cap = captureIo();
  const code = await runMemoryCommand(['flush', '--cwd', root], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join('\n')).toContain('Flushed 1 memory page(s)');
  expect(cap.out.join('\n')).toContain('local capture only');

  const db = createClient({ url: `file:${path.join(root, '.brain', 'brain.db')}` });
  try {
    const rows = await db.execute("SELECT COUNT(*) AS c FROM memory_pages");
    expect(Number(rows.rows?.[0]?.c ?? 0)).toBe(1);
  } finally {
    await db.close();
  }
});

test('triggerBrainDbSyncSignal is an explicit no-op on Windows', async () => {
  const root = tempDir('ab-memory-flush-win32-');
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: 'memory-brain' });
  const result = triggerBrainDbSyncSignal(root, { platform: 'win32' });
  expect(result.ok).toBe(true);
  expect(result.signaled).toBe(false);
  expect(result.reason).toContain('Windows');
});

test('triggerBrainDbSyncSignal is local-only when agent_id is unavailable', async () => {
  const root = tempDir('ab-memory-flush-no-agent-');
  const result = triggerBrainDbSyncSignal(root);
  expect(result.ok).toBe(true);
  expect(result.signaled).toBe(false);
  expect(result.code).toBe('missing-agent-id');
  expect(result.reason).toContain('agent_id unavailable');
});

test('triggerBrainDbSyncSignal refuses invalid agent_id values before PID-path signaling', async () => {
  const root = tempDir('ab-memory-flush-invalid-agent-');
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: '../../tmp/escape' });
  const result = triggerBrainDbSyncSignal(root);
  expect(result.ok).toBe(true);
  expect(result.signaled).toBe(false);
  expect(result.code).toBe('invalid-agent-id');
  expect(result.reason).toContain('agent_id invalid');
});

test('memory flush on Windows exits 0 and reports local-only instead of signaling', async () => {
  const root = tempDir('ab-memory-flush-win32-cli-');
  const home = tempDir('ab-memory-flush-win32-home-');
  process.env.HOME = home;
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: 'memory-brain' });
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'canon\n', 'utf8');

  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const cap = captureIo();
    const code = await runMemoryCommand(['flush', '--cwd', root], cap.io);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toContain('Flushed 1 memory page(s)');
    expect(cap.out.join('\n')).toContain('SIGUSR1 unsupported on Windows');
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});

test('signalDaemonByPidFile returns structured codes for skipped and failed cases', () => {
  const daemonDir = tempDir('ab-memory-signal-daemon-');
  process.env.AGENTBOOTUP_DAEMON_DIR = daemonDir;

  const windowsResult = signalDaemonByPidFile('brain-db-sync-alpha', {
    platform: 'win32',
    signal: 'SIGUSR1',
  });
  expect(windowsResult.signaled).toBe(false);
  expect(windowsResult.code).toBe('windows-unsupported');

  const missingResult = signalDaemonByPidFile('brain-db-sync-alpha', {
    platform: 'darwin',
    signal: 'SIGUSR1',
  });
  expect(missingResult.signaled).toBe(false);
  expect(missingResult.code).toBe('missing-pid-file');

  const pidFile = getPidFilePath('brain-db-sync-alpha');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, '999999\n', 'utf8');
  const deadResult = signalDaemonByPidFile('brain-db-sync-alpha', {
    platform: 'darwin',
    signal: 'SIGUSR1',
  });
  expect(deadResult.signaled).toBe(false);
  expect(deadResult.code).toBe('pid-not-alive');
});

test('signalDaemonByPidFile preserves unexpected kill errors for callers', () => {
  const daemonDir = tempDir('ab-memory-signal-error-daemon-');
  process.env.AGENTBOOTUP_DAEMON_DIR = daemonDir;

  const pidFile = getPidFilePath('brain-db-sync-alpha');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  const originalKill = process.kill;
  process.kill = ((pid, signal) => {
    if (signal === 0) return undefined;
    const err = new Error('access denied');
    err.code = 'EACCES';
    throw err;
  });

  try {
    const result = signalDaemonByPidFile('brain-db-sync-alpha', {
      platform: 'darwin',
      signal: 'SIGUSR1',
    });
    expect(result.signaled).toBe(false);
    expect(result.code).toBe('signal-failed');
    expect(result.errorCode).toBe('EACCES');
    expect(result.reason).toContain('access denied');
  } finally {
    process.kill = originalKill;
  }
});

test('memory flush signals brain-db-sync via SIGUSR1 when the daemon pid is present', async () => {
  if (process.platform === 'win32') {
    console.log('  skip: SIGUSR1 not supported on Windows');
    expect(true).toBe(true);
    return;
  }
  const root = tempDir('ab-memory-flush-signal-');
  const home = tempDir('ab-memory-flush-signal-home-');
  const daemonDir = tempDir('ab-memory-flush-daemon-');
  process.env.HOME = home;
  process.env.AGENTBOOTUP_DAEMON_DIR = daemonDir;
  writeJson(path.join(root, 'agentbootup.json'), { agent_id: 'memory-brain' });
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'canon\n', 'utf8');

  const marker = path.join(root, 'sigusr1.txt');
  const ready = path.join(root, 'sigusr1-ready.txt');
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
        const fs = require('node:fs');
        const marker = process.argv[1];
        const ready = process.argv[2];
        process.on('SIGUSR1', () => {
          fs.writeFileSync(marker, 'seen\\n', 'utf8');
        });
        process.on('SIGTERM', () => process.exit(0));
        fs.writeFileSync(ready, 'ready\\n', 'utf8');
        setInterval(() => {}, 1000);
      `,
      marker,
      ready,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );

  try {
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(ready)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fs.existsSync(ready)).toBe(true);

    const pidFile = getPidFilePath('brain-db-sync-memory-brain');
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(child.pid), 'utf8');

    const originalKill = process.kill;
    const seen = [];
    process.kill = ((pid, signal) => {
      seen.push([pid, signal]);
      return originalKill(pid, signal);
    });

    const cap = captureIo();
    try {
      const code = await runMemoryCommand(['flush', '--cwd', root], cap.io);
      expect(code).toBe(0);
      expect(cap.out.join('\n')).toContain(`brain-db-sync: signaled PID ${child.pid} via SIGUSR1`);
      expect(seen).toContainEqual([child.pid, 'SIGUSR1']);

      for (let i = 0; i < 20; i++) {
        if (fs.existsSync(marker)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  } finally {
    child.kill('SIGTERM');
    await child.exited;
    delete process.env.AGENTBOOTUP_DAEMON_DIR;
  }
}, 15_000);
