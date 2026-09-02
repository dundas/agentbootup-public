/**
 * Local skill index — walk installed skill trees and populate brain.db (PRD-0014 §3.1–3.3, FR-14–15, FR-19).
 *
 * `skills.skill_name` is the **logical** skill id (directory name under each CLI skills root). When the same
 * directory exists under multiple CLIs, §9.3 yields **one** `skills` row (canonical_cli = resolved winner)
 * and `skill_docs` rows tagged with each source tree’s CLI.
 */

import fs from 'fs';
import path from 'path';
import { readdir, readFile, stat } from 'fs/promises';
import { hashContent } from '../skill-projection/hash.js';

/** Ordered skill roots relative to project (FR-14); `.cursor/skills` optional — skipped if absent. */
export const SKILL_CLI_ROOTS = [
  { canonical_cli: 'claude', rel: '.claude/skills' },
  { canonical_cli: 'gemini', rel: '.gemini/skills' },
  { canonical_cli: 'codex', rel: '.codex/skills' },
  { canonical_cli: 'cursor', rel: '.cursor/skills' },
];

const VALID_SOURCE_CLIS = new Set(SKILL_CLI_ROOTS.map((r) => r.canonical_cli));

/** @param {string} cli */
function cliIndex(cli) {
  const i = SKILL_CLI_ROOTS.findIndex((r) => r.canonical_cli === cli);
  return i === -1 ? 999 : i;
}

/** Max bind params per statement — stay under SQLite default SQLITE_LIMIT_VARIABLE_NUMBER (~999). */
const STALE_DELETE_CHUNK = 400;

const JUNK_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.git',
  'venv',
  '.venv',
]);

/**
 * FR-19 — skip vendored/junk skill leaf directory names.
 * @param {string} name
 * @returns {boolean}
 */
export function shouldSkipSkillLeafName(name) {
  if (!name || name.startsWith('.')) return true;
  if (JUNK_DIR_NAMES.has(name)) return true;
  if (name.endsWith('.bak') || name.endsWith('~')) return true;
  return false;
}

/** Reject path segments that could escape the skills root (readdir names only). */
function isUnsafeLeafName(name) {
  return name.includes('..') || name.includes('/') || name.includes('\\');
}

/**
 * Minimal key: value YAML (first line of simple frontmatter). Multiline values not parsed.
 * @param {string} block
 * @returns {Record<string, string>}
 */
function parseSimpleYaml(block) {
  const meta = {};
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(t);
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return meta;
}

/**
 * @param {string} raw
 * @returns {{ meta: Record<string, string>, sections: Array<{ heading: string | null, content: string }> }}
 */
export function parseSkillMarkdown(raw) {
  let meta = {};
  let body = raw;
  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---\n', 4);
    if (end !== -1) {
      meta = parseSimpleYaml(raw.slice(4, end));
      body = raw.slice(end + 5);
    }
  }

  const lines = body.split('\n');
  /** @type {Array<{ heading: string | null, content: string }>} */
  const sections = [];
  let buf = [];
  /** @type {string | null} */
  let curHeading = null;

  function flush() {
    const text = buf.join('\n').trim();
    if (text || curHeading !== null) {
      sections.push({ heading: curHeading, content: text });
    }
    buf = [];
  }

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush();
      curHeading = line.replace(/^##\s+/, '').trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  return { meta, sections };
}

/**
 * Logical primary key for `skills.skill_name` (directory name only; PRD §9.3).
 * @param {string} skillDirName
 * @returns {string}
 */
export function skillLogicalName(skillDirName) {
  return skillDirName;
}

/**
 * @deprecated PK is logical dir name only — second arg ignored. Use {@link skillLogicalName}.
 * @param {string} _canonical_cli
 * @param {string} dirName
 * @returns {string}
 */
export function skillPrimaryKey(_canonical_cli, dirName) {
  return dirName;
}

/**
 * @param {string | undefined} raw
 * @returns {string | null}
 */
function normalizeCanonicalOverride(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const c = raw.trim().toLowerCase();
  return VALID_SOURCE_CLIS.has(c) ? c : null;
}

/**
 * PRD §9.3 — prefer `.claude/skills/` unless frontmatter `canonical_cli` selects another installed copy.
 *
 * @param {DiscoveredSkill[]} entries Same logical skill (same directory name), ≥1
 * @returns {{ winner: DiscoveredSkill, others: DiscoveredSkill[] }}
 */
