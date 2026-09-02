// Durable, project-local replay state for memory snapshots. Queue metadata never
// contains snapshot bytes or credentials; payloads are immutable hash-keyed dirs.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { assertContainedRelativePath } from '../bundle/manifest-schema.js';
import {
  collectMemoryFiles,
  collectTrustedInternalMemoryFiles,
  computeBundleHash,
  createMemorySnapshotManifest,
} from '../bundle/installer.js';

export const REPLAY_QUEUE_VERSION = 1;
export const REPLAY_DEGRADED_ATTEMPTS = 3;
let tmpCounter = 0;

const OUTCOME_TYPES = new Set([
  'blocked_conflict',
  'deferred_unreachable',
  'degraded',
  'failed_invalid_payload',
  'retrying',
]);
const REPLAY_PERMISSION_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
const REPLAY_TRANSIENT_ERROR_CODES = new Set([
  ...REPLAY_PERMISSION_ERROR_CODES,
  'EIO',
  'ESTALE',
  'ETIMEDOUT',
]);

function shaKey(bundleHash) {
  const value = String(bundleHash || '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`replay queue: invalid bundle hash ${bundleHash}`);
  return value;
}

function realProjectRoot(projectRoot) {
  return fs.realpathSync(path.resolve(projectRoot));
}

function assertSafeDir(dir, projectRoot, label) {
  const relative = path.relative(projectRoot, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`replay queue: ${label} escapes project root`);
  let current = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`replay queue: ${label} uses a symlink (${current})`);
      if (!stat.isDirectory()) throw new Error(`replay queue: ${label} has non-directory component (${current})`);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      fs.mkdirSync(current);
    }
  }
}

function assertSafeExistingDir(dir, projectRoot, label) {
  const relative = path.relative(projectRoot, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`replay queue: ${label} escapes project root`);
  let current = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`replay queue: ${label} uses a symlink (${current})`);
      if (!stat.isDirectory()) throw new Error(`replay queue: ${label} has non-directory component (${current})`);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function assertSafeFile(filePath, projectRoot, label) {
  const relative = path.relative(projectRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`replay queue: ${label} escapes project root`);
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`replay queue: ${label} is a symlink (${filePath})`);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function assertNoSymlinkedPath(root, relative, label) {
  const safeRelative = assertContainedRelativePath(relative, label);
  let current = root;
  for (const segment of safeRelative.split('/')) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`replay queue: ${label} uses a symlink (${current})`);
  }
}

function atomicWrite(filePath, value) {
  const temp = `${filePath}.${process.pid}-${tmpCounter++}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* platform permission model */ }
}

export function replayPaths(projectRoot, override = process.env.AGENTBOOTUP_MEMORY_REPLAY_QUEUE_PATH) {
  const root = realProjectRoot(projectRoot);
  const queuePath = override ? path.resolve(override) : path.join(root, '.brain', 'memory-replay-queue.json');
  const queueDir = path.dirname(queuePath);
  const payloadRoot = path.join(root, '.brain', 'memory-replay');
  if (path.dirname(queuePath) !== path.join(root, '.brain') && !override) throw new Error('replay queue: invalid queue path');
  assertSafeDir(queueDir, root, 'queue directory');
  assertSafeFile(queuePath, root, 'queue file');
  return { projectRoot: root, queuePath, payloadRoot };
}

// Forensic commands must not create `.brain/` merely to determine that there is
// no queue. Keep this separate from replayPaths(): writers deliberately create
// the directory after the same containment and symlink checks.
export function replayPathsReadOnly(projectRoot, override = process.env.AGENTBOOTUP_MEMORY_REPLAY_QUEUE_PATH) {
  const root = realProjectRoot(projectRoot);
  const queuePath = override ? path.resolve(override) : path.join(root, '.brain', 'memory-replay-queue.json');
  const queueDir = path.dirname(queuePath);
  const payloadRoot = path.join(root, '.brain', 'memory-replay');
  const relative = path.relative(root, queuePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('replay queue: queue file escapes project root');
  if (path.dirname(queuePath) !== path.join(root, '.brain') && !override) throw new Error('replay queue: invalid queue path');
  assertSafeExistingDir(queueDir, root, 'queue directory');
  assertSafeFile(queuePath, root, 'queue file');
  return { projectRoot: root, queuePath, payloadRoot };
}

// A normal publish should not create queue state merely to discover there is nothing
// to replay. This probe is intentionally non-mutating; writes still go through replayPaths.
export function hasReplayQueue(projectRoot, override = process.env.AGENTBOOTUP_MEMORY_REPLAY_QUEUE_PATH) {
  const root = realProjectRoot(projectRoot);
  const queuePath = override ? path.resolve(override) : path.join(root, '.brain', 'memory-replay-queue.json');
  const relative = path.relative(root, queuePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('replay queue: queue file escapes project root');
  const queueDir = path.dirname(queuePath);
  try {
    const dir = fs.lstatSync(queueDir);
    if (dir.isSymbolicLink()) throw new Error(`replay queue: queue directory uses a symlink (${queueDir})`);
    if (!dir.isDirectory()) return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const file = fs.lstatSync(queuePath);
    if (file.isSymbolicLink()) throw new Error(`replay queue: queue file is a symlink (${queuePath})`);
    if (!file.isFile()) throw new Error(`replay queue: queue file is not a regular file (${queuePath})`);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function normalizeStoreIdentity(store) {
  if (!store) throw new Error('replay queue: no memory store configured');
  if (store.scheme === 'file') {
    if (!store.root) throw new Error('replay queue: invalid file store');
    return `file://${path.resolve(store.root)}`;
  }
  if (store.scheme === 'agentdrive') {
    return typeof store.ref === 'string' && store.ref ? `agentdrive://${store.ref}` : 'agentdrive://';
  }
  if (store.scheme === 'server') {
    return typeof store.brainId === 'string' && store.brainId ? `server://${store.brainId}` : 'server://';
  }
  throw new Error(`replay queue: unsupported store scheme ${store.scheme}`);
}

