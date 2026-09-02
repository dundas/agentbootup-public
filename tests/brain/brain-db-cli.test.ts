/**
 * brain-db status / migrate CLI (PRD-0014 Task 2.4–2.5).
 */

import { test, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClient } from '@libsql/client';
import { runBrainDbCommand } from '../../lib/network/commands/brain-db.js';

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (s: string) => {
        out.push(s);
      },
      stderr: (s: string) => {
        err.push(s);
      },
    },
    out,
    err,
  };
}

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

test('brain-db status --json reports row counts and schema_version', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-db-cli-'));
  fs.writeFileSync(
    path.join(tmpDir, 'agentbootup.json'),
    JSON.stringify({ agent_id: 'test.brain', type: 'service' }),
    'utf-8',
  );
  fs.mkdirSync(path.join(tmpDir, '.brain'), { recursive: true });
  const dbPath = path.join(tmpDir, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  await db.executeMultiple(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('schema_version', '4');
    INSERT INTO schema_meta VALUES ('brain_id', 'test.brain');
    CREATE TABLE chunks (id TEXT PRIMARY KEY);
    CREATE TABLE skills (id TEXT PRIMARY KEY);
    CREATE TABLE skill_docs (id TEXT PRIMARY KEY);
    CREATE TABLE skill_index_state (path TEXT PRIMARY KEY);
    CREATE TABLE memory_events (id TEXT PRIMARY KEY);
    CREATE TABLE memory_pages (page_path TEXT PRIMARY KEY);
    INSERT INTO chunks VALUES ('x');
    INSERT INTO skills VALUES ('s1');
    INSERT INTO skill_docs VALUES ('d1');
  `);
  await db.close();

  const { io, out } = captureIo();
  const code = await runBrainDbCommand(['status', '--json', '--cwd', tmpDir], io);
  expect(code).toBe(0);
  const json = JSON.parse(out.join('\n'));
  expect(json.schema_version).toBe('4');
  expect(json.row_counts.chunks).toBe(1);
  expect(json.row_counts.skills).toBe(1);
  expect(json.row_counts.skill_docs).toBe(1);
  expect(json.row_counts.memory_events).toBe(0);
  expect(json.row_counts.memory_pages).toBe(0);
  expect(json.skill_index_state).toBe('empty');
});

test('brain-db migrate v2 file DB reaches v4 with AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP', async () => {
  const prev = process.env.AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP;
  process.env.AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP = '1';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-db-mig-'));
    fs.writeFileSync(
      path.join(tmpDir, 'agentbootup.json'),
      JSON.stringify({ agent_id: 'mig.brain', type: 'service' }),
      'utf-8',
    );
    fs.mkdirSync(path.join(tmpDir, '.brain'), { recursive: true });
    const dbPath = path.join(tmpDir, '.brain', 'brain.db');
    const db = createClient({ url: `file:${dbPath}` });
    await db.executeMultiple(`
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
    await db.close();

    const { io, out, err } = captureIo();
    const code = await runBrainDbCommand(['migrate', '--cwd', tmpDir], io);
    expect(code).toBe(0);
    expect(out.some((l) => l.includes('brain-db migrate: done'))).toBe(true);

    const db2 = createClient({ url: `file:${dbPath}` });
    const ver = await db2.execute(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    );
    expect(ver.rows[0]?.value).toBe('4');
    await db2.close();
    expect(err.join('')).not.toContain('brain-db migrate failed');
  } finally {
    if (prev === undefined) delete process.env.AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP;
    else process.env.AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP = prev;
  }
});

test('brain-db status --json preserves JSON output on conflicting project identity', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-db-conflict-'));
  fs.writeFileSync(
    path.join(tmpDir, 'agentbootup.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
    'utf-8',
  );
  fs.mkdirSync(path.join(tmpDir, '.brain'), { recursive: true });
  const dbPath = path.join(tmpDir, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  await db.executeMultiple(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chunks (id TEXT PRIMARY KEY);
    CREATE TABLE skills (id TEXT PRIMARY KEY);
    CREATE TABLE skill_docs (id TEXT PRIMARY KEY);
    CREATE TABLE skill_index_state (path TEXT PRIMARY KEY);
    CREATE TABLE memory_events (id TEXT PRIMARY KEY);
    CREATE TABLE memory_pages (page_path TEXT PRIMARY KEY);
  `);
  await db.close();

  const { io, out, err } = captureIo();
  const code = await runBrainDbCommand(['status', '--json', '--cwd', tmpDir], io);

  expect(code).toBe(1);
  expect(err).toHaveLength(0);
  const payload = JSON.parse(out.join('\n'));
  expect(payload.error).toContain('agent_id');
  expect(payload.error).toContain('agentId');
  expect(payload.brain_db_path).toBe(dbPath);
});
