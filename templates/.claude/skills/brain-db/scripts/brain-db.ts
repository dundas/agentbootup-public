#!/usr/bin/env bun
/**
 * brain-db.ts — CLI for querying and extending .brain/brain.db
 *
 * Usage:
 *   bun .claude/skills/brain-db/scripts/brain-db.ts <command> [args]
 *
 * Commands:
 *   query <text>           Full-text search transcripts
 *   sql <query>            Run any SELECT (read-only)
 *   stats                  Row counts, db size, last indexed
 *   schema                 All tables and columns
 *   extend <table> <sql>   Create a brain_ extension table
 *   insert <table> <json>  Insert a row into a brain_ table
 *   migrate <key> <sql>    Run a migration and record in schema_meta
 */

import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { assertBrainTable, isReadOnlySql, isMigrationSafe, extractTableName } from './brain-db-guards';

// ── Locate brain.db ──────────────────────────────────────────────────────────

function findDb(): string {
  const candidates: string[] = [];
  // Walk up to find a .brain dir (handles running from subdirectory). Stop at root.
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    candidates.push(join(dir, '.brain', 'brain.db'));
    const parent = resolve(dir, '..');
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  console.error('Error: .brain/brain.db not found.');
  console.error('Run: agentbootup brain upgrade');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function truncate(s: string, n = 120): string {
  if (!s) return '';
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

// ── Validation wrapper ───────────────────────────────────────────────────────

/** Wrap assertBrainTable (throws) for CLI exit-on-error behavior. */
function checkBrainTable(table: string) {
  try {
    assertBrainTable(table);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdQuery(db: Database, text: string) {
  if (!text?.trim()) {
    console.error('Usage: brain-db query <search text>');
    process.exit(1);
  }

  const rows = db.query<{
    session_id: string;
    timestamp: number;
    turn_type: string;
    content: string;
    brain_id: string;
  }, [string]>(`
    SELECT c.session_id, c.timestamp, c.turn_type, c.content, c.brain_id
    FROM chunks_fts f
    JOIN chunks c ON c.rowid = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT 20
  `).all(text);

  if (rows.length === 0) {
    console.log(`No results for: "${text}"`);
    console.log('Tip: try broader terms or run `agentbootup brain index-transcripts` to re-index.');
    return;
  }

  console.log(`\nFound ${rows.length} result(s) for: "${text}"\n`);
  for (const r of rows) {
    console.log(`  [${formatTimestamp(r.timestamp)}] ${r.session_id.slice(0, 8)}… (${r.turn_type})`);
    console.log(`    ${truncate(r.content)}`);
    console.log();
  }
}

function cmdSql(db: Database, query: string) {
  if (!query?.trim()) {
    console.error('Usage: brain-db sql "<SELECT ...>"');
    process.exit(1);
  }

  // Safety: only allow SELECT/PRAGMA/WITH (read-only) via this command.
  // The DB is also opened with { readonly: true }, which is the real enforcement —
  // this check provides a clear error message. WITH is allowed for read-only CTEs;
  // writable CTEs would be rejected by readonly mode anyway.
  if (!isReadOnlySql(query)) {
    console.error('Only SELECT/PRAGMA/WITH queries allowed via `sql` command.');
    console.error('Use `extend`, `insert`, or `migrate` for writes.');
    process.exit(1);
  }

  // Cap at 500 rows to avoid loading full tables into memory.
  // Inject LIMIT when absent so we fetch at most SQL_ROW_CAP+1 rows.
  // When the caller supplies their own LIMIT, respect it but still truncate the
  // display to SQL_ROW_CAP to guard against pathologically large explicit limits.
  const SQL_ROW_CAP = 500;
  const hasLimit = /\bLIMIT\b/i.test(query);
  const boundedQuery = hasLimit ? query : `${query} LIMIT ${SQL_ROW_CAP + 1}`;
  const rows = db.query(boundedQuery).all();
  // Always cap display — prevents large explicit LIMITs from filling the terminal.
  const display = rows.length > SQL_ROW_CAP ? rows.slice(0, SQL_ROW_CAP) : rows;
  if (rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  // Print as table. Cap column width at 80 chars to avoid unreadable output from
  // content-heavy columns (use `query` for full-text content searches instead).
  const MAX_COL = 80;
  const keys = Object.keys(display[0] as object);
  const widths = keys.map(k =>
    Math.min(MAX_COL, Math.max(k.length, ...display.map(r => String((r as Record<string, unknown>)[k] ?? '').length)))
  );
  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const divider = widths.map(w => '-'.repeat(w)).join('  ');
  console.log('\n' + header);
  console.log(divider);
  for (const row of display) {
    console.log(keys.map((k, i) => {
      const val = String((row as Record<string, unknown>)[k] ?? '');
      return (val.length > MAX_COL ? val.slice(0, MAX_COL - 1) + '…' : val).padEnd(widths[i]);
    }).join('  '));
  }
  const truncated = rows.length > SQL_ROW_CAP;
  const rowNote = truncated
    ? ` (showing ${SQL_ROW_CAP} of ${rows.length} — ${hasLimit ? 'add a smaller LIMIT' : 'add LIMIT to your query'} to control this)`
    : '';
  console.log(`\n(${display.length} row${display.length === 1 ? '' : 's'}${rowNote})`);
}

function cmdStats(db: Database, dbPath: string) {
  const size = statSync(dbPath).size;
  const chunkCount = (db.query('SELECT count(*) as n FROM chunks').get() as { n: number }).n;
  const sessionCount = (db.query('SELECT count(DISTINCT session_id) as n FROM chunks').get() as { n: number }).n;
  const sourceCount = (db.query('SELECT count(*) as n FROM transcript_index').get() as { n: number }).n;
  const latest = db.query('SELECT max(timestamp) as t FROM chunks').get() as { t: number | null };
  const meta = db.query('SELECT key, value FROM schema_meta').all() as { key: string; value: string }[];

  // Extension tables
  const extTables = db.query(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name LIKE 'brain_%'
    ORDER BY name
  `).all() as { name: string }[];

  console.log('\n=== Brain DB Stats ===\n');
  console.log(`  Path:         ${dbPath}`);
  console.log(`  Size:         ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Chunks:       ${chunkCount.toLocaleString()}`);
  console.log(`  Sessions:     ${sessionCount.toLocaleString()}`);
  console.log(`  Sources:      ${sourceCount.toLocaleString()} indexed transcript files`);
  console.log(`  Last indexed: ${latest.t ? formatTimestamp(latest.t) : 'never'}`);

  console.log('\n  Schema meta:');
  for (const { key, value } of meta) {
    console.log(`    ${key.padEnd(20)} ${value}`);
  }

  if (extTables.length > 0) {
    console.log('\n  Extension tables (brain_*):');
    for (const { name } of extTables) {
      const count = (db.query(`SELECT count(*) as n FROM "${name}"`).get() as { n: number }).n;
      console.log(`    ${name.padEnd(30)} ${count} rows`);
    }
  } else {
    console.log('\n  No extension tables yet. Use `extend` to add your own.');
  }
  console.log();
}

function cmdSchema(db: Database) {
  const tables = db.query(`
    SELECT name, sql FROM sqlite_master
    WHERE type='table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE WHEN name LIKE 'brain_%' THEN 1 ELSE 0 END, name
  `).all() as { name: string; sql: string }[];

  console.log('\n=== Brain DB Schema ===\n');
  for (const { name, sql } of tables) {
    const count = (db.query(`SELECT count(*) as n FROM "${name}"`).get() as { n: number }).n;
    const tag = name.startsWith('brain_') ? ' [extension]' : ' [foundation]';
    console.log(`── ${name}${tag}  (${count} rows)`);
    if (sql) {
      // Print column lines only
      const lines = sql.split('\n').filter(l => l.trim() && !l.trim().startsWith('CREATE'));
      for (const line of lines) console.log(`   ${line.trim().replace(/,$/, '')}`);
    }
    console.log();
  }
}

function cmdExtend(db: Database, table: string, sql: string) {
  if (!table || !sql) {
    console.error('Usage: brain-db extend <table_name> "<CREATE TABLE sql>"');
    process.exit(1);
  }
  checkBrainTable(table);
  // Validate the SQL is a CREATE TABLE statement and targets the declared table.
  // Bun's db.run() executes only the first statement, but we verify intent explicitly.
  const normalizedSql = sql.trim().toUpperCase();
  if (!normalizedSql.startsWith('CREATE TABLE')) {
    console.error('extend sql must be a CREATE TABLE statement.');
    process.exit(1);
  }
  // Extract the table name from the SQL (imported from brain-db-guards).
  // Handles unquoted, double-quoted, backtick-quoted, and bracket-quoted identifiers.
  const extractedName = extractTableName(sql);
  if (!extractedName || extractedName !== table) {
    console.error(`SQL table name "${extractedName ?? '?'}" does not match declared table "${table}".`);
    process.exit(1);
  }
  const exists = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (exists) {
    console.log(`Table "${table}" already exists. Use \`migrate\` to alter it.`);
    return;
  }
  db.run(sql);
  console.log(`Created extension table: ${table}`);
}

function cmdInsert(db: Database, table: string, jsonStr: string) {
  if (!table || !jsonStr) {
    console.error('Usage: brain-db insert <table> \'{"key":"value",...}\'');
    process.exit(1);
  }
  checkBrainTable(table);
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(jsonStr);
  } catch {
    console.error('Invalid JSON:', jsonStr);
    process.exit(1);
  }
  const keys = Object.keys(row);
  if (keys.length === 0) {
    console.error('JSON object has no keys — nothing to insert.');
    process.exit(1);
  }
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map(k => row[k]);
  // Escape embedded double-quotes in column names to prevent SQL parse errors.
  const quotedKeys = keys.map(k => `"${k.replace(/"/g, '""')}"`).join(', ');
  db.run(`INSERT INTO "${table}" (${quotedKeys}) VALUES (${placeholders})`, values);
  console.log(`Inserted 1 row into ${table}.`);
}

function cmdMigrate(db: Database, key: string, sql: string) {
  if (!key || !sql) {
    console.error('Usage: brain-db migrate <migration-key> "<SQL>"');
    process.exit(1);
  }
  const already = db.query('SELECT value FROM schema_meta WHERE key=?').get(key);
  if (already) {
    console.log(`Migration "${key}" already applied on ${(already as { value: string }).value}.`);
    return;
  }
  // Migrations are intentionally unrestricted — they must be able to ALTER TABLE,
  // CREATE INDEX, DROP INDEX, etc. on brain_ extension tables. The migration-key
  // deduplication guard (above) prevents accidental re-runs.
  // Foundation tables are fully managed by agentbootup — block any reference
  // (isMigrationSafe is imported from brain-db-guards).
  if (!isMigrationSafe(sql)) {
    console.error('Error: migration references a foundation table (chunks, transcript_index, schema_meta).');
    console.error('Foundation tables are managed by agentbootup — use brain_ extension tables instead.');
    process.exit(1);
  }
  // Wrap both writes in a transaction so the migration SQL and the schema_meta record
  // are applied atomically. Without this, a crash between the two writes leaves the
  // migration applied but unrecorded, causing a spurious re-run on next invocation.
  db.transaction(() => {
    db.run(sql);
    db.run('INSERT INTO schema_meta (key, value) VALUES (?, ?)', [key, new Date().toISOString().slice(0, 10)]);
  })();
  console.log(`Migration "${key}" applied.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
brain-db — query and extend .brain/brain.db

Commands:
  query <text>           Full-text search transcripts
  sql "<SELECT ...>"     Run a read-only SQL query
  stats                  Database overview and row counts
  schema                 All tables, columns, and row counts
  extend <table> <sql>   Create a brain_ extension table
  insert <table> <json>  Insert a row into a brain_ table
  migrate <key> <sql>    Run a migration and record it in schema_meta

Examples:
  bun brain-db.ts query "inbox daemon"
  bun brain-db.ts stats
  bun brain-db.ts extend brain_decisions "CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, date TEXT, topic TEXT, decision TEXT)"
  bun brain-db.ts insert brain_decisions '{"id":"d-001","date":"2026-03-25","topic":"config","decision":"agentbootup.json is canonical"}'
  bun brain-db.ts migrate ext-decisions-v2 "ALTER TABLE brain_decisions ADD COLUMN pr_number TEXT"
`);
  process.exit(0);
}

const dbPath = findDb();
const readOnly = cmd === 'query' || cmd === 'sql' || cmd === 'stats' || cmd === 'schema';
const db = readOnly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
if (!readOnly) db.run('PRAGMA journal_mode=WAL');

switch (cmd) {
  case 'query':   cmdQuery(db, rest.join(' ')); break;
  case 'sql':     cmdSql(db, rest.join(' ')); break;
  case 'stats':   cmdStats(db, dbPath); break;
  case 'schema':  cmdSchema(db); break;
  case 'extend':  cmdExtend(db, rest[0], rest.slice(1).join(' ')); break;
  case 'insert':  cmdInsert(db, rest[0], rest.slice(1).join(' ')); break;
  case 'migrate': cmdMigrate(db, rest[0], rest.slice(1).join(' ')); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Run with --help for usage.');
    process.exit(1);
}

db.close();
