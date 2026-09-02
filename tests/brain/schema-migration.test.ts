/**
 * Tests for templates/brain/brain-schema.sql (v4) and runMigrations() in brain-db-sync.mjs.
 *
 * Uses an in-memory libsql client so tests are hermetic and fast.
 */

import { test, expect, describe } from 'bun:test';
import { createClient } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../templates/brain/brain-schema.sql');

function makeDb() {
  return createClient({ url: 'file::memory:' });
}

async function applyFullSchema(db: ReturnType<typeof createClient>) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  await db.executeMultiple(sql);
}

async function getTableNames(db: ReturnType<typeof createClient>): Promise<string[]> {
  const result = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  return result.rows.map((r) => r.name as string);
}

async function getColumnNames(db: ReturnType<typeof createClient>, table: string): Promise<string[]> {
  const result = await db.execute(`PRAGMA table_info(${table})`);
  return result.rows.map((r) => r.name as string);
}

async function getSchemaVersion(db: ReturnType<typeof createClient>): Promise<string> {
  const result = await db.execute(
    "SELECT value FROM schema_meta WHERE key = 'schema_version'",
  );
  return (result.rows[0]?.value as string) ?? '0';
}

describe('schema v4 DDL (brain-schema.sql template)', () => {
  test('applies cleanly to a fresh database', async () => {
    const db = makeDb();
    await expect(applyFullSchema(db)).resolves.toBeUndefined();
    await db.close();
  });

  test('chunks table has v2+ columns and 384-dim embedding', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    const cols = await getColumnNames(db, 'chunks');
    expect(cols).toContain('chunk_meta');
    expect(cols).toContain('syncable');
    expect(cols).toContain('embedding');
    await db.close();
  });

  test('syncable defaults to 0', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    await db.execute({
      sql: `INSERT INTO chunks (id, brain_id, project, session_id, timestamp, content)
            VALUES ('test-1', 'bootup.gm', 'proj', 'sess-1', 1000, 'hello')`,
    });
    const result = await db.execute('SELECT syncable FROM chunks WHERE id = ?', ['test-1']);
    expect(result.rows[0]?.syncable).toBe(0);
    await db.close();
  });

  test('transcript_index uses v3 column shape', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    const cols = await getColumnNames(db, 'transcript_index');
    expect(cols).toContain('content_hash');
    expect(cols).toContain('byte_offset');
    expect(cols).not.toContain('source_cli');
    await db.close();
  });

  test('skill registry tables exist', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    const tables = await getTableNames(db);
    expect(tables).toContain('skills');
    expect(tables).toContain('skill_docs');
    expect(tables).toContain('skill_index_state');
    await db.close();
  });

  test('canonical memory tables exist', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    const tables = await getTableNames(db);
    expect(tables).toContain('memory_events');
    expect(tables).toContain('memory_pages');
    await db.close();
  });

  test('FTS trigger: INSERT into chunks populates chunks_fts', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    await db.execute({
      sql: `INSERT INTO chunks (id, brain_id, project, session_id, timestamp, content)
            VALUES ('fts-1', 'bootup.gm', 'proj', 'sess-1', 1000, 'elephant in the room')`,
    });
    const result = await db.execute(
      "SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'elephant'",
    );
    expect(result.rows.length).toBe(1);
    await db.close();
  });

  test('FTS trigger: DELETE from chunks removes from chunks_fts', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    await db.execute({
      sql: `INSERT INTO chunks (id, brain_id, project, session_id, timestamp, content)
            VALUES ('fts-2', 'bootup.gm', 'proj', 'sess-1', 1000, 'delete me keyword')`,
    });
    await db.execute("DELETE FROM chunks WHERE id = 'fts-2'");
    const result = await db.execute(
      "SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'keyword'",
    );
    expect(result.rows.length).toBe(0);
    await db.close();
  });

  test('schema_meta reports version 4', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    const version = await getSchemaVersion(db);
    expect(version).toBe('4');
    await db.close();
  });

  test('applying schema twice is idempotent (IF NOT EXISTS)', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    await expect(applyFullSchema(db)).resolves.toBeUndefined();
    await db.close();
  });
});

const { runMigrations } = await import('../../lib/daemon/brain-db-sync.mjs');

