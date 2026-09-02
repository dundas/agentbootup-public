import { isObject, nonEmptyString } from '../brain/validate-utils.js';
import { findRawSecretViolations, isTypedOpaqueReference } from './security.js';
import { ADAPTER_CONTRACT_VERSION, ITEM_RESULT_STATUSES, STATE_CLASSES } from './types.js';
import { isPortableRelativePath } from './portable-path.js';
import { inventoryInvariantErrors, itemInvariantErrors } from './item-invariants.js';

export const RUNTIME_BACKUP_SCHEMA_VERSION = '1.0.0';
export const PORTABLE_AGENT_CORE_SCHEMA_VERSION = '1.0.0';

const STATE_CLASS_SET = new Set(STATE_CLASSES);
const ITEM_RESULT_SET = new Set(ITEM_RESULT_STATUSES);
const HEX_256_RE = /^[a-f0-9]{64}$/;
const ROOT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const LOGICAL_STORE_ID_RE = /^(?!.*\.\.)[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DISPOSITIONS = Object.freeze(['captured', 'referenced', 'excluded', 'manual_review']);
const TOP_RUNTIME_KEYS = new Set([
  'schema_version', 'manifest_version', 'contract_status', 'qualification_status', 'runtime_identity', 'adapter_identity',
  'support', 'consistency', 'logical_roots', 'inventory', 'exclusions', 'native_artifacts',
  'dependency_pins', 'integrity', 'encryption', 'accounting', 'extensions',
]);
const TOP_PORTABLE_KEYS = new Set([
  'schema_version', 'manifest_version', 'contract_status', 'identity', 'instructions',
  'user_profile', 'memory', 'transcripts', 'skills', 'mcp_declarations', 'model_preferences',
  'schedules', 'credential_references', 'provenance', 'extensions',
]);
const FORBIDDEN_PORTABLE_KEYS = new Set([
  'runtime_databases', 'live_sessions', 'raw_credentials', 'channel_state', 'device_state', 'process_state',
]);

function checkObject(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  return true;
}

function checkUnknownKeys(value, allowed, path, errors) {
  if (!isObject(value)) return;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) errors.push(`${path} contains unsupported fields: ${unknown.join(', ')}`);
}

function strictJsonGraphErrors(value, path) {
  const errors = [];
  const ancestors = new Map();
  const stack = [{ value, path, exit: false }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.value === null || typeof current.value === 'string' || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value) || (Number.isInteger(current.value) && !Number.isSafeInteger(current.value))) {
        errors.push(`${current.path} must be a finite JSON number without unsafe integer precision loss`);
      }
      if (errors.length > 0) return errors;
      continue;
    }
    if (typeof current.value !== 'object') {
      errors.push(`${current.path} contains a non-JSON value`);
      return errors;
    }
    if (current.exit) {
      ancestors.delete(current.value);
      continue;
    }
    if (ancestors.has(current.value)) {
      errors.push(`${current.path} contains a cycle referencing ${ancestors.get(current.value)}`);
      return errors;
    }
    const isArray = Array.isArray(current.value);
    const prototype = Object.getPrototypeOf(current.value);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      errors.push(`${current.path} must be ${isArray ? 'a plain array' : 'a plain object with own properties'}`);
      return errors;
    }
    const keys = Reflect.ownKeys(current.value);
    if (keys.some((key) => typeof key === 'symbol')) {
      errors.push(`${current.path} must not contain symbol properties`);
      return errors;
    }
    ancestors.set(current.value, current.path);
    stack.push({ ...current, exit: true });
    if (isArray) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(current.value, 'length');
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        errors.push(`${current.path}.length must be an own safe-integer data property`);
        return errors;
      }
      const length = lengthDescriptor.value;
      const extra = keys.find((key) => key !== 'length' &&
        (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length));
      if (extra !== undefined) {
        errors.push(`${current.path} arrays must not contain extra properties`);
        return errors;
      }
      for (let index = length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
        if (!descriptor) {
          errors.push(`${current.path}[${index}] is a sparse array hole`);
          return errors;
        }
        if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          errors.push(`${current.path}[${index}] must be an own enumerable data property`);
          return errors;
        }
        stack.push({ value: descriptor.value, path: `${current.path}[${index}]`, exit: false });
      }
    } else {
      const stringKeys = keys.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (let index = stringKeys.length - 1; index >= 0; index -= 1) {
        const key = stringKeys[index];
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          errors.push(`${current.path}.${key} must be an own enumerable data property`);
          return errors;
        }
        stack.push({ value: descriptor.value, path: `${current.path}.${key}`, exit: false });
      }
    }
  }
  return errors;
}

function requireString(value, path, errors) {
  if (!nonEmptyString(value)) errors.push(`${path} must be a non-empty string`);
}

function optionalString(value, path, errors) {
  if (value != null && !nonEmptyString(value)) errors.push(`${path} must be a non-empty string`);
}

