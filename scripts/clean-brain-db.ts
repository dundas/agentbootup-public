/**
 * scripts/clean-brain-db.ts
 *
 * Delete foreign chunks from a brain.db — keeps only chunks whose `project`
 * column matches the encoded path of the repo the brain.db lives in.
 *
 * Usage:
 *   bun scripts/clean-brain-db.ts <repo-path>
 *   bun scripts/clean-brain-db.ts  # defaults to cwd
 *
 * Encoding convention (mirrors Claude Code's project-dir naming):
 *   /Users/kefentse/dev_env/agentbootup → -Users-kefentse-dev-env-agentbootup
 */

import path from 'path';
import fs from 'fs';
import { Database } from 'bun:sqlite';
import { encodeProjectPath } from '../lib/brain/project-path.js';

async function main() {
  const repoPath = process.argv[2] ?? process.cwd();
  const absRepo = path.resolve(repoPath);
  const dbPath = path.join(absRepo, '.brain', 'brain.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`[clean-brain-db] No brain.db found at ${dbPath}`);
    process.exit(1);
  }

  const encoded = encodeProjectPath(absRepo);
  console.log(`[clean-brain-db] Repo:    ${absRepo}`);
  console.log(`[clean-brain-db] Encoded: ${encoded}`);

  const db = new Database(dbPath, { readwrite: true });

  // Count before
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));

  const chunksBefore = tables.has('chunks')
    ? (db.prepare('SELECT COUNT(*) as n FROM chunks').get() as { n: number }).n : 0;
  const indexBefore = tables.has('transcript_index')
    ? (db.prepare('SELECT COUNT(*) as n FROM transcript_index').get() as { n: number }).n : 0;
  const foreignChunks = tables.has('chunks')
    ? (db.prepare('SELECT COUNT(*) as n FROM chunks WHERE project != ?').get(encoded) as { n: number }).n : 0;
  // transcript_index has no project column — filter by source_path containing the encoded project name.
  // Escape LIKE metacharacters in encoded (% and _) to prevent path components from broadening the match.
  // '\\' in JS = single backslash passed to SQLite as the ESCAPE char
  const encodedLike = encoded.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const foreignIndex = tables.has('transcript_index')
    ? (db.prepare("SELECT COUNT(*) as n FROM transcript_index WHERE source_path NOT LIKE ? ESCAPE '\\'").get(`%${encodedLike}%`) as { n: number }).n : 0;

  console.log(`[clean-brain-db] chunks: ${chunksBefore} total, ${foreignChunks} foreign`);
  console.log(`[clean-brain-db] transcript_index: ${indexBefore} total, ${foreignIndex} foreign`);

  if (foreignChunks === 0 && foreignIndex === 0) {
    console.log('[clean-brain-db] Already clean — nothing to delete.');
    db.close();
    return;
  }

  // Delete foreign rows
  db.transaction(() => {
    if (tables.has('chunks')) db.prepare('DELETE FROM chunks WHERE project != ?').run(encoded);
    if (tables.has('transcript_index')) db.prepare("DELETE FROM transcript_index WHERE source_path NOT LIKE ? ESCAPE '\\'").run(`%${encodedLike}%`);
  })();

  // Count after — mirror the same table guards as pre-deletion counts
  const chunksAfter = tables.has('chunks')
    ? (db.prepare('SELECT COUNT(*) as n FROM chunks').get() as { n: number }).n : 0;
  const indexAfter = tables.has('transcript_index')
    ? (db.prepare('SELECT COUNT(*) as n FROM transcript_index').get() as { n: number }).n : 0;

  console.log(`[clean-brain-db] Deleted ${foreignChunks} foreign chunk(s), ${foreignIndex} foreign index row(s)`);
  console.log(`[clean-brain-db] Remaining: ${chunksAfter} chunks, ${indexAfter} index rows`);

  // VACUUM to reclaim disk space
  console.log('[clean-brain-db] Running VACUUM...');
  db.run('VACUUM');
  console.log('[clean-brain-db] Done.');
  db.close();
}

main().catch((err) => {
  console.error('[clean-brain-db] Fatal:', err.message);
  process.exit(1);
});