function isValidStoreIdentity(identity) {
  if (typeof identity !== 'string') return false;
  if (identity.startsWith('file://')) return identity.length > 'file://'.length;
  if (identity.startsWith('agentdrive://')) return true;
  if (identity.startsWith('server://')) return true;
  return false;
}

function validateItem(item) {
  if (!item || typeof item !== 'object') throw new Error('replay queue: malformed queue item');
  if (!/^[a-f0-9-]{16,}$/i.test(String(item.id || ''))) throw new Error('replay queue: invalid queue item id');
  if (!isValidStoreIdentity(item.store_identity)) throw new Error('replay queue: invalid store identity');
  if (typeof item.snapshot_id !== 'string' || item.snapshot_id.length === 0) throw new Error('replay queue: invalid snapshot id');
  if (item.deleted_pages !== undefined) {
    if (!Array.isArray(item.deleted_pages)) throw new Error('replay queue: invalid deleted page metadata');
    for (const rel of item.deleted_pages) {
      const safeRel = assertContainedRelativePath(rel, 'replay deleted page');
      if (!safeRel.startsWith('memory/')) throw new Error('replay queue: invalid deleted page metadata');
    }
  }
  if (item.deleted_page_times !== undefined) {
    if (!item.deleted_page_times || typeof item.deleted_page_times !== 'object' || Array.isArray(item.deleted_page_times)) throw new Error('replay queue: invalid deleted page timestamps');
    for (const [rel, timestamp] of Object.entries(item.deleted_page_times)) {
      const safeRel = assertContainedRelativePath(rel, 'replay deleted page timestamp');
      if (!safeRel.startsWith('memory/') || !Number.isFinite(Number(timestamp))) throw new Error('replay queue: invalid deleted page timestamps');
    }
  }
  if (item.file_mtimes !== undefined) {
    if (!item.file_mtimes || typeof item.file_mtimes !== 'object' || Array.isArray(item.file_mtimes)) throw new Error('replay queue: invalid file mtime metadata');
    for (const [rel, mtime] of Object.entries(item.file_mtimes)) {
      const safeRel = assertContainedRelativePath(rel, 'replay file mtime');
      if (!safeRel.startsWith('memory/') || !Number.isFinite(Number(mtime))) throw new Error('replay queue: invalid file mtime metadata');
    }
  }
  shaKey(item.bundle_hash);
  if (!Number.isInteger(item.attempt_count) || item.attempt_count < 0) throw new Error('replay queue: invalid attempt count');
  if (!item.created_at || Number.isNaN(Date.parse(item.created_at))) throw new Error('replay queue: invalid creation timestamp');
  if (item.last_outcome !== null) {
    if (!item.last_outcome || typeof item.last_outcome !== 'object' || Array.isArray(item.last_outcome)) {
      throw new Error('replay queue: invalid last outcome');
    }
    if (!OUTCOME_TYPES.has(item.last_outcome.type) || !item.last_outcome.at || Number.isNaN(Date.parse(item.last_outcome.at))) {
      throw new Error('replay queue: invalid last outcome');
    }
  }
  return item;
}

