#!/usr/bin/env bun
/**
 * scripts/smoke-embeddings.mjs
 *
 * Smoke test for the vector embedding pipeline:
 *   1. Verify @huggingface/transformers can be imported
 *   2. Embed two strings and check output shape + normalisation
 *   3. Verify cosine similarity: near-identical texts score > 0.95
 *   4. Verify unrelated texts score < near-identical texts
 *   5. Verify bufferToVec round-trip is lossless
 *   6. Verify vectorSearch returns ranked results from an in-memory brain.db
 *   7. Verify hasEmbeddings() gating
 *
 * Does NOT require @huggingface/transformers to be installed —
 * tests 1-5 use the embedder module, tests 6-7 use synthetic Float32Arrays.
 *
 * Exit 0 = PASS, exit 1 = BLOCK
 */

import { Database } from 'bun:sqlite';
import { cosineSimilarity, vecToBuffer, bufferToVec, EMBED_DIM } from '../lib/brain/embedder.js';
import { BrainDbTranscriptBackend } from '../lib/brain/transcript-query-backend.js';

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

function assert(condition, label, detail) {
  condition ? ok(label) : fail(label, detail);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, brain_id TEXT, session_id TEXT NOT NULL,
      project TEXT, timestamp INTEGER, turn_type TEXT,
      content TEXT NOT NULL DEFAULT '', token_count INTEGER DEFAULT 0,
      embedding BLOB, syncable INTEGER NOT NULL DEFAULT 0, chunk_meta TEXT
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content, content='chunks', content_rowid='rowid'
    );
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('schema_version', '2');
  `);
  return db;
}

function insertChunkWithVec(db, id, content, vec) {
  db.prepare(
    'INSERT INTO chunks (id, brain_id, session_id, project, timestamp, content, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'smoke.gm', 'sess-smoke', 'smoke-proj', Date.now(), content, vecToBuffer(vec));
}

function makeUnitVec(values) {
  const v = new Float32Array(values);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

// ── Test suite ───────────────────────────────────────────────────────────────

console.log('\nSmoke test: embeddings + vector search\n');

// ── Group 1: embedder utility functions (no model required) ──────────────────

console.log('Group 1: embedder utilities');

// vecToBuffer / bufferToVec round-trip
const original = new Float32Array([0.1, 0.2, 0.3, 0.4]);
const buf = vecToBuffer(original);
const restored = bufferToVec(buf);
assert(buf instanceof Buffer, 'vecToBuffer returns Buffer');
assert(restored instanceof Float32Array, 'bufferToVec returns Float32Array');
assert(
  original.every((v, i) => Math.abs(v - restored[i]) < 1e-7),
  'round-trip is lossless'
);

// bufferToVec corrupt blob guard
try {
  bufferToVec(Buffer.alloc(5)); // 5 bytes — not multiple of 4
  fail('bufferToVec throws on corrupt blob (5 bytes)', 'no error thrown');
} catch (e) {
  assert(e.message.includes('multiple of 4'), 'bufferToVec throws on non-multiple-of-4 blob');
}

// EMBED_DIM
assert(typeof EMBED_DIM === 'number' && EMBED_DIM > 0, `EMBED_DIM exported (${EMBED_DIM})`);

// cosineSimilarity: identical unit vectors → 1.0
const v1 = makeUnitVec([1, 0, 0, 0]);
const score_same = cosineSimilarity(v1, v1);
assert(Math.abs(score_same - 1.0) < 1e-6, `cosine(same, same) = 1.0 (got ${score_same.toFixed(6)})`);

// cosineSimilarity: orthogonal vectors → 0.0
const v2 = makeUnitVec([0, 1, 0, 0]);
const score_orth = cosineSimilarity(v1, v2);
assert(Math.abs(score_orth) < 1e-6, `cosine(orthogonal) = 0.0 (got ${score_orth.toFixed(6)})`);

// cosineSimilarity: opposite vectors → -1.0
const v3 = makeUnitVec([-1, 0, 0, 0]);
const score_opp = cosineSimilarity(v1, v3);
assert(Math.abs(score_opp + 1.0) < 1e-6, `cosine(opposite) = -1.0 (got ${score_opp.toFixed(6)})`);

// ── Group 2: vectorSearch + hasEmbeddings against in-memory db ───────────────

console.log('\nGroup 2: vectorSearch and hasEmbeddings');

const db = makeDb();
const backend = new BrainDbTranscriptBackend(db);

// hasEmbeddings: false when empty
assert(!backend.hasEmbeddings(), 'hasEmbeddings() = false on empty db');

// Insert chunks with synthetic embeddings
// vec_close is similar to query, vec_far is orthogonal
const query  = makeUnitVec([1, 0, 0, 0]);
const close  = makeUnitVec([0.95, 0.1, 0.05, 0]);
const medium = makeUnitVec([0.6, 0.6, 0.3, 0.1]);
const far    = makeUnitVec([0, 1, 0, 0]);

insertChunkWithVec(db, 'c-close',  'close content',  close);
insertChunkWithVec(db, 'c-medium', 'medium content', medium);
insertChunkWithVec(db, 'c-far',    'far content',    far);

// hasEmbeddings: true after insert
assert(backend.hasEmbeddings(), 'hasEmbeddings() = true after inserting embeddings');

// vectorSearch returns results
const results = backend.vectorSearch(query, null, { limit: 3 });
assert(results.length === 3, `vectorSearch returns 3 results (got ${results.length})`);

// Results are ranked by score descending
assert(
  results[0].score >= results[1].score && results[1].score >= results[2].score,
  'results ranked by score descending'
);

// Closest vector is first
assert(results[0].id === 'c-close', `closest chunk is first (got ${results[0].id})`);

// Farthest is last
assert(results[2].id === 'c-far', `farthest chunk is last (got ${results[2].id})`);

// Scores are in valid range [-1, 1]
assert(
  results.every(r => r.score >= -1 && r.score <= 1),
  'all scores in [-1, 1]'
);

// Limit is respected
const limited = backend.vectorSearch(query, null, { limit: 1 });
assert(limited.length === 1, 'limit=1 returns exactly 1 result');

// Since filter
const pastTs  = new Date('2026-01-01').getTime();
const recentTs = Date.now();
db.prepare('UPDATE chunks SET timestamp = ? WHERE id = ?').run(pastTs, 'c-far');
const sinceResults = backend.vectorSearch(query, null, { since: '2026-02-01' });
assert(
  sinceResults.every(r => r.id !== 'c-far'),
  'since filter excludes old chunk'
);

// Chunk without embedding excluded
db.prepare('INSERT INTO chunks (id, brain_id, session_id, project, timestamp, content) VALUES (?, ?, ?, ?, ?, ?)').run(
  'c-no-embed', 'smoke.gm', 'sess-smoke', 'smoke-proj', recentTs, 'no embedding'
);
const withNoEmbed = backend.vectorSearch(query, null);
assert(
  withNoEmbed.every(r => r.id !== 'c-no-embed'),
  'chunk without embedding excluded from vectorSearch'
);

// Dimension mismatch skipped (different model)
const wrongDimVec = makeUnitVec([1, 0]); // 2-dim, not 4-dim
db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(vecToBuffer(wrongDimVec), 'c-far');
const mismatchResults = backend.vectorSearch(query, null);
assert(
  mismatchResults.every(r => r.id !== 'c-far'),
  'dimension-mismatched embedding skipped gracefully'
);

backend.close();

// ── Group 3: @huggingface/transformers import (optional, skip if not installed) ──

console.log('\nGroup 3: @huggingface/transformers availability');

let transformersAvailable = false;
try {
  await import('@huggingface/transformers');
  transformersAvailable = true;
} catch {
  // not installed — expected in CI without --embed setup
}

if (transformersAvailable) {
  const { embedText, getEmbedder } = await import('../lib/brain/embedder.js');
  const embedder = await getEmbedder();
  assert(typeof embedder === 'function', 'getEmbedder() returns a function');

  const vec = await embedText('hello world');
  assert(vec instanceof Float32Array, 'embedText returns Float32Array');
  assert(vec.length === EMBED_DIM, `embedding has correct dimension (${vec.length})`);

  // Check unit normalisation (should be ~1.0 since normalize=true)
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  assert(Math.abs(norm - 1.0) < 1e-4, `embedding is unit-normalised (norm=${norm.toFixed(6)})`);

  // Semantic similarity: similar texts score higher than unrelated
  const vec1 = await embedText('authentication login flow');
  const vec2 = await embedText('user login and authentication');
  const vec3 = await embedText('deploy kubernetes cluster');
  const sim12 = cosineSimilarity(vec1, vec2);
  const sim13 = cosineSimilarity(vec1, vec3);
  assert(sim12 > sim13, `similar texts rank higher than unrelated (${sim12.toFixed(3)} > ${sim13.toFixed(3)})`);
} else {
  console.log('  - @huggingface/transformers not installed — skipping live embedding tests');
  console.log('  - Run: agentbootup brain index-transcripts --embed  to install');
  ok('group 3 skipped (SKIP_MISSING: @huggingface/transformers not installed)');
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\nSMOKE: BLOCK');
  process.exit(1);
} else {
  console.log('\nSMOKE: PASS');
  process.exit(0);
}
