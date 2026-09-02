/**
 * agentbootup brain-db — local brain.db inspection and migration (PRD-0014 FR-11, Task 2.4).
 *
 *   agentbootup brain-db status [--json] [--cwd <path>]
 *   agentbootup brain-db migrate [--cwd <path>]
 */

import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { extractCwd } from '../args.js';
import { getAgentId } from '../../project-config.js';
import { runBrainDbMigrations } from '../../brain/brain-db-migrate.js';

function printUsage(io) {
  io.stdout('Usage: agentbootup brain-db <subcommand> [options]');
  io.stdout('');
  io.stdout('Subcommands:');
  io.stdout('  status   Show schema version, row counts, and brain_id (FR-11)');
  io.stdout('  migrate  Run v1→v2 / v2→v3 / v3→v4 migrations (FR-10 backup when credentials exist)');
  io.stdout('');
  io.stdout('Options:');
  io.stdout('  --cwd <path>  Project root (default: cwd)');
  io.stdout('  --json        (status) machine-readable output');
}

/**
 * @param {string[]} args
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 * @returns {Promise<number>}
 */
export async function runBrainDbCommand(args, io) {
  const sub = args[0];
  // --help/-h → exit 0; missing subcommand → exit 1 after usage
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage(io);
    return sub ? 0 : 1;
  }
  if (sub === 'status') return runBrainDbStatus(args.slice(1), io);
  if (sub === 'migrate') return runBrainDbMigrate(args.slice(1), io);
  io.stderr(`Unknown brain-db subcommand: ${sub}`);
  printUsage(io);
  return 1;
}

/** @param {string} cwd Project root (from `--cwd` or process cwd) */
export function defaultBrainDbPath(cwd) {
  // cwd is explicit project root from --cwd (operator-chosen); basename only under .brain/.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.join(path.resolve(cwd), '.brain', 'brain.db');
}

/**
 * @param {import('@libsql/client').Client} db
 * @param {string} sql
 */
async function scalar(db, sql) {
  const r = await db.execute(sql);
  const row = r.rows?.[0];
  if (!row) return null;
  const v = Object.values(row)[0];
  return v;
}

/**
 * @param {string[]} args
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 */
async function runBrainDbStatus(args, io) {
  const jsonOut = args.includes('--json');
  const { cwd } = extractCwd(args.filter((a) => a !== '--json'));
  const dbPath = defaultBrainDbPath(cwd);

  if (!fs.existsSync(dbPath)) {
    const msg = `brain.db not found at ${dbPath}`;
    if (jsonOut) {
      io.stdout(JSON.stringify({ error: msg, brain_db_path: dbPath }, null, 2));
    } else {
      io.stderr(msg);
    }
    return 1;
  }

  const db = createClient({ url: `file:${dbPath}` });
  try {
    let schemaVersion = null;
    let brainIdMeta = null;
    try {
      schemaVersion = await scalar(
        db,
        "SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1",
      );
      brainIdMeta = await scalar(db, "SELECT value FROM schema_meta WHERE key = 'brain_id' LIMIT 1");
    } catch {
      /* missing schema_meta */
    }

    let chunks = null;
    let skills = null;
    let skillDocs = null;
    let skillIndexRows = null;
    let memoryEvents = null;
    let memoryPages = null;
    try {
      chunks = Number(await scalar(db, 'SELECT COUNT(*) AS c FROM chunks'));
    } catch {
      chunks = null;
    }
    try {
      skills = Number(await scalar(db, 'SELECT COUNT(*) AS c FROM skills'));
    } catch {
      skills = null;
    }
    try {
      skillDocs = Number(await scalar(db, 'SELECT COUNT(*) AS c FROM skill_docs'));
    } catch {
      skillDocs = null;
    }
    try {
      skillIndexRows = Number(await scalar(db, 'SELECT COUNT(*) AS c FROM skill_index_state'));
    } catch {
      skillIndexRows = null;
    }
    try {
      memoryEvents = Number(await scalar(db, 'SELECT COUNT(*) AS c FROM memory_events'));
    } catch {
      memoryEvents = null;
    }
    try {
      memoryPages = Number(await scalar(db, 'SELECT COUNT(*) AS c FROM memory_pages'));
    } catch {
      memoryPages = null;
    }

    let projectBrainId;
    try {
      projectBrainId = getAgentId(cwd);
    } catch (err) {
      const message = `brain-db status failed: ${err instanceof Error ? err.message : String(err)}`;
      if (jsonOut) {
        io.stdout(JSON.stringify({ error: message, brain_db_path: dbPath }, null, 2));
      } else {
        io.stderr(message);
      }
      return 1;
    }
    const skillIndexState =
      skillIndexRows === null ? 'unknown' : skillIndexRows === 0 ? 'empty' : 'populated';

    const payload = {
      brain_db_path: dbPath,
      schema_version: schemaVersion,
      brain_id_schema_meta: brainIdMeta,
      brain_id_project: projectBrainId,
      row_counts: {
        chunks,
        skills,
        skill_docs: skillDocs,
        memory_events: memoryEvents,
        memory_pages: memoryPages,
      },
      skill_index_state: skillIndexState,
      skill_index_state_rows: skillIndexRows,
    };

    if (jsonOut) {
      io.stdout(JSON.stringify(payload, null, 2));
      return 0;
    }

    io.stdout(`brain.db: ${dbPath}`);
    io.stdout(`  schema_version: ${schemaVersion ?? '(none — pre-meta or legacy)'}`);
    io.stdout(`  brain_id (schema_meta): ${brainIdMeta ?? '—'}`);
    io.stdout(`  brain_id (agentbootup.json): ${projectBrainId ?? '—'}`);
    io.stdout(
      `  rows — chunks: ${chunks ?? 'n/a'}, skills: ${skills ?? 'n/a'}, skill_docs: ${skillDocs ?? 'n/a'}, memory_events: ${memoryEvents ?? 'n/a'}, memory_pages: ${memoryPages ?? 'n/a'}`,
    );
    io.stdout(`  skill_index_state: ${skillIndexState}${skillIndexRows !== null ? ` (${skillIndexRows} rows)` : ''}`);
    return 0;
  } finally {
    await db.close();
  }
}

/**
 * @param {string[]} args
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 */
async function runBrainDbMigrate(args, io) {
  const { cwd } = extractCwd(args);
  const dbPath = defaultBrainDbPath(cwd);
  let brainId;
  try {
    brainId = getAgentId(cwd);
  } catch (err) {
    io.stderr(`brain-db migrate failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!brainId) {
    io.stderr('brain-db migrate failed: could not determine agent_id — ensure agentbootup.json exists');
    return 1;
  }

  if (!fs.existsSync(dbPath)) {
    io.stderr(`brain-db migrate failed: brain.db not found at ${dbPath}`);
    return 1;
  }

  const db = createClient({ url: `file:${dbPath}` });
  try {
    await runBrainDbMigrations(db, {
      log: (m) => io.stdout(m),
      error: (m) => io.stderr(m),
      brainDbFilePath: dbPath,
      brainId,
    });
    io.stdout('brain-db migrate: done');
    return 0;
  } catch (err) {
    io.stderr(`brain-db migrate failed: ${err?.message ?? String(err)}`);
    return 1;
  } finally {
    await db.close();
  }
}
