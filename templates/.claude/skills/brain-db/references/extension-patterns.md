# Brain DB Extension Patterns

Ready-to-use table definitions for common brain needs. Copy and adapt.

## brain_decisions — Architectural decisions log

```sql
CREATE TABLE brain_decisions (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  topic      TEXT NOT NULL,
  decision   TEXT NOT NULL,
  rationale  TEXT,
  pr_number  TEXT,
  tags       TEXT
)
```

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts extend brain_decisions "CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, date TEXT NOT NULL, topic TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT, pr_number TEXT, tags TEXT)"

bun .claude/skills/brain-db/scripts/brain-db.ts insert brain_decisions '{"id":"d-001","date":"2026-03-25","topic":"config source","decision":"agentbootup.json is canonical","rationale":"single file eliminates drift between brain/config.json and agentbootup.json","pr_number":"77","tags":"config,architecture"}'
```

## brain_patterns — Recurring patterns (good and bad)

```sql
CREATE TABLE brain_patterns (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('gotcha','fix','approach','antipattern')),
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  example     TEXT,
  tags        TEXT
)
```

```bash
bun .claude/skills/brain-db/scripts/brain-db.ts extend brain_patterns "CREATE TABLE brain_patterns (id TEXT PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, example TEXT, tags TEXT)"
```

## brain_todos — Deferred work items

```sql
CREATE TABLE brain_todos (
  id          TEXT PRIMARY KEY,
  created     TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 2,  -- 1=high 2=normal 3=low
  title       TEXT NOT NULL,
  description TEXT,
  context     TEXT,   -- where this came up (PR, session, message)
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT
)
```

## brain_entities — Named things to track

Useful for tracking systems, people, APIs, concepts that come up repeatedly.

```sql
CREATE TABLE brain_entities (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,   -- 'service','person','concept','api','tool'
  name        TEXT NOT NULL,
  description TEXT,
  notes       TEXT,
  updated     TEXT NOT NULL
)
```

## brain_metrics — Time-series measurements

```sql
CREATE TABLE brain_metrics (
  id        TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  metric    TEXT NOT NULL,
  value     REAL NOT NULL,
  unit      TEXT,
  tags      TEXT
)
```

```bash
# Record a measurement
bun .claude/skills/brain-db/scripts/brain-db.ts insert brain_metrics '{"id":"m-001","timestamp":"2026-03-25T15:00:00Z","metric":"pr_review_rounds","value":2,"unit":"rounds","tags":"pr-78"}'

# Query trend
bun .claude/skills/brain-db/scripts/brain-db.ts sql "SELECT metric, avg(value) as avg, min(value) as min, max(value) as max FROM brain_metrics GROUP BY metric"
```

## brain_sessions — Session summaries (complements narrative-generator)

```sql
CREATE TABLE brain_sessions (
  session_id TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  summary    TEXT NOT NULL,
  outcome    TEXT,      -- 'completed','partial','blocked','exploratory'
  prs        TEXT,      -- comma-separated PR numbers
  tags       TEXT
)
```

## Migration Examples

```bash
# Add a column
bun .claude/skills/brain-db/scripts/brain-db.ts migrate ext-decisions-v2 "ALTER TABLE brain_decisions ADD COLUMN superseded_by TEXT"

# Create an index for faster queries
bun .claude/skills/brain-db/scripts/brain-db.ts migrate ext-decisions-idx-v1 "CREATE INDEX idx_brain_decisions_tags ON brain_decisions(tags)"

# Check what's been applied
bun .claude/skills/brain-db/scripts/brain-db.ts sql "SELECT key, value FROM schema_meta WHERE key LIKE 'ext-%' ORDER BY value DESC"
```
