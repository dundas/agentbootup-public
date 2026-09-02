import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  approvalSigningBytes,
  appendVerifiedReceipt,
  canonicalJson,
  createReceipt,
  planBinding,
  receiptSigningBytes,
  verifyAndConsumeApproval,
  verifyApproval,
  verifyReceipt,
} from '../lib/network/machine-approval-receipts.js';

function fixturePlan() {
  return {
    source_descriptor: {
      version: 'brain-source-descriptor/1', source_kind: 'git', source_root: '/srv/agentbootup',
      repo_ref: 'refs/heads/main', brain_id: 'seedid', branch_id: 'brain-main',
    },
    source_commit: 'a'.repeat(40),
    selected_assets: [{ path: 'memory/MEMORY.md', sha256: 'c'.repeat(64) }],
    asset_policy_hash: 'b'.repeat(64), machine_id: 'machine-mini-1',
    target_path: '/private/tmp/seedid-canary', server_head: 'server-revision-17',
    fence: { generation: 12, lease_holder: 'machine-mini-1', lease_id: 'lease-17' },
    rollback: { snapshot_id: 'snapshot-9', expected_target_revision: 'before-revision-9' },
  };
}

function signer(identity, roles) {
  const pair = generateKeyPairSync('ed25519');
  return { identity, roles, privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }) };
}

function resolver(...identities) {
  return (identity) => {
    const found = identities.find((candidate) => candidate.identity === identity);
    return found && { public_key: found.publicKey, roles: found.roles, status: 'registered' };
  };
}

function signedApproval(plan, operator, overrides = {}) {
  const binding = planBinding(plan);
  const approval = {
    version: 'machine-apply-approval/2', approval_record_id: 'approval-record-0001',
    issuer_identity: operator.identity, issuer_role: 'decisive', binding,
    binding_hash: binding.binding_hash, nonce: '0123456789abcdef0123456789abcdef',
    issued_at: '2026-08-10T00:00:00.000Z', expires_at: '2026-08-10T04:00:00.000Z', signature: null,
    ...overrides,
  };
  approval.signature = sign(null, approvalSigningBytes(approval), createPrivateKey(operator.privateKey)).toString('base64');
  return approval;
}

function signedReceipt(plan, approval, machine, overrides = {}) {
  return createReceipt({
    plan, approval_record_id: approval.approval_record_id, approval_nonce: approval.nonce,
    signer_identity: machine.identity, signer_role: 'machine', phase: 'post_apply',
    assertions: {
      before: { target_revision: 'before-revision-9', selected_assets_hash: planBinding(plan).selected_assets_hash },
      after: { target_revision: 'after-revision-10', selected_assets_hash: planBinding(plan).selected_assets_hash },
      fence: plan.fence, server_head: plan.server_head,
    },
    sign: (bytes) => sign(null, bytes, createPrivateKey(machine.privateKey)).toString('base64'), ...overrides,
  });
}