export function resolveCanonicalGroup(entries) {
  if (entries.length === 1) {
    return { winner: entries[0], others: [] };
  }
  const byCli = new Map(entries.map((e) => [e.sourceCli, e]));
  const sorted = [...entries].sort((a, b) => cliIndex(a.sourceCli) - cliIndex(b.sourceCli));

  for (const e of sorted) {
    const want = normalizeCanonicalOverride(e.meta.canonical_cli);
    if (want && byCli.has(want)) {
      const w = /** @type {DiscoveredSkill} */ (byCli.get(want));
      return { winner: w, others: entries.filter((x) => x !== w) };
    }
  }

  for (const { canonical_cli } of SKILL_CLI_ROOTS) {
    const w = byCli.get(canonical_cli);
    if (w) return { winner: w, others: entries.filter((x) => x !== w) };
  }

  const w = entries[0];
  return { winner: w, others: entries.slice(1) };
}

/**
 * @typedef {{
 *   logicalName: string,
 *   sourceCli: string,
 *   rel: string,
 *   skillDirName: string,
 *   raw: string,
 *   st: import('fs').Stats,
 *   contentHash: string,
 *   meta: Record<string, string>,
 *   sections: Array<{ heading: string | null, content: string }>,
 *   relSource: string,
 * }} DiscoveredSkill
 */

/**
 * Walk skill roots and return one entry per SKILL.md (physical installs).
 *
 * @param {string} projectRoot
 * @returns {Promise<DiscoveredSkill[]>}
 */
export async function collectDiscoveredSkillEntries(projectRoot) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const root = path.resolve(projectRoot);
  /** @type {DiscoveredSkill[]} */
  const out = [];

  for (const { canonical_cli, rel } of SKILL_CLI_ROOTS) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const skillsRoot = path.join(root, rel);
    if (!fs.existsSync(skillsRoot)) continue;

    let dirEntries;
    try {
      dirEntries = await readdir(skillsRoot, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }

    for (const ent of dirEntries) {
      if (!ent.isDirectory()) continue;
      if (shouldSkipSkillLeafName(ent.name)) continue;
      if (isUnsafeLeafName(ent.name)) continue;

      const skillDirName = ent.name;
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const skillMdPath = path.join(skillsRoot, skillDirName, 'SKILL.md');
      let raw;
      let st;
      try {
        raw = await readFile(skillMdPath, 'utf-8');
        st = await stat(skillMdPath);
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }

      const contentHash = hashContent(raw);
      const { meta, sections } = parseSkillMarkdown(raw);
      const relSource = path.relative(root, skillMdPath).split(path.sep).join('/');

      out.push({
        logicalName: skillDirName,
        sourceCli: canonical_cli,
        rel,
        skillDirName,
        raw,
        st,
        contentHash,
        meta,
        sections,
        relSource,
      });
    }
  }

  return out;
}

/**
 * @param {DiscoveredSkill[]} flat
 * @returns {Map<string, DiscoveredSkill[]>}
 */
export function groupSkillsByLogicalName(flat) {
  /** @type {Map<string, DiscoveredSkill[]>} */
  const m = new Map();
  for (const e of flat) {
    const list = m.get(e.logicalName) ?? [];
    list.push(e);
    m.set(e.logicalName, list);
  }
  return m;
}

/**
 * Delete DB rows for skills no longer present on disk.
 * Requires `PRAGMA foreign_keys = ON` so `DELETE FROM skills` cascades to `skill_docs`.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string[]} logicalNames
 */
async function deleteStaleSkills(db, logicalNames) {
  if (logicalNames.length === 0) {
    await db.execute('DELETE FROM skill_index_state');
    await db.execute('DELETE FROM skill_docs');
    await db.execute('DELETE FROM skills');
    return;
  }
  const discovered = new Set(logicalNames);
  const allRes = await db.execute('SELECT skill_name FROM skills');
  /** @type {string[]} */
  const stale = [];
  for (const row of allRes.rows ?? []) {
    const k = /** @type {{ skill_name: string }} */ (row).skill_name;
    if (!discovered.has(k)) stale.push(k);
  }
  if (stale.length === 0) return;

  for (let i = 0; i < stale.length; i += STALE_DELETE_CHUNK) {
    const chunk = stale.slice(i, i + STALE_DELETE_CHUNK);
    const ph = chunk.map(() => '?').join(',');
    await db.execute({
      sql: `DELETE FROM skill_index_state WHERE skill_name IN (${ph})`,
      args: chunk,
    });
    await db.execute({
      sql: `DELETE FROM skills WHERE skill_name IN (${ph})`,
      args: chunk,
    });
  }
}

/**
 * @param {import('@libsql/client').Client} db
 * @returns {Promise<Map<string, { content_hash: string }>>}
 */
async function loadSkillIndexStateByPath(db) {
  const res = await db.execute('SELECT source_path, content_hash FROM skill_index_state');
  /** @type {Map<string, { content_hash: string }>} */
  const map = new Map();
  for (const row of res.rows ?? []) {
    const r = /** @type {{ source_path: string, content_hash: string }} */ (row);
    map.set(r.source_path, { content_hash: r.content_hash });
  }
  return map;
}

