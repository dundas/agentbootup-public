import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import {
  REFUSALS,
  WRITE_POLICIES,
  planCanonicalWrite,
  writeToCanonicalRef,
} from '../../lib/brain/canonical-write.js';

function git(args, cwd) {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (proc.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr}`);
  return (proc.stdout || '').trim();
}

/** A work tree with a real upstream on a filesystem path — no network, no provider. */
function makeRepo({ branch = 'trunk' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-write-'));
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(['init', '--bare', `--initial-branch=${branch}`, bare], base);
  git(['init', `--initial-branch=${branch}`, work], base);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['config', 'user.name', 'Test'], work);
  fs.writeFileSync(path.join(work, 'seed.txt'), 'seed');
  git(['add', '.'], work);
  git(['commit', '-m', 'seed'], work);
  git(['remote', 'add', 'origin', bare], work);
  git(['push', '-u', 'origin', branch], work);
  return { base, work, bare, ref: `refs/heads/${branch}` };
}

test('a write policy is required and never guessed', () => {
  const { base, work, ref } = makeRepo();
  for (const policy of [undefined, null, 'whatever']) {
    const result = writeToCanonicalRef({ root: work, canonicalRef: ref, contents: { 'a.txt': 'x' }, policy });
    assert.equal(result.refused, true);
    assert.equal(result.reason, REFUSALS.POLICY_REQUIRED);
    // Even a refusal produces a receipt — that is what makes it actionable.
    assert.equal(result.receipt.refused, true);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('the canonical ref checked out writes in place', () => {
  const { base, work, ref } = makeRepo();
  const result = writeToCanonicalRef({
    root: work,
    canonicalRef: ref,
    contents: { 'assets/a.txt': 'hello' },
    policy: WRITE_POLICIES.COMMIT,
    message: 'test write',
  });
  assert.equal(result.refused, false);
  assert.equal(result.written, true);
  assert.equal(result.plan.route, 'in_place');
  assert.equal(fs.readFileSync(path.join(work, 'assets/a.txt'), 'utf8'), 'hello');
  // The receipt carries before/after commits and content hashes, not a boolean.
  assert.notEqual(result.receipt.before_commit, result.receipt.after_commit);
  assert.match(result.receipt.content_hashes['assets/a.txt'], /^[a-f0-9]{64}$/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a feature checkout routes through an isolated worktree, never the feature branch', () => {
  const { base, work, ref } = makeRepo();
  git(['checkout', '-b', 'feature-x'], work);
  const featureHeadBefore = git(['rev-parse', 'HEAD'], work);

  const result = writeToCanonicalRef({
    root: work,
    canonicalRef: ref,
    contents: { 'assets/b.txt': 'from-canonical' },
    policy: WRITE_POLICIES.COMMIT,
    worktreeRoot: path.join(base, 'isolated'),
  });

  assert.equal(result.refused, false);
  assert.equal(result.plan.route, 'isolated_worktree');
  // The feature branch is untouched — this is the whole point of the work order.
  assert.equal(git(['rev-parse', 'HEAD'], work), featureHeadBefore);
  assert.equal(fs.existsSync(path.join(work, 'assets/b.txt')), false);
  // The canonical ref advanced, and the content is on it.
  assert.equal(git(['show', `${ref}:assets/b.txt`], work), 'from-canonical');
  // The isolated worktree is cleaned up; a leak becomes the next ambiguous source.
  assert.equal(fs.existsSync(path.join(base, 'isolated')), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('dirty overlap fails closed without stash, reset, or data loss', () => {
  const { base, work, ref } = makeRepo();
  fs.mkdirSync(path.join(work, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(work, 'assets/c.txt'), 'operator edit');
  git(['add', '.'], work);
  git(['commit', '-m', 'add c'], work);
  git(['push'], work);
  // Uncommitted operator work on the very file we intend to write.
  fs.writeFileSync(path.join(work, 'assets/c.txt'), 'UNSAVED OPERATOR WORK');

  const result = writeToCanonicalRef({
    root: work,
    canonicalRef: ref,
    contents: { 'assets/c.txt': 'daemon content' },
    policy: WRITE_POLICIES.COMMIT,
  });

  assert.equal(result.refused, true);
  assert.equal(result.reason, REFUSALS.DIRTY_OVERLAP);
  // The operator's uncommitted work is exactly as they left it.
  assert.equal(fs.readFileSync(path.join(work, 'assets/c.txt'), 'utf8'), 'UNSAVED OPERATOR WORK');
  assert.deepEqual(result.receipt.dirty_overlap, ['assets/c.txt']);
  fs.rmSync(base, { recursive: true, force: true });
});

test('an unrelated dirty file is a normal working state, not a conflict', () => {
  const { base, work, ref } = makeRepo();
  fs.writeFileSync(path.join(work, 'seed.txt'), 'unrelated edit');
  const plan = planCanonicalWrite(work, ref, ['assets/d.txt']);
  assert.equal(plan.ok, true, 'dirtiness elsewhere must not block a disjoint write');
  fs.rmSync(base, { recursive: true, force: true });
});

test('an unpublished local canonical commit fails closed', () => {
  const { base, work, ref } = makeRepo();
  fs.writeFileSync(path.join(work, 'local.txt'), 'local only');
  git(['add', '.'], work);
  git(['commit', '-m', 'local only'], work);
  // Committed but never pushed: building fleet truth on this risks losing it.
  const result = writeToCanonicalRef({
    root: work,
    canonicalRef: ref,
    contents: { 'assets/e.txt': 'x' },
    policy: WRITE_POLICIES.COMMIT,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, REFUSALS.UNPUBLISHED_CANONICAL);
  fs.rmSync(base, { recursive: true, force: true });
});

test('an unknown upstream is a refusal, not an assumption of safety', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-noupstream-'));
  const work = path.join(base, 'work');
  git(['init', '--initial-branch=trunk', work], base);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['config', 'user.name', 'Test'], work);
  fs.writeFileSync(path.join(work, 'f.txt'), 'x');
  git(['add', '.'], work);
  git(['commit', '-m', 'c'], work);

  const plan = planCanonicalWrite(work, 'refs/heads/trunk', ['assets/f.txt']);
  assert.equal(plan.refused, true);
  assert.equal(plan.reason, REFUSALS.UNKNOWN_UPSTREAM);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a missing canonical ref is named, not silently created', () => {
  const { base, work } = makeRepo();
  const plan = planCanonicalWrite(work, 'refs/heads/does-not-exist', ['assets/g.txt']);
  assert.equal(plan.refused, true);
  assert.equal(plan.reason, REFUSALS.CANONICAL_REF_MISSING);
  fs.rmSync(base, { recursive: true, force: true });
});

test('dry run reports the route and changes nothing', () => {
  const { base, work, ref } = makeRepo();
  const before = git(['rev-parse', 'HEAD'], work);
  const result = writeToCanonicalRef({
    root: work,
    canonicalRef: ref,
    contents: { 'assets/h.txt': 'x' },
    policy: WRITE_POLICIES.DRY_RUN,
  });
  assert.equal(result.written, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.plan.route, 'in_place');
  assert.equal(git(['rev-parse', 'HEAD'], work), before);
  assert.equal(fs.existsSync(path.join(work, 'assets/h.txt')), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the propose policy never advances the canonical ref, even when it is checked out', () => {
  // The route that was previously uncovered: canonical ref checked out, so the
  // in-place path applied and committed straight onto the canonical branch.
  const { base, work, ref } = makeRepo();
  const canonicalBefore = git(['rev-parse', ref], work);
  assert.equal(git(['symbolic-ref', 'HEAD'], work), ref, 'canonical ref must be the checked-out one here');

  const result = writeToCanonicalRef({
    root: work,
    canonicalRef: ref,
    contents: { 'assets/in-place-propose.txt': 'proposed' },
    policy: WRITE_POLICIES.PROPOSE,
    worktreeRoot: path.join(base, 'isolated-inplace-propose'),
  });

  assert.equal(result.refused, false);
  assert.equal(git(['rev-parse', ref], work), canonicalBefore, 'canonical ref must not move under propose');
  assert.match(result.branch, /^agentbootup\/proposed-/);
  assert.equal(git(['show', `refs/heads/${result.branch}:assets/in-place-propose.txt`], work), 'proposed');
  // The working tree is untouched too — a proposal is not a local edit.
  assert.equal(fs.existsSync(path.join(work, 'assets/in-place-propose.txt')), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the propose policy never advances the canonical ref', () => {
  const { base, work, ref } = makeRepo();
  git(['checkout', '-b', 'feature-y'], work);
  const canonicalBefore = git(['rev-parse', ref], work);

  const result = writeToCanonicalRef({
    root: work,
    canonicalRef: ref,
    contents: { 'assets/i.txt': 'proposed' },
    policy: WRITE_POLICIES.PROPOSE,
    worktreeRoot: path.join(base, 'isolated-propose'),
  });

  assert.equal(result.refused, false);
  assert.equal(git(['rev-parse', ref], work), canonicalBefore, 'canonical ref must not move under propose');
  assert.match(result.branch, /^agentbootup\/proposed-/);
  assert.equal(git(['show', `refs/heads/${result.branch}:assets/i.txt`], work), 'proposed');
  fs.rmSync(base, { recursive: true, force: true });
});

test('two different proposals from one base do not overwrite each other', () => {
  const { base, work, ref } = makeRepo();
  const first = writeToCanonicalRef({
    root: work, canonicalRef: ref, contents: { 'assets/p.txt': 'proposal one' },
    policy: WRITE_POLICIES.PROPOSE, worktreeRoot: path.join(base, 'wt1'),
  });
  const second = writeToCanonicalRef({
    root: work, canonicalRef: ref, contents: { 'assets/p.txt': 'proposal two' },
    policy: WRITE_POLICIES.PROPOSE, worktreeRoot: path.join(base, 'wt2'),
  });

  assert.equal(first.refused, false);
  assert.equal(second.refused, false);
  // Same base commit, different content — naming by base alone reused one ref and
  // the second proposal silently destroyed the first.
  assert.notEqual(first.branch, second.branch);
  assert.equal(git(['show', `refs/heads/${first.branch}:assets/p.txt`], work), 'proposal one');
  assert.equal(git(['show', `refs/heads/${second.branch}:assets/p.txt`], work), 'proposal two');

  // An identical re-proposal is idempotent rather than a duplicate or a refusal.
  const repeat = writeToCanonicalRef({
    root: work, canonicalRef: ref, contents: { 'assets/p.txt': 'proposal one' },
    policy: WRITE_POLICIES.PROPOSE, worktreeRoot: path.join(base, 'wt3'),
  });
  assert.equal(repeat.refused, false);
  assert.equal(repeat.branch, first.branch);
  fs.rmSync(base, { recursive: true, force: true });
});

test('writing identical content is not a commit', () => {
  const { base, work, ref } = makeRepo();
  writeToCanonicalRef({ root: work, canonicalRef: ref, contents: { 'assets/j.txt': 'same' }, policy: WRITE_POLICIES.COMMIT });
  git(['push'], work);
  const after = git(['rev-parse', 'HEAD'], work);
  const second = writeToCanonicalRef({ root: work, canonicalRef: ref, contents: { 'assets/j.txt': 'same' }, policy: WRITE_POLICIES.COMMIT });
  assert.equal(second.written, false);
  assert.equal(second.refused, false);
  assert.equal(git(['rev-parse', 'HEAD'], work), after);
  fs.rmSync(base, { recursive: true, force: true });
});

test('canonical writes work from a LINKED worktree, where .git is a file', () => {
  // The default worktree location used to be `<root>/.git/...`, which cannot exist
  // when `.git` is a file — breaking exactly the multi-checkout workflow this
  // feature serves. No explicit worktreeRoot is passed, so the default is on trial.
  const { base, work, ref } = makeRepo();
  git(['checkout', '-b', 'feature-w'], work);
  const linked = path.join(base, 'linked');
  git(['worktree', 'add', '--detach', linked, ref], work);
  assert.ok(fs.statSync(path.join(linked, '.git')).isFile(), 'linked worktree keeps .git as a FILE');

  const result = writeToCanonicalRef({
    root: linked,
    canonicalRef: ref,
    contents: { 'assets/from-linked.txt': 'written from a linked worktree' },
    policy: WRITE_POLICIES.COMMIT,
  });

  assert.equal(result.refused, false, `expected success, got ${result.reason}`);
  assert.equal(git(['show', `${ref}:assets/from-linked.txt`], work), 'written from a linked worktree');
  fs.rmSync(base, { recursive: true, force: true });
});

test('write targets are containment-checked', () => {
  const { base, work, ref } = makeRepo();
  for (const bad of ['../escape.txt', '/etc/passwd', 'a/../../b.txt']) {
    assert.throws(() => planCanonicalWrite(work, ref, [bad]), /repo-relative path/);
  }
  fs.rmSync(base, { recursive: true, force: true });
});