function requireStringArray(value, path, errors, { nonEmptyItems = false, minItems = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minItems || value.some((item) => typeof item !== 'string' || (nonEmptyItems && !nonEmptyString(item)))) {
    errors.push(`${path} must be an array of ${nonEmptyItems ? 'non-empty ' : ''}strings`);
  }
}

function isCanonicalRelativePath(value) {
  return isPortableRelativePath(value);
}

function validateChecksum(value, path, errors, allowPolicy = false, allowPayloadRef = false) {
  if (!checkObject(value, path, errors)) return;
  checkUnknownKeys(value, new Set([
    ...(allowPolicy ? ['policy'] : []),
    'algorithm', 'digest',
    ...(allowPayloadRef ? ['payload_ref'] : []),
  ]), path, errors);
  if (allowPolicy) {
    if (!['required', 'metadata_only', 'not_applicable'].includes(value.policy)) errors.push(`${path}.policy is invalid`);
    if (value.policy === 'required' && (!['sha256', 'hmac-sha256'].includes(value.algorithm) || !HEX_256_RE.test(value.digest))) {
      errors.push(`${path} requires a sha256/hmac-sha256 algorithm and 64-character lowercase hex digest`);
    }
    if (value.algorithm != null && !['sha256', 'hmac-sha256'].includes(value.algorithm)) errors.push(`${path}.algorithm is invalid`);
    if (value.digest != null && !HEX_256_RE.test(value.digest)) errors.push(`${path}.digest must be 64-character lowercase hex`);
  } else if (!['sha256', 'hmac-sha256'].includes(value.algorithm) || !HEX_256_RE.test(value.digest)) {
    errors.push(`${path} must contain a sha256/hmac-sha256 algorithm and 64-character lowercase hex digest`);
  }
}

function validateExtensions(value, path, errors, forbiddenKeys = new Set()) {
  if (value == null) return;
  if (!checkObject(value, path, errors)) return;
  checkUnknownKeys(value, new Set(['migrated_fields', 'vendor']), path, errors);
  for (const area of ['migrated_fields', 'vendor']) {
    if (value[area] == null || !checkObject(value[area], `${path}.${area}`, errors)) continue;
    const forbidden = Object.keys(value[area]).filter((key) => forbiddenKeys.has(key)).sort();
    if (forbidden.length > 0) errors.push(`${path}.${area} contains forbidden portable fields: ${forbidden.join(', ')}`);
  }
}

function validateRuntimeIdentity(value, errors) {
  if (!checkObject(value, 'runtime_identity', errors)) return;
  checkUnknownKeys(value, new Set(['family', 'version', 'source_platform', 'profiles', 'agents', 'workspaces', 'detection_evidence']), 'runtime_identity', errors);
  requireString(value.family, 'runtime_identity.family', errors);
  requireString(value.version, 'runtime_identity.version', errors);
  if (checkObject(value.source_platform, 'runtime_identity.source_platform', errors)) {
    checkUnknownKeys(value.source_platform, new Set(['os', 'architecture']), 'runtime_identity.source_platform', errors);
    requireString(value.source_platform.os, 'runtime_identity.source_platform.os', errors);
    requireString(value.source_platform.architecture, 'runtime_identity.source_platform.architecture', errors);
  }
  for (const key of ['profiles', 'agents', 'workspaces']) requireStringArray(value[key], `runtime_identity.${key}`, errors, { nonEmptyItems: true });
  requireStringArray(value.detection_evidence, 'runtime_identity.detection_evidence', errors, { nonEmptyItems: true, minItems: 1 });
}

