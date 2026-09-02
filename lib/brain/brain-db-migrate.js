/**
 * brain.db schema migrations (v1 → v2 → v3 → v4).
 * Used by lib/daemon/brain-db-sync.mjs after applySchema().
 */

import fs from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { readCredentials } from '../auth/credentials.js';
import { isValidServerUrl } from '../auth/validate.js';
import { uploadBrainDbBackupToMechPlane } from './brain-db-backup-upload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Re-apply the canonical v3 SQL template (idempotent). Ensures skill-index tables
 * and meta INSERT OR IGNORE rows exist even when migrate runs without a prior
 * full apply (tests) or when apply partially failed before migrate.
 * @param {import('@libsql/client').Client} db
 */
export async function reapplyCanonicalTemplate(db) {
  const schemaPath = path.join(__dirname, '../../templates/brain/brain-schema.sql');
  const sql = await readFile(schemaPath, 'utf-8');
  if (typeof db.executeMultiple !== 'function') {
    throw new Error('reapplyCanonicalTemplate requires db.executeMultiple');
  }
  await db.executeMultiple(sql);
}

/**
 * @param {import('@libsql/client').Client} db
 * @returns {Promise<number>}
 */
export async function readSchemaVersion(db) {
  try {
    const result = await db.execute(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    );
    return parseInt(result.rows?.[0]?.value ?? '1', 10);
  } catch {
    return 1;
  }
}

/**
 * @param {import('@libsql/client').Client} db
 */
async function migrateV1ToV2(db, log) {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    const cols = await db.execute('PRAGMA table_info(chunks)');
    const colNames = new Set((cols.rows ?? []).map((r) => r.name));

    if (!colNames.has('chunk_meta')) {
      await db.execute('ALTER TABLE chunks ADD COLUMN chunk_meta TEXT');
      log('Migration v1→v2: added chunk_meta column to chunks');
    }
    if (!colNames.has('syncable')) {
      await db.execute(
        'ALTER TABLE chunks ADD COLUMN syncable INTEGER NOT NULL DEFAULT 0',
      );
      log('Migration v1→v2: added syncable column to chunks');
    }

    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_chunks_syncable ON chunks(syncable) WHERE syncable = 1',
    );

    await db.execute(
      "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1')",
    );
    await db.execute(
      "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('updated_at', date('now'))",
    );
    await db.execute(
      "UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'",
    );
    await db.execute(
      "UPDATE schema_meta SET value = date('now') WHERE key = 'updated_at'",
    );
    log('Migration v1→v2 complete');
  } catch (err) {
    log(`Migration v1→v2 failed: ${err.message}`);
  }
}

/**
 * Rebuild chunks (384-dim embedding), transcript_index (v3 shape), FTS; stamp v3 meta.
 *
 * SQLite/libSQL does not treat all DDL as atomic inside a single transaction; a crash
 * mid-migration can leave the DB inconsistent. Recovery is **FR-10** (pre-migrate backup
 * — Task 2.3) plus re-run. We do not wrap this entire sequence in BEGIN/COMMIT because
 * FTS/virtual-table steps and libSQL batching vary by version.
 *
 * @param {import('@libsql/client').Client} db
 */
