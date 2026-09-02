/**
 * Pure fail-closed glue between the report-only `machine add --dry-run` plan
 * and the merged approval-receipt contract (`planBinding`).
 *
 * A dry-run plan is NOT binding-ready. The CAS tuple the contract binds
 * requires runtime state that only exists once an apply path has:
 *   - resolved the canonical ref to a concrete commit        -> source_commit
 *   - materialized the target and recorded its head          -> server_head
 *   - verified/created the target's own host-local identity   -> machine_id
 *   - selected the target root                               -> target_path
 *   - acquired a fresh writer lease                          -> fence
 *   - snapshotted target state for rollback                  -> rollback
 *
 * `buildApplyBinding` takes a `machine-add-plan/1` plus that acquired state and
 * returns the 9-field binding object that `planBinding` (in
 * machine-approval-receipts.js) canonicalizes and hashes. It performs NO
 * filesystem, network, identity-minting, or lease-store access. Any missing or
 * placeholder-shaped acquired field is rejected fail-closed — an apply path
 * that failed to acquire real runtime state must never be able to synthesize a
 * binding.
 *
 * Authority: the merged contract's `planBinding` remains the final validator.
 * This module only assembles and pre-checks; it does not assert authority of
 * its own.
 */

const PLAN_VERSION = 'machine-add-plan/1';
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function bindingError(message) {
  const error = new Error(message);
  error.name = 'MachineApplyBindingError';
  return error;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value) throw bindingError(`${field} is required`);
  return value;
}

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((item) => bs.has(item));
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value) throw bindingError(`${field} is required`);
  return value;
}

function requireGitCommit(value, field) {
  if (typeof value !== 'string' || !GIT_COMMIT.test(value)) throw bindingError(`${field} must be an exact Git commit`);
  return value;
}

function requireAcquiredFence(fence) {
  if (fence == null || typeof fence !== 'object' || Array.isArray(fence)) throw bindingError('fence is required');
  if (!Number.isSafeInteger(fence.generation)) throw bindingError('fence.generation must be a safe integer');
  requireNonEmptyString(fence.lease_holder, 'fence.lease_holder');
  requireNonEmptyString(fence.lease_id, 'fence.lease_id');
  // Reject extra keys: the contract binds exactly {generation, lease_holder, lease_id}.
  for (const key of Object.keys(fence)) {
    if (!['generation', 'lease_holder', 'lease_id'].includes(key)) throw bindingError(`fence has unexpected field: ${key}`);
  }
  return { generation: fence.generation, lease_holder: fence.lease_holder, lease_id: fence.lease_id };
}

function requireAcquiredRollback(rollback) {
  if (rollback == null || typeof rollback !== 'object' || Array.isArray(rollback)) throw bindingError('rollback is required');
  requireNonEmptyString(rollback.snapshot_id, 'rollback.snapshot_id');
  requireNonEmptyString(rollback.expected_target_revision, 'rollback.expected_target_revision');
  for (const key of Object.keys(rollback)) {
    if (!['snapshot_id', 'expected_target_revision'].includes(key)) throw bindingError(`rollback has unexpected field: ${key}`);
  }
  return { snapshot_id: rollback.snapshot_id, expected_target_revision: rollback.expected_target_revision };
}

/**
 * Build the 9-field CAS binding from a dry-run plan and acquired runtime state.
 *
 * @param {object} plan   A `machine-add-plan/1` produced by `buildMachineAddPlan`.
 * @param {object} acquired Runtime state acquired by the apply executor:
 *   `{ source_commit, server_head, machine_id, target_path, fence, rollback }`.
 * @returns {object} The raw binding object (BINDING_FIELDS only); pass to
 *   `planBinding` for canonicalization, hashing, and final validation.
 */