function validateInventory(value, rootsById, errors) {
  if (!Array.isArray(value)) {
    errors.push('inventory must be an array');
    return;
  }
  const itemIds = new Set();
  value.forEach((item, index) => {
    const path = `inventory[${index}]`;
    if (!checkObject(item, path, errors)) return;
    checkUnknownKeys(item, new Set(['item_id', 'logical_root', 'relative_path', 'logical_store_id', 'kind', 'discovered_kind', 'state_class', 'durability', 'semantic_role', 'size_bytes', 'checksum', 'capture_method', 'sensitivity', 'restore_policy', 'provenance', 'reason', 'reason_code', 'disposition', 'result_status', 'policy_decision_ref', 'link', 'capture', 'external_reference', 'hardlink', 'hardlink_to', 'collision_types']), path, errors);
    requireString(item.item_id, `${path}.item_id`, errors);
    if (itemIds.has(item.item_id)) errors.push(`${path}.item_id duplicates another inventory item`);
    itemIds.add(item.item_id);
    const hasPath = nonEmptyString(item.relative_path);
    const hasStore = nonEmptyString(item.logical_store_id);
    if (hasPath === hasStore) errors.push(`${path} must include exactly one of relative_path or logical_store_id`);
    if (hasPath && !isCanonicalRelativePath(item.relative_path)) errors.push(`${path}.relative_path must use canonical portable relative path grammar`);
    if (hasStore && !LOGICAL_STORE_ID_RE.test(item.logical_store_id)) errors.push(`${path}.logical_store_id must be a typed machine-neutral identifier`);
    if (!['file', 'directory', 'symlink', 'hardlink', 'database', 'logical_record', 'native_archive', 'unsupported'].includes(item.kind)) errors.push(`${path}.kind is invalid`);
    if (!STATE_CLASS_SET.has(item.state_class)) errors.push(`${path}.state_class is invalid`);
    if (!['required', 'potentially_durable', 'non_durable'].includes(item.durability)) errors.push(`${path}.durability is invalid`);
    if (!['durable', 'lock', 'pid', 'active_lease', 'pending_approval', 'live_harness_state'].includes(item.semantic_role)) errors.push(`${path}.semantic_role is invalid`);
    if (!Number.isSafeInteger(item.size_bytes) || item.size_bytes < 0) errors.push(`${path}.size_bytes must be a non-negative safe integer`);
    validateChecksum(item.checksum, `${path}.checksum`, errors, true);
    if (!['native_command', 'safe_filesystem', 'database_api', 'reference_only', 'excluded', 'manual_action'].includes(item.capture_method)) errors.push(`${path}.capture_method is invalid`);
    if (!['ordinary', 'personal', 'confidential', 'secret_metadata'].includes(item.sensitivity)) errors.push(`${path}.sensitivity is invalid`);
    if (!['restore', 'recreate', 'redeem', 're_enroll', 'skip', 'unsupported', 'manual_review'].includes(item.restore_policy)) errors.push(`${path}.restore_policy is invalid`);
    if (!checkObject(item.provenance, `${path}.provenance`, errors) || !nonEmptyString(item.provenance?.source)) errors.push(`${path}.provenance.source is required`);
    else checkUnknownKeys(item.provenance, new Set(['source', 'native_artifact_id']), `${path}.provenance`, errors);
    requireString(item.reason, `${path}.reason`, errors);
    if (item.reason_code != null) requireString(item.reason_code, `${path}.reason_code`, errors);
    if (!['captured', 'referenced', 'excluded', 'manual_review'].includes(item.disposition)) errors.push(`${path}.disposition is invalid`);
    if (item.result_status != null && !ITEM_RESULT_SET.has(item.result_status)) errors.push(`${path}.result_status is invalid`);
    if (item.link != null) {
      if (checkObject(item.link, `${path}.link`, errors)) {
        checkUnknownKeys(item.link, new Set(['target_type', 'target_recorded', 'target']), `${path}.link`, errors);
        if (!['absolute', 'relative', 'unknown', 'unsafe'].includes(item.link.target_type)) errors.push(`${path}.link.target_type is invalid`);
        if (typeof item.link.target_recorded !== 'boolean') errors.push(`${path}.link.target_recorded must be a boolean`);
        if (item.link.target_recorded === true && (!nonEmptyString(item.link.target) || !isCanonicalRelativePath(item.link.target))) errors.push(`${path}.link.target must be a canonical relative path when recorded`);
        if (item.link.target_recorded !== true && item.link.target != null) errors.push(`${path}.link.target must be omitted when not recorded`);
      }
    }
    if (item.capture != null && checkObject(item.capture, `${path}.capture`, errors)) {
      checkUnknownKeys(item.capture, new Set(['follow', 'external_root']), `${path}.capture`, errors);
      if (typeof item.capture.follow !== 'boolean') errors.push(`${path}.capture.follow must be a boolean`);
      if (item.capture.follow === true && !nonEmptyString(item.capture.external_root)) errors.push(`${path}.capture.external_root must reference a declared root when following`);
      if (item.capture.follow === false && item.capture.external_root != null) errors.push(`${path}.capture.external_root must be omitted when not following`);
    }
    if (item.external_reference != null && checkObject(item.external_reference, `${path}.external_reference`, errors)) {
      checkUnknownKeys(item.external_reference, new Set(['logical_root', 'relative_path']), `${path}.external_reference`, errors);
      if (!nonEmptyString(item.external_reference.relative_path) || !isCanonicalRelativePath(item.external_reference.relative_path)) errors.push(`${path}.external_reference.relative_path must be canonical`);
    }
    if (item.hardlink != null && checkObject(item.hardlink, `${path}.hardlink`, errors)) {
      checkUnknownKeys(item.hardlink, new Set(['status']), `${path}.hardlink`, errors);
      if (!['complete', 'incomplete'].includes(item.hardlink.status)) errors.push(`${path}.hardlink.status is invalid`);
      if (!['file', 'hardlink'].includes(item.kind)) errors.push(`${path}.hardlink is only valid for file or hardlink items`);
    }
    if (item.hardlink_to != null && checkObject(item.hardlink_to, `${path}.hardlink_to`, errors)) {
      checkUnknownKeys(item.hardlink_to, new Set(['logical_root', 'relative_path']), `${path}.hardlink_to`, errors);
      if (!nonEmptyString(item.hardlink_to.relative_path) || !isCanonicalRelativePath(item.hardlink_to.relative_path)) errors.push(`${path}.hardlink_to.relative_path must be canonical`);
    }
    if (item.collision_types != null && (!Array.isArray(item.collision_types) || item.collision_types.length === 0 ||
        new Set(item.collision_types).size !== item.collision_types.length ||
        item.collision_types.some((type) => !['exact', 'case_only', 'path_normalization'].includes(type)))) {
      errors.push(`${path}.collision_types must contain unique declared collision types`);
    }
    errors.push(...itemInvariantErrors(item, path));
  });
  errors.push(...inventoryInvariantErrors(value, rootsById));
}

