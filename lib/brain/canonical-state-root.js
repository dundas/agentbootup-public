/**
 * Branch-independent canonical state root for ignored mutable brain state
 * (PRD-0059 FR-7/FR-8).
 *
 * SeedID's managed `.gitignore` block intentionally ignores `memory/`, `.ai/`,
 * `.brain/`, and other brain-local state. Those files therefore cannot live in Git
 * — and must not be forced in. But they still have to survive a branch switch and
 * converge across machines, which is what this provides: an AgentBootup-owned root
 * keyed by `brain_id` (and by an explicit `branch_id` only for genuinely branched
 * brains), projected into whatever checkout is active.
 *
 * Switching Git branches becomes irrelevant to ignored state, because ignored state
 * was never in Git to begin with.
 *
 * WHERE this root physically lives (server-side namespace vs. a local
 * AgentBootup-owned path synced through the existing transport) is PRD-0059 OQ3 and
 * is deliberately NOT decided here. The store is an interface; `createLocalStore`
 * is one implementation. Fencing, conflict detection, tombstones, and replay are
 * all independent of that choice, which is why this slice did not need to wait on
 * the answer.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { assertContainedRelativePath } from '../util/contained-path.js';
import { createSecretGuard, isAllowedExtension } from './secret-guard.js';
import { readFileOrAbsent, readJsonFile } from '../util/read-file.js';

export const STATE_ROOT_VERSION = 'brain-canonical-state/1';

/**
 * Roots whose contents are ignored-by-Git mutable state that SHOULD converge.
 *
 * `.brain/` is deliberately absent, and this is the load-bearing distinction here:
 * **ignored-by-Git is not the same as shared-across-machines.**
 *
 * The work order lists `.brain/` among the ignored paths, and it is — but `.brain/`
 * holds per-machine state: `source-descriptor.json`, whose `source_root` is a path
 * on *this* machine, plus share state, locks, and PID files. Converging it would
 * push one machine's descriptor onto another and point that machine at a path it
 * does not have — recreating the exact source ambiguity this work order exists to
 * remove. A replicated lock file is worse still.
 *
 * The rule: state describing the BRAIN converges (`memory`, `.ai`). State
 * describing THIS MACHINE's relationship to the brain does not. A test asserts
 * `.brain/` never enters the canonical root, so this stays a decision rather than
 * decaying into an oversight.
 */
export const IGNORED_STATE_ROOTS = Object.freeze(['memory', '.ai']);

/** Ignored and mutable, but deliberately NOT converged. Named so it is not "missing". */
export const PER_MACHINE_STATE_ROOTS = Object.freeze(['.brain']);

export const STATE_CONFLICTS = Object.freeze({
  STALE_WRITER: 'stale_writer',
  LEASE_HELD: 'lease_held_by_other_machine',
  REVISION_MISMATCH: 'revision_mismatch',
});

const LEASE_FILE = 'lease.json';
const INDEX_FILE = 'index.json';
const DEFAULT_LEASE_MS = 60_000;

export class StateRootError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'StateRootError';
    this.reason = reason;
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Shared three-way read, surfaced as this module's error type. */
function readStateJson(filePath, label) {
  const read = readJsonFile(filePath);
  if (read.state === 'invalid') throw new StateRootError('STATE_CORRUPT', `${label}: ${read.detail}`);
  return read;
}

function readStateBlob(filePath, label) {
  try {
    return readFileOrAbsent(filePath, { encoding: null });
  } catch (err) {
    throw new StateRootError('STATE_READ_FAILED', `${label}: ${err?.code ?? 'unknown'}`);
  }
}

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort(compareCodeUnits);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * The state key. `branch_id` participates ONLY when explicitly set — an unbranched
 * brain has one state, and silently keying by Git branch is the whole defect.
 */
export function stateKey(brainId, branchId = null) {
  const brain = assertContainedRelativePath(brainId, 'brain_id');
  if (branchId == null) return brain;
  return `${brain}/${assertContainedRelativePath(branchId, 'branch_id')}`;
}