/**
 * @param {string} logicalName
 * @param {DiscoveredSkill[]} group
 * @param {DiscoveredSkill} winner
 * @param {Map<string, string>} hashBySkill
 * @param {Map<string, { content_hash: string }>} indexStateByPath
 */
function shouldSkipGroup(logicalName, group, winner, hashBySkill, indexStateByPath) {
  if (hashBySkill.get(logicalName) !== winner.contentHash) return false;
  for (const e of group) {
    const st = indexStateByPath.get(e.relSource);
    if (!st || st.content_hash !== e.contentHash) return false;
  }
  return true;
}

/**
 * Insert docs for one physical SKILL.md; `skill_docs.canonical_cli` = that tree’s CLI (§9.3 tagging).
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} logicalName
 * @param {DiscoveredSkill} d
 * @param {number} now
 * @param {number} startOrdinal
 * @returns {Promise<{ docs: number, nextOrdinal: number }>}
 */
async function insertDocsForSource(db, logicalName, d, now, startOrdinal) {
  const { sourceCli, meta, sections, relSource, skillDirName } = d;
  let ordinal = startOrdinal;
  let docCount = 0;

  const fm = JSON.stringify(meta);
  if (fm !== '{}') {
    const docId = `${logicalName}::${ordinal}`;
    await db.execute({
      sql: `INSERT INTO skill_docs (
        id, skill_name, canonical_cli, source_path, section_type, heading, ordinal, content, snippet,
        content_hash, source_version, source_version_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        docId,
        logicalName,
        sourceCli,
        relSource,
        'frontmatter',
        null,
        ordinal,
        fm,
        fm.slice(0, 240),
        hashContent(fm),
        null,
        null,
        now,
        now,
      ],
    });
    ordinal++;
    docCount++;
  }

  for (const sec of sections) {
    if (!sec.content?.trim() && !sec.heading) continue;
    const docId = `${logicalName}::${ordinal}`;
    const body = sec.content || '';
    const snip = body.slice(0, 240);
    await db.execute({
      sql: `INSERT INTO skill_docs (
        id, skill_name, canonical_cli, source_path, section_type, heading, ordinal, content, snippet,
        content_hash, source_version, source_version_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        docId,
        logicalName,
        sourceCli,
        relSource,
        'section',
        sec.heading,
        ordinal,
        body,
        snip,
        hashContent(`${sec.heading ?? ''}\n${body}`),
        null,
        null,
        now,
        now,
      ],
    });
    ordinal++;
    docCount++;
  }

  await db.execute({
    sql: `INSERT INTO skill_index_state (
      source_path, skill_name, canonical_cli, content_hash, mtime_ms, size_bytes, indexed_at, doc_count, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      relSource,
      logicalName,
      sourceCli,
      d.contentHash,
      Math.floor(d.st.mtimeMs),
      d.st.size,
      now,
      ordinal - startOrdinal,
      null,
    ],
  });

  return { docs: docCount, nextOrdinal: ordinal };
}

/**
 * One logical skill: `skills` row from winner; docs + index_state for every physical copy.
 *
 * @param {import('@libsql/client').Client} db
 * @param {DiscoveredSkill} winner
 * @param {DiscoveredSkill[]} others
 * @param {number} now
 * @returns {Promise<{ docs: number }>}
 */
async function insertLogicalSkillGroup(db, winner, others, now) {
  const logicalName = winner.logicalName;
  const title = winner.meta.name || winner.skillDirName;
  const description = winner.meta.description || '';

  let tagsJson = null;
  if (winner.meta.tags) {
    const parts = String(winner.meta.tags)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    tagsJson = JSON.stringify(parts);
  }

  await db.execute({
    sql: `INSERT INTO skills (
      skill_name, canonical_cli, root_path, title, description, category, tags_json, trigger_hints,
      source_version, source_version_id, content_hash, installed_at, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      logicalName,
      winner.sourceCli,
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      path.join(winner.rel, winner.skillDirName),
      title,
      description,
      winner.meta.category || null,
      tagsJson,
      winner.meta.triggers || winner.meta.trigger || null,
      null,
      null,
      winner.contentHash,
      now,
      now,
    ],
  });

  let ordinal = 0;
  let totalDocs = 0;

  const { docs: d0, nextOrdinal: o0 } = await insertDocsForSource(db, logicalName, winner, now, ordinal);
  totalDocs += d0;
  ordinal = o0;

  for (const o of others) {
    const { docs: dn, nextOrdinal: on } = await insertDocsForSource(db, logicalName, o, now, ordinal);
    totalDocs += dn;
    ordinal = on;
  }

  return { docs: totalDocs };
}