function validationException(label) {
  return { ok: false, errors: [`${label} contains inaccessible or non-deterministic data`] };
}

/** @param {unknown} raw */
function validateRuntimeBackupManifestV1Internal(raw) {
  const errors = [];
  const graphErrors = strictJsonGraphErrors(raw, 'runtime backup manifest');
  if (graphErrors.length > 0) return { ok: false, errors: graphErrors };
  if (!checkObject(raw, 'runtime backup manifest', errors)) return { ok: false, errors };
  checkUnknownKeys(raw, TOP_RUNTIME_KEYS, 'runtime backup manifest', errors);
  if (raw.schema_version !== RUNTIME_BACKUP_SCHEMA_VERSION) errors.push(`schema_version must be ${RUNTIME_BACKUP_SCHEMA_VERSION}`);
  if (raw.manifest_version !== 1) errors.push('manifest_version must be 1');
  if (raw.contract_status !== 'draft') errors.push('contract_status must be draft until M0 contract freeze');
  if (!['unqualified', 'manual_review'].includes(raw.qualification_status)) errors.push('qualification_status must be unqualified or manual_review while the contract is draft');
  validateRuntimeIdentity(raw.runtime_identity, errors);

  if (checkObject(raw.adapter_identity, 'adapter_identity', errors)) {
    checkUnknownKeys(raw.adapter_identity, new Set(['name', 'version', 'contract_version']), 'adapter_identity', errors);
    requireString(raw.adapter_identity.name, 'adapter_identity.name', errors);
    requireString(raw.adapter_identity.version, 'adapter_identity.version', errors);
    if (raw.adapter_identity.contract_version !== ADAPTER_CONTRACT_VERSION) errors.push(`adapter_identity.contract_version must be ${ADAPTER_CONTRACT_VERSION}`);
  }
  if (checkObject(raw.support, 'support', errors)) {
    checkUnknownKeys(raw.support, new Set(['status', 'matrix_revision', 'evidence', 'remediation']), 'support', errors);
    if (!['draft', 'unsupported', 'manual_review'].includes(raw.support.status)) errors.push('support.status must not claim supported while the contract is draft');
    requireString(raw.support.matrix_revision, 'support.matrix_revision', errors);
    requireStringArray(raw.support.evidence, 'support.evidence', errors, { nonEmptyItems: true, minItems: 1 });
    optionalString(raw.support.remediation, 'support.remediation', errors);
  }
  if (checkObject(raw.consistency, 'consistency', errors)) {
    checkUnknownKeys(raw.consistency, new Set(['boundary', 'quiesce_owned', 'evidence']), 'consistency', errors);
    if (!['stopped', 'read_only', 'database_checkpointed', 'online_safe', 'manual_review'].includes(raw.consistency.boundary)) errors.push('consistency.boundary is invalid');
    if (typeof raw.consistency.quiesce_owned !== 'boolean') errors.push('consistency.quiesce_owned must be a boolean');
    requireStringArray(raw.consistency.evidence, 'consistency.evidence', errors, { nonEmptyItems: true, minItems: 1 });
  }

  const rootIds = new Set();
  const rootsById = new Map();
  if (!Array.isArray(raw.logical_roots)) errors.push('logical_roots must be an array');
  else raw.logical_roots.forEach((root, index) => {
    if (!checkObject(root, `logical_roots[${index}]`, errors)) return;
    checkUnknownKeys(root, new Set(['id', 'kind', 'provider', 'ownership', 'approved_destination_class', 'containment_policy', 'restoration_requirements']), `logical_roots[${index}]`, errors);
    if (!nonEmptyString(root.id) || !ROOT_ID_RE.test(root.id)) errors.push(`logical_roots[${index}].id is invalid`);
    if (rootIds.has(root.id)) errors.push(`logical_roots[${index}].id is duplicated`);
    rootIds.add(root.id);
    rootsById.set(root.id, root);
    if (!['runtime', 'workspace', 'profile', 'external_provider', 'logical_store'].includes(root.kind)) errors.push(`logical_roots[${index}].kind is invalid`);
    if (root.kind === 'external_provider') {
      if (!nonEmptyString(root.provider)) errors.push(`logical_roots[${index}].provider is required for external_provider`);
      if (!nonEmptyString(root.ownership)) errors.push(`logical_roots[${index}].ownership is required for external_provider`);
      if (root.approved_destination_class !== 'external_state') errors.push(`logical_roots[${index}].approved_destination_class must be external_state`);
      if (root.containment_policy !== 'realpath_within_root') errors.push(`logical_roots[${index}].containment_policy must be realpath_within_root`);
      requireStringArray(root.restoration_requirements, `logical_roots[${index}].restoration_requirements`, errors, { nonEmptyItems: true, minItems: 1 });
    } else if (['provider', 'ownership', 'approved_destination_class', 'containment_policy', 'restoration_requirements'].some((key) => root[key] != null)) {
      errors.push(`logical_roots[${index}] external provider fields are only valid for external_provider roots`);
    }
    optionalString(root.provider, `logical_roots[${index}].provider`, errors);
  });
  validateInventory(raw.inventory, rootsById, errors);

  const allItemIds = new Set(Array.isArray(raw.inventory) ? raw.inventory.map((item) => item?.item_id).filter(nonEmptyString) : []);
  if (!Array.isArray(raw.exclusions)) errors.push('exclusions must be an array');
  else raw.exclusions.forEach((item, index) => {
    const path = `exclusions[${index}]`;
    if (!checkObject(item, path, errors)) return;
    checkUnknownKeys(item, new Set(['item_id', 'state_class', 'size_bytes', 'reason', 'policy', 'policy_decision_ref']), path, errors);
    if (!nonEmptyString(item.item_id) || !STATE_CLASS_SET.has(item.state_class) || !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 0 || !nonEmptyString(item.reason) || !['always_exclude', 'operator_decision', 'unsupported'].includes(item.policy)) {
      errors.push(`exclusions[${index}] must contain item_id, state_class, reason, and valid policy`);
    }
    if (allItemIds.has(item.item_id)) errors.push(`${path}.item_id duplicates or overlaps another inventory/exclusion item`);
    allItemIds.add(item.item_id);
    if (item.policy === 'operator_decision' && !nonEmptyString(item.policy_decision_ref)) errors.push(`exclusions[${index}].policy_decision_ref is required`);
    if (item.state_class === 'manual_review' && item.policy !== 'operator_decision') errors.push(`${path} manual_review state requires an explicit operator_decision`);
    optionalString(item.policy_decision_ref, `${path}.policy_decision_ref`, errors);
  });
  const nativeArtifactCounts = new Map();
  for (const [key, requiredKeys] of [['native_artifacts', ['artifact_id', 'format', 'native_version', 'checksum', 'payload_ref']], ['dependency_pins', ['name', 'version', 'source']]]) {
    if (!Array.isArray(raw[key])) errors.push(`${key} must be an array`);
    else raw[key].forEach((item, index) => {
      if (!checkObject(item, `${key}[${index}]`, errors)) return;
      checkUnknownKeys(item, new Set(key === 'native_artifacts'
        ? ['artifact_id', 'format', 'native_version', 'checksum', 'payload_ref']
        : ['name', 'version', 'source', 'integrity']), `${key}[${index}]`, errors);
      for (const required of requiredKeys) {
        if (required === 'checksum') validateChecksum(item[required], `${key}[${index}].checksum`, errors);
        else requireString(item[required], `${key}[${index}].${required}`, errors);
      }
      if (key === 'native_artifacts' && nonEmptyString(item.artifact_id)) {
        const count = (nativeArtifactCounts.get(item.artifact_id) ?? 0) + 1;
        nativeArtifactCounts.set(item.artifact_id, count);
        if (count > 1) errors.push(`${key}[${index}].artifact_id duplicates another native artifact`);
      }
      if (key === 'dependency_pins') optionalString(item.integrity, `${key}[${index}].integrity`, errors);
    });
  }
  if (Array.isArray(raw.inventory)) raw.inventory.forEach((item, index) => {
    const artifactId = item?.provenance?.native_artifact_id;
    if (artifactId != null && nativeArtifactCounts.get(artifactId) !== 1) {
      errors.push(`inventory[${index}].provenance.native_artifact_id must reference exactly one declared native artifact`);
    }
  });
  validateChecksum(raw.integrity, 'integrity', errors, false, true);
  if (isObject(raw.integrity)) requireString(raw.integrity.payload_ref, 'integrity.payload_ref', errors);
  if (!checkObject(raw.encryption, 'encryption', errors) || !nonEmptyString(raw.encryption?.metadata_ref)) errors.push('encryption.metadata_ref is required');
  else checkUnknownKeys(raw.encryption, new Set(['metadata_ref', 'key_metadata_ref']), 'encryption', errors);
  optionalString(raw.encryption?.key_metadata_ref, 'encryption.key_metadata_ref', errors);
  if (checkObject(raw.accounting, 'accounting', errors)) {
    checkUnknownKeys(raw.accounting, new Set(['discovered_items', 'accounted_items', 'bytes_by_class', 'counts_by_disposition']), 'accounting', errors);
    const expected = (Array.isArray(raw.inventory) ? raw.inventory.length : 0) + (Array.isArray(raw.exclusions) ? raw.exclusions.length : 0);
    if (!Number.isSafeInteger(raw.accounting.discovered_items) || raw.accounting.discovered_items < 0) errors.push('accounting.discovered_items must be a non-negative safe integer');
    if (!Number.isSafeInteger(raw.accounting.accounted_items) || raw.accounting.accounted_items < 0) errors.push('accounting.accounted_items must be a non-negative safe integer');
    if (raw.accounting.accounted_items !== expected) errors.push(`accounting.accounted_items must equal inventory plus exclusions (${expected})`);
    if (raw.accounting.discovered_items !== raw.accounting.accounted_items) errors.push('accounting.discovered_items must equal accounted_items for complete source-item accounting');
    const expectedBytes = Object.fromEntries(STATE_CLASSES.map((key) => [key, 0]));
    const expectedCounts = Object.fromEntries(DISPOSITIONS.map((key) => [key, 0]));
    for (const item of Array.isArray(raw.inventory) ? raw.inventory : []) {
      if (STATE_CLASS_SET.has(item?.state_class) && Number.isSafeInteger(item?.size_bytes) && item.size_bytes >= 0) {
        const next = expectedBytes[item.state_class] + item.size_bytes;
        if (!Number.isSafeInteger(next)) errors.push(`accounting.bytes_by_class.${item.state_class} aggregate exceeds the maximum safe integer`);
        else expectedBytes[item.state_class] = next;
      }
      if (DISPOSITIONS.includes(item?.disposition)) expectedCounts[item.disposition] += 1;
    }
    for (const item of Array.isArray(raw.exclusions) ? raw.exclusions : []) {
      if (STATE_CLASS_SET.has(item?.state_class) && Number.isSafeInteger(item?.size_bytes) && item.size_bytes >= 0) {
        const next = expectedBytes[item.state_class] + item.size_bytes;
        if (!Number.isSafeInteger(next)) errors.push(`accounting.bytes_by_class.${item.state_class} aggregate exceeds the maximum safe integer`);
        else expectedBytes[item.state_class] = next;
      }
      expectedCounts.excluded += 1;
    }
    for (const [name, expectedMap] of [['bytes_by_class', expectedBytes], ['counts_by_disposition', expectedCounts]]) {
      const actual = raw.accounting[name];
      if (!isObject(actual)) errors.push(`accounting.${name} must be an object`);
      else {
        const actualKeys = Object.keys(actual).sort(); const expectedKeys = Object.keys(expectedMap).sort();
        if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) errors.push(`accounting.${name} must contain the complete canonical taxonomy`);
        for (const [key, expectedValue] of Object.entries(expectedMap)) if (actual[key] !== expectedValue) errors.push(`accounting.${name}.${key} must equal ${expectedValue}`);
      }
    }
  }
  const manualItems = Array.isArray(raw.inventory) ? raw.inventory.filter((item) => item?.state_class === 'manual_review') : [];
  const durableManualState = manualItems.some((item) => ['required', 'potentially_durable'].includes(item.durability));
  const excludedManualState = Array.isArray(raw.exclusions) && raw.exclusions.some((item) => item?.state_class === 'manual_review');
  if ((durableManualState || excludedManualState) && raw.qualification_status !== 'manual_review') errors.push('durable or excluded manual_review state requires overall manual_review qualification status');
  if (!durableManualState && !excludedManualState && raw.qualification_status === 'manual_review') errors.push('manual_review qualification status requires durable or excluded manual_review state');
  validateExtensions(raw.extensions, 'extensions', errors);
  const secrets = findRawSecretViolations(raw, { accountingContext: 'runtime_backup_manifest' });
  if (secrets.length > 0) errors.push(`runtime backup manifest contains raw secret material at: ${secrets.join(', ')}`);
  return errors.length === 0 ? { ok: true, value: raw } : { ok: false, errors };
}

