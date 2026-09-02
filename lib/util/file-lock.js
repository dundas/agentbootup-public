/**
 * Cross-process advisory file lock.
 *
 * Extracted from machine-id.js, which derived it first, because credentials.js needs the
 * same guarantee. A compare-and-swap immediately before rename() is *not* sufficient on
 * its own: the file can change between the check and the rename, and it does — under Bun's
 * scheduling that interleaving reproduces on every run. Only serializing the whole
 * read-decide-publish sequence closes the window.
 *
 * A lock left behind by a killed process goes stale after `staleMs`. Staleness must mean
 * "the holder is dead", never "the holder is slow", so an active holder heartbeats its
 * lock's mtime while it works.
 *
 * Two properties make stealing safe:
 *
 * - Stealing is exclusive: the stale lock is renamed away, and rename() off a live name
 *   succeeds for exactly one caller. Unlinking instead would let two waiters each remove a
 *   lock and each create a fresh one, putting both inside the critical section.
 * - Releasing is ownership-checked: each holder writes a token into its lock and removes
 *   the lock only if that token is still there. Otherwise a holder revived after its lock
 *   was stolen would delete its successor's lock on the way out.
 *
 * The heartbeat proves liveness only while the event loop runs. A process suspended past
 * `staleMs` (SIGSTOP, system sleep) cannot be told apart from a dead one without a
 * kernel-backed lock, which node's fs does not expose. Callers that cannot tolerate that
 * must not rest correctness on the lock alone.
 */

import fsp from 'fs/promises';
import fs from 'fs';
import { randomUUID } from 'crypto';

const DEFAULT_STALE_MS = 10_000;

/**
 * Run `critical` with exclusive access to `filePath`, across processes.
 *
 * @param {string} filePath the resource being guarded (the lock is `${filePath}.lock`)
 * @param {() => Promise<any>} critical
 * @param {{ staleMs?: number, waitMs?: number }} [options]
 */
export async function withFileLock(filePath, critical, options = {}) {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  // The retry window must exceed staleMs, or a lock orphaned a moment ago can never be
  // waited out: every caller would give up before it became stealable.
  const waitMs = options.waitMs ?? staleMs * 2 + 5_000;

  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + waitMs;

  for (let attempt = 0; Date.now() < deadline; attempt++) {
    let handle;
    const token = randomUUID();
    try {
      handle = await fsp.open(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const stat = await fsp.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        // Claim the right to remove it. Exactly one racer's rename() succeeds.
        const stolen = `${lockPath}.stale.${token}`;
        try {
          await fsp.rename(lockPath, stolen);
          await fsp.rm(stolen, { force: true }).catch(() => {});
        } catch (stealErr) {
          if (stealErr.code !== 'ENOENT') throw stealErr; // someone else got it
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, 5 + attempt)));
      continue;
    }

    let heartbeat;
    try {
      await handle.writeFile(token, 'utf-8');
      // Keep the lock visibly alive. A missed touch (the lock was stolen, the directory
      // went away) is not worth failing the critical section over.
      heartbeat = setInterval(() => {
        const now = new Date();
        fsp.utimes(lockPath, now, now).catch(() => {});
      }, Math.floor(staleMs / 3));
      heartbeat.unref?.();
      return await critical();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await handle.close().catch(() => {});
      // Remove the lock only if it is still ours. If it was stolen while we were slow, the
      // file now belongs to another holder and must be left alone.
      const owner = await fsp.readFile(lockPath, 'utf-8').catch(() => null);
      if (owner !== null && owner.trim() === token) {
        await fsp.rm(lockPath, { force: true }).catch(() => {});
      }
    }
  }

  throw new Error(`Timed out acquiring the lock at ${lockPath}`);
}

/**
 * Synchronous counterpart for short reads that must serialize with
 * `withFileLock`. The critical section must finish within `staleMs` because a
 * blocked event loop cannot heartbeat.
 */
export function withFileLockSync(filePath, critical, options = {}) {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = options.waitMs ?? staleMs * 2 + 5_000;
  const fsImpl = options.fsImpl ?? fs;
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + waitMs;
  const waitArray = new Int32Array(new SharedArrayBuffer(4));

  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    let descriptor;
    const token = randomUUID();
    try {
      descriptor = fsImpl.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stat = null;
      try { stat = fsImpl.statSync(lockPath); } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        const stolen = `${lockPath}.stale.${token}`;
        try {
          fsImpl.renameSync(lockPath, stolen);
          fsImpl.rmSync(stolen, { force: true });
        } catch (stealError) {
          if (stealError?.code !== 'ENOENT') throw stealError;
        }
        continue;
      }
      Atomics.wait(waitArray, 0, 0, Math.min(25, 5 + attempt));
      continue;
    }

    try {
      fsImpl.writeFileSync(descriptor, token, 'utf8');
      return critical();
    } finally {
      try { fsImpl.closeSync(descriptor); } catch { /* best-effort close */ }
      let owner = null;
      try { owner = fsImpl.readFileSync(lockPath, 'utf8'); } catch { /* lock may have been stolen */ }
      if (owner !== null && owner.trim() === token) {
        try { fsImpl.rmSync(lockPath, { force: true }); } catch { /* best-effort ownership release */ }
      }
    }
  }

  throw new Error(`Timed out acquiring the lock at ${lockPath}`);
}
