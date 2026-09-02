/**
 * Tests for lib/sync/restore.js
 *
 * Uses AGENTBOOTUP_RESTORE_ROOT_<CLI> env vars to redirect native CLI roots
 * to temp directories so tests never touch real ~/.claude etc.
 *
 * The `opts.promptFn` hook is used to simulate interactive user responses
 * without requiring a TTY.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';

function tmpId() { return crypto.randomBytes(8).toString('hex'); }

// Set env vars BEFORE importing the module so CLI_STANDARD_ROOTS is populated correctly.
const uniqueBase = path.join(os.tmpdir(), `agentbootup-restore-test-${tmpId()}`);
process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE = path.join(uniqueBase, 'native', 'claude');
process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX  = path.join(uniqueBase, 'native', 'codex');
process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI = path.join(uniqueBase, 'native', 'gemini');
process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR = path.join(uniqueBase, 'native', 'cursor');

const { handleDaemonRestore } = await import('../../lib/sync/restore.js');

const claudeRoot = process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!;
const codexRoot  = process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX!;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(uniqueBase, `run-${tmpId()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(claudeRoot, { recursive: true });
  await fsp.mkdir(codexRoot, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.rm(path.join(uniqueBase, 'native'), { recursive: true, force: true });
});

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
    out, err,
  };
}

/** Build a fake pulled archive: <inputDir>/<machineId>/<cli>/<relPath> */
async function buildArchive(inputDir: string, machineId: string, cli: string, relPath: string, content = 'content') {
  const p = path.join(inputDir, machineId, cli, relPath);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content, 'utf-8');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('restore writes file to native CLI path preserving subdirectory', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  await buildArchive(inputDir, 'machine-a', 'claude', '-Users-alice-proj/session.jsonl', '{"ok":1}');

  const { io, out } = captureIo();
  await handleDaemonRestore(['--input-dir', inputDir], io);

  const dest = path.join(claudeRoot, '-Users-alice-proj', 'session.jsonl');
  expect(await fsp.readFile(dest, 'utf-8')).toBe('{"ok":1}');
  expect(out.some((l) => l.includes('✓'))).toBe(true);
  expect(out.some((l) => l.includes('1 restored'))).toBe(true);
});

test('restore --dry-run does not write files', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  await buildArchive(inputDir, 'machine-a', 'claude', 'session.jsonl');

  const { io, out } = captureIo();
  await handleDaemonRestore(['--input-dir', inputDir, '--dry-run'], io);

  expect(out.some((l) => l.includes('+'))).toBe(true);
  const entries = await fsp.readdir(claudeRoot);
  expect(entries).toHaveLength(0);
});

test('restore skips existing files without --force', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  await buildArchive(inputDir, 'machine-a', 'claude', 'session.jsonl', 'new');

  const dest = path.join(claudeRoot, 'session.jsonl');
  await fsp.writeFile(dest, 'original', 'utf-8');

  const { io, out } = captureIo();
  await handleDaemonRestore(['--input-dir', inputDir], io);

  expect(await fsp.readFile(dest, 'utf-8')).toBe('original');
  expect(out.some((l) => l.includes('skipped'))).toBe(true);
});

test('restore --force overwrites existing files', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  await buildArchive(inputDir, 'machine-a', 'claude', 'session.jsonl', 'updated');

  const dest = path.join(claudeRoot, 'session.jsonl');
  await fsp.writeFile(dest, 'original', 'utf-8');

  const { io, out } = captureIo();
  await handleDaemonRestore(['--input-dir', inputDir, '--force'], io);

  expect(await fsp.readFile(dest, 'utf-8')).toBe('updated');
  expect(out.some((l) => l.includes('1 restored'))).toBe(true);
});

test('restore written files have mode 0o600', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  await buildArchive(inputDir, 'machine-a', 'codex', 'session.jsonl', 'data');

  const { io } = captureIo();
  await handleDaemonRestore(['--input-dir', inputDir, '--cli', 'codex'], io);

  const dest = path.join(codexRoot, 'session.jsonl');
  const stat = await fsp.stat(dest);
  expect(stat.mode & 0o777).toBe(0o600);
});

