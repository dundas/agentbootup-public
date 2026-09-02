import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { declareDescriptor } from '../lib/brain/source-descriptor.js';
import { saveDescriptor } from '../lib/brain/source-migration.js';
import { buildMachineAddPlan, runMachineCommand } from '../lib/network/commands/machine-add.js';
import { PER_MACHINE_STATE_ROOTS } from '../lib/brain/canonical-state-root.js';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-add-'));
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(['init', '--bare', '--initial-branch=trunk', bare], base);
  git(['init', '--initial-branch=trunk', work], base);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['config', 'user.name', 'Test'], work);
  fs.writeFileSync(path.join(work, 'tracked.txt'), 'tracked');
  git(['add', '.'], work);
  git(['commit', '-m', 'initial'], work);
  git(['remote', 'add', 'origin', bare], work);
  git(['push', '-u', 'origin', 'trunk'], work);
  saveDescriptor(work, declareDescriptor({
    sourceKind: 'git', sourceRoot: work, repoRef: 'refs/heads/trunk', brainId: 'seedid',
  }));
  fs.mkdirSync(path.join(work, 'memory'));
  fs.mkdirSync(path.join(work, '.ai'));
  return { base, work };
}

function makeDirectorySource({ branchId = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-add-directory-'));
  fs.mkdirSync(path.join(root, 'memory'));
  saveDescriptor(root, declareDescriptor({ sourceKind: 'directory', sourceRoot: root, brainId: 'directory-brain', branchId }));
  return root;
}

function io() {
  const out = [];
  const err = [];
  return { out, err, value: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) } };
}

