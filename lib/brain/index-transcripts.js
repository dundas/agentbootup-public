/**
 * lib/brain/index-transcripts.js
 *
 * Transcript ingestion pipeline for brain.db.
 *
 * Discovers AI CLI transcripts (Claude, Cursor, Codex, Gemini), chunks them
 * using signal-based boundary detection, and inserts chunks into the local
 * brain.db SQLite file for FTS5 keyword search and optional vector ANN search.
 *
 * Key design decisions:
 *   - Uses the synchronous libSQL driver for persistent writes so canonical
 *     vector indexes are maintained. Dry-run uses Bun SQLite's enforced
 *     read-only mode, covered against the same vector schema.
 *   - Byte-offset dedup (P2): transcript_index stores byte_offset. Content is
 *     hashed before the offset fast path so equal-size replacements cannot be
 *     mistaken for unchanged append-only transcripts.
 *   - Privacy gate (P1): syncable=0 by default. Set syncable=1 only when the
 *     --sync-transcripts flag is explicitly passed. Local FTS5 search works
 *     regardless; the daemon only pushes syncable=1 chunks to remote sqld.
 *   - brain_id guard: rejects empty brainId to prevent silent '' inserts that
 *     would corrupt tenant isolation.
 *
 * Exported API:
 *   discoverTranscripts(options?)      → TranscriptEntry[]
 *   getIndexState(db, sourcePath)      → { lastByteOffset, chunkCount }
 *   readNewLines(sourcePath, offset)   → { newContent, newByteOffset }
 *   indexFile(db, options)             → { inserted, skipped }
 *   runIndexTranscripts(argv)          → Promise<void>  (CLI entry point)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Database drivers are loaded dynamically in runIndexTranscripts. Functions
// that accept `db` (indexFile, getIndexState, etc.) work with either synchronous
// SQLite-compatible handle.
import { chunkMessages } from './chunker.js';
import { isValidBrainId } from '../config/brain-id.js';
import { resolveProjectAgentId } from '../project-config.js';
import { ensureEmbedderInstalled, getEmbedder, vecToBuffer } from './embedder.js';
import { encodeProjectPath } from './project-path.js';
import { signalDaemonByPidFile } from '../process/pid-utils.js';

// ── Transcript discovery ───────────────────────────────────────────────────

/**
 * Derive a session ID from the source file path.
 * For JSONL files the filename (without extension) is the session ID.
 * e.g. "/home/user/.claude/projects/myproj/memory/abc123.jsonl" → "abc123"
 *
 * @param {string} filePath
 * @returns {string}
 */
function sessionIdFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath));
}


/**
 * Glob a pattern like "~/.claude/projects" into real paths.
 * Returns all matching files. Silently skips missing directories.
 *
 * @param {string} baseDir        - absolute base directory (already expanded)
 * @param {{ subDir: string|null, filePattern: string }} glob2  - subDir = intermediate path (null for flat), filePattern = e.g. '*.jsonl'
 * @param {string} sourceCli
 * @param {{ maxAgeMs?: number }} opts
 * @returns {Array<{ sourcePath: string, sourceCli: string, sessionId: string, project: string }>}
 */
function globTranscriptDir(baseDir, glob2, sourceCli, opts = {}) {
  const results = [];
  if (!fs.existsSync(baseDir)) return results;

  const { subDir, filePattern } = glob2;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(baseDir, d.name));
  } catch {
    return results;
  }

  const patternExt = filePattern.startsWith('*.') ? filePattern.slice(1) : null; // e.g. '.jsonl'

  for (const projectDir of projectDirs) {
    const transcriptDir = subDir ? path.join(projectDir, subDir) : projectDir;
    if (!fs.existsSync(transcriptDir)) continue;

    let files;
    try {
      files = fs.readdirSync(transcriptDir, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => path.join(transcriptDir, f.name));
    } catch {
      continue;
    }

    for (const filePath of files) {
      // Filter by extension pattern
      if (patternExt && !filePath.endsWith(patternExt)) continue;

      // Filter by max age
      if (opts.maxAgeMs != null) {
        try {
          const stat = fs.statSync(filePath);
          if (Date.now() - stat.mtimeMs > opts.maxAgeMs) continue;
        } catch {
          continue;
        }
      }

      results.push({
        sourcePath: filePath,
        sourceCli,
        sessionId: sessionIdFromPath(filePath),
        // Use basename of projectDir directly — always correct for all CLI layouts,
        // including Gemini (no subDir) where path-depth derivation would return 'history'.
        project: path.basename(projectDir),
      });
    }
  }

  return results;
}

/**
 * Discover all AI CLI transcript files across all 4 CLIs.
 *
 * @param {object} [options]
 * @param {number} [options.maxSessions]     - cap total results (default: unlimited)
 * @param {number} [options.maxAgeDays]      - skip files older than this many days
 * @param {string} [options.homeDir]         - override home dir (for testing)
 * @returns {Array<{ sourcePath: string, sourceCli: string, sessionId: string, project: string }>}
 */
