#!/usr/bin/env node
/**
 * Brain DB Sync Daemon
 *
 * Opens a libsql embedded-replica database in the target project's .brain/
 * directory and keeps it synced with the remote sqld server on a managed
 * five-minute pull-push cycle. Managing the cadence here makes successful
 * completions observable to the doctor report.
 *
 * This daemon is registered with @derivativelabs/agent-process under the
 * name `agentbootup-brain-db-<brain-id>`, following the same pattern as
 * agentbootup-transcripts and agentbootup-brain-<id>.
 *
 * Required env vars (all injected by unified-daemon-cli.js at start time):
 *   BRAIN_DB_URL          — syncUrl: the remote sqld endpoint (https://brain-sqld.fly.dev/<brain-id>)
 *   BRAIN_DB_TOKEN        — authToken: JWT issued by /v1/brain-db/provision
 *   BRAIN_DB_PATH         — url: local file path (.brain/brain.db in target project)
 *   BRAIN_DB_SCHEMA_PATH  — path to brain-schema.sql to apply on startup (idempotent)
 *   BRAIN_DB_INSTALL_PATH — path to target project's node_modules (for @libsql/client)
 *   BRAIN_DB_BRAIN_ID     — brain ID for log labelling
 *
 * Design rationale: explicit daemon-owned syncs keep continuous replica
 * convergence while making each successful completion durable and auditable.
 * SIGTERM: db.close() then exit 0.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { runBrainDbMigrations } from '../brain/brain-db-migrate.js';
import { getPidFilePath } from '../process/pid-utils.js';
import { recordBrainDbSyncHealth } from './brain-db-health.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[brain-db-sync]';
/** Explicit remote sync cadence; kept equal to the previous 300-second interval. */
const SYNC_INTERVAL_MS = 5 * 60_000;

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`${LOG_PREFIX} ${new Date().toISOString()} ${msg}\n`);
}

function logError(msg) {
  process.stderr.write(`${LOG_PREFIX} ${new Date().toISOString()} ERROR ${msg}\n`);
}

// ── libsql client loader ──────────────────────────────────────────────────────

/**
 * Dynamically import createClient from the target project's node_modules.
 * BRAIN_DB_INSTALL_PATH points to <project>/node_modules.
 *
 * Falls back to a direct import of '@libsql/client' (for test environments
 * where it is installed in agentbootup's own node_modules).
 *
 * @param {string | undefined} installPath
 * @returns {Promise<{ createClient: Function }>}
 */
async function loadLibsqlClient(installPath) {
  if (installPath) {
    try {
      // Resolve package.json to find the real entry point.
      const pkgPath = path.join(installPath, '@libsql', 'client', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      // Prefer CJS entry (require) over ESM when available — more portable.
      // exports['.'].require is a string directly per Node.js convention;
      // .require.default only exists in a few non-standard packages, so
      // check typeof first to avoid passing [object Object] to path.join.
      const exportsField = pkg.exports?.['.'];
      const requireEntry = exportsField?.require;
      const mainFile =
        (typeof requireEntry === 'string' ? requireEntry : null) ??
        requireEntry?.default ??
        (typeof exportsField?.default === 'string' ? exportsField.default : null) ??
        pkg.main ??
        'index.js';
      const clientFile = path.join(installPath, '@libsql', 'client', mainFile);
      return await import(pathToFileURL(clientFile).href);
    } catch (err) {
      log(`Could not load @libsql/client from BRAIN_DB_INSTALL_PATH (${installPath}): ${err.message}. Falling back to direct import.`);
    }
  }
  // Fallback — works in test environments where @libsql/client is a dev dep.
  return await import('@libsql/client');
}

// ── Schema application ────────────────────────────────────────────────────────

/**
 * Apply the brain schema to the database (idempotent — all statements use
 * CREATE TABLE IF NOT EXISTS). Reads from BRAIN_DB_SCHEMA_PATH.
 *
 * @param {object} db  libsql client
 * @param {string} schemaPath
 * @param {{ brainDbFilePath?: string, brainId?: string }} [migrationOpts]  FR-10 backup context
 */
async function applySchema(db, schemaPath, migrationOpts = {}) {
  if (!schemaPath) {
    log('BRAIN_DB_SCHEMA_PATH not set — skipping schema application');
    return;
  }
  if (!fs.existsSync(schemaPath)) {
    log(`Schema file not found at ${schemaPath} — skipping`);
    return;
  }
  const sql = fs.readFileSync(schemaPath, 'utf-8');

  // Use db.executeMultiple() if available (libsql ≥0.5) — handles the full SQL
  // string as a batch, avoiding naive semicolon-splitting issues with string
  // literals or comments. Fall back to line-by-line splitting only if the method
  // is absent (older client versions). Note: the bundled brain-schema.sql uses
  // CREATE TABLE IF NOT EXISTS, so all statements are idempotent.
  if (typeof db.executeMultiple === 'function') {
    try {
      await db.executeMultiple(sql);
      log(`Schema applied from ${schemaPath} (executeMultiple)`);
    } catch (err) {
      // Legacy v1 DBs may lack columns/indexes the v3 template expects. Migrate first, then retry.
      log(`Schema apply failed: ${err.message} — running migrations then retry`);
      try {
        await runBrainDbMigrations(db, {
          log: (m) => log(m),
          error: (m) => logError(m),
          brainDbFilePath: migrationOpts.brainDbFilePath ?? process.env.BRAIN_DB_PATH,
          brainId: migrationOpts.brainId ?? process.env.BRAIN_DB_BRAIN_ID,
        });
        await db.executeMultiple(sql);
        log(`Schema applied from ${schemaPath} (executeMultiple, after migrate)`);
      } catch (err2) {
        logError(`Schema application failed after migrate retry: ${err2.message}`);
      }
    }
    return;
  }

  // Fallback: split on ';\n' (safer than bare ';' to reduce false splits on
  // semicolons inside SQL comments or strings), then strip comment lines from
  // each segment — do NOT filter whole segments by their first line, because
  // segments in brain-schema.sql start with a comment followed by CREATE TABLE.
  // NOTE: the bundled brain-schema.sql is controlled and does not embed ';'
  // inside string literals. If the schema ever gains such statements, migrate
  // to db.executeMultiple() (already the primary path above for libsql ≥0.5).
  const statements = sql
    .split(/;(?:\s*\n|$)/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      await db.execute(stmt + ';');
    } catch (err) {
      // Log but do not abort — partial schema is better than no schema.
      logError(`Schema statement failed: ${err.message}\n  Statement: ${stmt.slice(0, 80)}`);
    }
  }
  log(`Schema applied from ${schemaPath} (${statements.length} statements)`);
}

