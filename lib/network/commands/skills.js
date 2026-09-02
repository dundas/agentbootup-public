/**
 * skills.js — `agentbootup skills` command handler (migrate + local brain.db index; PRD-0014 §3.4, FR-16–18).
 *
 * Usage:
 *   agentbootup skills migrate --from static --to mech-storage [--dry-run] [--cwd <dir>]
 *   agentbootup skills reindex [--cwd <dir>]
 *   agentbootup skills query <intent> [--limit N] [--cwd <dir>]
 *   agentbootup skills show <skill-name> [--cwd <dir>]
 *   agentbootup skills status [--json] [--cwd <dir>]
 *   agentbootup skills push [--dry-run] [--cwd <dir>]
 *   agentbootup skills pull [--dry-run] [--force] [--no-reindex] [--bundle <path>] [--cwd <dir>]
 *   agentbootup skills diff [--dry-run] [--bundle <path>] [--cwd <dir>]
 *
 * Migrates all skills from a StaticBackend (read from .claude/skills/) to a
 * MechStorageBackend (canonical cloud store).
 *
 * Accepts an optional third parameter `_backends` for dependency injection in
 * tests. In production the backends are constructed from credentials and config.
 */

import fs from 'fs';
import path from 'path';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { reindexSkillIndex, skillIndexStatus } from '../../brain/skill-index.js';
import { defaultBrainDbPath } from './brain-db.js';
import { extractCwd, getFlagValue, getPositionalArgs, hasFlag } from '../args.js';
import { resolveProjectAgentId } from '../../project-config.js';
import { readCredentials } from '../../auth/credentials.js';
import { StaticBackend } from '../../skill-projection/backends/static.js';
import { MechStorageBackend } from '../../skill-projection/backends/mech-storage.js';
import {
  MAX_SKILL_BUNDLE_BYTES,
  diffSkillBundleAgainstLocal,
  downloadConfigAssetByPath,
  existingSkillRoots,
  extractSkillBundleTarGzToProject,
  fetchConfigAssetHashes,
  pickLatestSkillBundlePath,
  uploadSkillBundleToMechPlane,
} from '../../brain/skill-bundle-transport.js';

const MECH_STORAGE_BASE_URL = process.env.MECH_STORAGE_URL || 'https://storage.mechdna.net';

