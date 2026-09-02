/**
 * Pure validation and evidence primitives for machine-add apply.
 *
 * This module intentionally has no filesystem, network, identity-minting, or
 * nonce-storage capability. An eventual control-plane apply endpoint must
 * atomically consume the verified nonce together with the complete binding.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { validateDescriptor } from '../brain/source-descriptor.js';

const BINDING_FIELDS = [
  'source_descriptor', 'source_commit', 'selected_assets', 'asset_policy_hash',
  'machine_id', 'target_path', 'server_head', 'fence', 'rollback',
];
const BINDING_DERIVED_FIELDS = ['version', 'selected_assets_hash', 'binding_hash', 'plan_hash'];
const SECRET_FIELD = /(?:secret|private(?:[_-]?key)?|credentials?|password|token|api[_-]?key|authorization)/i;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NONCE = /^[a-zA-Z0-9_-]{16,256}$/;
const APPROVAL_RECORD = /^approval-record-\d{4,}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PEM_SECRET = /-----BEGIN .*PRIVATE KEY-----/;
const APPROVAL_KEYS = new Set(['version', 'approval_record_id', 'issuer_identity', 'issuer_role', 'binding', 'binding_hash', 'nonce', 'issued_at', 'expires_at', 'signature']);
const RECEIPT_KEYS = new Set(['version', 'plan_hash', 'approval_nonce', 'binding', 'approval_record_id', 'signer_identity', 'signer_role', 'phase', 'assertions', 'previous_receipt_hash', 'created_at', 'signature', 'receipt_hash']);
const FENCE_KEYS = new Set(['generation', 'lease_holder', 'lease_id']);
const ROLLBACK_KEYS = new Set(['snapshot_id', 'expected_target_revision']);
const ASSET_KEYS = new Set(['path', 'sha256']);
const ASSERTION_KEYS = new Set(['before', 'after', 'fence', 'server_head']);
const SNAPSHOT_KEYS = new Set(['target_revision', 'selected_assets_hash']);
const RECEIPT_PHASES = new Set(['preflight', 'post_apply', 'rollback', 'blocked', 'coordinator_outcome']);

function contractError(message) {
  const error = new Error(message);
  error.name = 'MachineApplyContractError';
  return error;
}

function assertPlainValue(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && PEM_SECRET.test(value)) throw contractError(`secret private key material is forbidden at ${path}`);
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELD.test(key)) throw contractError(`secret-like field is forbidden at ${path}.${key}`);
      assertPlainValue(item, `${path}.${key}`);
    }
    return;
  }
  throw contractError(`non-canonical value at ${path}`);
}

export function canonicalJson(value) {
  assertPlainValue(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value) throw contractError(`${field} is required`);
  return value;
}
function assertExactKeys(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) throw contractError(`${field} contains unsupported fields`);
}
function assertRelativeAssetPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.split('/').some((segment) => !segment || segment === '.' || segment === '..') || /(?:^|\/)\.env(?:\.|$)/i.test(value)) throw contractError('selected_assets paths are invalid or environment paths');
}
function requireApprovalRecord(value) { if (!APPROVAL_RECORD.test(value ?? '')) throw contractError('approval record is invalid'); return value; }
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); } return value; }
function assertReceiptAssertions(assertions, binding) {
  assertExactKeys(assertions, ASSERTION_KEYS, 'assertions');
  assertExactKeys(assertions.before, SNAPSHOT_KEYS, 'assertions.before');
  assertExactKeys(assertions.after, SNAPSHOT_KEYS, 'assertions.after');
  if (!SHA256.test(assertions.before.selected_assets_hash ?? '') || !SHA256.test(assertions.after.selected_assets_hash ?? '') || !requireString(assertions.before.target_revision, 'assertions.before.target_revision') || !requireString(assertions.after.target_revision, 'assertions.after.target_revision') || !assertions.fence || !requireString(assertions.server_head, 'assertions.server_head')) throw contractError('receipt assertions are incomplete');
  if (!binding) return;
  if (assertions.after.selected_assets_hash !== binding.selected_assets_hash) throw contractError('receipt after asset hash does not match bound selection');
  if (canonicalJson(assertions.fence) !== canonicalJson(binding.fence)) throw contractError('receipt fence does not match bound fence');
  if (assertions.server_head !== binding.server_head) throw contractError('receipt server head does not match bound head');
}

function parseTime(value, field) {
  const text = requireString(value, field);
  if (!UTC.test(text)) throw contractError(`${field} must be UTC milliseconds timestamp`);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw contractError(`${field} must be an ISO timestamp`);
  return time;
}

/** Return the complete immutable CAS tuple and its canonical hash. */
export function planBinding(plan) {
  assertPlainValue(plan);
  assertExactKeys(plan, new Set([...BINDING_FIELDS, ...BINDING_DERIVED_FIELDS]), 'plan');
  const binding = {};
  for (const field of BINDING_FIELDS) {
    const value = plan[field];
    if (value == null) throw contractError(`${field} is required`);
    if (field === 'source_commit' && !GIT_COMMIT.test(value ?? '')) throw contractError('source_commit must be an exact Git commit');
    if (field === 'asset_policy_hash' && !SHA256.test(value ?? '')) throw contractError('asset_policy_hash must be sha256');
    if (field === 'selected_assets' && (!Array.isArray(value) || value.some((item) => { assertExactKeys(item, ASSET_KEYS, 'selected_assets item'); assertRelativeAssetPath(item.path); return !SHA256.test(item.sha256 ?? ''); }))) throw contractError('selected_assets hashes must be sha256');
    if (field === 'fence') { assertExactKeys(value, FENCE_KEYS, 'fence'); if (!Number.isSafeInteger(value.generation) || !requireString(value.lease_holder, 'fence.lease_holder') || !requireString(value.lease_id, 'fence.lease_id')) throw contractError('fence is invalid'); }
    if (field === 'source_descriptor') { try { validateDescriptor(value); } catch { throw contractError('source_descriptor is invalid'); } }
    if (field === 'rollback') { assertExactKeys(value, ROLLBACK_KEYS, 'rollback'); requireString(value.snapshot_id, 'rollback.snapshot_id'); requireString(value.expected_target_revision, 'rollback.expected_target_revision'); }
    binding[field] = structuredClone(value);
  }
  const binding_hash = sha256(canonicalJson(binding));
  const result = { version: 'machine-apply-binding/2', ...binding, selected_assets_hash: sha256(canonicalJson(binding.selected_assets)), binding_hash, plan_hash: binding_hash };
  for (const field of BINDING_DERIVED_FIELDS) {
    if (plan[field] != null && plan[field] !== result[field]) throw contractError(`binding ${field} is invalid`);
  }
  return result;
}