/**
 * A local filesystem store. One implementation of the store interface; the OQ3
 * decision picks which implementation the daemon binds to, not what it must do.
 */
export function createLocalStore(rootDir) {
  const root = path.resolve(rootDir); // nosemgrep: path-join-resolve-traversal -- key segments come from stateKey(), each routed through assertContainedRelativePath

  const keyDir = (key) => path.join(root, ...key.split('/')); // nosemgrep: path-join-resolve-traversal -- key segments come from stateKey(), which routes each through assertContainedRelativePath

  return {
    describe: () => ({ kind: 'local', root }),
    readIndex(key) {
      const read = readStateJson(path.join(keyDir(key), INDEX_FILE), 'index'); // nosemgrep: path-join-resolve-traversal -- keyDir output; INDEX_FILE is a literal
      // ONLY a genuinely absent index is an empty store. A malformed or unreadable
      // one must never read as revision 0 — that would let a writer publish against
      // an empty base and discard every prior entry and tombstone.
      if (read.state === 'absent') return { version: STATE_ROOT_VERSION, revision: 0, entries: {}, tombstones: {} };
      return read.value;
    },
    writeIndex(key, index) {
      const dir = keyDir(key);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.${INDEX_FILE}.${process.pid}.${index.revision}.tmp`); // nosemgrep: path-join-resolve-traversal -- keyDir output; the temp name is built from literals and integers
      fs.writeFileSync(tmp, `${canonicalJson(index)}\n`);
      fs.renameSync(tmp, path.join(dir, INDEX_FILE)); // nosemgrep: path-join-resolve-traversal -- keyDir output; INDEX_FILE is a literal
    },
    readBlob(key, digest) {
      const read = readStateBlob(path.join(keyDir(key), 'blobs', digest), 'blob'); // nosemgrep: path-join-resolve-traversal -- keyDir output; digest is a validated content hash used as a filename
      return read.absent ? null : read.body;
    },
    writeBlob(key, digest, body) {
      const dir = path.join(keyDir(key), 'blobs'); // nosemgrep: path-join-resolve-traversal -- keyDir output; "blobs" is a literal
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, digest); // nosemgrep: path-join-resolve-traversal -- blob dir plus a content-hash filename
      if (fs.existsSync(target)) return;
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, target);
    },
    readLease(key) {
      const read = readStateJson(path.join(keyDir(key), LEASE_FILE), 'lease'); // nosemgrep: path-join-resolve-traversal -- keyDir output; LEASE_FILE is a literal
      // An unreadable lease is NOT an absent lease. Treating it as absent would
      // hand a second machine the fence while the first still believes it holds it.
      if (read.state === 'absent') return null;
      return read.value;
    },
    writeLease(key, lease) {
      const dir = keyDir(key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, LEASE_FILE), `${canonicalJson(lease)}\n`); // nosemgrep: path-join-resolve-traversal -- keyDir output; LEASE_FILE is a literal
    },
    clearLease(key) {
      try {
        fs.unlinkSync(path.join(keyDir(key), LEASE_FILE)); // nosemgrep: path-join-resolve-traversal -- keyDir output; LEASE_FILE is a literal
      } catch {
        // Already released.
      }
    },
  };
}

/**
 * Acquire the single-writer lease.
 *
 * Fencing, not mutual exclusion for its own sake: without it two machines writing
 * one unbranched brain silently last-writer-win, which is the failure this whole
 * work order exists to stop. A stale writer must converge before it can publish.
 *
 * `now` is injected rather than read from the clock so expiry is testable and so
 * this never depends on two machines agreeing about wall time.
 */
export function acquireLease(store, key, machineId, { now, ttlMs = DEFAULT_LEASE_MS } = {}) {
  if (typeof now !== 'number') throw new StateRootError('LEASE_CLOCK_REQUIRED');
  const existing = store.readLease(key);
  if (existing && existing.machine_id !== machineId && existing.expires_at > now) {
    throw new StateRootError(STATE_CONFLICTS.LEASE_HELD, `${existing.machine_id} until ${existing.expires_at}`);
  }
  // A fencing token that only ever increases, so a resumed writer holding an old
  // lease cannot pass itself off as current.
  const fencingToken = (existing?.fencing_token ?? 0) + 1;
  const lease = { machine_id: machineId, expires_at: now + ttlMs, fencing_token: fencingToken };
  store.writeLease(key, lease);
  return lease;
}

export function releaseLease(store, key, machineId) {
  const existing = store.readLease(key);
  if (existing && existing.machine_id !== machineId) {
    throw new StateRootError(STATE_CONFLICTS.LEASE_HELD, existing.machine_id);
  }
  store.clearLease(key);
}

/**
 * Collect ignored mutable state from a checkout.
 *
 * Secret exclusion runs here, at the point of collection, so a secret cannot enter
 * the canonical root at all — filtering on the way out would leave it at rest in a
 * store that then syncs between machines.
 */
export function collectIgnoredState(projectRoot, { roots = IGNORED_STATE_ROOTS, warnOnSkip = true } = {}) {
  const root = path.resolve(projectRoot); // nosemgrep: path-join-resolve-traversal -- dir is already contained; entry.name comes from readdir and cannot contain a separator
  const guard = createSecretGuard(root, { honorGitignore: false, honorGitignoreNegations: false, warn: warnOnSkip });
  const collected = {};

  const walk = (dir, relBase) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // A partial policy/state capture is indistinguishable from an approved
      // deletion. Refuse instead of silently omitting an unreadable subtree.
      throw new StateRootError('STATE_ROOT_READ_FAILED', relBase);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name); // nosemgrep: path-join-resolve-traversal -- relRoot is from the IGNORED_STATE_ROOTS allowlist
      const rel = `${relBase}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        if (guard.shouldSkip(full)) continue;
        if (!isAllowedExtension(full)) continue;
        collected[assertContainedRelativePath(rel, 'state path')] = fs.readFileSync(full);
      }
    }
  };

  for (const relRoot of roots) {
    const abs = path.join(root, relRoot); // nosemgrep: path-join-resolve-traversal -- relRoot is from the IGNORED_STATE_ROOTS allowlist
    let rootStat;
    try {
      rootStat = fs.lstatSync(abs);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    // lstat, not stat: a symlinked allowed root would otherwise make external
    // content look lexically project-contained to the later walk and guard.
    if (rootStat.isSymbolicLink()) throw new StateRootError('STATE_ROOT_SYMLINK_DENIED', relRoot);
    if (!rootStat.isDirectory()) throw new StateRootError('STATE_ROOT_NOT_DIRECTORY', relRoot);
    walk(abs, relRoot);
  }
  return collected;
}

