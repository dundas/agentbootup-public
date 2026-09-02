/**
 * Cross-process memory sync mutex (PRD-0054 FR 7a).
 *
 * Serializes the daemon converge/publish legs and the `memory` CLI commands
 * so `.brain/` state and `memory/` writes can never interleave across
 * processes. In-process locks (the daemons' syncPromise) cannot see each
 * other; this file-based lock is the shared ground truth.
 *
 * Design constraints (adversarial + pairing review, PRD 7a):
 *  - Conservative stale handling: a lock whose holder pid is ALIVE is never
 *    stolen, no matter how old — a bad steal during slow I/O corrupts state
 *    and is worse than no lock. Only a dead-pid lock is reclaimed, and the
 *    reclaim goes through an atomic rename so two reclaimers cannot both
 *    "win" the same stale file.
 *  - Every awaiter is bounded: acquisition waits at most `waitMs`, then
 *    throws MemorySyncLockHeldError carrying the holder info so callers can
 *    report "daemon sync in progress" instead of hanging.
 *  - `.brain` must be a real directory — a symlinked `.brain` is refused
 *    (matches the store's containment rules).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isProcessAlive } from '../process/pid-utils.js';

const LOCK_FILENAME = 'memory-sync.lock';
const RETRY_INTERVAL_MS = 50;
const DEFAULT_WAIT_MS = 10_000;

export class MemorySyncLockHeldError extends Error {
  constructor(holder) {
    const label = holder?.label || 'unknown';
    const pid = holder?.pid ?? '?';
    super(`memory sync lock held by ${label} (pid ${pid}) — daemon sync in progress; retry shortly`);
    this.code = 'MEMORY_SYNC_LOCK_HELD';
    this.holder = holder;
  }
}

/**
 * Resolve the lock path, or null when `.brain` is UNWRITABLE (EACCES/EROFS/
 * mkdir failure). Unwritable degrades to LOCKLESS execution deliberately: a
 * process that cannot write `.brain` cannot corrupt the state this lock
 * protects — the memory commands' own fail-closed preflights refuse those
 * mutations with their specific messages, which the lock must not mask.
 * A SYMLINKED `.brain` stays a hard refusal (containment, not writability).
 */
function lockPathFor(projectRoot) {
  const brainDir = path.join(path.resolve(projectRoot), '.brain');
  let st = null;
  try { st = fs.lstatSync(brainDir); } catch { /* absent — try to create below */ }
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`memory sync lock refused: ${brainDir} is a symlink`);
    if (!st.isDirectory()) return null; // a file at .brain = unwritable-state condition; degrade lockless
  } else {
    try {
      fs.mkdirSync(brainDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      if (UNWRITABLE_CODES.has(err?.code)) return null;
      throw err;
    }
  }
  return path.join(brainDir, LOCK_FILENAME);
}

/** Only genuine unwritability degrades to lockless (see lockPathFor).
 * Transient errors (ENOSPC, EMFILE, EIO...) must surface, not silently
 * disable serialization (roborev). */
const UNWRITABLE_CODES = new Set(['EACCES', 'EROFS', 'EPERM']);

function readHolder(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse Linux's /proc/<pid>/stat start time without being confused by spaces
 * (or closing parentheses) in the parenthesized comm field. The fields after
 * the final `)` begin at kernel field 3 (state), making starttime (field 22)
 * index 19. Anything short or malformed remains unprovable.
 */
export function parseLinuxProcStatStartTicks(stat) {
  if (typeof stat !== 'string') return null;
  const openingParen = stat.indexOf('(');
  const closingParen = stat.lastIndexOf(')');
  if (openingParen < 0 || closingParen <= openingParen) return null;
  const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
  if (fields.length <= 19 || !/^[A-Za-z]$/.test(fields[0])) return null;
  const startTicks = fields[19];
  return /^\d+$/.test(startTicks || '') ? startTicks : null;
}

/**
 * Return a stable identity token for a live process, or null when this host
 * cannot safely determine one. PID liveness alone cannot distinguish a stale
 * PID file from a PID that has been recycled to an unrelated process.
 *
 * The Linux kernel start-tick is immutable for a process lifetime. macOS's
 * `ps -o lstart` is only second-precise, so it cannot prove identity after a
 * rapid PID reuse. Darwin and unknown platforms remain conservative: a live
 * PID without a comparable token is never stolen.
 */
export function getMemorySyncLockOwnerToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const startTicks = parseLinuxProcStatStartTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      return startTicks === null ? null : `linux:${pid}:${startTicks}`;
    }
  } catch {
    // A missing /proc entry or an unavailable ps binary means identity cannot
    // be proved. The caller will retain the conservative live-PID behavior.
  }
  return null;
}

/**
 * Try one acquisition. Returns the exact owner token written on success, or the current holder
 * (object or null for unreadable) when the lock is taken.
 */
