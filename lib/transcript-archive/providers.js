import fsp from 'fs/promises';
import path from 'path';
import { discoverTranscriptFiles } from '../brain/transcript-discovery.js';
import { getTranscriptSourceRoot, isSupportedNativeTranscriptRelativePath } from '../brain/transcript-discovery.js';
import { readStableSnapshot, validateTranscriptContainment } from './snapshot.js';
import { ARCHIVE_SAFE_ID_PATTERN } from './contracts.js';
import { ARCHIVE_LIMITS, MIN_CLOSED_AGE_HOURS_RANGE, TRANSCRIPT_ARCHIVE_DEFAULTS, resolveArchiveLimit } from './config.js';

const yes = () => Object.freeze({ supported: true });
const no = (reason) => Object.freeze({ supported: false, reason });

function recordDiscoveryFailure(failures, failure) {
  if (failures.items.length < failures.max) failures.items.push(failure);
  else failures.omitted++;
}

async function* walkFiles(root, depth, maxDepth, failures) {
  if (depth > maxDepth) { recordDiscoveryFailure(failures, { path: root, errorCode: 'DISCOVERY_DEPTH_EXCEEDED' }); return; }
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (error) {
    recordDiscoveryFailure(failures, { path: root, errorCode: error.code, scope: depth === 0 ? 'root' : 'subtree' });
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      if (!entry.name.startsWith('.')) recordDiscoveryFailure(failures, { path: full,
        errorCode: 'DISCOVERY_SYMLINK_REFUSED', scope: depth === 0 ? 'root' : 'subtree' });
      continue;
    }
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) yield* walkFiles(full, depth + 1, maxDepth, failures);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full;
  }
}

async function discoverMechRun(options = {}) {
  if (!options.projectRoot) return { files: [], discoveryFailures: [], discoveryFailureOverflow: 0 };
  const projectRoot = path.resolve(options.projectRoot);
  const root = path.join(projectRoot, '.mech-run', 'transcripts');
  const maxDepth = resolveArchiveLimit('discoveryMaxDepth', options.limits?.discoveryMaxDepth);
  const maxFailures = resolveArchiveLimit('discoveryMaxFailures', options.limits?.discoveryMaxFailures);
  for (const directory of [projectRoot, path.join(projectRoot, '.mech-run'), root]) {
    let stat;
    try { stat = await fsp.lstat(directory); } catch (error) {
      if (error.code === 'ENOENT') return { files: [], discoveryFailures: [], discoveryFailureOverflow: 0 };
      throw error;
    }
    if (stat.isSymbolicLink()) throw Object.assign(new Error(`mech-run transcript discovery refuses symlinked directory: ${directory}`),
      { code: 'DISCOVERY_SYMLINK_REFUSED' });
    if (!stat.isDirectory()) throw Object.assign(new Error(`mech-run transcript discovery requires a directory: ${directory}`),
      { code: 'DISCOVERY_NOT_A_DIRECTORY' });
  }
  const found = [];
  const discoveryFailures = { items: [], omitted: 0, max: maxFailures };
  for await (const filePath of walkFiles(root, 0, maxDepth, discoveryFailures)) found.push({
    cli: 'mech-run', root, path: filePath, filename: path.basename(filePath),
    relative_path: path.relative(root, filePath).split(path.sep).join('/'),
    match_confidence: 'project_local', matched_by: projectRoot,
  });
  found.sort((a, b) => a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0);
  return { files: found, discoveryFailures: discoveryFailures.items, discoveryFailureOverflow: discoveryFailures.omitted };
}

function filenameSession({ filename, path: filePath }) {
  if (filename && path.basename(filename) !== filename) throw new Error(`transcript filename must not contain path segments: ${filename}`);
  const name = path.basename(filename || filePath || 'unknown-session');
  const sessionId = path.extname(name) ? name.slice(0, -path.extname(name).length) : name;
  if (!ARCHIVE_SAFE_ID_PATTERN.test(sessionId)) throw new Error(`transcript filename cannot provide a safe session id: ${name}`);
  return sessionId;
}

function parseJsonLines(raw) {
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed);
    } catch { /* identity falls back to filename */ }
  }
  return records;
}

function nestedId(records, provider) {
  for (const record of records) {
    const candidates = provider === 'codex'
      ? [record.sessionId, record.session_id, record.payload?.id, record.payload?.sessionId]
      : [record.sessionId, record.session_id, record.uuid];
    const found = candidates.find((value) => typeof value === 'string' && value.length <= 256 && value === value.trim() && ARCHIVE_SAFE_ID_PATTERN.test(value));
    if (found) return found;
  }
  return '';
}

