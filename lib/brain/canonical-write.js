/**
 * Canonical-ref write routing (PRD-0059 FR-4/FR-5/FR-6).
 *
 * The rule this enforces: an AgentBootup-managed Git-tracked artifact is written
 * against the canonical ref, never against whatever branch happens to be checked
 * out. If the canonical ref IS checked out, write in place. If it is not, write
 * through an isolated AgentBootup-owned worktree based on the canonical ref. The
 * only durable copy must never be left on a feature branch.
 *
 * Every hazard fails closed and returns a reason. Nothing here stashes, resets,
 * force-pushes, or picks a winner — a conflicting state is a human's decision, and
 * silently resolving it is precisely how a machine's local mess becomes fleet
 * truth.
 *
 * The publish policy (commit on the canonical branch vs. open a change for review)
 * is a REQUIRED caller-supplied value with no default. The work order says
 * "according to explicit operator policy" and names no default; inventing one here
 * would be the same class of guess as assuming `main`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'node:child_process';
import { assertContainedRelativePath } from '../util/contained-path.js';
import { resolveWorktreeParent } from '../util/git-dir.js';

/** What the caller wants done with the canonical-branch result. No default. */
export const WRITE_POLICIES = Object.freeze({
  /** Commit directly onto the canonical ref. */
  COMMIT: 'commit_on_canonical',
  /** Stage the work on a branch for human review; never advance the canonical ref. */
  PROPOSE: 'propose_change',
  /** Compute and report only. Writes nothing. */
  DRY_RUN: 'dry_run',
});

const VALID_POLICIES = new Set(Object.values(WRITE_POLICIES));

/** Every refusal reason. Each is a fail-closed outcome, not an error condition. */
export const REFUSALS = Object.freeze({
  DIRTY_OVERLAP: 'dirty_overlap',
  NOT_FAST_FORWARD: 'not_fast_forward',
  MERGE_CONFLICT: 'merge_conflict',
  UNKNOWN_UPSTREAM: 'unknown_upstream',
  UNPUBLISHED_CANONICAL: 'unpublished_local_canonical_commit',
  CANONICAL_REF_MISSING: 'canonical_ref_missing',
  WORKTREE_UNAVAILABLE: 'worktree_unavailable',
  POLICY_REQUIRED: 'write_policy_required',
});

const GIT_TIMEOUT_MS = 30_000;

export class CanonicalWriteError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'CanonicalWriteError';
    this.reason = reason;
  }
}

/**
 * @param {{ raw?: boolean }} [options] — `raw` keeps stdout byte-exact.
 *
 * Trimming is the default because most plumbing output is a single token, but it
 * is WRONG for `--porcelain`, whose first two columns are status codes and are
 * frequently a leading space. Trimming there shifted every path left by one and
 * `slice(3)` then produced a plausible-looking wrong path — `assets/c.txt` read as
 * `ssets/c.txt` — so a dirty-overlap check silently matched nothing. A corruption
 * that yields a valid-looking value is worse than one that throws.
 */
function git(args, cwd, options = {}) {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_CONFIG_GLOBAL: undefined },
  });
  const stdout = proc.stdout || '';
  return {
    ok: proc.status === 0,
    stdout: options.raw ? stdout : stdout.trim(),
    stderr: (proc.stderr || '').trim(),
  };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Deterministic digest input: sorted path -> content hash. */
function canonicalContentJson(contents) {
  const entries = Object.keys(contents)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => [key, sha256(Buffer.from(contents[key]))]);
  return JSON.stringify(entries);
}

function shortRefName(ref) {
  return ref.replace(/^refs\/heads\//, '');
}

/** The commit the canonical ref currently points at, or null when it does not exist. */
function canonicalCommit(root, ref) {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root);
  return result.ok && result.stdout ? result.stdout : null;
}

/**
 * Is the canonical local ref published to its upstream?
 *
 * A local canonical commit that exists nowhere else is a fail-closed condition:
 * writing on top of it would build the fleet's truth on a commit that could be
 * lost with one machine. Unknown upstream is also a refusal — not knowing is not
 * the same as being fine, and treating it as fine is how this class of bug ships.
 */