/**
 * Incremental reindex (§3.2–3.3): stale cleanup; skip when canonical + all on-disk file hashes match.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} projectRoot
 * @param {{ log?: (m: string) => void }} [opts]
 * @returns {Promise<{ skills: number, docs: number, skipped: number }>}
 */
export async function reindexSkillIndex(db, projectRoot, opts = {}) {
  const log = opts.log ?? (() => {});
  const now = Date.now();

  const flat = await collectDiscoveredSkillEntries(projectRoot);
  const byLogical = groupSkillsByLogicalName(flat);
  const logicalNames = [...byLogical.keys()];

  let totalSkills = 0;
  let totalDocs = 0;
  let skipped = 0;

  await db.execute('PRAGMA foreign_keys = ON');
  await db.execute('BEGIN');
  try {
    await deleteStaleSkills(db, logicalNames);

    const hashRes = await db.execute('SELECT skill_name, content_hash FROM skills');
    /** @type {Map<string, string>} */
    const hashBySkill = new Map();
    for (const row of hashRes.rows ?? []) {
      const r = /** @type {{ skill_name: string, content_hash: string }} */ (row);
      hashBySkill.set(r.skill_name, r.content_hash);
    }

    const indexStateByPath = await loadSkillIndexStateByPath(db);

    for (const [logicalName, group] of byLogical) {
      const { winner, others } = resolveCanonicalGroup(group);

      if (shouldSkipGroup(logicalName, group, winner, hashBySkill, indexStateByPath)) {
        skipped++;
        continue;
      }

      await db.execute({ sql: 'DELETE FROM skills WHERE skill_name = ?', args: [logicalName] });
      await db.execute({
        sql: 'DELETE FROM skill_index_state WHERE skill_name = ?',
        args: [logicalName],
      });

      const { docs } = await insertLogicalSkillGroup(db, winner, others, now);
      totalSkills++;
      totalDocs += docs;
    }

    await db.execute('COMMIT');
  } catch (err) {
    await db.execute('ROLLBACK').catch(() => {});
    throw err;
  }

  log(`skill index: ${totalSkills} skills (reindexed), ${skipped} skipped (unchanged), ${totalDocs} skill_docs rows written`);
  return { skills: totalSkills, docs: totalDocs, skipped };
}

/**
 * FR-18 — `agentbootup skills status`: counts, last index time, stale detection, per-CLI breakdown.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} projectRoot
 * @returns {Promise<{
 *   totalSkills: number,
 *   lastIndexedAt: number | null,
 *   stale: boolean,
 *   stalePaths: string[],
 *   perCli: Record<string, number>,
 * }>}
 */
export async function skillIndexStatus(db, projectRoot) {
  let totalSkills = 0;
  try {
    const r = await db.execute('SELECT COUNT(*) AS c FROM skills');
    totalSkills = Number(r.rows?.[0]?.c ?? 0);
  } catch {
    totalSkills = 0;
  }

  let lastIndexedAt = null;
  try {
    const r = await db.execute('SELECT MAX(indexed_at) AS m FROM skill_index_state');
    const m = r.rows?.[0]?.m;
    lastIndexedAt = m != null ? Number(m) : null;
  } catch {
    lastIndexedAt = null;
  }

  /** @type {Record<string, number>} */
  const perCli = {};
  try {
    const r = await db.execute(
      'SELECT canonical_cli, COUNT(*) AS c FROM skills GROUP BY canonical_cli ORDER BY canonical_cli',
    );
    for (const row of r.rows ?? []) {
      const x = /** @type {{ canonical_cli: string, c: number }} */ (row);
      perCli[x.canonical_cli] = Number(x.c);
    }
  } catch {
    /* missing table */
  }

  const flat = await collectDiscoveredSkillEntries(projectRoot);
  /** @type {Map<string, number>} */
  const indexedAtByPath = new Map();
  try {
    const r = await db.execute('SELECT source_path, indexed_at FROM skill_index_state');
    for (const row of r.rows ?? []) {
      const x = /** @type {{ source_path: string, indexed_at: number }} */ (row);
      indexedAtByPath.set(x.source_path, Number(x.indexed_at));
    }
  } catch {
    /* empty */
  }

  /** @type {string[]} */
  const stalePaths = [];
  for (const e of flat) {
    const idxAt = indexedAtByPath.get(e.relSource);
    if (idxAt == null || e.st.mtimeMs > idxAt) {
      stalePaths.push(e.relSource);
    }
  }

  return {
    totalSkills,
    lastIndexedAt,
    stale: stalePaths.length > 0,
    stalePaths,
    perCli,
  };
}
