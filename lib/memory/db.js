import crypto, { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { assertContainedRelativePath } from '../bundle/manifest-schema.js';

function sha256Hex(data) {
  const hash = crypto.createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

function ensureMemoryPagePath(pagePath, label = 'page_path') {
  const normalized = assertContainedRelativePath(pagePath, label);
  if (!normalized.startsWith('memory/')) {
    throw new Error(`${label} must stay under memory/: ${pagePath}`);
  }
  return normalized;
}

function walkMemoryFiles(rootDir, baseDir, out) {
  if (!fs.existsSync(rootDir)) return;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkMemoryFiles(abs, baseDir, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(baseDir, abs).replaceAll('\\', '/');
    out.push(ensureMemoryPagePath(rel, 'memory file path'));
  }
}

export function collectMemoryPagePaths(projectRoot) {
  const out = [];
  walkMemoryFiles(path.join(path.resolve(projectRoot), 'memory'), path.resolve(projectRoot), out);
  return out.sort();
}

export async function ensureMemoryTables(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory_events (
      id            TEXT PRIMARY KEY,
      page_path     TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      page_rev      INTEGER NOT NULL,
      machine_id    TEXT,
      created_at    INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory_pages (
      page_path        TEXT PRIMARY KEY,
      content          TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      rev              INTEGER NOT NULL,
      source_event_id  TEXT NOT NULL,
      machine_id       TEXT,
      updated_at       INTEGER NOT NULL,
      FOREIGN KEY (source_event_id) REFERENCES memory_events(id) ON DELETE RESTRICT
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_memory_events_page_time ON memory_events(page_path, created_at)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_memory_pages_updated_at ON memory_pages(updated_at)');
}

async function nextPageRevision(db, pagePath, materializedRev = 0) {
  const latest = await db.execute({
    sql: 'SELECT MAX(page_rev) AS rev FROM memory_events WHERE page_path = ?',
    args: [pagePath],
  });
  const eventRev = Number(latest.rows?.[0]?.rev ?? 0);
  return Math.max(eventRev, materializedRev) + 1;
}

export async function captureMemoryToBrainDb({
  db,
  projectRoot,
  machineId = null,
  now = () => Date.now(),
  pruneMissing = false,
}) {
  await ensureMemoryTables(db);
  const files = collectMemoryPagePaths(projectRoot);
  const fileSet = new Set(files);
  const captured = [];
  const deleted = [];
  const unchanged = [];

  const existingPages = await db.execute({
    sql: 'SELECT page_path, rev FROM memory_pages ORDER BY page_path',
    args: [],
  });

  if (pruneMissing) {
    for (const row of existingPages.rows ?? []) {
      const pagePath = ensureMemoryPagePath(String(row.page_path), 'memory_pages.page_path');
      if (fileSet.has(pagePath)) continue;
      const pageRev = await nextPageRevision(db, pagePath, Number(row.rev ?? 0));
      const eventId = randomUUID();
      const createdAt = now();
      await db.execute({
        sql: `
          INSERT INTO memory_events (
            id, page_path, event_type, content, content_hash, page_rev, machine_id, created_at
          ) VALUES (?, ?, 'delete', '', 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', ?, ?, ?)
        `,
        args: [eventId, pagePath, pageRev, machineId, createdAt],
      });
      await db.execute({
        sql: 'DELETE FROM memory_pages WHERE page_path = ?',
        args: [pagePath],
      });
      deleted.push({ page_path: pagePath, rev: pageRev });
    }
  }

  for (const pagePath of files) {
    const abs = path.join(path.resolve(projectRoot), pagePath);
    const content = fs.readFileSync(abs, 'utf8');
    const contentHash = `sha256:${sha256Hex(content)}`;
    const existing = await db.execute({
      sql: 'SELECT content_hash, rev FROM memory_pages WHERE page_path = ?',
      args: [pagePath],
    });
    const row = existing.rows?.[0] ?? null;
    const priorHash = typeof row?.content_hash === 'string' ? row.content_hash : null;
    const priorRev = Number(row?.rev ?? 0);

    if (priorHash === contentHash) {
      unchanged.push(pagePath);
      continue;
    }

    const pageRev = await nextPageRevision(db, pagePath, priorRev);
    const eventId = randomUUID();
    const createdAt = now();
    await db.execute({
      sql: `
        INSERT INTO memory_events (
          id, page_path, event_type, content, content_hash, page_rev, machine_id, created_at
        ) VALUES (?, ?, 'upsert', ?, ?, ?, ?, ?)
      `,
      args: [eventId, pagePath, content, contentHash, pageRev, machineId, createdAt],
    });
    await db.execute({
      sql: `
        INSERT INTO memory_pages (
          page_path, content, content_hash, rev, source_event_id, machine_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(page_path) DO UPDATE SET
          content = excluded.content,
          content_hash = excluded.content_hash,
          rev = excluded.rev,
          source_event_id = excluded.source_event_id,
          machine_id = excluded.machine_id,
          updated_at = excluded.updated_at
      `,
      args: [pagePath, content, contentHash, pageRev, eventId, machineId, createdAt],
    });
    captured.push({ page_path: pagePath, rev: pageRev, content_hash: contentHash });
  }

  return {
    scanned: files.length,
    captured,
    deleted,
    unchanged,
  };
}

export async function refreshMemoryFromBrainDb({
  db,
  projectRoot,
  force = false,
}) {
  await ensureMemoryTables(db);
  const result = await db.execute(`
    SELECT page_path, content, content_hash, rev
    FROM memory_pages
    ORDER BY page_path
  `);
  const restored = [];
  const overwritten = [];
  const drifted = [];

  for (const row of result.rows ?? []) {
    const pagePath = ensureMemoryPagePath(String(row.page_path), 'memory_pages.page_path');
    const content = String(row.content ?? '');
    const expectedHash = String(row.content_hash ?? '');
    const abs = path.join(path.resolve(projectRoot), pagePath);
    const exists = fs.existsSync(abs);

    if (exists) {
      const current = fs.readFileSync(abs, 'utf8');
      const currentHash = `sha256:${sha256Hex(current)}`;
      if (currentHash === expectedHash) {
        continue;
      }
      if (!force) {
        drifted.push({ page_path: pagePath, rev: Number(row.rev ?? 0) });
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      overwritten.push({ page_path: pagePath, rev: Number(row.rev ?? 0) });
      continue;
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    restored.push({ page_path: pagePath, rev: Number(row.rev ?? 0) });
  }

  return {
    available_pages: (result.rows ?? []).length,
    restored,
    overwritten,
    drifted,
  };
}