test('machine add dry-run reports only canonical, non-secret, fenced planned work', async () => {
  const { base, work } = makeRepo();
  const identityFile = path.join(base, 'machine-id');
  const previousIdentityFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = identityFile;
  try {
    const before = git(['status', '--porcelain=v1'], work);
    const plan = await buildMachineAddPlan({ sourceRoot: work, target: 'seedid-mini', remote: 'ssh://seedid-mini' }, {
      readMachineIdState: async () => ({ state: 'absent', id: null }),
    });

    assert.equal(plan.dry_run, true);
    assert.equal(plan.canonical_code.ref, 'refs/heads/trunk');
    assert.equal(plan.canonical_code.checked_out_ref, 'refs/heads/trunk');
    assert.deepEqual(plan.selected_assets.ignored_state_roots, ['memory', '.ai']);
    assert.equal(plan.selected_assets.secrets.included, false);
    assert.deepEqual(plan.selected_assets.excluded_per_machine_roots, PER_MACHINE_STATE_ROOTS);
    assert.equal(plan.target.disposition, 'declared_unverified');
    assert.equal(plan.target.identity.state, 'unverified');
    assert.equal(plan.remote.capability, 'declared_unverified');
    assert.equal(plan.writer_fence.required, true);
    assert.equal(plan.writer_fence.state_key, 'seedid');
    assert.equal(plan.policy.approval_required, true);
    assert.equal(plan.daemon.disposition, 'stopped_pending_canary');
    assert.ok(plan.actions.length >= 7);
    assert.ok(plan.actions.every((action) => action.mutates === false));
    assert.ok(plan.actions.every((action) => /^[a-z0-9_]+$/.test(action.disposition)));
    assert.equal(git(['status', '--porcelain=v1'], work), before, 'a plan must not write source state');
    assert.equal(fs.existsSync(identityFile), false, 'a plan must not mint a source machine identity');
  } finally {
    if (previousIdentityFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = previousIdentityFile;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('machine add proposes an exact, non-secret policy inventory without following symlinks', async () => {
  const { base, work } = makeRepo();
  const outside = path.join(base, 'outside.txt');
  const originalWarn = console.warn;
  const warnings = [];
  try {
    fs.writeFileSync(path.join(work, 'memory', 'durable.md'), 'durable memory');
    fs.writeFileSync(path.join(work, '.ai', 'protocol.md'), 'safe protocol');
    fs.writeFileSync(path.join(work, 'memory', '.env'), 'TOKEN=must-not-appear');
    fs.writeFileSync(outside, 'outside content');
    fs.symlinkSync(outside, path.join(work, 'memory', 'outside-link'));

    console.warn = (...args) => warnings.push(args.join(' '));
    const plan = await buildMachineAddPlan({ sourceRoot: work, target: 'seedid-mini' });
    const proposal = plan.policy.proposal;
    assert.equal(proposal.version, 'machine-asset-policy-proposal/1');
    assert.equal(proposal.state, 'proposed_unapproved');
    assert.deepEqual(proposal.included.files.map((file) => file.path), ['.ai/protocol.md', 'memory/durable.md']);
    assert.equal(proposal.included.file_count, 2);
    assert.equal(proposal.included.total_bytes, Buffer.byteLength('safe protocol') + Buffer.byteLength('durable memory'));
    assert.match(proposal.included.inventory_sha256, /^[a-f0-9]{64}$/);
    assert.equal(proposal.approval.binds_inventory_sha256, proposal.included.inventory_sha256);
    assert.deepEqual(proposal.exclusions.per_machine_roots.roots, PER_MACHINE_STATE_ROOTS);
    assert.equal(proposal.exclusions.secret_or_denied_paths.disposition, 'excluded_before_plan_output');
    assert.equal(proposal.exclusions.secret_or_denied_paths.count, 1);
    assert.equal(proposal.exclusions.symlink_paths.count, 1);
    assert.equal(proposal.exclusions.non_regular_paths.count, 0);
    const serialized = JSON.stringify(plan);
    assert.doesNotMatch(serialized, /must-not-appear|outside content|outside-link|memory\/.env/i);
    assert.deepEqual(warnings, [], 'policy reports must not disclose excluded filenames through diagnostics');
  } finally {
    console.warn = originalWarn;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('machine add refuses a symlinked policy root before external files enter its proposal', async () => {
  const { base, work } = makeRepo();
  const outside = path.join(base, 'outside-memory');
  try {
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'private.md'), 'must never be inventoried');
    fs.rmSync(path.join(work, 'memory'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(work, 'memory'));
    await assert.rejects(
      () => buildMachineAddPlan({ sourceRoot: work, target: 'seedid-mini' }),
      /policy root is unsafe/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('machine add refuses a dangling symlinked policy root instead of silently omitting it', async () => {
  const { base, work } = makeRepo();
  try {
    fs.rmSync(path.join(work, 'memory'), { recursive: true, force: true });
    fs.symlinkSync(path.join(base, 'missing-external-root'), path.join(work, 'memory'));
    await assert.rejects(
      () => buildMachineAddPlan({ sourceRoot: work, target: 'seedid-mini' }),
      /policy root is unsafe/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('machine add refuses a non-directory policy root instead of silently omitting it', async () => {
  const { base, work } = makeRepo();
  try {
    fs.rmSync(path.join(work, 'memory'), { recursive: true, force: true });
    fs.writeFileSync(path.join(work, 'memory'), 'not a directory');
    await assert.rejects(
      () => buildMachineAddPlan({ sourceRoot: work, target: 'seedid-mini' }),
      /policy root is unsafe: memory \(not_directory\)/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('machine add exposes dirty feature checkout as non-authoritative without selecting it', async () => {
  const { base, work } = makeRepo();
  try {
    git(['checkout', '-b', 'feature-local'], work);
    fs.writeFileSync(path.join(work, 'tracked.txt'), 'operator work');
    const plan = await buildMachineAddPlan({ sourceRoot: work, target: 'seedid-mini' });
    assert.equal(plan.canonical_code.ref, 'refs/heads/trunk');
    assert.equal(plan.canonical_code.checked_out_ref, 'refs/heads/feature-local');
    assert.equal(plan.canonical_code.work_tree_dirty, true);
    assert.equal(plan.canonical_code.checkout_disposition, 'not_selected_as_authority');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('machine add refuses modes that could mutate, mint identity, or start a daemon', async () => {
  const run = io();
  const code = await runMachineCommand(['add', '--source-root', '/tmp/source', '--target', 'mini'], run.value);
  assert.equal(code, 2);
  assert.match(run.err.join('\n'), /only supports --dry-run/i);
});

test('machine add dry-run rejects an absent source descriptor rather than inferring authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-add-no-descriptor-'));
  try {
    await assert.rejects(
      () => buildMachineAddPlan({ sourceRoot: root, target: 'seedid-mini' }),
      /source descriptor/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('machine add refuses credential-bearing remote declarations without echoing their secret values', async () => {
  const root = makeDirectorySource();
  try {
    for (const remote of [
      'ssh://operator:password@seedid-mini',
      'https://seedid-mini?access_token=super-secret',
      'https://seedid-mini?jwt=jwt-secret',
      'https://seedid-mini?key=key-secret',
      'https://seedid-mini?session=session-secret',
      'https://seedid-mini#fragment-secret',
      'seedid-mini#alias-fragment-secret',
      'operator@seedid-mini',
      'ssh:operator:opaque-at-secret@seedid-mini',
    ]) {
      await assert.rejects(async () => {
        try {
          await buildMachineAddPlan({ sourceRoot: root, target: 'seedid-mini', remote });
        } catch (error) {
          assert.doesNotMatch(error.message, /password|super-secret|jwt-secret|key-secret|session-secret|fragment-secret|alias-fragment-secret|opaque-at-secret/i);
          throw error;
        }
      }, /remote must not contain/i);
      const run = io();
      assert.equal(await runMachineCommand(['add', '--dry-run', '--source-root', root, '--target', 'seedid-mini', '--remote', remote], run.value), 1);
      assert.equal(run.out.length, 0, 'refused remotes must not emit a plan');
      assert.doesNotMatch(run.err.join('\n'), /password|super-secret|jwt-secret|key-secret|session-secret|fragment-secret|alias-fragment-secret|opaque-at-secret/i);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('machine add refuses a symlink source root before descriptor or Git inspection', async () => {
  const root = makeDirectorySource();
  const link = `${root}-link`;
  fs.symlinkSync(root, link);
  try {
    await assert.rejects(
      () => buildMachineAddPlan({ sourceRoot: link, target: 'seedid-mini' }),
      /SOURCE_ROOT_SYMLINK_DENIED/,
    );
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('machine add supports an explicitly declared non-Git directory source', async () => {
  const root = makeDirectorySource();
  try {
    const plan = await buildMachineAddPlan({ sourceRoot: root, target: 'seedid-mini' });
    assert.equal(plan.canonical_code.kind, 'directory');
    assert.equal(plan.canonical_code.ref, null);
    assert.equal(plan.selected_assets.tracked_code.included, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('machine add keeps an explicit runtime branch overlay separate from its Git ref', async () => {
  const { base, work } = makeRepo();
  try {
    saveDescriptor(work, declareDescriptor({
      sourceKind: 'git', sourceRoot: work, repoRef: 'refs/heads/trunk', brainId: 'seedid', branchId: 'overlay-a',
    }));
    const plan = await buildMachineAddPlan({ sourceRoot: work, target: 'seedid-mini' });
    assert.equal(plan.canonical_code.ref, 'refs/heads/trunk');
    assert.equal(plan.source.descriptor.branch_id, 'overlay-a');
    assert.equal(plan.writer_fence.state_key, 'seedid/overlay-a');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('machine add refuses an unresolved declared Git ref rather than choosing the checkout', async () => {
  const { base, work } = makeRepo();
  try {
    saveDescriptor(work, declareDescriptor({
      sourceKind: 'git', sourceRoot: work, repoRef: 'refs/heads/missing', brainId: 'seedid',
    }));
    await assert.rejects(
      () => buildMachineAddPlan({ sourceRoot: work, target: 'seedid-mini' }),
      /canonical_ref_(?:unresolved|missing)/i,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('machine add refuses a canonical commit that is not published to its upstream', async () => {
  const { base, work } = makeRepo();
  try {
    fs.writeFileSync(path.join(work, 'local-only.txt'), 'not published');
    git(['add', 'local-only.txt'], work);
    git(['commit', '-m', 'local canonical commit'], work);
    await assert.rejects(
      () => buildMachineAddPlan({ sourceRoot: work, target: 'seedid-mini' }),
      /unpublished_local_canonical_commit|unknown_upstream/i,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('bootup.mjs dispatches machine add without creating local identity state', { timeout: 20_000 }, () => {
  const { base, work } = makeRepo();
  const tmpdir = path.join(base, 'tmp');
  const identityFile = path.join(base, 'machine-id');
  fs.mkdirSync(tmpdir);
  try {
    const child = Bun.spawnSync([process.execPath, 'bootup.mjs', 'machine', 'add', '--dry-run', '--json', '--source-root', work, '--target', 'seedid-mini'], {
      cwd: path.resolve('.'),
      env: { ...process.env, TMPDIR: tmpdir, TEMP: tmpdir, TMP: tmpdir, AGENTBOOTUP_MACHINE_ID_FILE: identityFile },
      stdout: 'pipe', stderr: 'pipe',
    });
    assert.equal(child.exitCode, 0, new TextDecoder().decode(child.stderr));
    const plan = JSON.parse(new TextDecoder().decode(child.stdout));
    assert.equal(plan.dry_run, true);
    assert.equal(plan.canonical_code.ref, 'refs/heads/trunk');
    assert.equal(fs.existsSync(identityFile), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