/**
 * Publish local ignored state into the canonical root.
 *
 * Fails closed when the caller's `baseRevision` is not the store's current
 * revision: a stale machine must converge before it can publish, rather than
 * overwriting whatever it did not see.
 */
export function publishState(store, key, { machineId, contents, baseRevision, deletions = [], lease }) {
  const index = store.readIndex(key);
  if (baseRevision !== index.revision) {
    throw new StateRootError(STATE_CONFLICTS.STALE_WRITER, `base ${baseRevision} != current ${index.revision}`);
  }
  const held = store.readLease(key);
  if (!held || held.machine_id !== machineId || held.fencing_token !== lease?.fencing_token) {
    throw new StateRootError(STATE_CONFLICTS.LEASE_HELD, held?.machine_id ?? 'none');
  }

  const entries = { ...index.entries };
  const tombstones = { ...index.tombstones };

  for (const [relPath, body] of Object.entries(contents)) {
    const canonical = assertContainedRelativePath(relPath, 'state path');
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const digest = sha256(buf);
    store.writeBlob(key, digest, buf);
    entries[canonical] = { sha256: digest, bytes: buf.length, machine_id: machineId };
    delete tombstones[canonical];
  }

  for (const relPath of deletions) {
    const canonical = assertContainedRelativePath(relPath, 'state path');
    delete entries[canonical];
    // A tombstone, not a silent absence: a machine that reappears offline with the
    // file still present must learn it was deleted rather than resurrect it.
    tombstones[canonical] = { deleted_by: machineId, revision: index.revision + 1 };
  }

  const next = { version: STATE_ROOT_VERSION, revision: index.revision + 1, entries, tombstones };
  store.writeIndex(key, next);
  return next;
}

