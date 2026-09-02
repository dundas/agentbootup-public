// Red-first contract tests for the machine-add apply binding (work-order Step 3,
// first sub-slice). A dry-run plan is NOT binding-ready: fence (lease), rollback
// (snapshot), target identity, server_head, and source_commit are runtime state
// acquired at apply time. `buildApplyBinding` is the pure fail-closed glue that
// combines a `machine-add-plan/1` with acquired runtime state into a
// `planBinding`-valid CAS tuple. It must reject any missing/fake acquired field.
//
// These tests are intentionally pure: no filesystem, no network, no identity
// minting, no lease store. The apply executor (later sub-slice) feeds real
// acquired state into this function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApplyBinding } from '../lib/network/machine-apply-binding.js';
import { planBinding } from '../lib/network/machine-approval-receipts.js';

function fakeDescriptor({ brainId = 'seedid', branchId = null, sourceKind = 'git', repoRef = 'refs/heads/trunk' } = {}) {
  return {
    version: 'brain-source-descriptor/1',
    source_kind: sourceKind,
    source_root: '/tmp/source-root',
    brain_id: brainId,
    branch_id: branchId,
    repo_ref: sourceKind === 'git' ? repoRef : null,
  };
}

function fakePlan({ descriptor = fakeDescriptor(), files = [{ path: 'memory/x.txt', sha256: 'a'.repeat(64), bytes: 2 }], inventorySha = 'b'.repeat(64) } = {}) {
  return {
    version: 'machine-add-plan/1',
    dry_run: true,
    source: { descriptor, descriptor_hash: 'c'.repeat(64), daemon_state: 'eligible' },
    canonical_code: { kind: 'git', ref: 'refs/heads/trunk', ref_source: 'declared', checked_out_ref: 'trunk', checked_out_detached: false, work_tree_dirty: false, checkout_disposition: 'not_selected_as_authority' },
    selected_assets: { tracked_code: { included: true, disposition: 'clone_or_checkout_canonical_ref' }, ignored_state_roots: ['memory'], disposition: 'non_secret_assets_only', secrets: { included: false, disposition: 'excluded_from_ordinary_bootstrap' }, excluded_per_machine_roots: ['.brain'] },
    target: { declared: 'mac-mini-canary', disposition: 'declared_unverified', identity: { state: 'unverified', machine_id: null, disposition: 'target_must_create_or_use_its_own_identity' } },
    remote: { endpoint: null, capability: 'not_declared', disposition: 'no_remote_connection_attempted' },
    source_identity: { state: 'registered', machine_id: 'src-machine', disposition: 'read_only_not_transferred' },
    writer_fence: { required: true, state_key: 'seedid', disposition: 'must_acquire_fresh_lease_and_fencing_token_before_any_state_write' },
    policy: {
      approval_required: true, approved: false, disposition: 'proposal_only_no_apply_path',
      proposal: {
        version: 'machine-asset-policy-proposal/1', state: 'proposed_unapproved',
        included: { roots: ['memory'], files, file_count: files.length, total_bytes: 2, inventory_sha256: inventorySha },
        exclusions: {},
        approval: { required: true, disposition: 'proposal_only_no_apply_path', binds_inventory_sha256: inventorySha },
      },
    },
    daemon: { disposition: 'stopped_pending_canary' },
    actions: [],
  };
}

function fakeAcquired(overrides = {}) {
  return {
    source_commit: '0'.repeat(40),
    server_head: '1'.repeat(40),
    machine_id: 'target-machine-id',
    target_path: '/tmp/target-root',
    fence: { generation: 1, lease_holder: 'operator', lease_id: 'lease-abc123def456' },
    rollback: { snapshot_id: 'snap-0'.repeat(8).slice(0, 64), expected_target_revision: 'rev-0'.repeat(8).slice(0, 64) },
    ...overrides,
  };
}

test('buildApplyBinding rejects a non-machine-add-plan/1 input', () => {
  const plan = fakePlan();
  plan.version = 'something-else/1';
  assert.throws(() => buildApplyBinding(plan, fakeAcquired()), /machine-add-plan\/1/);
});

test('buildApplyBinding rejects a dry-run plan whose acquired state is missing (fail-closed)', () => {
  const plan = fakePlan();
  // No acquired state at all — must fail closed, never synthesize a binding.
  assert.throws(() => buildApplyBinding(plan, {}), /source_commit/);
});

test('buildApplyBinding rejects a missing source_commit', () => {
  const plan = fakePlan();
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ source_commit: undefined })), /source_commit/);
});