export function discoverTranscripts(options = {}) {
  const { maxSessions, maxAgeDays } = options;
  const maxAgeMs = maxAgeDays != null ? maxAgeDays * 86_400_000 : null;
  const opts = maxAgeMs != null ? { maxAgeMs } : {};

  const home = options.homeDir ?? os.homedir();
  const results = [];

  // Claude Code: ~/.claude/projects/<project>/*.jsonl (flat layout — current Claude Code format).
  // Older versions used a memory/ subdir; current Claude Code stores transcripts flat.
  // Skip subagents/ subdirectory (contains child-session transcripts indexed separately).
  const claudeProjects = path.join(home, '.claude', 'projects');
  for (const entry of globTranscriptDir(claudeProjects, { subDir: null, filePattern: '*.jsonl' }, 'claude', opts)) {
    // Skip subagent transcripts (path contains /subagents/)
    if (!entry.sourcePath.includes(path.sep + 'subagents' + path.sep)) {
      results.push(entry);
    }
  }

  // Cursor: ~/.cursor/projects/<project>/agent-transcripts/*.jsonl
  const cursorProjects = path.join(home, '.cursor', 'projects');
  results.push(...globTranscriptDir(cursorProjects, { subDir: 'agent-transcripts', filePattern: '*.jsonl' }, 'cursor', opts));

  // Codex: ~/.codex/projects/<project>/memory/*.jsonl
  const codexProjects = path.join(home, '.codex', 'projects');
  results.push(...globTranscriptDir(codexProjects, { subDir: 'memory', filePattern: '*.jsonl' }, 'codex', opts));

  // Gemini: ~/.gemini/history/<project>/*.jsonl
  const geminiProjects = path.join(home, '.gemini', 'history');
  results.push(...globTranscriptDir(geminiProjects, { subDir: null, filePattern: '*.jsonl' }, 'gemini', opts));

  if (maxSessions != null && results.length > maxSessions) {
    // Sort newest-first by mtime so --max-sessions N returns the most-recent transcripts
    // across all CLIs rather than the first N from Claude alone.
    // Pre-compute mtimes to avoid O(n log n) statSync calls in the comparator.
    const mtimes = new Map(results.map((r) => {
      try { return [r.sourcePath, fs.statSync(r.sourcePath).mtimeMs]; }
      catch { return [r.sourcePath, 0]; }
    }));
    results.sort((a, b) => (mtimes.get(b.sourcePath) ?? 0) - (mtimes.get(a.sourcePath) ?? 0));
    return results.slice(0, maxSessions);
  }
  return results;
}

// ── Byte-offset dedup ──────────────────────────────────────────────────────

/**
 * Read the current indexing state for a source file from transcript_index.
 * Returns { lastByteOffset: 0, chunkCount: 0 } for files not yet indexed.
 *
 * @param {import('bun:sqlite').Database} db
 * @param {string} sourcePath
 * @returns {{ lastByteOffset: number, chunkCount: number }}
 */
export function getIndexState(db, sourcePath) {
  try {
    const row = db.prepare(
      'SELECT byte_offset, chunk_count FROM transcript_index WHERE source_path = ?'
    ).get(sourcePath);
    if (!row) return { lastByteOffset: 0, chunkCount: 0 };
    return {
      lastByteOffset: row.byte_offset ?? 0,
      chunkCount: row.chunk_count ?? 0,
    };
  } catch (err) {
    // Swallow "no such table" — transcript_index not yet created (schema not applied).
    // Re-throw anything else (column mismatch, corruption) so the caller notices.
    if (err?.message?.includes('no such table')) return { lastByteOffset: 0, chunkCount: 0 };
    throw err;
  }
}

/**
 * Read new content from a file starting at byteOffset.
 * Handles the case where the file is shorter than byteOffset
 * (e.g. file was rotated/truncated) by resetting to offset 0.
 *
 * @param {string} sourcePath
 * @param {number} byteOffset
 * @returns {{ newContent: string, newByteOffset: number }}
 */
export function readNewLines(sourcePath, byteOffset) {
  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return { newContent: '', newByteOffset: byteOffset };
  }

  const fileSize = stat.size;

  // File truncated/rotated (fileSize < byteOffset) — reset to start.
  //
  // Known limitation: if a file is atomically replaced with different content
  // but the exact same byte length, fileSize === byteOffset and we return
  // newContent = '' — old stale chunks remain in brain.db. Pass `--force` to
  // reset all offsets and re-index from scratch. This case is extremely rare
  // because AI CLI transcripts are append-only by design.
  const effectiveOffset = byteOffset > fileSize ? 0 : byteOffset;

  if (effectiveOffset >= fileSize) {
    // No new bytes.
    return { newContent: '', newByteOffset: effectiveOffset };
  }

  const fd = fs.openSync(sourcePath, 'r');
  try {
    const length = fileSize - effectiveOffset;
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, effectiveOffset);
    const newContent = buf.slice(0, bytesRead).toString('utf-8');
    return { newContent, newByteOffset: effectiveOffset + bytesRead };
  } finally {
    fs.closeSync(fd);
  }
}

// ── Chunk insertion ────────────────────────────────────────────────────────

function getSourceChunks(db, sourcePath, sessionId) {
  const sourcePredicate = `CASE
    WHEN json_valid(chunk_meta) THEN json_extract(chunk_meta, '$.source_path') = ?
    ELSE 0
  END`;
  const rows = sessionId == null
    ? db.prepare(`
        SELECT id, brain_id, project, session_id, content, embedding, syncable, chunk_meta
        FROM chunks WHERE ${sourcePredicate}
      `).all(sourcePath)
    : db.prepare(`
        SELECT id, brain_id, project, session_id, content, embedding, syncable, chunk_meta
        FROM chunks WHERE session_id = ? AND ${sourcePredicate}
      `).all(sessionId, sourcePath);
  return rows
    .filter((row) => {
      try {
        return JSON.parse(row.chunk_meta ?? '{}').source_path === sourcePath;
      } catch {
        return false;
      }
    });
}

export function hasCanonicalTranscriptIndexSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(transcript_index)').all().map((row) => row.name));
  return ['source_path', 'content_hash', 'byte_offset', 'indexed_at', 'session_id', 'project', 'chunk_count', 'last_error']
    .every((column) => columns.has(column));
}

const REQUIRED_FTS_SCHEMA_OBJECTS = [
  ['table', 'chunks_fts'],
  ['trigger', 'chunks_ai'],
  ['trigger', 'chunks_ad'],
  ['trigger', 'chunks_au'],
];

// Private capability: only runIndexTranscripts may bypass per-file validation,
// and only after its single persistent-batch preflight has succeeded.
const INDEX_BATCH_FTS_PREFLIGHT = Symbol('index-batch-fts-preflight');

/**
 * The FTS table is external-content, so its presence alone does not prove that
 * existing chunks are searchable.  fts5vocab's instance view exposes the
 * document ids that actually have index entries (unlike COUNT(*) on an
 * external-content FTS table, which reads the content table and can mask an
 * empty index).
 */
