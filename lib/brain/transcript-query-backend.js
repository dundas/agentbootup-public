/**
 * Brain.db-backed transcript query backend.
 *
 * Provides FTS5-indexed search, session listing, and session detail retrieval
 * against a local brain.db (bun:sqlite / libSQL schema v2).
 *
 * Exported separately from the skill CLI so tests can import without side-effects.
 *
 * **Bun-only**: Uses `bun:sqlite` which is not available in Node.js.
 * This module requires Bun as the JavaScript runtime.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { cosineSimilarity, bufferToVec, EMBED_DIM } from './embedder.js';

/**
 * Detect whether a brain.db with schema v2 (chunks_fts table) is available.
 * @param {string} targetPath - Project root directory
 * @returns {{ available: boolean, dbPath: string }}
 */
export function detectBrainDb(targetPath) {
  const dbPath = join(targetPath, '.brain', 'brain.db');
  if (!existsSync(dbPath)) return { available: false, dbPath };
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'"
    ).get();
    return { available: !!row, dbPath };
  } catch {
    return { available: false, dbPath };
  } finally {
    db?.close();
  }
}

/**
 * Open brain.db for querying. Returns a Database instance or null on failure.
 * @param {string} dbPath
 * @returns {import('bun:sqlite').Database | null}
 */
export function openBrainDb(dbPath) {
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err) {
    process.stderr.write(`[transcript-query] openBrainDb failed for ${dbPath}: ${err.message}\n`);
    return null;
  }
}

/**
 * FTS5-backed transcript search backend.
 * Wraps a bun:sqlite Database with typed query methods.
 *
 * **Note on search phrase semantics**: `search()` wraps the keyword in FTS5
 * double-quotes, producing a *phrase query* — words must appear adjacent and
 * in order. For single-word searches this behaves as an exact token match.
 * For multi-word queries, use single words or rely on the phrase match behavior.
 */
export class BrainDbTranscriptBackend {
  /**
   * @param {import('bun:sqlite').Database} db - Must be a non-null Database
   *   instance. Check the return value of openBrainDb() before constructing.
   */
  constructor(db) {
    if (!db) throw new TypeError('[BrainDbTranscriptBackend] db must be a non-null Database instance');
    this.db = db;
  }

  /**
   * Keyword search via FTS5.
   * @param {string} keyword
   * @param {string|null} brainId - When null, queries across ALL tenants (all brain_id values).
   *   Pass an explicit brainId to restrict results to a single tenant.
   * @param {{ limit?: number, since?: string, until?: string }} opts
   *   since/until accept ISO date strings (e.g. "2026-03-01"). Parsed as UTC midnight.
   *   until is end-of-day inclusive: extended by +24h so "2026-03-16" matches all
   *   timestamps on that UTC calendar day.
   */
  search(keyword, brainId, opts = {}) {
    const limit = opts.limit ?? 20;
    // Escape FTS5 special chars: wrap in double-quotes for phrase query.
    // Internal double-quotes doubled per FTS5 spec.
    const escaped = `"${keyword.replace(/"/g, '""')}"`;

    const conditions = ['chunks_fts MATCH ?'];
    const params = [escaped];

    if (brainId) { conditions.push('c.brain_id = ?'); params.push(brainId); }
    if (opts.since) {
      const t = new Date(opts.since).getTime();
      if (!isNaN(t)) { conditions.push('c.timestamp >= ?'); params.push(t); }
    }
    if (opts.until) {
      const t = new Date(opts.until).getTime();
      if (!isNaN(t)) { conditions.push('c.timestamp <= ?'); params.push(t + 86400000); }
    }

    params.push(limit);
    const where = conditions.join(' AND ');
    const sql = `SELECT c.id, c.session_id, c.project, c.timestamp, c.content, c.chunk_meta
                   FROM chunks_fts
                   JOIN chunks c ON chunks_fts.rowid = c.rowid
                  WHERE ${where}
                  ORDER BY c.timestamp DESC LIMIT ?`;
    return this.db.query(sql).all(...params);
  }

