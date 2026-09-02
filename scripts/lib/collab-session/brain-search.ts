#!/usr/bin/env bun
/**
 * brain-search.ts
 *
 * Session-start correction lookup against local brain.db (FTS5).
 * Surfaces past corrections and gotchas relevant to the current task topic.
 *
 * Preferred entrypoint:
 *   bun scripts/lib/collab-session/brain-search.ts <query>
 *   bun scripts/lib/collab-session/brain-search.ts <query> --corrections-only
 *   bun scripts/lib/collab-session/brain-search.ts <query> --project .
 *   bun scripts/lib/collab-session/brain-search.ts <query> --since 2026-02-01
 *   bun scripts/lib/collab-session/brain-search.ts <query> --limit 10
 *
 * Legacy entrypoint still supported:
 *   bun scripts/brain-search.ts ...
 *
 * Once agentbootup ships 'brain search', this delegates to that command.
 * Until then, queries .brain/brain.db directly via bun:sqlite.
 */

import { Database } from "bun:sqlite";
import { join, resolve } from "path";
import { existsSync } from "fs";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
brain-search — query brain.db for past corrections and patterns

USAGE
  bun scripts/lib/collab-session/brain-search.ts <query> [options]

OPTIONS
  --corrections-only    Only return chunks with correction signals
  --project <path>      Scope to a single project directory (default: all)
  --since <date>        ISO date lower bound (default: 90 days ago)
  --limit <n>           Max results (default: 10)
  --db <path>           Path to brain.db (default: .brain/brain.db)

EXAMPLES
  bun scripts/lib/collab-session/brain-search.ts "mech-vault"
  bun scripts/lib/collab-session/brain-search.ts "deployment" --corrections-only
  bun scripts/lib/collab-session/brain-search.ts "authentication" --project . --limit 5
  bun scripts/lib/collab-session/brain-search.ts "round table" --since 2026-03-01

LEGACY
  bun brain/tools/brain-search.ts ...
`);
  process.exit(0);
}

const query = args[0];
let correctionsOnly = false;
let projectFilter: string | null = null;
const DEFAULT_SINCE = Date.now() - 90 * 24 * 60 * 60 * 1000;
let since: number = DEFAULT_SINCE;
let sinceOverridden = false;
let limit = 10;
let dbPath = join(process.cwd(), ".brain", "brain.db");

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--corrections-only") {
    correctionsOnly = true;
  } else if (args[i] === "--project" && args[i + 1]) {
    const dir = resolve(args[++i]);
    projectFilter = dir.replace(/[/_]/g, "-").replace(/%/g, "\\%");
    process.stderr.write(`[brain-search] project filter: ${projectFilter}\n`);
  } else if (args[i] === "--since" && args[i + 1]) {
    const raw = args[++i];
    const t = new Date(raw).getTime();
    if (isNaN(t)) {
      process.stderr.write(`[brain-search] invalid --since value "${raw}", using default 90d\n`);
    } else {
      since = t;
      sinceOverridden = true;
    }
  } else if (args[i] === "--limit" && args[i + 1]) {
    const n = parseInt(args[++i], 10);
    if (!isNaN(n) && n > 0) limit = Math.min(n, 500);
  } else if (args[i] === "--db" && args[i + 1]) {
    dbPath = resolve(args[++i]);
  }
}

const sinceLabel = sinceOverridden
  ? `since ${new Date(since).toISOString().split("T")[0]}`
  : "90d";

if (!existsSync(dbPath)) {
  console.error(`brain.db not found at ${dbPath}`);
  console.error(`Run: agentbootup brain index-transcripts`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const hasFts = db
  .query("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'")
  .get();

if (!hasFts) {
  console.error("brain.db exists but FTS5 index is missing. Re-run index-transcripts.");
  process.exit(1);
}

interface ChunkRow {
  id: string;
  session_id: string;
  project: string;
  timestamp: number;
  content: string;
  chunk_meta: string | null;
}

function buildFtsQuery(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

const escaped = buildFtsQuery(query);
const conditions: string[] = ["chunks_fts MATCH ?"];
const params: (string | number)[] = [escaped];

if (projectFilter) {
  conditions.push("c.project LIKE ? ESCAPE '\\'");
  params.push(`%${projectFilter}%`);
}
conditions.push("c.timestamp >= ?");
params.push(since);

if (correctionsOnly) {
  conditions.push("json_extract(c.chunk_meta, '$.correction_count') >= 1");
}

params.push(limit);

const where = conditions.join(" AND ");
const sql = `
  SELECT c.id, c.session_id, c.project, c.timestamp, c.content, c.chunk_meta
  FROM chunks_fts
  JOIN chunks c ON chunks_fts.rowid = c.rowid
  WHERE ${where}
  ORDER BY
    json_extract(c.chunk_meta, '$.correction_count') DESC,
    c.timestamp DESC
  LIMIT ?
