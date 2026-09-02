// Red-first contract tests for assertPlanFreshness — the TOCTOU close (gap B)
// and the descriptor half of gap A. The apply executor must re-plan at T1 and
// prove the fresh plan's binding inputs match the approved plan before binding.
//
// What enters the CAS binding: source_descriptor (via descriptor_hash),
// selected_assets + asset_policy_hash (via inventory_sha256). Freshness MUST
// bind exactly those. Structural root-set parity is a defense-in-depth check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanFreshness } from '../lib/network/machine-apply-binding.js';

function plan({ descriptorHash = 'a'.repeat(64), inventorySha = 'b'.repeat(64), roots = ['memory', '.ai'], version = 'machine-add-plan/1' } = {}) {
  return {
    version,
    source: { descriptor_hash: descriptorHash },
    selected_assets: { ignored_state_roots: roots },
    policy: { proposal: { included: { inventory_sha256: inventorySha } } },
  };
}

test('assertPlanFreshness throws on a null/missing fresh plan', () => {
  assert.throws(() => assertPlanFreshness(plan(), null), /fresh plan/);
  assert.throws(() => assertPlanFreshness(plan(), undefined), /fresh plan/);
});

test('assertPlanFreshness throws on a non-machine-add-plan/1 fresh plan', () => {
  assert.throws(() => assertPlanFreshness(plan(), plan({ version: 'other/1' })), /plan\/1/);
});

test('assertPlanFreshness accepts identical plans', () => {
  const approved = plan();
  assert.doesNotThrow(() => assertPlanFreshness(approved, plan()));
});

test('assertPlanFreshness is indifferent to cosmetic non-binding fields (checked_out_ref, work_tree_dirty, daemon_state, dry_run)', () => {
  const approved = plan();
  const fresh = plan();
  fresh.canonical_code = { checked_out_ref: 'different-sha', work_tree_dirty: true };
  fresh.source.daemon_state = 'changed';
  fresh.dry_run = true;
  assert.doesNotThrow(() => assertPlanFreshness(approved, fresh));
});

test('assertPlanFreshness fails closed on a differing descriptor_hash (gap A: source descriptor drift)', () => {
  const approved = plan({ descriptorHash: 'a'.repeat(64) });
  const fresh = plan({ descriptorHash: 'c'.repeat(64) });
  assert.throws(() => assertPlanFreshness(approved, fresh), /descriptor_hash/);
});

test('assertPlanFreshness fails closed on a differing inventory_sha256 (gap B: asset inventory drift between plan and apply)', () => {
  const approved = plan({ inventorySha: 'b'.repeat(64) });
  const fresh = plan({ inventorySha: 'd'.repeat(64) });
  assert.throws(() => assertPlanFreshness(approved, fresh), /inventory_sha256/);
});

test('assertPlanFreshness fails closed on a differing ignored_state_roots set (structural drift)', () => {
  const approved = plan({ roots: ['memory', '.ai'] });
  const fresh = plan({ roots: ['memory'] });
  assert.throws(() => assertPlanFreshness(approved, fresh), /ignored_state_roots/);
  const fresh2 = plan({ roots: ['memory', '.ai', '.brain'] });
  assert.throws(() => assertPlanFreshness(approved, fresh2), /ignored_state_roots/);
});

test('assertPlanFreshness accepts a reordered but equal ignored_state_roots set', () => {
  const approved = plan({ roots: ['memory', '.ai'] });
  const fresh = plan({ roots: ['.ai', 'memory'] });
  assert.doesNotThrow(() => assertPlanFreshness(approved, fresh));
});

test('assertPlanFreshness fails closed on a missing descriptor_hash in either plan', () => {
  const approved = plan();
  delete approved.source.descriptor_hash;
  assert.throws(() => assertPlanFreshness(approved, plan()), /descriptor_hash/);
  const good = plan();
  const freshMissing = plan();
  delete freshMissing.source.descriptor_hash;
  assert.throws(() => assertPlanFreshness(good, freshMissing), /descriptor_hash/);
});

test('assertPlanFreshness fails closed on a missing inventory_sha256 in either plan', () => {
  const approved = plan();
  delete approved.policy.proposal.included.inventory_sha256;
  assert.throws(() => assertPlanFreshness(approved, plan()), /inventory_sha256/);
});