function ftsPostings(db, tableName) {
  const vocabTable = '__agentbootup_chunks_fts_vocab';
  try {
    const database = tableName.startsWith('temp.') ? 'temp' : 'main';
    const bareTableName = tableName.replace(/^temp\./, '');
    db.exec(`CREATE VIRTUAL TABLE temp.${vocabTable} USING fts5vocab(${database}, ${bareTableName}, 'instance')`);
    return db.prepare(`
      SELECT term, doc, col, offset FROM temp.${vocabTable}
      ORDER BY term, doc, col, offset
    `).all();
  } finally {
    // This is TEMP schema only. It is cleaned up on every path so validation
    // never changes persistent brain.db state (including during --dry-run).
    try { db.exec(`DROP TABLE IF EXISTS temp.${vocabTable}`); } catch { /* best effort cleanup */ }
  }
}

function countIndexedFtsRows(db) {
  return ftsPostings(db, 'chunks_fts');
}

// An FTS document with no tokens deliberately has no fts5vocab entry. Build a
// temporary FTS table with the canonical tokenizer to calculate the matching
// expected count rather than treating such chunks as a broken index.
function expectedFtsPostings(db) {
  const expectedTable = '__agentbootup_expected_chunks_fts';
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.${expectedTable} USING fts5(content, project, session_id)`);
    db.prepare(`
      INSERT INTO temp.${expectedTable}(rowid, content, project, session_id)
      SELECT rowid, content, project, session_id FROM chunks
    `).run();
    return ftsPostings(db, `temp.${expectedTable}`);
  } finally {
    try { db.exec(`DROP TABLE IF EXISTS temp.${expectedTable}`); } catch { /* best effort cleanup */ }
  }
}

function ftsSchemaObjects(db) {
  const rows = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE (type = 'table' AND name = 'chunks_fts')
       OR (type = 'trigger' AND name IN ('chunks_ai', 'chunks_ad', 'chunks_au'))
  `).all();
  return new Map(rows.map((row) => [`${row.type}:${row.name}`, row.sql ?? '']));
}