/**
 * Total public validation boundary for untrusted runtime manifest values.
 * Detailed semantic failures remain in-band, while hostile JavaScript object
 * behavior is collapsed to a stable error that cannot reflect thrown secrets.
 *
 * @param {unknown} raw
 */
export function validateRuntimeBackupManifestV1(raw) {
  try {
    return validateRuntimeBackupManifestV1Internal(raw);
  } catch {
    return validationException('runtime backup manifest');
  }
}

/**
 * Required acceptance path for runtime-backup-manifest-v1 documents.
 *
 * JSON Schema validation is structural only: relational invariants such as
 * hardlink_to resolving to a compatible inventoried primary require this
 * deterministic semantic validator before a manifest is accepted or applied.
 *
 * @param {unknown} raw
 */
export function acceptRuntimeBackupManifestV1(raw) {
  return validateRuntimeBackupManifestV1(raw);
}

function validateContentReference(value, path, errors, requireId = false) {
  if (!checkObject(value, path, errors)) return;
  const allowed = new Set(['content_ref', 'checksum', 'media_type', ...(requireId ? ['id'] : [])]);
  checkUnknownKeys(value, allowed, path, errors);
  if (requireId) requireString(value.id, `${path}.id`, errors);
  requireString(value.content_ref, `${path}.content_ref`, errors);
  validateChecksum(value.checksum, `${path}.checksum`, errors);
  optionalString(value.media_type, `${path}.media_type`, errors);
}

