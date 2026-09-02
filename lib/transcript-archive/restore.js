import fsp from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { getTranscriptCacheRoot, updateManifestAtomic, mergeManifest, buildManifestFromEntries } from '../brain/transcript-cache.js';
import { analysisManifestLockFile, withTranscriptManifestLock } from '../brain/transcript-manifest-lock.js';
import { ARCHIVE_SOURCE_RELATIVE_PATH_PATTERN, canonicalHash, validateArchiveManifest, validateDurabilityReceipt } from './contracts.js';
import { ArchiveClientError, TRANSCRIPT_EXIT_CODES } from './client.js';
import { getProviderAdapter } from './providers.js';

const MODE = Object.freeze({ ANALYSIS: 'analysis_cache', NATIVE: 'native' });
const SAFE_SEGMENT = /^[^/\\\0\r\n]+$/;

function integrityError(message) {
  return new ArchiveClientError(message, { code: 'VERIFICATION_FAILED', exitCode: TRANSCRIPT_EXIT_CODES.VERIFICATION });
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !ARCHIVE_SOURCE_RELATIVE_PATH_PATTERN.test(value)) throw integrityError('archive source path is unsafe');
  const segments = value.split('/');
  if (!segments.length || segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    throw integrityError('archive source path contains an unsafe segment');
  }
  return segments;
}

async function lstatOrNull(file) {
  try { return await fsp.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertNoSymlinkPath(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) {
      const platformAlias = process.platform === 'darwin' && (current === '/var' || current === '/tmp');
      if (!platformAlias) throw Object.assign(new Error(`restore path contains a symlink: ${current}`), { code: 'RESTORE_SYMLINK_REFUSED' });
    }
  }
}

async function assertNoCaseCollision(parent, basename, allowExact = true) {
  const entries = await fsp.readdir(parent).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const collision = entries.find((entry) => entry.toLocaleLowerCase('en-US') === basename.toLocaleLowerCase('en-US')
    && (!allowExact || entry !== basename));
  if (collision) throw Object.assign(new Error(`restore path has a case-only collision: ${collision} / ${basename}`), { code: 'RESTORE_CASE_COLLISION' });
}

async function ensureDirectorySafe(root, directory) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('restore destination escapes the selected root'), { code: 'RESTORE_PATH_ESCAPE' });
  await assertNoSymlinkPath(resolvedRoot);
  await fsp.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    await assertNoCaseCollision(current, segment);
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (existing?.isSymbolicLink()) throw Object.assign(new Error(`restore path contains a symlink: ${current}`), { code: 'RESTORE_SYMLINK_REFUSED' });
    if (existing && !existing.isDirectory()) throw Object.assign(new Error(`restore ancestor is not a directory: ${current}`), { code: 'RESTORE_PATH_CONFLICT' });
    if (!existing) await fsp.mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const created = await fsp.lstat(current);
    if (created.isSymbolicLink() || !created.isDirectory()) throw Object.assign(new Error(`restore ancestor changed during creation: ${current}`), { code: 'RESTORE_SYMLINK_REFUSED' });
  }
  return resolvedDirectory;
}

function conflictPath(destination, archiveVersionId) {
  const extension = path.extname(destination);
  const stem = extension ? destination.slice(0, -extension.length) : destination;
  const suffix = `.${archiveVersionId.slice(3)}`;
  const maxStemBytes = Math.max(1, 255 - Buffer.byteLength(suffix) - Buffer.byteLength(extension));
  const codePoints = [...path.basename(stem)];
  while (Buffer.byteLength(codePoints.join('')) > maxStemBytes) codePoints.pop();
  const bounded = codePoints.join('') || 'restored';
  return path.join(path.dirname(destination), `${bounded}${suffix}${extension}`);
}

async function readJsonRegular(file, label) {
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error(`${label} must be a regular non-symlink file`), { code: 'RESTORE_PATH_CONFLICT' });
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | noFollow | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw Object.assign(new Error(`${label} changed while opening`), { code: 'RESTORE_PATH_CONFLICT' });
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle?.close(); }
}

function restoreAuditPaths(projectRoot) {
  const brainRoot = path.join(path.resolve(projectRoot), '.brain');
  return {
    file: path.join(brainRoot, 'transcripts', '.restore-audit-outbox.json'),
    lock: path.join(brainRoot, '.restore-audit-outbox-lock.sqlite'),
  };
}

