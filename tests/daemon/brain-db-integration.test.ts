/**
 * FR-5: Integration test for the full brain.db chain.
 *
 * Gated behind BRAIN_DB_INTEGRATION=1 — does not run in standard CI.
 * Requires real storage.mechdna.net credentials and network access.
 *
 * Run via server (requires AGENTBOOTUP_API_KEY):
 *   BRAIN_DB_INTEGRATION=1 AGENTBOOTUP_API_KEY=<key> bun test tests/daemon/brain-db-integration.test.ts
 *
 * Run via direct Mech provision (requires MECH_APP_ID, MECH_API_KEY, MECH_API_SECRET):
 *   BRAIN_DB_INTEGRATION=1 MECH_APP_ID=... MECH_API_KEY=... MECH_API_SECRET=... \
 *     MECH_STORAGE_URL=https://storage.mechdna.net \
 *     bun test tests/daemon/brain-db-integration.test.ts
 *
 * What this covers:
 *   1. provisionBrainDb() → real /v1/brain-db/provision (or direct Mech) → real syncUrl/authToken
 *   2. Daemon starts with those credentials, initial db.sync() completes without error
 *   3. A write (INSERT chunks syncable=1) is made locally
 *   4. SIGUSR1 sent → daemon logs sync complete
 *   5. A separate libsql client connecting to syncUrl confirms the row is present
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { getPidFilePath } from '../../lib/process/pid-utils.js';

const INTEGRATION = process.env.BRAIN_DB_INTEGRATION === '1';

function tmpDir() {
  const d = path.join(os.tmpdir(), `brain-db-int-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

let target: string;
let daemonDir: string;
let daemonProc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(() => {
  target = tmpDir();
  daemonDir = path.join(target, 'daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
});

afterAll(async () => {
  // Ensure daemon is killed even if an expect() threw mid-test.
  if (daemonProc) {
    daemonProc.kill('SIGTERM');
    await Promise.race([daemonProc.exited, new Promise((r) => setTimeout(r, 5000))]);
    daemonProc = null;
  }
  fs.rmSync(target, { recursive: true, force: true });
});

/**
 * Provision a brain DB via the agentbootup server (primary path) or directly via
 * Mech Storage (fallback when server API key is unavailable in the test environment).
 */