/** @param {unknown} raw */
function validatePortableAgentCoreV1Internal(raw) {
  const errors = [];
  const graphErrors = strictJsonGraphErrors(raw, 'portable agent core');
  if (graphErrors.length > 0) return { ok: false, errors: graphErrors };
  if (!checkObject(raw, 'portable agent core', errors)) return { ok: false, errors };
  checkUnknownKeys(raw, TOP_PORTABLE_KEYS, 'portable agent core', errors);
  for (const key of FORBIDDEN_PORTABLE_KEYS) if (key in raw) errors.push(`${key} is forbidden in portable-agent-core-v1`);
  if (raw.schema_version !== PORTABLE_AGENT_CORE_SCHEMA_VERSION) errors.push(`schema_version must be ${PORTABLE_AGENT_CORE_SCHEMA_VERSION}`);
  if (raw.manifest_version !== 1) errors.push('manifest_version must be 1');
  if (raw.contract_status !== 'draft') errors.push('contract_status must be draft until M0 contract freeze');
  if (!checkObject(raw.identity, 'identity', errors) || !nonEmptyString(raw.identity?.agent_id)) errors.push('identity.agent_id is required');
  else {
    checkUnknownKeys(raw.identity, new Set(['agent_id', 'display_name', 'description']), 'identity', errors);
    optionalString(raw.identity.display_name, 'identity.display_name', errors);
    if (raw.identity.description != null && typeof raw.identity.description !== 'string') errors.push('identity.description must be a string');
  }
  for (const key of ['instructions', 'memory', 'transcripts', 'skills']) {
    if (!Array.isArray(raw[key])) errors.push(`${key} must be an array`);
    else raw[key].forEach((item, index) => validateContentReference(item, `${key}[${index}]`, errors, true));
  }
  validateContentReference(raw.user_profile, 'user_profile', errors);
  for (const key of ['mcp_declarations', 'schedules', 'credential_references']) if (!Array.isArray(raw[key])) errors.push(`${key} must be an array`);
  if (Array.isArray(raw.mcp_declarations)) raw.mcp_declarations.forEach((item, index) => {
    if (!checkObject(item, `mcp_declarations[${index}]`, errors)) return;
    checkUnknownKeys(item, new Set(['name', 'transport', 'command_ref', 'endpoint_ref', 'credential_references']), `mcp_declarations[${index}]`, errors);
    requireString(item.name, `mcp_declarations[${index}].name`, errors);
    if (!['stdio', 'http', 'sse'].includes(item.transport)) errors.push(`mcp_declarations[${index}].transport is invalid`);
    optionalString(item.command_ref, `mcp_declarations[${index}].command_ref`, errors);
    optionalString(item.endpoint_ref, `mcp_declarations[${index}].endpoint_ref`, errors);
    if (item.credential_references != null) {
      requireStringArray(item.credential_references, `mcp_declarations[${index}].credential_references`, errors, { nonEmptyItems: true });
      if (Array.isArray(item.credential_references)) item.credential_references.forEach((reference, referenceIndex) => {
        if (!isTypedOpaqueReference(reference)) errors.push(`mcp_declarations[${index}].credential_references[${referenceIndex}] must be a typed opaque reference`);
      });
    }
  });
  if (!checkObject(raw.model_preferences, 'model_preferences', errors)) errors.push('model_preferences is required');
  else {
    checkUnknownKeys(raw.model_preferences, new Set(['provider', 'task_model', 'chat_model']), 'model_preferences', errors);
    for (const key of ['provider', 'task_model', 'chat_model']) optionalString(raw.model_preferences[key], `model_preferences.${key}`, errors);
  }
  if (Array.isArray(raw.schedules)) raw.schedules.forEach((item, index) => {
    const path = `schedules[${index}]`;
    if (!checkObject(item, path, errors)) return;
    checkUnknownKeys(item, new Set(['id', 'expression', 'timezone', 'enabled', 'action_ref']), path, errors);
    requireString(item.id, `${path}.id`, errors); requireString(item.expression, `${path}.expression`, errors);
    if (typeof item.enabled !== 'boolean') errors.push(`${path}.enabled must be a boolean`);
    optionalString(item.timezone, `${path}.timezone`, errors); optionalString(item.action_ref, `${path}.action_ref`, errors);
  });
  if (Array.isArray(raw.credential_references)) raw.credential_references.forEach((item, index) => {
    if (!checkObject(item, `credential_references[${index}]`, errors)) return;
    checkUnknownKeys(item, new Set(['provider', 'reference', 'restore_status', 'remediation']), `credential_references[${index}]`, errors);
    requireString(item.provider, `credential_references[${index}].provider`, errors);
    requireString(item.reference, `credential_references[${index}].reference`, errors);
    if (!isTypedOpaqueReference(item.reference)) errors.push(`credential_references[${index}].reference must be a typed opaque reference`);
    if (!ITEM_RESULT_SET.has(item.restore_status) || item.restore_status === 'restored') errors.push(`credential_references[${index}].restore_status is invalid`);
    optionalString(item.remediation, `credential_references[${index}].remediation`, errors);
  });
  if (!checkObject(raw.provenance, 'provenance', errors)) errors.push('provenance is required');
  else {
    checkUnknownKeys(raw.provenance, new Set(['source_runtime_family', 'source_snapshot_id', 'generated_by']), 'provenance', errors);
    for (const key of ['source_runtime_family', 'source_snapshot_id', 'generated_by']) requireString(raw.provenance[key], `provenance.${key}`, errors);
  }
  validateExtensions(raw.extensions, 'extensions', errors, FORBIDDEN_PORTABLE_KEYS);
  const secrets = findRawSecretViolations(raw);
  if (secrets.length > 0) errors.push(`portable agent core contains raw secret material at: ${secrets.join(', ')}`);
  return errors.length === 0 ? { ok: true, value: raw } : { ok: false, errors };
}