function normalizeSql(sql) {
  return String(sql)
    .replace(/--[^\n]*(?:\n|$)/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function hasRequiredFtsSemantics(objects) {
  const table = normalizeSql(objects.get('table:chunks_fts'));
  const ai = normalizeSql(objects.get('trigger:chunks_ai'));
  const ad = normalizeSql(objects.get('trigger:chunks_ad'));
  const au = normalizeSql(objects.get('trigger:chunks_au'));
  const ftsTable = /^createvirtualtablechunks_ftsusingfts5\(content,project,session_id,content=['"]chunks['"],content_rowid=['"]rowid['"]\);?$/.test(table);
  const insert = ai === 'createtriggerchunks_aiafterinsertonchunksbegininsertintochunks_fts(rowid,content,project,session_id)values(new.rowid,new.content,new.project,new.session_id);end';
  const remove = ad === "createtriggerchunks_adafterdeleteonchunksbegininsertintochunks_fts(chunks_fts,rowid,content,project,session_id)values('delete',old.rowid,old.content,old.project,old.session_id);end";
  const update = au === "createtriggerchunks_auafterupdateonchunksbegininsertintochunks_fts(chunks_fts,rowid,content,project,session_id)values('delete',old.rowid,old.content,old.project,old.session_id);insertintochunks_fts(rowid,content,project,session_id)values(new.rowid,new.content,new.project,new.session_id);end";
  return { ftsTable, insert, remove, update };
}

function ftsMigrationError(detail) {
  return new Error(
    `brain.db transcript FTS schema/integrity validation failed (${detail}). ` +
    'Run `agentbootup brain-db migrate --cwd <project>` first, then retry.'
  );
}

// The FTS table is shared by every local chunk, so rebuilding it for a target
// brain is only safe when every existing chunk has that exact ownership. Do
// not "fix" foreign or legacy data here: assigning, deleting, or indexing it
// would cross the identity boundary. A migration with an explicit ownership
// contract is required instead.
function assertCanonicalChunkOwnership(db, brainId) {
  if (!isValidBrainId(brainId)) {
    throw ftsMigrationError('target brain identity is invalid');
  }
  let owners;
  try {
    owners = db.prepare('SELECT brain_id FROM chunks GROUP BY brain_id').all();
  } catch (err) {
    throw ftsMigrationError(err.message);
  }
  if (owners.some(({ brain_id: owner }) => !isValidBrainId(owner) || owner !== brainId)) {
    throw ftsMigrationError('existing chunk ownership is foreign or missing for this target brain');
  }
}

/**
 * Verify the FTS5 contract before an index operation can write chunks. Missing
 * schema is a migration problem; a stale external-content index is repaired
 * before new chunks are inserted so search cannot silently remain incomplete.
 *
 * @param {import('bun:sqlite').Database} db
 * @param {{ dryRun?: boolean, brainId: string }} options
 */
export function ensureCanonicalTranscriptFtsIndex(db, { dryRun = false, brainId } = {}) {
  let objects;
  try { objects = ftsSchemaObjects(db); }
  catch (err) { throw ftsMigrationError(err.message); }
  const missing = REQUIRED_FTS_SCHEMA_OBJECTS
    .filter(([type, name]) => !objects.has(`${type}:${name}`))
    .map(([, name]) => name);
  if (missing.length > 0) throw ftsMigrationError(`missing ${missing.join(', ')}`);
  const semantics = hasRequiredFtsSemantics(objects);
  const malformed = Object.entries(semantics).filter(([, valid]) => !valid).map(([name]) => name);
  if (malformed.length > 0) throw ftsMigrationError(`non-canonical ${malformed.join(', ')} definition`);

  // This guard deliberately precedes both the observation and the rebuild.
  // A mixed/unknown chunks table must never become searchable for the target
  // through this transcript indexing path, including during --dry-run.
  assertCanonicalChunkOwnership(db, brainId);

  const postings = () => ({ expected: expectedFtsPostings(db), actual: countIndexedFtsRows(db) });
  const equalPostings = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const summary = ({ expected, actual }) => ({
    chunkCount: new Set(expected.map((posting) => posting.doc)).size,
    indexedCount: new Set(actual.map((posting) => posting.doc)).size,
  });
  if (dryRun) {
    let observed;
    try { observed = postings(); }
    catch (err) { throw ftsMigrationError(err.message); }
    const observedSummary = summary(observed);
    if (equalPostings(observed.expected, observed.actual)) return { repaired: false, ...observedSummary };
    throw new Error(
      `brain.db transcript FTS index is stale (${observedSummary.indexedCount} indexed rows for ${observedSummary.chunkCount} searchable chunks); ` +
      'dry-run will not repair it. Re-run without --dry-run to rebuild the FTS index.'
    );
  }

  try {
    return db.transaction(() => {
      // Count, rebuild, and verify inside one transaction. A concurrent writer
      // cannot slip a new chunk between repair and verification and turn a
      // healthy repair into a spurious migration failure.
      const before = postings();
      const beforeSummary = summary(before);
      if (equalPostings(before.expected, before.actual)) return { repaired: false, ...beforeSummary };
      db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
      const after = postings();
      if (!equalPostings(after.expected, after.actual)) {
        const afterSummary = summary(after);
        throw ftsMigrationError(`rebuild produced ${afterSummary.indexedCount} indexed rows for ${afterSummary.chunkCount} searchable chunks`);
      }
      return { repaired: true, ...beforeSummary };
    })();
  } catch (err) {
    if (err.message?.includes('brain-db migrate')) throw err;
    throw ftsMigrationError(err.message);
  }
}

function createDryRunDatabase(Database) {
  const db = new Database(':memory:');
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
      content,
      project,
      session_id,
      content='chunks',
      content_rowid='rowid'
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

function getIndexRecord(db, sourcePath) {
  return db.prepare(`
    SELECT source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count
    FROM transcript_index WHERE source_path = ?
  `).get(sourcePath) ?? null;
}

function logicalSourceLocator(sourcePath, sourceCli) {
  const normalized = String(sourcePath).replaceAll('\\', '/');
  const providerRoots = {
    claude: '.claude/projects',
    cursor: '.cursor/projects',
    codex: '.codex/projects',
    gemini: '.gemini/history',
  };
  const providerRoot = providerRoots[sourceCli];
  if (providerRoot) {
    const marker = `/${providerRoot}/`;
    const markerIndex = normalized.indexOf(marker);
    const providerRelative = markerIndex >= 0
      ? normalized.slice(markerIndex + marker.length)
      : normalized.startsWith(`${providerRoot}/`) ? normalized.slice(providerRoot.length + 1) : null;
    if (providerRelative) {
      const projectBoundary = providerRelative.indexOf('/');
      return projectBoundary >= 0 ? providerRelative.slice(projectBoundary + 1) : providerRelative;
    }
  }

  // Unknown layouts have no portable root. Preserve the full normalized path
  // so distinct same-named files cannot collapse to one chunk identity.
  return normalized;
}

function sourceChunkIdPrefix(sourcePath, sourceCli, sessionId, brainId) {
  const sourceIdentity = crypto.createHash('sha256')
    .update(`${brainId}\0${sourceCli}\0${sessionId}\0${logicalSourceLocator(sourcePath, sourceCli)}`)
    .digest('hex');
  return `${sessionId}__s${sourceIdentity}`;
}

function hasPortableChunkEvidence(db, row, { desiredPrefix, brainId, sessionId, project, sourceCli }) {
  const sourceChunks = getSourceChunks(db, row.source_path, null);
  if (sourceChunks.length !== row.chunk_count) return false;
  if (sourceChunks.length === 0) return row.chunk_count === 0;

  const idPrefix = `${desiredPrefix}__c`;
  const expectedChunkProject = row.project == null || row.project === '' ? project : row.project;
  const chunkIndices = new Set();
  for (const chunk of sourceChunks) {
    const id = String(chunk.id);
    const suffix = id.startsWith(idPrefix) ? id.slice(idPrefix.length) : '';
    const legacySuffix = id.startsWith(`${sessionId}__c`) ? id.slice(`${sessionId}__c`.length) : '';
    const validPortableId = /^\d+$/.test(suffix);
    const validMigratedV2Id = row.content_hash === 'migrated-v2' && row.project === '' && /^\d+$/.test(legacySuffix);
    let meta;
    try { meta = JSON.parse(chunk.chunk_meta ?? '{}'); }
    catch { return false; }
    const chunkIndex = validPortableId ? suffix : legacySuffix;
    if ((!validPortableId && !validMigratedV2Id) || chunkIndices.has(chunkIndex) ||
        chunk.brain_id !== brainId || chunk.session_id !== sessionId ||
        chunk.project !== expectedChunkProject ||
        meta.source_path !== row.source_path || meta.source_cli !== sourceCli) {
      return false;
    }
    chunkIndices.add(chunkIndex);
  }
  return true;
}

function migratePortableSourcePath(db, { sourcePath, sourceCli, sessionId, project, brainId, dryRun }) {
  // A canonical row already owns this path. Stale portable duplicates are a
  // repair concern, but must not block incremental indexing of the healthy row.
  if (getIndexRecord(db, sourcePath)) return false;

  const desiredPrefix = sourceChunkIdPrefix(sourcePath, sourceCli, sessionId, brainId);
  const evidence = { desiredPrefix, brainId, sessionId, project, sourceCli };
  const compatibleRows = db.prepare(`
    SELECT source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count
    FROM transcript_index
    WHERE (session_id = ? OR session_id IS NULL)
  `).all(sessionId);
  const candidates = [];
  for (const row of compatibleRows) {
    // This routine only reconciles moved paths. Same-path nullable state is
    // still the canonical row and will be normalized by the next state write.
    if (row.source_path === sourcePath) continue;
    if (sourceChunkIdPrefix(row.source_path, sourceCli, sessionId, brainId) !== desiredPrefix) continue;

    // Recover moved rows only when the source-scoped chunk IDs and metadata
    // independently prove the portable identity. This also covers canonical
    // rows whose machine-encoded project value changed across environments.
    if (!hasPortableChunkEvidence(db, row, evidence)) {
      throw new Error(`Cannot safely migrate portable transcript source ${row.source_path}: chunk evidence is missing or inconsistent`);
    }
    candidates.push(row);
  }

  if (candidates.length > 1) {
    throw new Error(`Ambiguous portable transcript source for ${sourcePath}: ${candidates.length} index rows match`);
  }
  if (candidates.length === 0 || candidates[0].source_path === sourcePath || dryRun) return false;

  const oldPath = candidates[0].source_path;
  db.transaction(() => {
    if (getIndexRecord(db, sourcePath)) {
      throw new Error(`Ambiguous portable transcript source for ${sourcePath}: destination already exists`);
    }
    const currentOld = getIndexRecord(db, oldPath);
    if (!sameIndexRecord(candidates[0], currentOld)) {
      throw new Error(`Transcript index state changed concurrently for ${oldPath}`);
    }
    if (!hasPortableChunkEvidence(db, currentOld, evidence)) {
      throw new Error(`Cannot safely migrate portable transcript source ${oldPath}: chunk evidence changed concurrently`);
    }

    const updateMeta = db.prepare('UPDATE chunks SET project = ?, chunk_meta = ? WHERE id = ?');
    for (const row of getSourceChunks(db, oldPath, null)) {
      let meta;
      try { meta = JSON.parse(row.chunk_meta ?? '{}'); }
      catch { throw new Error(`Cannot migrate malformed chunk metadata for ${row.id}`); }
      meta.source_path = sourcePath;
      updateMeta.run(project, JSON.stringify(meta), row.id);
    }
    db.prepare(`
      UPDATE transcript_index
      SET source_path = ?, session_id = ?, project = ?
      WHERE source_path = ?
    `).run(sourcePath, sessionId, project, oldPath);
  })();
  return true;
}

function parseConsumableJsonl(buffer) {
  const messages = [];
  let consumedBytes = 0;
  let cursor = 0;
  let invalid = false;
  let partial = false;

  while (cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor);
    const recordEnd = newline >= 0 ? newline : buffer.length;
    const nextCursor = newline >= 0 ? newline + 1 : buffer.length;
    const text = buffer.subarray(cursor, recordEnd).toString('utf8');
    if (!text.trim()) {
      consumedBytes = nextCursor;
      cursor = nextCursor;
      continue;
    }
    try {
      messages.push(JSON.parse(text));
      consumedBytes = nextCursor;
      cursor = nextCursor;
    } catch {
      invalid = true;
      if (newline < 0) {
        partial = true;
        break;
      }
      // A newline-terminated malformed record is complete but unusable. Skip
      // that record, retain a diagnostic, and continue so later valid JSONL is
      // never blocked behind it.
      consumedBytes = nextCursor;
      cursor = nextCursor;
    }
  }
  return { messages, consumedBytes, invalid, partial };
}

function deleteSourceChunks(db, sourcePath) {
  const deleteChunk = db.prepare('DELETE FROM chunks WHERE id = ?');
  for (const { id } of getSourceChunks(db, sourcePath, null)) deleteChunk.run(id);
}

function writeIndexRecord(db, { sourcePath, contentHash, byteOffset, sessionId, project, chunkCount, lastError }) {
  db.prepare(`
    INSERT INTO transcript_index
      (source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      byte_offset = excluded.byte_offset,
      session_id = excluded.session_id,
      project = excluded.project,
      chunk_count = excluded.chunk_count,
      indexed_at = excluded.indexed_at,
      last_error = excluded.last_error
  `).run(sourcePath, contentHash, byteOffset, Date.now(), sessionId, project, chunkCount, lastError);
}

function sameIndexRecord(expected, actual) {
  if (!expected || !actual) return expected === actual;
  return expected.source_path === actual.source_path &&
    expected.content_hash === actual.content_hash &&
    expected.byte_offset === actual.byte_offset &&
    expected.indexed_at === actual.indexed_at &&
    expected.session_id === actual.session_id &&
    expected.project === actual.project &&
    expected.chunk_count === actual.chunk_count;
}

/**
 * Index a single transcript file into brain.db.
 *
 * @param {import('bun:sqlite').Database} db
 * @param {object} options
 * @param {string}  options.sourcePath      - absolute path to JSONL file
 * @param {string}  options.sourceCli       - 'claude' | 'cursor' | 'codex' | 'gemini'
 * @param {string}  options.sessionId       - session identifier
 * @param {string}  options.project         - project name
 * @param {string}  options.brainId         - must be non-empty string
 * @param {boolean} [options.syncTranscripts=false] - set syncable=1 on chunks
 * @param {boolean} [options.dryRun=false]  - parse + chunk but don't write
 * @param {boolean} [options.verbose=false]
 * @param {boolean} [options.force=false] - full-read replacement committed atomically
 * @param {symbol} [options.ftsPreflight] - internal successful batch capability
 * @returns {{ inserted: number, skipped: boolean }}
 */
export async function indexFile(db, options) {
  const {
    sourcePath, sourceCli, sessionId, project, brainId,
    syncTranscripts = false,
    dryRun = false,
    verbose = false,
    force = false,
    embedFn = null,  // async (text: string) => Float32Array — optional
    ftsPreflight = null,
  } = options;

  // brain_id guard — uses the same validator as config set-brain to ensure
  // format consistency and prevent silent '' or whitespace-only inserts
  // that would corrupt tenant isolation.
  if (!isValidBrainId(brainId)) {
    throw new Error(`brainId must be a valid brain ID (got: ${JSON.stringify(brainId)})`);
  }

  try {
    fs.statSync(sourcePath);
  } catch {
    if (verbose) console.log(`  [skip] ${path.basename(sourcePath)} — source missing`);
    return { inserted: 0, skipped: true };
  }
  // This must happen before source migration or chunk insertion.  A missing or
  // stale external-content FTS index otherwise leaves local search silently
  // incomplete even though transcript indexing reports success.
  if (ftsPreflight !== INDEX_BATCH_FTS_PREFLIGHT) {
    ensureCanonicalTranscriptFtsIndex(db, { dryRun, brainId });
  }
  const migratedSource = migratePortableSourcePath(
    db, { sourcePath, sourceCli, sessionId, project, brainId, dryRun }
  );

  const expectedIndexRecord = getIndexRecord(db, sourcePath);
  const lastByteOffset = expectedIndexRecord?.byte_offset ?? 0;
  let fileBytes;
  try {
    fileBytes = fs.readFileSync(sourcePath);
  } catch {
    if (verbose) console.log(`  [skip] ${path.basename(sourcePath)} — source missing`);
    return { inserted: 0, skipped: true };
  }
  const priorPrefixHash = crypto.createHash('sha256')
    .update(fileBytes.subarray(0, Math.min(lastByteOffset, fileBytes.length)))
    .digest('hex');
  const replaceSource = force || (Boolean(expectedIndexRecord) && (
    fileBytes.length < lastByteOffset ||
    priorPrefixHash !== expectedIndexRecord.content_hash
  ));
  const effectiveOffset = replaceSource ? 0 : lastByteOffset;
  const unreadBytes = fileBytes.subarray(effectiveOffset);

  if (!migratedSource && expectedIndexRecord && !replaceSource && fileBytes.length === lastByteOffset) {
    if (verbose) console.log(`  [skip] ${path.basename(sourcePath)} — no new bytes`);
    return { inserted: 0, skipped: true };
  }

  // Stop at the first invalid/partial record so later writes remain retryable.
  const parsed = parseConsumableJsonl(unreadBytes);
  const rawMessages = parsed.messages;
  if (force && (parsed.invalid || parsed.partial)) {
    throw new Error(`Force re-index refused for ${sourcePath}: transcript contains malformed or partial JSONL`);
  }
  const consumedOffset = effectiveOffset + parsed.consumedBytes;
  const newByteOffset = replaceSource && rawMessages.length === 0 && parsed.invalid && !parsed.partial
    ? fileBytes.length
    : consumedOffset;
  const contentHash = crypto.createHash('sha256').update(fileBytes.subarray(0, newByteOffset)).digest('hex');

  if (rawMessages.length === 0) {
    const invalidJson = parsed.invalid;
    if (dryRun) return { inserted: 0, skipped: true };

    if (parsed.partial || (!replaceSource && invalidJson)) {
      if (verbose) console.log(`  [skip] ${path.basename(sourcePath)} — invalid or partial JSON remains retryable`);
      return { inserted: 0, skipped: true };
    }
    db.transaction(() => {
      const currentIndexRecord = getIndexRecord(db, sourcePath);
      if (!sameIndexRecord(expectedIndexRecord, currentIndexRecord)) {
        throw new Error(`Transcript index state changed concurrently for ${sourcePath}`);
      }
      if (replaceSource) deleteSourceChunks(db, sourcePath);
      const persistedCount = getSourceChunks(db, sourcePath, replaceSource ? null : sessionId).length;
      writeIndexRecord(db, {
        sourcePath,
        contentHash,
        byteOffset: newByteOffset,
        sessionId,
        project,
        chunkCount: persistedCount,
        lastError: invalidJson ? 'No valid JSON lines found in unread transcript content' : null,
      });
    })();
    if (verbose) console.log(`  [skip] ${path.basename(sourcePath)} — ${invalidJson ? 'no valid JSON lines' : 'empty transcript'}`);
    return { inserted: 0, skipped: true };
  }

  // Chunk the messages.
  const chunks = chunkMessages(rawMessages, sessionId, { sourceCli, sourcePath });

  const existingSourceChunks = getSourceChunks(db, sourcePath, sessionId);
  const persistedChunks = replaceSource ? [] : existingSourceChunks;
  const preservedEmbeddings = new Map();
  for (const row of existingSourceChunks) {
    if (row.embedding != null && !preservedEmbeddings.has(row.content)) {
      preservedEmbeddings.set(row.content, row.embedding);
    }
  }
  const inheritedSyncable = replaceSource && existingSourceChunks.some((row) => row.syncable === 1) ? 1 : 0;
  const nextChunkIndex = persistedChunks.reduce((next, row) => {
    const match = String(row.id).match(/__c(\d+)$/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 0);
  const newTotal = persistedChunks.length + chunks.length;
  for (let i = 0; i < chunks.length; i++) {
    const chunkIndex = nextChunkIndex + i;
    chunks[i].id = `${sourceChunkIdPrefix(sourcePath, sourceCli, sessionId, brainId)}__c${String(chunkIndex).padStart(3, '0')}`;
    chunks[i].chunk_index = chunkIndex;
    chunks[i].chunk_meta.total_chunks_in_session = newTotal;
  }

  if (verbose) {
    console.log(`  [index] ${path.basename(sourcePath)} — ${rawMessages.length} msgs → ${chunks.length} chunks`);
  }

  if (dryRun) {
    return { inserted: chunks.length, skipped: false };
  }

  // Pre-compute embeddings outside the transaction (async — can't run inside sync transaction).
  // embeddings[i] is a Buffer for chunk[i], or null if embedFn is not set.
  const embeddings = [];
  if (embedFn && !dryRun) {
    for (const chunk of chunks) {
      try {
        const vec = await embedFn(chunk.content);
        embeddings.push(vecToBuffer(vec));
      } catch (err) {
        if (verbose) console.log(`  [embed-warn] ${chunk.id}: ${err.message} — stored without embedding`);
        embeddings.push(null);
      }
    }
  } else {
    for (let i = 0; i < chunks.length; i++) embeddings.push(null);
  }

  // INSERT chunks in a transaction.
  const syncable = syncTranscripts ? 1 : 0;

  db.transaction(() => {
    // All expensive parsing/embedding happens before the transaction. Compare
    // the state observed before that work with the now-serialized DB state so
    // two indexers cannot both commit the same continuation indices.
    const currentIndexRecord = getIndexRecord(db, sourcePath);
    if (!sameIndexRecord(expectedIndexRecord, currentIndexRecord)) {
      throw new Error(`Transcript index state changed concurrently for ${sourcePath}`);
    }

    if (replaceSource) deleteSourceChunks(db, sourcePath);

    // Source-scoped IDs prevent distinct transcript paths with the same native
    // session ID from sharing a primary key. A conflict is therefore corruption
    // or a broken concurrency invariant and must fail closed.
    const insertChunk = db.prepare(`
      INSERT INTO chunks
        (id, brain_id, project, session_id, timestamp, turn_type, content, token_count, chunk_meta, syncable, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      insertChunk.run(
        chunk.id,
        brainId,
        project,
        sessionId,
        chunk.timestamp_ms ?? 0,
        'mixed',
        chunk.content,
        chunk.token_count,
        JSON.stringify(chunk.chunk_meta),
        Math.max(syncable, inheritedSyncable),
        embeddings[i] ?? preservedEmbeddings.get(chunk.content) ?? null,
      );
    }

    // Appends change the source-wide total. Backfill every old and new row in
    // the same transaction so consumers never observe mixed totals.
    const allSourceChunks = getSourceChunks(db, sourcePath, sessionId);
    const updateMeta = db.prepare('UPDATE chunks SET chunk_meta = ? WHERE id = ?');
    for (const row of allSourceChunks) {
      let meta;
      try { meta = JSON.parse(row.chunk_meta ?? '{}'); }
      catch { meta = {}; }
      meta.total_chunks_in_session = allSourceChunks.length;
      updateMeta.run(JSON.stringify(meta), row.id);
    }

    // Upsert transcript_index using the canonical brain DB v3/v4 schema.
    const persistedCount = allSourceChunks.length;
    writeIndexRecord(db, {
      sourcePath, contentHash, byteOffset: newByteOffset, sessionId, project,
      chunkCount: persistedCount,
      lastError: parsed.invalid
        ? parsed.partial
          ? 'Invalid or partial JSON remains unread after consumed prefix'
          : 'Malformed JSONL records were skipped'
        : null,
    });
  })();

  return { inserted: chunks.length, skipped: false };
}

// ── CLI entry point ────────────────────────────────────────────────────────

/**
 * Parse flags for `agentbootup brain index-transcripts`.
 * @param {string[]} argv
 */
function parseIndexArgs(argv) {
  let target = process.cwd();
  let dryRun = false;
  let verbose = false;
  let force = false;
  let syncTranscripts = false;
  let embed = false;
  let yes = false;
  let maxSessions = null;
  let maxAgeDays = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) { target = argv[++i]; }
    else if (argv[i] === '--dry-run') { dryRun = true; }
    else if (argv[i] === '--verbose') { verbose = true; }
    else if (argv[i] === '--force') { force = true; }
    else if (argv[i] === '--sync-transcripts') { syncTranscripts = true; }
    else if (argv[i] === '--embed') { embed = true; }
    else if (argv[i] === '--yes') { yes = true; }
    else if (argv[i] === '--max-sessions' && argv[i + 1] !== undefined) {
      const n = parseInt(argv[++i], 10);
      maxSessions = (!isNaN(n) && n > 0) ? n : null;
    }
    else if (argv[i] === '--max-age' && argv[i + 1] !== undefined) {
      const n = parseFloat(argv[++i]);
      maxAgeDays = (!isNaN(n) && n > 0) ? n : null;
    }
  }

  return { target, dryRun, verbose, force, syncTranscripts, embed, yes, maxSessions, maxAgeDays };
}

/**
 * Resolve the identity declared by the target project through the canonical
 * project identity boundary. Global CLI configuration is intentionally not a
 * fallback because it may name a different tenant.
 */
export function resolveIndexTargetIdentity(target) {
  const brainId = resolveProjectAgentId(path.resolve(target));
  if (!isValidBrainId(brainId)) {
    throw new Error(`Target project declares an invalid brain ID: ${JSON.stringify(brainId)}`);
  }
  return brainId;
}

/**
 * `agentbootup brain index-transcripts` — main CLI entry point.
 *
 * @param {string[]} argv - argv slice starting after 'index-transcripts'
 */
export async function runIndexTranscripts(argv) {
  const { target, dryRun, verbose, force, syncTranscripts, embed, yes, maxSessions, maxAgeDays } = parseIndexArgs(argv);

  // bun:sqlite is Bun-only. Fail fast before any I/O if run under Node.js.
  if (typeof Bun === 'undefined') {
    console.error('[index-transcripts] ERROR: brain index-transcripts requires Bun. Run: bun bootup.mjs brain index-transcripts');
    process.exitCode = 1;
    return;
  }

  // Resolve identity from the target itself. Never fall back to the global
  // configured brain ID: --target is a tenant boundary.
  let brainId;
  try {
    brainId = resolveIndexTargetIdentity(target);
  } catch (err) {
    console.error(`Error: unable to resolve target project identity: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Locate brain.db. A dry-run may operate without persistent index state; in
  // that case an in-memory canonical schema provides a full-read simulation.
  const dbPath = path.join(path.resolve(target), '.brain', 'brain.db');
  if (!dryRun && !fs.existsSync(dbPath)) {
    console.error(`Error: brain.db not found at ${dbPath}`);
    console.error('Run `agentbootup brain restore` first to set up brain.db.');
    process.exitCode = 1;
    return;
  }

  if (dryRun) console.log('[index-transcripts] dry-run mode — no writes');
  if (syncTranscripts) console.log('[index-transcripts] --sync-transcripts: chunks will be marked syncable=1');

  // Initialise embedder if --embed requested.
  let embedFn = null;
  if (embed) {
    const ok = await ensureEmbedderInstalled({ yes });
    if (!ok) {
      console.error('[index-transcripts] --embed requested but embedder not available — aborting');
      process.exitCode = 1;
      return;
    }
    embedFn = await getEmbedder();
    console.log('[index-transcripts] --embed: generating embeddings for all chunks');
  }

  // Canonical brain.db contains libsql_vector_idx expression indexes, so every
  // persistent write uses libSQL. Bun SQLite can safely query that schema and
  // provides the enforced readonly mode required by dry-run.
  const { Database: BunDatabase } = await import('bun:sqlite');
  const LibsqlDatabase = dryRun ? null : (await import('libsql')).default;
  let db;
  if (dryRun && !fs.existsSync(dbPath)) {
    console.log('[index-transcripts] no brain.db found — simulating a full read with ephemeral index state');
    db = createDryRunDatabase(BunDatabase);
  } else if (dryRun) {
    db = new BunDatabase(dbPath, { readonly: true });
  } else {
    db = new LibsqlDatabase(dbPath);
  }
  if (!hasCanonicalTranscriptIndexSchema(db)) {
    db.close();
    if (dryRun) {
      console.error('[index-transcripts] legacy brain.db schema detected; dry-run cannot safely simulate existing index state');
    } else {
      console.error('[index-transcripts] legacy brain.db schema detected; indexing was not started');
    }
    console.error(`Run \`agentbootup brain-db migrate --cwd ${path.resolve(target)}\` first, then retry.`);
    process.exitCode = 1;
    return;
  }

  // Discover transcripts.
  const allTranscripts = discoverTranscripts({ maxSessions, maxAgeDays });

  // Project-scope filter: only index transcripts belonging to this repo.
  // project field is path.basename(projectDir) which uses Claude's encoding:
  //   /Users/kefentse/dev_env/agentbootup → -Users-kefentse-dev-env-agentbootup
  const repoProject = encodeProjectPath(target);
  const transcripts = allTranscripts.filter((t) => t.project === repoProject);

  if (transcripts.length === 0 && allTranscripts.length > 0) {
    console.log(`[index-transcripts] no transcripts for this project (${repoProject})`);
    console.log(`[index-transcripts] ${allTranscripts.length} transcript(s) from other projects skipped`);
    db.close();
    return;
  }

  if (transcripts.length === 0) {
    console.log('[index-transcripts] no transcripts found');
    db.close();
    return;
  }

  const skippedOther = allTranscripts.length - transcripts.length;
  console.log(`[index-transcripts] found ${transcripts.length} transcript(s) for this project` +
    (skippedOther > 0 ? ` (${skippedOther} from other projects skipped)` : ''));

  if (force) {
    console.log(`[index-transcripts] --force${dryRun ? ' --dry-run' : ''}: full-read ${transcripts.length} selected source(s)`);
  }

  // Persistent batch indexing validates/rebuilds once before any file can
  // write. The private capability passed below prevents an O(all postings)
  // integrity scan for each selected transcript while preserving the default
  // direct indexFile safety boundary.
  let ftsPreflight = null;
  if (!dryRun) {
    try {
      ensureCanonicalTranscriptFtsIndex(db, { brainId });
      ftsPreflight = INDEX_BATCH_FTS_PREFLIGHT;
    } catch (err) {
      db.close();
      console.error(`[index-transcripts] FTS preflight failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const { sourcePath, sourceCli, sessionId, project } of transcripts) {
    try {
      const { inserted, skipped } = await indexFile(db, {
        sourcePath, sourceCli, sessionId, project, brainId,
        syncTranscripts, dryRun, verbose, force, embedFn, ftsPreflight,
      });
      if (skipped) {
        totalSkipped++;
      } else {
        totalInserted += inserted;
      }
    } catch (err) {
      totalFailed++;
      console.error(`  [error] ${path.basename(sourcePath)}: ${err.message}`);
    }
  }

  db.close();

  const action = dryRun ? 'would index' : 'indexed';
  console.log(
    `[index-transcripts] ${action}: ${totalInserted} chunks across ` +
    `${transcripts.length - totalSkipped} session(s), ` +
    `skipped: ${totalSkipped} (unchanged)`
  );

  // FR-3: After a --sync-transcripts write, signal the daemon to sync immediately.
  if (syncTranscripts && !dryRun && totalInserted > 0) {
    triggerDaemonSync(brainId, verbose);
  }

  // Individual files are isolated so healthy sessions still index, but the
  // command itself must fail after the DB is closed. This propagates through
  // the Bun child-process boundary used by daemon startup.
  if (totalFailed > 0) {
    console.error(`[index-transcripts] failed: ${totalFailed} transcript(s)`);
    process.exitCode = 1;
  }
}

/**
 * Send SIGUSR1 to the brain-db-sync daemon for `brainId` to trigger an
 * immediate sync. Fire-and-forget — does not await sync completion.
 *
 * Guards:
 * - POSIX-signal guard: SIGUSR1 is not a valid Windows signal; calling
 *   process.kill(pid, 'SIGUSR1') on Windows throws ERR_UNKNOWN_SIGNAL.
 *   isProcessAlive() uses process.kill(pid, 0) which returns true on Windows
 *   even when the process exists — it is NOT a safe Windows guard.
 *   An explicit platform check must come first.
 *
 * @param {string} brainId
 * @param {boolean} [verbose]
 */
function triggerDaemonSync(brainId, verbose = false) {
  const result = signalDaemonByPidFile(`brain-db-sync-${brainId}`, { signal: 'SIGUSR1' });
  if (result.signaled) {
    if (verbose) console.log(`[index-transcripts] sent SIGUSR1 to brain-db-sync (PID ${result.pid})`);
    return;
  }
  const unexpectedSignalFailure =
    result.code === 'signal-failed' &&
    result.errorCode !== 'ESRCH' &&
    result.errorCode !== 'EPERM';
  if (unexpectedSignalFailure || verbose) {
    if (result.code === 'windows-unsupported') {
      console.log('[index-transcripts] SIGUSR1 sync skipped — Windows does not support POSIX signals');
    } else if (unexpectedSignalFailure) {
      console.warn(`[index-transcripts] ${result.reason}`);
    } else {
      console.log(`[index-transcripts] ${result.reason}`);
    }
  }
}
