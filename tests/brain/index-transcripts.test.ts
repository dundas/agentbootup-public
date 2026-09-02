/**
 * Tests for lib/brain/index-transcripts.js
 *
 * All tests are hermetic — use in-memory bun:sqlite and tmp dirs.
 * No network, no real transcript dirs required.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { Database } from 'bun:sqlite';

import {
  discoverTranscripts,
  getIndexState,
  readNewLines,
  indexFile,
  resolveIndexTargetIdentity,
  hasCanonicalTranscriptIndexSchema,
  ensureCanonicalTranscriptFtsIndex,
} from '../../lib/brain/index-transcripts.js';
import { encodeProjectPath } from '../../lib/brain/project-path.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function tmpDir() {
  const d = path.join(os.tmpdir(), `idx-test-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeDb(schemaPath?: string): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  // Minimal schema needed by index-transcripts
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
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
    CREATE TABLE IF NOT EXISTS transcript_index (
      source_path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL,
      session_id TEXT,
      project TEXT,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      project,
      session_id,
      content='chunks',
      content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END;
  `);
  return db;
}

function makePersistentFtsDb(dbPath: string): InstanceType<typeof Database> {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, brain_id TEXT NOT NULL, project TEXT NOT NULL,
      session_id TEXT NOT NULL, timestamp INTEGER NOT NULL, turn_type TEXT,
      content TEXT NOT NULL, token_count INTEGER, embedding BLOB, chunk_meta TEXT,
      syncable INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE transcript_index (
      source_path TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER NOT NULL,
      session_id TEXT, project TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content, project, session_id, content='chunks', content_rowid='rowid'
    );
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END;
  `);
  return db;
}

/** Write a minimal Claude JSONL line. */
function jsonlLine(role: string, text: string, ts?: string): string {
  const msg = {
    role,
    content: [{ type: 'text', text }],
    usage: role === 'assistant' ? { input_tokens: 10, output_tokens: 5 } : undefined,
  };
  return JSON.stringify({
    message: msg,
    timestamp: ts ?? new Date().toISOString(),
  });
}

// ── discoverTranscripts ────────────────────────────────────────────────────

describe('discoverTranscripts', () => {
  let home: string;

  beforeEach(() => { home = tmpDir(); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const discover = (opts = {}) => discoverTranscripts({ homeDir: home, ...opts });

  test('returns empty array when no CLI dirs exist', () => {
    expect(discover()).toEqual([]);
  });

  test('discovers Claude transcripts', () => {
    // Claude Code stores transcripts flat in the project dir (not in a memory/ subdir).
    const projDir = path.join(home, '.claude', 'projects', 'my-project');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'sess-abc.jsonl'), jsonlLine('user', 'hello'));

    const results = discover();
    expect(results.length).toBe(1);
    expect(results[0].sourceCli).toBe('claude');
    expect(results[0].sessionId).toBe('sess-abc');
    expect(results[0].project).toBe('my-project');
  });

  test('discovers Cursor transcripts', () => {
    const agentDir = path.join(home, '.cursor', 'projects', 'cursor-proj', 'agent-transcripts');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'cursor-sess.jsonl'), jsonlLine('user', 'hi'));

    const results = discover();
    expect(results.length).toBe(1);
    expect(results[0].sourceCli).toBe('cursor');
  });

  test('discovers Gemini transcripts', () => {
    const histDir = path.join(home, '.gemini', 'history', 'gemini-proj');
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, 'gem-sess.jsonl'), jsonlLine('user', 'gemini'));

    const results = discover();
    expect(results.length).toBe(1);
    expect(results[0].sourceCli).toBe('gemini');
  });

  test('skips claude subagents/ path segment', () => {
    // The glob only reads files directly in the project dir, not recursively.
    // To test the subagents/ filter, we create a structure where sourcePath contains /subagents/
    // by putting a project named "subagents" — the filter checks the path string.
    const projDir = path.join(home, '.claude', 'projects', 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'main-sess.jsonl'), jsonlLine('user', 'main'));

    // Create a sibling project literally named "subagents" — the filter should exclude it
    // because its path contains /subagents/ as a segment.
    const subagentProj = path.join(home, '.claude', 'projects', 'subagents');
    fs.mkdirSync(subagentProj, { recursive: true });
    fs.writeFileSync(path.join(subagentProj, 'child.jsonl'), jsonlLine('user', 'child'));

    const results = discover();
    const paths = results.map((r) => r.sourcePath);
    // child.jsonl path includes /subagents/ — should be filtered out
    expect(paths.some((p) => p.endsWith('child.jsonl'))).toBe(false);
    expect(paths.some((p) => p.endsWith('main-sess.jsonl'))).toBe(true);
  });

  test('maxSessions caps result count', () => {
    const projDir = path.join(home, '.claude', 'projects', 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(projDir, `sess-${i}.jsonl`), jsonlLine('user', `msg ${i}`));
    }

    const results = discover({ maxSessions: 2 });
    expect(results.length).toBe(2);
  });

  test('maxAgeDays filters old files', () => {
    const projDir = path.join(home, '.claude', 'projects', 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    const newFile = path.join(projDir, 'new-sess.jsonl');
    const oldFile = path.join(projDir, 'old-sess.jsonl');
    fs.writeFileSync(newFile, jsonlLine('user', 'new'));
    fs.writeFileSync(oldFile, jsonlLine('user', 'old'));

    // Make old-sess.jsonl appear 10 days old
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    const results = discover({ maxAgeDays: 5 });
    expect(results.every((r) => !r.sourcePath.includes('old-sess'))).toBe(true);
    expect(results.some((r) => r.sourcePath.includes('new-sess'))).toBe(true);
  });

  test('non-.jsonl files are not discovered', () => {
    const projDir = path.join(home, '.claude', 'projects', 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'notes.txt'), 'not a transcript');
    fs.writeFileSync(path.join(projDir, 'data.json'), '{}');

    expect(discover()).toEqual([]);
  });
});

// ── getIndexState ──────────────────────────────────────────────────────────