/**
 * Total public validation boundary for untrusted portable core values.
 *
 * @param {unknown} raw
 */
export function validatePortableAgentCoreV1(raw) {
  try {
    return validatePortableAgentCoreV1Internal(raw);
  } catch {
    return validationException('portable agent core');
  }
}

function unsupportedMigration(schemaName, version) {
  return {
    ok: false,
    status: 'unsupported',
    error: {
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      message: `${schemaName} schema version ${String(version ?? '<missing>')} is unsupported`,
      remediation: 'Use a reader that supports this schema version or an explicit major-version migration.',
    },
  };
}

function migrateAdditiveV1(raw, { schemaName, currentVersion, allowedKeys, forbiddenKeys = new Set(), validate }) {
  if (!isObject(raw)) return unsupportedMigration(schemaName, undefined);
  if (raw.schema_version === currentVersion) {
    const checked = validate(raw);
    return checked.ok ? { ok: true, value: structuredClone(raw), migrated: false, warnings: [] } : { ok: false, status: 'manual_review', errors: checked.errors };
  }
  if (raw.schema_version !== '1.0') return unsupportedMigration(schemaName, raw.schema_version);

  const value = structuredClone(raw);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key)).sort();
  const forbidden = unknownKeys.filter((key) => forbiddenKeys.has(key));
  if (forbidden.length > 0) {
    return {
      ok: false, status: 'manual_review',
      error: { code: 'MANUAL_REVIEW_REQUIRED', message: `Migration contains non-portable fields: ${forbidden.join(', ')}`, remediation: 'Classify or remove runtime/live/credential state before creating portable core.' },
    };
  }
  if (unknownKeys.length > 0 && Object.hasOwn(value, 'extensions') && !isObject(value.extensions)) {
    return {
      ok: false, status: 'manual_review',
      error: { code: 'MANUAL_REVIEW_REQUIRED', message: 'Migration cannot preserve unknown fields because extensions is not an object', remediation: 'Repair or explicitly classify the existing extension state before migration.' },
    };
  }
  if (unknownKeys.length > 0 && isObject(value.extensions) && Object.hasOwn(value.extensions, 'migrated_fields') && !isObject(value.extensions.migrated_fields)) {
    return {
      ok: false, status: 'manual_review',
      error: { code: 'MANUAL_REVIEW_REQUIRED', message: 'Migration cannot preserve unknown fields because extensions.migrated_fields is not an object', remediation: 'Repair or explicitly classify the existing migrated field state before migration.' },
    };
  }
  const existing = isObject(value.extensions?.migrated_fields) ? value.extensions.migrated_fields : {};
  const collisions = unknownKeys.filter((key) => Object.hasOwn(existing, key));
  if (collisions.length > 0) {
    return {
      ok: false, status: 'manual_review',
      error: { code: 'MANUAL_REVIEW_REQUIRED', message: `Migration extension collision: ${collisions.join(', ')}`, remediation: 'Resolve the colliding extension fields explicitly.' },
    };
  }
  if (unknownKeys.length > 0) {
    value.extensions = { ...(isObject(value.extensions) ? value.extensions : {}), migrated_fields: { ...existing } };
    for (const key of unknownKeys) {
      value.extensions.migrated_fields[key] = value[key];
      delete value[key];
    }
  }
  value.schema_version = currentVersion;
  const checked = validate(value);
  return checked.ok
    ? { ok: true, value, migrated: true, warnings: unknownKeys.map((key) => `preserved ${key} in extensions.migrated_fields`) }
    : { ok: false, status: 'manual_review', errors: checked.errors };
}

/** Pure additive migration for the runtime backup manifest. */
export function migrateRuntimeBackupManifest(raw) {
  return migrateAdditiveV1(raw, {
    schemaName: 'runtime-backup-manifest', currentVersion: RUNTIME_BACKUP_SCHEMA_VERSION,
    allowedKeys: TOP_RUNTIME_KEYS, validate: validateRuntimeBackupManifestV1,
  });
}

/** Pure additive migration for the portable agent core. */
export function migratePortableAgentCore(raw) {
  return migrateAdditiveV1(raw, {
    schemaName: 'portable-agent-core', currentVersion: PORTABLE_AGENT_CORE_SCHEMA_VERSION,
    allowedKeys: TOP_PORTABLE_KEYS, forbiddenKeys: FORBIDDEN_PORTABLE_KEYS, validate: validatePortableAgentCoreV1,
  });
}
