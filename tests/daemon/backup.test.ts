/**
 * Tests for lib/sync/backup.js
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';

function tmpId() { return crypto.randomBytes(8).toString('hex'); }

const uniqueBase = path.join(os.tmpdir(), `agentbootup-backup-test-${tmpId()}`);
process.env.AGENTBOOTUP_BACKUP_DIR = path.join(uniqueBase, 'backups');

const { createBackup, listBackups, restoreFromBackup } = await import('../../lib/sync/backup.js');

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(uniqueBase, `run-${tmpId()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  // Clear backup index between tests
  await fsp.rm(process.env.AGENTBOOTUP_BACKUP_DIR!, { recursive: true, force: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('createBackup snapshots an existing file', async () => {
  const source = path.join(tmpDir, 'file.jsonl');
  await fsp.writeFile(source, 'original', 'utf-8');

  const { backedUp, skipped } = await createBackup([source], 'test', tmpDir);
  expect(backedUp).toContain(source);
  expect(skipped).toHaveLength(0);
});

test('createBackup skips files that do not exist', async () => {
  const missing = path.join(tmpDir, 'missing.jsonl');
  const { backedUp, skipped } = await createBackup([missing], 'test', tmpDir);
  expect(backedUp).toHaveLength(0);
  expect(skipped).toContain(missing);
});

test('createBackup writes index entry', async () => {
  const source = path.join(tmpDir, 'f.jsonl');
  await fsp.writeFile(source, 'data', 'utf-8');

  await createBackup([source], 'restore --force', tmpDir);

  const entries = await listBackups();
  expect(entries).toHaveLength(1);
  expect(entries[0].trigger).toBe('restore --force');
  expect(entries[0].files).toHaveLength(1);
});

test('listBackups returns entries most recent first', async () => {
  const f1 = path.join(tmpDir, 'a.jsonl');
  const f2 = path.join(tmpDir, 'b.jsonl');
  await fsp.writeFile(f1, 'a', 'utf-8');
  await fsp.writeFile(f2, 'b', 'utf-8');

  await createBackup([f1], 'first', tmpDir);
  await new Promise((r) => setTimeout(r, 5)); // ensure distinct createdAt
  await createBackup([f2], 'second', tmpDir);

  const entries = await listBackups();
  expect(entries[0].trigger).toBe('second');
  expect(entries[1].trigger).toBe('first');
});

test('restoreFromBackup copies files back to dest', async () => {
  const source = path.join(tmpDir, 'orig.jsonl');
  await fsp.writeFile(source, 'original content', 'utf-8');

  const { timestamp } = await createBackup([source], 'test', tmpDir);

  // Overwrite the original
  await fsp.writeFile(source, 'modified', 'utf-8');

  const destDir = path.join(tmpDir, 'restored');
  await fsp.mkdir(destDir, { recursive: true });
  const { restored } = await restoreFromBackup(timestamp, destDir);

  expect(restored.length).toBeGreaterThan(0);
  const restoredContent = await fsp.readFile(restored[0], 'utf-8');
  expect(restoredContent).toBe('original content');
});

test('restoreFromBackup throws for unknown timestamp', async () => {
  await expect(restoreFromBackup('nonexistent', tmpDir)).rejects.toThrow('No backup found');
});

test('createBackup does not write index entry when no files exist', async () => {
  const missing = path.join(tmpDir, 'no-file.jsonl');
  await createBackup([missing], 'nothing', tmpDir);

  const entries = await listBackups();
  expect(entries).toHaveLength(0);
});
