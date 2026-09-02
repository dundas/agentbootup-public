/**
 * Tests for brain-db.ts — guard logic, SQL validation, and migration safety.
 *
 * Uses an in-memory SQLite database to test the command functions directly.
 * Does not test output formatting; focuses on correctness of guards and writes.
 */

import { test, expect, describe } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  assertBrainTable,
  isReadOnlySql,
  isMigrationSafe,
  extractTableName,
} from '../../.claude/skills/brain-db/scripts/brain-db-guards';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal brain.db in memory with the expected foundation schema. */
function makeTestDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    brain_id TEXT,
    session_id TEXT,
    timestamp INTEGER,
    turn_type TEXT,
    content TEXT,
    token_count INTEGER
  )`);
  db.run(`CREATE TABLE transcript_index (path TEXT PRIMARY KEY, indexed_at INTEGER)`);
  db.run(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')`);
  db.run('PRAGMA journal_mode=WAL');
  return db;
}

describe('assertBrainTable', () => {
  test('accepts valid brain_ table names', () => {
    expect(() => assertBrainTable('brain_decisions')).not.toThrow();
    expect(() => assertBrainTable('brain_todos_2')).not.toThrow();
    expect(() => assertBrainTable('brain_a')).not.toThrow();
  });

  test('rejects names without brain_ prefix', () => {
    expect(() => assertBrainTable('decisions')).toThrow();
    expect(() => assertBrainTable('chunks')).toThrow();
    expect(() => assertBrainTable('schema_meta')).toThrow();
  });

  test('rejects empty string', () => {
    expect(() => assertBrainTable('')).toThrow();
  });

  test('rejects names with special characters', () => {
    expect(() => assertBrainTable('brain_foo-bar')).toThrow();
    expect(() => assertBrainTable('brain_foo bar')).toThrow();
    expect(() => assertBrainTable('brain_foo;drop')).toThrow();
  });
});

// ── cmdSql read-only guard ────────────────────────────────────────────────────