async function migrateV2ToV3(db, log) {
  log('Migration v2→v3: rebuilding chunks, transcript_index, and transcript FTS');

  await db.execute('DROP TRIGGER IF EXISTS chunks_ai');
  await db.execute('DROP TRIGGER IF EXISTS chunks_ad');
  await db.execute('DROP TRIGGER IF EXISTS chunks_au');
  await db.execute('DROP TABLE IF EXISTS chunks_fts');

  await db.execute(`
    CREATE TABLE chunks__v3 (
      id          TEXT    PRIMARY KEY,
      brain_id    TEXT    NOT NULL,
      project     TEXT    NOT NULL,
      session_id  TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL,
      turn_type   TEXT,
      content     TEXT    NOT NULL,
      token_count INTEGER,
      embedding   F32_BLOB(384),
      chunk_meta  TEXT,
      syncable    INTEGER NOT NULL DEFAULT 0
    )
  `);

  const chunkCols = await db.execute('PRAGMA table_info(chunks)');
  const colNames = new Set((chunkCols.rows ?? []).map((r) => r.name));
  const turnSel = colNames.has('turn_type') ? 'turn_type' : 'NULL';
  const tokenSel = colNames.has('token_count') ? 'token_count' : 'NULL';
  const metaSel = colNames.has('chunk_meta') ? 'chunk_meta' : 'NULL';
  const syncSel = colNames.has('syncable') ? 'syncable' : '0';

  await db.execute(`
    INSERT INTO chunks__v3 (
      id, brain_id, project, session_id, timestamp, turn_type, content, token_count, embedding, chunk_meta, syncable
    )
    SELECT
      id, brain_id, project, session_id, timestamp, ${turnSel}, content, ${tokenSel}, NULL, ${metaSel}, ${syncSel}
    FROM chunks
  `);

  await db.execute('DROP TABLE chunks');
  await db.execute('ALTER TABLE chunks__v3 RENAME TO chunks');

  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_chunks_brain_time ON chunks(brain_id, timestamp)',
  );
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id)',
  );
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_chunks_syncable ON chunks(syncable) WHERE syncable = 1',
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_chunks_vector ON chunks(libsql_vector_idx(embedding, 'metric=cosine'))",
  );

  await db.execute(`
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content,
      project,
      session_id,
      content='chunks',
      content_rowid='rowid'
    )
  `);

  await db.execute(`
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END
  `);
  await db.execute(`
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
    END
  `);
  await db.execute(`
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END
  `);

  await db.execute(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);

  const pragma = await db.execute('PRAGMA table_info(transcript_index)');
  const cols = new Set((pragma.rows ?? []).map((r) => r.name));
  if (cols.size === 0) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS transcript_index (
        source_path     TEXT PRIMARY KEY,
        content_hash    TEXT NOT NULL,
        byte_offset     INTEGER NOT NULL DEFAULT 0,
        indexed_at      INTEGER NOT NULL,
        session_id      TEXT,
        project         TEXT,
        chunk_count     INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT
      )
    `);
  } else if (cols.has('source_cli') && cols.has('last_byte_offset')) {
    await db.execute(`
      CREATE TABLE transcript_index__v3 (
        source_path     TEXT PRIMARY KEY,
        content_hash    TEXT NOT NULL,
        byte_offset     INTEGER NOT NULL DEFAULT 0,
        indexed_at      INTEGER NOT NULL,
        session_id      TEXT,
        project         TEXT,
        chunk_count     INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT
      )
    `);
    // content_hash 'migrated-v2' is a sentinel (not a file hash). Indexer should force re-read (document when transcript_indexer lands).
    await db.execute(`
      INSERT INTO transcript_index__v3 (
        source_path, content_hash, byte_offset, indexed_at, session_id, project, chunk_count, last_error
      )
      SELECT
        source_path,
        'migrated-v2',
        last_byte_offset,
        indexed_at,
        session_id,
        '',
        chunk_count,
        NULL
      FROM transcript_index
    `);
    await db.execute('DROP TABLE transcript_index');
    await db.execute('ALTER TABLE transcript_index__v3 RENAME TO transcript_index');
  }

  // Full template: skill tables + INSERT OR IGNORE meta keys (stamping v3 happens next).
  await reapplyCanonicalTemplate(db);

  await stampV3SchemaMeta(db);

  log('Migration v2→v3 complete');
}

/**
 * @param {import('@libsql/client').Client} db
 */
export async function stampV3SchemaMeta(db) {
  const rows = [
    ['schema_version', '3'],
    ['brain_db_role', 'runtime-local'],
    ['transcript_embedding_dim', '384'],
    ['transcript_embedding_model', 'Xenova/all-MiniLM-L6-v2'],
    ['skill_index_version', '1'],
    ['skill_embedding_dim', '384'],
    ['skill_embedding_model', 'Xenova/all-MiniLM-L6-v2'],
    ['updated_at', new Date().toISOString().slice(0, 10)],
  ];
  for (const [k, v] of rows) {
    await db.execute({
      sql: 'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
      args: [k, v],
    });
  }
}

/**
 * @param {import('@libsql/client').Client} db
 */
export async function stampV4SchemaMeta(db) {
  const rows = [
    ['schema_version', '4'],
    ['memory_schema_version', '1'],
    ['updated_at', new Date().toISOString().slice(0, 10)],
  ];
  for (const [k, v] of rows) {
    await db.execute({
      sql: 'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
      args: [k, v],
    });
  }
}

/**
 * v4 is additive: canonical memory tables plus schema metadata.
 *
 * @param {import('@libsql/client').Client} db
 */
async function migrateV3ToV4(db, log) {
  log('Migration v3→v4: adding canonical memory tables');
  await reapplyCanonicalTemplate(db);
  await stampV4SchemaMeta(db);
  log('Migration v3→v4 complete');
}

/**
 * FR-10: upload brain.db to mech-plane before any structural migration when an on-disk
 * path is known. Skipped for in-memory DBs (no file path), when opts.skipBackup, or when
 * AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP=1.
 *
 * @param {import('@libsql/client').Client} db
 * @param {number} version
 * @param {{ brainDbFilePath?: string, brainId?: string, skipBackup?: boolean }} opts
 * @param {(m: string) => void} log
 * @param {(m: string) => void} logError
 */
async function ensurePreMigrateRemoteBackup(db, version, opts, log, logError) {
  if (version >= 4) return;
  if (opts.skipBackup === true) return;
  if (process.env.AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP === '1') {
    log('Skipping brain.db remote backup (AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP=1)');
    return;
  }
  const brainDbPath = opts.brainDbFilePath;
  if (!brainDbPath || !fs.existsSync(brainDbPath)) {
    log('Skipping brain.db remote backup: no on-disk path (in-memory or tests)');
    return;
  }

  const creds = await readCredentials();
  if (!creds?.apiKey || !creds?.serverUrl || !isValidServerUrl(creds.serverUrl)) {
    const msg =
      'brain.db migration requires remote backup (FR-10): run `agentbootup auth login`, or set AGENTBOOTUP_SKIP_BRAIN_DB_BACKUP=1 after copying brain.db locally (not recommended)';
    logError(msg);
    throw new Error(msg);
  }

  const brainId = opts.brainId && String(opts.brainId).trim() ? opts.brainId : 'unknown';
  if (brainId === 'unknown') {
    log(
      'Warning: brain_id missing — backup will be stored under brain-db-backup/unknown/ (set agent_id in agentbootup.json or pass brain id)',
    );
  }
  log(`Uploading brain.db snapshot before migration (${brainId})...`);
  try {
    await db.execute('PRAGMA wal_checkpoint(FULL)');
  } catch {
    /* best-effort flush before read */
  }

  const result = await uploadBrainDbBackupToMechPlane({
    brainDbPath,
    brainId,
    serverUrl: creds.serverUrl,
    apiKey: creds.apiKey,
  });
  if (!result.ok) {
    const msg = `brain.db backup upload failed: ${result.error}`;
    logError(msg);
    throw new Error(msg);
  }
  log(`Remote backup: ${result.remotePath}`);
}

/**
 * Ordered migrations for embedded brain.db (libSQL).
 *
 * @param {import('@libsql/client').Client} db
 * @param {{
 *   log?: (msg: string) => void,
 *   error?: (msg: string) => void,
 *   brainDbFilePath?: string,
 *   brainId?: string,
 *   skipBackup?: boolean,
 * }} [opts]
 */
export async function runBrainDbMigrations(db, opts = {}) {
  const log = opts.log ?? ((m) => process.stdout.write(`[brain-db-migrate] ${m}\n`));
  const logError = opts.error ?? ((m) => process.stderr.write(`[brain-db-migrate] ERROR ${m}\n`));

  try {
    await db.execute('PRAGMA foreign_keys = ON');
  } catch {
    /* non-fatal */
  }

  let version = await readSchemaVersion(db);

  // ensurePreMigrateRemoteBackup logs via logError before throwing; do not log again here
  await ensurePreMigrateRemoteBackup(db, version, opts, log, logError);

  if (version < 2) {
    await migrateV1ToV2(db, log);
    version = await readSchemaVersion(db);
  }

  if (version === 2) {
    try {
      await migrateV2ToV3(db, log);
      version = await readSchemaVersion(db);
    } catch (err) {
      logError(`Migration v2→v3 failed: ${err?.message ?? String(err)}`);
    }
  }

  if (version === 3) {
    try {
      await migrateV3ToV4(db, log);
    } catch (err) {
      logError(`Migration v3→v4 failed: ${err?.message ?? String(err)}`);
    }
  }
}