test('restore --cli filter skips other CLIs', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  await buildArchive(inputDir, 'machine-a', 'claude', 'session.jsonl');
  await buildArchive(inputDir, 'machine-a', 'codex', 'session.jsonl');

  const { io, out } = captureIo();
  await handleDaemonRestore(['--input-dir', inputDir, '--cli', 'claude'], io);

  expect((await fsp.readdir(claudeRoot)).length).toBeGreaterThan(0);
  expect(await fsp.readdir(codexRoot)).toHaveLength(0);
  expect(out.some((l) => l.includes('1 restored'))).toBe(true);
});

test('restore --machine-id filter restores only that machine', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  await buildArchive(inputDir, 'machine-a', 'claude', 'a.jsonl', 'a');
  await buildArchive(inputDir, 'machine-b', 'claude', 'b.jsonl', 'b');

  const { io, out } = captureIo();
  await handleDaemonRestore(['--input-dir', inputDir, '--machine-id', 'machine-a'], io);

  const entries = await fsp.readdir(claudeRoot);
  expect(entries).toContain('a.jsonl');
  expect(entries).not.toContain('b.jsonl');
  expect(out.some((l) => l.includes('1 restored'))).toBe(true);
});

test('restore rejects path traversal in relative_path', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  // Manually craft a traversal path in the archive
  const filePath = path.join(inputDir, 'machine-a', 'claude', '..', '..', 'evil.txt');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, 'evil');

  const { io } = captureIo();
  await handleDaemonRestore(['--input-dir', inputDir], io);

  // The file must not have been written outside claudeRoot
  const escaped = path.resolve(claudeRoot, '..', '..', 'evil.txt');
  expect(await fsp.access(escaped).then(() => true).catch(() => false)).toBe(false);
});

test('restore prompts user when standard root does not exist', async () => {
  // Remove codex root so it cannot be auto-discovered
  await fsp.rm(codexRoot, { recursive: true, force: true });

  const inputDir = path.join(tmpDir, 'archive');
  const customRoot = path.join(tmpDir, 'custom-codex');
  await fsp.mkdir(customRoot, { recursive: true });
  await buildArchive(inputDir, 'machine-a', 'codex', 'session.jsonl', 'hello');

  const { io, out } = captureIo();
  // Simulate user typing the custom path
  await handleDaemonRestore(
    ['--input-dir', inputDir, '--cli', 'codex'],
    io,
    { promptFn: async () => customRoot },
  );

  const dest = path.join(customRoot, 'session.jsonl');
  expect(await fsp.readFile(dest, 'utf-8')).toBe('hello');
  expect(out.some((l) => l.includes('1 restored'))).toBe(true);
});

test('restore skips CLI when user declines the prompt', async () => {
  await fsp.rm(codexRoot, { recursive: true, force: true });

  const inputDir = path.join(tmpDir, 'archive');
  await buildArchive(inputDir, 'machine-a', 'codex', 'session.jsonl');

  const { io, out } = captureIo();
  // User presses Enter (null = skip)
  await handleDaemonRestore(
    ['--input-dir', inputDir, '--cli', 'codex'],
    io,
    { promptFn: async () => null },
  );

  // Nothing restored, nothing failed
  expect(out.some((l) => l.includes('0 restored'))).toBe(true);
});

test('restore skips CLI in non-interactive mode when root missing', async () => {
  await fsp.rm(codexRoot, { recursive: true, force: true });

  const inputDir = path.join(tmpDir, 'archive');
  await buildArchive(inputDir, 'machine-a', 'codex', 'session.jsonl');

  const { io, out } = captureIo();
  const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', {
    value: false,
    configurable: true,
  });
  try {
    await handleDaemonRestore(['--input-dir', inputDir, '--cli', 'codex'], io);
  } finally {
    if (stdinIsTty) {
      Object.defineProperty(process.stdin, 'isTTY', stdinIsTty);
    } else {
      delete process.stdin.isTTY;
    }
  }

  expect(out.some((l) => l.includes('skip') || l.includes('Skip') || l.includes('0 restored'))).toBe(true);
});

// ── Backup integration ────────────────────────────────────────────────────────