  /**
   * List sessions grouped by session_id.
   * @param {string|null} brainId
   * @param {{ limit?: number, since?: string, until?: string }} opts
   *   since/until accept ISO date strings (e.g. "2026-03-01"). Dates are
   *   parsed as **UTC midnight** by JavaScript's Date constructor. `until` is
   *   end-of-day inclusive: extended by +24h so "2026-03-16" matches all
   *   timestamps on that UTC calendar day.
   */
  listSessions(brainId, opts = {}) {
    const limit = opts.limit ?? 20;
    const conditions = [];
    const params = [];
    if (brainId) { conditions.push('brain_id = ?'); params.push(brainId); }
    if (opts.since) {
      const t = new Date(opts.since).getTime();
      if (!isNaN(t)) { conditions.push('timestamp >= ?'); params.push(t); }
    }
    if (opts.until) {
      const t = new Date(opts.until).getTime();
      if (!isNaN(t)) { conditions.push('timestamp <= ?'); params.push(t + 86400000); }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    return this.db.query(`
      SELECT session_id, project,
             MIN(timestamp) AS started_at, MAX(timestamp) AS ended_at,
             COUNT(*) AS chunk_count
        FROM chunks ${where}
       GROUP BY session_id
       ORDER BY started_at DESC LIMIT ?`).all(...params);
  }

  /**
   * Get all chunks for a session, ordered by timestamp.
   * Embedding blobs are excluded to avoid loading large vector data.
   * @param {string} sessionId
   */
  getSession(sessionId) {
    return this.db.query(
      `SELECT id, brain_id, session_id, project, timestamp, turn_type,
              content, token_count, syncable, chunk_meta
         FROM chunks WHERE session_id = ? ORDER BY timestamp`
    ).all(sessionId);
  }

  /**
   * Check whether any chunks in the db have embeddings stored.
   * Use this to gate the --semantic search path with a helpful error message.
   * @returns {boolean}
   */
  hasEmbeddings() {
    const row = this.db.query('SELECT 1 FROM chunks WHERE embedding IS NOT NULL LIMIT 1').get();
    return !!row;
  }

  /**
   * Semantic vector search — cosine similarity over stored embeddings.
   *
   * Loads all embedding BLOBs from chunks (filtered by brainId/since/until),
   * computes cosine similarity against queryVec, returns top-K results.
   *
   * Complexity: O(n) over chunks with embeddings. Fast for n < 100k.
   * For larger corpora, replace with sqlite-vec ANN index.
   *
   * Both vectors must be unit-normalised (index-transcripts --embed uses
   * normalize=true). For normalised vectors cosine similarity = dot product.
   *
   * @param {Float32Array} queryVec - Query embedding (384d, unit-normalised)
   * @param {string|null} brainId
   * @param {{ limit?: number, since?: string, until?: string }} opts
   * @returns {Array<{ id, session_id, project, timestamp, content, chunk_meta, score }>}
   */
  vectorSearch(queryVec, brainId, opts = {}) {
    const limit = opts.limit ?? 10;

    const conditions = ['embedding IS NOT NULL'];
    const params = [];
    if (brainId) { conditions.push('brain_id = ?'); params.push(brainId); }
    if (opts.since) {
      const t = new Date(opts.since).getTime();
      if (!isNaN(t)) { conditions.push('timestamp >= ?'); params.push(t); }
    }
    if (opts.until) {
      const t = new Date(opts.until).getTime();
      if (!isNaN(t)) { conditions.push('timestamp <= ?'); params.push(t + 86400000); }
    }

    const where = conditions.length ? conditions.join(' AND ') : '1=1';

    // Guard against loading excessive embeddings into memory.
    // 50k chunks × 1.5 KB = ~75 MB; 100k = ~150 MB heap spike.
    const WARN_THRESHOLD = 50_000;
    const countRow = this.db.query(
      `SELECT COUNT(*) AS n FROM chunks WHERE ${where}`
    ).get(...params);
    const candidateCount = countRow?.n ?? 0;
    if (candidateCount > WARN_THRESHOLD) {
      process.stderr.write(
        `[vectorSearch] warning: ${candidateCount} candidate chunks — loading all embeddings ` +
        `(~${Math.round(candidateCount * EMBED_DIM * 4 / 1_000_000)} MB). ` +
        `Use --since/--until or --limit to narrow the search.\n`
      );
    }

    const rows = this.db.query(
      `SELECT id, brain_id, session_id, project, timestamp, content, chunk_meta, embedding
         FROM chunks WHERE ${where}`
    ).all(...params);

    // Score each row; skip rows with dimension mismatch or corrupt blobs.
    const scored = rows.flatMap((row) => {
      try {
        const vec = bufferToVec(row.embedding);
        if (vec.length !== queryVec.length) return []; // dimension mismatch — different model
        const score = cosineSimilarity(queryVec, vec);
        const { embedding: _drop, ...rest } = row;
        return [{ ...rest, score }];
      } catch {
        return []; // corrupt blob — skip silently
      }
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  close() { this.db.close(); }
}
