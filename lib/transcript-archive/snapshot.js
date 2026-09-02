import fsp from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { ARCHIVE_LIMITS } from './config.js';

async function assertNoSymlinkComponents(filePath, trustedRoot) {
  const root = path.resolve(trustedRoot);
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`refusing transcript path with symlink trusted root: ${root}`);
  const relative = path.relative(root, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('transcript source must be a child of its trusted root');
  let current = await fsp.realpath(root);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`refusing transcript path with symlink component: ${current}`);
  }
}

async function containmentGuard(filePath, trustedRoot) {
  if (!fsConstants.O_NOFOLLOW) throw new Error('stable transcript containment requires O_NOFOLLOW support');
  const target = path.resolve(filePath);
  const root = path.resolve(trustedRoot);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('transcript source must be a child of its trusted root');
  await assertNoSymlinkComponents(filePath, root);
  const realRoot = await fsp.realpath(root);
  const realParent = await fsp.realpath(path.dirname(target));
  const realRelative = path.relative(realRoot, realParent);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('transcript source parent escaped its trusted root');
  const [rootStat, parentStat] = await Promise.all([
    fsp.stat(realRoot, { bigint: true }),
    fsp.stat(realParent, { bigint: true }),
  ]);
  return {
    realRoot,
    realParent,
    rootDevice: String(rootStat.dev),
    rootInode: String(rootStat.ino),
    parentDevice: String(parentStat.dev),
    parentInode: String(parentStat.ino),
  };
}

export async function validateTranscriptContainment(filePath, trustedRoot, noFollowSupported = Boolean(fsConstants.O_NOFOLLOW)) {
  if (!noFollowSupported) throw new Error('stable transcript containment requires O_NOFOLLOW support');
  await containmentGuard(filePath, trustedRoot);
}

function assertSameContainment(current, guard) {
  if (current.realRoot !== guard.realRoot || current.realParent !== guard.realParent
    || current.rootDevice !== guard.rootDevice || current.rootInode !== guard.rootInode
    || current.parentDevice !== guard.parentDevice || current.parentInode !== guard.parentInode) {
    throw new Error('transcript source trusted root or ancestor identity changed during snapshot');
  }
}

async function revalidateContainment(filePath, trustedRoot, guard) {
  assertSameContainment(await containmentGuard(filePath, trustedRoot), guard);
}

function fingerprint(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameFingerprint(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

export function transcriptFingerprintMatches(left, right) {
  return Boolean(left && right) && sameFingerprint(left, right) && sameFingerprint(right, left);
}

/**
 * Read one bounded range from the exact source generation that was previously
 * hashed. This lets archive uploads stream in request-sized parts without
 * staging a second full transcript on local disk.
 */
export async function readStableSnapshotPart(filePath, options = {}) {
  const { trustedRoot, expectedFingerprint, offset, length } = options;
  if (!trustedRoot) throw new TypeError('stable transcript part reads require an explicit trusted root');
  if (!expectedFingerprint || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(length) || length < 1) {
    throw new TypeError('stable transcript part read requires a fingerprint and positive bounded range');
  }
  const guard = await containmentGuard(filePath, trustedRoot);
  const handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = fingerprint(await handle.stat({ bigint: true }));
    if (!transcriptFingerprintMatches(before, expectedFingerprint)) {
      const error = new Error('transcript source changed after snapshot planning');
      error.code = 'SNAPSHOT_CHANGED';
      throw error;
    }
    if (offset + length > before.size) throw new Error('stable transcript part range exceeds the planned source size');
    const buffer = Buffer.allocUnsafe(length);
    let readOffset = 0;
    while (readOffset < length) {
      const { bytesRead } = await handle.read(buffer, readOffset, length - readOffset, offset + readOffset);
      if (bytesRead < 1) throw new Error('stable transcript part read ended before the planned byte size');
      readOffset += bytesRead;
    }
    const after = fingerprint(await handle.stat({ bigint: true }));
    const current = fingerprint(await fsp.stat(filePath, { bigint: true }));
    await revalidateContainment(filePath, trustedRoot, guard);
    if (!transcriptFingerprintMatches(after, expectedFingerprint)
      || !transcriptFingerprintMatches(current, expectedFingerprint)) {
      const error = new Error('transcript source changed during part upload');
      error.code = 'SNAPSHOT_CHANGED';
      throw error;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function snapshotTooLarge(maxBytes) {
  const error = new Error(`stable snapshot exceeds bounded byte limit: ${maxBytes}`);
  error.code = 'SNAPSHOT_TOO_LARGE';
  return error;
}

export async function readStableSnapshot(filePath, options = {}) {
  const noFollowSupported = options.noFollowSupported ?? Boolean(fsConstants.O_NOFOLLOW);
  if (!noFollowSupported) throw new Error('stable transcript snapshots require O_NOFOLLOW support');
  const limits = options.limits ?? ARCHIVE_LIMITS;
  const maxAttempts = options.maxAttempts ?? limits.snapshotMaxAttempts;
  const maxBytes = options.maxBytes ?? (options.retainBuffer === false ? limits.streamingFileByteLimit : limits.requestByteLimit);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer');
  const trustedRoot = options.trustedRoot ?? path.dirname(path.dirname(path.resolve(filePath)));
  // Pin the trust anchor once for the whole operation. A retry is allowed to
  // observe a new file generation, never a replacement trusted directory.
  const operationGuard = await containmentGuard(filePath, trustedRoot);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const guard = await containmentGuard(filePath, trustedRoot);
    assertSameContainment(guard, operationGuard);
    if (typeof options.beforeOpen === 'function') await options.beforeOpen({ attempt, filePath });
    await revalidateContainment(filePath, trustedRoot, guard);
    const beforeOpen = await fsp.lstat(filePath);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) throw new Error(`transcript source must be a regular file: ${filePath}`);
    const handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    let stream;
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error(`transcript source must be a regular file: ${filePath}`);
      const before = fingerprint(await handle.stat({ bigint: true }));
      if (before.size > maxBytes) throw snapshotTooLarge(maxBytes);
      if (typeof options.beforeRead === 'function') await options.beforeRead({ attempt, filePath, before });
      const retainBuffer = options.retainBuffer !== false;
      const chunks = [];
      let byteSize = 0;
      const hash = createHash('sha256');
      stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        byteSize += chunk.length;
        if (byteSize > maxBytes) throw snapshotTooLarge(maxBytes);
        hash.update(chunk);
        if (retainBuffer) chunks.push(chunk);
      }
      const buffer = retainBuffer ? Buffer.concat(chunks, byteSize) : undefined;
      if (typeof options.afterRead === 'function') await options.afterRead({ attempt, filePath, before });
      const after = fingerprint(await handle.stat({ bigint: true }));
      // The path-based stat deliberately detects same-parent file replacement;
      // safety comes from comparing its device/inode fingerprint with the open handle.
      const current = fingerprint(await fsp.stat(filePath, { bigint: true }));
      await revalidateContainment(filePath, trustedRoot, guard);
      if (byteSize === before.size && sameFingerprint(before, after) && sameFingerprint(after, current)) {
        return {
          ...(retainBuffer ? { buffer } : {}),
          byteSize,
          contentHash: hash.digest('hex'),
          before,
          after,
          attempts: attempt,
        };
      }
      if (typeof options.afterUnstableAttempt === 'function') await options.afterUnstableAttempt({ attempt, filePath });
    } finally {
      stream?.destroy();
      await handle.close();
    }
  }
  const error = new Error(`unable to obtain stable snapshot after ${maxAttempts} attempts`);
  error.code = 'SNAPSHOT_UNSTABLE';
  throw error;
}
