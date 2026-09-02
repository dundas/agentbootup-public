// Red-first contract tests for acquireApplyPreflight — the read-only executor
// step that acquires real runtime state and closes gap A fully (source_commit
// resolved from the live ref at T1, never trusted from the plan; target identity
// read fail-closed; fence from a real lease; server_head derived as the head the
// apply produces = source_commit; rollback from a target snapshot).
//
// deps-injected so it is pure-testable with no filesystem, no canary contact,
// no identity minting. The real wiring passes the actual primitives
// (buildMachineAddPlan, git rev-parse, acquireLease, readMachineIdState,
// snapshotTarget) as deps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireApplyPreflight } from '../lib/network/machine-apply-binding.js';

const COMMIT = '0'.repeat(40);
const OTHER = '1'.repeat(40);

const DESCRIPTOR = {
  version: 'brain-source-descriptor/1', source_kind: 'git', source_root: '/tmp/source',
  brain_id: 'seedid', branch_id: null, repo_ref: 'refs/heads/trunk',
};

function approvedPlan({ descriptorHash = 'a'.repeat(64), inventorySha = 'b'.repeat(64), roots = ['memory', '.ai'], canonicalRef = 'refs/heads/trunk' } = {}) {
  return {
    version: 'machine-add-plan/1',
    source: { descriptor_hash: descriptorHash, descriptor: DESCRIPTOR },
    canonical_code: { ref: canonicalRef },
    selected_assets: { ignored_state_roots: roots },
    policy: { proposal: { included: { inventory_sha256: inventorySha, files: [{ path: 'memory/x.txt', sha256: 'a'.repeat(64), bytes: 2 }] } } },
  };
}

function deps({
  freshPlan = approvedPlan(),
  resolveCommit = () => COMMIT,
  acquireLease = () => ({ machine_id: 'operator', fencing_token: 7, expires_at: 9999 }),
  releaseLease = () => {},
  readTargetMachineId = () => 'target-machine-id',
  snapshotTarget = () => ({ snapshot_id: 's'.repeat(64), expected_target_revision: 'absent' }),
  makeLeaseId = () => 'lease-id-0123456789ab',
} = {}) {
  return { buildMachineAddPlan: () => freshPlan, resolveCommit, acquireLease, releaseLease, readTargetMachineId, snapshotTarget, makeLeaseId };
}

function ctx({ operatorMachineId = 'operator', target = '/tmp/target', stateKey = 'seedid' } = {}) {
  return { sourceRoot: '/tmp/source', target, stateKey, operatorMachineId, store: {}, now: 1000 };
}

test('acquireApplyPreflight re-plans at T1 and asserts freshness (throws on descriptor drift)', async () => {
  const approved = approvedPlan();
  const fresh = approvedPlan({ descriptorHash: 'c'.repeat(64) });
  await assert.rejects(() => acquireApplyPreflight(approved, ctx(), deps({ freshPlan: fresh })), /descriptor_hash/);
});

test('acquireApplyPreflight resolves source_commit from the live ref (not from the plan)', async () => {
  const result = await acquireApplyPreflight(approvedPlan(), ctx(), deps({ resolveCommit: () => OTHER }));
  assert.equal(result.acquired.source_commit, OTHER);
});

test('acquireApplyPreflight rejects a non-commit source_commit (fail-closed)', async () => {
  await assert.rejects(() => acquireApplyPreflight(approvedPlan(), ctx(), deps({ resolveCommit: () => 'not-a-commit' })), /source_commit/);
});

test('acquireApplyPreflight rejects a missing source_commit (fail-closed)', async () => {
  await assert.rejects(() => acquireApplyPreflight(approvedPlan(), ctx(), deps({ resolveCommit: () => null })), /source_commit/);
});

test('acquireApplyPreflight sets server_head = source_commit (the head the apply produces)', async () => {
  const result = await acquireApplyPreflight(approvedPlan(), ctx(), deps({ resolveCommit: () => OTHER }));
  assert.equal(result.acquired.server_head, OTHER);
  assert.equal(result.acquired.server_head, result.acquired.source_commit);
});

test('acquireApplyPreflight acquires the lease and maps fencing_token to fence.generation', async () => {
  let leaseArgs;
  const acquireLease = (store, key, machineId, opts) => {
    leaseArgs = { store, key, machineId, opts };
    return { machine_id: machineId, fencing_token: 42, expires_at: 9999 };
  };
  const c = ctx();
  const result = await acquireApplyPreflight(approvedPlan(), c, deps({ acquireLease }));
  assert.equal(leaseArgs.key, c.stateKey);
  assert.equal(leaseArgs.machineId, c.operatorMachineId);
  assert.equal(leaseArgs.opts.now, c.now);
  assert.equal(result.acquired.fence.generation, 42);
  assert.equal(result.acquired.fence.lease_holder, c.operatorMachineId);
  assert.equal(typeof result.acquired.fence.lease_id, 'string');
  assert.ok(result.acquired.fence.lease_id.length >= 16);
});