function upstreamState(root, ref) {
  const branch = shortRefName(ref);
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], root);
  if (!upstream.ok || !upstream.stdout) return { known: false };
  const counts = git(['rev-list', '--left-right', '--count', `${upstream.stdout}...${branch}`], root);
  if (!counts.ok) return { known: false };
  const [behind, ahead] = counts.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10));
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) return { known: false };
  return { known: true, upstream: upstream.stdout, behind, ahead };
}

/** Files with uncommitted changes, as canonical repo-relative paths. */
function dirtyPaths(root) {
  // `raw`: porcelain status codes occupy the first two columns and are often a
  // leading space. See the note on git().
  const status = git(['status', '--porcelain=v1', '-z'], root, { raw: true });
  if (!status.ok) return null;
  const paths = [];
  for (const record of status.stdout.split('\0')) {
    if (!record) continue;
    // `XY path`, except that a rename emits a second NUL-separated record holding
    // the source path with no status prefix. Both sides of a rename count as
    // dirty for overlap purposes, so the bare form is kept rather than skipped.
    const hasStatusPrefix = record.length > 3 && record[2] === ' ';
    const candidate = hasStatusPrefix ? record.slice(3) : record;
    if (!candidate) continue;
    try {
      paths.push(assertContainedRelativePath(candidate, 'dirty path'));
    } catch {
      // A path git reports that we cannot contain is itself a refusal signal.
      return null;
    }
  }
  return paths;
}

function refusal(reason, detail, extra = {}) {
  return { written: false, refused: true, reason, detail: detail ?? null, ...extra };
}

/**
 * Plan a canonical-ref write. Pure inspection — it never mutates the repository,
 * so the migration/dry-run path and the real write path reach the same verdict
 * through the same code rather than through two implementations that can drift.
 *
 * @param {string} root — the declared source root (a Git work tree)
 * @param {string} canonicalRef — e.g. `refs/heads/main`
 * @param {string[]} targetPaths — repo-relative paths the caller intends to write
 * @returns {{ ok: boolean, route?: 'in_place'|'isolated_worktree', ... }}
 */
export function planCanonicalWrite(root, canonicalRef, targetPaths) {
  const targets = targetPaths.map((value) => assertContainedRelativePath(value, 'write target'));

  const commit = canonicalCommit(root, canonicalRef);
  if (!commit) return refusal(REFUSALS.CANONICAL_REF_MISSING, canonicalRef);

  const upstream = upstreamState(root, canonicalRef);
  if (!upstream.known) return refusal(REFUSALS.UNKNOWN_UPSTREAM, canonicalRef);
  if (upstream.ahead > 0) {
    return refusal(REFUSALS.UNPUBLISHED_CANONICAL, `${canonicalRef} is ${upstream.ahead} commit(s) ahead of ${upstream.upstream}`);
  }

  const head = git(['symbolic-ref', '--quiet', 'HEAD'], root);
  const checkedOut = head.ok && head.stdout ? head.stdout : null;
  const canonicalCheckedOut = checkedOut === canonicalRef;

  const dirty = dirtyPaths(root);
  if (dirty === null) return refusal(REFUSALS.DIRTY_OVERLAP, 'work tree state could not be determined');

  // Overlap is what matters, not dirtiness as such: an unrelated dirty file is a
  // normal working state, while a dirty file we are about to write is a conflict
  // whose resolution belongs to a human.
  const targetSet = new Set(targets);
  const overlap = dirty.filter((candidate) => targetSet.has(candidate));
  if (canonicalCheckedOut && overlap.length > 0) {
    return refusal(REFUSALS.DIRTY_OVERLAP, overlap.join(', '), { overlap });
  }

  return {
    ok: true,
    refused: false,
    route: canonicalCheckedOut ? 'in_place' : 'isolated_worktree',
    canonical_ref: canonicalRef,
    canonical_commit: commit,
    checked_out_ref: checkedOut,
    upstream: upstream.upstream,
    targets,
  };
}

/**
 * A receipt records what was decided and what changed (FR-6). It is produced for
 * refusals too: "we refused, here is the state we saw" is the evidence that makes
 * a refusal actionable instead of merely obstructive.
 */
