import fsp from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { discoverTranscriptFiles } from './transcript-discovery.js';
import { normalizeTranscriptBuffer, stringifyNormalizedEvents } from './transcript-normalize.js';
import { stableJson } from './stable-json.js';
import { getMachineId } from '../machine-id/machine-id.js';
import { transcriptCacheManifestLockFile, withTranscriptManifestLock } from './transcript-manifest-lock.js';

export const TRANSCRIPT_CACHE_SCHEMA_VERSION = 1;
export const NORMALIZATION_VERSION = 'mech-run.v1';
export const TRANSCRIPT_CACHE_DIR = path.join('.brain', 'transcripts');

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sanitizeSegment(value, fallback = 'unknown') {
  const cleaned = String(value || '').trim().replaceAll(/[^A-Za-z0-9._-]/g, '-');
  return cleaned || fallback;
}

function normalizeRelPath(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => sanitizeSegment(part))
    .join('/');
}

function sessionIdFromTranscript(transcript) {
  const filename = transcript?.filename || path.basename(transcript?.relative_path || transcript?.path || '');
  const ext = path.extname(filename);
  // Discovery always supplies a file-backed path today; this fallback protects future custom sources.
  return (ext ? filename.slice(0, -ext.length) : filename) || 'unknown-session';
}

function extractTimestampCandidates(value, out, depth = 0) {
  // Transcript events are usually shallow; this caps pathological nested JSON.
  if (!value || typeof value !== 'object' || depth > 20) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      extractTimestampCandidates(item, out, depth + 1);
    }
    return;
  }
  for (const key of ['timestamp', 'created_at', 'createdAt', 'time', 'ts']) {
    const candidate = value[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const date = new Date(candidate);
      if (!Number.isNaN(date.getTime())) out.push(date.toISOString());
    }
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') {
      // Recurse through all nested payloads because CLIs put timestamps under different envelopes.
      extractTimestampCandidates(nested, out, depth + 1);
    }
  }
}

function transcriptTimestampRange(buffer, filename = '') {
  const text = buffer.toString('utf-8');
  const timestamps = [];
  const tryJson = (line) => {
    try {
      extractTimestampCandidates(JSON.parse(line), timestamps);
    } catch {
      // Transcript formats are heterogeneous; malformed lines should not block caching.
    }
  };
  if (filename.endsWith('.jsonl')) {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) tryJson(line);
    }
  } else if (filename.endsWith('.json')) {
    tryJson(text);
  }
  timestamps.sort();
  return {
    firstTimestamp: timestamps[0] || null,
    lastTimestamp: timestamps[timestamps.length - 1] || null,
  };
}

function updateEntryFromBuffer(entry, buffer) {
  const timestampRange = transcriptTimestampRange(buffer, entry.filename);
  entry.contentHash = sha256Buffer(buffer);
  entry.size = buffer.length;
  entry.firstTimestamp = timestampRange.firstTimestamp;
  entry.lastTimestamp = timestampRange.lastTimestamp;
  return entry;
}

function transcriptReadErrorEntry(entry, err) {
  return {
    ...entry,
    error: err.code || err.name || 'read_failed',
  };
}

function rawCacheRelativePath(transcript, machineId) {
  // The machine segment is load-bearing: identical CLI session IDs from different machines must not collide.
  const safeMachine = sanitizeSegment(machineId);
  const safeCli = sanitizeSegment(transcript.cli);
  const rel = normalizeRelPath(transcript.relative_path || transcript.filename || path.basename(transcript.path));
  return path.posix.join('raw', safeMachine, safeCli, rel);
}

export function normalizedCacheRelativePath(rawCachePath) {
  const parts = String(rawCachePath || '').split('/').filter(Boolean);
  const [, machineId = 'unknown', provider = 'unknown', ...rest] = parts;
  const rel = rest.join('/') || 'session.jsonl';
  const ext = path.posix.extname(rel);
  const stem = ext ? rel.slice(0, -ext.length) : rel;
  const extTag = ext ? ext.slice(1) : 'noext';
  return path.posix.join('normalized', NORMALIZATION_VERSION, provider, machineId, `${stem}.${extTag}.jsonl`);
}