function unsignedApproval(approval) {
  const { signature, ...unsigned } = approval ?? {};
  return unsigned;
}

export function approvalSigningBytes(approval) {
  return Buffer.from(canonicalJson(unsignedApproval(approval)));
}

/**
 * Verify approval evidence against a registered issuer identity. `resolvePublicIdentity`
 * is deliberately injected: approval-supplied public keys are never authority.
 */
export function verifyApproval(plan, approval, { now = new Date().toISOString(), resolvePublicIdentity } = {}) {
  const binding = planBinding(plan);
  assertPlainValue(approval);
  assertExactKeys(approval, APPROVAL_KEYS, 'approval');
  if (approval?.version !== 'machine-apply-approval/2') throw contractError('unsupported approval version');
  const issuer = requireString(approval.issuer_identity, 'issuer_identity');
  if (approval.issuer_role !== 'decisive') throw contractError('approval issuer must be Decisive');
  requireApprovalRecord(approval.approval_record_id);
  if (!SHA256.test(approval.binding_hash ?? '')) throw contractError('approval binding_hash must be sha256');
  if (approval.binding_hash !== binding.binding_hash || canonicalJson(approval.binding) !== canonicalJson(binding)) throw contractError('approval binding hash does not match complete bound tuple');
  if (!NONCE.test(approval.nonce ?? '')) throw contractError('approval nonce is invalid');
  const issuedAt = parseTime(approval.issued_at, 'issued_at');
  const expiresAt = parseTime(approval.expires_at, 'expires_at');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 4 * 60 * 60 * 1000) throw contractError('approval validity must be at most four hours');
  const nowAt = parseTime(typeof now === 'string' ? now : new Date(now).toISOString(), 'now');
  if (issuedAt > nowAt) throw contractError('approval is future-issued');
  if (nowAt > expiresAt) throw contractError('approval has expired');
  if (typeof resolvePublicIdentity !== 'function') throw contractError('registered identity resolver is required');
  const publicIdentity = resolvePublicIdentity(issuer);
  if (!publicIdentity || publicIdentity.status !== 'registered' || !Array.isArray(publicIdentity.roles)) throw contractError('approval issuer registered identity record is required');
  if (!publicIdentity.roles.includes('decisive')) throw contractError('approval issuer must be Decisive');
  if (typeof approval.signature !== 'string' || !approval.signature) throw contractError('approval signature is required');
  let signatureValid = false;
  try {
    const key = createPublicKey(publicIdentity.public_key);
    if (key.asymmetricKeyType !== 'ed25519') throw contractError('approval identity key must be Ed25519');
    signatureValid = verify(null, approvalSigningBytes(approval), key, Buffer.from(approval.signature, 'base64'));
  } catch (err) {
    if (err?.name === 'MachineApplyContractError') throw err;
    throw contractError('approval signature is invalid');
  }
  if (!signatureValid) throw contractError('approval signature is invalid');
  return { ...binding, nonce: approval.nonce, approval_record_id: approval.approval_record_id, issuer_identity: issuer, expires_at: approval.expires_at };
}