export function buildApplyBinding(plan, acquired) {
  if (plan == null || typeof plan !== 'object' || plan.version !== PLAN_VERSION) {
    throw bindingError(`plan must be a ${PLAN_VERSION}`);
  }
  const proposal = plan.policy?.proposal?.included;
  if (proposal == null || !Array.isArray(proposal.files)) {
    throw bindingError('plan has no policy proposal with an asset inventory to bind');
  }
  if (typeof proposal.inventory_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proposal.inventory_sha256)) {
    throw bindingError('policy proposal inventory_sha256 is invalid');
  }
  if (plan.source?.descriptor == null) {
    throw bindingError('plan has no source descriptor');
  }

  const acquiredState = acquired ?? {};
  const sourceCommit = requireGitCommit(acquiredState.source_commit, 'source_commit');
  const serverHead = requireGitCommit(acquiredState.server_head, 'server_head');
  const machineId = requireNonEmptyString(acquiredState.machine_id, 'machine_id');
  const targetPath = requireNonEmptyString(acquiredState.target_path, 'target_path');
  const fence = requireAcquiredFence(acquiredState.fence);
  const rollback = requireAcquiredRollback(acquiredState.rollback);

  // Map the proposal's non-secret asset inventory to the contract's asset
  // shape: {path, sha256} only. Bytes and any extra fields are dropped so they
  // cannot perturb the binding hash, and a rejected file (never named/hashed by
  // the dry-run collector) can never enter the binding.
  const selectedAssets = proposal.files.map((file) => {
    if (file == null || typeof file !== 'object') throw bindingError('selected asset entry is invalid');
    const { path, sha256 } = file;
    if (typeof path !== 'string' || !path) throw bindingError('selected asset path is required');
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw bindingError('selected asset sha256 must be sha256');
    return { path, sha256 };
  });

  return {
    source_descriptor: plan.source.descriptor,
    source_commit: sourceCommit,
    selected_assets: selectedAssets,
    asset_policy_hash: proposal.inventory_sha256,
    machine_id: machineId,
    target_path: targetPath,
    server_head: serverHead,
    fence,
    rollback,
  };
}

/**
 * Close the TOCTOU gap (B) and the descriptor half of A: prove the live source
 * at apply time (T1) still matches the source the operator approved (T0) on
 * exactly the fields that enter the CAS binding. The apply executor re-runs
 * `buildMachineAddPlan` at T1 and passes both plans here before binding.
 *
 * What enters the binding: `source_descriptor` (bound via `descriptor_hash`) and
 * `selected_assets` + `asset_policy_hash` (bound via `inventory_sha256`).
 * `ignored_state_roots` parity is a structural defense-in-depth check: if the
 * set of collected roots differs, an equal inventory hash would be coincidental.
 *
 * Cosmetic fields (`checked_out_ref`, `work_tree_dirty`, `daemon_state`,
 * `dry_run`) do NOT enter the binding and are intentionally ignored.
 */
export function assertPlanFreshness(approvedPlan, freshPlan) {
  if (!isPlainObject(freshPlan) || freshPlan.version !== PLAN_VERSION) {
    throw bindingError('fresh plan must be a machine-add-plan/1');
  }
  if (!isPlainObject(approvedPlan)) throw bindingError('approved plan is required');

  const approvedDescriptorHash = approvedPlan.source?.descriptor_hash;
  const freshDescriptorHash = freshPlan.source?.descriptor_hash;
  if (requireString(approvedDescriptorHash, 'approved descriptor_hash') !== requireString(freshDescriptorHash, 'fresh descriptor_hash')) {
    throw bindingError('descriptor_hash drift between approved and fresh plan');
  }

  const approvedInventory = approvedPlan.policy?.proposal?.included?.inventory_sha256;
  const freshInventory = freshPlan.policy?.proposal?.included?.inventory_sha256;
  if (requireString(approvedInventory, 'approved inventory_sha256') !== requireString(freshInventory, 'fresh inventory_sha256')) {
    throw bindingError('inventory_sha256 drift between approved and fresh plan');
  }

  const approvedRoots = approvedPlan.selected_assets?.ignored_state_roots;
  const freshRoots = freshPlan.selected_assets?.ignored_state_roots;
  if (!sameSet(approvedRoots, freshRoots)) {
    throw bindingError('ignored_state_roots drift between approved and fresh plan');
  }
}

/**
 * Read-only executor preflight: acquire the real runtime state the CAS binding
 * requires, using deps-injected primitives. Closes gap A fully: source_commit
 * is resolved from the live canonical ref at T1 (never trusted from the plan),
 * the target identity is read fail-closed (the target must have pre-created its
 * own host-local identity; unverified identity is not authority), and the fence
 * comes from a real lease. server_head is the head the apply produces, which
 * for bringing a target to the canonical commit equals source_commit. rollback
 * is the before-apply target snapshot from the snapshotter.
 *
 * This step performs NO target mutation and consumes NO approval. It returns
 * the fresh plan plus the acquired state ready for `buildApplyBinding`. The
 * caller drives materialize, approval consumption, and receipts afterward.
 *
 * On any failure after the lease is acquired, the lease is released so a failed
 * preflight never strands a fence. On success the caller owns the lease through
 * the apply (and must release it on apply failure/success per the fence contract).
 *
 * @param {object} approvedPlan The plan the operator approved at T0.
 * @param {object} ctx `{ sourceRoot, target, stateKey, operatorMachineId, store, now }`.
 * @param {object} deps Injected primitives (all required):
 *   `{ buildMachineAddPlan, resolveCommit, acquireLease, releaseLease,
 *      readTargetMachineId, snapshotTarget, makeLeaseId }`.
 * @returns {Promise<{ freshPlan: object, acquired: object, binding: object }>}
 */