export function stringifyManifest(manifest) {
  return `${JSON.stringify(stableJson(manifest), null, 2)}\n`;
}

export function getTranscriptCacheRoot(projectRoot) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolvedProjectRoot = path.resolve(projectRoot);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.join(resolvedProjectRoot, TRANSCRIPT_CACHE_DIR);
}

export function safeJoinUnder(root, relPath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const normalizedRoot = path.resolve(root);
  if (path.isAbsolute(String(relPath || ''))) {
    throw new Error('Refusing to write transcript cache outside cache root');
  }
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const dest = path.resolve(normalizedRoot, ...String(relPath || '').split('/').filter(Boolean));
  const relative = path.relative(normalizedRoot, dest);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to write transcript cache outside cache root');
  }
  return dest;
}

export async function readManifest(projectRoot) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const manifestPath = path.join(getTranscriptCacheRoot(projectRoot), 'manifest.json');
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeManifestAtomicUnlocked(projectRoot, manifest) {
  const root = getTranscriptCacheRoot(projectRoot);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Refusing unsafe transcript cache root');
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const manifestPath = path.join(root, 'manifest.json');
  const tmpPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  const data = stringifyManifest(manifest);
  const handle = await fsp.open(tmpPath, 'wx', 0o600);
  let writeError = null;
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    writeError = err;
  } finally {
    try {
      await handle.close();
    } catch (closeErr) {
      if (!writeError) writeError = closeErr;
    }
  }
  if (writeError) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw writeError;
  }
  try {
    const existing = await fsp.lstat(manifestPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('Refusing unsafe transcript cache manifest');
    await fsp.rename(tmpPath, manifestPath);
    await fsp.chmod(manifestPath, 0o600);
    const directory = await fsp.open(root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function writeManifestAtomic(projectRoot, manifest) {
  return withTranscriptManifestLock(transcriptCacheManifestLockFile(projectRoot),
    () => writeManifestAtomicUnlocked(projectRoot, manifest), { trustedRoot: path.resolve(projectRoot) });
}

export async function updateManifestAtomic(projectRoot, update) {
  return withTranscriptManifestLock(transcriptCacheManifestLockFile(projectRoot), async () => {
    const current = await readManifest(projectRoot);
    const next = await update(current);
    await writeManifestAtomicUnlocked(projectRoot, next);
    return next;
  }, { trustedRoot: path.resolve(projectRoot) });
}

export function createEmptyManifest({ brainId, machineId, generatedAt = new Date().toISOString() }) {
  return {
    schemaVersion: TRANSCRIPT_CACHE_SCHEMA_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    brainId,
    machineId,
    generatedAt,
    raw: [],
    normalized: [],
    conflicts: [],
    errors: [],
  };
}

export async function collectTranscriptSources({ cwd, brainId = '', machineId = '', generatedAt, computeMetadata = true } = {}) {
  const projectRoot = path.resolve(cwd || process.cwd()); // nosemgrep: cwd is the explicit project root boundary for local cache writes.
  const resolvedMachineId = machineId || await getMachineId();
  const transcripts = await discoverTranscriptFiles({ projectRoot });
  const entries = [];

  for (const transcript of transcripts) {
    const entry = {
      brainId,
      machineId: resolvedMachineId,
      cli: transcript.cli,
      sourcePath: transcript.path,
      sourceRoot: transcript.root,
      sourceRelativePath: transcript.relative_path,
      filename: transcript.filename,
      sessionId: sessionIdFromTranscript(transcript),
      matchConfidence: transcript.match_confidence || 'unknown',
      matchedBy: transcript.matched_by || '',
      rawCachePath: rawCacheRelativePath(transcript, resolvedMachineId),
    };
    if (computeMetadata) {
      let buffer;
      try {
        buffer = await fsp.readFile(transcript.path);
      } catch (err) {
        entries.push(transcriptReadErrorEntry(entry, err));
        continue;
      }
      updateEntryFromBuffer(entry, buffer);
    }
    entries.push(entry);
  }

  return {
    projectRoot,
    brainId,
    machineId: resolvedMachineId,
    generatedAt: generatedAt || new Date().toISOString(),
    entries,
  };
}

export function disambiguateRawEntries(entries) {
  const bySession = new Map();
  for (const entry of entries) {
    if (entry.error) continue;
    const key = `${entry.cli}:${entry.sessionId}`;
    const group = bySession.get(key) || [];
    group.push(entry);
    bySession.set(key, group);
  }

  const conflicts = [];
  const sessionIds = new Map();
  for (const [key, group] of bySession.entries()) {
    const hashes = new Set(group.map((entry) => entry.contentHash));
    if (group.length <= 1) continue;
    // Even identical cross-machine sessions need stable unique IDs for downstream recall/index keys.
    for (const entry of group) {
      sessionIds.set(entry.rawCachePath, `${entry.sessionId}--${sanitizeSegment(entry.machineId)}--${entry.contentHash.slice(0, 12)}`);
    }
    if (hashes.size <= 1) continue;
    conflicts.push({
      type: 'session_hash_mismatch',
      key,
      sessionId: group[0].sessionId,
      cli: group[0].cli,
      entries: group.map((entry) => ({
        machineId: entry.machineId,
        sourceRelativePath: entry.sourceRelativePath,
        contentHash: entry.contentHash,
        disambiguatedSessionId: sessionIds.get(entry.rawCachePath),
      })).sort((a, b) => `${a.machineId}:${a.contentHash}`.localeCompare(`${b.machineId}:${b.contentHash}`)),
    });
  }
  return { conflicts, sessionIds };
}

function existingRawManifestEntries(manifest) {
  return (manifest?.raw || []).map((entry) => ({
    cli: entry.cli,
    sessionId: entry.originalSessionId || entry.sessionId,
    machineId: entry.machineId,
    sourcePath: entry.sourcePath,
    sourceRelativePath: entry.sourceRelativePath,
    size: entry.size,
    firstTimestamp: entry.firstTimestamp,
    lastTimestamp: entry.lastTimestamp,
    matchConfidence: entry.matchConfidence,
    matchedBy: entry.matchedBy,
    contentHash: entry.contentHash,
    archiveVersionId: entry.archiveVersionId,
    archiveManifestHash: entry.archiveManifestHash,
    sourceAuthority: entry.sourceAuthority,
    rawCachePath: entry.cachePath,
  }));
}

function existingNormalizedPathByRawCache(manifest) {
  const out = new Map();
  for (const entry of manifest?.normalized || []) {
    if (!entry?.sourceRawCachePath || !entry?.cachePath) continue;
    out.set(entry.sourceRawCachePath, entry.cachePath);
  }
  return out;
}

function sessionIdsForEntries(entries, existingRaw = []) {
  const currentRawPaths = new Set(entries.filter((entry) => !entry.error).map((entry) => entry.rawCachePath));
  const combined = [
    ...existingRaw
      .filter((entry) => !currentRawPaths.has(entry.rawCachePath))
      .map((entry) => ({ ...entry, error: false })),
    ...entries.filter((entry) => !entry.error),
  ];
  return disambiguateRawEntries(combined).sessionIds;
}

function withoutManifestEntriesForRawPaths(manifest, rawPaths) {
  if (!manifest || rawPaths.size === 0) return manifest;
  return {
    ...manifest,
    raw: (manifest.raw || []).filter((entry) => !rawPaths.has(entry.cachePath)),
    normalized: (manifest.normalized || []).filter((entry) => !rawPaths.has(entry.sourceRawCachePath)),
  };
}

async function normalizeEntryToCache(root, entry, buffer) {
  const normalized = normalizeTranscriptBuffer({
    provider: entry.cli,
    sessionId: entry.effectiveSessionId,
    rawEntry: entry,
    buffer,
  });
  entry.normalizationErrors = normalized.errors;
  entry.normalizedEventCount = normalized.events.length;
  entry.staleNormalizedCachePath = '';
  const normalizedPath = normalizedCacheRelativePath(entry.rawCachePath);
  const normalizedDest = safeJoinUnder(root, normalizedPath);
  const previousNormalizedPath = entry.previousNormalizedCachePath || '';
  if (previousNormalizedPath && previousNormalizedPath !== normalizedPath) {
    entry.staleNormalizedCachePath = previousNormalizedPath;
  }
  if (normalized.events.length > 0) {
    entry.normalizedCachePath = normalizedPath;
    const normalizedData = Buffer.from(stringifyNormalizedEvents(normalized.events), 'utf-8');
    entry.normalizedContentHash = sha256Buffer(normalizedData);
    await fsp.mkdir(path.dirname(normalizedDest), { recursive: true });
    let existingNormalizedHash = '';
    try {
      existingNormalizedHash = sha256Buffer(await fsp.readFile(normalizedDest));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (existingNormalizedHash !== entry.normalizedContentHash) {
      await fsp.writeFile(normalizedDest, normalizedData);
    }
  } else {
    entry.normalizedCachePath = '';
    entry.normalizedContentHash = '';
    await fsp.rm(normalizedDest, { force: true });
  }
}

export function buildManifestFromEntries({ brainId, machineId, generatedAt, entries }) {
  const successful = entries.filter((entry) => !entry.error);
  const { conflicts, sessionIds } = disambiguateRawEntries(successful);
  const manifest = createEmptyManifest({ brainId, machineId, generatedAt });
  manifest.raw = successful.map((entry) => ({
    cli: entry.cli,
    sessionId: entry.effectiveSessionId || sessionIds.get(entry.rawCachePath) || entry.sessionId,
    originalSessionId: entry.sessionId,
    machineId: entry.machineId,
    sourcePath: entry.sourcePath,
    sourceRelativePath: entry.sourceRelativePath,
    cachePath: entry.rawCachePath,
    contentHash: entry.contentHash,
    size: entry.size,
    firstTimestamp: entry.firstTimestamp,
    lastTimestamp: entry.lastTimestamp,
    matchConfidence: entry.matchConfidence,
    matchedBy: entry.matchedBy,
    ...(entry.archiveVersionId ? { archiveVersionId: entry.archiveVersionId } : {}),
    ...(entry.archiveManifestHash ? { archiveManifestHash: entry.archiveManifestHash } : {}),
    ...(entry.sourceAuthority ? { sourceAuthority: entry.sourceAuthority } : {}),
  })).sort((a, b) => a.cachePath.localeCompare(b.cachePath));
  manifest.normalized = successful
    .filter((entry) => entry.normalizedCachePath)
    .map((entry) => ({
      provider: entry.cli,
      sessionId: entry.effectiveSessionId || sessionIds.get(entry.rawCachePath) || entry.sessionId,
      machineId: entry.machineId,
      sourceRawCachePath: entry.rawCachePath,
      cachePath: entry.normalizedCachePath,
      eventCount: entry.normalizedEventCount,
      contentHash: entry.normalizedContentHash,
      normalizationVersion: NORMALIZATION_VERSION,
    }))
    .sort((a, b) => a.cachePath.localeCompare(b.cachePath));
  manifest.conflicts = conflicts;
  const readErrors = entries
    .filter((entry) => entry.error)
    .map((entry) => ({
      type: 'read_failed',
      sourcePath: entry.sourcePath || '',
      error: entry.error,
    }));
  const normalizationErrors = successful.flatMap((entry) => (entry.normalizationErrors || []).map((error) => ({
    type: 'normalization_failed',
    sourcePath: entry.sourcePath || '',
    cachePath: entry.rawCachePath,
    error: error.error || error.type || 'normalization_failed',
  })));
  manifest.errors = [...readErrors, ...normalizationErrors]
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return manifest;
}

async function writeRawCacheUnlocked({ cwd, brainId = '', machineId = '', reset = false, generatedAt } = {}) {
  const projectRoot = path.resolve(cwd || process.cwd());
  const existingManifest = reset ? null : await readManifest(projectRoot);
  const effectiveGeneratedAt = generatedAt || existingManifest?.generatedAt;
  const collected = await collectTranscriptSources({
    cwd: projectRoot,
    brainId,
    machineId,
    generatedAt: effectiveGeneratedAt,
    // Avoid a discovery-time read; the write loop reads once and hashes the exact bytes cached.
    computeMetadata: false,
  });
  const root = getTranscriptCacheRoot(collected.projectRoot);
  const backupRoot = reset ? `${root}.backup-${process.pid}-${Date.now()}` : '';
  const warnings = [];
  let backedUp = false;
  const priorNormalizedPaths = existingNormalizedPathByRawCache(existingManifest);

  try {
    if (reset) {
      try {
        await fsp.rename(root, backupRoot);
        backedUp = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    await fsp.mkdir(path.join(root, 'raw'), { recursive: true });
    // T2 writes normalized events and derived cache artifacts into these scaffolded directories.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    await fsp.mkdir(path.join(root, 'normalized', NORMALIZATION_VERSION), { recursive: true });
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    await fsp.mkdir(path.join(root, 'cache'), { recursive: true });

    for (const entry of collected.entries) {
      if (entry.error) continue;
      entry.previousNormalizedCachePath = priorNormalizedPaths.get(entry.rawCachePath) || '';
      const dest = safeJoinUnder(root, entry.rawCachePath);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      let buffer;
      try {
        buffer = await fsp.readFile(entry.sourcePath);
      } catch (err) {
        Object.assign(entry, transcriptReadErrorEntry(entry, err));
        continue;
      }
      updateEntryFromBuffer(entry, buffer);
      let existingHash = '';
      try {
        // Compare against the already-cached copy, not the native source file.
        existingHash = sha256Buffer(await fsp.readFile(dest));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (existingHash !== entry.contentHash) {
        await fsp.writeFile(dest, buffer);
      }
    }

    const authoritativeRawPaths = new Set();
    const hydratedExistingEntries = [];

    for (const rawEntry of existingRawManifestEntries(existingManifest)) {
      if (collected.entries.some((entry) => entry.rawCachePath === rawEntry.rawCachePath && !entry.error)) continue;
      const cachedRawPath = safeJoinUnder(root, rawEntry.rawCachePath);
      let buffer;
      try {
        buffer = await fsp.readFile(cachedRawPath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          authoritativeRawPaths.add(rawEntry.rawCachePath);
          continue;
        }
        throw err;
      }
      const entry = {
        ...rawEntry,
        sourcePath: rawEntry.sourcePath,
        sourceRelativePath: rawEntry.sourceRelativePath,
        filename: path.basename(rawEntry.rawCachePath),
        previousNormalizedCachePath: priorNormalizedPaths.get(rawEntry.rawCachePath) || '',
      };
      updateEntryFromBuffer(entry, buffer);
      hydratedExistingEntries.push(entry);
    }

    const sessionIds = sessionIdsForEntries(collected.entries, hydratedExistingEntries);

    for (const entry of collected.entries) {
      if (entry.error) continue;
      entry.effectiveSessionId = sessionIds.get(entry.rawCachePath) || entry.sessionId;
      authoritativeRawPaths.add(entry.rawCachePath);
      await normalizeEntryToCache(root, entry, await fsp.readFile(safeJoinUnder(root, entry.rawCachePath)));
    }

    for (const entry of hydratedExistingEntries) {
      if (authoritativeRawPaths.has(entry.rawCachePath)) continue;
      entry.effectiveSessionId = sessionIds.get(entry.rawCachePath) || entry.sessionId;
      authoritativeRawPaths.add(entry.rawCachePath);
      await normalizeEntryToCache(root, entry, await fsp.readFile(safeJoinUnder(root, entry.rawCachePath)));
      collected.entries.push(entry);
    }

    const nextManifest = buildManifestFromEntries(collected);
    const manifest = mergeManifest(withoutManifestEntriesForRawPaths(existingManifest, authoritativeRawPaths), nextManifest);
    await writeManifestAtomicUnlocked(collected.projectRoot, manifest);
    for (const stalePath of new Set(collected.entries.map((entry) => entry.staleNormalizedCachePath).filter(Boolean))) {
      await fsp.rm(safeJoinUnder(root, stalePath), { force: true });
    }
    const result = {
      projectRoot: collected.projectRoot,
      cacheRoot: root,
      manifest,
      warnings,
    };
    if (backedUp) {
      try {
        await fsp.rm(backupRoot, { recursive: true, force: true });
      } catch (cleanupErr) {
        // The new cache is already written; operators may remove stale .backup-* dirs if cleanup fails.
        warnings.push(`backup cleanup failed (${backupRoot}): ${cleanupErr.message}`);
      }
    }
    return result;
  } catch (err) {
    if (backedUp) {
      try {
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rename(backupRoot, root);
      } catch (rollbackErr) {
        err.rollbackError = `rollback failed (backup at ${backupRoot}): ${rollbackErr.message}`;
      }
    }
    throw err;
  }
}

export async function writeRawCache(options = {}) {
  const projectRoot = path.resolve(options.cwd || process.cwd());
  return withTranscriptManifestLock(transcriptCacheManifestLockFile(projectRoot),
    () => writeRawCacheUnlocked({ ...options, cwd: projectRoot }), { trustedRoot: projectRoot });
}

export function mergeManifest(existing, incoming) {
  if (!existing) return incoming;
  if (existing.schemaVersion !== incoming.schemaVersion) {
    throw new Error(`Cannot merge transcript manifests with schema versions ${existing.schemaVersion} and ${incoming.schemaVersion}`);
  }
  if (existing.normalizationVersion !== incoming.normalizationVersion) {
    throw new Error(`Cannot merge transcript manifests with normalization versions ${existing.normalizationVersion} and ${incoming.normalizationVersion}`);
  }
  const merged = createEmptyManifest({
    brainId: incoming.brainId || existing.brainId,
    machineId: incoming.machineId || existing.machineId,
    generatedAt: incoming.generatedAt || existing.generatedAt,
  });
  const mergeBy = (field, keyFn) => {
    const map = new Map();
    for (const item of [...(existing[field] || []), ...(incoming[field] || [])]) {
      // Incoming entries supersede existing entries for the same cache key.
      map.set(keyFn(item), item);
    }
    return [...map.values()].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
  };
  merged.raw = mergeBy('raw', (item) => item.cachePath || `${item.cli}:${item.sessionId}:${item.contentHash}`);
  merged.normalized = mergeBy('normalized', (item) => item.cachePath || `${item.provider}:${item.sessionId}:${item.contentHash}`);
  // Conflicts and errors are derived from the authoritative entry set built for this run.
  const rawForConflicts = merged.raw.map((item) => ({
    ...item, rawCachePath: item.cachePath, sessionId: item.originalSessionId || item.sessionId,
    machineId: item.machineId || 'unknown', sourceRelativePath: item.sourceRelativePath || '',
  }));
  const derived = disambiguateRawEntries(rawForConflicts);
  merged.raw = merged.raw.map((item) => ({ ...item,
    sessionId: derived.sessionIds.get(item.cachePath) || item.originalSessionId || item.sessionId,
  })).sort((a, b) => a.cachePath.localeCompare(b.cachePath));
  merged.normalized = merged.normalized.map((item) => ({ ...item,
    sessionId: derived.sessionIds.get(item.sourceRawCachePath) || item.sessionId,
  })).sort((a, b) => a.cachePath.localeCompare(b.cachePath));
  merged.conflicts = derived.conflicts;
  merged.errors = [...(incoming.errors || [])].sort((a, b) => `${a.type}:${a.sourcePath}`.localeCompare(`${b.type}:${b.sourcePath}`));
  return merged;
}