async function mutateRestoreAuditOutbox(projectRoot, update) {
  const paths = restoreAuditPaths(projectRoot);
  return withTranscriptManifestLock(paths.lock, async () => {
    await ensureDirectorySafe(projectRoot, path.dirname(paths.file));
    const current = await readJsonRegular(paths.file, 'restore audit outbox') ?? { schemaVersion: 1, records: {} };
    if (current.schemaVersion !== 1 || !current.records || typeof current.records !== 'object' || Array.isArray(current.records)) {
      throw Object.assign(new Error('restore audit outbox is invalid'), { code: 'RESTORE_AUDIT_OUTBOX_INVALID' });
    }
    const next = await update(structuredClone(current));
    const temporary = `${paths.file}.tmp-${randomUUID()}`;
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try {
      const existing = await lstatOrNull(paths.file);
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw Object.assign(new Error('restore audit outbox is unsafe'), { code: 'RESTORE_PATH_CONFLICT' });
      await fsp.rename(temporary, paths.file);
      const directory = await fsp.open(path.dirname(paths.file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { await fsp.unlink(temporary).catch(() => {}); throw error; }
    return next;
  }, { trustedRoot: path.resolve(projectRoot) });
}

async function prepareRestoreAudit(options, item) {
  let operationId;
  let reused = false;
  await mutateRestoreAuditOutbox(options.projectRoot, (outbox) => {
    const archiveVersionId = item.manifest.archiveVersionId;
    const existing = Object.values(outbox.records).find((record) => record?.brainId === options.brainId
      && record.archiveVersionId === archiveVersionId && record.state === 'pending');
    operationId = existing?.operationId ?? `restore_${randomUUID()}`;
    reused = Boolean(existing);
    outbox.records[operationId] = existing ?? {
      brainId: options.brainId, archiveVersionId, operationId, state: 'pending', outcome: null, reason: null,
    };
    return outbox;
  });
  return { operationId, reused };
}

async function setRestoreAuditTerminal(options, item, operationId, outcome, reason) {
  await mutateRestoreAuditOutbox(options.projectRoot, (outbox) => {
    const archiveVersionId = item.manifest.archiveVersionId;
    const existing = outbox.records[operationId];
    if (!existing || existing.operationId !== operationId) throw Object.assign(new Error('restore audit outbox operation changed'), { code: 'RESTORE_AUDIT_OUTBOX_INVALID' });
    outbox.records[operationId] = { ...existing, state: 'terminal', outcome, reason };
    return outbox;
  });
}

async function clearRestoreAudit(options, _archiveVersionId, operationId) {
  await mutateRestoreAuditOutbox(options.projectRoot, (outbox) => {
    if (outbox.records[operationId]?.operationId === operationId) delete outbox.records[operationId];
    return outbox;
  });
}

async function flushRestoreAuditOutbox(options) {
  const paths = restoreAuditPaths(options.projectRoot);
  await ensureDirectorySafe(options.projectRoot, path.dirname(paths.file));
  const outbox = await readJsonRegular(paths.file, 'restore audit outbox');
  if (!outbox?.records) return;
  for (const record of Object.values(outbox.records)) {
    if (record?.state !== 'terminal' || record.brainId !== options.brainId) continue;
    await options.client.reportRestoreOutcome(record.brainId, record.archiveVersionId, record.operationId, record.outcome, record.reason);
    await clearRestoreAudit(options, record.archiveVersionId, record.operationId);
  }
}

function restoreFailureReason(error, phase) {
  if (error?.publishedDestination) return 'publication_finalize_failed';
  if (phase === 'manifest') return 'manifest_update_failed';
  if (phase === 'ledger') return 'ledger_update_failed';
  if (error?.code === 'RESTORE_HASH_MISMATCH') return 'hash_mismatch';
  if (error?.code === 'RESTORE_SIZE_MISMATCH') return 'size_mismatch';
  if (error?.code === 'RESTORE_PROVIDER_LAYOUT_REFUSED') return 'provider_layout_refused';
  if (error?.code === 'RESTORE_CONFLICT') return 'publication_conflict';
  if (typeof error?.code === 'string' && /(?:PATH|SYMLINK|CASE_COLLISION)/.test(error.code)) return 'path_refused';
  if (typeof error?.code === 'string' && /(?:UPSTREAM|TIMEOUT|INTERRUPT)/.test(error.code)) return 'download_interrupted';
  return 'internal_error';
}

async function reconcileStaleRestoreTemps(directory) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\.agentbootup-restore-[0-9a-f-]+\.tmp$/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const stat = await fsp.lstat(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) await fsp.unlink(file).catch(() => {});
  }
}

async function publishAtomicNoOverwrite(temporary, destination, root, hooks) {
  const directory = path.dirname(destination);
  let linked = false;
  try {
    await assertNoSymlinkPath(root);
    await assertNoSymlinkPath(directory);
    await assertNoCaseCollision(directory, path.basename(destination));
    await fsp.link(temporary, destination);
    linked = true;
    await hooks?.afterPublishLink?.({ destination, temporary });
    const directoryHandle = await fsp.open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    await fsp.unlink(temporary);
    return true;
  } catch (error) {
    if (!linked && error.code === 'EEXIST') return false;
    if (linked) error.publishedDestination = destination;
    throw error;
  }
}

async function hashRegularFileNoFollow(file, label = 'restore destination') {
  let hash = createHash('sha256');
  const before = await lstatOrNull(file);
  if (!before || before.isSymbolicLink() || !before.isFile()) {
    throw Object.assign(new Error(`${label} must be a regular non-symlink file`), { code: 'RESTORE_PATH_CONFLICT' });
  }
  let handle;
  let bytes = 0;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw Object.assign(new Error(`${label} changed while opening`), { code: 'RESTORE_PATH_CONFLICT' });
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle?.close(); }
  return { contentHash: hash.digest('hex'), byteSize: bytes };
}