async function provision(brainId: string): Promise<{ syncUrl: string; authToken: string }> {
  const serverUrl = process.env.AGENTBOOTUP_SERVER_URL || 'http://localhost:4321';
  const apiKey = process.env.AGENTBOOTUP_API_KEY;

  if (apiKey) {
    const res = await fetch(`${serverUrl}/v1/brain-db/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ brain_id: brainId }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`provision via server returned ${res.status}: ${errBody}`);
    }
    const body = await res.json() as { data?: { db_url?: string; db_token?: string } };
    if (!body.data?.db_url || !body.data?.db_token) {
      throw new Error(`provision response missing db_url/db_token: ${JSON.stringify(body)}`);
    }
    return { syncUrl: body.data.db_url, authToken: body.data.db_token };
  }

  // Fallback: call Mech Storage directly via MechClient (avoids needing server API key).
  const mechAppId = process.env.MECH_APP_ID;
  const mechApiKey = process.env.MECH_API_KEY;
  const mechApiSecret = process.env.MECH_API_SECRET;
  const mechStorageUrl = process.env.MECH_STORAGE_URL || 'https://storage.mechdna.net';

  if (!mechAppId || !mechApiKey || !mechApiSecret) {
    throw new Error(
      'provision requires either AGENTBOOTUP_API_KEY (server path) or ' +
      'MECH_APP_ID + MECH_API_KEY + MECH_API_SECRET (direct Mech path)',
    );
  }

  const { MechClient } = await import('../../src/server/lib/mech-client.js');
  const client = new MechClient({ baseUrl: mechStorageUrl, appId: mechAppId, apiKey: mechApiKey, apiSecret: mechApiSecret });
  const { syncUrl, authToken } = await client.libsql().provision({ namespace: brainId });
  return { syncUrl, authToken };
}

test('FR-5: full chain — provision → embedded-replica → write → SIGUSR1 sync → remote verify', async () => {
  if (!INTEGRATION) {
    console.log('  skip: set BRAIN_DB_INTEGRATION=1 to run');
    expect(true).toBe(true);
    return;
  }
  if (process.platform === 'win32') {
    console.log('  skip: SIGUSR1 not supported on Windows');
    expect(true).toBe(true);
    return;
  }

  const brainId = `inttest${crypto.randomBytes(4).toString('hex')}`;

  // ── Step 1: provision ─────────────────────────────────────────────────────
  const { syncUrl, authToken } = await provision(brainId);
  expect(syncUrl).toBeTruthy();
  expect(authToken).toBeTruthy();

  // ── Step 2: start daemon ───────────────────────────────────────────────────
  const dbPath = path.join(target, '.brain', 'brain.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const schemaPath = path.join(target, 'brain-schema.sql');
  fs.writeFileSync(schemaPath, `
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  brain_id TEXT NOT NULL,
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp TEXT,
  turn_type TEXT,
  content TEXT NOT NULL,
  token_count INTEGER,
  chunk_meta TEXT,
  syncable INTEGER NOT NULL DEFAULT 0,
  embedding BLOB
);
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO schema_meta VALUES ('schema_version', '3');
  `.trim());

  daemonProc = Bun.spawn(
    ['bun', path.resolve('lib/daemon/brain-db-sync.mjs')],
    {
      env: {
        ...process.env,
        AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP: '1',
        AGENTBOOTUP_DAEMON_DIR: daemonDir,
        BRAIN_DB_URL: syncUrl,
        BRAIN_DB_TOKEN: authToken,
        BRAIN_DB_PATH: dbPath,
        BRAIN_DB_SCHEMA_PATH: schemaPath,
        BRAIN_DB_BRAIN_ID: brainId,
        BRAIN_DB_SYNC_TIMEOUT_MS: '15000',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  // Wait for startup + initial sync (real network — allow 10s).
  await new Promise((r) => setTimeout(r, 5000));

  // Use same path derivation as unit tests: basename from utility, dir from test env.
  const pidFile = path.join(daemonDir, path.basename(getPidFilePath(`brain-db-sync-${brainId}`)));
  expect(fs.existsSync(pidFile)).toBe(true);

  // ── Step 3: write a syncable=1 row locally ────────────────────────────────
  const { Database } = await import('bun:sqlite');
  const db = new Database(dbPath, { readwrite: true });
  const rowId = `int-test-${crypto.randomBytes(4).toString('hex')}`;
  db.run(`
    INSERT INTO chunks (id, brain_id, project, session_id, timestamp, turn_type, content, token_count, syncable)
    VALUES (?, ?, 'integration-test', 'session-1', datetime('now'), 'human', 'integration test chunk', 5, 1)
  `, [rowId, brainId]);
  db.close();

  // ── Step 4: send SIGUSR1 and wait for sync ────────────────────────────────
  process.kill(daemonProc.pid, 'SIGUSR1');
  await new Promise((r) => setTimeout(r, 8000));

  // ── Step 5: verify row on remote ─────────────────────────────────────────
  const { createClient } = await import('@libsql/client');
  const remoteDb = createClient({ url: syncUrl, authToken });
  const result = await remoteDb.execute({
    sql: 'SELECT id FROM chunks WHERE id = ?',
    args: [rowId],
  });
  expect(result.rows.length).toBe(1);
  remoteDb.close();

  // Clean up daemon (afterAll also handles this if we get here normally).
  daemonProc.kill('SIGTERM');
  await Promise.race([daemonProc.exited, new Promise((r) => setTimeout(r, 5000))]);
  daemonProc = null;

  // PID file should be cleaned up.
  expect(fs.existsSync(pidFile)).toBe(false);
}, 60_000);
