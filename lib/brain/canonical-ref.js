/**
 * Provider-neutral canonical-ref resolution (PRD-0059 FR-2).
 *
 * Resolution order is a precedence, not a search: an explicit persisted
 * declaration wins, then a generic local Git remote default-branch symref, then
 * nothing. "Nothing" is a refusal, not a fallback — this module never assumes
 * `main`, because assuming it is how a feature checkout quietly becomes the source
 * of truth for a fleet.
 *
 * Everything here uses ordinary Git plumbing that works against GitHub, GitLab,
 * a bare repo on a filesystem path, or no remote at all. There is deliberately no
 * hosted-provider API call and no remote-URL parsing: a URL tells you who hosts a
 * repository, not which ref an operator considers canonical.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';

/** Where a resolved ref came from. Callers surface this; it is evidence, not decoration. */
export const REF_SOURCES = Object.freeze({
  DECLARED: 'declared_config',
  REMOTE_HEAD: 'remote_head_symref',
  UNRESOLVED: 'unresolved',
});

const REF_RE = /^refs\/[A-Za-z0-9._\-/]+$/;
const GIT_TIMEOUT_MS = 10_000;

export class CanonicalRefError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'CanonicalRefError';
    this.reason = reason;
  }
}

function isValidRef(value) {
  return typeof value === 'string' && REF_RE.test(value) && !value.includes('..');
}

/**
 * Run git with an explicit cwd and no shell. Returns null on any failure — callers
 * decide what an absent answer means, because "git failed" and "git said no" are
 * different facts and only the caller knows which one is fatal.
 */
function git(args, cwd, runner = defaultGitRunner) {
  try {
    return runner(args, cwd);
  } catch {
    return null;
  }
}

function defaultGitRunner(args, cwd) {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    // No shell, and an explicitly minimal environment: a canonical-source decision
    // must not be steerable through GIT_DIR or friends inherited from a daemon.
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_CONFIG_GLOBAL: undefined },
  });
  if (proc.status !== 0) return null;
  return (proc.stdout || '').trim();
}

/**
 * Is this a Git working tree at all? A `directory` source must never reach here,
 * and a `git` source that is not actually a repository is a declaration error.
 */
export function isGitWorkTree(root, runner) {
  return git(['rev-parse', '--is-inside-work-tree'], root, runner) === 'true';
}

/**
 * The generic remote default branch, via the symbolic ref Git itself maintains.
 * Works for any provider and for a bare repo on a local filesystem path. Returns
 * null when the remote has no recorded HEAD — which is common and not an error.
 */
function remoteDefaultRef(root, remote, runner) {
  // `refs/remotes/<remote>/HEAD` -> `refs/remotes/<remote>/<branch>`
  const symref = git(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], root, runner);
  if (!symref) return null;
  const prefix = `refs/remotes/${remote}/`;
  if (!symref.startsWith(prefix)) return null;
  const branch = symref.slice(prefix.length);
  if (!branch || branch === 'HEAD') return null;
  const ref = `refs/heads/${branch}`;
  return isValidRef(ref) ? ref : null;
}

/**
 * Resolve the canonical ref for a Git source.
 *
 * @param {string} root — the source root (an existing Git work tree)
 * @param {{ declaredRef?: string|null, remote?: string, runner?: Function }} [options]
 * @returns {{ ref: string, source: string }}
 * @throws {CanonicalRefError} when nothing resolves — never a silent default.
 */
export function resolveCanonicalRef(root, options = {}) {
  const { declaredRef = null, remote = 'origin', runner } = options;

  // Form before filesystem: a malformed declared ref is a declaration error and
  // should say so, whatever the root turns out to be.
  if (declaredRef != null && !isValidRef(declaredRef)) {
    throw new CanonicalRefError('DECLARED_REF_INVALID', String(declaredRef));
  }

  // Every path through this function requires a real work tree — including the
  // declared one. Returning a declared ref for a plain directory would let a
  // misdeclared `git` source look valid, which is the ambiguity being removed.
  if (!isGitWorkTree(root, runner)) throw new CanonicalRefError('NOT_A_GIT_WORK_TREE', root);

  // 1. An explicit persisted declaration wins over repository state, so a
  //    repository's remote can never override an operator's decision.
  if (declaredRef != null) return { ref: declaredRef, source: REF_SOURCES.DECLARED };

  // 2. The generic remote default-branch symref — no provider API, no URL parsing.
  const fromRemote = remoteDefaultRef(root, remote, runner);
  if (fromRemote) return { ref: fromRemote, source: REF_SOURCES.REMOTE_HEAD };

  // 3. Refuse. The currently checked-out branch is deliberately NOT consulted:
  //    using it is the exact defect this work order exists to eliminate.
  throw new CanonicalRefError(
    'CANONICAL_REF_UNRESOLVED',
    `no declared ref and no ${remote}/HEAD symref; declare one explicitly`,
  );
}

/**
 * Report-only resolution for the migration/dry-run path (FR-10): never throws,
 * always says what it found and what it could not.
 */
export function describeCanonicalRef(root, options = {}) {
  try {
    const resolved = resolveCanonicalRef(root, options);
    return { ...resolved, resolved: true, reason: null };
  } catch (err) {
    return {
      ref: null,
      source: REF_SOURCES.UNRESOLVED,
      resolved: false,
      reason: err instanceof CanonicalRefError ? err.reason : 'UNKNOWN',
    };
  }
}

/**
 * The ref currently checked out. Diagnostic ONLY — reported to an operator so they
 * can see the drift, never used to choose a canonical ref. Kept in this module,
 * next to the refusal it must not become, rather than somewhere a caller might
 * mistake it for an answer.
 */
export function describeCheckedOutRef(root, runner) {
  const symref = git(['symbolic-ref', '--quiet', 'HEAD'], root, runner);
  if (symref && isValidRef(symref)) return { ref: symref, detached: false };
  const head = git(['rev-parse', 'HEAD'], root, runner);
  return { ref: null, detached: true, commit: head || null };
}

/** True when the work tree has uncommitted changes — a fail-closed input for FR-5. */
export function isWorkTreeDirty(root, runner) {
  const status = git(['status', '--porcelain'], root, runner);
  if (status === null) return null; // unknown, which callers must treat as unsafe
  return status.length > 0;
}

/**
 * A source root must be a real directory that is not a symlink, mirroring the
 * containment posture of `resolveRootState` in the runtime manifest.
 */
export function assertUsableSourceRoot(root) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    throw new CanonicalRefError('SOURCE_ROOT_MISSING', root);
  }
  if (stat.isSymbolicLink()) throw new CanonicalRefError('SOURCE_ROOT_SYMLINK_DENIED', root);
  if (!stat.isDirectory()) throw new CanonicalRefError('SOURCE_ROOT_NOT_DIRECTORY', root);
  // `root` is an operator-declared absolute source_root that has passed the
  // descriptor's containment checks and was just lstat-verified as a real,
  // non-symlink directory. Nothing is joined onto it; this only normalizes the
  // caller's own declaration.
  return path.resolve(root); // nosemgrep: path-join-resolve-traversal -- lstat-verified operator-declared absolute root; no untrusted segment is joined
}