async function downloadToTemporary(client, brainId, archiveVersionId, restoreOperationId, temporary, expected, hooks) {
  const handle = await fsp.open(temporary, 'wx+', 0o600);
  let byteSize = 0;
  let position = 0;
  const write = async (chunk) => {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    byteSize += chunk.length;
    if (byteSize > expected.byteSize) throw integrityError('archive download exceeded the manifest byte size');
    let offset = 0;
    while (offset < chunk.length) {
      const result = hooks?.writeTemporary
        ? await hooks.writeTemporary(handle, chunk, offset, chunk.length - offset, position)
        : await handle.write(chunk, offset, chunk.length - offset, position);
      const bytesWritten = result?.bytesWritten;
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > chunk.length - offset) {
        throw Object.assign(new Error('archive temporary file write made invalid progress'), { code: 'RESTORE_WRITE_FAILED' });
      }
      offset += bytesWritten;
      position += bytesWritten;
    }
  };
  try {
    await client.downloadCommitted(brainId, archiveVersionId, {
      reset: async () => { await handle.truncate(0); byteSize = 0; position = 0; },
      write,
    }, restoreOperationId);
    if (byteSize !== expected.byteSize) throw Object.assign(integrityError('archive download does not match the manifest byte size'), { code: 'RESTORE_SIZE_MISMATCH' });
    await handle.sync();
    const persisted = await handle.stat();
    if (!persisted.isFile() || persisted.size !== expected.byteSize) {
      throw Object.assign(integrityError('persisted archive temporary file does not match the manifest byte size'), { code: 'RESTORE_SIZE_MISMATCH' });
    }
    const persistedHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let readPosition = 0;
    while (readPosition < persisted.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, persisted.size - readPosition), readPosition);
      if (!bytesRead) throw Object.assign(integrityError('persisted archive temporary file ended unexpectedly'), { code: 'RESTORE_SIZE_MISMATCH' });
      persistedHash.update(buffer.subarray(0, bytesRead));
      readPosition += bytesRead;
    }
    const contentHash = persistedHash.digest('hex');
    if (contentHash !== expected.contentHash) throw Object.assign(integrityError('persisted archive temporary file does not match the manifest hash'), { code: 'RESTORE_HASH_MISMATCH' });
    return { contentHash, byteSize };
  } finally { await handle.close(); }
}

function validateInventoryItem(item, requestedBrainId) {
  const manifestErrors = validateArchiveManifest(item?.manifest);
  const receiptErrors = validateDurabilityReceipt(item?.receipt);
  if (manifestErrors.length || receiptErrors.length) throw integrityError('archive inventory metadata is invalid');
  const { manifest, receipt } = item;
  if (manifest.logicalIdentity.brainId !== requestedBrainId
    || receipt.logicalIdentity.brainId !== requestedBrainId
    || receipt.logicalIdentity.provider !== manifest.logicalIdentity.provider
    || receipt.logicalIdentity.sessionId !== manifest.logicalIdentity.sessionId
    || receipt.sourceMachineId !== manifest.provenance.sourceMachineId
    || receipt.archiveVersionId !== manifest.archiveVersionId
    || receipt.manifestHash !== canonicalHash(manifest)
    || receipt.contentHash !== manifest.contentHash
    || receipt.byteSize !== manifest.byteSize
    || receipt.storageGeneration !== manifest.blob.storageGeneration) throw integrityError('archive manifest and receipt bindings do not match');
  return item;
}