async function identitySnapshot(source, options = {}) {
  const maxIdentityBytes = resolveArchiveLimit('identityByteLimit', options.maxIdentityBytes ?? options.limits?.identityByteLimit);
  const maxAttempts = resolveArchiveLimit('snapshotMaxAttempts', options.maxSnapshotAttempts ?? options.limits?.snapshotMaxAttempts);
  const trustedRoot = options.trustedRoot ?? source.root;
  const supplied = options.stableSnapshot;
  if (supplied && !Buffer.isBuffer(supplied.buffer) && !trustedRoot) throw new Error('stableSnapshot must retain its buffer or provide a trusted transcript root for identity parsing');
  if (!supplied && !trustedRoot) throw new Error('provider identity requires an explicit trusted transcript root');
  const snapshot = supplied && Buffer.isBuffer(supplied.buffer) ? supplied : await readStableSnapshot(source.path, {
    maxAttempts,
    noFollowSupported: options.noFollowSupported,
    maxBytes: maxIdentityBytes,
    limits: options.limits,
    trustedRoot,
  });
  if (!Buffer.isBuffer(snapshot.buffer)) throw new Error('stableSnapshot must retain its buffer for identity parsing');
  if (snapshot.buffer.length > maxIdentityBytes) {
    const error = new Error('identity snapshot exceeds bounded parser limit');
    error.code = 'SNAPSHOT_TOO_LARGE';
    throw error;
  }
  return snapshot;
}

async function identitySnapshotOrFilename(source, options) {
  try { return { snapshot: await identitySnapshot(source, options) }; } catch (error) {
    if (error.code === 'SNAPSHOT_TOO_LARGE') return { fallback: { sessionId: filenameSession(source), method: 'filename' } };
    throw error;
  }
}

async function jsonlIdentity(provider, source, options = {}) {
  const { snapshot, fallback } = await identitySnapshotOrFilename(source, options);
  if (fallback) return fallback;
  const raw = snapshot.buffer.toString('utf8');
  const embedded = nestedId(parseJsonLines(raw), provider);
  return { sessionId: embedded || filenameSession(source), method: embedded ? 'embedded_metadata' : 'filename' };
}