export function buildWriteReceipt({ root, plan, policy, beforeCommit, afterCommit, contents }) {
  return {
    source_root: root,
    canonical_ref: plan.canonical_ref ?? null,
    route: plan.route ?? null,
    policy,
    checked_out_ref: plan.checked_out_ref ?? null,
    upstream: plan.upstream ?? null,
    before_commit: beforeCommit ?? null,
    after_commit: afterCommit ?? null,
    dirty_overlap: plan.overlap ?? [],
    refused: Boolean(plan.refused),
    refusal_reason: plan.reason ?? null,
    content_hashes: Object.fromEntries(
      Object.entries(contents ?? {}).map(([relPath, body]) => [relPath, sha256(Buffer.from(body))]),
    ),
  };
}

/**
 * Create an isolated AgentBootup-owned worktree at `canonicalRef`.
 *
 * Deliberately checks out a detached copy of the ref rather than the branch: two
 * concurrent operations must not fight over one branch checkout, and a detached
 * worktree cannot leave a half-finished branch behind if the process dies.
 */
/**
 * Where an isolated worktree goes when the caller does not say.
 *
 * NOT `<root>/.git/...`: in a linked worktree `.git` is a FILE, so that path cannot
 * be created and canonical writes would fail for exactly the multi-checkout
 * workflow this feature exists to serve. Git is asked where its metadata lives.
 */
function defaultWorktreeRoot(root) {
  const parent = resolveWorktreeParent(root);
  if (parent) return path.join(parent, 'agentbootup-canonical-write'); // nosemgrep: path-join-resolve-traversal -- parent comes from git's own metadata location; the leaf is a literal
  return path.join(os.tmpdir(), `agentbootup-canonical-write-${sha256(Buffer.from(root)).slice(0, 12)}`); // nosemgrep: path-join-resolve-traversal -- tmpdir plus a hashed literal
}

export function withIsolatedWorktree(root, canonicalRef, worktreeRoot, fn) {
  const created = git(['worktree', 'add', '--detach', worktreeRoot, canonicalRef], root);
  if (!created.ok) throw new CanonicalWriteError(REFUSALS.WORKTREE_UNAVAILABLE, created.stderr);
  try {
    return fn(worktreeRoot);
  } finally {
    // Always removed, including on throw: a leaked worktree becomes the next
    // machine's ambiguous source.
    git(['worktree', 'remove', '--force', worktreeRoot], root);
    git(['worktree', 'prune'], root);
  }
}

/**
 * Execute a canonical-ref write.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {string} options.canonicalRef
 * @param {Record<string,string>} options.contents — repo-relative path -> file body
 * @param {string} options.policy — a WRITE_POLICIES value. REQUIRED, no default.
 * @param {string} [options.message] — commit message when the policy commits
 * @param {string} [options.worktreeRoot] — where to place an isolated worktree
 */
