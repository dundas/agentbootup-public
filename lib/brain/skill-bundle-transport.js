/**
 * Skill bundle tar.gz build + mech-plane upload / pull / diff (PRD-0014 FR-20–21).
 * Remote key: skills/<brain_id>/bundle-<YYYY-MM-DD-HHmmss>.tar.gz
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import path from 'path';
import { readFile, readdir } from 'fs/promises';
import { SKILL_CLI_ROOTS } from './skill-index.js';
import { apiUrl, isValidServerUrl } from '../auth/validate.js';
import { brainAssetPushHeaders } from '../brain-asset-headers.js';
import { formatBrainDbBackupTimestamp } from './brain-db-backup-upload.js';

export { formatBrainDbBackupTimestamp as formatSkillBundleTimestamp };

/** @type {number} */
export const MAX_SKILL_BUNDLE_BYTES = 64 * 1024 * 1024;

const PUSH_TIMEOUT_MS = 120_000;
const HASH_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 120_000;

/** @param {string} remotePath */
export function bundleTimestampFromPath(remotePath) {
  const m = /bundle-(\d{4}-\d{2}-\d{2}-\d{6})\.tar\.gz$/.exec(remotePath);
  return m?.[1] ?? null;
}

/**
 * Latest `skills/<brainId>/bundle-<ts>.tar.gz` by timestamp suffix (desc).
 * @param {Array<{ path?: string }>} files — from hashes API
 * @param {string} brainId
 * @returns {string | null}
 */
export function pickLatestSkillBundlePath(files, brainId) {
  const prefix = `skills/${brainId}/bundle-`;
  const paths = (files || [])
    .map((f) => f.path)
    .filter((p) => typeof p === 'string' && p.startsWith(prefix) && p.endsWith('.tar.gz'));
  if (paths.length === 0) return null;
  paths.sort((a, b) => {
    const ta = bundleTimestampFromPath(a) ?? '';
    const tb = bundleTimestampFromPath(b) ?? '';
    return tb.localeCompare(ta);
  });
  return paths[0];
}

/**
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {string} brainId
 * @returns {Promise<{ ok: true, files: Array<{ path: string, hash: string, size: number }> } | { ok: false, error: string }>}
 */