test('restore --force creates a backup of the overwritten file', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  const backupDir = path.join(tmpDir, 'backups');
  process.env.AGENTBOOTUP_BACKUP_DIR = backupDir;

  await buildArchive(inputDir, 'machine-a', 'claude', 'session.jsonl', 'new content');
  const dest = path.join(claudeRoot, 'session.jsonl');
  await fsp.writeFile(dest, 'original content', 'utf-8');

  const { io } = captureIo();
  try {
    await handleDaemonRestore(['--input-dir', inputDir, '--force'], io);
  } finally {
    delete process.env.AGENTBOOTUP_BACKUP_DIR;
  }

  // Backup index should exist
  const indexFile = path.join(backupDir, 'index.json');
  const index = JSON.parse(await fsp.readFile(indexFile, 'utf-8'));
  expect(index.entries.length).toBeGreaterThan(0);
  expect(index.entries[0].trigger).toBe('restore --force');

  // The overwritten file should have new content
  expect(await fsp.readFile(dest, 'utf-8')).toBe('new content');
});

test('restore --list-backups shows available backups', async () => {
  const backupDir = path.join(tmpDir, 'backups-list');
  process.env.AGENTBOOTUP_BACKUP_DIR = backupDir;
  await fsp.mkdir(backupDir, { recursive: true });

  // Write a fake index
  const fakeIndex = {
    version: 1,
    entries: [
      { timestamp: '2026-01-01T00-00-00.000Z', trigger: 'restore --force', files: ['a.jsonl'], createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
  await fsp.writeFile(path.join(backupDir, 'index.json'), JSON.stringify(fakeIndex), 'utf-8');

  const { io, out } = captureIo();
  try {
    await handleDaemonRestore(['--list-backups'], io);
  } finally {
    delete process.env.AGENTBOOTUP_BACKUP_DIR;
  }

  expect(out.some((l) => l.includes('2026-01-01T00-00-00.000Z'))).toBe(true);
});

test('restore exits 1 with invalid --cli', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  await fsp.mkdir(inputDir);

  const { io, err } = captureIo();
  const origExit = process.exit;
  let exited = false;
  // @ts-ignore
  process.exit = () => { exited = true; throw new Error('exit'); };
  try {
    await handleDaemonRestore(['--input-dir', inputDir, '--cli', 'vscode'], io).catch(() => {});
  } finally { process.exit = origExit as never; }
  expect(exited || err.some((l) => l.includes('Invalid --cli'))).toBe(true);
});

test('restore exits 1 when input directory does not exist', async () => {
  const { io, err } = captureIo();
  const origExit = process.exit;
  let exited = false;
  // @ts-ignore
  process.exit = () => { exited = true; throw new Error('exit'); };
  try {
    await handleDaemonRestore(['--input-dir', path.join(tmpDir, 'nonexistent')], io).catch(() => {});
  } finally { process.exit = origExit as never; }
  expect(exited || err.some((l) => l.includes('not found'))).toBe(true);
});

test('restore throws instead of exiting when exitOnError is false', async () => {
  const inputDir = path.join(tmpDir, 'archive');
  await fsp.mkdir(inputDir);

  const { io, err } = captureIo();
  await expect(
    handleDaemonRestore(['--input-dir', inputDir, '--cli', 'vscode'], io, { exitOnError: false })
  ).rejects.toThrow('Invalid --cli');
  expect(err.some((l) => l.includes('Invalid --cli'))).toBe(true);
});

test('restore throws missing-input error with tip when exitOnError is false', async () => {
  const missingDir = path.join(tmpDir, 'nonexistent');
  const { io, err } = captureIo();
  const thrown = await handleDaemonRestore(['--input-dir', missingDir], io, { exitOnError: false }).catch((error) => error);
  expect(thrown.message).toContain('Input directory not found');
  expect(thrown.tip).toBe('Run: agentbootup transcripts restore to download transcripts first.');
  expect(err.some((l) => l.includes('Run: agentbootup transcripts restore to download transcripts first.'))).toBe(true);
});

test('restore throws from-backup validation errors when exitOnError is false', async () => {
  const { io } = captureIo();
  await expect(
    handleDaemonRestore(['--from-backup'], io, { exitOnError: false })
  ).rejects.toThrow('--from-backup requires a timestamp argument');
});