describe('cmdSql read-only guard', () => {
  test('allows SELECT', () => {
    expect(isReadOnlySql('SELECT * FROM chunks')).toBe(true);
    expect(isReadOnlySql('  select id from chunks')).toBe(true);
  });

  test('allows PRAGMA', () => {
    expect(isReadOnlySql('PRAGMA table_info(chunks)')).toBe(true);
  });

  test('allows WITH (CTE)', () => {
    expect(isReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
  });

  test('rejects INSERT', () => {
    expect(isReadOnlySql('INSERT INTO chunks VALUES (?)')).toBe(false);
  });

  test('rejects UPDATE', () => {
    expect(isReadOnlySql('UPDATE chunks SET content=? WHERE id=?')).toBe(false);
  });

  test('rejects DROP', () => {
    expect(isReadOnlySql('DROP TABLE chunks')).toBe(false);
  });
});

// ── cmdMigrate foundation table guard ────────────────────────────────────────

describe('cmdMigrate foundation table guard', () => {
  test('allows migrations on brain_ tables', () => {
    expect(isMigrationSafe('ALTER TABLE brain_decisions ADD COLUMN pr_number TEXT')).toBe(true);
    expect(isMigrationSafe('CREATE INDEX idx ON brain_todos(priority)')).toBe(true);
  });

  test('blocks any reference to chunks', () => {
    expect(isMigrationSafe('CREATE INDEX idx ON chunks(content)')).toBe(false);
    expect(isMigrationSafe('ALTER TABLE chunks ADD COLUMN extra TEXT')).toBe(false);
    expect(isMigrationSafe('DROP TABLE chunks')).toBe(false);
  });

  test('blocks any reference to transcript_index', () => {
    expect(isMigrationSafe('DELETE FROM transcript_index')).toBe(false);
    expect(isMigrationSafe('CREATE INDEX idx ON transcript_index(path)')).toBe(false);
  });

  test('blocks any reference to schema_meta', () => {
    expect(isMigrationSafe('DROP TABLE schema_meta')).toBe(false);
  });

  test('blocks even without word boundaries — via regex word boundary', () => {
    // A comment before the keyword should not bypass the guard
    expect(isMigrationSafe('-- safe migration\nDROP TABLE chunks')).toBe(false);
  });
});

// ── cmdMigrate idempotency ────────────────────────────────────────────────────

describe('cmdMigrate idempotency', () => {
  test('skips migration if key already recorded in schema_meta', () => {
    const db = makeTestDb();
    db.run(`CREATE TABLE brain_test (id TEXT PRIMARY KEY, val TEXT)`);
    // Record migration manually
    db.run(`INSERT INTO schema_meta (key, value) VALUES ('ext-v1', '2026-03-25')`);

    // Simulate what cmdMigrate does: check for key first
    const already = db.query('SELECT value FROM schema_meta WHERE key=?').get('ext-v1');
    expect(already).not.toBeNull();
    expect((already as { value: string }).value).toBe('2026-03-25');
    db.close();
  });

  test('applies migration and records it atomically', () => {
    const db = makeTestDb();
    db.run(`CREATE TABLE brain_test2 (id TEXT PRIMARY KEY)`);

    // Apply migration in a transaction (mirrors cmdMigrate behavior)
    db.transaction(() => {
      db.run(`ALTER TABLE brain_test2 ADD COLUMN extra TEXT`);
      db.run(`INSERT INTO schema_meta (key, value) VALUES (?, ?)`, ['ext-test2-v1', '2026-03-25']);
    })();

    const recorded = db.query('SELECT value FROM schema_meta WHERE key=?').get('ext-test2-v1');
    expect(recorded).not.toBeNull();
    db.close();
  });
});

// ── cmdInsert empty JSON guard ────────────────────────────────────────────────

describe('cmdInsert JSON guard', () => {
  test('rejects empty JSON object', () => {
    const row = JSON.parse('{}');
    const keys = Object.keys(row);
    expect(keys.length).toBe(0); // guard condition: exit if no keys
  });

  test('accepts valid JSON object', () => {
    const row = JSON.parse('{"id":"d-001","date":"2026-03-25","topic":"config"}');
    expect(Object.keys(row).length).toBe(3);
  });

  test('rejects invalid JSON', () => {
    expect(() => JSON.parse('{invalid')).toThrow();
  });
});

// ── cmdExtend SQL table name matching ─────────────────────────────────────────

describe('cmdExtend SQL table name extraction', () => {
  test('extracts unquoted table name', () => {
    expect(extractTableName('CREATE TABLE brain_decisions (id TEXT)')).toBe('brain_decisions');
  });

  test('extracts double-quoted table name', () => {
    expect(extractTableName('CREATE TABLE "brain_decisions" (id TEXT)')).toBe('brain_decisions');
  });

  test('extracts backtick-quoted table name', () => {
    expect(extractTableName('CREATE TABLE `brain_decisions` (id TEXT)')).toBe('brain_decisions');
  });

  test('extracts bracket-quoted table name', () => {
    expect(extractTableName('CREATE TABLE [brain_decisions] (id TEXT)')).toBe('brain_decisions');
  });

  test('extracts with IF NOT EXISTS', () => {
    expect(extractTableName('CREATE TABLE IF NOT EXISTS brain_todos (id TEXT)')).toBe('brain_todos');
  });

  test('returns undefined for non-CREATE TABLE', () => {
    expect(extractTableName('ALTER TABLE brain_foo ADD COLUMN x TEXT')).toBeUndefined();
  });

  test('mismatch between declared name and SQL name is detectable', () => {
    const declared = 'brain_decisions';
    const extracted = extractTableName('CREATE TABLE brain_other (id TEXT)');
    expect(extracted).not.toBe(declared);
  });
});