export function writeToCanonicalRef({ root, canonicalRef, contents, policy, message, worktreeRoot }) {
  // No default policy. The work order says "according to explicit operator
  // policy" and names none; choosing one here would be the same guess as `main`.
  if (!VALID_POLICIES.has(policy)) {
    const plan = refusal(REFUSALS.POLICY_REQUIRED, `policy must be one of: ${[...VALID_POLICIES].join(', ')}`);
    return { ...plan, receipt: buildWriteReceipt({ root, plan, policy: policy ?? null, contents }) };
  }

  const targets = Object.keys(contents);
  const plan = planCanonicalWrite(root, canonicalRef, targets);
  if (!plan.ok) {
    return { ...plan, receipt: buildWriteReceipt({ root, plan, policy, contents }) };
  }

  const beforeCommit = plan.canonical_commit;
  if (policy === WRITE_POLICIES.DRY_RUN) {
    return {
      written: false,
      refused: false,
      dry_run: true,
      plan,
      receipt: buildWriteReceipt({ root, plan, policy, beforeCommit, afterCommit: beforeCommit, contents }),
    };
  }

  const apply = (workDir) => {
    for (const [relPath, body] of Object.entries(contents)) {
      const canonical = assertContainedRelativePath(relPath, 'write target');
      const destination = path.join(workDir, canonical); // nosemgrep: path-join-resolve-traversal -- canonical is contained by assertContainedRelativePath and workDir is an AgentBootup-owned root
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, body);
    }
    const added = git(['add', '--', ...Object.keys(contents)], workDir);
    if (!added.ok) throw new CanonicalWriteError(REFUSALS.MERGE_CONFLICT, added.stderr);

    const staged = git(['diff', '--cached', '--name-only'], workDir);
    if (staged.ok && !staged.stdout) {
      // Nothing changed. Not a failure, and emphatically not a commit.
      return { changed: false, commit: beforeCommit };
    }

    // A proposal ref is named by base commit AND content digest. Naming it by base
    // alone meant two different proposals from the same base reused one ref and the
    // second silently destroyed the first. With content in the name, identical
    // proposals are idempotent and different ones cannot collide.
    const contentDigest = sha256(Buffer.from(canonicalContentJson(contents)));
    const branch = policy === WRITE_POLICIES.COMMIT
      ? shortRefName(canonicalRef)
      : `agentbootup/proposed-${beforeCommit.slice(0, 12)}-${contentDigest.slice(0, 12)}`;

    if (policy === WRITE_POLICIES.PROPOSE) {
      // Even so, refuse to move an existing proposal ref to a different commit.
      const existing = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], root);
      if (existing.ok && existing.stdout) {
        const existingTree = git(['rev-parse', `refs/heads/${branch}^{tree}`], root);
        const stagedTree = git(['write-tree'], workDir);
        if (!existingTree.ok || !stagedTree.ok || existingTree.stdout !== stagedTree.stdout) {
          throw new CanonicalWriteError(REFUSALS.NOT_FAST_FORWARD, `proposal ref ${branch} already exists`);
        }
        return { changed: false, commit: existing.stdout, branch };
      }
    }

    if (plan.route === 'isolated_worktree' || policy === WRITE_POLICIES.PROPOSE) {
      // Detached worktree, or a proposal: commit onto an explicit branch ref so
      // the canonical ref is only ever advanced when the policy says to.
      const committed = git(['commit', '-m', message || 'chore(brain): canonical asset write'], workDir);
      if (!committed.ok) throw new CanonicalWriteError(REFUSALS.MERGE_CONFLICT, committed.stderr);
      const newCommit = git(['rev-parse', 'HEAD'], workDir);
      if (!newCommit.ok) throw new CanonicalWriteError(REFUSALS.MERGE_CONFLICT, newCommit.stderr);

      // Fast-forward only. A canonical ref that moved under us is a refusal, never
      // a force.
      const update = git(['update-ref', `refs/heads/${branch}`, newCommit.stdout, ...(policy === WRITE_POLICIES.COMMIT ? [beforeCommit] : [])], root);
      if (!update.ok) throw new CanonicalWriteError(REFUSALS.NOT_FAST_FORWARD, update.stderr);
      return { changed: true, commit: newCommit.stdout, branch };
    }

    const committed = git(['commit', '-m', message || 'chore(brain): canonical asset write'], workDir);
    if (!committed.ok) throw new CanonicalWriteError(REFUSALS.MERGE_CONFLICT, committed.stderr);
    const newCommit = git(['rev-parse', 'HEAD'], workDir);
    return { changed: true, commit: newCommit.stdout, branch };
  };

  // PROPOSE always goes through an isolated worktree, even when the canonical ref
  // IS checked out. Committing in place would advance the canonical ref, which is
  // the one thing this policy promises never to do — and the promise held only for
  // a feature checkout, because that was the only route the test covered.
  const effectiveRoute = policy === WRITE_POLICIES.PROPOSE ? 'isolated_worktree' : plan.route;

  try {
    const result = effectiveRoute === 'in_place'
      ? apply(root)
      // nosemgrep: path-join-resolve-traversal -- root is the operator-declared source root and the remaining segments are literals; the default worktree location is AgentBootup-owned
      : withIsolatedWorktree(root, canonicalRef, worktreeRoot ?? defaultWorktreeRoot(root), apply);

    return {
      written: result.changed,
      refused: false,
      plan,
      branch: result.branch ?? null,
      receipt: buildWriteReceipt({ root, plan, policy, beforeCommit, afterCommit: result.commit, contents }),
    };
  } catch (err) {
    const reason = err instanceof CanonicalWriteError ? err.reason : REFUSALS.MERGE_CONFLICT;
    const failed = refusal(reason, err.message, { route: plan.route, canonical_ref: canonicalRef });
    return { ...failed, receipt: buildWriteReceipt({ root, plan: { ...plan, ...failed }, policy, beforeCommit, contents }) };
  }
}
