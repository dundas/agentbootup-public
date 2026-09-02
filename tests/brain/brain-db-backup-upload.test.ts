/**
 * brain.db mech-plane backup upload (PRD-0014 FR-10).
 */

import { test, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  uploadBrainDbBackupToMechPlane,
  formatBrainDbBackupTimestamp,
  MAX_BRAIN_DB_BACKUP_BYTES,
} from '../../lib/brain/brain-db-backup-upload.js';

let tmp: string | null = null;
afterEach(() => {
  if (tmp && fs.existsSync(tmp)) {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  tmp = null;
});

test('formatBrainDbBackupTimestamp matches YYYY-MM-DD-HHmmss', () => {
  const s = formatBrainDbBackupTimestamp(new Date(2026, 3, 10, 14, 5, 9));
  expect(s).toBe('2026-04-10-140509');
});

test('uploadBrainDbBackupToMechPlane posts JSON push payload', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbu-'));
  const dbFile = path.join(tmp, 'brain.db');
  fs.writeFileSync(dbFile, Buffer.from('sqlite-test'));

  const orig = globalThis.fetch;
  let captured: RequestInit | null = null;
  globalThis.fetch = async (url: string | URL, init?: RequestInit) => {
    captured = init ?? null;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const result = await uploadBrainDbBackupToMechPlane({
      brainDbPath: dbFile,
      brainId: 'bootup.gm',
      serverUrl: 'https://example.com',
      apiKey: 'k',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.remotePath.startsWith('brain-db-backup/bootup.gm/')).toBe(true);
    const body = JSON.parse((captured?.body as string) ?? '{}');
    expect(body.files[0].path).toContain('brain-db-backup/bootup.gm/');
    expect(body.files[0].path.endsWith('.db')).toBe(true);
    expect(body.files[0].asset_type).toBe('config');
    expect(body.files[0].content_base64).toBe(Buffer.from('sqlite-test').toString('base64'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('uploadBrainDbBackupToMechPlane rejects oversize files', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbu-big-'));
  const dbFile = path.join(tmp, 'brain.db');
  fs.writeFileSync(dbFile, Buffer.alloc(MAX_BRAIN_DB_BACKUP_BYTES + 1));

  const result = await uploadBrainDbBackupToMechPlane({
    brainDbPath: dbFile,
    brainId: 'x',
    serverUrl: 'https://example.com',
    apiKey: 'k',
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('max');
});
