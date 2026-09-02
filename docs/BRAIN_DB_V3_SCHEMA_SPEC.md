# brain.db v3 Schema Spec

**Status**: Draft  
**Author**: decisive.gm  
**Date**: 2026-04-09

## Purpose

Define the first `brain.db` schema version that treats the database as the brain's
general local runtime store, not just a transcript index.

`v3` is the schema milestone that makes the local skill index a first-class
subsystem inside `brain.db`.

## Decisions

1. `brain.db` remains the canonical local database name and stays at `.brain/brain.db`.
2. Transcript memory remains in `brain.db`; it is not split into a second DB.
3. The skill index lives inside `brain.db`, not in a separate vector store.
4. FTS is the default retrieval path; vector search is optional but provisioned in schema.
5. `brain/brain-schema.sql` becomes the unambiguous source of truth for both transcript and skill-index tables.

## Why v3

Today the portfolio has three overlapping realities:

- `brain.db` is treated conceptually as a local runtime database
- tooling still mostly treats it as transcript search storage
- the checked-in schema does not fully express every table current tools assume

`v3` resolves that ambiguity by making the full required contract explicit.

## Scope

`v3` covers:

- transcript memory base tables
- transcript FTS
- transcript index state
- skill registry
- skill document sections
- skill FTS
- incremental skill reindex state
- schema metadata for index/query tooling

`v3` does not yet standardize:

- cross-brain remote query serving
- arbitrary repo-owned `brain_*` extension tables
- snapshot manifests stored inside the DB
- push/pull skill transport

## Required Tables

### Transcript Memory

These remain foundation tables:

```sql
CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  brain_id    TEXT NOT NULL,
  project     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  turn_type   TEXT,
  content     TEXT NOT NULL,
  token_count INTEGER,
  embedding   F32_BLOB(384)
);

CREATE INDEX IF NOT EXISTS idx_chunks_brain_time
  ON chunks(brain_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_chunks_session
  ON chunks(session_id);

CREATE INDEX IF NOT EXISTS idx_chunks_vector
  ON chunks(libsql_vector_idx(embedding, 'metric=cosine'));
```

### Transcript FTS

`v3` makes transcript FTS explicit in the canonical schema rather than leaving it
to indexer side effects.

```sql
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
```

### Transcript Index State

```sql
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
```

### Schema Metadata

Retain the existing key-value model, but make the required keys explicit.

```sql
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Required rows after successful `v3` migration:

- `schema_version = 3`
- `brain_id = <agent-id or empty during bootstrap>`
- `brain_db_role = runtime-local`
- `transcript_embedding_dim = 384`
- `transcript_embedding_model = Xenova/all-MiniLM-L6-v2`
- `skill_index_version = 1`
- `skill_embedding_dim = 384`
- `skill_embedding_model = Xenova/all-MiniLM-L6-v2`
- `updated_at = <YYYY-MM-DD>`

### Skill Registry

One row per installed logical skill.

```sql
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
```

### Skill Documents

One row per retrievable skill unit. This is the main query surface for dynamic
skill loading.

Initial chunk types:

- `overview`
- `frontmatter`
- `section`
- `reference`
- `eval`
- `manifest`

```sql
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
```

### Skill FTS

```sql
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
```

### Skill Reindex State

Tracks incremental indexing at the file level.

```sql
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
```

## Source Trees

The `v3` skill index is built from installed skill trees:

- `.claude/skills`
- `.gemini/skills`
- `.codex/skills`
- optionally `.cursor/skills`

The authoritative query index is the DB tables above.

`.brain/skills/index/` may still exist, but only for cache files, temp artifacts,
or exported manifests. It is not the source of truth.

## Indexing Contract

### Registry row

For each logical skill, create one `skills` row using the canonical source:

- prefer the CLI-native skill if explicitly declared canonical
- otherwise prefer `.claude/skills/<name>` as the default source of truth

### Document rows

For each skill, index:

1. frontmatter summary
2. skill overview/introduction
3. each top-level `##` section from `SKILL.md`
4. reference files when present
5. eval/reference artifacts only when text-like and useful for retrieval

Do not index:

- runtime state
- backup files
- vendored dependencies
- large generated outputs

## Query Contract

`v3` must support these query modes:

1. exact lookup by skill name
2. FTS lookup by command/problem description
3. semantic fallback over `skill_docs.embedding`
4. related-section lookup within one skill

Representative SQL:

```sql
SELECT d.skill_name, d.section_type, d.heading, d.source_path, bm25(skill_docs_fts) AS score
FROM skill_docs_fts
JOIN skill_docs d ON d.rowid = skill_docs_fts.rowid
WHERE skill_docs_fts MATCH ?
ORDER BY score
LIMIT ?;
```

## Migration Plan

### Supported upgrade paths

- unprovisioned -> v3
- v1 -> v3
- v2 -> v3

### Migration requirements

1. Preserve existing transcript data.
2. Create `chunks_fts` if missing.
3. Create `transcript_index` if missing.
4. Create all skill tables and indexes.
5. Backfill metadata rows in `schema_meta`.
6. Do not require skill reindex during schema migration itself.
7. Mark skill index as empty-but-ready until `agentbootup skills reindex` runs.

### Post-migration state

Immediately after migration, before reindex:

- transcript search works
- skill tables exist
- `skill_index_state` is empty
- `skills` is empty
- `skill_docs` is empty
- `schema_version = 3`

After the first skill reindex:

- `skills` populated
- `skill_docs` populated
- `skill_docs_fts` queryable
- vector index populated when embedding support is enabled

## Tooling Implications

`brain/brain-schema.sql` should be updated to:

- declare all required `v3` tables
- stop implying that transcript FTS exists elsewhere
- stamp `schema_version = 3`
- document migration from existing transcript-only installs

`brain/sync-brain-schema.ts` should be updated later to:

- report `v3` accurately
- distinguish schema migration from skill reindex
- avoid saying `schema v1 applied`

## Out Of Scope For This Spec

- the external CLI UX for `agentbootup skills query`
- local HTTP API routes and payloads
- skill push/pull transport
- ranking heuristics beyond "FTS first, semantic fallback"

Those belong in follow-on specs.

## Acceptance Criteria

This spec is complete when it gives `agentbootup` enough detail to:

1. create a new `.brain/brain.db` with transcript + skill-index tables
2. migrate an old transcript-only DB to `schema_version = 3`
3. run a later `skills reindex` command without further schema changes
4. support both lexical and semantic skill lookup against the same local DB
