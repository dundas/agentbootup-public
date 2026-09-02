-- templates/brain/brain-schema.sql
-- Canonical brain.db schema for agentbootup (PRD-0014 / FR-07).
-- Source of truth lives in this repo. Provisioning copies the v4 template to:
--   `brain/brain-schema.sql` (committed — human-readable contract per FR-07)
--   `.brain/brain-schema.sql` (runtime mirror for daemons / applySchema)
--
-- Version: 4
-- Updated: 2026-07-12
-- v4: canonical memory tables (memory_events, memory_pages) for capture/refresh.
-- v3: skill index subsystem (skills, skill_docs, FTS), transcript_index shape,
--      chunks.embedding F32_BLOB(384), chunks_fts columns (content, project, session_id).
-- v3 → v4 migrations: lib/brain/brain-db-migrate.js (additive memory tables + meta).
-- v2 → v3 migrations: lib/brain/brain-db-migrate.js (runBrainDbMigrations).
-- v1 → v2: same module (additive columns + index).

-- ─────────────────────────────────────────────────────────
-- Transcript chunks — semantic memory from coding sessions
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
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
);

CREATE INDEX IF NOT EXISTS idx_chunks_brain_time
  ON chunks(brain_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_chunks_session
  ON chunks(session_id);

CREATE INDEX IF NOT EXISTS idx_chunks_syncable
  ON chunks(syncable) WHERE syncable = 1;

CREATE INDEX IF NOT EXISTS idx_chunks_vector
  ON chunks(libsql_vector_idx(embedding, 'metric=cosine'));

-- ─────────────────────────────────────────────────────────
-- Schema version tracking
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────
-- Canonical memory — append-only events + materialized pages
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_events (
  id            TEXT PRIMARY KEY,
  page_path     TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  page_rev      INTEGER NOT NULL,
  machine_id    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_events_page_time
  ON memory_events(page_path, created_at);

CREATE TABLE IF NOT EXISTS memory_pages (
  page_path        TEXT PRIMARY KEY,
  content          TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  rev              INTEGER NOT NULL,
  source_event_id  TEXT NOT NULL,
  machine_id       TEXT,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (source_event_id) REFERENCES memory_events(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_memory_pages_updated_at
  ON memory_pages(updated_at);

-- ─────────────────────────────────────────────────────────
-- Transcript index — per-source incremental indexing state
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transcript_index (
  source_path     TEXT PRIMARY KEY,
  content_hash    TEXT NOT NULL,
  byte_offset     INTEGER NOT NULL DEFAULT 0,
  indexed_at      INTEGER NOT NULL,
  session_id      TEXT,
  project         TEXT,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);

-- ─────────────────────────────────────────────────────────
-- Transcript FTS (v3 column set)
-- ─────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
  USING fts5(
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

-- ─────────────────────────────────────────────────────────
-- Skill registry
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  skill_name          TEXT PRIMARY KEY,
  canonical_cli       TEXT NOT NULL,
  root_path           TEXT NOT NULL,
  title               TEXT,
  description         TEXT,
  category            TEXT,
  tags_json           TEXT,
  trigger_hints       TEXT,
  source_version      TEXT,
  source_version_id   TEXT,
  content_hash        TEXT NOT NULL,
  installed_at        INTEGER NOT NULL,
  indexed_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skills_cli
  ON skills(canonical_cli);

-- ─────────────────────────────────────────────────────────
-- Skill document sections (retrieval units)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_docs (
  id                 TEXT PRIMARY KEY,
  skill_name         TEXT NOT NULL,
  canonical_cli      TEXT NOT NULL,
  source_path        TEXT NOT NULL,
  section_type       TEXT NOT NULL,
  heading            TEXT,
  ordinal            INTEGER NOT NULL DEFAULT 0,
  content            TEXT NOT NULL,
  snippet            TEXT,
  content_hash       TEXT NOT NULL,
  source_version     TEXT,
  source_version_id  TEXT,
  embedding          F32_BLOB(384),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (skill_name) REFERENCES skills(skill_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_skill_docs_skill
  ON skill_docs(skill_name, section_type, ordinal);

CREATE INDEX IF NOT EXISTS idx_skill_docs_cli
  ON skill_docs(canonical_cli, skill_name);

CREATE INDEX IF NOT EXISTS idx_skill_docs_vector
  ON skill_docs(libsql_vector_idx(embedding, 'metric=cosine'));

-- ─────────────────────────────────────────────────────────
-- Skill FTS
-- ─────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS skill_docs_fts
  USING fts5(
    skill_name,
    heading,
    content,
    snippet,
    content='skill_docs',
    content_rowid='rowid'
  );

CREATE TRIGGER IF NOT EXISTS skill_docs_ai AFTER INSERT ON skill_docs BEGIN
  INSERT INTO skill_docs_fts(rowid, skill_name, heading, content, snippet)
  VALUES (new.rowid, new.skill_name, new.heading, new.content, new.snippet);
END;

CREATE TRIGGER IF NOT EXISTS skill_docs_ad AFTER DELETE ON skill_docs BEGIN
  INSERT INTO skill_docs_fts(skill_docs_fts, rowid, skill_name, heading, content, snippet)
  VALUES ('delete', old.rowid, old.skill_name, old.heading, old.content, old.snippet);
END;

CREATE TRIGGER IF NOT EXISTS skill_docs_au AFTER UPDATE ON skill_docs BEGIN
  INSERT INTO skill_docs_fts(skill_docs_fts, rowid, skill_name, heading, content, snippet)
  VALUES ('delete', old.rowid, old.skill_name, old.heading, old.content, old.snippet);
  INSERT INTO skill_docs_fts(rowid, skill_name, heading, content, snippet)
  VALUES (new.rowid, new.skill_name, new.heading, new.content, new.snippet);
END;

-- ─────────────────────────────────────────────────────────
-- Skill reindex incremental state
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_index_state (
  source_path        TEXT PRIMARY KEY,
  skill_name         TEXT NOT NULL,
  canonical_cli      TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  mtime_ms           INTEGER NOT NULL,
  size_bytes         INTEGER NOT NULL,
  indexed_at         INTEGER NOT NULL,
  doc_count          INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_skill_index_state_skill
  ON skill_index_state(skill_name, canonical_cli);

-- ─────────────────────────────────────────────────────────
-- Default metadata (v3) — INSERT OR IGNORE: never clobber an existing schema_version
-- during v2→v3 migration (lib/brain/brain-db-migrate.js stamps v3 keys after rebuild).
-- ─────────────────────────────────────────────────────────
INSERT OR IGNORE INTO schema_meta VALUES ('schema_version', '4');
INSERT OR IGNORE INTO schema_meta VALUES ('brain_db_role', 'runtime-local');
INSERT OR IGNORE INTO schema_meta VALUES ('memory_schema_version', '1');
INSERT OR IGNORE INTO schema_meta VALUES ('transcript_embedding_dim', '384');
INSERT OR IGNORE INTO schema_meta VALUES ('transcript_embedding_model', 'Xenova/all-MiniLM-L6-v2');
INSERT OR IGNORE INTO schema_meta VALUES ('skill_index_version', '1');
INSERT OR IGNORE INTO schema_meta VALUES ('skill_embedding_dim', '384');
INSERT OR IGNORE INTO schema_meta VALUES ('skill_embedding_model', 'Xenova/all-MiniLM-L6-v2');
INSERT OR IGNORE INTO schema_meta VALUES ('updated_at', date('now'));
INSERT OR IGNORE INTO schema_meta VALUES ('brain_id', '');