export function selectRestoreInventory(items, selector) {
  const selected = items.filter(({ manifest }) => {
    if (!manifest || typeof manifest !== 'object' || !manifest.logicalIdentity || typeof manifest.logicalIdentity !== 'object'
      || typeof manifest.logicalIdentity.provider !== 'string' || typeof manifest.logicalIdentity.sessionId !== 'string'
      || typeof manifest.archiveVersionId !== 'string' || !manifest.provenance || typeof manifest.provenance.sourceMachineId !== 'string'
      || !manifest.timestamps || typeof (manifest.timestamps.last ?? manifest.timestamps.collected) !== 'string') return false;
    const identity = manifest.logicalIdentity;
    const timestamp = Date.parse(manifest.timestamps.last ?? manifest.timestamps.collected);
    return (!selector.provider || identity.provider === selector.provider)
      && (!selector.session || identity.sessionId === selector.session)
      && (!selector.archiveVersion || manifest.archiveVersionId === selector.archiveVersion)
      && (!selector.sourceMachine || manifest.provenance.sourceMachineId === selector.sourceMachine)
      && (!selector.since || timestamp >= selector.since.getTime())
      && (!selector.before || timestamp < selector.before.getTime());
  });
  return selected.sort((a, b) => {
    const aTime = Date.parse(a.manifest.timestamps.last ?? a.manifest.timestamps.collected);
    const bTime = Date.parse(b.manifest.timestamps.last ?? b.manifest.timestamps.collected);
    return bTime - aTime || a.manifest.archiveVersionId.localeCompare(b.manifest.archiveVersionId);
  });
}

async function mergeAnalysisManifest(projectRoot, item, destination, mode) {
  if (mode !== MODE.ANALYSIS) return;
  const authority = { archiveVersionId: item.manifest.archiveVersionId, contentHash: item.manifest.contentHash,
    archiveManifestHash: canonicalHash(item.manifest), sourceAuthority: 'archive_v2' };
  if (path.resolve(getTranscriptCacheRoot(projectRoot)) !== path.resolve(destination.root)) {
    const sidecar = path.join(destination.root, '.agentbootup-transcript-archive-manifest.json');
    await withTranscriptManifestLock(analysisManifestLockFile(destination.root), async () => {
      await assertNoSymlinkPath(destination.root);
      await assertNoCaseCollision(destination.root, path.basename(sidecar));
      const existing = await readJsonRegular(sidecar, 'analysis output manifest');
      if (existing?.brainId && existing.brainId !== item.manifest.logicalIdentity.brainId) throw Object.assign(new Error('analysis output manifest belongs to another brain'), { code: 'RESTORE_BRAIN_MISMATCH' });
      const entry = { provider: item.manifest.logicalIdentity.provider, sessionId: item.manifest.logicalIdentity.sessionId,
        sourceMachineId: item.manifest.provenance.sourceMachineId, relativePath: path.relative(destination.root, destination.path).split(path.sep).join('/'),
        byteSize: item.manifest.byteSize, ...authority };
      const entries = [...(existing?.entries ?? []).filter((value) => !(value.archiveVersionId === entry.archiveVersionId
        && value.relativePath === entry.relativePath)), entry]
        .sort((a, b) => `${a.archiveVersionId}:${a.relativePath}`.localeCompare(`${b.archiveVersionId}:${b.relativePath}`));
      const temporary = path.join(destination.root, `.agentbootup-manifest-${randomUUID()}.tmp`);
      const handle = await fsp.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, brainId: item.manifest.logicalIdentity.brainId, entries }, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      try {
        const current = await lstatOrNull(sidecar);
        if (current && (current.isSymbolicLink() || !current.isFile())) throw Object.assign(new Error('analysis output manifest is unsafe'), { code: 'RESTORE_PATH_CONFLICT' });
        await fsp.rename(temporary, sidecar);
        const directory = await fsp.open(destination.root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) { await fsp.unlink(temporary).catch(() => {}); throw error; }
    }, { trustedRoot: destination.root });
    return authority;
  }
  await updateManifestAtomic(projectRoot, async (existing) => {
    await assertNoSymlinkPath(destination.root);
    const current = existing ?? {
      schemaVersion: 1, normalizationVersion: 'mech-run.v1', brainId: item.manifest.logicalIdentity.brainId,
      machineId: 'archive-restore', generatedAt: new Date().toISOString(), raw: [], normalized: [], conflicts: [], errors: [],
    };
    if (current.brainId && current.brainId !== item.manifest.logicalIdentity.brainId) throw Object.assign(new Error('transcript cache manifest belongs to another brain'), { code: 'RESTORE_BRAIN_MISMATCH' });
    const rawEntry = {
      cli: item.manifest.logicalIdentity.provider,
      sessionId: item.manifest.logicalIdentity.sessionId,
      originalSessionId: item.manifest.logicalIdentity.sessionId,
      machineId: item.manifest.provenance.sourceMachineId,
      sourcePath: '', sourceRelativePath: item.manifest.provenance.sourceRelativePath,
      cachePath: path.relative(destination.root, destination.path).split(path.sep).join('/'),
      contentHash: item.manifest.contentHash, size: item.manifest.byteSize,
      firstTimestamp: item.manifest.timestamps.first, lastTimestamp: item.manifest.timestamps.last,
      matchConfidence: item.manifest.provenance.matchConfidence, matchedBy: item.manifest.provenance.matchMethod,
      archiveVersionId: item.manifest.archiveVersionId, archiveManifestHash: canonicalHash(item.manifest),
      sourceAuthority: 'archive_v2',
    };
    const incoming = buildManifestFromEntries({ brainId: item.manifest.logicalIdentity.brainId, machineId: 'archive-restore',
      generatedAt: current.generatedAt, entries: [{ ...rawEntry, rawCachePath: rawEntry.cachePath, size: rawEntry.size }] });
    return mergeManifest(current, incoming);
  });
  return authority;
}