test('acquireApplyPreflight reads target machine_id fail-closed (unverified identity is not authority)', async () => {
  await assert.rejects(() => acquireApplyPreflight(approvedPlan(), ctx(), deps({ readTargetMachineId: () => null })), /machine_id/);
  await assert.rejects(() => acquireApplyPreflight(approvedPlan(), ctx(), deps({ readTargetMachineId: () => undefined })), /machine_id/);
  await assert.rejects(() => acquireApplyPreflight(approvedPlan(), ctx(), deps({ readTargetMachineId: () => '' })), /machine_id/);
});

test('acquireApplyPreflight sets target_path from ctx', async () => {
  const c = ctx({ target: '/tmp/canary-target' });
  const result = await acquireApplyPreflight(approvedPlan(), c, deps());
  assert.equal(result.acquired.target_path, '/tmp/canary-target');
});

test('acquireApplyPreflight takes rollback from snapshotTarget (before-apply snapshot)', async () => {
  const snap = { snapshot_id: 'x'.repeat(64), expected_target_revision: 'old-head-'.repeat(5).slice(0, 40) };
  const result = await acquireApplyPreflight(approvedPlan(), ctx(), deps({ snapshotTarget: () => snap }));
  assert.deepEqual(result.acquired.rollback, snap);
});

test('acquireApplyPreflight requires a valid rollback from the snapshotter (fail-closed on missing)', async () => {
  await assert.rejects(() => acquireApplyPreflight(approvedPlan(), ctx(), deps({ snapshotTarget: () => null })), /rollback/);
  await assert.rejects(() => acquireApplyPreflight(approvedPlan(), ctx(), deps({ snapshotTarget: () => ({ snapshot_id: 's'.repeat(64) }) })), /rollback/);
});

test('acquireApplyPreflight result feeds buildApplyBinding + planBinding cleanly', async () => {
  const { planBinding } = await import('../lib/network/machine-approval-receipts.js');
  // approvedPlan() is now full-shape (descriptor + files + inventory), so the
  // preflight returns a verified `binding` (it runs buildApplyBinding internally).
  const approved = approvedPlan();
  const result = await acquireApplyPreflight(approved, ctx(), deps({ freshPlan: approvedPlan() }));
  const verified = planBinding(result.binding);
  assert.equal(verified.version, 'machine-apply-binding/2');
  assert.ok(verified.binding_hash);
  // The binding the preflight returns equals re-deriving from the returned acquired state.
  const { buildApplyBinding } = await import('../lib/network/machine-apply-binding.js');
  assert.deepEqual(planBinding(buildApplyBinding(result.freshPlan, result.acquired)), verified);
});

test('acquireApplyPreflight releases the lease if a later step fails (no stranded fence)', async () => {
  let released = false;
  const acquireLease = () => ({ machine_id: 'operator', fencing_token: 1, expires_at: 9999 });
  const releaseLease = () => { released = true; };
  // readTargetMachineId fails AFTER the lease is acquired
  await assert.rejects(
    () => acquireApplyPreflight(approvedPlan(), ctx(), deps({ acquireLease, releaseLease, readTargetMachineId: () => null })),
    /machine_id/,
  );
  assert.equal(released, true, 'lease must be released when a post-acquire step fails');
});

test('acquireApplyPreflight does NOT release the lease on success (the caller owns it through apply)', async () => {
  let released = false;
  const releaseLease = () => { released = true; };
  await acquireApplyPreflight(approvedPlan(), ctx(), deps({ releaseLease }));
  assert.equal(released, false);
});

test('acquireApplyPreflight requires deps.releaseLease (no silent no-op default that would strand a fence)', async () => {
  const d = deps();
  delete d.releaseLease;
  await assert.rejects(() => acquireApplyPreflight(approvedPlan(), ctx(), d), /releaseLease is required/);
});

test('acquireApplyPreflight rejects a non-integer fencing_token (binding-incompatible fence)', async () => {
  await assert.rejects(
    () => acquireApplyPreflight(approvedPlan(), ctx(), deps({ acquireLease: () => ({ machine_id: 'operator', fencing_token: 1.5, expires_at: 9999 }) })),
    /fencing_token/,
  );
});

test('acquireApplyPreflight catches a binding-incompatible rollback (extra keys) inside preflight and releases the lease', async () => {
  let released = false;
  const releaseLease = () => { released = true; };
  // rollback with an extra key that buildApplyBinding rejects via requireAcquiredRollback
  const badRollback = { snapshot_id: 's'.repeat(64), expected_target_revision: 'absent', extra: 'noise' };
  await assert.rejects(
    () => acquireApplyPreflight(approvedPlan(), ctx(), deps({ releaseLease, snapshotTarget: () => badRollback })),
    /rollback/,
  );
  assert.equal(released, true, 'lease must be released when buildApplyBinding rejects the acquired state');
});