export async function fetchConfigAssetHashes(serverUrl, apiKey, brainId) {
  if (!isValidServerUrl(serverUrl)) {
    return { ok: false, error: 'invalid server URL' };
  }
  const endpoint = apiUrl(
    serverUrl,
    `/v1/brain-assets/${encodeURIComponent(brainId)}/hashes?asset_type=config`,
  );
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), HASH_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timerId);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 400)}` };
    }
    const json = await resp.json().catch(() => null);
    const files = json?.data?.files;
    if (!Array.isArray(files)) {
      return { ok: false, error: 'invalid server response (missing data.files)' };
    }
    return { ok: true, files };
  } catch (err) {
    clearTimeout(timerId);
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'request timed out' };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * GET /v1/brain-assets/:brainId?asset_type=config&path=… — single file (server filters by path).
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {string} brainId
 * @param {string} remotePath
 * @returns {Promise<{ ok: true, buffer: Buffer } | { ok: false, error: string }>}
 */
export async function downloadConfigAssetByPath(serverUrl, apiKey, brainId, remotePath) {
  if (!isValidServerUrl(serverUrl)) {
    return { ok: false, error: 'invalid server URL' };
  }
  const q = new URLSearchParams({ asset_type: 'config', path: remotePath });
  const endpoint = apiUrl(serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}?${q.toString()}`);
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timerId);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 400)}` };
    }
    const json = await resp.json().catch(() => null);
    const files = json?.data?.files;
    const b64 = files?.[0]?.content_base64;
    if (typeof b64 !== 'string' || !b64.length) {
      return { ok: false, error: 'invalid pull response (missing file content)' };
    }
    return { ok: true, buffer: Buffer.from(b64, 'base64') };
  } catch (err) {
    clearTimeout(timerId);
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'request timed out' };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * @param {string} projectRoot
 * @returns {Promise<Map<string, string>>} rel path → sha256 hex
 */
export async function hashSkillTreeFiles(projectRoot) {
  const root = path.resolve(projectRoot);
  const m = new Map();
  const roots = existingSkillRoots(root);
  for (const relRoot of roots) {
    const absRoot = path.join(root, relRoot);
    await hashWalkFiles(absRoot, root, m);
  }
  return m;
}

/**
 * @param {string} absDir
 * @param {string} projectRoot
 * @param {Map<string, string>} out
 */
async function hashWalkFiles(absDir, projectRoot, out) {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(absDir, e.name);
    const rel = path.relative(projectRoot, abs).replaceAll('\\', '/');
    if (e.name === 'node_modules' || e.name === '.git') continue;
    if (e.isDirectory()) {
      await hashWalkFiles(abs, projectRoot, out);
    } else if (e.isFile()) {
      const raw = await readFile(abs);
      const h = crypto.createHash('sha256').update(raw).digest('hex');
      out.set(rel, h);
    }
  }
}

/**
 * @param {Buffer} bundleBuffer
 * @param {string} projectRoot
 * @param {{ force?: boolean }} opts
 */
export function extractSkillBundleTarGzToProject(bundleBuffer, projectRoot, opts = {}) {
  const force = Boolean(opts.force);
  const root = path.resolve(projectRoot);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-skills-extract-'));
  const gzPath = path.join(tmpDir, 'bundle.tar.gz');
  try {
    fs.writeFileSync(gzPath, bundleBuffer);
    const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const args = force ? ['-xzf', gzPath, '-C', root] : ['-xzkf', gzPath, '-C', root];
    const r = spawnSync(tarBin, args, { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(
        `tar extract failed (${r.status}): ${(r.stderr || r.stdout || '').trim() || 'unknown error'}`,
      );
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} localProjectRoot
 * @param {Buffer} bundleBuffer
 * @returns {Promise<{ onlyRemote: string[], onlyLocal: string[], changed: string[] }>}
 */
export async function diffSkillBundleAgainstLocal(localProjectRoot, bundleBuffer) {
  const localMap = await hashSkillTreeFiles(localProjectRoot);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-skills-diff-'));
  const gz = path.join(tmp, 'b.tar.gz');
  try {
    fs.writeFileSync(gz, bundleBuffer);
    const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const r = spawnSync(tarBin, ['-xzf', gz, '-C', tmp], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`tar extract failed: ${(r.stderr || r.stdout || '').trim()}`);
    }
    const remoteMap = await hashSkillTreeFiles(tmp);
    const onlyRemote = [];
    const onlyLocal = [];
    const changed = [];
    for (const [p, h] of remoteMap.entries()) {
      if (!localMap.has(p)) onlyRemote.push(p);
      else if (localMap.get(p) !== h) changed.push(p);
    }
    for (const p of localMap.keys()) {
      if (!remoteMap.has(p)) onlyLocal.push(p);
    }
    onlyRemote.sort();
    onlyLocal.sort();
    changed.sort();
    return { onlyRemote, onlyLocal, changed };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Skill roots that exist under projectRoot, sorted for deterministic archives (FR-21).
 * @param {string} projectRoot
 * @returns {string[]} relative paths from project root (POSIX slashes)
 */
export function existingSkillRoots(projectRoot) {
  const root = path.resolve(projectRoot);
  const out = [];
  for (const { rel } of SKILL_CLI_ROOTS) {
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) out.push(rel.replaceAll('\\', '/'));
    } catch {
      /* skip */
    }
  }
  return out.sort();
}

/**
 * Create a gzipped tar of all files under existing skill roots.
 * Uses system `tar` (POSIX); deterministic member order via sorted roots and sorted file list.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ buffer: Buffer, roots: string[], fileCount: number }>}
 */
export async function buildSkillBundleTarGz(projectRoot) {
  const root = path.resolve(projectRoot);
  const roots = existingSkillRoots(root);
  if (roots.length === 0) {
    throw new Error('no skill directories found — expected at least one of .claude/skills, .gemini/skills, .codex/skills, .cursor/skills');
  }

  /** @type {string[]} */
  const relFiles = [];
  for (const relRoot of roots) {
    const absRoot = path.join(root, relRoot);
    await walkFiles(absRoot, root, relFiles);
  }
  relFiles.sort();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-skill-bundle-'));
  const gzPath = path.join(tmpDir, 'bundle.tar.gz');

  try {
    if (relFiles.length === 0) {
      throw new Error('skill directories exist but contain no files');
    }

    const listFile = path.join(tmpDir, 'files.txt');
    fs.writeFileSync(listFile, relFiles.join('\n') + '\n', 'utf8');

    const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const r = spawnSync(tarBin, ['-czf', gzPath, '-C', root, '-T', listFile], {
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(
        `tar failed (${r.status}): ${(r.stderr || r.stdout || '').trim() || 'unknown error'}`,
      );
    }

    const buffer = await readFile(gzPath);
    if (buffer.length > MAX_SKILL_BUNDLE_BYTES) {
      throw new Error(
        `skill bundle is ${buffer.length} bytes (max ${MAX_SKILL_BUNDLE_BYTES}) — reduce size or split skills`,
      );
    }
    return { buffer, roots, fileCount: relFiles.length };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} absDir
 * @param {string} projectRoot
 * @param {string[]} outRel POSIX paths relative to projectRoot
 */
async function walkFiles(absDir, projectRoot, outRel) {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(absDir, e.name);
    const rel = path.relative(projectRoot, abs).replaceAll('\\', '/');
    if (e.name === 'node_modules' || e.name === '.git') continue;
    if (e.isDirectory()) {
      await walkFiles(abs, projectRoot, outRel);
    } else if (e.isFile()) {
      outRel.push(rel);
    }
  }
}

/**
 * @param {string} brainId
 * @param {string} ts from formatSkillBundleTimestamp()
 */
export function skillBundleRemotePath(brainId, ts) {
  return `skills/${brainId}/bundle-${ts}.tar.gz`;
}

/**
 * @param {{ projectRoot: string, brainId: string, serverUrl: string, apiKey: string }} args
 * @returns {Promise<{ ok: true, remotePath: string, fileCount: number, roots: string[] } | { ok: false, error: string }>}
 */
export async function uploadSkillBundleToMechPlane(args) {
  const { projectRoot, brainId, serverUrl, apiKey } = args;
  if (!isValidServerUrl(serverUrl)) {
    return { ok: false, error: 'invalid server URL' };
  }

  let buffer;
  let roots;
  let fileCount;
  try {
    const built = await buildSkillBundleTarGz(projectRoot);
    buffer = built.buffer;
    roots = built.roots;
    fileCount = built.fileCount;
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }

  const ts = formatBrainDbBackupTimestamp();
  const remotePath = skillBundleRemotePath(brainId, ts);

  const payload = {
    files: [
      {
        path: remotePath,
        content_base64: buffer.toString('base64'),
        asset_type: 'config',
        cli: 'shared',
      },
    ],
  };

  const endpoint = apiUrl(serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}/push`);
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: brainAssetPushHeaders(apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timerId);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 400)}` };
    }
    return { ok: true, remotePath, fileCount, roots };
  } catch (err) {
    clearTimeout(timerId);
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'request timed out' };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}
