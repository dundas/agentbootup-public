import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect state file to a temp path before any function calls.
// Uses getStateFilePath() lazy evaluation so the env var takes effect
// even though ES module imports are hoisted.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-syncstate-test-'));
const tmpStateFile = path.join(tmpDir, 'sync-state.json');
process.env['AGENTBOOTUP_SYNC_STATE_FILE'] = tmpStateFile;

import {
  readSyncState,
  writeSyncState,
  getFileOffset,
  updateFileOffset,
  getStateFilePath,
} from './sync-state';

describe('sync-state', () => {
  beforeEach(() => {
    // Clean state file before each test for isolation
    if (fs.existsSync(tmpStateFile)) fs.unlinkSync(tmpStateFile);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true });
    delete process.env['AGENTBOOTUP_SYNC_STATE_FILE'];
  });

  test('getStateFilePath() reflects AGENTBOOTUP_SYNC_STATE_FILE env var', () => {
    expect(getStateFilePath()).toBe(tmpStateFile);
  });

  test('readSyncState returns empty state when file is absent', async () => {
    const state = await readSyncState();
    expect(state).toEqual({ files: {} });
  });

  test('writeSyncState then readSyncState round-trips correctly', async () => {
    const state = {
      files: {
        '/tmp/test.jsonl': { lastOffset: 1024, lastPushedAt: '2026-01-01T00:00:00.000Z' },
      },
    };
    await writeSyncState(state);
    const result = await readSyncState();
    expect(result).toEqual(state);
  });

  test('written file has mode 0o600', async () => {
    await writeSyncState({ files: {} });
    const stat = fs.statSync(tmpStateFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('writeSyncState corrects permissions on existing file with wrong mode', async () => {
    // Simulate a file created by an older version with wider permissions
    fs.writeFileSync(tmpStateFile, '{}', { mode: 0o644 });
    fs.chmodSync(tmpStateFile, 0o644);
    expect(fs.statSync(tmpStateFile).mode & 0o777).toBe(0o644);

    await writeSyncState({ files: {} });
    expect(fs.statSync(tmpStateFile).mode & 0o777).toBe(0o600);
  });

  test('parent directory has mode 0o700 after writeSyncState', async () => {
    await writeSyncState({ files: {} });
    const dirStat = fs.statSync(path.dirname(tmpStateFile));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  test('getFileOffset returns 0 for unknown file', async () => {
    const offset = await getFileOffset('/tmp/never-seen.jsonl');
    expect(offset).toBe(0);
  });

  test('getFileOffset returns stored offset after updateFileOffset', async () => {
    await updateFileOffset('/tmp/transcript.jsonl', 4096);
    const offset = await getFileOffset('/tmp/transcript.jsonl');
    expect(offset).toBe(4096);
  });

  test('updateFileOffset persists lastPushedAt as ISO 8601', async () => {
    await updateFileOffset('/tmp/transcript.jsonl', 512);
    const state = await readSyncState();
    const entry = state.files['/tmp/transcript.jsonl'];
    expect(entry).toBeDefined();
    expect(new Date(entry.lastPushedAt).toISOString()).toBe(entry.lastPushedAt);
  });

  test('updateFileOffset updates existing entry without overwriting others', async () => {
    await updateFileOffset('/tmp/a.jsonl', 100);
    await updateFileOffset('/tmp/b.jsonl', 200);
    await updateFileOffset('/tmp/a.jsonl', 300);
    const state = await readSyncState();
    expect(state.files['/tmp/a.jsonl'].lastOffset).toBe(300);
    expect(state.files['/tmp/b.jsonl'].lastOffset).toBe(200);
  });

  test('readSyncState returns empty state for corrupted JSON', async () => {
    fs.writeFileSync(tmpStateFile, '{ not valid json }');
    const state = await readSyncState();
    expect(state).toEqual({ files: {} });
  });

  test('readSyncState returns empty state when files field is missing', async () => {
    fs.writeFileSync(tmpStateFile, JSON.stringify({ version: 1 }));
    const state = await readSyncState();
    expect(state).toEqual({ files: {} });
  });

  test('sequential offset updates for a growing file simulate multi-chunk push', async () => {
    // Simulates three push cycles on the same file (growing transcript):
    // cycle 1: bytes 0–4194304 (one 4 MB chunk)
    // cycle 2: bytes 4194304–8388608 (second 4 MB chunk)
    // cycle 3: bytes 8388608–8500000 (small tail chunk)
    const filePath = '/tmp/large-transcript.jsonl';
    await updateFileOffset(filePath, 4_194_304);
    expect(await getFileOffset(filePath)).toBe(4_194_304);

    await updateFileOffset(filePath, 8_388_608);
    expect(await getFileOffset(filePath)).toBe(8_388_608);

    await updateFileOffset(filePath, 8_500_000);
    expect(await getFileOffset(filePath)).toBe(8_500_000);

    // Other files in state are unaffected
    await updateFileOffset('/tmp/other.jsonl', 1024);
    expect(await getFileOffset('/tmp/other.jsonl')).toBe(1024);
    expect(await getFileOffset(filePath)).toBe(8_500_000);
  });
});
