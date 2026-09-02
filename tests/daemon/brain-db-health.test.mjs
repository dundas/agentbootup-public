import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getBrainDbSyncHealthPath, readLiveBrainDbSyncHealth, recordBrainDbSyncHealth } from '../../lib/daemon/brain-db-health.js';

const daemonDir = path.join(os.tmpdir(), `brain-db-health-${crypto.randomBytes(6).toString('hex')}`);
process.env.AGENTBOOTUP_DAEMON_DIR = daemonDir;

afterEach(() => fs.rmSync(daemonDir, { recursive: true, force: true }));

test('persists and reads a live successful DB sync completion', () => {
  const health = recordBrainDbSyncHealth('brain-a', { now: '2026-07-24T00:00:00.000Z' });
  expect(health.lastSyncAt).toBe('2026-07-24T00:00:00.000Z');
  expect(readLiveBrainDbSyncHealth('brain-a', process.pid)).toMatchObject(health);
  expect(fs.existsSync(getBrainDbSyncHealthPath('brain-a'))).toBe(true);
});

test('rejects a record that does not belong to the expected process', () => {
  recordBrainDbSyncHealth('brain-a');
  expect(readLiveBrainDbSyncHealth('brain-a', process.pid + 1)).toBeNull();
});