async function materializeOne(item, options) {
  const manifest = item.manifest;
  const adapter = getProviderAdapter(manifest.logicalIdentity.provider);
  const mode = options.native ? MODE.NATIVE : MODE.ANALYSIS;
  const operation = options.native ? adapter.restoreNative.bind(adapter) : adapter.restoreAnalysis.bind(adapter);
  return operation(manifest, { projectRoot: options.projectRoot, restoreTransport: async ({ provider, relativePath, root: nativeRoot }) => {
    const root = path.resolve(nativeRoot ?? options.outputDir ?? getTranscriptCacheRoot(options.projectRoot));
    const sourceSegments = safeRelativePath(relativePath);
    const relative = options.native
      ? sourceSegments
      : ['raw', manifest.provenance.sourceMachineId, provider, ...sourceSegments];
    let destination = path.join(root, ...relative);
    await ensureDirectorySafe(root, path.dirname(destination));
    await reconcileStaleRestoreTemps(path.dirname(destination));
    await assertNoCaseCollision(path.dirname(destination), path.basename(destination));
    let conflict = false;
    const temporary = path.join(path.dirname(destination), `.agentbootup-restore-${randomUUID()}.tmp`);
    try {
      await downloadToTemporary(options.client, manifest.logicalIdentity.brainId, manifest.archiveVersionId,
        options.restoreOperationId, temporary, manifest, options.hooks);
      await assertNoSymlinkPath(root);
      await assertNoSymlinkPath(path.dirname(destination));
      await assertNoCaseCollision(path.dirname(destination), path.basename(destination));
      const existing = await lstatOrNull(destination);
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile()) throw Object.assign(new Error('restore destination is not a regular file'), { code: 'RESTORE_PATH_CONFLICT' });
        const exact = await hashRegularFileNoFollow(destination);
        if (exact.contentHash === manifest.contentHash && exact.byteSize === manifest.byteSize) {
          await fsp.unlink(temporary);
          return { root, path: destination, mode, result: 'existing', conflict: false, bytes: manifest.byteSize };
        }
        conflict = true;
        destination = conflictPath(destination, manifest.archiveVersionId);
        await assertNoCaseCollision(path.dirname(destination), path.basename(destination));
        const conflictExisting = await lstatOrNull(destination);
        if (conflictExisting) {
          if (!conflictExisting.isFile() || conflictExisting.isSymbolicLink()) throw Object.assign(new Error('restore conflict destination is unsafe'), { code: 'RESTORE_PATH_CONFLICT' });
          const conflictExact = await hashRegularFileNoFollow(destination, 'restore conflict destination');
          if (conflictExact.contentHash === manifest.contentHash && conflictExact.byteSize === manifest.byteSize) {
            await fsp.unlink(temporary);
            return { root, path: destination, mode, result: 'existing', conflict: true, bytes: manifest.byteSize };
          }
          throw Object.assign(new Error('restore conflict path already contains different content'), { code: 'RESTORE_CONFLICT', exitCode: TRANSCRIPT_EXIT_CODES.CONFLICT });
        }
      }
      await options.hooks?.beforePublish?.({ destination, temporary });
      const published = await publishAtomicNoOverwrite(temporary, destination, root, options.hooks);
      if (!published) {
        const raced = await hashRegularFileNoFollow(destination);
        if (raced.contentHash === manifest.contentHash && raced.byteSize === manifest.byteSize) {
          await fsp.unlink(temporary);
          return { root, path: destination, mode, result: 'existing', conflict, bytes: manifest.byteSize };
        }
        conflict = true;
        destination = conflictPath(destination, manifest.archiveVersionId);
        await assertNoCaseCollision(path.dirname(destination), path.basename(destination));
        const racedConflict = await lstatOrNull(destination);
        if (racedConflict) {
          if (!racedConflict.isFile() || racedConflict.isSymbolicLink()) {
            throw Object.assign(new Error('restore conflict destination is unsafe'), { code: 'RESTORE_PATH_CONFLICT' });
          }
          const conflictExact = await hashRegularFileNoFollow(destination, 'restore conflict destination');
          if (conflictExact.contentHash === manifest.contentHash && conflictExact.byteSize === manifest.byteSize) {
            await fsp.unlink(temporary);
            return { root, path: destination, mode, result: 'existing', conflict: true, bytes: manifest.byteSize };
          }
          throw Object.assign(new Error('restore conflict path already contains different content'),
            { code: 'RESTORE_CONFLICT', exitCode: TRANSCRIPT_EXIT_CODES.CONFLICT });
        }
        const conflictPublished = await publishAtomicNoOverwrite(temporary, destination, root, options.hooks);
        if (!conflictPublished) {
          const conflictRace = await hashRegularFileNoFollow(destination, 'restore conflict destination');
          if (conflictRace.contentHash === manifest.contentHash && conflictRace.byteSize === manifest.byteSize) {
            await fsp.unlink(temporary);
            return { root, path: destination, mode, result: 'existing', conflict: true, bytes: manifest.byteSize };
          }
          throw Object.assign(new Error('restore conflict destination appeared with different content during publication'),
            { code: 'RESTORE_CONFLICT', exitCode: TRANSCRIPT_EXIT_CODES.CONFLICT });
        }
      }
      return { root, path: destination, mode, result: 'restored', conflict, bytes: manifest.byteSize };
    } catch (error) {
      await fsp.unlink(temporary).catch(() => {});
      if (error.code === 'ENAMETOOLONG') error.code = 'RESTORE_PATH_TOO_LONG';
      error.restoreDestination = destination;
      error.restoreMode = mode;
      throw error;
    }
  } });
}