/**
 * The apply coordinator must call this immediately before its state-changing CAS.
 * `consumeApproval` is a control-plane transaction that must atomically make the
 * nonce unavailable while binding it to `plan_hash`; a local Set is not adequate.
 */
export async function verifyAndConsumeApproval(plan, approval, options = {}) {
  const verified = verifyApproval(plan, approval, options);
  if (typeof options.consumeApproval !== 'function') throw contractError('atomic approval consumer is required');
  const request = deepFreeze({ approval_record_id: verified.approval_record_id, nonce: verified.nonce, binding: planBinding(plan), expires_at: verified.expires_at });
  const consumed = await options.consumeApproval(request);
  if (!consumed || consumed.status !== 'consumed') throw contractError('approval atomic consume status is not consumed');
  return verified;
}

function unsignedReceipt(receipt) {
  const { signature, receipt_hash, ...unsigned } = receipt ?? {};
  return unsigned;
}

function receiptHash(receipt) {
  const { receipt_hash, ...hashable } = receipt;
  return sha256(canonicalJson(hashable));
}

export function receiptSigningBytes(receipt) {
  return Buffer.from(canonicalJson(unsignedReceipt(receipt)));
}

export function createReceipt({ plan, approval_record_id, approval_nonce, signer_identity, signer_role, phase, assertions, previous_receipt_hash = null, created_at = new Date().toISOString(), sign }) {
  const binding = planBinding(plan);
  if (!NONCE.test(approval_nonce ?? '')) throw contractError('receipt approval_nonce is invalid');
  requireString(signer_identity, 'signer_identity');
  requireApprovalRecord(approval_record_id);
  if (signer_role !== 'machine' && signer_role !== 'coordinator') throw contractError('receipt signer role is invalid');
  if (!RECEIPT_PHASES.has(phase)) throw contractError('receipt phase is invalid');
  parseTime(created_at, 'created_at');
  assertPlainValue(assertions); assertReceiptAssertions(assertions, binding);
  if (previous_receipt_hash !== null && !SHA256.test(previous_receipt_hash)) throw contractError('previous_receipt_hash must be sha256 or null');
  if (typeof sign !== 'function') throw contractError('receipt signer is required');
  const receipt = {
    version: 'machine-apply-receipt/1', plan_hash: binding.plan_hash, approval_nonce,
    binding, approval_record_id, signer_identity, signer_role, phase, assertions, previous_receipt_hash, created_at, signature: null,
  };
  receipt.signature = sign(receiptSigningBytes(receipt));
  if (typeof receipt.signature !== 'string' || !receipt.signature) throw contractError('receipt signer returned no signature');
  receipt.receipt_hash = receiptHash(receipt);
  return receipt;
}

