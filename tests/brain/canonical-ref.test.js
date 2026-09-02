import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import {
  CanonicalRefError,
  REF_SOURCES,
  assertUsableSourceRoot,
  describeCanonicalRef,
  describeCheckedOutRef,
  isGitWorkTree,
  isWorkTreeDirty,
  resolveCanonicalRef,
} from '../../lib/brain/canonical-ref.js';

/**
 * Real git, no network, no hosted provider — a bare repo on a filesystem path is
 * the provider-neutral case the work order requires (WO test 8).
 */
function git(args, cwd) {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (proc.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr}`);
  return (proc.stdout || '').trim();
}

function makeRepoWithFileRemote() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-ref-'));
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'work');

  git(['init', '--bare', '--initial-branch=trunk', bare], base);
  git(['init', '--initial-branch=trunk', work], base);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['config', 'user.name', 'Test'], work);
  fs.writeFileSync(path.join(work, 'file.txt'), 'hello');
  git(['add', '.'], work);
  git(['commit', '-m', 'initial'], work);
  // A plain filesystem remote — no URL to parse, no provider to ask.
  git(['remote', 'add', 'origin', bare], work);
  git(['push', '-u', 'origin', 'trunk'], work);
  git(['remote', 'set-head', 'origin', '--auto'], work);
  return { base, work, bare };
}

function reason(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof CanonicalRefError, `expected CanonicalRefError, got ${err}`);
    return err.reason;
  }
}

test('an explicit declaration wins over repository state', () => {
  const { base, work } = makeRepoWithFileRemote();
  const resolved = resolveCanonicalRef(work, { declaredRef: 'refs/heads/release' });
  assert.deepEqual(resolved, { ref: 'refs/heads/release', source: REF_SOURCES.DECLARED });
  // Declaration beats the remote's own default — an operator's decision is not
  // overridable by repository state.
  assert.notEqual(resolveCanonicalRef(work, {}).ref, resolved.ref);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the remote default branch resolves with no network and no provider API', () => {
  const { base, work } = makeRepoWithFileRemote();
  // The remote is a bare repo on a filesystem path, and its default branch is not
  // `main` — so a passing result cannot come from an assumption.
  const resolved = resolveCanonicalRef(work, {});
  assert.deepEqual(resolved, { ref: 'refs/heads/trunk', source: REF_SOURCES.REMOTE_HEAD });
  fs.rmSync(base, { recursive: true, force: true });
});

test('an unresolvable ref fails closed and never assumes main', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-noremote-'));
  const work = path.join(base, 'work');
  git(['init', '--initial-branch=feature-x', work], base);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['config', 'user.name', 'Test'], work);
  fs.writeFileSync(path.join(work, 'f.txt'), 'x');
  git(['add', '.'], work);
  git(['commit', '-m', 'c'], work);

  // No remote, so nothing to fall back to. The checked-out branch is `feature-x`
  // and must NOT be used — that is the defect being eliminated.
  assert.equal(reason(() => resolveCanonicalRef(work, {})), 'CANONICAL_REF_UNRESOLVED');
  assert.equal(describeCheckedOutRef(work).ref, 'refs/heads/feature-x');

  const described = describeCanonicalRef(work, {});
  assert.equal(described.resolved, false);
  assert.equal(described.ref, null);
  assert.equal(described.reason, 'CANONICAL_REF_UNRESOLVED');
  fs.rmSync(base, { recursive: true, force: true });
});

test('a malformed declared ref is rejected rather than passed through', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-badref-'));
  // Form is checked before the filesystem: a malformed declaration is a
  // declaration error whatever the root turns out to be.
  for (const bad of ['main', 'refs/heads/../evil', '', 'refs/heads/x y']) {
    assert.equal(reason(() => resolveCanonicalRef(base, { declaredRef: bad })), 'DECLARED_REF_INVALID', bad);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('a declared ref does not excuse a non-repository root', () => {
  // A well-formed declaration on a plain directory would otherwise let a
  // misdeclared `git` source look valid — the exact ambiguity being removed.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-declared-nogit-'));
  assert.equal(reason(() => resolveCanonicalRef(base, { declaredRef: 'refs/heads/main' })), 'NOT_A_GIT_WORK_TREE');
  fs.rmSync(base, { recursive: true, force: true });
});

test('a non-repository is named as such, not silently unresolved', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-nogit-'));
  assert.equal(isGitWorkTree(base), false);
  assert.equal(reason(() => resolveCanonicalRef(base, {})), 'NOT_A_GIT_WORK_TREE');
  fs.rmSync(base, { recursive: true, force: true });
});

test('dirty work trees are detected for the fail-closed write path', () => {
  const { base, work } = makeRepoWithFileRemote();
  assert.equal(isWorkTreeDirty(work), false);
  fs.writeFileSync(path.join(work, 'file.txt'), 'changed');
  assert.equal(isWorkTreeDirty(work), true);
  // Unknown must be distinguishable from clean: a caller has to treat it as unsafe.
  assert.equal(isWorkTreeDirty(path.join(base, 'does-not-exist')), null);
  fs.rmSync(base, { recursive: true, force: true });
});

test('source roots are validated with the same posture as runtime roots', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-root-'));
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  assert.equal(assertUsableSourceRoot(real), real);

  assert.equal(reason(() => assertUsableSourceRoot(path.join(base, 'missing'))), 'SOURCE_ROOT_MISSING');

  const file = path.join(base, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.equal(reason(() => assertUsableSourceRoot(file)), 'SOURCE_ROOT_NOT_DIRECTORY');

  const link = path.join(base, 'a-link');
  fs.symlinkSync(real, link);
  assert.equal(reason(() => assertUsableSourceRoot(link)), 'SOURCE_ROOT_SYMLINK_DENIED');

  const dangling = path.join(base, 'dangling');
  fs.symlinkSync(path.join(base, 'nowhere'), dangling);
  assert.equal(reason(() => assertUsableSourceRoot(dangling)), 'SOURCE_ROOT_SYMLINK_DENIED');
  fs.rmSync(base, { recursive: true, force: true });
});

test('resolution never consults the checked-out branch', () => {
  const { base, work } = makeRepoWithFileRemote();
  git(['checkout', '-b', 'feature-y'], work);
  // Canonical stays `trunk` even though `feature-y` is checked out.
  assert.equal(resolveCanonicalRef(work, {}).ref, 'refs/heads/trunk');
  assert.equal(describeCheckedOutRef(work).ref, 'refs/heads/feature-y');
  fs.rmSync(base, { recursive: true, force: true });
});