export function readReplayQueue(projectRoot, options) {
  const paths = replayPaths(projectRoot, options?.queuePath);
  if (!fs.existsSync(paths.queuePath)) return { version: REPLAY_QUEUE_VERSION, items: [], paths };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(paths.queuePath, 'utf8')); } catch { throw new Error('replay queue: malformed JSON'); }
  if (parsed?.version !== REPLAY_QUEUE_VERSION || !Array.isArray(parsed.items)) throw new Error('replay queue: unsupported schema version');
  const items = parsed.items.map(validateItem).sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { version: REPLAY_QUEUE_VERSION, items, paths };
}

export function readReplayQueueReadOnly(projectRoot, options) {
  const paths = replayPathsReadOnly(projectRoot, options?.queuePath);
  if (!fs.existsSync(paths.queuePath)) return { version: REPLAY_QUEUE_VERSION, items: [], paths };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(paths.queuePath, 'utf8')); } catch { throw new Error('replay queue: malformed JSON'); }
  if (parsed?.version !== REPLAY_QUEUE_VERSION || !Array.isArray(parsed.items)) throw new Error('replay queue: unsupported schema version');
  const items = parsed.items.map(validateItem).sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { version: REPLAY_QUEUE_VERSION, items, paths };
}

export function writeReplayQueue(projectRoot, items, options) {
  const { paths } = readReplayQueue(projectRoot, options);
  const ordered = items.map(validateItem).sort((a, b) => a.created_at.localeCompare(b.created_at));
  atomicWrite(paths.queuePath, { version: REPLAY_QUEUE_VERSION, items: ordered });
  return { version: REPLAY_QUEUE_VERSION, items: ordered, paths };
}