export async function acquireApplyPreflight(approvedPlan, ctx, deps) {
  if (!isPlainObject(approvedPlan)) throw bindingError('approved plan is required');
  if (!isPlainObject(ctx)) throw bindingError('ctx is required');
  const { sourceRoot, target, stateKey, operatorMachineId, store, now } = ctx;
  requireString(sourceRoot, 'ctx.sourceRoot');
  requireString(target, 'ctx.target');
  requireString(stateKey, 'ctx.stateKey');
  requireString(operatorMachineId, 'ctx.operatorMachineId');
  if (typeof now !== 'number') throw bindingError('ctx.now is required (lease clock)');
  if (store == null) throw bindingError('ctx.store is required');

  const d = deps ?? {};
  const buildMachineAddPlan = d.buildMachineAddPlan ?? (() => { throw bindingError('deps.buildMachineAddPlan is required'); });
  const resolveCommit = d.resolveCommit ?? (() => { throw bindingError('deps.resolveCommit is required'); });
  const acquireLease = d.acquireLease ?? (() => { throw bindingError('deps.acquireLease is required'); });
  // releaseLease is required and validated upfront (not lazily): it is only
  // invoked in the failure path, so a lazy default would let a successful
  // preflight proceed without the caller ever providing a matching release,
  // and a failed preflight would strand the fence until TTL. The real wiring
  // MUST pass the matching releaseLease for acquireLease.
  if (typeof d.releaseLease !== 'function') throw bindingError('deps.releaseLease is required');
  const releaseLease = d.releaseLease;
  const readTargetMachineId = d.readTargetMachineId ?? (() => { throw bindingError('deps.readTargetMachineId is required'); });
  const snapshotTarget = d.snapshotTarget ?? (() => { throw bindingError('deps.snapshotTarget is required'); });
  const makeLeaseId = d.makeLeaseId ?? (() => { throw bindingError('deps.makeLeaseId is required'); });

  // 1. Re-plan at T1 (read-only) and prove the live source still matches T0.
  const freshPlan = await buildMachineAddPlan({ sourceRoot, target });
  assertPlanFreshness(approvedPlan, freshPlan);

  // 2. Resolve the canonical ref to a concrete commit at T1 (never trust plan).
  const canonicalRef = freshPlan.canonical_code?.ref;
  const sourceCommit = resolveCommit(sourceRoot, canonicalRef);
  if (typeof sourceCommit !== 'string' || !GIT_COMMIT.test(sourceCommit)) {
    throw bindingError('source_commit must be an exact Git commit');
  }

  // 3. Acquire the writer fence. The catch below is only reachable after a
  //    successful acquireLease (acquireLease itself is outside the try), so any
  //    post-acquire failure must release the lease to avoid stranding the fence.
  const lease = acquireLease(store, stateKey, operatorMachineId, { now });
  try {
    const machineId = readTargetMachineId(target);
    if (typeof machineId !== 'string' || !machineId) {
      throw bindingError('machine_id is required (target must pre-create its own identity)');
    }
    const rollback = snapshotTarget(target, { sourceCommit });
    if (!isPlainObject(rollback) || typeof rollback.snapshot_id !== 'string' || !rollback.snapshot_id || typeof rollback.expected_target_revision !== 'string' || !rollback.expected_target_revision) {
      throw bindingError('rollback.snapshot_id and rollback.expected_target_revision are required');
    }
    if (!Number.isSafeInteger(lease.fencing_token)) {
      throw bindingError('lease.fencing_token must be a safe integer');
    }
    const fence = {
      generation: lease.fencing_token,
      lease_holder: operatorMachineId,
      lease_id: makeLeaseId(),
    };
    const acquired = {
      source_commit: sourceCommit,
      server_head: sourceCommit,
      machine_id: machineId,
      target_path: target,
      fence,
      rollback,
    };
    // 4. Validate the acquired state against the binding contract BEFORE
    //    returning, so a binding-incompatible acquired object (e.g. rollback
    //    with extra keys, or any other shape the contract rejects) is caught
    //    here — and the lease released — rather than leaving the caller with a
    //    held lease that buildApplyBinding then rejects. buildApplyBinding is
    //    the authority on the binding shape; this is defense-in-depth at the
    //    preflight boundary.
    const binding = buildApplyBinding(freshPlan, acquired);
    return { freshPlan, acquired, binding };
  } catch (error) {
    try { releaseLease(store, stateKey, operatorMachineId); } catch { /* release is best-effort; original error is primary */ }
    throw error;
  }
}
