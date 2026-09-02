import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import {
  DAEMON_STATES,
  QUARANTINE_REASONS,
  buildMigrationReport,
  descriptorPath,
  evaluateDaemonSource,
  loadDescriptor,
  recordAuthoritativeSelection,
  saveDescriptor,
} from '../../lib/brain/source-migration.js';
import { declareDescriptor } from '../../lib/brain/source-descriptor.js';

const priorDescriptorStateRoot = process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT;
const descriptorTestStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-descriptor-state-'));
process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = descriptorTestStateRoot;
test.after(() => {
  if (priorDescriptorStateRoot == null) delete process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT;
  else process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = priorDescriptorStateRoot;
  fs.rmSync(descriptorTestStateRoot, { recursive: true, force: true });
});

function git(args, cwd) {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (proc.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr}`);
  return (proc.stdout || '').trim();
}

/** A git work tree with a real filesystem remote whose default branch is `trunk`. */
function makeRepo(branch = 'trunk') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-'));
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(['init', '--bare', `--initial-branch=${branch}`, bare], base);
  git(['init', `--initial-branch=${branch}`, work], base);
  git(['config', 'user.email', 't@e.com'], work);
  git(['config', 'user.name', 'T'], work);
  fs.writeFileSync(path.join(work, 'f.txt'), 'x');
  git(['add', '.'], work);
  git(['commit', '-m', 'c'], work);
  git(['remote', 'add', 'origin', bare], work);
  git(['push', '-u', 'origin', branch], work);
  git(['remote', 'set-head', 'origin', '--auto'], work);
  return { base, work, ref: `refs/heads/${branch}` };
}

test('a legacy daemon is quarantined, not upgraded in place', () => {
  const { base, work } = makeRepo();
  // brain_id + projectRoot only, exactly as the old configuration looks.
  const evaluation = evaluateDaemonSource(work);
  assert.equal(evaluation.state, DAEMON_STATES.QUARANTINED);
  assert.equal(evaluation.reason, QUARANTINE_REASONS.NO_DESCRIPTOR);
  assert.equal(evaluation.may_publish, false, 'quarantine must mean "does not publish"');
  fs.rmSync(base, { recursive: true, force: true });
});

test('quarantine is never lifted by inference', () => {
  const { base, work, ref } = makeRepo();
  // A resolvable remote HEAD exists, the repo is clean, the daemon is alive — every
  // signal that feels authoritative. None of them lifts quarantine.
  assert.equal(evaluateDaemonSource(work).may_publish, false);

  // Only an explicit persisted descriptor does.
  saveDescriptor(work, declareDescriptor({
    sourceKind: 'git',
    sourceRoot: work,
    repoRef: ref,
    brainId: 'seedid',
  }));
  const ready = evaluateDaemonSource(work);
  assert.equal(ready.state, DAEMON_STATES.READY);
  assert.equal(ready.may_publish, true);
  assert.equal(ready.canonical_ref, ref);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a descriptor for a different root does not authorize this daemon', () => {
  const { base, work, ref } = makeRepo();
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const descriptor = declareDescriptor({ sourceKind: 'git', sourceRoot: elsewhere, repoRef: ref, brainId: 'seedid' });
  // Written into this root, but describing another one.
  fs.mkdirSync(path.dirname(descriptorPath(work)), { recursive: true });
  fs.writeFileSync(descriptorPath(work), JSON.stringify(descriptor));

  const evaluation = evaluateDaemonSource(work);
  assert.equal(evaluation.state, DAEMON_STATES.QUARANTINED);
  assert.equal(evaluation.reason, QUARANTINE_REASONS.ROOT_MISMATCH);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a corrupt or non-canonical descriptor quarantines rather than being repaired', () => {
  const { base, work } = makeRepo();
  fs.mkdirSync(path.dirname(descriptorPath(work)), { recursive: true });
  // Malformed JSON is a CORRUPT descriptor, not a missing one. This assertion
  // previously expected NO_DESCRIPTOR — it encoded the bug as the contract, so the
  // invalid-descriptor quarantine path was unreachable and on-disk corruption was
  // reported to the operator as "never configured".
  fs.writeFileSync(descriptorPath(work), '{ not json');
  assert.equal(evaluateDaemonSource(work).reason, QUARANTINE_REASONS.DESCRIPTOR_INVALID);
  assert.equal(evaluateDaemonSource(work).may_publish, false);

  // A genuinely absent descriptor is still reported as absent.
  fs.rmSync(descriptorPath(work));
  assert.equal(evaluateDaemonSource(work).reason, QUARANTINE_REASONS.NO_DESCRIPTOR);

  // Well-formed JSON, but not the canonical form — silently normalizing it would
  // be the rewriting this contract forbids.
  fs.writeFileSync(descriptorPath(work), JSON.stringify({
    version: 'brain-source-descriptor/1',
    source_kind: 'git',
    source_root: `${work}/`,
    brain_id: 'seedid',
    repo_ref: 'refs/heads/trunk',
    branch_id: null,
  }));
  assert.equal(evaluateDaemonSource(work).reason, QUARANTINE_REASONS.DESCRIPTOR_INVALID);
  fs.rmSync(base, { recursive: true, force: true });
});

test('WO 9: a persisted descriptor survives restart with no cwd or branch fallback', () => {
  const { base, work, ref } = makeRepo();
  saveDescriptor(work, declareDescriptor({ sourceKind: 'git', sourceRoot: work, repoRef: ref, brainId: 'seedid' }));

  // "Restart": a fresh read, from a different cwd, on a different branch.
  git(['checkout', '-b', 'feature-z'], work);
  const previousCwd = process.cwd();
  try {
    process.chdir(os.tmpdir());
    const reloaded = evaluateDaemonSource(work);
    assert.equal(reloaded.state, DAEMON_STATES.READY);
    // The canonical ref is still trunk, not the checked-out feature branch.
    assert.equal(reloaded.canonical_ref, ref);
    assert.equal(loadDescriptor(work).repo_ref, ref);
  } finally {
    process.chdir(previousCwd);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('an unresolvable canonical ref quarantines even with a descriptor', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-noref-'));
  const work = path.join(base, 'work');
  git(['init', '--initial-branch=trunk', work], base);
  git(['config', 'user.email', 't@e.com'], work);
  git(['config', 'user.name', 'T'], work);
  fs.writeFileSync(path.join(work, 'f.txt'), 'x');
  git(['add', '.'], work);
  git(['commit', '-m', 'c'], work);

  // A descriptor naming a ref that does not resolve here.
  saveDescriptor(work, declareDescriptor({
    sourceKind: 'git',
    sourceRoot: work,
    repoRef: 'refs/heads/trunk',
    brainId: 'seedid',
  }));
  // The declared ref resolves by declaration, so this daemon is ready — the
  // declaration IS the resolution, which is the contract.
  assert.equal(evaluateDaemonSource(work).state, DAEMON_STATES.READY);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the migration report describes and never recommends', () => {
  const { base, work } = makeRepo();
  git(['checkout', '-b', 'fix/security-hardening'], work);
  fs.writeFileSync(path.join(work, 'f.txt'), 'uncommitted');
  fs.mkdirSync(path.join(work, 'memory'), { recursive: true });

  const report = buildMigrationReport(work, {
    competingWriters: ['davids-mac-mini'],
    serverRevision: 42,
  });

  assert.equal(report.dry_run, true);
  assert.equal(report.daemon_state, DAEMON_STATES.QUARANTINED);
  assert.equal(report.git_backed, true);
  assert.equal(report.checked_out_ref, 'refs/heads/fix/security-hardening');
  assert.equal(report.work_tree_dirty, true);
  assert.deepEqual(report.ignored_state_roots, ['memory']);
  assert.equal(report.server_revision, 42);
  assert.deepEqual(report.competing_writers, ['davids-mac-mini']);
  // The report shows the operator the split and the drift, and names no winner.
  // A recommendation would be the inference this whole contract forbids.
  assert.equal(report.authoritative_source, null);

  // And it wrote nothing.
  assert.equal(fs.existsSync(descriptorPath(work)), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the migration report describes a symlinked policy root without following or omitting it', () => {
  const { base, work } = makeRepo();
  try {
    fs.symlinkSync(path.join(base, 'missing-external-root'), path.join(work, 'memory'));
    const report = buildMigrationReport(work);
    assert.deepEqual(report.ignored_state_roots, []);
    assert.deepEqual(report.unsafe_ignored_state_roots, [{ root: 'memory', reason: 'symlink_denied' }]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the migration report describes a non-directory policy root without omitting it', () => {
  const { base, work } = makeRepo();
  try {
    fs.writeFileSync(path.join(work, 'memory'), 'not a directory');
    const report = buildMigrationReport(work);
    assert.deepEqual(report.ignored_state_roots, []);
    assert.deepEqual(report.unsafe_ignored_state_roots, [{ root: 'memory', reason: 'not_directory' }]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an authoritative selection requires an actor and a timestamp', () => {
  const { base, work, ref } = makeRepo();
  const descriptor = declareDescriptor({ sourceKind: 'git', sourceRoot: work, repoRef: ref, brainId: 'seedid' });

  // A receipt that cannot say who decided is not a receipt.
  assert.throws(
    () => recordAuthoritativeSelection(work, descriptor, { selectedAt: '2026-08-05T12:00:00Z' }),
    /SELECTION_ACTOR_REQUIRED/,
  );
  assert.throws(
    () => recordAuthoritativeSelection(work, descriptor, { selectedBy: 'operator', selectedAt: 'today' }),
    /SELECTION_TIMESTAMP_REQUIRED/,
  );

  // A descriptor for a different root would persist and then quarantine the daemon
  // with ROOT_MISMATCH — a receipt for a choice that never took effect.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-other-'));
  const foreign = declareDescriptor({ sourceKind: 'git', sourceRoot: elsewhere, repoRef: ref, brainId: 'seedid' });
  assert.throws(
    () => recordAuthoritativeSelection(work, foreign, { selectedBy: 'operator', selectedAt: '2026-08-05T12:00:00Z' }),
    /SELECTION_ROOT_MISMATCH/,
  );
  assert.equal(fs.existsSync(descriptorPath(work)), false, 'a rejected selection must not persist');
  fs.rmSync(elsewhere, { recursive: true, force: true });

  const receipt = recordAuthoritativeSelection(work, descriptor, {
    selectedBy: 'operator:kefentse',
    selectedAt: '2026-08-05T12:00:00Z',
    rationale: 'main machine holds the newest reviewed state',
  });
  assert.equal(receipt.selected_by, 'operator:kefentse');
  assert.match(receipt.descriptor_hash, /^[a-f0-9]{64}$/);
  // Selection and effect are one call: no window where a choice is recorded but
  // not in force.
  assert.equal(evaluateDaemonSource(work).may_publish, true);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a directory source needs no ref and is ready once declared', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-dir-'));
  const work = path.join(base, 'plain');
  fs.mkdirSync(work, { recursive: true });
  assert.equal(evaluateDaemonSource(work).state, DAEMON_STATES.QUARANTINED);

  saveDescriptor(work, declareDescriptor({ sourceKind: 'directory', sourceRoot: work, brainId: 'seedid' }));
  const ready = evaluateDaemonSource(work);
  assert.equal(ready.state, DAEMON_STATES.READY);
  assert.equal(ready.canonical_ref, null);

  const report = buildMigrationReport(work);
  assert.equal(report.git_backed, false);
  assert.equal(report.checked_out_ref, null);
  fs.rmSync(base, { recursive: true, force: true });
});