function tryAcquire(lockPath, holderLabel) {
  // Atomic acquisition via link(2): the holder payload is written to a unique
  // temp file FIRST, then hard-linked to the lock path — content becomes
  // visible atomically with the lock's existence. The previous two-step
  // open('wx')+write left a window where a concurrent reader saw an EMPTY
  // lock, judged it corrupt, and stole a LIVE lock (roborev, High).
  const ownerToken = getMemorySyncLockOwnerToken(process.pid);
  const payload = JSON.stringify({
    pid: process.pid,
    label: holderLabel,
    ownerToken,
    acquiredAt: new Date().toISOString(),
  });
  const tmp = `${lockPath}.acquire-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (UNWRITABLE_CODES.has(err?.code)) return 'unlockable';
    throw err;
  }
  try {
    fs.linkSync(tmp, lockPath);
    fs.rmSync(tmp, { force: true });
    return { acquired: true, ownerToken };
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err.code !== 'EEXIST') {
      // Hard links can be unsupported on otherwise-WRITABLE filesystems
      // (some network mounts): fall back to exclusive-create-then-write.
      // The brief empty-file window this reintroduces is harmless now,
      // because an unreadable lock is WAITED OUT, never reclaimed (roborev).
      if (err.code === 'EPERM' || err.code === 'ENOTSUP' || err.code === 'EOPNOTSUPP' || err.code === 'EXDEV') {
        let fd = null;
        let created = false;
        try {
          fd = fs.openSync(lockPath, 'wx', 0o600);
          created = true;
          fs.writeSync(fd, payload);
          fs.closeSync(fd);
          fd = null;
          return { acquired: true, ownerToken };
        } catch (err2) {
          // Never strand a partially-written lock we created: unreadable locks
          // are non-reclaimable, so a stranded empty file would block everyone
          // until timeout with no live owner (roborev).
          if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
          if (created && err2.code !== 'EEXIST') fs.rmSync(lockPath, { force: true });
          if (err2.code === 'EEXIST') { /* held — fall through to holder read */ }
          else if (UNWRITABLE_CODES.has(err2?.code)) return 'unlockable';
          else throw err2;
        }
      } else if (UNWRITABLE_CODES.has(err?.code)) {
        return 'unlockable';
      } else {
        throw err;
      }
    }
  }

  const holder = readHolder(lockPath);
  // NEVER reclaim an unreadable/incomplete lock: with atomic acquisition it
  // should not occur, and treating it as reclaimable is exactly the live-
  // steal hazard. Wait it out; the bounded wait surfaces a held error.
  if (holder === null) return { label: 'unknown (unreadable lock file)', pid: null };
  const pid = Number(holder.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { label: holder.label || 'unknown', pid: null };
  // Reclaim only a provably-dead holder, or a live PID whose durable process
  // identity proves that the PID was recycled. Missing/unknown tokens retain
  // the previous conservative behavior for legacy locks and unsupported OSes.
  const dead = !isProcessAlive(pid);
  const currentOwnerToken = dead ? null : getMemorySyncLockOwnerToken(pid);
  const pidReused = !dead
    && typeof holder.ownerToken === 'string'
    && typeof currentOwnerToken === 'string'
    && holder.ownerToken !== currentOwnerToken;
  if (dead || pidReused) {
    // Atomic reclaim: rename the stale file to a unique name first — only the
    // process whose rename succeeds proceeds to retry acquisition, so two
    // reclaimers can never both treat the same stale lock as theirs.
    const staleName = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.renameSync(lockPath, staleName);
      fs.rmSync(staleName, { force: true });
    } catch { /* someone else reclaimed first — fall through to retry */ }
    return null; // caller retries immediately
  }
  return holder;
}

/**
 * Run `fn` while holding the cross-process memory sync lock for projectRoot.
 * Waits up to `waitMs` (default 10s) for a busy lock, then throws
 * MemorySyncLockHeldError with the holder info. The lock is always released
 * on completion or throw — but never released if this process no longer owns
 * it (a reclaimed-after-death scenario must not delete a newer holder's lock).
 *
 * @template T
 * @param {{ projectRoot: string, holderLabel: string, waitMs?: number }} opts
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
/** In-process hold flags, keyed by resolved projectRoot (see isMemorySyncLockHeldByThisProcess). */
const heldRoots = new Set();

/**
 * True when THIS process currently holds the lock for projectRoot. Lets the
 * memory CLI skip re-acquisition when invoked in-process from inside the
 * daemon's converge cycle (which already holds the lock) — cross-process
 * callers still serialize through the file.
 */
export function isMemorySyncLockHeldByThisProcess(projectRoot) {
  return heldRoots.has(path.resolve(projectRoot));
}

/** Run fn lockless but still registered as held-in-process, so reentrant
 * callers (the CLI invoked from inside a degraded daemon cycle) do not
 * recurse back into acquisition. */
async function runLocklessHeld(projectRoot, fn) {
  const rootKey = path.resolve(projectRoot);
  const had = heldRoots.has(rootKey);
  if (!had) heldRoots.add(rootKey);
  try {
    return await fn();
  } finally {
    if (!had) heldRoots.delete(rootKey);
  }
}

export async function withMemorySyncLock({ projectRoot, holderLabel, waitMs = DEFAULT_WAIT_MS }, fn) {
  const lockPath = lockPathFor(projectRoot);
  if (lockPath === null) return runLocklessHeld(projectRoot, fn); // unwritable .brain — see lockPathFor
  const deadline = Date.now() + Math.max(0, waitMs);
  let lastHolder = null;
  let acquiredOwnerToken = null;

  for (;;) {
    const result = tryAcquire(lockPath, holderLabel);
    if (result?.acquired === true) {
      acquiredOwnerToken = result.ownerToken;
      break;
    }
    if (result === 'unlockable') return runLocklessHeld(projectRoot, fn);
    if (result !== null) lastHolder = result;
    if (Date.now() >= deadline) throw new MemorySyncLockHeldError(lastHolder);
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }

  const rootKey = path.resolve(projectRoot);
  heldRoots.add(rootKey);
  try {
    return await fn();
  } finally {
    heldRoots.delete(rootKey);
    // Release only our own lock: verify ownership before unlink.
    const holder = readHolder(lockPath);
    if (holder
      && Number(holder.pid) === process.pid
      && holder.label === holderLabel
      && holder.ownerToken === acquiredOwnerToken) {
      fs.rmSync(lockPath, { force: true });
    }
  }
}
