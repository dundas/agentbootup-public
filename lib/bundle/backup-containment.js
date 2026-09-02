import fs from 'fs';
import path from 'path';

const ERROR_PREFIX = 'bundle backup structural preflight failed';

function fail(reason) {
  throw new Error(`${ERROR_PREFIX}: ${reason}`);
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function statIdentity(stat) {
  const dev = String(stat.dev);
  const ino = String(stat.ino);
  if (!/^\d+$/.test(dev) || !/^\d+$/.test(ino) || ino === '0') fail('filesystem identity is unavailable');
  return {
    dev,
    ino,
    mode: stat.mode & 0o7777,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'unsupported',
  };
}

function identityEqual(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.kind === right.kind
    && left.link === right.link;
}

function inspectAnchoredPath(absolutePath, anchorPath, { requireExisting = false } = {}) {
  const logicalAnchor = path.resolve(anchorPath);
  let existingAnchor = logicalAnchor;
  while (true) {
    try {
      fs.lstatSync(existingAnchor);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') fail('trusted root identity is unavailable');
      const parent = path.dirname(existingAnchor);
      if (parent === existingAnchor) fail('trusted root identity is unavailable');
      existingAnchor = parent;
    }
  }
  let anchorStat;
  try { anchorStat = fs.lstatSync(existingAnchor); } catch { fail('trusted root identity is unavailable'); }
  if (anchorStat.isSymbolicLink() || !anchorStat.isDirectory()) fail('trusted root is not a real directory');
  let canonicalAnchor;
  try { canonicalAnchor = fs.realpathSync(existingAnchor); } catch { fail('trusted root identity is unavailable'); }

  const absolute = path.resolve(absolutePath);
  const relative = path.relative(existingAnchor, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('path escapes its trusted root');
  const segments = relative.split(path.sep).filter(Boolean);
  let logicalCursor = existingAnchor;
  let canonicalCursor = canonicalAnchor;
  let missing = false;
  let leafStat = anchorStat;

  for (const segment of segments) {
    logicalCursor = path.join(logicalCursor, segment);
    canonicalCursor = path.join(canonicalCursor, segment);
    if (missing) continue;
    try {
      leafStat = fs.lstatSync(logicalCursor);
    } catch (error) {
      if (error?.code !== 'ENOENT') fail('filesystem identity is unavailable');
      missing = true;
      leafStat = null;
      continue;
    }
    if (leafStat.isSymbolicLink()) fail('symbolic links are not permitted in managed paths');
    try { canonicalCursor = fs.realpathSync(logicalCursor); } catch { fail('filesystem identity is unavailable'); }
  }

  if (requireExisting && missing) fail('source identity is unavailable');
  return {
    logical: absolute,
    canonical: path.resolve(canonicalCursor),
    exists: !missing,
    identity: leafStat ? statIdentity(leafStat) : null,
  };
}

function snapshotTree(root, { allowNestedSymlinks = false } = {}) {
  const records = [];
  const visit = (absolute, relative) => {
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { fail('source identity is unavailable'); }
    const record = { path: relative, ...statIdentity(stat) };
    if (record.kind === 'symlink') {
      if (!allowNestedSymlinks) fail('symbolic links are not permitted in managed backup sources');
      try { record.link = fs.readlinkSync(absolute); } catch { fail('symbolic-link identity is unavailable'); }
      records.push(record);
      return;
    }
    if (record.kind === 'unsupported') fail('unsupported filesystem entry in backup source');
    records.push(record);
    if (record.kind !== 'directory') return;
    let names;
    try { names = fs.readdirSync(absolute).sort(); } catch { fail('backup source is unreadable'); }
    for (const name of names) visit(path.join(absolute, name), relative ? path.join(relative, name) : name);
  };
  visit(root, '');
  return records;
}

function snapshotEqual(left, right) {
  return left.length === right.length && left.every((record, index) => {
    const candidate = right[index];
    return record.path === candidate.path && identityEqual(record, candidate);
  });
}

export function planStructuralBackupCopy({
  sourcePath,
  destinationPath,
  targetRoot,
  backupHome,
  backupsRoot,
  allowNestedSymlinks = false,
}) {
  const source = inspectAnchoredPath(sourcePath, targetRoot, { requireExisting: true });
  const destination = inspectAnchoredPath(destinationPath, backupHome);
  const protectedRoot = inspectAnchoredPath(backupsRoot, backupHome);

  if (within(source.canonical, protectedRoot.canonical)
    || within(protectedRoot.canonical, source.canonical)
    || within(source.canonical, destination.canonical)
    || within(destination.canonical, source.canonical)) {
    fail('backup source and destination overlap');
  }
  if (sameIdentity(source.identity, protectedRoot.identity)
    || sameIdentity(source.identity, destination.identity)) fail('backup source aliases protected storage');

  return {
    source,
    destination,
    allowNestedSymlinks,
    snapshot: snapshotTree(source.logical, { allowNestedSymlinks }),
  };
}

export function originalModeRecords(plan) {
  return plan.snapshot
    .map(({ path: relative, kind, mode }) => ({ path: relative, kind, mode }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function revalidateStructuralBackupCopy(plan, { targetRoot, backupHome } = {}) {
  const source = inspectAnchoredPath(plan.source.logical, targetRoot, { requireExisting: true });
  const destination = inspectAnchoredPath(plan.destination.logical, backupHome);
  if (source.canonical !== plan.source.canonical
    || source.identity.dev !== plan.source.identity.dev
    || source.identity.ino !== plan.source.identity.ino
    || destination.canonical !== plan.destination.canonical
    || destination.exists !== plan.destination.exists) {
    fail('filesystem identity changed after preflight');
  }
  const current = snapshotTree(source.logical, { allowNestedSymlinks: plan.allowNestedSymlinks });
  if (!snapshotEqual(plan.snapshot, current)) fail('backup source changed after preflight');
}

export function privateMode(originalMode, kind) {
  const owner = originalMode & 0o700;
  if (kind === 'directory') return owner | 0o700;
  return owner | 0o600;
}

export function makeBackupCopyPrivate(destination, modes) {
  for (const record of [...modes].sort((a, b) => b.path.length - a.path.length)) {
    if (record.kind === 'symlink') continue;
    const absolute = record.path ? path.join(destination, record.path) : destination;
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { fail('backup output identity is unavailable'); }
    if (stat.isSymbolicLink()) fail('backup output became a symbolic link');
    try { fs.chmodSync(absolute, privateMode(record.mode, record.kind)); }
    catch { fail('private backup permissions could not be applied'); }
  }
}

export function restoreOriginalModes(target, modes) {
  if (!Array.isArray(modes)) return;
  for (const record of modes) {
    if (!record || typeof record.path !== 'string' || path.isAbsolute(record.path)
      || record.path.split(/[\\/]/).includes('..')
      || !['file', 'directory', 'symlink'].includes(record.kind)
      || !Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o7777) {
      fail('original-mode metadata is invalid');
    }
  }
  for (const record of [...modes].sort((a, b) => b.path.length - a.path.length)) {
    if (record.kind === 'symlink') continue;
    const absolute = record.path ? path.join(target, record.path) : target;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('restore target became a symbolic link');
      fs.chmodSync(absolute, record.mode);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(ERROR_PREFIX)) throw error;
      fail('original backup permissions could not be restored');
    }
  }
}