describe('runMigrations()', () => {
  test('is a no-op on a fresh v4 database', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    await expect(runMigrations(db)).resolves.toBeUndefined();
    expect(await getSchemaVersion(db)).toBe('4');
    await db.close();
  });

  test('is idempotent — safe to call twice', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    await runMigrations(db);
    await expect(runMigrations(db)).resolves.toBeUndefined();
    await db.close();
  });

  test('upgrades a v3 database by adding canonical memory tables in place', async () => {
    const db = makeDb();
    await applyFullSchema(db);
    await db.executeMultiple(`
      INSERT INTO chunks (
        id, brain_id, project, session_id, timestamp, turn_type, content,
        embedding, token_count, chunk_meta, syncable
      ) VALUES (
        'c1', 'b.gm', 'p', 's', 1, 'assistant', 'keep-me',
        NULL, 0, '{}', 0
      );
      DROP TABLE memory_pages;
      DROP TABLE memory_events;
      DELETE FROM schema_meta WHERE key = 'memory_schema_version';
      UPDATE schema_meta SET value = '3' WHERE key = 'schema_version';
      UPDATE schema_meta SET value = '2026-07-11' WHERE key = 'updated_at';
    `);

    await runMigrations(db);

    expect(await getSchemaVersion(db)).toBe('4');
    const tables = await getTableNames(db);
    expect(tables).toContain('memory_events');
    expect(tables).toContain('memory_pages');
    const memorySchemaVersion = await db.execute(
      "SELECT value FROM schema_meta WHERE key = 'memory_schema_version'",
    );
    expect(memorySchemaVersion.rows[0]?.value).toBe('1');
    const chunk = await db.execute('SELECT content FROM chunks WHERE id = ?', ['c1']);
    expect(chunk.rows[0]?.content).toBe('keep-me');
    await db.close();
  });

  test('upgrades a v1 database: adds chunk_meta column and reaches v4', async () => {
    const db = makeDb();
    await db.executeMultiple(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        brain_id TEXT NOT NULL,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        turn_type TEXT,
        content TEXT NOT NULL,
        token_count INTEGER
      );
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('schema_version', '1');
      INSERT INTO schema_meta VALUES ('updated_at', '2026-03-15');
    `);

    await runMigrations(db);

    const cols = await getColumnNames(db, 'chunks');
    expect(cols).toContain('chunk_meta');
    expect(await getSchemaVersion(db)).toBe('4');
    const tables = await getTableNames(db);
    expect(tables).toContain('skills');
    expect(tables).toContain('skill_docs');
    expect(tables).toContain('memory_events');
    expect(tables).toContain('memory_pages');
    await db.close();
  });

  test('upgrades a v1 database: adds syncable column', async () => {
    const db = makeDb();
    await db.executeMultiple(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        brain_id TEXT NOT NULL,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('schema_version', '1');
    `);

    await runMigrations(db);

    const cols = await getColumnNames(db, 'chunks');
    expect(cols).toContain('syncable');
    expect(await getSchemaVersion(db)).toBe('4');
    await db.close();
  });

  test('preserves chunk content across v1→v4 chain', async () => {
    const db = makeDb();
    await db.executeMultiple(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        brain_id TEXT NOT NULL,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('schema_version', '1');
      INSERT INTO chunks VALUES ('c1', 'b.gm', 'p', 's', 1, 'preserve-me');
    `);

    await runMigrations(db);

    expect(await getSchemaVersion(db)).toBe('4');
    const r = await db.execute('SELECT content FROM chunks WHERE id = ?', ['c1']);
    expect(r.rows[0]?.content).toBe('preserve-me');
    await db.close();
  });

  test('handles missing schema_meta gracefully (very old instance)', async () => {
    const db = makeDb();
    await db.executeMultiple(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY, brain_id TEXT NOT NULL, project TEXT NOT NULL,
        session_id TEXT NOT NULL, timestamp INTEGER NOT NULL, content TEXT NOT NULL
      );
    `);

    await expect(runMigrations(db)).resolves.toBeUndefined();
    await db.close();
  });

  test('migrates v2 transcript_index (source_cli shape) to v4 columns', async () => {
    const db = makeDb();
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
      CREATE TABLE transcript_index (
        source_path TEXT PRIMARY KEY,
        source_cli TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_byte_offset INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL
      );
      INSERT INTO transcript_index VALUES ('/tmp/x.jsonl', 'claude', 'sess-9', 99, 2, 5000);
    `);

    await runMigrations(db);

    expect(await getSchemaVersion(db)).toBe('4');
    const r = await db.execute(
      'SELECT content_hash, byte_offset, session_id FROM transcript_index WHERE source_path = ?',
      ['/tmp/x.jsonl'],
    );
    expect(r.rows[0]?.content_hash).toBe('migrated-v2');
    expect(r.rows[0]?.byte_offset).toBe(99);
    expect(r.rows[0]?.session_id).toBe('sess-9');
    await db.close();
  });
});
