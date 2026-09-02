/**
 * runBrainDbMigrations safety: FR-10 backup must succeed before v2→v3.
 */

import { test, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClient } from '@libsql/client';
import {
  runBrainDbMigrations,
  readSchemaVersion,
} from '../../lib/brain/brain-db-migrate.js';
import { writeCredentials } from '../../lib/auth/credentials.js';

let tmpDir: string | null = null;
let prevCreds: string | undefined;
let prevSkip: string | undefined;

afterEach(async () => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
  if (prevCreds === undefined) delete process.env.AGENTBOOTUP_CREDS_FILE;
  else process.env.AGENTBOOTUP_CREDS_FILE = prevCreds;
  if (prevSkip === undefined) delete process.env.AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP;
  else process.env.AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP = prevSkip;
});

test('runBrainDbMigrations does not migrate v2→v3 when backup upload fails', async () => {
  prevCreds = process.env.AGENTBOOTUP_CREDS_FILE;
  prevSkip = process.env.AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP;
  delete process.env.AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdm-fail-'));
  const credPath = path.join(tmpDir, 'creds');
  process.env.AGENTBOOTUP_CREDS_FILE = credPath;
  await writeCredentials({ apiKey: 'k', serverUrl: 'https://example.com' });

  const dbPath = path.join(tmpDir, 'brain.db');
  const setup = createClient({ url: `file:${dbPath}` });
  await setup.executeMultiple(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      brain_id TEXT NOT NULL,
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      turn_type TEXT,
      content TEXT NOT NULL,
      token_count INTEGER,
      embedding BLOB,
      chunk_meta TEXT,
      syncable INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('schema_version', '2');
  `);
  await setup.close();

  const db = createClient({ url: `file:${dbPath}` });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('server error', { status: 500, statusText: 'Internal Server Error' });

  try {
    await expect(
      runBrainDbMigrations(db, {
        brainDbFilePath: dbPath,
        brainId: 'test.brain',
        log: () => {},
        error: () => {},
      }),
    ).rejects.toThrow(/backup upload failed|brain\.db backup upload failed/i);
  } finally {
    globalThis.fetch = origFetch;
    await db.close();
  }

  const verify = createClient({ url: `file:${dbPath}` });
  const v = await readSchemaVersion(verify);
  expect(v).toBe(2);
  await verify.close();
});