test('buildApplyBinding rejects a non-Git source_commit', () => {
  const plan = fakePlan();
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ source_commit: 'not-a-commit' })), /source_commit/);
});

test('buildApplyBinding rejects a missing server_head', () => {
  const plan = fakePlan();
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ server_head: undefined })), /server_head/);
});

test('buildApplyBinding rejects a missing target machine_id (unverified identity is not authority)', () => {
  const plan = fakePlan();
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ machine_id: undefined })), /machine_id/);
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ machine_id: null })), /machine_id/);
});

test('buildApplyBinding rejects a missing target_path', () => {
  const plan = fakePlan();
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ target_path: undefined })), /target_path/);
});

test('buildApplyBinding rejects a fence missing any required field', () => {
  const plan = fakePlan();
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ fence: undefined })), /fence/);
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ fence: { generation: 1, lease_holder: 'op' } })), /fence/);
  // generation must be a safe integer
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ fence: { generation: 1.5, lease_holder: 'op', lease_id: 'x'.repeat(16) } })), /fence/);
  // a complete fence is accepted (sanity: the rejections above are about missing/invalid fields)
  assert.doesNotThrow(() => buildApplyBinding(plan, fakeAcquired({ fence: { generation: 1, lease_holder: 'op', lease_id: 'x'.repeat(16) } })));
});

test('buildApplyBinding rejects a rollback missing any required field', () => {
  const plan = fakePlan();
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ rollback: undefined })), /rollback/);
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ rollback: { snapshot_id: 's'.repeat(64) } })), /rollback/);
  // a complete rollback is accepted (sanity)
  assert.doesNotThrow(() => buildApplyBinding(plan, fakeAcquired({ rollback: { snapshot_id: 's'.repeat(64), expected_target_revision: 'r'.repeat(64) } })));
});

test('buildApplyBinding maps selected_assets to {path, sha256} only — no bytes, no extra fields', () => {
  const plan = fakePlan({ files: [{ path: 'memory/a.txt', sha256: 'a'.repeat(64), bytes: 99 }, { path: 'memory/b.txt', sha256: 'b'.repeat(64), bytes: 7 }] });
  const binding = buildApplyBinding(plan, fakeAcquired());
  assert.ok(Array.isArray(binding.selected_assets), 'selected_assets is an array');
  assert.equal(binding.selected_assets.length, 2);
  for (const item of binding.selected_assets) {
    assert.deepEqual(Object.keys(item).sort(), ['path', 'sha256']);
  }
});

test('buildApplyBinding sets asset_policy_hash from the proposal inventory_sha256', () => {
  const inventorySha = 'd'.repeat(64);
  const plan = fakePlan({ inventorySha });
  const binding = buildApplyBinding(plan, fakeAcquired());
  assert.equal(binding.asset_policy_hash, inventorySha);
});

test('buildApplyBinding sets source_descriptor from the plan source descriptor', () => {
  const descriptor = fakeDescriptor({ brainId: 'seedid', repoRef: 'refs/heads/trunk' });
  const plan = fakePlan({ descriptor });
  const binding = buildApplyBinding(plan, fakeAcquired());
  assert.deepEqual(binding.source_descriptor, descriptor);
});

test('buildApplyBinding result is accepted by planBinding (full CAS tuple, binding_hash stable)', () => {
  const plan = fakePlan();
  const acquired = fakeAcquired();
  const binding = buildApplyBinding(plan, acquired);
  // planBinding is the merged contract's authority — the apply binding MUST pass it.
  const verified = planBinding(binding);
  assert.equal(verified.version, 'machine-apply-binding/2');
  assert.equal(verified.binding_hash, verified.plan_hash);
  // Re-deriving from the same inputs is deterministic.
  const again = planBinding(buildApplyBinding(plan, acquired));
  assert.equal(again.binding_hash, verified.binding_hash);
});

test('buildApplyBinding is fail-closed: a fake/placeholder fence is not accepted', () => {
  const plan = fakePlan();
  // An apply path that failed to acquire a real lease must not be able to slip
  // a placeholder through. Empty-string lease_id is rejected by the contract.
  assert.throws(() => buildApplyBinding(plan, fakeAcquired({ fence: { generation: 1, lease_holder: 'op', lease_id: '' } })), /fence/);
});

test('buildApplyBinding rejects if the plan has no policy proposal (no asset inventory to bind)', () => {
  const plan = fakePlan();
  delete plan.policy;
  assert.throws(() => buildApplyBinding(plan, fakeAcquired()), /policy/);
});