describe('getIndexState', () => {
  test('returns offset 0 for new file', () => {
    const db = makeDb();
    const state = getIndexState(db, '/path/to/new.jsonl');
    expect(state.lastByteOffset).toBe(0);
    expect(state.chunkCount).toBe(0);
    db.close();
  });

  test('returns stored offset after insert', () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO transcript_index (source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count, last_error)
      VALUES ('/path/to/file.jsonl', 'abc', 512, 1000, 'sess-1', 'proj', 3, NULL)
    `);
    const state = getIndexState(db, '/path/to/file.jsonl');
    expect(state.lastByteOffset).toBe(512);
    expect(state.chunkCount).toBe(3);
    db.close();
  });
});

// ── readNewLines ───────────────────────────────────────────────────────────

describe('readNewLines', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('reads entire file when offset is 0', () => {
    const p = path.join(dir, 'a.jsonl');
    fs.writeFileSync(p, 'line1\nline2\n');
    const { newContent, newByteOffset } = readNewLines(p, 0);
    expect(newContent).toContain('line1');
    expect(newContent).toContain('line2');
    expect(newByteOffset).toBe(fs.statSync(p).size);
  });

  test('reads only new bytes after offset', () => {
    const p = path.join(dir, 'b.jsonl');
    const first = 'line1\n';
    fs.writeFileSync(p, first);
    const offset1 = Buffer.byteLength(first);

    // Append more content
    fs.appendFileSync(p, 'line2\n');

    const { newContent, newByteOffset } = readNewLines(p, offset1);
    expect(newContent.trim()).toBe('line2');
    expect(newByteOffset).toBeGreaterThan(offset1);
  });

  test('returns empty string when no new bytes', () => {
    const p = path.join(dir, 'c.jsonl');
    fs.writeFileSync(p, 'hello\n');
    const size = fs.statSync(p).size;
    const { newContent } = readNewLines(p, size);
    expect(newContent).toBe('');
  });

  test('resets to 0 when file is shorter than offset (truncation)', () => {
    const p = path.join(dir, 'd.jsonl');
    fs.writeFileSync(p, 'short\n');
    // Tell it we already read 9999 bytes (impossible — file is tiny)
    const { newContent, newByteOffset } = readNewLines(p, 9999);
    // Should reset to 0 and read the whole file
    expect(newContent).toContain('short');
    expect(newByteOffset).toBe(fs.statSync(p).size);
  });

  test('returns empty content for missing file', () => {
    const { newContent } = readNewLines('/nonexistent/path/file.jsonl', 0);
    expect(newContent).toBe('');
  });
});

// ── indexFile ──────────────────────────────────────────────────────────────

describe('indexFile', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeTranscript(name: string, lines: string[]): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return p;
  }

  test('fails closed with brain-db migrate guidance when FTS schema objects are missing', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY, brain_id TEXT NOT NULL, project TEXT NOT NULL,
        session_id TEXT NOT NULL, timestamp INTEGER NOT NULL, content TEXT NOT NULL
      );
      CREATE TABLE transcript_index (
        source_path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, byte_offset INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL, session_id TEXT, project TEXT, chunk_count INTEGER NOT NULL, last_error TEXT
      );
    `);
    const p = writeTranscript('missing-fts.jsonl', [jsonlLine('user', 'must not index')]);
    await expect(indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    })).rejects.toThrow(/chunks_fts.*brain-db migrate/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM chunks').get()).toEqual({ count: 0 });
    db.close();
  });

  test('fails closed when named FTS objects have non-canonical definitions', () => {
    const db = makeDb();
    db.exec('DROP TRIGGER chunks_ad');
    db.exec(`CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.rowid;
    END`);
    expect(() => ensureCanonicalTranscriptFtsIndex(db, { brainId: 'b.gm' }))
      .toThrow(/non-canonical remove.*brain-db migrate/i);
    db.close();
  });

  test('fails closed when a superficially similar FTS table is not external-content canonical', () => {
    const db = makeDb();
    db.exec('DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au; DROP TABLE chunks_fts');
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content, project, session_id, content='some_other_table', content_rowid='rowid'
    )`);
    db.exec(`CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END`);
    expect(() => ensureCanonicalTranscriptFtsIndex(db, { brainId: 'b.gm' }))
      .toThrow(/non-canonical ftstable.*brain-db migrate/i);
    db.close();
  });

  test('rebuilds an empty external-content FTS index before persistent indexing', async () => {
    const db = makeDb();
    db.exec(`INSERT INTO chunks (id, brain_id, project, session_id, timestamp, content, syncable)
      VALUES ('existing', 'b.gm', 'proj', 'old', 1, 'already indexed after rebuild', 0)`);
    db.exec('DROP TRIGGER chunks_ai');
    db.exec(`DELETE FROM chunks_fts`);
    db.exec(`CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END`);
    const p = writeTranscript('stale-fts.jsonl', [jsonlLine('user', 'new searchable transcript')]);

    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });

    expect(db.prepare("SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'already'").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'searchable'").get())
      .toEqual({ count: 1 });
    db.close();
  });

  test('persistent indexFile repair survives reopen with old and new terms searchable', async () => {
    const dbPath = path.join(dir, 'persistent-stale-fts.db');
    const setup = makePersistentFtsDb(dbPath);
    setup.exec(`INSERT INTO chunks (id, brain_id, project, session_id, timestamp, content, syncable)
      VALUES ('existing', 'b.gm', 'proj', 'old', 1, 'durable existing search term', 0)`);
    setup.exec('DROP TRIGGER chunks_ai');
    setup.exec('DELETE FROM chunks_fts');
    setup.exec(`CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END`);
    setup.close();
    const p = writeTranscript('persistent-stale-fts.jsonl', [jsonlLine('user', 'durable new search term')]);
    const db = new Database(dbPath);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });
    db.close();

    const verify = new Database(dbPath, { readonly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'existing'").get())
      .toEqual({ count: 1 });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'new'").get())
      .toEqual({ count: 1 });
    verify.close();
  });

  test('persistent repair restores a partial FTS posting set after reopen', async () => {
    const dbPath = path.join(dir, 'partial-postings-fts.db');
    const setup = makePersistentFtsDb(dbPath);
    setup.exec(`INSERT INTO chunks (id, brain_id, project, session_id, timestamp, content, syncable)
      VALUES ('existing', 'b.gm', 'proj', 'old', 1, 'alpha beta', 0)`);
    setup.exec('DELETE FROM chunks_fts');
    setup.exec(`INSERT INTO chunks_fts(rowid, content, project, session_id)
      SELECT rowid, 'alpha', project, session_id FROM chunks WHERE id = 'existing'`);
    setup.close();
    const p = writeTranscript('partial-postings-fts.jsonl', [jsonlLine('user', 'gamma')]);
    const db = new Database(dbPath);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });
    db.close();

    const verify = new Database(dbPath, { readonly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'beta'").get())
      .toEqual({ count: 1 });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'gamma'").get())
      .toEqual({ count: 1 });
    verify.close();
  });

  test('fails closed before FTS rebuild or transcript writes for foreign or missing chunk ownership', async () => {
    for (const owner of ['other.gm', '']) {
      const db = makeDb();
      db.prepare(`INSERT INTO chunks (id, brain_id, project, session_id, timestamp, content, syncable)
        VALUES (?, ?, 'foreign-project', 'foreign-session', 1, 'foreign stale term', 0)`).run(`existing-${owner || 'empty'}`, owner);
      db.exec('DELETE FROM chunks_fts');
      const p = writeTranscript(`ownership-${owner || 'empty'}.jsonl`, [jsonlLine('user', 'must remain unindexed')]);

      await expect(indexFile(db, {
        sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
      })).rejects.toThrow(/ownership is foreign or missing.*brain-db migrate/i);
      expect(db.prepare("SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'foreign'").get())
        .toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM chunks').get()).toEqual({ count: 1 });
      db.close();
    }
  });

  test('valid tokenless chunks do not make a healthy FTS index look stale', () => {
    const db = makeDb();
    db.exec(`INSERT INTO chunks (id, brain_id, project, session_id, timestamp, content, syncable)
      VALUES ('tokenless', 'b.gm', '', '', 1, '', 0)`);
    expect(ensureCanonicalTranscriptFtsIndex(db, { brainId: 'b.gm' })).toEqual({ repaired: false, chunkCount: 0, indexedCount: 0 });
    db.close();
  });

  test('dry-run detects stale FTS but does not rebuild or write', () => {
    const dbPath = path.join(dir, 'dry-run-fts.db');
    const setup = makePersistentFtsDb(dbPath);
    setup.exec(`INSERT INTO chunks (id, brain_id, project, session_id, timestamp, content, syncable)
      VALUES ('existing', 'b.gm', 'proj', 'old', 1, 'stale dry run evidence', 0)`);
    setup.exec(`DELETE FROM chunks_fts`);
    setup.close();

    const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    const before = new Map(sidecars.filter(fs.existsSync).map((file) => [
      file,
      { bytes: fs.readFileSync(file), stat: fs.statSync(file) },
    ]));
    const db = new Database(dbPath, { readonly: true });

    expect(() => ensureCanonicalTranscriptFtsIndex(db, { dryRun: true, brainId: 'b.gm' }))
      .toThrow(/dry-run will not repair/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'stale'").get())
      .toEqual({ count: 0 });
    db.close();
    for (const [file, snapshot] of before) {
      expect(fs.readFileSync(file)).toEqual(snapshot.bytes);
      const after = fs.statSync(file);
      expect(after.size).toBe(snapshot.stat.size);
      expect(after.mtimeMs).toBe(snapshot.stat.mtimeMs);
    }
    expect(sidecars.filter(fs.existsSync).sort()).toEqual([...before.keys()].sort());
  });

  test('throws if brainId is empty', () => {
    const db = makeDb();
    const p = writeTranscript('t.jsonl', [jsonlLine('user', 'hello')]);
    expect(() => indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: '',
    })).toThrow('brainId');
    db.close();
  });

  test('throws if brainId is null', () => {
    const db = makeDb();
    const p = writeTranscript('t.jsonl', [jsonlLine('user', 'hello')]);
    expect(() => indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: null as any,
    })).toThrow('brainId');
    db.close();
  });

  test('inserts chunks with correct brain_id and session_id', async () => {
    const db = makeDb();
    const lines = Array.from({ length: 3 }, (_, i) => jsonlLine('user', `msg ${i}`));
    const p = writeTranscript('sess1.jsonl', lines);

    const { inserted } = await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess-001', project: 'proj',
      brainId: 'bootup.gm',
    });

    expect(inserted).toBeGreaterThan(0);
    const rows = db.prepare('SELECT brain_id, session_id FROM chunks').all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].brain_id).toBe('bootup.gm');
    expect(rows[0].session_id).toBe('sess-001');
    db.close();
  });

  test('syncable defaults to 0 (privacy gate)', async () => {
    const db = makeDb();
    const p = writeTranscript('t.jsonl', [jsonlLine('user', 'private')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });
    const rows = db.prepare('SELECT syncable FROM chunks').all();
    expect(rows.every((r: any) => r.syncable === 0)).toBe(true);
    db.close();
  });

  test('syncable=1 when --sync-transcripts passed', async () => {
    const db = makeDb();
    const p = writeTranscript('t.jsonl', [jsonlLine('user', 'shared')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj',
      brainId: 'b.gm', syncTranscripts: true,
    });
    const rows = db.prepare('SELECT syncable FROM chunks').all();
    expect(rows.every((r: any) => r.syncable === 1)).toBe(true);
    db.close();
  });

  test('chunk_meta JSON round-trips correctly', async () => {
    const db = makeDb();
    const p = writeTranscript('t.jsonl', [jsonlLine('user', 'test content')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });
    const row = db.prepare('SELECT chunk_meta FROM chunks LIMIT 1').get() as any;
    const meta = JSON.parse(row.chunk_meta);
    expect(meta).toHaveProperty('boundary_reason');
    expect(meta).toHaveProperty('source_cli', 'claude');
    expect(meta).toHaveProperty('source_path', p);
    db.close();
  });

  test('transcript_index updated after insert', async () => {
    const db = makeDb();
    const p = writeTranscript('t.jsonl', [jsonlLine('user', 'hello')]);
    const fileSize = fs.statSync(p).size;
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });
    const row = db.prepare(`
      SELECT source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count, last_error
      FROM transcript_index WHERE source_path = ?
    `).get(p) as any;
    expect(row).not.toBeNull();
    expect(Object.keys(row).sort()).toEqual([
      'byte_offset', 'chunk_count', 'content_hash', 'indexed_at',
      'last_error', 'project', 'session_id', 'source_path',
    ]);
    expect(row.byte_offset).toBe(fileSize);
    expect(row.content_hash).toBe(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    expect(row.session_id).toBe('sess');
    expect(row.project).toBe('proj');
    expect(row.last_error).toBeNull();
    expect(row.chunk_count).toBeGreaterThan(0);
    db.close();
  });

  test('second run with same file inserts 0 new chunks (no new bytes)', async () => {
    const db = makeDb();
    const p = writeTranscript('t.jsonl', [jsonlLine('user', 'first content')]);

    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });
    const countAfterFirst = (db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;

    // Second run — same file, no new bytes
    const result2 = await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });
    const countAfterSecond = (db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;

    expect(result2.inserted).toBe(0);
    expect(result2.skipped).toBe(true);
    expect(countAfterSecond).toBe(countAfterFirst);
    db.close();
  });

  test('incremental append preserves original and appended chunks with exact state count', async () => {
    const db = makeDb();
    const p = path.join(dir, 'incremental.jsonl');
    fs.writeFileSync(p, jsonlLine('user', 'first batch') + '\n');

    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });
    const firstState = db.prepare('SELECT byte_offset, content_hash, chunk_count FROM transcript_index WHERE source_path = ?').get(p) as any;
    const countAfterFirst = (db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;
    expect(countAfterFirst).toBe(1);
    expect(firstState.chunk_count).toBe(countAfterFirst);

    // Append new content
    fs.appendFileSync(p, jsonlLine('user', 'second batch') + '\n');

    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });
    const countAfterSecond = (db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;
    const secondState = db.prepare('SELECT byte_offset, content_hash, chunk_count FROM transcript_index WHERE source_path = ?').get(p) as any;
    const rows = db.prepare('SELECT id, content, chunk_meta FROM chunks ORDER BY id').all() as Array<{ id: string; content: string; chunk_meta: string }>;

    expect(countAfterSecond).toBe(countAfterFirst + 1);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.map((row) => row.id).every((id) => id.endsWith('__c000') || id.endsWith('__c001'))).toBe(true);
    expect(rows.map((row) => row.content)).toEqual(['first batch', 'second batch']);
    expect(rows.map((row) => JSON.parse(row.chunk_meta).total_chunks_in_session)).toEqual([2, 2]);
    expect(secondState.chunk_count).toBe(countAfterSecond);
    expect(secondState.byte_offset).toBe(fs.statSync(p).size);
    expect(secondState.byte_offset).toBeGreaterThan(firstState.byte_offset);
    expect(secondState.content_hash).toBe(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    expect(secondState.content_hash).not.toBe(firstState.content_hash);
    db.close();
  });

  test('incremental partial JSON remains retryable until the record is completed', async () => {
    const db = makeDb();
    const p = path.join(dir, 'partial.jsonl');
    const complete = jsonlLine('user', 'completed after retry') + '\n';
    const splitAt = Buffer.byteLength(complete) - 9;
    fs.writeFileSync(p, Buffer.from(complete).subarray(0, splitAt));

    expect(await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'partial-session', project: 'proj', brainId: 'b.gm',
    })).toEqual({ inserted: 0, skipped: true });
    expect(db.prepare('SELECT * FROM transcript_index').all()).toEqual([]);

    fs.appendFileSync(p, Buffer.from(complete).subarray(splitAt));
    expect(await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'partial-session', project: 'proj', brainId: 'b.gm',
    })).toEqual({ inserted: 1, skipped: false });
    expect(db.prepare('SELECT content FROM chunks').all()).toEqual([{ content: 'completed after retry' }]);
    expect(db.prepare('SELECT byte_offset FROM transcript_index WHERE source_path = ?').get(p))
      .toEqual({ byte_offset: Buffer.byteLength(complete) });
    db.close();
  });

  test('all-partial rotation preserves the indexed snapshot and completes on retry', async () => {
    const db = makeDb();
    const p = writeTranscript('partial-rotation.jsonl', [jsonlLine('user', 'stale indexed content')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'partial-rotation', project: 'proj', brainId: 'b.gm',
    });
    const chunksBefore = db.prepare('SELECT * FROM chunks ORDER BY id').all();
    const stateBefore = db.prepare(`
      SELECT content_hash, byte_offset, session_id, project, chunk_count, last_error
      FROM transcript_index WHERE source_path = ?
    `).get(p);

    const replacement = jsonlLine('user', 'replacement completed after rotation') + '\n';
    const splitAt = Buffer.byteLength(replacement) - 13;
    fs.writeFileSync(p, Buffer.from(replacement).subarray(0, splitAt));

    expect(await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'partial-rotation', project: 'proj', brainId: 'b.gm',
    })).toEqual({ inserted: 0, skipped: true });
    expect(db.prepare('SELECT * FROM chunks ORDER BY id').all()).toEqual(chunksBefore);
    expect(db.prepare(`
      SELECT content_hash, byte_offset, session_id, project, chunk_count, last_error
      FROM transcript_index WHERE source_path = ?
    `).get(p)).toEqual(stateBefore);

    fs.appendFileSync(p, Buffer.from(replacement).subarray(splitAt));
    expect(await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'partial-rotation', project: 'proj', brainId: 'b.gm',
    })).toEqual({ inserted: 1, skipped: false });

    const chunks = db.prepare('SELECT id, content, chunk_meta FROM chunks ORDER BY id').all() as any[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toMatch(/^partial-rotation__s[0-9a-f]{64}__c000$/);
    expect(chunks[0].content).toBe('replacement completed after rotation');
    expect(JSON.parse(chunks[0].chunk_meta)).toMatchObject({
      source_path: p,
      source_cli: 'claude',
      total_chunks_in_session: 1,
    });
    expect(db.prepare(`
      SELECT content_hash, byte_offset, session_id, project, chunk_count, last_error
      FROM transcript_index WHERE source_path = ?
    `).get(p)).toEqual({
      content_hash: crypto.createHash('sha256').update(replacement).digest('hex'),
      byte_offset: Buffer.byteLength(replacement),
      session_id: 'partial-rotation',
      project: 'proj',
      chunk_count: 1,
      last_error: null,
    });
    db.close();
  });

  test('valid prefix advances by exact bytes while trailing partial JSON stays unread', async () => {
    const db = makeDb();
    const p = path.join(dir, 'mixed-partial.jsonl');
    const first = jsonlLine('user', 'multibyte 🧠') + '\n';
    const second = jsonlLine('user', 'eventually complete') + '\n';
    const splitAt = Buffer.byteLength(second) - 11;
    fs.writeFileSync(p, Buffer.concat([
      Buffer.from(first),
      Buffer.from(second).subarray(0, splitAt),
    ]));

    expect(await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'mixed-session', project: 'proj', brainId: 'b.gm',
    })).toEqual({ inserted: 1, skipped: false });
    const prefixHash = crypto.createHash('sha256').update(Buffer.from(first)).digest('hex');
    expect(db.prepare('SELECT byte_offset, content_hash FROM transcript_index WHERE source_path = ?').get(p))
      .toEqual({ byte_offset: Buffer.byteLength(first), content_hash: prefixHash });

    fs.appendFileSync(p, Buffer.from(second).subarray(splitAt));
    expect(await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'mixed-session', project: 'proj', brainId: 'b.gm',
    })).toEqual({ inserted: 1, skipped: false });
    expect((db.prepare('SELECT content FROM chunks ORDER BY id').all() as any[]).map((row) => row.content))
      .toEqual(['multibyte 🧠', 'eventually complete']);
    expect(db.prepare('SELECT byte_offset FROM transcript_index WHERE source_path = ?').get(p))
      .toEqual({ byte_offset: Buffer.byteLength(first + second) });
    db.close();
  });

  test('complete invalid incremental line is quarantined without blocking later valid bytes', async () => {
    const db = makeDb();
    const p = writeTranscript('invalid-append.jsonl', [jsonlLine('user', 'good')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'invalid-append', project: 'proj', brainId: 'b.gm',
    });
    fs.appendFileSync(p, 'not json\n' + jsonlLine('user', 'must not be skipped') + '\n');

    expect(await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'invalid-append', project: 'proj', brainId: 'b.gm',
    })).toEqual({ inserted: 1, skipped: false });
    expect(db.prepare('SELECT byte_offset, chunk_count, last_error FROM transcript_index WHERE source_path = ?').get(p))
      .toEqual({
        byte_offset: fs.statSync(p).size,
        chunk_count: 2,
        last_error: 'Malformed JSONL records were skipped',
      });
    expect(db.prepare('SELECT content FROM chunks ORDER BY id').all())
      .toEqual([{ content: 'good' }, { content: 'must not be skipped' }]);
    db.close();
  });

  test('source-scoped chunk IDs preserve distinct files that share a session ID', async () => {
    const db = makeDb();
    const first = writeTranscript('first.jsonl', [jsonlLine('user', 'from first source')]);
    const second = writeTranscript('second.jsonl', [jsonlLine('user', 'from second source')]);

    for (const sourcePath of [first, second]) {
      await indexFile(db, {
        sourcePath, sourceCli: 'claude', sessionId: 'shared-session', project: 'proj', brainId: 'b.gm',
      });
    }

    const chunks = db.prepare('SELECT id, content, chunk_meta FROM chunks ORDER BY content').all() as any[];
    const states = db.prepare('SELECT source_path, chunk_count FROM transcript_index ORDER BY source_path').all() as any[];
    expect(chunks).toHaveLength(2);
    expect(new Set(chunks.map((row) => row.id)).size).toBe(2);
    expect(chunks.map((row) => row.content)).toEqual(['from first source', 'from second source']);
    expect(chunks.map((row) => JSON.parse(row.chunk_meta).source_path).sort()).toEqual([first, second].sort());
    expect(states).toEqual([
      { source_path: first, chunk_count: 1 },
      { source_path: second, chunk_count: 1 },
    ]);
    db.close();
  });

  test('unknown layouts keep same-named sources distinct', async () => {
    const db = makeDb();
    const first = path.join(dir, 'custom-a', 'session.jsonl');
    const second = path.join(dir, 'custom-b', 'session.jsonl');
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(first, jsonlLine('user', 'custom first') + '\n');
    fs.writeFileSync(second, jsonlLine('user', 'custom second') + '\n');

    for (const sourcePath of [first, second]) {
      await indexFile(db, {
        sourcePath, sourceCli: 'custom', sessionId: 'same-session', project: 'same-project', brainId: 'b.gm',
      });
    }

    const chunks = db.prepare('SELECT id, content FROM chunks ORDER BY content').all() as any[];
    expect(chunks.map((row) => row.content)).toEqual(['custom first', 'custom second']);
    expect(new Set(chunks.map((row) => row.id)).size).toBe(2);
    db.close();
  });

  test('append preserves legacy session-only chunk IDs while using source-scoped continuation IDs', async () => {
    const db = makeDb();
    const p = writeTranscript('legacy.jsonl', [jsonlLine('user', 'legacy content')]);
    const firstSize = fs.statSync(p).size;
    const firstHash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    db.prepare(`
      INSERT INTO chunks
        (id, brain_id, project, session_id, timestamp, turn_type, content, token_count, chunk_meta, syncable, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      'legacy-session__c000', 'b.gm', 'proj', 'legacy-session', 0, 'mixed', 'legacy content', 2,
      JSON.stringify({ source_path: p, source_cli: 'claude', total_chunks_in_session: 1 }), 0,
    );
    db.prepare(`
      INSERT INTO transcript_index
        (source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(p, firstHash, firstSize, Date.now(), 'legacy-session', 'proj', 1);

    fs.appendFileSync(p, jsonlLine('user', 'modern continuation') + '\n');
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'legacy-session', project: 'proj', brainId: 'b.gm',
    });

    const chunks = db.prepare('SELECT id, content, chunk_meta FROM chunks ORDER BY id').all() as any[];
    expect(chunks).toHaveLength(2);
    expect(chunks.some((row) => row.id === 'legacy-session__c000')).toBe(true);
    expect(chunks.some((row) => /^legacy-session__s[0-9a-f]{64}__c001$/.test(row.id))).toBe(true);
    expect(chunks.map((row) => JSON.parse(row.chunk_meta).total_chunks_in_session)).toEqual([2, 2]);
    expect((db.prepare('SELECT chunk_count FROM transcript_index WHERE source_path = ?').get(p) as any).chunk_count).toBe(2);
    db.close();
  });

  test('truncation transactionally replaces stale source chunks', async () => {
    const db = makeDb();
    const p = writeTranscript('rotated.jsonl', Array.from({ length: 21 }, (_, i) => jsonlLine('user', `stale ${i}`)));
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'rotated-session', project: 'proj', brainId: 'b.gm',
    });
    expect((db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as any).n).toBe(2);

    fs.writeFileSync(p, jsonlLine('user', 'replacement only') + '\n');
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'rotated-session', project: 'proj', brainId: 'b.gm',
    });

    const chunks = db.prepare('SELECT content, chunk_meta FROM chunks').all() as any[];
    const state = db.prepare('SELECT byte_offset, chunk_count FROM transcript_index WHERE source_path = ?').get(p) as any;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('replacement only');
    expect(JSON.parse(chunks[0].chunk_meta).total_chunks_in_session).toBe(1);
    expect(state).toEqual({ byte_offset: fs.statSync(p).size, chunk_count: 1 });
    db.close();
  });

  test('equal-size rotation replaces stale source chunks instead of skipping', async () => {
    const db = makeDb();
    const p = writeTranscript('same-size-rotation.jsonl', [
      jsonlLine('user', 'old payload', '2026-01-01T00:00:00.000Z'),
    ]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'same-size-session', project: 'proj', brainId: 'b.gm',
    });
    const originalSize = fs.statSync(p).size;

    fs.writeFileSync(p, jsonlLine('user', 'new payload', '2026-01-01T00:00:00.000Z') + '\n');
    expect(fs.statSync(p).size).toBe(originalSize);
    const result = await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'same-size-session', project: 'proj', brainId: 'b.gm',
    });

    expect(result).toEqual({ inserted: 1, skipped: false });
    expect(db.prepare('SELECT content FROM chunks').all()).toEqual([{ content: 'new payload' }]);
    expect((db.prepare('SELECT chunk_count FROM transcript_index WHERE source_path = ?').get(p) as any).chunk_count).toBe(1);
    db.close();
  });

  test.each([
    ['empty', ''],
    ['whitespace', '  \n\t\n'],
  ])('natural %s replacement transactionally clears stale chunks and advances state', async (_label, replacement) => {
    const db = makeDb();
    const p = writeTranscript('empty-replacement.jsonl', [jsonlLine('user', 'stale content')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'empty-session', project: 'proj', brainId: 'b.gm',
    });

    fs.writeFileSync(p, replacement);
    const result = await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'empty-session', project: 'proj', brainId: 'b.gm',
    });

    expect(result).toEqual({ inserted: 0, skipped: true });
    expect(db.prepare('SELECT content FROM chunks').all()).toEqual([]);
    expect(db.prepare(`
      SELECT content_hash, byte_offset, chunk_count, last_error
      FROM transcript_index WHERE source_path = ?
    `).get(p)).toEqual({
      content_hash: crypto.createHash('sha256').update(replacement).digest('hex'),
      byte_offset: Buffer.byteLength(replacement),
      chunk_count: 0,
      last_error: null,
    });
    db.close();
  });

  test('natural invalid-JSON replacement clears stale chunks and records the parse failure', async () => {
    const db = makeDb();
    const p = writeTranscript('invalid-replacement.jsonl', [jsonlLine('user', 'stale content')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'invalid-session', project: 'proj', brainId: 'b.gm',
    });

    fs.writeFileSync(p, 'not json\nstill not json\n');
    const result = await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'invalid-session', project: 'proj', brainId: 'b.gm',
    });

    expect(result).toEqual({ inserted: 0, skipped: true });
    expect(db.prepare('SELECT content FROM chunks').all()).toEqual([]);
    const state = db.prepare(`
      SELECT content_hash, byte_offset, chunk_count, last_error
      FROM transcript_index WHERE source_path = ?
    `).get(p) as any;
    expect(state.content_hash).toBe(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    expect(state.byte_offset).toBe(fs.statSync(p).size);
    expect(state.chunk_count).toBe(0);
    expect(state.last_error).toMatch(/no valid JSON/i);
    db.close();
  });

  test('force with invalid JSON preserves the prior consistent snapshot', async () => {
    const db = makeDb();
    const p = writeTranscript('invalid-force.jsonl', [jsonlLine('user', 'preserve me')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-invalid-session', project: 'proj', brainId: 'b.gm',
    });
    const chunksBefore = db.prepare('SELECT * FROM chunks').all();
    const stateBefore = db.prepare('SELECT * FROM transcript_index WHERE source_path = ?').get(p);

    fs.writeFileSync(p, 'not json\n');
    await expect(indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-invalid-session', project: 'proj', brainId: 'b.gm', force: true,
    })).rejects.toThrow(/force re-index refused.*malformed or partial JSONL/i);

    expect(db.prepare('SELECT * FROM chunks').all()).toEqual(chunksBefore);
    expect(db.prepare('SELECT * FROM transcript_index WHERE source_path = ?').get(p)).toEqual(stateBefore);
    db.close();
  });

  test('force with mixed valid and malformed JSON preserves the prior consistent snapshot', async () => {
    const db = makeDb();
    const p = writeTranscript('force-mixed-invalid.jsonl', [jsonlLine('user', 'stable snapshot')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-mixed', project: 'proj', brainId: 'b.gm',
    });
    const stateBefore = db.prepare('SELECT * FROM transcript_index').all();
    const chunksBefore = db.prepare('SELECT * FROM chunks').all();
    fs.writeFileSync(p, jsonlLine('user', 'valid replacement prefix') + '\nmalformed\n');

    await expect(indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-mixed', project: 'proj', brainId: 'b.gm', force: true,
    })).rejects.toThrow(/force re-index refused.*malformed or partial JSONL/i);
    expect(db.prepare('SELECT * FROM transcript_index').all()).toEqual(stateBefore);
    expect(db.prepare('SELECT * FROM chunks').all()).toEqual(chunksBefore);
    db.close();
  });

  test('force rolls back deletion when rebuilding the replacement fails', async () => {
    const db = makeDb();
    const p = writeTranscript('failed-force.jsonl', [jsonlLine('user', 'preserve on failure')]);
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-failure-session', project: 'proj', brainId: 'b.gm',
    });
    const chunksBefore = db.prepare('SELECT * FROM chunks').all();
    const stateBefore = db.prepare('SELECT * FROM transcript_index WHERE source_path = ?').get(p);
    fs.writeFileSync(p, jsonlLine('user', 'valid replacement') + '\n');
    db.exec(`
      CREATE TRIGGER reject_forced_chunk BEFORE INSERT ON chunks
      BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END
    `);

    await expect(indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-failure-session', project: 'proj', brainId: 'b.gm', force: true,
    })).rejects.toThrow(/forced insert failure/i);

    expect(db.prepare('SELECT * FROM chunks').all()).toEqual(chunksBefore);
    expect(db.prepare('SELECT * FROM transcript_index WHERE source_path = ?').get(p)).toEqual(stateBefore);
    db.close();
  });

  test('portable source IDs are stable across home roots and distinct within one session', async () => {
    const dbA = makeDb();
    const dbB = makeDb();
    const homeA = path.join(dir, 'machine-a');
    const homeB = path.join(dir, 'machine-b');
    const relativeSources = [
      path.join('.claude', 'projects', 'portable-project', 'primary.jsonl'),
      path.join('.claude', 'projects', 'portable-project', 'secondary.jsonl'),
    ];

    for (const relativeSource of relativeSources) {
      const sourceA = path.join(homeA, relativeSource);
      const sourceB = path.join(homeB, relativeSource);
      fs.mkdirSync(path.dirname(sourceA), { recursive: true });
      fs.mkdirSync(path.dirname(sourceB), { recursive: true });
      fs.writeFileSync(sourceA, jsonlLine('user', path.basename(relativeSource)) + '\n');
      fs.writeFileSync(sourceB, jsonlLine('user', path.basename(relativeSource)) + '\n');
      await indexFile(dbA, {
        sourcePath: sourceA, sourceCli: 'claude', sessionId: 'shared-session', project: 'portable-project', brainId: 'b.gm',
      });
      await indexFile(dbB, {
        sourcePath: sourceB, sourceCli: 'claude', sessionId: 'shared-session', project: 'portable-project', brainId: 'b.gm',
      });
    }

    const idsA = (dbA.prepare('SELECT id FROM chunks ORDER BY content').all() as any[]).map((row) => row.id);
    const idsB = (dbB.prepare('SELECT id FROM chunks ORDER BY content').all() as any[]).map((row) => row.id);
    expect(idsA).toEqual(idsB);
    expect(new Set(idsA).size).toBe(2);
    dbA.close();
    dbB.close();
  });

  test('restored DB migrates an unchanged portable source path without duplicate state', async () => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', 'restored.jsonl');
    const oldPath = path.join(dir, 'home-a', relative);
    const newPath = path.join(dir, 'home-b', relative);
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    const content = jsonlLine('user', 'portable unchanged') + '\n';
    fs.writeFileSync(oldPath, content);
    await indexFile(db, {
      sourcePath: oldPath, sourceCli: 'claude', sessionId: 'portable-session', project: 'portable-project', brainId: 'b.gm',
    });
    fs.writeFileSync(newPath, content);

    expect(await indexFile(db, {
      sourcePath: newPath, sourceCli: 'claude', sessionId: 'portable-session', project: 'portable-project', brainId: 'b.gm',
    })).toEqual({ inserted: 0, skipped: true });
    expect(db.prepare('SELECT source_path, chunk_count FROM transcript_index').all())
      .toEqual([{ source_path: newPath, chunk_count: 1 }]);
    const rows = db.prepare('SELECT id, chunk_meta FROM chunks').all() as any[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].chunk_meta).source_path).toBe(newPath);
    db.close();
  });

  test('healthy canonical source is not blocked by a stale portable duplicate row', async () => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', 'healthy.jsonl');
    const currentPath = path.join(dir, 'healthy-home', relative);
    const stalePath = path.join(dir, 'stale-home', relative);
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.writeFileSync(currentPath, jsonlLine('user', 'healthy canonical content') + '\n');
    await indexFile(db, {
      sourcePath: currentPath, sourceCli: 'claude', sessionId: 'healthy-session',
      project: 'portable-project', brainId: 'b.gm',
    });
    db.prepare(`
      INSERT INTO transcript_index
        (source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count, last_error)
      SELECT ?, content_hash, byte_offset, indexed_at, session_id, project, 1, last_error
      FROM transcript_index WHERE source_path = ?
    `).run(stalePath, currentPath);

    expect(await indexFile(db, {
      sourcePath: currentPath, sourceCli: 'claude', sessionId: 'healthy-session',
      project: 'portable-project', brainId: 'b.gm',
    })).toEqual({ inserted: 0, skipped: true });
    expect(db.prepare('SELECT content FROM chunks').all()).toEqual([{ content: 'healthy canonical content' }]);
    db.close();
  });

  test('restored DB migrates a valid zero-chunk snapshot', async () => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', 'empty.jsonl');
    const oldPath = path.join(dir, 'empty-home-a', relative);
    const newPath = path.join(dir, 'empty-home-b', relative);
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(oldPath, '');
    fs.writeFileSync(newPath, '');
    await indexFile(db, {
      sourcePath: oldPath, sourceCli: 'claude', sessionId: 'empty-portable',
      project: 'portable-project', brainId: 'b.gm',
    });

    expect(await indexFile(db, {
      sourcePath: newPath, sourceCli: 'claude', sessionId: 'empty-portable',
      project: 'portable-project', brainId: 'b.gm',
    })).toEqual({ inserted: 0, skipped: true });
    expect(db.prepare('SELECT source_path, byte_offset, chunk_count FROM transcript_index').all())
      .toEqual([{ source_path: newPath, byte_offset: 0, chunk_count: 0 }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks').get()).toEqual({ n: 0 });
    db.close();
  });

  test('restored DB migrates a portable source then appends with exact counts', async () => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', 'appended.jsonl');
    const oldPath = path.join(dir, 'home-a', relative);
    const newPath = path.join(dir, 'home-b', relative);
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    const first = jsonlLine('user', 'before restore') + '\n';
    const second = jsonlLine('user', 'after restore') + '\n';
    fs.writeFileSync(oldPath, first);
    await indexFile(db, {
      sourcePath: oldPath, sourceCli: 'claude', sessionId: 'portable-append', project: 'portable-project', brainId: 'b.gm',
    });
    fs.writeFileSync(newPath, first + second);

    expect(await indexFile(db, {
      sourcePath: newPath, sourceCli: 'claude', sessionId: 'portable-append', project: 'portable-project', brainId: 'b.gm',
    })).toEqual({ inserted: 1, skipped: false });
    expect(db.prepare('SELECT source_path, byte_offset, chunk_count FROM transcript_index').all())
      .toEqual([{ source_path: newPath, byte_offset: Buffer.byteLength(first + second), chunk_count: 2 }]);
    const rows = db.prepare('SELECT content, chunk_meta FROM chunks ORDER BY id').all() as any[];
    expect(rows.map((row) => row.content)).toEqual(['before restore', 'after restore']);
    expect(rows.every((row) => JSON.parse(row.chunk_meta).source_path === newPath)).toBe(true);
    db.close();
  });

  test('restored DB migrates across different machine-encoded project roots', async () => {
    const db = makeDb();
    const oldProject = encodeProjectPath('/Users/alice/dev/mech-browse');
    const newProject = encodeProjectPath('/Users/bob/work/mech-browse');
    const oldPath = path.join(dir, 'home-a', '.claude', 'projects', oldProject, 'cross-machine.jsonl');
    const newPath = path.join(dir, 'home-b', '.claude', 'projects', newProject, 'cross-machine.jsonl');
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    const content = jsonlLine('user', 'cross-machine restore') + '\n';
    fs.writeFileSync(oldPath, content);
    fs.writeFileSync(newPath, content);
    await indexFile(db, {
      sourcePath: oldPath, sourceCli: 'claude', sessionId: 'cross-machine-session',
      project: oldProject, brainId: 'mech-browse',
    });

    expect(await indexFile(db, {
      sourcePath: newPath, sourceCli: 'claude', sessionId: 'cross-machine-session',
      project: newProject, brainId: 'mech-browse',
    })).toEqual({ inserted: 0, skipped: true });
    expect(db.prepare('SELECT source_path, project, chunk_count FROM transcript_index').all())
      .toEqual([{ source_path: newPath, project: newProject, chunk_count: 1 }]);
    const chunks = db.prepare('SELECT project, chunk_meta FROM chunks').all() as any[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].project).toBe(newProject);
    expect(JSON.parse(chunks[0].chunk_meta).source_path).toBe(newPath);
    db.close();
  });

  test.each([
    ['null session', null, 'portable-project'],
    ['null project', 'nullable-portable', null],
    ['null session and project', null, null],
  ])('restored DB migrates unchanged portable source with %s', async (_label, storedSession, storedProject) => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', 'nullable-unchanged.jsonl');
    const oldPath = path.join(dir, 'nullable-home-a', relative);
    const newPath = path.join(dir, 'nullable-home-b', relative);
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    const content = jsonlLine('user', 'nullable portable unchanged') + '\n';
    fs.writeFileSync(oldPath, content);
    await indexFile(db, {
      sourcePath: oldPath, sourceCli: 'claude', sessionId: 'nullable-portable', project: 'portable-project', brainId: 'b.gm',
    });
    db.prepare('UPDATE transcript_index SET session_id = ?, project = ? WHERE source_path = ?')
      .run(storedSession, storedProject, oldPath);
    fs.writeFileSync(newPath, content);

    expect(await indexFile(db, {
      sourcePath: newPath, sourceCli: 'claude', sessionId: 'nullable-portable', project: 'portable-project', brainId: 'b.gm',
    })).toEqual({ inserted: 0, skipped: true });
    expect(db.prepare(`
      SELECT source_path, content_hash, byte_offset, session_id, project, chunk_count
      FROM transcript_index
    `).all()).toEqual([{
      source_path: newPath,
      content_hash: crypto.createHash('sha256').update(content).digest('hex'),
      byte_offset: Buffer.byteLength(content),
      session_id: 'nullable-portable',
      project: 'portable-project',
      chunk_count: 1,
    }]);
    const chunks = db.prepare('SELECT id, content, chunk_meta FROM chunks').all() as any[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('nullable portable unchanged');
    expect(JSON.parse(chunks[0].chunk_meta).source_path).toBe(newPath);
    db.close();
  });

  test.each([
    ['null session', null, 'portable-project'],
    ['null project', 'nullable-portable-append', null],
    ['null session and project', null, null],
  ])('restored DB migrates and appends portable source with %s', async (_label, storedSession, storedProject) => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', 'nullable-appended.jsonl');
    const oldPath = path.join(dir, 'nullable-append-home-a', relative);
    const newPath = path.join(dir, 'nullable-append-home-b', relative);
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    const first = jsonlLine('user', 'nullable before restore') + '\n';
    const second = jsonlLine('user', 'nullable after restore') + '\n';
    fs.writeFileSync(oldPath, first);
    await indexFile(db, {
      sourcePath: oldPath, sourceCli: 'claude', sessionId: 'nullable-portable-append', project: 'portable-project', brainId: 'b.gm',
    });
    db.prepare('UPDATE transcript_index SET session_id = ?, project = ? WHERE source_path = ?')
      .run(storedSession, storedProject, oldPath);
    fs.writeFileSync(newPath, first + second);

    expect(await indexFile(db, {
      sourcePath: newPath, sourceCli: 'claude', sessionId: 'nullable-portable-append', project: 'portable-project', brainId: 'b.gm',
    })).toEqual({ inserted: 1, skipped: false });
    expect(db.prepare(`
      SELECT source_path, content_hash, byte_offset, session_id, project, chunk_count
      FROM transcript_index
    `).all()).toEqual([{
      source_path: newPath,
      content_hash: crypto.createHash('sha256').update(first + second).digest('hex'),
      byte_offset: Buffer.byteLength(first + second),
      session_id: 'nullable-portable-append',
      project: 'portable-project',
      chunk_count: 2,
    }]);
    const chunks = db.prepare('SELECT id, content, chunk_meta FROM chunks ORDER BY id').all() as any[];
    expect(chunks).toHaveLength(2);
    expect(chunks.map((row) => row.content)).toEqual(['nullable before restore', 'nullable after restore']);
    expect(new Set(chunks.map((row) => row.id)).size).toBe(2);
    expect(chunks.every((row) => JSON.parse(row.chunk_meta).source_path === newPath)).toBe(true);
    db.close();
  });

  test('restored v2-migrated empty-project sentinel is normalized without duplicate chunks', async () => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', 'migrated-v2.jsonl');
    const oldPath = path.join(dir, 'v2-home-a', relative);
    const newPath = path.join(dir, 'v2-home-b', relative);
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    const content = jsonlLine('user', 'migrated v2 content') + '\n';
    fs.writeFileSync(oldPath, content);
    fs.writeFileSync(newPath, content);
    await indexFile(db, {
      sourcePath: oldPath, sourceCli: 'claude', sessionId: 'migrated-v2-session',
      project: 'portable-project', brainId: 'b.gm',
    });
    const chunk = db.prepare('SELECT id FROM chunks').get() as any;
    db.prepare('UPDATE chunks SET id = ? WHERE id = ?').run('migrated-v2-session__c000', chunk.id);
    db.prepare(`
      UPDATE transcript_index
      SET content_hash = 'migrated-v2', project = ''
      WHERE source_path = ?
    `).run(oldPath);

    expect(await indexFile(db, {
      sourcePath: newPath, sourceCli: 'claude', sessionId: 'migrated-v2-session',
      project: 'portable-project', brainId: 'b.gm',
    })).toEqual({ inserted: 1, skipped: false });
    expect(db.prepare('SELECT source_path, project, chunk_count FROM transcript_index').all())
      .toEqual([{ source_path: newPath, project: 'portable-project', chunk_count: 1 }]);
    const chunks = db.prepare('SELECT id, content, chunk_meta FROM chunks').all() as any[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('migrated v2 content');
    expect(JSON.parse(chunks[0].chunk_meta).source_path).toBe(newPath);
    db.close();
  });

  test('portable source migration fails closed when more than one old row matches', async () => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', 'ambiguous.jsonl');
    const oldA = path.join(dir, 'home-a', relative);
    const oldB = path.join(dir, 'home-b', relative);
    const current = path.join(dir, 'home-c', relative);
    for (const sourcePath of [oldA, oldB, current]) {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, jsonlLine('user', sourcePath) + '\n');
    }
    await indexFile(db, {
      sourcePath: oldA, sourceCli: 'claude', sessionId: 'ambiguous-session', project: 'portable-project', brainId: 'b.gm',
    });
    db.prepare(`INSERT INTO transcript_index
      (source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count, last_error)
      SELECT ?, content_hash, byte_offset, indexed_at, session_id, project, 0, last_error
      FROM transcript_index WHERE source_path = ?`).run(oldB, oldA);

    await expect(indexFile(db, {
      sourcePath: current, sourceCli: 'claude', sessionId: 'ambiguous-session', project: 'portable-project', brainId: 'b.gm',
    })).rejects.toThrow(/ambiguous portable transcript source|cannot safely migrate portable transcript source/i);
    expect((db.prepare('SELECT source_path FROM transcript_index ORDER BY source_path').all() as any[]).map((r) => r.source_path))
      .toEqual([oldA, oldB].sort());
    db.close();
  });

  test('nullable portable source migration fails closed when chunk evidence is ambiguous', async () => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', 'nullable-ambiguous.jsonl');
    const oldA = path.join(dir, 'nullable-ambiguous-home-a', relative);
    const oldB = path.join(dir, 'nullable-ambiguous-home-b', relative);
    const current = path.join(dir, 'nullable-ambiguous-home-c', relative);
    for (const sourcePath of [oldA, oldB, current]) {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, jsonlLine('user', 'ambiguous nullable evidence') + '\n');
    }
    await indexFile(db, {
      sourcePath: oldA, sourceCli: 'claude', sessionId: 'nullable-ambiguous', project: 'portable-project', brainId: 'b.gm',
    });
    const originalChunk = db.prepare('SELECT * FROM chunks').get() as any;
    const originalMeta = JSON.parse(originalChunk.chunk_meta);
    originalMeta.source_path = oldB;
    db.prepare(`
      INSERT INTO chunks
        (id, brain_id, project, session_id, timestamp, turn_type, content, token_count, embedding, chunk_meta, syncable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      originalChunk.id.replace(/__c000$/, '__c001'), originalChunk.brain_id, originalChunk.project,
      originalChunk.session_id, originalChunk.timestamp, originalChunk.turn_type, originalChunk.content,
      originalChunk.token_count, originalChunk.embedding, JSON.stringify(originalMeta), originalChunk.syncable,
    );
    db.prepare(`
      INSERT INTO transcript_index
        (source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count, last_error)
      SELECT ?, content_hash, byte_offset, indexed_at, NULL, NULL, 1, last_error
      FROM transcript_index WHERE source_path = ?
    `).run(oldB, oldA);
    db.prepare('UPDATE transcript_index SET session_id = NULL, project = NULL WHERE source_path = ?').run(oldA);
    const stateBefore = db.prepare('SELECT * FROM transcript_index ORDER BY source_path').all();
    const chunksBefore = db.prepare('SELECT * FROM chunks ORDER BY id').all();

    await expect(indexFile(db, {
      sourcePath: current, sourceCli: 'claude', sessionId: 'nullable-ambiguous', project: 'portable-project', brainId: 'b.gm',
    })).rejects.toThrow(/ambiguous portable transcript source/i);
    expect(db.prepare('SELECT * FROM transcript_index ORDER BY source_path').all()).toEqual(stateBefore);
    expect(db.prepare('SELECT * FROM chunks ORDER BY id').all()).toEqual(chunksBefore);
    db.close();
  });

  test.each([
    'brain_id',
    'session_id',
    'project',
    'source_cli',
    'chunk_id_suffix',
  ])('nullable portable source migration rejects inconsistent %s evidence', async (field) => {
    const db = makeDb();
    const relative = path.join('.claude', 'projects', 'portable-project', `evidence-${field}.jsonl`);
    const oldPath = path.join(dir, 'evidence-home-a', relative);
    const newPath = path.join(dir, 'evidence-home-b', relative);
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    const content = jsonlLine('user', `evidence ${field}`) + '\n';
    fs.writeFileSync(oldPath, content);
    fs.writeFileSync(newPath, content);
    await indexFile(db, {
      sourcePath: oldPath, sourceCli: 'claude', sessionId: 'evidence-session',
      project: 'portable-project', brainId: 'b.gm',
    });
    db.prepare('UPDATE transcript_index SET session_id = NULL, project = NULL WHERE source_path = ?').run(oldPath);

    if (field === 'source_cli') {
      const row = db.prepare('SELECT id, chunk_meta FROM chunks').get() as any;
      const meta = JSON.parse(row.chunk_meta);
      meta.source_cli = 'cursor';
      db.prepare('UPDATE chunks SET chunk_meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id);
    } else if (field === 'chunk_id_suffix') {
      const row = db.prepare('SELECT id FROM chunks').get() as any;
      db.prepare('UPDATE chunks SET id = ? WHERE id = ?').run(row.id.replace(/__c\d+$/, '__cBAD'), row.id);
    } else {
      db.prepare(`UPDATE chunks SET ${field} = ?`).run(`wrong-${field}`);
    }

    const stateBefore = db.prepare('SELECT * FROM transcript_index').all();
    const chunksBefore = db.prepare('SELECT * FROM chunks').all();
    await expect(indexFile(db, {
      sourcePath: newPath, sourceCli: 'claude', sessionId: 'evidence-session',
      project: 'portable-project', brainId: 'b.gm',
    })).rejects.toThrow(field === 'brain_id'
      ? /ownership is foreign or missing.*brain-db migrate/i
      : /cannot safely migrate portable transcript source/i);
    expect(db.prepare('SELECT * FROM transcript_index').all()).toEqual(stateBefore);
    expect(db.prepare('SELECT * FROM chunks').all()).toEqual(chunksBefore);
    db.close();
  });

  test('stale concurrent continuation fails closed without overwriting chunks or counters', async () => {
    const dbPath = path.join(dir, 'concurrent.db');
    const setup = makePersistentFtsDb(dbPath);
    setup.close();
    const dbA = new Database(dbPath);
    const dbB = new Database(dbPath);
    const p = writeTranscript('concurrent.jsonl', [jsonlLine('user', 'original')]);

    try {
      await indexFile(dbA, {
        sourcePath: p, sourceCli: 'claude', sessionId: 'concurrent-session', project: 'proj', brainId: 'b.gm',
      });
      fs.appendFileSync(p, jsonlLine('user', 'one continuation') + '\n');

      let signalEmbeddingStarted!: () => void;
      let releaseStaleWriter!: () => void;
      const embeddingStarted = new Promise<void>((resolve) => { signalEmbeddingStarted = resolve; });
      const staleWriterGate = new Promise<void>((resolve) => { releaseStaleWriter = resolve; });
      const staleWrite = indexFile(dbA, {
        sourcePath: p, sourceCli: 'claude', sessionId: 'concurrent-session', project: 'proj', brainId: 'b.gm',
        embedFn: async () => {
          signalEmbeddingStarted();
          await staleWriterGate;
          return new Float32Array(384);
        },
      });
      await embeddingStarted;
      await indexFile(dbB, {
        sourcePath: p, sourceCli: 'claude', sessionId: 'concurrent-session', project: 'proj', brainId: 'b.gm',
      });
      releaseStaleWriter();

      await expect(staleWrite).rejects.toThrow(/changed concurrently/i);
      const chunks = dbB.prepare('SELECT content FROM chunks ORDER BY id').all() as any[];
      const state = dbB.prepare('SELECT byte_offset, chunk_count FROM transcript_index WHERE source_path = ?').get(p) as any;
      expect(chunks.map((row) => row.content)).toEqual(['original', 'one continuation']);
      expect(state).toEqual({ byte_offset: fs.statSync(p).size, chunk_count: 2 });
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  test('dryRun: reports chunks but inserts nothing', async () => {
    const db = makeDb();
    const p = writeTranscript('t.jsonl', [jsonlLine('user', 'dry run test')]);

    const { inserted } = await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj',
      brainId: 'b.gm', dryRun: true,
    });

    const count = (db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;
    const idxCount = (db.prepare('SELECT COUNT(*) as n FROM transcript_index').get() as any).n;

    expect(inserted).toBeGreaterThan(0);  // reported, not actually inserted
    expect(count).toBe(0);                // nothing written
    expect(idxCount).toBe(0);             // index not updated
    db.close();
  });

  test('skips file with no valid JSONL lines', async () => {
    const db = makeDb();
    const p = writeTranscript('bad.jsonl', ['not json', 'also not json']);

    const { inserted, skipped } = await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'sess', project: 'proj', brainId: 'b.gm',
    });

    expect(skipped).toBe(true);
    expect(inserted).toBe(0);
    db.close();
  });
});