/**
 * Project canonical state into a checkout, preserving the ignore contract.
 *
 * Never runs `git add -f`, and never runs git at all — the files it writes are
 * ignored by design, and the entire point is that they reach the working tree
 * without entering version control.
 */
export function materializeState(store, key, projectRoot, { applyTombstones = true } = {}) {
  const root = path.resolve(projectRoot); // nosemgrep: path-join-resolve-traversal -- canonical is contained by assertContainedRelativePath; root is the caller project root
  const index = store.readIndex(key);
  const written = [];
  const removed = [];

  for (const [relPath, entry] of Object.entries(index.entries)) {
    const canonical = assertContainedRelativePath(relPath, 'state path');
    const body = store.readBlob(key, entry.sha256);
    if (body == null) throw new StateRootError('STATE_BLOB_MISSING', canonical);
    if (sha256(body) !== entry.sha256) throw new StateRootError('STATE_BLOB_CORRUPT', canonical);
    const destination = path.join(root, canonical); // nosemgrep: path-join-resolve-traversal -- canonical is contained by assertContainedRelativePath and root is the caller's project root
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, body);
    written.push(canonical);
  }

  if (applyTombstones) {
    for (const relPath of Object.keys(index.tombstones)) {
      const canonical = assertContainedRelativePath(relPath, 'state path');
      const destination = path.join(root, canonical); // nosemgrep: path-join-resolve-traversal -- canonical is contained by assertContainedRelativePath and root is the caller's project root
      if (fs.existsSync(destination)) {
        fs.rmSync(destination);
        removed.push(canonical);
      }
    }
  }

  return { revision: index.revision, written: written.sort(compareCodeUnits), removed: removed.sort(compareCodeUnits) };
}

/**
 * Roll back to a previously captured index. The blobs are content-addressed and
 * never deleted by publish, so an older index is directly replayable.
 */
export function rollbackState(store, key, previousIndex, { machineId, lease }) {
  const held = store.readLease(key);
  if (!held || held.machine_id !== machineId || held.fencing_token !== lease?.fencing_token) {
    throw new StateRootError(STATE_CONFLICTS.LEASE_HELD, held?.machine_id ?? 'none');
  }
  const current = store.readIndex(key);
  const restored = { ...previousIndex, revision: current.revision + 1 };
  store.writeIndex(key, restored);
  return restored;
}

/**
 * An offline replay queue entry. Recorded when publish fails for reasons that a
 * later attempt could succeed at, so work performed offline is not lost.
 */
export function queueReplay(queue, { key, contents, deletions = [], baseRevision, machineId }) {
  return [...queue, { key, contents, deletions, base_revision: baseRevision, machine_id: machineId }];
}

/**
 * Drain the replay queue against the current store state.
 *
 * Each entry is re-based onto the store's current revision before retrying, which
 * is what makes replay converge instead of failing forever on a stale base — but
 * an entry whose file was tombstoned by another machine meanwhile is dropped
 * rather than resurrected.
 */
export function drainReplay(store, queue, { machineId, lease }) {
  const remaining = [];
  const applied = [];
  for (const item of queue) {
    const index = store.readIndex(item.key);
    const live = Object.fromEntries(
      Object.entries(item.contents).filter(([relPath]) => !index.tombstones[relPath]),
    );
    if (Object.keys(live).length === 0 && item.deletions.length === 0) continue;
    try {
      publishState(store, item.key, {
        machineId,
        contents: live,
        deletions: item.deletions,
        baseRevision: index.revision,
        lease,
      });
      applied.push(item);
    } catch (err) {
      if (err instanceof StateRootError && err.reason === STATE_CONFLICTS.LEASE_HELD) {
        remaining.push(item);
        continue;
      }
      remaining.push(item);
    }
  }
  return { applied, remaining };
}
