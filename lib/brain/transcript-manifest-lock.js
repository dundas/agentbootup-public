import fsp from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { createClient } from '@libsql/client';

const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 10;
const inProcessQueues = new Map();

function busy(error) {
  return error?.code === 'SQLITE_BUSY' || /(?:database is locked|SQLITE_BUSY)/i.test(String(error?.message ?? ''));
}

async function safeLockPath(file, trustedRoot) {
  const target = path.resolve(file);
  const root = path.resolve(trustedRoot ?? path.dirname(target));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing transcript manifest lock outside its trusted root');
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Refusing unsafe transcript manifest lock root');
  let current = root;
  for (const segment of path.dirname(relative).split(path.sep).filter((value) => value && value !== '.')) {
    current = path.join(current, segment);
    const existing = await fsp.lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error('Refusing unsafe transcript manifest lock ancestor');
    if (!existing) await fsp.mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const verified = await fsp.lstat(current);
    if (verified.isSymbolicLink() || !verified.isDirectory()) throw new Error('Refusing unsafe transcript manifest lock ancestor');
    await fsp.chmod(current, 0o700);
  }
  let handle;
  try { handle = await fsp.open(target, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await handle?.close(); }
  const lockStat = await fsp.lstat(target);
  if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error('Refusing unsafe transcript manifest lock file');
  await fsp.chmod(target, 0o600);
  return target;
}

/**
 * Serialize a complete transcript-manifest read/merge/publish operation.
 * SQLite holds a kernel-backed write lock and releases it automatically on
 * process death, so no stale PID/lease takeover is required.
 */
async function withKernelLock(lockFile, operation, options) {
  await safeLockPath(lockFile, options.trustedRoot);
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  const client = createClient({ url: pathToFileURL(path.resolve(lockFile)).href });
  let transaction;
  try {
    await client.execute('PRAGMA busy_timeout = 5000');
    while (!transaction) {
      try {
        await client.execute('CREATE TABLE IF NOT EXISTS manifest_coordination (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))');
        transaction = await client.transaction('write');
        await transaction.execute('INSERT OR IGNORE INTO manifest_coordination (singleton) VALUES (1)');
      } catch (error) {
        await transaction?.rollback().catch(() => {});
        transaction = undefined;
        if (!busy(error) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    await fsp.chmod(lockFile, 0o600);
    const result = await operation();
    await transaction.commit();
    transaction = undefined;
    return result;
  } catch (error) {
    await transaction?.rollback().catch(() => {});
    throw error;
  } finally {
    client.close();
  }
}

export async function withTranscriptManifestLock(lockFile, operation, options = {}) {
  const key = path.resolve(lockFile);
  const previous = inProcessQueues.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  inProcessQueues.set(key, current);
  try {
    await previous;
    return await withKernelLock(key, operation, options);
  } finally {
    release();
    if (inProcessQueues.get(key) === current) inProcessQueues.delete(key);
  }
}

export function transcriptCacheManifestLockFile(projectRoot) {
  return path.join(path.resolve(projectRoot), '.brain', '.transcript-cache-manifest-lock.sqlite');
}

export function analysisManifestLockFile(outputRoot) {
  return path.join(path.resolve(outputRoot), '.agentbootup-transcript-archive-manifest-lock.sqlite');
}