test('--force full reindex atomically replaces prior chunks without inflating state', async () => {
  const dir = tmpDir();
  const db = makeDb();
  const p = path.join(dir, 'force.jsonl');
  fs.writeFileSync(p, [
    jsonlLine('user', 'original content'),
    jsonlLine('user', 'appended content'),
  ].join('\n') + '\n');

  try {
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-sess', project: 'proj', brainId: 'b.gm',
    });
    fs.appendFileSync(p, jsonlLine('user', 'latest content') + '\n');
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-sess', project: 'proj', brainId: 'b.gm',
    });

    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-sess', project: 'proj', brainId: 'b.gm', force: true,
    });

    const rows = db.prepare('SELECT id, content FROM chunks ORDER BY id').all() as Array<{ id: string; content: string }>;
    const state = db.prepare('SELECT byte_offset, chunk_count FROM transcript_index WHERE source_path = ?').get(p) as any;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toEndWith('__c000');
    expect(rows[0].content).toContain('original content');
    expect(rows[0].content).toContain('appended content');
    expect(rows[0].content).toContain('latest content');
    expect(state.chunk_count).toBe(rows.length);
    expect(state.byte_offset).toBe(fs.statSync(p).size);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--force preserves an existing embedding when rebuilt chunk content is unchanged', async () => {
  const dir = tmpDir();
  const db = makeDb();
  const p = path.join(dir, 'force-embedding.jsonl');
  fs.writeFileSync(p, jsonlLine('user', 'stable semantic content') + '\n');

  try {
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-embedding', project: 'proj', brainId: 'b.gm',
      embedFn: async () => new Float32Array([1.5, 2.5, 3.5]),
    });
    const before = db.prepare('SELECT embedding FROM chunks').get() as any;
    expect(before.embedding).not.toBeNull();

    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-embedding', project: 'proj', brainId: 'b.gm', force: true,
    });
    const after = db.prepare('SELECT embedding FROM chunks').get() as any;
    expect(Buffer.from(after.embedding)).toEqual(Buffer.from(before.embedding));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--force preserves existing source syncability without requiring the flag again', async () => {
  const dir = tmpDir();
  const db = makeDb();
  const p = path.join(dir, 'force-syncable.jsonl');
  fs.writeFileSync(p, jsonlLine('user', 'already syncable') + '\n');

  try {
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-syncable', project: 'proj', brainId: 'b.gm',
      syncTranscripts: true,
    });
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'force-syncable', project: 'proj', brainId: 'b.gm', force: true,
    });
    expect(db.prepare('SELECT syncable FROM chunks').all()).toEqual([{ syncable: 1 }]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--force only replaces the selected source path', async () => {
  const dir = tmpDir();
  const db = makeDb();
  const selected = path.join(dir, 'selected.jsonl');
  const untouched = path.join(dir, 'untouched.jsonl');
  fs.writeFileSync(selected, jsonlLine('user', 'selected content') + '\n');
  fs.writeFileSync(untouched, jsonlLine('user', 'untouched content') + '\n');

  try {
    for (const sourcePath of [selected, untouched]) {
      await indexFile(db, {
        sourcePath, sourceCli: 'claude', sessionId: path.basename(sourcePath), project: 'proj', brainId: 'b.gm',
      });
    }
    const untouchedBefore = db.prepare('SELECT byte_offset, chunk_count FROM transcript_index WHERE source_path = ?').get(untouched);

    await indexFile(db, {
      sourcePath: selected, sourceCli: 'claude', sessionId: path.basename(selected), project: 'proj', brainId: 'b.gm', force: true,
    });

    expect(db.prepare('SELECT byte_offset, chunk_count FROM transcript_index WHERE source_path = ?').get(selected))
      .toEqual({ byte_offset: fs.statSync(selected).size, chunk_count: 1 });
    expect(db.prepare('SELECT byte_offset, chunk_count FROM transcript_index WHERE source_path = ?').get(untouched))
      .toEqual(untouchedBefore);
    const remaining = db.prepare('SELECT content FROM chunks ORDER BY content').all() as any[];
    expect(remaining.map((row) => row.content)).toEqual(['selected content', 'untouched content']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--force rebuild cleans source chunks when canonical index session_id is null', async () => {
  const dir = tmpDir();
  const db = makeDb();
  const p = path.join(dir, 'nullable-session.jsonl');
  fs.writeFileSync(p, jsonlLine('user', 'replacement') + '\n');
  db.prepare(`
    INSERT INTO chunks
      (id, brain_id, project, session_id, timestamp, turn_type, content, token_count, chunk_meta, syncable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('legacy__c000', 'b.gm', 'proj', 'legacy', 0, 'mixed', 'stale', 1,
    JSON.stringify({ source_path: p, source_cli: 'claude' }), 0);
  db.prepare(`
    INSERT INTO transcript_index
      (source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count, last_error)
    VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
  `).run(p, 'migrated-v2', 0, Date.now(), 'proj', 1);

  try {
    await indexFile(db, {
      sourcePath: p, sourceCli: 'claude', sessionId: 'current', project: 'proj', brainId: 'b.gm', force: true,
    });
    expect(db.prepare('SELECT content FROM chunks').all()).toEqual([{ content: 'replacement' }]);
    expect(db.prepare('SELECT session_id, byte_offset, chunk_count FROM transcript_index WHERE source_path = ?').get(p))
      .toEqual({ session_id: 'current', byte_offset: fs.statSync(p).size, chunk_count: 1 });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveIndexTargetIdentity', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('uses the target project identity rather than global configuration', () => {
    fs.writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'target.gm' }));
    expect(resolveIndexTargetIdentity(dir)).toBe('target.gm');
  });

  test('fails closed when target identity is missing', () => {
    expect(() => resolveIndexTargetIdentity(dir)).toThrow(/No non-empty project agent ID/);
  });

  test('fails closed when target identity is invalid', () => {
    fs.writeFileSync(path.join(dir, 'agentbootup.json'), '{not-json');
    expect(() => resolveIndexTargetIdentity(dir)).toThrow(/invalid JSON/);
  });

  test('fails closed when the declared target brain ID has an invalid format', () => {
    fs.writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: '-invalid' }));
    expect(() => resolveIndexTargetIdentity(dir)).toThrow(/invalid brain ID/);
  });

  test('fails closed when target identity declarations conflict', () => {
    fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'target.gm' }));
    fs.writeFileSync(path.join(dir, 'brain', 'config.json'), JSON.stringify({ agent_id: 'other.gm' }));
    expect(() => resolveIndexTargetIdentity(dir)).toThrow(/Conflicting project identity/);
  });
});

describe('transcript index schema gate', () => {
  test('accepts the canonical v3/v4 schema', () => {
    const db = makeDb();
    expect(hasCanonicalTranscriptIndexSchema(db)).toBe(true);
    db.close();
  });

  test('rejects the legacy source_cli and last_byte_offset schema', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE transcript_index (
        source_path TEXT PRIMARY KEY,
        source_cli TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_byte_offset INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL
      )
    `);
    expect(hasCanonicalTranscriptIndexSchema(db)).toBe(false);
    db.close();
  });
});

