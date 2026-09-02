---
name: brain-db
description: Query, inspect, and extend the brain's local SQLite database (.brain/brain.db). Use when: brain db, query transcripts, search session history, brain database, extend brain.db, add custom table, brain schema, what did I work on, find past sessions, brain_decisions, brain_patterns, brain migration, inspect brain tables, brain data. Do NOT use for: web search, file search in repo, cross-brain messaging, remote data.
compatibility: Requires .brain/brain.db initialized via `agentbootup brain upgrade` or `agentbootup brain index-transcripts`
metadata:
  author: bootup
  version: 1.0.0
---

# Brain DB

Query transcripts, inspect your schema, and extend brain.db with your own tables.

## The Database

`.brain/brain.db` is a SQLite database local to each brain. It has two layers:

**Foundation** (managed by agentbootup — don't modify):
- `chunks` — transcript content indexed from all sessions (FTS5 searchable)
- `chunks_fts` — full-text search index over chunks
- `transcript_index` — tracks which transcript files have been indexed
- `schema_meta` — key/value metadata (schema_version, brain_id, updated_at)

**Extensions** (owned by you — use for anything):
Tables prefixed `brain_` are fully yours. Use them for whatever serves your work:

- **Memory** — decisions, patterns, gotchas, domain knowledge
- **Active work** — task state, queues, progress tracking across sessions
- **Domain data** — any structured data your project needs (orders, metrics, records, analysis results)
- **Operational state** — build history, sync state, job queues, caches

The rule is simple: if it's useful to your work and local to this brain, put it here. No need to justify it as "memory" — brain.db is your working database, not just an archive.

## CLI Script

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts <command> [args]
```

### Commands

| Command | What it does |
|---------|-------------|
| `query <text>` | Full-text search transcripts |
| `sql <query>` | Run any SELECT query |
| `stats` | Row counts, db size, last indexed |
| `schema` | Show all tables and their columns |
| `extend <table> <sql>` | Create a custom brain_ table |
| `insert <table> <json>` | Insert a row into a brain_ table |
| `migrate <version> <sql>` | Run a migration and record it |

## Querying Transcripts

**Full-text search** — finds sessions where you worked on a topic:

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts query "inbox daemon routing"
```

Returns: session IDs, timestamps, matching content previews.

**SQL query** — for structured lookups:

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts sql \
  "SELECT session_id, datetime(timestamp/1000,'unixepoch') as when, substr(content,1,200) as preview
   FROM chunks WHERE turn_type='assistant' ORDER BY timestamp DESC LIMIT 10"
```

**Useful columns in chunks:**
- `brain_id` — which brain produced this chunk
- `turn_type` — `user`, `assistant`, or `mixed`
- `session_id` — group chunks from the same session
- `timestamp` — milliseconds since epoch
- `content` — the actual text
- `token_count` — size of the chunk

## Inspecting Your DB

```bash
# Overview: row counts, db size, last indexed session
bun .claude/skills/brain-db/scripts/brain-db.ts stats

# All tables and columns
bun .claude/skills/brain-db/scripts/brain-db.ts schema
```

## Extending with Custom Tables

Each brain can add any tables it needs. Use the `brain_` prefix to keep your tables clearly separated from foundation tables.

You decide what goes here. Some examples of how brains use it:
- Tracking work orders and their status across sessions
- Caching expensive computation results
- Storing domain data the brain is actively working with (e.g. a list of repos, a set of API endpoints, customer records)
- Queue tables for deferred work
- Anything you'd reach for SQLite for in a normal project

**Create a table:**

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts extend brain_decisions \
  "CREATE TABLE brain_decisions (
    id        TEXT PRIMARY KEY,
    date      TEXT NOT NULL,
    topic     TEXT NOT NULL,
    decision  TEXT NOT NULL,
    rationale TEXT,
    tags      TEXT
  )"
```

**Insert a row:**

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts insert brain_decisions \
  '{"id":"d-001","date":"2026-03-25","topic":"config consolidation","decision":"agentbootup.json is canonical","rationale":"single source eliminates drift","tags":"config,architecture"}'
```

**Query your extension:**

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts sql \
  "SELECT date, topic, decision FROM brain_decisions ORDER BY date DESC"
```

## Schema Migrations

When you need to alter an existing extension table, use migrations to track versions:

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts migrate ext-v2 \
  "ALTER TABLE brain_decisions ADD COLUMN pr_number TEXT"
```

This runs the SQL and records `{"key": "ext-v2", "value": "2026-03-25"}` in `schema_meta` so you can check what migrations have run.

Check migration history:

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts sql \
  "SELECT key, value FROM schema_meta WHERE key LIKE 'ext-%'"
```

## Common Extension Patterns

See `references/extension-patterns.md` for ready-to-use table definitions:
- `brain_decisions` — architectural and design decisions
- `brain_patterns` — recurring patterns (good and bad)
- `brain_todos` — deferred work items with priority
- `brain_entities` — named things you want to track (people, systems, concepts)
- `brain_metrics` — time-series measurements

## Direct Bun SQLite (for scripting)

When you need more control, use Bun's SQLite directly:

```typescript
import { Database } from 'bun:sqlite';
const db = new Database('.brain/brain.db');

// FTS search
const results = db.query(`
  SELECT c.session_id, c.timestamp, c.content
  FROM chunks_fts f
  JOIN chunks c ON c.rowid = f.rowid
  WHERE chunks_fts MATCH ?
  ORDER BY rank
  LIMIT 20
`).all('inbox daemon');

db.close();
```

## Troubleshooting

**"no such table: chunks"** — brain.db not initialized. Run: `agentbootup brain upgrade`

**"no such table: brain_decisions"** — extension not created yet. Run the `extend` command first.

**Empty FTS results** — transcripts may not be indexed. Run: `agentbootup brain index-transcripts`

**Migration already applied** — check `schema_meta` before running: `sql "SELECT * FROM schema_meta WHERE key='ext-v2'"`