export function verifyReceipt(receipt, { resolvePublicIdentity } = {}) {
  assertPlainValue(receipt);
  assertExactKeys(receipt, RECEIPT_KEYS, 'receipt');
  if (receipt?.version !== 'machine-apply-receipt/1') throw contractError('unsupported receipt version');
  if (!SHA256.test(receipt.plan_hash ?? '') || !SHA256.test(receipt.receipt_hash ?? '')) throw contractError('receipt hashes must be sha256');
  const binding = planBinding(receipt.binding);
  if (binding.plan_hash !== receipt.plan_hash) throw contractError('receipt plan hash does not match its complete bound tuple');
  if (!NONCE.test(receipt.approval_nonce ?? '')) throw contractError('receipt approval_nonce is invalid');
  requireApprovalRecord(receipt.approval_record_id);
  parseTime(receipt.created_at, 'created_at');
  if (!RECEIPT_PHASES.has(receipt.phase)) throw contractError('receipt phase is invalid');
  if (receipt.signer_role !== 'machine' && receipt.signer_role !== 'coordinator') throw contractError('receipt signer role is invalid');
  assertReceiptAssertions(receipt.assertions, binding);
  if (receipt.previous_receipt_hash !== null && !SHA256.test(receipt.previous_receipt_hash ?? '')) throw contractError('previous_receipt_hash must be sha256 or null');
  if (typeof resolvePublicIdentity !== 'function') throw contractError('registered identity resolver is required');
  const publicIdentity = resolvePublicIdentity(requireString(receipt.signer_identity, 'signer_identity'));
  if (!publicIdentity || publicIdentity.status !== 'registered' || !Array.isArray(publicIdentity.roles) || !publicIdentity.roles.includes(receipt.signer_role)) throw contractError('receipt signer role is not registered');
  if (typeof receipt.signature !== 'string' || !receipt.signature) throw contractError('receipt signature is required');
  let signatureValid = false;
  try {
    const key = createPublicKey(publicIdentity.public_key);
    if (key.asymmetricKeyType !== 'ed25519') throw contractError('receipt identity key must be Ed25519');
    signatureValid = verify(null, receiptSigningBytes(receipt), key, Buffer.from(receipt.signature, 'base64'));
  } catch (err) {
    if (err?.name === 'MachineApplyContractError') throw err;
    throw contractError('receipt signature is invalid');
  }
  if (!signatureValid) throw contractError('receipt signature is invalid');
  if (receipt.receipt_hash !== receiptHash(receipt)) throw contractError('receipt hash is invalid');
  return receipt;
}

/** Append through the control-plane's atomic chain CAS; evidence is never authority. */
export async function appendVerifiedReceipt(receipt, { resolvePublicIdentity, appendReceipt } = {}) {
  const verified = verifyReceipt(receipt, { resolvePublicIdentity });
  if (typeof appendReceipt !== 'function') throw contractError('atomic receipt appender is required');
  const request = deepFreeze({
    approval_record_id: verified.approval_record_id,
    expected_previous_receipt_hash: verified.previous_receipt_hash,
    receipt: structuredClone(verified),
  });
  const result = await appendReceipt(request);
  if (!result || result.status !== 'appended' || result.head_receipt_hash !== verified.receipt_hash) throw contractError('receipt append head mismatch');
  return verified;
}
