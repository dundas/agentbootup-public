/**
 * Tests for BrainDbTranscriptBackend and detectBrainDb in the transcript-query skill.
 *
 * Uses bun:sqlite in-memory databases — hermetic, no disk I/O.
 */

import { test, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrainDbTranscriptBackend, detectBrainDb, openBrainDb } from '../../lib/brain/transcript-query-backend.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create an in-memory brain.db with the v2 schema (chunks + FTS5). */
function makeTestDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_meta VALUES ('schema_version', '2');

    CREATE TABLE IF NOT EXISTS chunks (
      id          TEXT PRIMARY KEY,
      brain_id    TEXT,
      session_id  TEXT NOT NULL,
      project     TEXT,
      timestamp   INTEGER,
      turn_type   TEXT,
      content     TEXT NOT NULL DEFAULT '',
      token_count INTEGER DEFAULT 0,
      embedding   BLOB,
      syncable    INTEGER NOT NULL DEFAULT 0,
      chunk_meta  TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      content='chunks',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
  return db;
}

/** Insert a chunk row into the test db. */
function insertChunk(db: Database, opts: {
  id: string;
  sessionId: string;
  brainId?: string;
  project?: string;
  timestamp?: number;
  content: string;
}) {
  db.prepare(`
    INSERT INTO chunks (id, brain_id, session_id, project, timestamp, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.brainId ?? 'test-brain',
    opts.sessionId,
    opts.project ?? 'test-project',
    opts.timestamp ?? Date.now(),
    opts.content,
  );
}

// ── BrainDbTranscriptBackend.search() ─────────────────────────────────────────

describe('BrainDbTranscriptBackend.search()', () => {
  test('returns matching chunks for a keyword', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'authentication refactoring complete' });
    insertChunk(db, { id: 'c2', sessionId: 's2', content: 'deploy to production environment' });

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.search('authentication', null);
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('s1');
    backend.close();
  });

  test('returns empty array when no keyword matches', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'some unrelated content here' });

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.search('authentication', null);
    expect(rows).toEqual([]);
    backend.close();
  });

  test('FTS special chars in keyword are escaped (phrase-quoted)', () => {
    const db = makeTestDb();
    // OR is a FTS5 operator — without quoting it would be a syntax error or
    // match differently. With phrase-quoting, "foo OR bar" is a 3-word phrase.
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'fix: handle foo OR bar correctly' });
    insertChunk(db, { id: 'c2', sessionId: 's2', content: 'only foo present here' });

    const backend = new BrainDbTranscriptBackend(db);
    // Should not throw — FTS5 OR would be a syntax error without quoting
    expect(() => backend.search('foo OR bar', null)).not.toThrow();
    // Should not match the chunk that only contains 'foo' (phrase 'foo OR bar' not present)
    const rows = backend.search('foo OR bar', null);
    expect(rows.every((r: any) => r.session_id === 's1')).toBe(true);
    backend.close();
  });

  test('double-quotes in keyword are escaped correctly', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'said "hello world" to the user' });

    const backend = new BrainDbTranscriptBackend(db);
    // Should not throw even with embedded quotes
    expect(() => backend.search('say "hello"', null)).not.toThrow();
    backend.close();
  });

  test('brain_id filter isolates results by tenant', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', brainId: 'brain-a', content: 'authentication flow' });
    insertChunk(db, { id: 'c2', sessionId: 's2', brainId: 'brain-b', content: 'authentication bypass' });

    const backend = new BrainDbTranscriptBackend(db);
    const rowsA = backend.search('authentication', 'brain-a');
    expect(rowsA.length).toBe(1);
    expect(rowsA[0].session_id).toBe('s1');

    const rowsB = backend.search('authentication', 'brain-b');
    expect(rowsB.length).toBe(1);
    expect(rowsB[0].session_id).toBe('s2');
    backend.close();
  });

  test('respects limit option', () => {
    const db = makeTestDb();
    for (let i = 0; i < 10; i++) {
      insertChunk(db, { id: `c${i}`, sessionId: `s${i}`, content: `authentication step ${i}` });
    }

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.search('authentication', null, { limit: 3 });
    expect(rows.length).toBe(3);
    backend.close();
  });

  test('since filter excludes chunks before the date', () => {
    const db = makeTestDb();
    const past   = new Date('2026-01-01').getTime();
    const recent = new Date('2026-03-01').getTime();
    insertChunk(db, { id: 'c1', sessionId: 's1', timestamp: past,   content: 'authentication old event' });
    insertChunk(db, { id: 'c2', sessionId: 's2', timestamp: recent, content: 'authentication new event' });

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.search('authentication', null, { since: '2026-02-01' });
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('s2');
    backend.close();
  });

  test('until filter excludes chunks after the date', () => {
    const db = makeTestDb();
    const past   = new Date('2026-01-15').getTime();
    const future = new Date('2026-04-01').getTime();
    insertChunk(db, { id: 'c1', sessionId: 's1', timestamp: past,   content: 'authentication early' });
    insertChunk(db, { id: 'c2', sessionId: 's2', timestamp: future, content: 'authentication later' });

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.search('authentication', null, { until: '2026-02-01' });
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('s1');
    backend.close();
  });

  test('since and until together form a date window', () => {
    const db = makeTestDb();
    const before = new Date('2026-01-01').getTime();
    const inside = new Date('2026-03-01').getTime();
    const after  = new Date('2026-05-01').getTime();
    insertChunk(db, { id: 'c1', sessionId: 's1', timestamp: before, content: 'authentication before window' });
    insertChunk(db, { id: 'c2', sessionId: 's2', timestamp: inside, content: 'authentication inside window' });
    insertChunk(db, { id: 'c3', sessionId: 's3', timestamp: after,  content: 'authentication after window' });

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.search('authentication', null, { since: '2026-02-01', until: '2026-04-01' });
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('s2');
    backend.close();
  });

  test('invalid since/until strings are silently ignored', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'authentication test' });

    const backend = new BrainDbTranscriptBackend(db);
    expect(() => backend.search('authentication', null, { since: 'not-a-date', until: 'also-bad' })).not.toThrow();
    const rows = backend.search('authentication', null, { since: 'not-a-date', until: 'also-bad' });
    expect(rows.length).toBe(1); // filters not applied, result returned
    backend.close();
  });

  test('multi-word keyword uses phrase semantics (words must be adjacent)', () => {
    // Documents the FTS5 phrase-query behavior: "authentication refactor" only
    // matches chunks where those words appear adjacent and in order.
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'authentication refactor is complete' });
    insertChunk(db, { id: 'c2', sessionId: 's2', content: 'authentication and later refactor' }); // non-adjacent

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.search('authentication refactor', null);
    // Only c1 matches: words are adjacent
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('s1');
    backend.close();
  });
});

// ── BrainDbTranscriptBackend.listSessions() ───────────────────────────────────

describe('BrainDbTranscriptBackend.listSessions()', () => {
  test('groups chunks into sessions with aggregate counts', () => {
    const db = makeTestDb();
    const ts = Date.now();
    insertChunk(db, { id: 'c1', sessionId: 'session-a', timestamp: ts,     content: 'first chunk' });
    insertChunk(db, { id: 'c2', sessionId: 'session-a', timestamp: ts + 1, content: 'second chunk' });
    insertChunk(db, { id: 'c3', sessionId: 'session-b', timestamp: ts + 2, content: 'other session' });

    const backend = new BrainDbTranscriptBackend(db);
    const sessions = backend.listSessions(null);
    expect(sessions.length).toBe(2);
    type SessionRow = { session_id: string; chunk_count: number };
    const sessA = sessions.find((s) => (s as SessionRow).session_id === 'session-a') as SessionRow | undefined;
    expect(sessA).toBeDefined();
    expect(sessA!.chunk_count).toBe(2);
    backend.close();
  });

  test('brain_id filter only returns matching tenant sessions', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 'sa', brainId: 'b1', content: 'x' });
    insertChunk(db, { id: 'c2', sessionId: 'sb', brainId: 'b2', content: 'y' });

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.listSessions('b1');
    expect(rows.length).toBe(1);
    expect((rows[0] as { session_id: string }).session_id).toBe('sa');
    backend.close();
  });

  test('returns empty array when no sessions exist', () => {
    const db = makeTestDb();
    const backend = new BrainDbTranscriptBackend(db);
    expect(backend.listSessions(null)).toEqual([]);
    backend.close();
  });

  test('limit option restricts number of sessions returned', () => {
    const db = makeTestDb();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      insertChunk(db, { id: `c${i}`, sessionId: `sess-${i}`, timestamp: now + i, content: 'content' });
    }
    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.listSessions(null, { limit: 2 });
    expect(rows.length).toBe(2);
    backend.close();
  });

  test('since filter excludes sessions before the date', () => {
    const db = makeTestDb();
    const past = new Date('2026-01-01').getTime();
    const recent = new Date('2026-03-01').getTime();
    insertChunk(db, { id: 'c1', sessionId: 'old', timestamp: past,   content: 'old session' });
    insertChunk(db, { id: 'c2', sessionId: 'new', timestamp: recent, content: 'new session' });

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.listSessions(null, { since: '2026-02-01' });
    expect(rows.length).toBe(1);
    expect((rows[0] as { session_id: string }).session_id).toBe('new');
    backend.close();
  });

  test('invalid since date string is silently ignored (isNaN guard)', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'any content' });

    const backend = new BrainDbTranscriptBackend(db);
    // Should not throw — invalid date is skipped, all sessions returned
    expect(() => backend.listSessions(null, { since: 'not-a-date' })).not.toThrow();
    const rows = backend.listSessions(null, { since: 'not-a-date' });
    expect(rows.length).toBe(1); // filter not applied, all sessions returned
    backend.close();
  });
});

// ── BrainDbTranscriptBackend.getSession() ─────────────────────────────────────

describe('BrainDbTranscriptBackend.getSession()', () => {
  test('returns all chunks for a session ordered by timestamp', () => {
    const db = makeTestDb();
    const base = Date.now();
    insertChunk(db, { id: 'c1', sessionId: 'target-session', timestamp: base + 2, content: 'second' });
    insertChunk(db, { id: 'c2', sessionId: 'target-session', timestamp: base,     content: 'first'  });
    insertChunk(db, { id: 'c3', sessionId: 'other-session',  timestamp: base + 1, content: 'other'  });

    const backend = new BrainDbTranscriptBackend(db);
    const chunks = backend.getSession('target-session');
    expect(chunks.length).toBe(2);
    // Ordered by timestamp ascending
    expect(chunks[0].id).toBe('c2');
    expect(chunks[1].id).toBe('c1');
    backend.close();
  });

  test('returns empty array when session does not exist', () => {
    const db = makeTestDb();
    const backend = new BrainDbTranscriptBackend(db);
    expect(backend.getSession('nonexistent')).toEqual([]);
    backend.close();
  });
});

// ── Shared vector test helpers ────────────────────────────────────────────────

/** Make a unit-normalised Float32Array of given values. */
function makeVec(values: number[]): Float32Array {
  const v = new Float32Array(values);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ── BrainDbTranscriptBackend.vectorSearch() ───────────────────────────────────

describe('BrainDbTranscriptBackend.vectorSearch()', () => {
  const DIM = 4; // small dimension for tests

  /** Insert a chunk with an explicit embedding BLOB. */
  function insertWithEmbedding(db: Database, id: string, sessionId: string, content: string, vec: Float32Array, opts: { timestamp?: number } = {}) {
    db.prepare(`
      INSERT INTO chunks (id, brain_id, session_id, project, timestamp, content, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'test-brain', sessionId, 'proj', opts.timestamp ?? Date.now(), content, vecToBuffer(vec));
  }

  test('returns top-K results ranked by cosine similarity', () => {
    const db = makeTestDb();
    // vec A is close to query, vec B is orthogonal
    const query = makeVec([1, 0, 0, 0]);
    const vecA  = makeVec([0.9, 0.1, 0, 0]);  // high similarity
    const vecB  = makeVec([0, 1, 0, 0]);       // orthogonal — low similarity

    insertWithEmbedding(db, 'c1', 's1', 'close chunk', vecA);
    insertWithEmbedding(db, 'c2', 's2', 'far chunk',   vecB);

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.vectorSearch(query, null, { limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows[0].session_id).toBe('s1');  // closest first
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    backend.close();
  });

  test('respects limit', () => {
    const db = makeTestDb();
    const query = makeVec([1, 0, 0, 0]);
    for (let i = 0; i < 5; i++) {
      insertWithEmbedding(db, `c${i}`, `s${i}`, `chunk ${i}`, makeVec([1 - i * 0.1, i * 0.1, 0, 0]));
    }
    const backend = new BrainDbTranscriptBackend(db);
    expect(backend.vectorSearch(query, null, { limit: 3 }).length).toBe(3);
    backend.close();
  });

  test('since/until filter applied before cosine ranking', () => {
    const db = makeTestDb();
    const query = makeVec([1, 0, 0, 0]);
    const past   = new Date('2026-01-01').getTime();
    const recent = new Date('2026-03-01').getTime();
    const nearVec = makeVec([0.99, 0.01, 0, 0]);

    insertWithEmbedding(db, 'c1', 'old',    'old chunk',    nearVec, { timestamp: past });
    insertWithEmbedding(db, 'c2', 'recent', 'recent chunk', nearVec, { timestamp: recent });

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.vectorSearch(query, null, { since: '2026-02-01' });
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('recent');
    backend.close();
  });

  test('chunks without embedding are excluded', () => {
    const db = makeTestDb();
    const query = makeVec([1, 0, 0, 0]);
    // Insert one chunk with embedding, one without
    insertWithEmbedding(db, 'c1', 's1', 'has embedding', makeVec([1, 0, 0, 0]));
    insertChunk(db, { id: 'c2', sessionId: 's2', content: 'no embedding' });

    const backend = new BrainDbTranscriptBackend(db);
    const rows = backend.vectorSearch(query, null);
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('s1');
    backend.close();
  });

  test('returns empty array when no embeddings exist', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'no embedding here' });
    const backend = new BrainDbTranscriptBackend(db);
    expect(backend.vectorSearch(new Float32Array(DIM), null)).toEqual([]);
    backend.close();
  });
});