// ── getIndexState error handling ──────────────────────────────────────────

describe('getIndexState error handling', () => {
  test('returns zeros when transcript_index table does not exist', () => {
    // Database with no transcript_index table (simulates schema not yet applied)
    const db = new Database(':memory:');
    db.exec('CREATE TABLE chunks (id TEXT PRIMARY KEY)');

    const result = getIndexState(db, '/some/path.jsonl');
    expect(result).toEqual({ lastByteOffset: 0, chunkCount: 0 });
    db.close();
  });

  test('re-throws non-table-missing errors', () => {
    const db = new Database(':memory:');
    // Create transcript_index with wrong column names to trigger schema mismatch
    db.exec('CREATE TABLE transcript_index (wrong_col TEXT)');

    expect(() => getIndexState(db, '/some/path.jsonl')).toThrow(/no such column/);
    db.close();
  });
});

// ── encodeProjectPath ─────────────────────────────────────────────────────

describe('encodeProjectPath', () => {
  test('replaces forward slashes with hyphens', () => {
    expect(encodeProjectPath('/Users/foo/myproject')).toBe('-Users-foo-myproject');
  });

  test('replaces underscores with hyphens', () => {
    expect(encodeProjectPath('/Users/foo/dev_env/myproject')).toBe('-Users-foo-dev-env-myproject');
  });

  test('replaces both slashes and underscores — mirrors Claude Code encoding', () => {
    // Claude Code encodes project paths for ~/.claude/projects/ dir names using
    // the same rule: both / and _ become -. Verified by inspecting actual dirs on disk.
    const input = '/Users/foo/dev_env/my_project';
    expect(encodeProjectPath(input)).toBe(input.replace(/[\/_]/g, '-'));
  });

  test('resolves relative paths before encoding', () => {
    const abs = encodeProjectPath(process.cwd());
    const rel = encodeProjectPath('.');
    expect(abs).toBe(rel);
  });
});