export function createReplayPayload({ projectRoot, snapshotId, options }) {
  const { paths } = readReplayQueue(projectRoot, options);
  assertSafeDir(paths.payloadRoot, paths.projectRoot, 'payload directory');
  const files = collectMemoryFiles(paths.projectRoot);
  if (files.length === 0) throw new Error('replay queue: cannot queue an empty memory snapshot');
  const fileMtimes = Object.fromEntries(files.map((rel) => [rel, fs.statSync(path.join(paths.projectRoot, rel)).mtimeMs]));
  const manifest = createMemorySnapshotManifest({ targetRoot: paths.projectRoot, snapshotId, files, sourceRepo: 'local-memory' });
  const key = shaKey(manifest.bundle_hash);
  const payloadDir = path.join(paths.payloadRoot, key);
  if (fs.existsSync(payloadDir)) {
    const existing = fs.lstatSync(payloadDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`replay queue: payload directory is unsafe (${payloadDir})`);
    return { manifest, payloadDir, paths, fileMtimes };
  }
  const staging = `${payloadDir}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.mkdirSync(path.join(staging, 'payload'), { recursive: true, mode: 0o700 });
  try {
    for (const rel of files) {
      const safeRel = assertContainedRelativePath(rel, 'memory file');
      const source = path.join(paths.projectRoot, safeRel);
      const target = path.join(staging, 'payload', safeRel);
      assertSafeFile(source, paths.projectRoot, `source ${safeRel}`);
      assertNoSymlinkedPath(paths.projectRoot, safeRel, `source ${safeRel}`);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const sourceStat = fs.statSync(source);
      fs.copyFileSync(source, target);
      // Tombstone/recreation decisions use page mtime. Preserve the source value so
      // freezing an old page cannot make it appear newly recreated during replay.
      const copiedSourceStat = fs.statSync(source);
      if (copiedSourceStat.size !== sourceStat.size || copiedSourceStat.mtimeMs !== sourceStat.mtimeMs) {
        throw new Error(`replay queue: source changed while freezing ${safeRel}; retry enqueue`);
      }
      fs.utimesSync(target, sourceStat.atime, sourceStat.mtime);
      fileMtimes[safeRel] = sourceStat.mtimeMs;
    }
    if (computeBundleHash(manifest, path.join(staging, 'payload')) !== manifest.bundle_hash) throw new Error('replay queue: payload integrity verification failed');
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    fs.renameSync(staging, payloadDir);
    return { manifest, payloadDir, paths, fileMtimes };
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

export function enqueueReplayItem({ projectRoot, store, snapshotId, deletedPages = [], deletedPageTimes = {}, options }) {
  const queue = readReplayQueue(projectRoot, options);
  const payload = createReplayPayload({ projectRoot, snapshotId, options });
  const storeIdentity = normalizeStoreIdentity(store);
  const existing = queue.items.find((item) => item.store_identity === storeIdentity && item.bundle_hash === payload.manifest.bundle_hash);
  if (existing) {
    const fileMtimes = { ...existing.file_mtimes };
    for (const [rel, mtime] of Object.entries(payload.fileMtimes)) fileMtimes[rel] = Math.max(Number(fileMtimes[rel] || 0), mtime);
    const mergedDeletedPages = [...new Set([...(existing.deleted_pages || []), ...deletedPages])];
    const mergedDeletedPageTimes = { ...(existing.deleted_page_times || {}) };
    for (const [rel, timestamp] of Object.entries(deletedPageTimes)) {
      const previous = mergedDeletedPageTimes[rel];
      mergedDeletedPageTimes[rel] = previous === undefined ? timestamp : Math.min(Number(previous), Number(timestamp));
    }
    const updated = updateReplayItem({ projectRoot, id: existing.id, update: { file_mtimes: fileMtimes, deleted_pages: mergedDeletedPages, deleted_page_times: mergedDeletedPageTimes }, options });
    return { item: updated.item, deduplicated: true, payload, queue: updated.queue };
  }
  const item = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    store_identity: storeIdentity,
    snapshot_id: String(snapshotId),
    deleted_pages: [...new Set(deletedPages)],
    deleted_page_times: deletedPageTimes,
    bundle_hash: payload.manifest.bundle_hash,
    file_mtimes: payload.fileMtimes,
    attempt_count: 0,
    last_outcome: null,
  };
  const next = writeReplayQueue(projectRoot, [...queue.items, item], options);
  return { item, deduplicated: false, payload, queue: next };
}

export function readReplayPayload({ projectRoot, item, options, readOnly = false }) {
  validateItem(item);
  if (!item.file_mtimes) throw new Error('replay queue: legacy item lacks source mtime metadata; inspect and discard or re-enqueue it');
  const { paths } = readOnly ? readReplayQueueReadOnly(projectRoot, options) : readReplayQueue(projectRoot, options);
  if (readOnly) assertSafeExistingDir(paths.payloadRoot, paths.projectRoot, 'payload directory');
  const payloadDir = path.join(paths.payloadRoot, shaKey(item.bundle_hash));
  const stat = fs.lstatSync(payloadDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`replay queue: payload directory is unsafe (${payloadDir})`);
  const manifestPath = path.join(payloadDir, 'manifest.json');
  assertSafeFile(manifestPath, paths.projectRoot, 'payload manifest');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (REPLAY_TRANSIENT_ERROR_CODES.has(String(error?.code || ''))) throw error;
    throw new Error('replay queue: payload manifest is malformed');
  }
  if (manifest?.bundle_hash !== item.bundle_hash || !Array.isArray(manifest.files)) throw new Error('replay queue: payload manifest does not match queue item');
  const payloadRoot = path.join(payloadDir, 'payload');
  const payloadStat = fs.lstatSync(payloadRoot);
  if (payloadStat.isSymbolicLink() || !payloadStat.isDirectory()) throw new Error('replay queue: payload root is unsafe');
  for (const file of manifest.files) {
    const source = assertContainedRelativePath(file?.source, 'payload source');
    const target = assertContainedRelativePath(file?.target, 'payload target');
    if (source !== target || !source.startsWith('memory/')) throw new Error('replay queue: payload manifest has unsafe memory paths');
    assertNoSymlinkedPath(payloadRoot, source, `payload ${source}`);
  }
  const files = manifest.files.map((file) => file.target);
  const manifestTargets = new Set(files);
  const inventory = collectTrustedInternalMemoryFiles(payloadRoot);
  const inventorySet = new Set(inventory);
  const extra = inventory.filter((rel) => !manifestTargets.has(rel));
  const missing = files.filter((rel) => !inventorySet.has(rel));
  if (
    manifestTargets.size !== files.length ||
    inventory.length !== files.length ||
    extra.length > 0 ||
    missing.length > 0
  ) {
    throw new Error(
      'replay queue: payload file set does not exactly match manifest' +
      (extra.length > 0 ? ` (extra: ${extra.join(', ')})` : '') +
      (missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''),
    );
  }
  if (computeBundleHash(manifest, payloadRoot) !== item.bundle_hash) throw new Error('replay queue: payload integrity verification failed');
  if (Object.keys(item.file_mtimes).length !== manifestTargets.size || Object.keys(item.file_mtimes).some((rel) => !manifestTargets.has(rel))) {
    throw new Error('replay queue: payload mtime metadata does not match manifest');
  }
  return {
    manifest,
    files: Object.freeze([...files]),
    payloadRoot,
    payloadDir,
    paths: Object.freeze({ ...paths }),
    fileMtimes: Object.freeze({ ...item.file_mtimes }),
  };
}

function makeOutcome(type, detail) {
  if (!OUTCOME_TYPES.has(type)) throw new Error(`replay queue: invalid outcome type ${type}`);
  return {
    type,
    at: new Date().toISOString(),
    ...(detail ? { detail: String(detail).slice(0, 240) } : {}),
  };
}

export function updateReplayItem({ projectRoot, id, update, options }) {
  const queue = readReplayQueue(projectRoot, options);
  const index = queue.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`replay queue: item not found (${id})`);
  const current = queue.items[index];
  const replacement = validateItem({ ...current, ...update });
  const items = [...queue.items];
  items[index] = replacement;
  const next = writeReplayQueue(projectRoot, items, options);
  return { item: replacement, queue: next };
}

// Reachable failures count toward degradation. An offline transport error is observable,
// but it is not evidence that the frozen item itself is unhealthy.
export function recordReplayFailure({ projectRoot, id, type, detail, options }) {
  const queue = readReplayQueue(projectRoot, options);
  const item = queue.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`replay queue: item not found (${id})`);
  if (type === 'deferred_unreachable' || type === 'blocked_conflict' || type === 'failed_invalid_payload') {
    return updateReplayItem({ projectRoot, id, update: { last_outcome: makeOutcome(type, detail) }, options });
  }
  if (type !== 'retrying') throw new Error(`replay queue: invalid retry outcome ${type}`);
  const attemptCount = item.attempt_count + 1;
  return updateReplayItem({
    projectRoot,
    id,
    update: {
      attempt_count: attemptCount,
      last_outcome: makeOutcome(attemptCount >= REPLAY_DEGRADED_ATTEMPTS ? 'degraded' : 'retrying', detail),
    },
    options,
  });
}

export function inspectReplayItem({ projectRoot, id, options }) {
  const queue = readReplayQueueReadOnly(projectRoot, options);
  const item = queue.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`replay queue: item not found (${id})`);
  try {
    const payload = readReplayPayload({ projectRoot, item, options, readOnly: true });
    return { item, payload: { valid: true, manifest: payload.manifest } };
  } catch (error) {
    const code = String(error?.code || '');
    const transient = REPLAY_TRANSIENT_ERROR_CODES.has(code);
    const detail = REPLAY_PERMISSION_ERROR_CODES.has(code)
      ? code
      : error instanceof Error ? error.message : String(error);
    return { item, payload: { valid: false, terminal: !transient, error: detail } };
  }
}

export function isReplayHead({ projectRoot, id, options }) {
  const queue = readReplayQueue(projectRoot, options);
  const item = queue.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`replay queue: item not found (${id})`);
  const head = queue.items.find((candidate) => candidate.store_identity === item.store_identity);
  return { item, isHead: head?.id === id };
}

export function removeReplayItem({ projectRoot, id, options }) {
  const queue = readReplayQueue(projectRoot, options);
  const item = queue.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`replay queue: item not found (${id})`);
  const next = writeReplayQueue(projectRoot, queue.items.filter((candidate) => candidate.id !== id), options);
  const stillReferenced = next.items.some((candidate) => candidate.bundle_hash === item.bundle_hash);
  if (!stillReferenced) {
    const payloadDir = path.join(next.paths.payloadRoot, shaKey(item.bundle_hash));
    try {
      assertSafeDir(next.paths.payloadRoot, next.paths.projectRoot, 'payload directory');
      const stat = fs.lstatSync(payloadDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`replay queue: payload directory is unsafe (${payloadDir})`);
      fs.rmSync(payloadDir, { recursive: true, force: true });
    } catch (error) {
      // Queue success is durable; a later retention/GC feature can examine this orphan.
      if (error?.code !== 'ENOENT') return { item, queue: next, payload_cleanup_error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { item, queue: next, payload_cleanup_error: null };
}