// ── Schema migrations ─────────────────────────────────────────────────────────

/**
 * Run brain.db migrations (v1→v2 additive columns, v2→v3 rebuild + skill DDL alignment).
 * @param {object} db  libsql client
 * @param {{ brainDbFilePath?: string, brainId?: string, skipBackup?: boolean }} [opts]
 */
export async function runMigrations(db, opts = {}) {
  await runBrainDbMigrations(db, {
    log: (msg) => log(msg),
    error: (msg) => logError(msg),
    brainDbFilePath: opts.brainDbFilePath ?? process.env.BRAIN_DB_PATH,
    brainId: opts.brainId ?? process.env.BRAIN_DB_BRAIN_ID,
    skipBackup: opts.skipBackup,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const brainDbUrl = process.env.BRAIN_DB_URL;
  const brainDbToken = process.env.BRAIN_DB_TOKEN;
  const brainDbPath = process.env.BRAIN_DB_PATH;
  const brainDbSchemaPath = process.env.BRAIN_DB_SCHEMA_PATH;
  const brainDbInstallPath = process.env.BRAIN_DB_INSTALL_PATH;
  const brainId = process.env.BRAIN_DB_BRAIN_ID || 'unknown';

  // Validate required env vars.
  const missing = [];
  if (!brainDbUrl) missing.push('BRAIN_DB_URL');
  if (!brainDbToken) missing.push('BRAIN_DB_TOKEN');
  if (!brainDbPath) missing.push('BRAIN_DB_PATH');

  if (missing.length > 0) {
    logError(`Missing required env vars: ${missing.join(', ')}. Exiting.`);
    process.exit(1);
  }

  // Register signal handlers before any async work so that a SIGTERM arriving
  // during startup (applySchema / db.sync) is handled cleanly. db, syncTimer,
  // and fileOnly are declared as let so the handlers close over mutable references.
  let db = null;
  let syncTimer = null;
  let shuttingDown = false;
  // fileOnly is permanent for the process lifetime: once createClient falls back to
  // file-only mode, there is no re-connect path. The SIGUSR1 handler skips all syncs
  // when fileOnly is true. If a reconnect path is ever added, revisit this invariant.
  let fileOnly = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (syncTimer) clearInterval(syncTimer);
    log(`received ${signal} — shutting down`);
    try {
      // db.close() may be async in some libsql versions — await to ensure
      // WAL/embedded-replica state is flushed before the process exits.
      if (db) await Promise.resolve(db.close());
    } catch (err) {
      logError(`Error closing db: ${err.message}`);
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── SIGUSR1 immediate sync trigger (FR-1) ────────────────────────────────────
  // Registered BEFORE the PID file is written so any writer that reads the PID
  // file and sends SIGUSR1 is guaranteed to find the handler in place.
  // syncInFlight guards against JS-level redundancy (not Rust — the native
  // databaseSyncAsync binding serializes concurrent calls internally).
  let syncInFlight = false;

  async function syncAndRecord(reason) {
    if (!db || fileOnly) {
      log(`${reason} sync skipped (not ready or file-only mode)`);
      return false;
    }
    if (syncInFlight) {
      log(`${reason} sync skipped (already in flight)`);
      return false;
    }
    syncInFlight = true;
    // Re-read on every signal — enables hot-reconfiguration without daemon restart.
    const timeoutMs = Number(process.env.BRAIN_DB_SYNC_TIMEOUT_MS) || 10_000;
    let timeoutId;
    try {
      await Promise.race([
        db.sync(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`sync timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      recordBrainDbSyncHealth(brainId);
      log(`${reason} sync complete`);
      return true;
    } catch (err) {
      logError(`${reason} sync failed: ${err.message}`);
      return false;
    } finally {
      clearTimeout(timeoutId);
      syncInFlight = false;
    }
  }

  process.on('SIGUSR1', async () => {
    log('SIGUSR1 received');
    await syncAndRecord('SIGUSR1');
  });

  // ── PID file (FR-2) ──────────────────────────────────────────────────────────
  // Written AFTER SIGUSR1 handler registration — any writer that reads this file
  // and sends SIGUSR1 is guaranteed to find the handler in place.
  const pidFile = getPidFilePath(`brain-db-sync-${brainId}`);
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
    log(`PID ${process.pid} written to ${pidFile}`);
  } catch (err) {
    log(`Could not write PID file (non-fatal): ${err.message}`);
  }

  // Remove PID file on clean shutdown.
  const removePidFile = () => {
    try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
  };
  process.on('exit', removePidFile);

  // Ensure the parent directory for the local db file exists.
  fs.mkdirSync(path.dirname(brainDbPath), { recursive: true });

  // Load @libsql/client from target project's node_modules.
  let createClient;
  try {
    ({ createClient } = await loadLibsqlClient(brainDbInstallPath));
  } catch (err) {
    logError(`Failed to load @libsql/client: ${err.message}`);
    logError('Install it in the target project: bun add @libsql/client');
    process.exit(1);
  }

  // Open embedded-replica client.
  // Some libsql versions (≥0.6 sqlite3 backend) attempt the remote connection at
  // createClient() time rather than at db.sync() time. Catch that failure and fall
  // back to file-only mode so the daemon stays alive for local FTS/vector queries
  // even when the remote sqld is temporarily unreachable.
  try {
    db = createClient({
      url: `file:${brainDbPath}`,
      syncUrl: brainDbUrl,
      authToken: brainDbToken,
    });
  } catch (err) {
    logError(`Embedded-replica createClient failed: ${err.message} — falling back to file-only mode`);
    fileOnly = true;
    db = createClient({ url: `file:${brainDbPath}` });
  }

  try {
    await db.execute('PRAGMA foreign_keys = ON');
  } catch (err) {
    log(`PRAGMA foreign_keys = ON failed (non-fatal): ${err.message}`);
  }

  const migrationCtx = { brainDbFilePath: brainDbPath, brainId };

  // Apply schema (idempotent CREATE TABLE IF NOT EXISTS).
  await applySchema(db, brainDbSchemaPath, migrationCtx);

  // Run additive migrations for existing v1 instances (adds chunk_meta, syncable).
  await runMigrations(db, migrationCtx);

  // Initial sync — pull from remote (skip if already in file-only fallback mode).
  if (!fileOnly) {
    if (await syncAndRecord('initial')) {
      log(`started brain=${brainId} mode=embedded-replica syncInterval=300s`);
    } else {
      // Initial sync failure is non-fatal — local file db still usable.
      log(`started brain=${brainId} mode=embedded-replica (offline)`);
    }
  } else {
    log(`started brain=${brainId} mode=file-only (remote unreachable at startup)`);
  }

  // Explicit cadence replaces libsql's opaque syncInterval so successful
  // completions can be recorded for doctor freshness checks.
  syncTimer = setInterval(() => { void syncAndRecord('scheduled'); }, SYNC_INTERVAL_MS);
}

// ── Entry point guard ─────────────────────────────────────────────────────────
// import.meta.main is Bun-specific (true when this file is the entry point).
// The daemon is always launched via `bun lib/daemon/brain-db-sync.mjs`, so
// this guard works correctly. It is intentionally not used in Node.js.

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`${LOG_PREFIX} Fatal: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
