import { findRawSecretViolations, isTypedOpaqueReference } from './security.js';
import { ADAPTER_CONTRACT_VERSION, ITEM_RESULT_STATUSES, STATE_CLASSES } from './types.js';
import { normalizePortableRelativePath } from './portable-path.js';
import { inventoryInvariantErrors, itemInvariantErrors } from './item-invariants.js';

export const INVENTORY_REPORT_VERSION = `${ADAPTER_CONTRACT_VERSION}`;
export const INVENTORY_DIFF_VERSION = `${ADAPTER_CONTRACT_VERSION}`;
export const INVENTORY_DISPOSITIONS = Object.freeze(['captured', 'referenced', 'excluded', 'manual_review']);

const STATE_CLASS_SET = new Set(STATE_CLASSES);
const DISPOSITION_SET = new Set(INVENTORY_DISPOSITIONS);
const DURABILITIES = new Set(['required', 'potentially_durable', 'non_durable']);
const SEMANTIC_ROLES = new Set(['durable', 'lock', 'pid', 'active_lease', 'pending_approval', 'live_harness_state']);
const ITEM_KINDS = new Set(['file', 'directory', 'symlink', 'hardlink', 'database', 'logical_record', 'native_archive', 'unsupported']);
const CAPTURE_METHODS = new Set(['native_command', 'safe_filesystem', 'database_api', 'reference_only', 'excluded', 'manual_action']);
const SENSITIVITIES = new Set(['ordinary', 'personal', 'confidential', 'secret_metadata']);
const RESTORE_POLICIES = new Set(['restore', 'recreate', 'redeem', 're_enroll', 'skip', 'unsupported', 'manual_review']);
const SUPPORT_STATUSES = new Set(['draft', 'unsupported', 'manual_review']);
const ITEM_RESULT_SET = new Set(ITEM_RESULT_STATUSES);
const POLICY_REF_RE = /^policy:\/\/[A-Za-z0-9._~/-]+$/;
const HEX_256_RE = /^[a-f0-9]{64}$/;
const LOGICAL_ROOT_RE = /^[a-z0-9][a-z0-9._-]*$/;
const LOGICAL_STORE_ID_RE = /^(?!.*\.\.)[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_PATH_DECODE_LAYERS = 8;

const INPUT_KEYS = new Set(['logical_roots', 'discovered_items', 'classified_items', 'policy_decisions', 'adapter_identity', 'support']);
const REPORT_KEYS = new Set([
  'report_version', 'qualification_status', 'recoverable', 'complete_accounting', 'adapter_identity', 'support',
  'logical_roots', 'items', 'policy_decisions', 'accounting', 'remediation',
]);
const ITEM_KEYS = new Set([
  'item_id', 'logical_root', 'relative_path', 'logical_store_id', 'kind', 'discovered_kind', 'state_class',
  'durability', 'semantic_role', 'size_bytes', 'checksum', 'capture_method', 'sensitivity', 'restore_policy',
  'provenance', 'reason', 'reason_code', 'disposition', 'result_status', 'policy_decision_ref', 'link', 'capture',
  'external_reference', 'hardlink', 'hardlink_to', 'collision_types',
]);
const CLASSIFICATION_POLICY_FIELDS = new Set([
  'state_class', 'durability', 'semantic_role', 'capture_method', 'restore_policy', 'disposition',
  'policy_decision_ref', 'reason_code',
]);

function fail(message) {
  throw new TypeError(message);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPlain(value, path) {
  if (!isPlainRecord(value)) fail(`${path} must be a plain object with own properties`);
}

function rejectUnknown(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(compareCodeUnits);
  if (unknown.length > 0) fail(`${path} contains unsupported fields: ${unknown.join(', ')}`);
}

function requireOwnString(value, key, path) {
  if (!own(value, key) || !nonEmptyString(value[key])) fail(`${path}.${key} must be an own non-empty string`);
}

function decodePathMaterial(value) {
  let decoded = value;
  let malformed = false;
  for (let attempt = 0; attempt < MAX_PATH_DECODE_LAYERS; attempt += 1) {
    if (/%(?![0-9A-Fa-f]{2})/.test(decoded) && /%[0-9A-Za-z]{2}/.test(decoded)) malformed = true;
    const next = decoded.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) return { decoded, malformed, decodeLimitReached: false };
    decoded = next;
  }
  return { decoded, malformed, decodeLimitReached: /%[0-9A-Fa-f]{2}/.test(decoded) };
}

function containsUnsafePathMaterial(value) {
  if (isTypedOpaqueReference(value)) return false;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol)) return Boolean(url.username || url.password);
  } catch {
    // Non-URL strings continue through portable path-material checks.
  }
  const { decoded, malformed, decodeLimitReached } = decodePathMaterial(value);
  const trimmed = decoded.trim();
  return malformed || decodeLimitReached || /[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(decoded) ||
    trimmed === '/' || trimmed.startsWith('//') || /(?:^|[\s("'=])\/\/[^/\s]+\/[^\s]+/.test(decoded) ||
    /(?:^|[\s:=("'])(?:file:\/\/\/|\/(?!\/)[^\s]*|[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\/][^\s]+)/.test(decoded) ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(decoded);
}

function validatePortableRelativePath(value, path) {
  if (!nonEmptyString(value)) fail(`${path} must be a non-empty portable relative path`);
  const { decoded, malformed, decodeLimitReached } = decodePathMaterial(value);
  try {
    normalizePortableRelativePath(value);
    normalizePortableRelativePath(decoded);
  } catch {
    fail(`${path} must be a normalized portable relative path without absolute or traversal material`);
  }
  if (malformed || decodeLimitReached) fail(`${path} must be a normalized portable relative path without absolute or traversal material`);
}

function validateLogicalStoreId(value, path) {
  if (!nonEmptyString(value) || !LOGICAL_STORE_ID_RE.test(value) || value.includes('..') ||
      containsUnsafePathMaterial(value)) {
    fail(`${path} must be a typed machine-neutral identifier without absolute, traversal, encoded, or control material`);
  }
}

function assertNoSecrets(value, label, { inventoryAccounting = false } = {}) {
  const violations = findRawSecretViolations(value, {
    ...(inventoryAccounting ? { accountingContext: 'inventory_report' } : {}),
  });
  if (violations.length > 0) fail(`${label} contains raw secret material at: ${violations.join(', ')}`);
  const machinePaths = [];
  const ancestors = new Map();
  function visit(current, path) {
    if (typeof current === 'string') {
      if (containsUnsafePathMaterial(current)) machinePaths.push(path);
      return;
    }
    if (current && typeof current === 'object') {
      if (ancestors.has(current)) fail(`${path} contains a cycle referencing ${ancestors.get(current)}`);
      ancestors.set(current, path);
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      ancestors.delete(current);
      return;
    }
    if (current && typeof current === 'object') {
      Object.keys(current).sort(compareCodeUnits).forEach((key) => visit(current[key], `${path}.${key}`));
      ancestors.delete(current);
    }
  }
  visit(value, '$');
  if (machinePaths.length > 0) fail(`${label} contains machine-specific path material at: ${machinePaths.join(', ')}`);
}

function clone(value) {
  return structuredClone(value);
}

function sortByItemId(left, right) {
  return compareCodeUnits(left.item_id, right.item_id);
}

function validateChecksum(value, path) {
  assertPlain(value, path);
  rejectUnknown(value, new Set(['policy', 'algorithm', 'digest']), path);
  if (!['required', 'metadata_only', 'not_applicable'].includes(value.policy)) fail(`${path}.policy is invalid`);
  if (value.policy === 'required') {
    if (!['sha256', 'hmac-sha256'].includes(value.algorithm) || !HEX_256_RE.test(value.digest)) {
      fail(`${path} required checksums need a supported algorithm and lowercase 256-bit digest`);
    }
  } else if (value.algorithm != null || value.digest != null) {
    fail(`${path} metadata-only or inapplicable checksums must not contain payload digest material`);
  }
}

function validateKnownNestedObject(value, path, allowed) {
  assertPlain(value, path);
  rejectUnknown(value, allowed, path);
}

function validateClassifiedItem(value, index) {
  const path = `classified_items[${index}]`;
  assertPlain(value, path);
  rejectUnknown(value, ITEM_KEYS, path);
  for (const key of ['item_id', 'logical_root', 'kind', 'state_class', 'durability', 'semantic_role', 'capture_method', 'sensitivity', 'restore_policy', 'reason', 'disposition']) {
    requireOwnString(value, key, path);
  }
  if (!LOGICAL_ROOT_RE.test(value.logical_root)) fail(`${path}.logical_root must be a machine-neutral identifier`);
  const hasPath = own(value, 'relative_path') && nonEmptyString(value.relative_path);
  const hasStore = own(value, 'logical_store_id') && nonEmptyString(value.logical_store_id);
  if (hasPath === hasStore) fail(`${path} must contain exactly one portable locator`);
  if (hasPath) validatePortableRelativePath(value.relative_path, `${path}.relative_path`);
  if (hasStore) validateLogicalStoreId(value.logical_store_id, `${path}.logical_store_id`);
  if (!ITEM_KINDS.has(value.kind)) fail(`${path}.kind is invalid`);
  if (!STATE_CLASS_SET.has(value.state_class)) fail(`${path}.state_class is invalid`);
  if (!DURABILITIES.has(value.durability)) fail(`${path}.durability is invalid`);
  if (!SEMANTIC_ROLES.has(value.semantic_role)) fail(`${path}.semantic_role is invalid`);
  if (!Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0) fail(`${path}.size_bytes must be a non-negative safe integer`);
  if (!own(value, 'checksum')) fail(`${path}.checksum must be an own property`);
  validateChecksum(value.checksum, `${path}.checksum`);
  if (!CAPTURE_METHODS.has(value.capture_method)) fail(`${path}.capture_method is invalid`);
  if (!SENSITIVITIES.has(value.sensitivity)) fail(`${path}.sensitivity is invalid`);
  if (!RESTORE_POLICIES.has(value.restore_policy)) fail(`${path}.restore_policy is invalid`);
  if (!DISPOSITION_SET.has(value.disposition)) fail(`${path}.disposition is invalid`);
  validateKnownNestedObject(value.provenance, `${path}.provenance`, new Set(['source', 'native_artifact_id']));
  requireOwnString(value.provenance, 'source', `${path}.provenance`);
  if (value.provenance.native_artifact_id != null && !nonEmptyString(value.provenance.native_artifact_id)) fail(`${path}.provenance.native_artifact_id is invalid`);
  if (value.result_status != null && !ITEM_RESULT_SET.has(value.result_status)) fail(`${path}.result_status is invalid`);
  if (value.link != null) {
    validateKnownNestedObject(value.link, `${path}.link`, new Set(['target_type', 'target_recorded', 'target']));
    requireOwnString(value.link, 'target_type', `${path}.link`);
    if (!['absolute', 'relative', 'unknown', 'unsafe'].includes(value.link.target_type)) fail(`${path}.link.target_type is invalid`);
    if (typeof value.link.target_recorded !== 'boolean') fail(`${path}.link.target_recorded must be a boolean`);
    if (value.link.target_recorded === true) validatePortableRelativePath(value.link.target, `${path}.link.target`);
    if (value.link.target_recorded !== true && value.link.target != null) fail(`${path}.link.target must be omitted when not recorded`);
  }
  if (value.capture != null) {
    validateKnownNestedObject(value.capture, `${path}.capture`, new Set(['follow', 'external_root']));
    if (typeof value.capture.follow !== 'boolean') fail(`${path}.capture.follow must be a boolean`);
    if (value.capture.follow === true && !nonEmptyString(value.capture.external_root)) fail(`${path}.capture.external_root must be a non-empty string when following`);
    if (value.capture.follow === false && value.capture.external_root != null) fail(`${path}.capture.external_root must be omitted when not following`);
  }
  if (value.external_reference != null) {
    validateKnownNestedObject(value.external_reference, `${path}.external_reference`, new Set(['logical_root', 'relative_path']));
    requireOwnString(value.external_reference, 'logical_root', `${path}.external_reference`);
    if (!LOGICAL_ROOT_RE.test(value.external_reference.logical_root)) fail(`${path}.external_reference.logical_root must be a machine-neutral identifier`);
    validatePortableRelativePath(value.external_reference.relative_path, `${path}.external_reference.relative_path`);
  }
  if (value.hardlink != null) {
    validateKnownNestedObject(value.hardlink, `${path}.hardlink`, new Set(['status']));
    requireOwnString(value.hardlink, 'status', `${path}.hardlink`);
    if (!['complete', 'incomplete'].includes(value.hardlink.status)) fail(`${path}.hardlink.status is invalid`);
  }
  if (value.hardlink_to != null) {
    validateKnownNestedObject(value.hardlink_to, `${path}.hardlink_to`, new Set(['logical_root', 'relative_path']));
    requireOwnString(value.hardlink_to, 'logical_root', `${path}.hardlink_to`);
    if (!LOGICAL_ROOT_RE.test(value.hardlink_to.logical_root)) fail(`${path}.hardlink_to.logical_root must be a machine-neutral identifier`);
    validatePortableRelativePath(value.hardlink_to.relative_path, `${path}.hardlink_to.relative_path`);
  }
  if (value.collision_types != null && (!Array.isArray(value.collision_types) || value.collision_types.length === 0 ||
      new Set(value.collision_types).size !== value.collision_types.length ||
      value.collision_types.some((entry, collisionIndex) => !own(value.collision_types, collisionIndex) ||
        !['exact', 'case_only', 'path_normalization'].includes(entry)))) {
    fail(`${path}.collision_types must be an array of strings`);
  }
  if (value.state_class === 'secret' && value.checksum.policy === 'required') fail(`${path} secret state must not contain a payload checksum`);
  const invariantErrors = itemInvariantErrors(value, path);
  if (invariantErrors.length > 0) fail(invariantErrors[0]);
  return clone(value);
}

function validateAdapterIdentity(value, path = 'adapter_identity') {
  assertPlain(value, path);
  rejectUnknown(value, new Set(['runtime_family', 'name', 'version', 'contract_version']), path);
  for (const key of ['runtime_family', 'name', 'version', 'contract_version']) requireOwnString(value, key, path);
  if (value.contract_version !== ADAPTER_CONTRACT_VERSION) fail(`${path}.contract_version must be ${ADAPTER_CONTRACT_VERSION}`);
  return clone(value);
}

function validateSupport(value, path = 'support') {
  assertPlain(value, path);
  rejectUnknown(value, new Set(['status', 'matrix_revision']), path);
  requireOwnString(value, 'status', path);
  requireOwnString(value, 'matrix_revision', path);
  if (!SUPPORT_STATUSES.has(value.status)) fail(`${path}.status must not claim supported before M0 qualification`);
  return clone(value);
}

function validateLogicalRoots(value, path = 'logical_roots') {
  if (!Array.isArray(value) || value.length === 0) fail(`${path} must be a non-empty array`);
  const ids = new Set();
  const allowed = new Set(['id', 'kind', 'provider', 'ownership', 'approved_destination_class', 'containment_policy', 'restoration_requirements']);
  const externalFields = ['provider', 'ownership', 'approved_destination_class', 'containment_policy', 'restoration_requirements'];
  const roots = value.map((root, index) => {
    const rootPath = `${path}[${index}]`;
    assertPlain(root, rootPath);
    rejectUnknown(root, allowed, rootPath);
    requireOwnString(root, 'id', rootPath);
    requireOwnString(root, 'kind', rootPath);
    if (!LOGICAL_ROOT_RE.test(root.id)) fail(`${rootPath}.id must be a machine-neutral identifier`);
    if (ids.has(root.id)) fail(`${rootPath}.id is duplicated`);
    ids.add(root.id);
    if (!['runtime', 'workspace', 'profile', 'external_provider', 'logical_store'].includes(root.kind)) fail(`${rootPath}.kind is invalid`);
    if (root.kind === 'external_provider') {
      for (const field of ['provider', 'ownership']) requireOwnString(root, field, rootPath);
      if (root.approved_destination_class !== 'external_state') fail(`${rootPath}.approved_destination_class must be external_state`);
      if (root.containment_policy !== 'realpath_within_root') fail(`${rootPath}.containment_policy must be realpath_within_root`);
      if (!Array.isArray(root.restoration_requirements) || root.restoration_requirements.length === 0 ||
          root.restoration_requirements.some((entry, requirementIndex) => !own(root.restoration_requirements, requirementIndex) || !nonEmptyString(entry))) {
        fail(`${rootPath}.restoration_requirements must contain non-empty strings`);
      }
    } else if (externalFields.some((field) => root[field] != null)) {
      fail(`${rootPath} external provider fields are only valid for external_provider roots`);
    }
    return clone(root);
  });
  return roots.sort((left, right) => compareCodeUnits(left.id, right.id));
}

function validatePolicyDecision(value, index) {
  const path = `policy_decisions[${index}]`;
  assertPlain(value, path);
  rejectUnknown(value, new Set(['decision_ref', 'item_id', 'action', 'reason']), path);
  for (const key of ['decision_ref', 'item_id', 'action', 'reason']) requireOwnString(value, key, path);
  if (!POLICY_REF_RE.test(value.decision_ref)) fail(`${path}.decision_ref must be a stable policy:// reference`);
  if (value.action !== 'exclude') fail(`${path}.action must be exclude`);
  return clone(value);
}

function zeroMap(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function accountingFor(items, discoveredCount) {
  const countsByClass = zeroMap(STATE_CLASSES);
  const bytesByClass = zeroMap(STATE_CLASSES);
  const countsByDisposition = zeroMap(INVENTORY_DISPOSITIONS);
  const bytesByDisposition = zeroMap(INVENTORY_DISPOSITIONS);
  for (const item of items) {
    countsByClass[item.state_class] += 1;
    bytesByClass[item.state_class] += item.size_bytes;
    countsByDisposition[item.disposition] += 1;
    bytesByDisposition[item.disposition] += item.size_bytes;
    if (!Number.isSafeInteger(bytesByClass[item.state_class]) || !Number.isSafeInteger(bytesByDisposition[item.disposition])) {
      fail('inventory accounting byte totals exceed the maximum safe integer');
    }
  }
  return {
    discovered_items: discoveredCount,
    accounted_items: items.length,
    counts_by_class: countsByClass,
    bytes_by_class: bytesByClass,
    counts_by_disposition: countsByDisposition,
    bytes_by_disposition: bytesByDisposition,
  };
}

/**
 * Qualify already-discovered classifier output for manifest construction.
 * Source identities and classified identities must be the same unique set.
 *
 * @param {unknown} raw
 */
export function qualifyInventory(raw) {
  canonicalize(raw, 'inventory qualification input');
  assertNoSecrets(raw, 'inventory qualification input');
  assertPlain(raw, 'inventory qualification input');
  rejectUnknown(raw, INPUT_KEYS, 'inventory qualification input');
  for (const key of ['logical_roots', 'discovered_items', 'classified_items', 'policy_decisions']) {
    if (!own(raw, key) || !Array.isArray(raw[key])) fail(`inventory qualification input.${key} must be an own array`);
  }
  const logicalRoots = validateLogicalRoots(raw.logical_roots);
  const rootsById = new Map(logicalRoots.map((root) => [root.id, root]));
  const adapterIdentity = validateAdapterIdentity(raw.adapter_identity);
  const support = validateSupport(raw.support);

  const discoveredIds = new Set();
  raw.discovered_items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || !own(entry, 'item_id')) fail(`discovered_items[${index}] must contain an own item_id property`);
    assertPlain(entry, `discovered_items[${index}]`);
    rejectUnknown(entry, new Set(['item_id']), `discovered_items[${index}]`);
    requireOwnString(entry, 'item_id', `discovered_items[${index}]`);
    if (discoveredIds.has(entry.item_id)) fail(`discovered item_id ${entry.item_id} is duplicated`);
    discoveredIds.add(entry.item_id);
  });
  const classifiedIds = new Set();
  const items = raw.classified_items.map((entry, index) => {
    const item = validateClassifiedItem(entry, index);
    if (item.state_class === 'manual_review' && item.disposition === 'excluded') {
      fail(`classified_items[${index}] manual_review exclusions require a recorded policy_decisions entry and cannot be pre-excluded`);
    }
    if (classifiedIds.has(item.item_id)) fail(`classified item_id ${item.item_id} is duplicated`);
    classifiedIds.add(item.item_id);
    return item;
  });
  const missing = [...classifiedIds].filter((id) => !discoveredIds.has(id)).sort(compareCodeUnits);
  const unaccounted = [...discoveredIds].filter((id) => !classifiedIds.has(id)).sort(compareCodeUnits);
  if (missing.length > 0) fail(`classified identities are missing from source discovery: ${missing.join(', ')}`);
  if (unaccounted.length > 0) fail(`source identities are unaccounted: ${unaccounted.join(', ')}`);

  const decisionRefs = new Set();
  const decisionItems = new Set();
  const decisions = raw.policy_decisions.map((entry, index) => {
    const decision = validatePolicyDecision(entry, index);
    if (decisionRefs.has(decision.decision_ref)) fail(`policy decision_ref ${decision.decision_ref} is duplicated`);
    if (decisionItems.has(decision.item_id)) fail(`policy decision for item_id ${decision.item_id} is duplicated`);
    decisionRefs.add(decision.decision_ref);
    decisionItems.add(decision.item_id);
    return decision;
  }).sort(sortByItemId);

  const byId = new Map(items.map((item) => [item.item_id, item]));
  for (const decision of decisions) {
    const item = byId.get(decision.item_id);
    if (!item) fail(`policy decision ${decision.decision_ref} references an undiscovered item`);
    if (item.state_class !== 'manual_review') fail(`policy decision ${decision.decision_ref} may exclude only manual_review state`);
    if (item.disposition !== 'manual_review' || item.capture_method !== 'manual_action') {
      fail(`policy decision ${decision.decision_ref} requires unresolved manual_review state`);
    }
    Object.assign(item, {
      disposition: 'excluded', capture_method: 'excluded', restore_policy: 'skip',
      policy_decision_ref: decision.decision_ref, reason: decision.reason,
    });
  }
  items.sort(sortByItemId);
  const crossItemErrors = inventoryInvariantErrors(items, rootsById, 'classified_items');
  if (crossItemErrors.length > 0) fail(crossItemErrors[0]);

  const unresolved = items.filter((item) => item.state_class === 'manual_review' && item.disposition === 'manual_review');
  const blocking = unresolved.filter((item) => item.durability === 'required' || item.durability === 'potentially_durable');
  const remediation = unresolved.map((item) => ({
    item_id: item.item_id,
    code: item.reason_code ?? 'MANUAL_REVIEW_REQUIRED',
    action: 'Add an adapter classification rule or record an explicit operator exclusion policy decision.',
    message: item.reason,
  })).sort(sortByItemId);
  const report = {
    report_version: INVENTORY_REPORT_VERSION,
    qualification_status: blocking.length > 0 ? 'manual_review' : 'unqualified',
    recoverable: false,
    complete_accounting: true,
    adapter_identity: adapterIdentity,
    support,
    logical_roots: logicalRoots,
    items,
    policy_decisions: decisions,
    accounting: accountingFor(items, discoveredIds.size),
    remediation,
  };
  validateReport(report, 'inventory report');
  return report;
}

function validateReport(value, label) {
  canonicalize(value, label);
  assertPlain(value, label);
  rejectUnknown(value, REPORT_KEYS, label);
  if (value.report_version !== INVENTORY_REPORT_VERSION) fail(`${label}.report_version is unsupported`);
  if (!['unqualified', 'manual_review'].includes(value.qualification_status)) fail(`${label}.qualification_status is invalid`);
  if (value.recoverable !== false) fail(`${label}.recoverable must remain false before M0 qualification`);
  if (value.complete_accounting !== true) fail(`${label}.complete_accounting must be true`);
  const adapterIdentity = validateAdapterIdentity(value.adapter_identity, `${label}.adapter_identity`);
  const support = validateSupport(value.support, `${label}.support`);
  const logicalRoots = validateLogicalRoots(value.logical_roots, `${label}.logical_roots`);
  const rootsById = new Map(logicalRoots.map((root) => [root.id, root]));
  if (!Array.isArray(value.items) || !Array.isArray(value.policy_decisions) || !Array.isArray(value.remediation)) fail(`${label} arrays are malformed`);
  const items = value.items.map((entry, index) => validateClassifiedItem(entry, index)).sort(sortByItemId);
  const decisions = value.policy_decisions.map((entry, index) => validatePolicyDecision(entry, index)).sort(sortByItemId);
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.item_id)) fail(`${label} item_id ${item.item_id} is duplicated`);
    ids.add(item.item_id);
  }
  const crossItemErrors = inventoryInvariantErrors(items, rootsById, `${label}.items`);
  if (crossItemErrors.length > 0) fail(crossItemErrors[0]);
  const decisionRefs = new Set();
  const decisionItems = new Set();
  for (const decision of decisions) {
    if (decisionRefs.has(decision.decision_ref) || decisionItems.has(decision.item_id)) fail(`${label} policy evidence is duplicated`);
    decisionRefs.add(decision.decision_ref);
    decisionItems.add(decision.item_id);
    const item = items.find((candidate) => candidate.item_id === decision.item_id);
    if (!item || item.state_class !== 'manual_review' || item.disposition !== 'excluded' ||
        item.capture_method !== 'excluded' || item.restore_policy !== 'skip' ||
        item.policy_decision_ref !== decision.decision_ref || item.reason !== decision.reason) {
      fail(`${label} policy evidence is inconsistent with its manifest-ready item`);
    }
  }
  for (const item of items) {
    if (item.policy_decision_ref != null && !decisionItems.has(item.item_id)) fail(`${label} item policy evidence is missing`);
  }
  assertPlain(value.accounting, `${label}.accounting`);
  rejectUnknown(value.accounting, new Set([
    'discovered_items', 'accounted_items', 'counts_by_class', 'bytes_by_class', 'counts_by_disposition', 'bytes_by_disposition',
  ]), `${label}.accounting`);
  const expectedAccounting = accountingFor(items, items.length);
  if (canonicalString(value.accounting) !== canonicalString(expectedAccounting)) fail(`${label}.accounting is inconsistent with its items`);
  const unresolved = items.filter((item) => item.state_class === 'manual_review' && item.disposition === 'manual_review');
  const blocking = unresolved.some((item) => item.durability === 'required' || item.durability === 'potentially_durable');
  const expectedQualification = blocking ? 'manual_review' : 'unqualified';
  if (value.qualification_status !== expectedQualification) fail(`${label}.qualification_status is inconsistent with unresolved items`);
  const expectedRemediation = unresolved.map((item) => ({
    item_id: item.item_id,
    code: item.reason_code ?? 'MANUAL_REVIEW_REQUIRED',
    action: 'Add an adapter classification rule or record an explicit operator exclusion policy decision.',
    message: item.reason,
  })).sort(sortByItemId);
  if (canonicalString(value.remediation) !== canonicalString(expectedRemediation)) fail(`${label}.remediation is inconsistent with unresolved items`);
  assertNoSecrets(value, label, { inventoryAccounting: true });
  return { adapter_identity: adapterIdentity, support, logical_roots: logicalRoots, items, policy_decisions: decisions };
}

function compareValues(before, after, prefix = '') {
  if (Object.is(before, after)) return [];
  if (before !== undefined && after !== undefined && canonicalString(before) === canonicalString(after)) return [];
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareCodeUnits);
    return keys.flatMap((key) => compareValues(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  return [{ field: prefix, ...(before !== undefined ? { before: clone(before) } : {}), ...(after !== undefined ? { after: clone(after) } : {}) }];
}

function policyByItem(decisions) {
  return new Map(decisions.map((decision) => [decision.item_id, decision]));
}

/** @param {unknown} beforeRaw @param {unknown} afterRaw */
export function diffInventoryReports(beforeRaw, afterRaw) {
  const before = validateReport(beforeRaw, 'before inventory report');
  const after = validateReport(afterRaw, 'after inventory report');
  const beforeItems = new Map(before.items.map((item) => [item.item_id, item]));
  const afterItems = new Map(after.items.map((item) => [item.item_id, item]));
  const additions = after.items.filter((item) => !beforeItems.has(item.item_id)).map(clone).sort(sortByItemId);
  const removals = before.items.filter((item) => !afterItems.has(item.item_id)).map(clone).sort(sortByItemId);
  const beforePolicy = policyByItem(before.policy_decisions);
  const afterPolicy = policyByItem(after.policy_decisions);
  const itemChanges = [];
  for (const itemId of [...beforeItems.keys()].filter((id) => afterItems.has(id)).sort(compareCodeUnits)) {
    const beforeItem = beforeItems.get(itemId);
    const afterItem = afterItems.get(itemId);
    const checksumChanges = compareValues(beforeItem.checksum, afterItem.checksum, 'checksum');
    const classificationPolicyChanges = [];
    for (const field of [...CLASSIFICATION_POLICY_FIELDS].sort(compareCodeUnits)) {
      classificationPolicyChanges.push(...compareValues(beforeItem[field], afterItem[field], field));
    }
    classificationPolicyChanges.push(...compareValues(beforePolicy.get(itemId), afterPolicy.get(itemId), 'policy_decision'));
    classificationPolicyChanges.sort((left, right) => compareCodeUnits(left.field, right.field));
    const metadataBefore = Object.fromEntries(Object.entries(beforeItem).filter(([key]) => key !== 'checksum' && !CLASSIFICATION_POLICY_FIELDS.has(key)));
    const metadataAfter = Object.fromEntries(Object.entries(afterItem).filter(([key]) => key !== 'checksum' && !CLASSIFICATION_POLICY_FIELDS.has(key)));
    const metadataChanges = compareValues(metadataBefore, metadataAfter).filter((change) => change.field !== 'item_id');
    if (metadataChanges.length || classificationPolicyChanges.length || checksumChanges.length) {
      itemChanges.push({
        item_id: itemId,
        metadata_changes: metadataChanges,
        classification_policy_changes: classificationPolicyChanges,
        checksum_changes: checksumChanges,
      });
    }
  }
  const adapterChanges = compareValues(before.adapter_identity, after.adapter_identity);
  const supportChanges = compareValues(before.support, after.support);
  const logicalRootChanges = compareValues(before.logical_roots, after.logical_roots, 'logical_roots');
  const diff = {
    diff_version: INVENTORY_DIFF_VERSION,
    changed: additions.length > 0 || removals.length > 0 || itemChanges.length > 0 || adapterChanges.length > 0 || supportChanges.length > 0 || logicalRootChanges.length > 0,
    additions,
    removals,
    item_changes: itemChanges,
    adapter_changes: adapterChanges,
    support_changes: supportChanges,
    logical_root_changes: logicalRootChanges,
  };
  assertNoSecrets(diff, 'inventory diff');
  return diff;
}

function canonicalize(value, path = '$') {
  return canonicalizeValue(value, path, new Map());
}

function canonicalizeValue(value, path, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) fail(`${path} contains a cycle referencing ${ancestors.get(value)}`);
    ancestors.set(value, path);
  }
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!own(value, index)) fail(`${path}[${index}] must not be a sparse array hole`);
      result.push(canonicalizeValue(value[index], `${path}[${index}]`, ancestors));
    }
    ancestors.delete(value);
    return result;
  }
  if (!isPlainRecord(value)) fail(`${path} must contain only deterministic JSON values`);
  const result = Object.fromEntries(Object.keys(value).sort(compareCodeUnits).map((key) => [key, canonicalizeValue(value[key], `${path}.${key}`, ancestors)]));
  ancestors.delete(value);
  return result;
}

function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

/** Serialize reports and diffs as canonical newline-terminated JSON. */
export function serializeInventoryArtifact(value) {
  canonicalize(value, 'inventory artifact');
  if (isPlainRecord(value) && own(value, 'report_version')) validateReport(value, 'inventory artifact');
  else assertNoSecrets(value, 'inventory artifact');
  return `${canonicalString(value)}\n`;
}