function resolveSkillsBrainId(cwd, io, command) {
  try {
    return resolveProjectAgentId(cwd);
  } catch (err) {
    io.stderr(`${command} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Build a minimal fetch-based MechClient from environment credentials.
 *
 * @param {{ appId: string, apiKey: string, baseUrl: string }} opts
 * @returns {object} mechClient compatible with MechStorageBackend
 */
function buildMechClient({ appId, apiKey, baseUrl }) {
  const headers = () => ({
    'Content-Type': 'application/json',
    'X-App-ID': appId,
    Authorization: `Bearer ${apiKey}`,
  });

  async function checkResponse(resp) {
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const err = new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  return {
    async listDocuments(collection) {
      const url = `${baseUrl}/api/documents?collection=${encodeURIComponent(collection)}`;
      const resp = await fetch(url, { method: 'GET', headers: headers() });
      const json = await checkResponse(resp);
      return json.data ?? json ?? [];
    },
    async getDocument(id) {
      const url = `${baseUrl}/api/documents/${encodeURIComponent(id)}`;
      const resp = await fetch(url, { method: 'GET', headers: headers() });
      const json = await checkResponse(resp);
      return json.data ?? json ?? null;
    },
    async createDocument(collection, data) {
      const url = `${baseUrl}/api/documents`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ collection, document: data }),
      });
      const json = await checkResponse(resp);
      return json.data?.id ?? json.id;
    },
    async updateDocument(id, collection, data) {
      const url = `${baseUrl}/api/documents/${encodeURIComponent(id)}`;
      const resp = await fetch(url, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ collection, document: data }),
      });
      await checkResponse(resp);
    },
    async deleteDocument(id) {
      const url = `${baseUrl}/api/documents/${encodeURIComponent(id)}`;
      const resp = await fetch(url, { method: 'DELETE', headers: headers() });
      await checkResponse(resp);
    },
  };
}


/**
 * handleSkillsMigrate — implements `agentbootup skills migrate`.
 *
 * @param {string[]} args - argv after 'skills'
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 * @param {{ staticBackend?: object, mechBackend?: object, agentId?: string } | undefined} _backends
 *   Optional backend overrides for testing. When provided, skips credentials
 *   and backend construction and uses the injected objects directly.
 * @returns {Promise<number>} exit code
 */
export async function handleSkillsMigrate(args, io, _backends) {
  // Skip subcommand token 'migrate' if present
  const subArgs = args[0] === 'migrate' ? args.slice(1) : args;

  // Extract --cwd
  const extracted = extractCwd(subArgs);
  const cwd = path.resolve(extracted.cwd);
  const remainingArgs = extracted.args;

  // Parse flags
  const fromArg = getFlagValue(remainingArgs, '--from');
  const toArg = getFlagValue(remainingArgs, '--to');
  const dryRun = hasFlag(remainingArgs, '--dry-run');

  // Validate --from
  if (!fromArg) {
    io.stderr('skills migrate failed: --from is required (supported: static)');
    return 1;
  }
  if (fromArg !== 'static') {
    io.stderr(`skills migrate failed: --from "${fromArg}" is not supported. Supported: static`);
    return 1;
  }

  // Validate --to
  if (!toArg) {
    io.stderr('skills migrate failed: --to is required (supported: mech-storage)');
    return 1;
  }
  if (toArg !== 'mech-storage') {
    io.stderr(`skills migrate failed: --to "${toArg}" is not supported. Supported: mech-storage`);
    return 1;
  }

  // ── Resolve backends ───────────────────────────────────────────────────────
  let staticBackend;
  let mechBackend;

  if (_backends) {
    // Test injection path
    staticBackend = _backends.staticBackend;
    mechBackend = _backends.mechBackend;
  } else {
    // Production path: build from credentials + env
    const creds = await readCredentials();
    if (!creds) {
      io.stderr('skills migrate failed: no credentials — run: agentbootup auth login');
      return 1;
    }

    const mechAppId = process.env.MECH_APP_ID;
    const mechApiKey = process.env.MECH_API_KEY;
    if (!mechAppId || !mechApiKey) {
      io.stderr('skills migrate failed: MECH_APP_ID and MECH_API_KEY environment variables are required');
      return 1;
    }

    const agentId = resolveSkillsBrainId(cwd, io, 'skills migrate');
    if (!agentId) return 1;

    const mechClient = buildMechClient({
      appId: mechAppId,
      apiKey: mechApiKey,
      baseUrl: MECH_STORAGE_BASE_URL,
    });

    staticBackend = new StaticBackend({ projectRoot: cwd });
    mechBackend = new MechStorageBackend({ mechClient, agentId });
  }

  // ── Load skills from static source ────────────────────────────────────────
  let skills;
  try {
    skills = await staticBackend.loadSkills('master');
  } catch (err) {
    io.stderr(`skills migrate failed: could not load skills from static backend: ${err?.message ?? String(err)}`);
    return 1;
  }

  // ── Dry run ────────────────────────────────────────────────────────────────
  if (dryRun) {
    io.stdout(`Would migrate ${skills.length} skills from static to mech-storage:`);
    for (const skill of skills) {
      io.stdout(`  ${skill.name}`);
    }
    return 0;
  }

  // ── Live migration ─────────────────────────────────────────────────────────
  try {
    for (const skill of skills) {
      await mechBackend.saveSkill(skill);
      io.stdout(`  Pushed: ${skill.name}`);
    }
  } catch (err) {
    io.stderr(`skills migrate failed: ${err?.message ?? String(err)}`);
    return 1;
  }

  io.stdout(`Migrated ${skills.length} skills successfully`);
  return 0;
}

/**
 * @param {string[]} argsWithoutSub — argv after `skills reindex`
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 */
async function handleSkillsReindex(argsWithoutSub, io) {
  const { cwd } = extractCwd(argsWithoutSub);
  const dbPath = defaultBrainDbPath(cwd);
  if (!fs.existsSync(dbPath)) {
    io.stderr(`skills reindex failed: brain.db not found at ${dbPath} — run: agentbootup brain-db migrate`);
    return 1;
  }
  const db = createClient({ url: `file:${dbPath}` });
  try {
    await reindexSkillIndex(db, cwd, { log: (m) => io.stdout(m) });
    return 0;
  } catch (err) {
    io.stderr(`skills reindex failed: ${err?.message ?? String(err)}`);
    return 1;
  } finally {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {string[]} argsWithoutSub — argv after `skills query`
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 */
async function handleSkillsQuery(argsWithoutSub, io) {
  const { cwd, args: rest } = extractCwd(argsWithoutSub);
  let limit = 5;
  const limVal = getFlagValue(rest, '--limit');
  if (limVal) {
    const n = parseInt(limVal, 10);
    if (!Number.isFinite(n) || n < 1) {
      io.stderr('skills query failed: --limit must be a positive integer');
      return 1;
    }
    limit = Math.min(n, 500);
  }
  const intentParts = rest.filter((_, i, arr) => {
    if (arr[i] === '--limit') return false;
    if (i > 0 && arr[i - 1] === '--limit') return false;
    return true;
  });
  const intent = intentParts.join(' ').trim();
  if (!intent) {
    io.stderr('skills query failed: provide a search string, e.g. agentbootup skills query "pr review loop"');
    return 1;
  }

  const dbPath = defaultBrainDbPath(cwd);
  if (!fs.existsSync(dbPath)) {
    io.stderr(`skills query failed: brain.db not found at ${dbPath}`);
    return 1;
  }

  const db = createClient({ url: `file:${dbPath}` });
  try {
    const sql = `
      SELECT d.skill_name, d.section_type, d.heading, d.source_path, d.snippet
      FROM skill_docs_fts
      INNER JOIN skill_docs AS d ON d.rowid = skill_docs_fts.rowid
      WHERE skill_docs_fts MATCH ?
      ORDER BY bm25(skill_docs_fts)
      LIMIT ?
    `;
    let rows;
    try {
      const res = await db.execute({ sql, args: [intent, limit] });
      rows = res.rows ?? [];
    } catch (err) {
      io.stderr(`skills query failed: ${err?.message ?? String(err)}`);
      return 1;
    }

    if (rows.length === 0) {
      io.stdout('No results.');
      return 0;
    }

    for (const row of rows) {
      const r = /** @type {Record<string, unknown>} */ (row);
      const skill = r.skill_name ?? '';
      const st = r.section_type ?? '';
      const head = r.heading ?? '';
      const src = r.source_path ?? '';
      const snip = r.snippet ?? '';
      io.stdout(`— ${skill} [${st}] ${head ? `"${head}" ` : ''}(${src})`);
      if (snip) io.stdout(`  ${String(snip).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
    return 0;
  } finally {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {string[]} argsWithoutSub
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 */
async function handleSkillsShow(argsWithoutSub, io) {
  const { cwd, args: rest } = extractCwd(argsWithoutSub);
  const pos = getPositionalArgs(rest, ['--cwd']);
  const skillName = (pos[0] ?? '').trim();
  if (!skillName) {
    io.stderr('skills show failed: provide <skill-name> (logical directory name, e.g. pr-review-loop)');
    return 1;
  }

  const dbPath = defaultBrainDbPath(cwd);
  if (!fs.existsSync(dbPath)) {
    io.stderr(`skills show failed: brain.db not found at ${dbPath}`);
    return 1;
  }

  const db = createClient({ url: `file:${dbPath}` });
  try {
    const res = await db.execute({
      sql: `SELECT skill_name, canonical_cli, root_path, title, description, category, tags_json, trigger_hints,
                   content_hash, installed_at, indexed_at
            FROM skills WHERE skill_name = ? LIMIT 1`,
      args: [skillName],
    });
    const row = res.rows?.[0];
    if (!row) {
      io.stderr(`skills show: no skill named "${skillName}" in the local index — run: agentbootup skills reindex`);
      return 1;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    io.stdout(`skill_name:    ${r.skill_name ?? ''}`);
    io.stdout(`title:         ${r.title ?? ''}`);
    io.stdout(`description:   ${r.description ?? ''}`);
    io.stdout(`canonical_cli: ${r.canonical_cli ?? ''}`);
    io.stdout(`root_path:     ${r.root_path ?? ''}`);
    io.stdout(`category:      ${r.category ?? '—'}`);
    io.stdout(`tags:          ${r.tags_json ?? '—'}`);
    io.stdout(`trigger_hints: ${r.trigger_hints ?? '—'}`);
    io.stdout(`content_hash:  ${r.content_hash ?? '—'}`);
    return 0;
  } finally {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {string[]} argsWithoutSub
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 */
async function handleSkillsStatus(argsWithoutSub, io) {
  const jsonOut = hasFlag(argsWithoutSub, '--json');
  const { cwd } = extractCwd(argsWithoutSub.filter((a) => a !== '--json'));
  const dbPath = defaultBrainDbPath(cwd);
  if (!fs.existsSync(dbPath)) {
    const msg = `skills status: brain.db not found at ${dbPath}`;
    if (jsonOut) io.stdout(JSON.stringify({ error: msg, brain_db_path: dbPath }, null, 2));
    else io.stderr(msg);
    return 1;
  }

  const db = createClient({ url: `file:${dbPath}` });
  try {
    const st = await skillIndexStatus(db, cwd);
    if (jsonOut) {
      io.stdout(
        JSON.stringify(
          {
            brain_db_path: dbPath,
            total_skills: st.totalSkills,
            last_indexed_at_ms: st.lastIndexedAt,
            stale: st.stale,
            stale_paths: st.stalePaths,
            per_cli: st.perCli,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    io.stdout(`brain.db: ${dbPath}`);
    io.stdout(`  indexed skills (logical): ${st.totalSkills}`);
    io.stdout(
      `  last index activity: ${st.lastIndexedAt != null ? new Date(st.lastIndexedAt).toISOString() : '—'}`,
    );
    io.stdout(`  stale vs disk: ${st.stale ? 'yes' : 'no'}`);
    if (st.stalePaths.length > 0) {
      for (const p of st.stalePaths) {
        io.stdout(`    - ${p}`);
      }
    }
    io.stdout('  per-CLI (canonical rows in `skills`):');
    const clis = Object.keys(st.perCli).sort();
    if (clis.length === 0) io.stdout('    (none)');
    else for (const c of clis) io.stdout(`    ${c}: ${st.perCli[c]}`);
    return 0;
  } catch (err) {
    io.stderr(`skills status failed: ${err?.message ?? String(err)}`);
    return 1;
  } finally {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * `agentbootup skills push` — tar skill roots → mech-plane brain-assets (FR-20).
 *
 * @param {string[]} argsWithoutSub - argv after `skills push`
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 * @param {{ uploadFn?: typeof uploadSkillBundleToMechPlane }} [deps] - tests only
 * @returns {Promise<number>}
 */
export async function handleSkillsPush(argsWithoutSub, io, deps = {}) {
  const uploadFn = deps.uploadFn ?? uploadSkillBundleToMechPlane;
  const { cwd } = extractCwd(argsWithoutSub);
  const dryRun = hasFlag(argsWithoutSub, '--dry-run');

  const brainId = resolveSkillsBrainId(cwd, io, 'skills push');
  if (!brainId) return 1;

  if (dryRun) {
    const roots = existingSkillRoots(cwd);
    if (roots.length === 0) {
      io.stderr('skills push failed: no skill directories under project');
      return 1;
    }
    io.stdout(`Would upload skill bundle for brain_id=${brainId} (roots: ${roots.join(', ')})`);
    return 0;
  }

  /** Injected `uploadFn` (tests): skip reading ~/.agentbootup/credentials. */
  let creds;
  if (deps.uploadFn) {
    creds = { apiKey: 'test', serverUrl: 'https://example.test' };
  } else {
    creds = await readCredentials();
  }
  if (!creds?.apiKey || !creds?.serverUrl) {
    io.stderr('skills push failed: no credentials — run: agentbootup auth login');
    return 1;
  }

  const result = await uploadFn({
    projectRoot: cwd,
    brainId,
    serverUrl: creds.serverUrl,
    apiKey: creds.apiKey,
  });

  if (!result.ok) {
    io.stderr(`skills push failed: ${result.error}`);
    return 1;
  }

  io.stdout(`skills push: uploaded ${result.remotePath} (${result.fileCount} files from ${result.roots.join(', ')})`);
  return 0;
}

/**
 * Resolve credentials for skills pull/diff. `deps` may inject transport fns for tests.
 * @param {{ fetchHashesFn?: unknown, downloadFn?: unknown }} [deps]
 * @returns {Promise<{ apiKey: string, serverUrl: string } | null>}
 */
async function credsForSkillsRemote(deps = {}) {
  const testMode = Boolean(deps.fetchHashesFn || deps.downloadFn);
  if (testMode) {
    return { apiKey: 'test', serverUrl: 'https://example.test' };
  }
  const creds = await readCredentials();
  if (!creds?.apiKey || !creds?.serverUrl) return null;
  return { apiKey: creds.apiKey, serverUrl: creds.serverUrl };
}

/**
 * `agentbootup skills pull` — latest skill bundle from brain-assets (FR-20).
 *
 * @param {string[]} argsWithoutSub
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 * @param {{
 *   fetchHashesFn?: typeof fetchConfigAssetHashes,
 *   downloadFn?: typeof downloadConfigAssetByPath,
 *   pickLatestFn?: typeof pickLatestSkillBundlePath,
 * }} [deps]
 */
export async function handleSkillsPull(argsWithoutSub, io, deps = {}) {
  const fetchHashesFn = deps.fetchHashesFn ?? fetchConfigAssetHashes;
  const downloadFn = deps.downloadFn ?? downloadConfigAssetByPath;
  const pickLatestFn = deps.pickLatestFn ?? pickLatestSkillBundlePath;

  const { cwd } = extractCwd(argsWithoutSub);
  const dryRun = hasFlag(argsWithoutSub, '--dry-run');
  const force = hasFlag(argsWithoutSub, '--force');
  const noReindex = hasFlag(argsWithoutSub, '--no-reindex');
  const bundleArg = getFlagValue(argsWithoutSub, '--bundle');

  const brainId = resolveSkillsBrainId(cwd, io, 'skills pull');
  if (!brainId) return 1;

  const creds = await credsForSkillsRemote(deps);
  if (!creds) {
    io.stderr('skills pull failed: no credentials — run: agentbootup auth login');
    return 1;
  }

  let remotePath = bundleArg?.trim();
  if (!remotePath) {
    const hashes = await fetchHashesFn(creds.serverUrl, creds.apiKey, brainId);
    if (!hashes.ok) {
      io.stderr(`skills pull failed: ${hashes.error}`);
      return 1;
    }
    remotePath = pickLatestFn(hashes.files, brainId);
  }
  if (!remotePath) {
    io.stderr('skills pull failed: no skill bundle found on server (skills/<brain_id>/bundle-*.tar.gz)');
    return 1;
  }

  if (dryRun) {
    io.stdout(`Would pull ${remotePath} into ${cwd}`);
    return 0;
  }

  const dl = await downloadFn(creds.serverUrl, creds.apiKey, brainId, remotePath);
  if (!dl.ok) {
    io.stderr(`skills pull failed: ${dl.error}`);
    return 1;
  }

  if (dl.buffer.length > MAX_SKILL_BUNDLE_BYTES) {
    io.stderr(`skills pull failed: bundle exceeds ${MAX_SKILL_BUNDLE_BYTES} bytes`);
    return 1;
  }

  try {
    extractSkillBundleTarGzToProject(dl.buffer, cwd, { force });
  } catch (err) {
    io.stderr(`skills pull failed: ${err?.message ?? String(err)}`);
    return 1;
  }

  io.stdout(`skills pull: extracted ${remotePath} → ${cwd}${force ? ' (overwrite)' : ' (skipped existing files)'}`);

  if (!noReindex) {
    const dbPath = defaultBrainDbPath(cwd);
    if (fs.existsSync(dbPath)) {
      const code = await handleSkillsReindex(['--cwd', cwd], io);
      if (code !== 0) return code;
    } else {
      io.stdout(
        'skills pull: skipped reindex — no brain.db (run: agentbootup brain-db migrate when the project has a local DB)',
      );
    }
  }

  return 0;
}

/**
 * `agentbootup skills diff` — remote latest bundle vs local skill trees (FR-20–21).
 *
 * @param {string[]} argsWithoutSub
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 * @param {{
 *   fetchHashesFn?: typeof fetchConfigAssetHashes,
 *   downloadFn?: typeof downloadConfigAssetByPath,
 *   pickLatestFn?: typeof pickLatestSkillBundlePath,
 * }} [deps]
 */
export async function handleSkillsDiff(argsWithoutSub, io, deps = {}) {
  const fetchHashesFn = deps.fetchHashesFn ?? fetchConfigAssetHashes;
  const downloadFn = deps.downloadFn ?? downloadConfigAssetByPath;
  const pickLatestFn = deps.pickLatestFn ?? pickLatestSkillBundlePath;

  const { cwd } = extractCwd(argsWithoutSub);
  const dryRun = hasFlag(argsWithoutSub, '--dry-run');
  const bundleArg = getFlagValue(argsWithoutSub, '--bundle');

  const brainId = resolveSkillsBrainId(cwd, io, 'skills diff');
  if (!brainId) return 1;

  const creds = await credsForSkillsRemote(deps);
  if (!creds) {
    io.stderr('skills diff failed: no credentials — run: agentbootup auth login');
    return 1;
  }

  let remotePath = bundleArg?.trim();
  if (!remotePath) {
    const hashes = await fetchHashesFn(creds.serverUrl, creds.apiKey, brainId);
    if (!hashes.ok) {
      io.stderr(`skills diff failed: ${hashes.error}`);
      return 1;
    }
    remotePath = pickLatestFn(hashes.files, brainId);
  }
  if (!remotePath) {
    io.stderr('skills diff failed: no skill bundle found on server');
    return 1;
  }

  if (dryRun) {
    io.stdout(`Would compare local skill files to bundle ${remotePath}`);
    return 0;
  }

  const dl = await downloadFn(creds.serverUrl, creds.apiKey, brainId, remotePath);
  if (!dl.ok) {
    io.stderr(`skills diff failed: ${dl.error}`);
    return 1;
  }

  if (dl.buffer.length > MAX_SKILL_BUNDLE_BYTES) {
    io.stderr(`skills diff failed: bundle exceeds ${MAX_SKILL_BUNDLE_BYTES} bytes`);
    return 1;
  }

  let diff;
  try {
    diff = await diffSkillBundleAgainstLocal(cwd, dl.buffer);
  } catch (err) {
    io.stderr(`skills diff failed: ${err?.message ?? String(err)}`);
    return 1;
  }

  io.stdout(`Bundle: ${remotePath}`);
  if (diff.onlyRemote.length > 0) {
    io.stdout('Only in remote (would add on pull):');
    for (const p of diff.onlyRemote) io.stdout(`  + ${p}`);
  }
  if (diff.onlyLocal.length > 0) {
    io.stdout('Only local (not in bundle):');
    for (const p of diff.onlyLocal) io.stdout(`  - ${p}`);
  }
  if (diff.changed.length > 0) {
    io.stdout('Changed (sha256 differs):');
    for (const p of diff.changed) io.stdout(`  ~ ${p}`);
  }
  if (
    diff.onlyRemote.length === 0 &&
    diff.onlyLocal.length === 0 &&
    diff.changed.length === 0
  ) {
    io.stdout('No differences — local skill tree matches bundle content.');
  }

  return 0;
}

/**
 * runSkillsCommand — dispatcher for `agentbootup skills <subcommand>`.
 *
 * @param {string[]} args - argv after 'skills'
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 * @returns {Promise<number>} exit code
 */
export async function runSkillsCommand(args, io) {
  if (!args || args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    io.stdout('Usage: agentbootup skills <subcommand> [options]');
    io.stdout('');
    io.stdout('Subcommands:');
    io.stdout('  reindex   Rebuild local skill index in .brain/brain.db (FR-14–15)');
    io.stdout('  query     Search indexed skill sections via FTS (FR-16)');
    io.stdout('  show      Print metadata for one logical skill name (FR-17)');
    io.stdout('  status    Index health: counts, stale files, per-CLI breakdown (FR-18)');
    io.stdout('  push      Tar skill roots and upload to mech-storage (FR-20)');
    io.stdout('  pull      Download latest skill bundle and extract (FR-20)');
    io.stdout('  diff      Compare latest bundle to local skill files (FR-20–21)');
    io.stdout('  migrate   Migrate skills from one backend to another');
    io.stdout('');
    io.stdout('Note: manifest-aware bundle install / rollout now lives under `agentbootup bundle ...`.');
    io.stdout('');
    io.stdout('Local index (reindex / query / show / status):');
    io.stdout('  --cwd <dir>        Project root (default: cwd)');
    io.stdout('  query: --limit N   Max FTS rows (default 5, max 500)');
    io.stdout('  status: --json     Machine-readable output');
    io.stdout('');
    io.stdout('push:');
    io.stdout('  --dry-run          List skill roots that would be bundled; no upload');
    io.stdout('');
    io.stdout('pull / diff:');
    io.stdout('  --cwd <dir>        Project root (default: cwd)');
    io.stdout('  --bundle <path>    Remote path (default: latest skills/<brain_id>/bundle-*.tar.gz)');
    io.stdout('  --dry-run          pull: list bundle only; diff: compare plan only');
    io.stdout('pull also:');
    io.stdout('  --force            Overwrite existing files (default: keep existing, tar -k)');
    io.stdout('  --no-reindex       Skip skills reindex after extract');
    io.stdout('');
    io.stdout('Options for migrate:');
    io.stdout('  --from <backend>   Source backend. Supported: static');
    io.stdout('  --to <backend>     Destination backend. Supported: mech-storage');
    io.stdout('  --dry-run          Preview what would be migrated');
    return 0;
  }

  const subcommand = args[0];

  switch (subcommand) {
    case 'migrate':
      return handleSkillsMigrate(args, io);
    case 'reindex':
      return handleSkillsReindex(args.slice(1), io);
    case 'query':
      return handleSkillsQuery(args.slice(1), io);
    case 'show':
      return handleSkillsShow(args.slice(1), io);
    case 'status':
      return handleSkillsStatus(args.slice(1), io);
    case 'push':
      return handleSkillsPush(args.slice(1), io);
    case 'pull':
      return handleSkillsPull(args.slice(1), io);
    case 'diff':
      return handleSkillsDiff(args.slice(1), io);
    default:
      io.stderr(`Unknown skills subcommand: ${subcommand}`);
      io.stdout('Run "agentbootup skills --help" for usage.');
      return 1;
  }
}