async function geminiIdentity(source, options = {}) {
  const { snapshot, fallback } = await identitySnapshotOrFilename(source, options);
  if (fallback) return fallback;
  let value;
  try {
    value = JSON.parse(snapshot.buffer.toString('utf8'));
  } catch {
    return { sessionId: filenameSession(source), method: 'filename' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { sessionId: filenameSession(source), method: 'filename' };
  const embedded = [value.sessionId, value.session_id, value.id]
    .find((candidate) => typeof candidate === 'string' && candidate.length <= 256 && candidate === candidate.trim() && ARCHIVE_SAFE_ID_PATTERN.test(candidate));
  return { sessionId: embedded || filenameSession(source), method: embedded ? 'embedded_metadata' : 'filename' };
}

const commonCapabilities = {
  discover: yes(), identity: yes(), closedStable: yes(),
  archive: yes(),
  restoreAnalysis: yes(),
  restoreNative: yes(),
};

function assertRestoreManifest(provider, manifest) {
  if (manifest?.logicalIdentity?.provider !== provider) throw new Error(`${provider} restore received a manifest for another provider`);
  const relativePath = manifest?.provenance?.sourceRelativePath;
  if (typeof relativePath !== 'string' || !relativePath) throw new Error(`${provider} restore requires source-relative provenance`);
  const normalized = relativePath.split('\\').join('/');
  return normalized;
}

function assertNativeRestoreManifest(provider, manifest) {
  const normalized = assertRestoreManifest(provider, manifest);
  const supported = isSupportedNativeTranscriptRelativePath(provider, normalized);
  if (!supported) throw Object.assign(new Error(`${provider} restore path is outside the supported native layout or extension`),
    { code: 'RESTORE_PROVIDER_LAYOUT_REFUSED' });
  return normalized;
}

function nativeRoot(provider, options) {
  if (provider === 'mech-run') {
    if (!options?.projectRoot) throw new Error('mech-run native restore requires a project root');
    return path.join(path.resolve(options.projectRoot), '.mech-run', 'transcripts');
  }
  const root = getTranscriptSourceRoot(provider);
  if (!root) throw new Error(`${provider} has no native transcript root`);
  return path.resolve(root);
}

function adapter(provider, parseIdentity, offloadQualified) {
  return Object.freeze({
    provider,
    discover: async (options = {}) => provider === 'mech-run'
      ? discoverMechRun(options)
      : (await discoverTranscriptFiles(options)).filter((entry) => entry.cli === provider && !path.basename(entry.path || entry.filename || '').startsWith('.')),
    parseIdentity,
    archive: async (source, options = {}) => {
      if (typeof options.archiveTransport !== 'function') throw new Error(`${provider} archive operation requires the archive-v2 transport`);
      return options.archiveTransport({ provider, source });
    },
    restoreAnalysis: async (manifest, options = {}) => {
      const relativePath = assertRestoreManifest(provider, manifest);
      if (typeof options.restoreTransport !== 'function') throw new Error(`${provider} analysis restore requires a restore transport`);
      return options.restoreTransport({ provider, relativePath, mode: 'analysis_cache' });
    },
    restoreNative: async (manifest, options = {}) => {
      const relativePath = assertNativeRestoreManifest(provider, manifest);
      if (typeof options.restoreTransport !== 'function') throw new Error(`${provider} native restore requires a restore transport`);
      return options.restoreTransport({ provider, relativePath, root: nativeRoot(provider, options), mode: 'native' });
    },
    offload: async () => { throw new Error(`${provider} offload operation is not implemented in Phase 1A`); },
    determineClosedStable: async (source, options = {}) => {
      const minClosedAgeHours = options.minClosedAgeHours ?? TRANSCRIPT_ARCHIVE_DEFAULTS.localRetention.minClosedAgeHours;
      const [minimumClosedAge, maximumClosedAge] = MIN_CLOSED_AGE_HOURS_RANGE;
      if (!Number.isSafeInteger(minClosedAgeHours) || minClosedAgeHours < minimumClosedAge || minClosedAgeHours > maximumClosedAge) {
        throw new TypeError(`minClosedAgeHours must be an integer from ${minimumClosedAge} to ${maximumClosedAge}`);
      }
      if (options.harnessStopped !== true) return { eligible: false, reason: options.harnessStopped === false ? 'harness_running' : 'harness_state_unknown' };
      const trustedRoot = options.trustedRoot ?? source.root;
      if (!trustedRoot) throw new Error('closed-stable evaluation requires an explicit trusted transcript root');
      await validateTranscriptContainment(source.path, trustedRoot, options.noFollowSupported);
      const initial = await fsp.lstat(source.path);
      if (initial.isSymbolicLink() || !initial.isFile()) throw new Error(`transcript source must be a regular non-symlink file: ${source.path}`);
      const initialAgeMs = (options.now ?? Date.now()) - initial.mtimeMs;
      if (initialAgeMs < -1_000) return { eligible: false, reason: 'source_timestamp_in_future' };
      if (Math.max(0, initialAgeMs) < minClosedAgeHours * 60 * 60 * 1000) return { eligible: false, reason: 'source_not_old_enough' };
      let snapshot;
      try {
        const maxBytes = resolveArchiveLimit('eligibilityByteLimit', options.limits?.eligibilityByteLimit);
        const identityByteLimit = resolveArchiveLimit('identityByteLimit', options.limits?.identityByteLimit);
        const maxAttempts = resolveArchiveLimit('snapshotMaxAttempts', options.maxSnapshotAttempts ?? options.limits?.snapshotMaxAttempts);
        const retainBuffer = initial.size <= identityByteLimit;
        snapshot = await readStableSnapshot(source.path, { maxAttempts, noFollowSupported: options.noFollowSupported,
          trustedRoot, beforeRead: options.beforeRead, afterRead: options.afterRead, retainBuffer,
          maxBytes: retainBuffer ? Math.min(maxBytes, identityByteLimit) : maxBytes });
      } catch (error) {
        if (error.code === 'SNAPSHOT_UNSTABLE') return { eligible: false, reason: 'source_not_stable' };
        if (error.code === 'SNAPSHOT_TOO_LARGE') return { eligible: false, reason: 'source_too_large' };
        throw error;
      }
      const stableMtimeMs = Number(BigInt(snapshot.after.mtimeNs) / 1_000_000n);
      const rawAgeMs = (options.now ?? Date.now()) - stableMtimeMs;
      if (rawAgeMs < -1_000) return { eligible: false, reason: 'source_timestamp_in_future', snapshot };
      const ageMs = Math.max(0, rawAgeMs);
      return ageMs >= minClosedAgeHours * 60 * 60 * 1000
        ? { eligible: true, reason: null, snapshot }
        : { eligible: false, reason: 'source_not_old_enough', snapshot };
    },
    capabilities: Object.freeze({
      ...commonCapabilities,
      offload: offloadQualified ? no('offload_operation_not_implemented') : no('provider_offload_not_qualified'),
    }),
  });
}

const PROVIDERS = new Map([
  ['claude', adapter('claude', (source, options) => jsonlIdentity('claude', source, options), true)],
  ['codex', adapter('codex', (source, options) => jsonlIdentity('codex', source, options), true)],
  ['cursor', adapter('cursor', async (source) => ({ sessionId: filenameSession(source), method: 'filename' }), false)],
  ['gemini', adapter('gemini', geminiIdentity, false)],
  ['mech-run', adapter('mech-run', (source, options) => jsonlIdentity('mech-run', source, options), false)],
]);

export function getProviderAdapter(provider) {
  const found = PROVIDERS.get(provider);
  if (!found) throw new Error(`unsupported provider: ${provider}`);
  return found;
}

export function listProviderCapabilities() {
  return Object.fromEntries([...PROVIDERS].map(([name, value]) => [name, value.capabilities]));
}