function restoreOperationLockFile(projectRoot, archiveVersionId) {
  return path.join(path.resolve(projectRoot), '.brain', '.restore-operation-locks', `${archiveVersionId}.sqlite`);
}

async function restoreSelectedItem(item, options) {
  let { operationId: restoreOperationId, reused: reusedRestoreOperation } = await prepareRestoreAudit(options, item);
  let phase = 'attempt';
  let attemptStarted = false;
  let destination = null;
  try {
    try {
      await options.client.beginRestoreAttempt(options.brainId, item.manifest.archiveVersionId, restoreOperationId);
    } catch (error) {
      if (!reusedRestoreOperation || error?.code !== 'restore_attempt_closed') throw error;
      await clearRestoreAudit(options, item.manifest.archiveVersionId, restoreOperationId);
      ({ operationId: restoreOperationId, reused: reusedRestoreOperation } = await prepareRestoreAudit(options, item));
      await options.client.beginRestoreAttempt(options.brainId, item.manifest.archiveVersionId, restoreOperationId);
    }
    attemptStarted = true;
    phase = 'materialize';
    destination = await materializeOne(item, { ...options, restoreOperationId });
    phase = 'manifest';
    const authority = await mergeAnalysisManifest(options.projectRoot, item, destination, destination.mode);
    phase = 'ledger';
    const restoreRecord = {
      restoredAt: new Date().toISOString(), destination: destination.path, mode: destination.mode,
      archiveVersionId: item.manifest.archiveVersionId, contentHash: item.manifest.contentHash,
      byteSize: item.manifest.byteSize, result: destination.conflict ? 'conflict'
        : destination.result === 'existing' ? 'already_present' : 'restored',
    };
    if (destination.mode === MODE.NATIVE && !destination.conflict
      && new Set(['restored', 'already_present']).has(restoreRecord.result)) {
      const ledgerState = await options.ledger.read({ verify: false });
      const candidates = Object.values(ledgerState.sources).filter((entry) =>
        (entry.archiveVersionId ?? entry.inventoryReference?.archiveVersionId) === item.manifest.archiveVersionId);
      const source = candidates.find((entry) => entry.state === 'offloaded')
        ?? (candidates.length === 1 ? candidates[0] : null);
      if (!source) throw new Error(candidates.length ? 'native restore ledger source is ambiguous' : 'native restore ledger source is missing');
      await options.ledger.recordRestoredSnapshot(source.sourceId, {
        sourceId: source.sourceId, logicalSessionKey: source.logicalSessionKey,
        sourcePath: destination.path, sourceRelativePath: item.manifest.provenance.sourceRelativePath,
        brainId: item.manifest.logicalIdentity.brainId, provider: item.manifest.logicalIdentity.provider,
        sessionId: item.manifest.logicalIdentity.sessionId, machineId: source.machineId,
        matchConfidence: item.manifest.provenance.matchConfidence, matchMethod: item.manifest.provenance.matchMethod,
        statFingerprint: { size: item.manifest.byteSize }, contentHash: item.manifest.contentHash,
        byteSize: item.manifest.byteSize, firstTimestamp: item.manifest.timestamps.first ?? undefined,
        lastTimestamp: item.manifest.timestamps.last ?? undefined, collectedAt: item.manifest.timestamps.collected,
        priorGeneration: item.manifest.priorGeneration ?? undefined,
      }, restoreRecord);
    } else {
      await options.ledger.recordRestoreByArchive?.(item.manifest.archiveVersionId, restoreRecord);
    }
    const terminalOutcome = destination.conflict ? 'conflict_preserved'
      : destination.result === 'existing' ? 'already_present' : 'restored';
    phase = 'audit';
    try {
      await setRestoreAuditTerminal(options, item, restoreOperationId, terminalOutcome, null);
    } catch (outboxError) {
      const error = Object.assign(new Error('restore completed locally but terminal audit outbox could not be persisted',
        { cause: outboxError }), { code: 'RESTORE_AUDIT_OUTBOX_FAILED', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM,
        restoreDestination: destination.path, restoreMode: destination.mode });
      let auditLost = false;
      let reported = false;
      try {
        await options.client.reportRestoreOutcome(options.brainId, item.manifest.archiveVersionId,
          restoreOperationId, terminalOutcome, null);
        reported = true;
      } catch (auditError) {
        error.auditError = auditError;
        error.code = 'RESTORE_AUDIT_UNRECOVERABLE';
        auditLost = true;
      }
      if (reported) {
        try { await clearRestoreAudit(options, item.manifest.archiveVersionId, restoreOperationId); }
        catch (cleanupError) { error.auditCleanupError = cleanupError; }
      }
      return { ok: false, brainId: options.brainId, provider: item.manifest.logicalIdentity.provider,
        sessionId: item.manifest.logicalIdentity.sessionId, archiveVersionId: item.manifest.archiveVersionId,
        bytes: item.manifest.byteSize, destination: destination.path, auditPending: false, auditLost, error };
    }
    try {
      await options.client.reportRestoreOutcome(options.brainId, item.manifest.archiveVersionId,
        restoreOperationId, terminalOutcome, null);
      await clearRestoreAudit(options, item.manifest.archiveVersionId, restoreOperationId);
    } catch (auditError) {
      const error = Object.assign(new Error('restore completed locally but terminal audit remains pending', { cause: auditError }),
        { code: 'RESTORE_AUDIT_PENDING', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
      return { ok: false, brainId: options.brainId, provider: item.manifest.logicalIdentity.provider,
        sessionId: item.manifest.logicalIdentity.sessionId, archiveVersionId: item.manifest.archiveVersionId,
        bytes: item.manifest.byteSize, destination: destination.path, auditPending: true, error };
    }
    return { ok: true, brainId: options.brainId, provider: item.manifest.logicalIdentity.provider,
      sessionId: item.manifest.logicalIdentity.sessionId, archiveVersionId: item.manifest.archiveVersionId,
      contentHash: item.manifest.contentHash, bytes: item.manifest.byteSize, destination: destination.path,
      mode: destination.mode, state: destination.result === 'existing' ? 'already_present' : destination.result,
      conflict: destination.conflict, authority };
  } catch (error) {
    if (error.code === 'ENAMETOOLONG') error.code = 'RESTORE_PATH_TOO_LONG';
    const failureDestination = path.resolve(destination?.path
      ?? error.restoreDestination ?? options.outputDir ?? getTranscriptCacheRoot(options.projectRoot));
    let reason = restoreFailureReason(error, phase);
    try {
      await options.ledger.recordRestoreByArchive?.(item.manifest.archiveVersionId, {
        restoredAt: new Date().toISOString(), destination: failureDestination, mode: error.restoreMode ?? (options.native ? MODE.NATIVE : MODE.ANALYSIS),
        archiveVersionId: item.manifest.archiveVersionId, contentHash: item.manifest.contentHash,
        byteSize: item.manifest.byteSize, result: 'error',
      });
    } catch (ledgerError) {
      reason = 'ledger_update_failed';
      error.ledgerError = ledgerError;
    }
    // The outer destination is assigned only after materializeOne returns. A thrown
    // materialization conflict therefore remains non-partial unless publication
    // itself succeeded and its finalization surfaced publishedDestination.
    const partialMaterialized = Boolean((destination || error.publishedDestination)
      && (phase === 'materialize' || phase === 'manifest' || phase === 'ledger'));
    let auditLost = false;
    if (attemptStarted) {
      const terminalOutcome = partialMaterialized ? 'partial_materialized' : 'failed';
      let terminalPersisted = false;
      try {
        await setRestoreAuditTerminal(options, item, restoreOperationId, terminalOutcome, reason);
        terminalPersisted = true;
      } catch (outboxError) {
        error.auditOutboxError = outboxError;
      }
      try {
        await options.client.reportRestoreOutcome(options.brainId, item.manifest.archiveVersionId,
          restoreOperationId, terminalOutcome, reason);
        if (terminalPersisted) await clearRestoreAudit(options, item.manifest.archiveVersionId, restoreOperationId);
      } catch (auditError) {
        error.auditError = auditError;
        if (terminalPersisted) error.auditPending = true;
        else {
          error.auditPending = false;
          error.code = 'RESTORE_AUDIT_UNRECOVERABLE';
          auditLost = true;
        }
      }
    } else {
      error.auditPending = true;
    }
    return { ok: false, partial: partialMaterialized, state: partialMaterialized ? 'materialized_incomplete' : 'failed',
      brainId: options.brainId, provider: item.manifest.logicalIdentity.provider,
      sessionId: item.manifest.logicalIdentity.sessionId, archiveVersionId: item.manifest.archiveVersionId,
      contentHash: item.manifest.contentHash, bytes: item.manifest.byteSize,
      destination: destination?.path ?? error.publishedDestination, mode: destination?.mode ?? error.restoreMode,
      auditPending: error.auditPending === true, auditLost, error };
  }
}

export async function restoreArchiveSelection(options) {
  if (typeof options.client.downloadCommitted !== 'function' || typeof options.client.beginRestoreAttempt !== 'function'
    || typeof options.client.reportRestoreOutcome !== 'function') {
    throw new TypeError('archive restore client requires restore-purpose download, attempt, and terminal outcome reporting');
  }
  await flushRestoreAuditOutbox(options);
  if (!options.native && !options.outputDir) {
    const cacheRoot = getTranscriptCacheRoot(options.projectRoot);
    await assertNoSymlinkPath(cacheRoot);
    const existingManifest = await readJsonRegular(path.join(cacheRoot, 'manifest.json'), 'transcript cache manifest');
    if (existingManifest?.brainId && existingManifest.brainId !== options.brainId) {
      throw Object.assign(new Error('transcript cache manifest belongs to another brain'), { code: 'RESTORE_BRAIN_MISMATCH' });
    }
  }
  if (!options.native && options.outputDir) {
    const outputRoot = path.resolve(options.outputDir);
    const stat = await lstatOrNull(outputRoot);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('analysis output root is unsafe'), { code: 'RESTORE_PATH_CONFLICT' });
      await assertNoSymlinkPath(outputRoot);
      const sidecarName = '.agentbootup-transcript-archive-manifest.json';
      await assertNoCaseCollision(outputRoot, sidecarName);
      const sidecar = await readJsonRegular(path.join(outputRoot, sidecarName), 'analysis output manifest');
      if (sidecar?.brainId && sidecar.brainId !== options.brainId) {
        throw Object.assign(new Error('analysis output manifest belongs to another brain'), { code: 'RESTORE_BRAIN_MISMATCH' });
      }
    }
  }
  const inventory = await options.client.inventory(options.brainId);
  const valid = [];
  const validationFailures = [];
  const candidates = inventory.filter((item) => {
    const manifest = item?.manifest;
    const identity = manifest?.logicalIdentity;
    if (identity?.brainId && identity.brainId !== options.brainId) return false;
    if (options.selector.provider && identity?.provider !== options.selector.provider) return false;
    if (options.selector.session && identity?.sessionId !== options.selector.session) return false;
    if (options.selector.archiveVersion && manifest?.archiveVersionId !== options.selector.archiveVersion) return false;
    if (options.selector.sourceMachine && manifest?.provenance?.sourceMachineId !== options.selector.sourceMachine) return false;
    const timestamp = Date.parse(manifest?.timestamps?.last ?? manifest?.timestamps?.collected);
    if ((options.selector.since || options.selector.before) && !Number.isFinite(timestamp)) return false;
    if (options.selector.since && timestamp < options.selector.since.getTime()) return false;
    if (options.selector.before && timestamp >= options.selector.before.getTime()) return false;
    return true;
  });
  for (const item of candidates) {
    try { valid.push(validateInventoryItem(item, options.brainId)); }
    catch (error) { validationFailures.push({ ok: false, kind: 'inventory_validation_failure', brainId: options.brainId,
      provider: item?.manifest?.logicalIdentity?.provider ?? null,
      sessionId: item?.manifest?.logicalIdentity?.sessionId ?? null,
      archiveVersionId: item?.manifest?.archiveVersionId ?? null,
      bytes: Number.isSafeInteger(item?.manifest?.byteSize) ? item.manifest.byteSize : 0, error }); }
  }
  await options.ledger.recordInventoryEntries(valid.map((item) => ({ manifest: item.manifest, receipt: item.receipt })), {
    requestedBrainIds: valid.map(() => options.brainId),
  });
  const selected = selectRestoreInventory(valid, options.selector);
  if (!selected.length && !validationFailures.length) throw new ArchiveClientError('no archive versions matched the restore selection', { code: 'NOT_FOUND', exitCode: TRANSCRIPT_EXIT_CODES.NOT_FOUND });
  const results = [...validationFailures];
  for (const item of selected) {
    results.push(await withTranscriptManifestLock(restoreOperationLockFile(options.projectRoot, item.manifest.archiveVersionId),
      () => restoreSelectedItem(item, options), { trustedRoot: path.resolve(options.projectRoot) }));
  }
  return results;
}