function tamperSignature(signature) {
  return `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
}

function resignReceipt(receipt, machine, overrides) {
  const updated = { ...receipt, ...overrides, signature: null, receipt_hash: null };
  updated.signature = sign(null, receiptSigningBytes(updated), createPrivateKey(machine.privateKey)).toString('base64');
  const { receipt_hash, ...hashable } = updated;
  updated.receipt_hash = createHash('sha256').update(canonicalJson(hashable)).digest('hex');
  return updated;
}

test('approval binds the exact canonical source descriptor, source commit, selected hashes, policy, target, live head, fence and rollback', () => {
  const plan = fixturePlan(); const operator = signer('did:seed:operator', ['decisive']); const approval = signedApproval(plan, operator);
  const bound = planBinding(plan);
  assert.equal(verifyApproval(plan, approval, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator) }).binding_hash, bound.binding_hash);
  assert.doesNotThrow(() => planBinding({ ...plan, version: bound.version, selected_assets_hash: bound.selected_assets_hash, binding_hash: bound.binding_hash, plan_hash: bound.plan_hash }));
  for (const field of ['binding_hash', 'plan_hash']) assert.throws(() => planBinding({ ...plan, [field]: '0'.repeat(64) }), new RegExp(`binding ${field} is invalid`));
  for (const mutated of [
    { ...plan, source_descriptor: { ...plan.source_descriptor, repo_ref: 'refs/heads/feature' } },
    { ...plan, source_commit: 'd'.repeat(40) },
    { ...plan, selected_assets: [{ ...plan.selected_assets[0], sha256: 'd'.repeat(64) }] },
    { ...plan, target_path: '/private/tmp/other' },
    { ...plan, server_head: 'server-revision-18' },
    { ...plan, fence: { ...plan.fence, generation: 13 } },
    { ...plan, rollback: { ...plan.rollback, snapshot_id: 'snapshot-10' } },
  ]) assert.throws(() => verifyApproval(mutated, approval, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator) }), /binding hash/);
  assert.throws(() => planBinding({ ...plan, source_commit: 'not-a-commit' }), /exact Git commit/);
});

test('approval rejects caller supplied authority, non-Decisive roles, non-Ed25519 keys, future and non-UTC timestamps', () => {
  const plan = fixturePlan(); const operator = signer('did:seed:operator', ['decisive']); const approval = signedApproval(plan, operator);
  assert.throws(() => verifyApproval(plan, approval, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: () => operator.publicKey }), /registered identity record/);
  assert.throws(() => verifyApproval(plan, approval, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: () => ({ public_key: operator.publicKey, roles: ['operator'], status: 'registered' }) }), /Decisive/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => verifyApproval(plan, approval, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: () => ({ public_key: rsa.publicKey.export({ format: 'pem', type: 'spki' }), roles: ['decisive'], status: 'registered' }) }), /Ed25519/);
  for (const issued_at of ['2026-08-10T01:00:00.001Z', '2026-08-10T00:00:00+00:00']) {
    const changed = signedApproval(plan, operator, { issued_at });
    assert.throws(() => verifyApproval(plan, changed, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator) }), /future|UTC/);
  }
  assert.doesNotThrow(() => verifyApproval(plan, signedApproval(plan, operator, { nonce: 'a'.repeat(256) }), { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator) }));
  assert.throws(() => verifyApproval(plan, { ...approval, nonce: 'a'.repeat(257) }, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator) }), /nonce/);
});

test('schemas recursively reject secrets, credential-shaped keys, private PEM and environment paths', () => {
  const plan = fixturePlan(); const operator = signer('did:seed:operator', ['decisive']);
  for (const evil of [
    { ...plan, credentials: { x: 'no' } },
    { ...plan, source_descriptor: { ...plan.source_descriptor, authorizationHeader: 'Bearer no' } },
    { ...plan, asset_policy_hash: 'always-allow' },
    { ...plan, selected_assets: [{ path: '.env.production', sha256: 'c'.repeat(64) }] },
    { ...plan, rollback: { ...plan.rollback, note: '-----BEGIN PRIVATE KEY-----' } },
    { ...plan, unbound_note: 'opaque-value' },
    { ...plan, fence: { ...plan.fence, opaque_value: 'x' } },
    { ...plan, fence: { generation: plan.fence.generation, lease_holder: plan.fence.lease_holder } },
    { ...plan, rollback: { ...plan.rollback, note: 'plain-text' } },
    { ...plan, rollback: { snapshot_id: plan.rollback.snapshot_id } },
    { ...plan, rollback: { expected_target_revision: plan.rollback.expected_target_revision } },
    { ...plan, selected_assets: [{ ...plan.selected_assets[0], opaque_value: 'x' }] },
    ...['/etc/passwd', '../escape', 'memory/../config', '.'].map((path) => ({ ...plan, selected_assets: [{ path, sha256: 'c'.repeat(64) }] })),
  ]) assert.throws(() => planBinding(evil), /secret|schema|environment|policy|unsupported|required|invalid/i);
  const approval = signedApproval(plan, operator);
  assert.throws(() => verifyApproval(plan, { ...approval, accessToken: 'no' }, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator) }), /unexpected|secret/i);
  assert.throws(() => verifyApproval(plan, { ...approval, opaque_value: 'x' }, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator) }), /unsupported fields/);
  assert.throws(() => verifyApproval(plan, { ...approval, signature: tamperSignature(approval.signature) }, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator) }), /signature is invalid/);
});

test('atomic consume receives a frozen complete approval record and full tuple, never a hash-only capability', async () => {
  const plan = fixturePlan(); const operator = signer('did:seed:operator', ['decisive']); const approval = signedApproval(plan, operator); let request;
  await verifyAndConsumeApproval(plan, approval, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator), consumeApproval: async (candidate) => { request = candidate; return { status: 'consumed' }; } });
  assert.equal(request.approval_record_id, approval.approval_record_id); assert.deepEqual(request.binding, planBinding(plan)); assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.binding), true);
  await assert.rejects(() => verifyAndConsumeApproval(plan, approval, { now: '2026-08-10T01:00:00.000Z', resolvePublicIdentity: resolver(operator), consumeApproval: async () => true }), /status/);
  assert.equal(Object.isFrozen(plan.fence), false); plan.fence.generation = 13; assert.equal(plan.fence.generation, 13);
});

test('receipt requires bound approval record, registered Ed25519 machine signer role, full before/after/fence assertions and atomic append-only persistence', async () => {
  const plan = fixturePlan(); const operator = signer('did:seed:operator', ['decisive']); const machine = signer('did:seed:machine', ['machine']); const approval = signedApproval(plan, operator); const receipt = signedReceipt(plan, approval, machine);
  assert.equal(verifyReceipt(receipt, { resolvePublicIdentity: resolver(machine) }).approval_record_id, approval.approval_record_id);
  assert.throws(() => signedReceipt(plan, approval, machine, { created_at: 'not-a-UTC-timestamp' }), /created_at/);
  assert.throws(() => signedReceipt(plan, approval, machine, { phase: 'opaque-value' }), /phase/);
  assert.throws(() => verifyReceipt(resignReceipt(receipt, machine, { phase: 'opaque-value' }), { resolvePublicIdentity: resolver(machine) }), /phase is invalid/);
  for (const assertions of [
    { ...receipt.assertions, before: { selected_assets_hash: receipt.assertions.before.selected_assets_hash } },
    { ...receipt.assertions, after: { selected_assets_hash: receipt.assertions.after.selected_assets_hash } },
  ]) assert.throws(() => signedReceipt(plan, approval, machine, { assertions }), /target_revision/);
  for (const altered of [
    { ...receipt, approval_record_id: 'approval-record-evil' },
    { ...receipt, signer_role: 'operator' },
    { ...receipt, assertions: { before: {}, after: {}, fence: plan.fence, server_head: plan.server_head } },
  ]) assert.throws(() => verifyReceipt(altered, { resolvePublicIdentity: resolver(machine) }), /record|role|assertion/i);
  assert.throws(() => verifyReceipt(receipt, { resolvePublicIdentity: () => ({ public_key: machine.publicKey, roles: ['machine'], status: 'revoked' }) }), /registered/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => verifyReceipt(receipt, { resolvePublicIdentity: () => ({ public_key: rsa.publicKey.export({ format: 'pem', type: 'spki' }), roles: ['machine'], status: 'registered' }) }), /Ed25519/);
  assert.throws(() => verifyReceipt({ ...receipt, signature: tamperSignature(receipt.signature) }, { resolvePublicIdentity: resolver(machine) }), /signature is invalid/);
  assert.throws(() => verifyReceipt({ ...receipt, opaque_value: 'could-be-a-secret' }, { resolvePublicIdentity: resolver(machine) }), /unsupported fields/);
  const beforeHash = 'd'.repeat(64);
  assert.doesNotThrow(() => createReceipt({
    plan, approval_record_id: approval.approval_record_id, approval_nonce: approval.nonce,
    signer_identity: machine.identity, signer_role: 'machine', phase: 'post_apply',
    assertions: { before: { target_revision: 'before-revision-8', selected_assets_hash: beforeHash }, after: { target_revision: 'after-revision-10', selected_assets_hash: planBinding(plan).selected_assets_hash }, fence: plan.fence, server_head: plan.server_head },
    sign: (bytes) => sign(null, bytes, createPrivateKey(machine.privateKey)).toString('base64'),
  }));
  for (const assertions of [
    { ...receipt.assertions, after: { ...receipt.assertions.after, selected_assets_hash: beforeHash } },
    { ...receipt.assertions, fence: { ...plan.fence, generation: 13 } },
    { ...receipt.assertions, server_head: 'server-revision-18' },
    { ...receipt.assertions, opaque_value: 'x' },
    { ...receipt.assertions, before: { ...receipt.assertions.before, opaque_value: 'x' } },
  ]) assert.throws(() => verifyReceipt(resignReceipt(receipt, machine, { assertions }), { resolvePublicIdentity: resolver(machine) }), /bound selection|bound fence|bound head|unsupported/);
  let append;
  await appendVerifiedReceipt(receipt, { resolvePublicIdentity: resolver(machine), appendReceipt: async (candidate) => { append = candidate; return { status: 'appended', head_receipt_hash: receipt.receipt_hash }; } });
  assert.equal(append.approval_record_id, approval.approval_record_id); assert.equal(append.expected_previous_receipt_hash, null); assert.equal(Object.isFrozen(append.receipt), true);
  const chained = signedReceipt(plan, approval, machine, { previous_receipt_hash: receipt.receipt_hash });
  await appendVerifiedReceipt(chained, { resolvePublicIdentity: resolver(machine), appendReceipt: async (candidate) => {
    assert.equal(candidate.expected_previous_receipt_hash, receipt.receipt_hash);
    return { status: 'appended', head_receipt_hash: chained.receipt_hash };
  } });
  await assert.rejects(() => appendVerifiedReceipt(receipt, { resolvePublicIdentity: resolver(machine), appendReceipt: async () => ({ status: 'appended', head_receipt_hash: '0'.repeat(64) }) }), /head/);
  assert.equal(Object.isFrozen(receipt.binding), false); receipt.assertions.after.target_revision = 'retry-revision'; assert.equal(receipt.assertions.after.target_revision, 'retry-revision');
});