// ── BrainDbTranscriptBackend.hasEmbeddings() ──────────────────────────────────

describe('BrainDbTranscriptBackend.hasEmbeddings()', () => {
  test('returns false when no embeddings stored', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'no embedding' });
    const backend = new BrainDbTranscriptBackend(db);
    expect(backend.hasEmbeddings()).toBe(false);
    backend.close();
  });

  test('returns true when at least one embedding exists', () => {
    const db = makeTestDb();
    insertChunk(db, { id: 'c1', sessionId: 's1', content: 'with embedding' });
    const vec = new Float32Array([1, 0, 0, 0]);
    db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(vecToBuffer(vec), 'c1');
    const backend = new BrainDbTranscriptBackend(db);
    expect(backend.hasEmbeddings()).toBe(true);
    backend.close();
  });
});

// ── detectBrainDb() ───────────────────────────────────────────────────────────

describe('detectBrainDb()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-detect-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns available=false when no brain.db exists', () => {
    const result = detectBrainDb(tmpDir);
    expect(result.available).toBe(false);
  });

  test('returns available=false when brain.db exists but has no chunks_fts table', () => {
    // Schema v1 — no FTS table
    const brainDir = path.join(tmpDir, '.brain');
    fs.mkdirSync(brainDir);
    const db = new Database(path.join(brainDir, 'brain.db'));
    db.exec('CREATE TABLE chunks (id TEXT PRIMARY KEY, content TEXT)');
    db.close();

    const result = detectBrainDb(tmpDir);
    expect(result.available).toBe(false);
  });

  test('returns available=true when brain.db has chunks_fts table', () => {
    const brainDir = path.join(tmpDir, '.brain');
    fs.mkdirSync(brainDir);
    const db = new Database(path.join(brainDir, 'brain.db'));
    db.exec(`
      CREATE TABLE chunks (id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '');
      CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='rowid');
    `);
    db.close();

    const result = detectBrainDb(tmpDir);
    expect(result.available).toBe(true);
    expect(result.dbPath).toContain('brain.db');
  });
});

// ── BrainDbTranscriptBackend constructor ─────────────────────────────────────

describe('BrainDbTranscriptBackend constructor', () => {
  test('throws TypeError when db is null', () => {
    expect(() => new BrainDbTranscriptBackend(null as any)).toThrow(TypeError);
  });

  test('throws TypeError when db is undefined', () => {
    expect(() => new BrainDbTranscriptBackend(undefined as any)).toThrow(TypeError);
  });
});

// ── openBrainDb() ─────────────────────────────────────────────────────────────

describe('openBrainDb()', () => {
  test('returns null for a non-existent path', () => {
    // Suppress expected stderr error message from openBrainDb
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = openBrainDb('/non/existent/path/brain.db');
    spy.mockRestore();
    expect(result).toBeNull();
  });

  test('returns Database for a valid path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-open-test-'));
    const dbPath = path.join(tmpDir, 'brain.db');
    // Create a valid (empty) sqlite file
    const db = new Database(dbPath);
    db.close();

    const result = openBrainDb(dbPath);
    expect(result).not.toBeNull();
    result!.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