`;

let rows: ChunkRow[] = [];
try {
  rows = db.query(sql).all(...params) as ChunkRow[];
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[brain-search] FTS phrase match failed, falling back to LIKE scan: ${msg}\n`);
  const safeQuery = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const fallbackConditions: string[] = ["content LIKE ? ESCAPE '\\'"];
  const fbParams: (string | number)[] = [`%${safeQuery}%`];
  if (projectFilter) {
    fallbackConditions.push("project LIKE ? ESCAPE '\\'");
    fbParams.push(`%${projectFilter}%`);
  }
  fallbackConditions.push("timestamp >= ?");
  fbParams.push(since);
  if (correctionsOnly) fallbackConditions.push("json_extract(chunk_meta, '$.correction_count') >= 1");
  fbParams.push(limit);
  const fallbackSql = `
    SELECT id, session_id, project, timestamp, content, chunk_meta
    FROM chunks
    WHERE ${fallbackConditions.join(" AND ")}
    ORDER BY json_extract(chunk_meta, '$.correction_count') DESC, timestamp DESC
    LIMIT ?
  `;
  rows = db.query(fallbackSql).all(...fbParams) as ChunkRow[];
}

db.close();

function parseMeta(raw: string | null): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

if (rows.length === 0) {
  const scope = correctionsOnly ? "corrections" : "results";
  console.log(`Brain search: "${query}" — no ${scope} found (${sinceLabel})`);
  if (!correctionsOnly) {
    console.log(`Tip: try --corrections-only or broaden the query`);
  }
  process.exit(0);
}

const correctionRows = correctionsOnly
  ? rows
  : rows.filter((r) => Number(parseMeta(r.chunk_meta).correction_count || 0) >= 1);

const header = correctionsOnly
  ? `Brain search: "${query}" — ${rows.length} corrections found (${sinceLabel})`
  : `Brain search: "${query}" — ${rows.length} results, ${correctionRows.length} with corrections (${sinceLabel})`;

console.log("\n" + header);
console.log("─".repeat(header.length));

for (const row of rows) {
  const meta = parseMeta(row.chunk_meta);
  const cc = Number(meta.correction_count || 0);
  const date = new Date(row.timestamp).toISOString().split("T")[0];
  const projectLabel = row.project
    .replace(/^-(?:Users|home)-[^-]+-dev-env-/, "")
    .replace(/-/g, "/");

  const corrLabel = cc > 0 ? ` ⚠ ${cc} correction${cc > 1 ? "s" : ""}` : "";
  console.log(`\n[${date}] ${projectLabel}${corrLabel}`);

  const content = row.content;
  const idx = content.toLowerCase().indexOf(query.toLowerCase().split(" ")[0]);
  const snippet = idx >= 0
    ? content.slice(Math.max(0, idx - 40), Math.min(content.length, idx + 260)).replace(/\n+/g, " ").trim()
    : content.slice(0, 200).replace(/\n+/g, " ").trim();

  console.log("  " + snippet);
}

console.log("");
