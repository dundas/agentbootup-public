import { isObject, nonEmptyString } from '../brain/validate-utils.js';
import { findRawSecretViolations } from './security.js';

export const ADAPTER_CONTRACT_VERSION = '1.0.0-draft';
export const ADAPTER_OPERATIONS = Object.freeze([
  'detect', 'inventory', 'quiesce', 'snapshot', 'restore', 'verify', 'resume',
]);
export const STATE_CLASSES = Object.freeze([
  'portable_core', 'runtime_state', 'secret', 'external_state',
  'reproducible', 'machine_local', 'cache', 'manual_review',
]);
export const DETECTION_STATUSES = Object.freeze([
  'not_installed', 'unsupported_version', 'ambiguous', 'manual_review', 'supported',
]);
export const ITEM_RESULT_STATUSES = Object.freeze([
  'restored', 'redeemed', 're_enroll_required', 'skipped', 'unsupported', 'manual_review',
]);
export const OPERATION_STATUSES = Object.freeze([
  'success', 'partial', 'failed', 'unsupported', 'manual_review', 'skipped',
]);
export const CAPABILITY_MECHANISMS = Object.freeze([
  'native_command', 'safe_filesystem', 'database_api', 'manual_action',
]);
export const RUNTIME_ERROR_CODES = Object.freeze([
  'ADAPTER_CONTRACT_INVALID', 'AMBIGUOUS_RUNTIME', 'CAPABILITY_UNAVAILABLE',
  'CONSISTENCY_BOUNDARY_FAILED', 'INVALID_MANIFEST', 'MANUAL_REVIEW_REQUIRED',
  'NOT_INSTALLED', 'RESTORE_POLICY_REQUIRED', 'RUNTIME_OPERATION_FAILED',
  'SECRET_MATERIAL_REJECTED', 'UNSUPPORTED_PLATFORM', 'UNSUPPORTED_SCHEMA_VERSION',
  'UNSUPPORTED_VERSION', 'VERIFICATION_FAILED',
]);

const OPERATION_SET = new Set(ADAPTER_OPERATIONS);
const DETECTION_STATUS_SET = new Set(DETECTION_STATUSES);
const OPERATION_STATUS_SET = new Set(OPERATION_STATUSES);
const ITEM_STATUS_SET = new Set(ITEM_RESULT_STATUSES);
const ERROR_CODE_SET = new Set(RUNTIME_ERROR_CODES);
const MECHANISM_SET = new Set(CAPABILITY_MECHANISMS);
const DETECTION_ERROR_CODES = Object.freeze({
  not_installed: 'NOT_INSTALLED',
  unsupported_version: 'UNSUPPORTED_VERSION',
  ambiguous: 'AMBIGUOUS_RUNTIME',
  manual_review: 'MANUAL_REVIEW_REQUIRED',
});
const SUCCESS_ITEM_STATUSES = new Set(['restored', 'redeemed']);
const SHA256_RE = /^[a-f0-9]{64}$/;
const EVIDENCE_FIELDS = new Set(['reference', 'sha256']);

function denseArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a plain array`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) throw new TypeError(`${label} must not contain non-JSON array properties`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`${label} must contain plain JSON values`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must not contain sparse array holes`);
  }
  return value;
}

function plainRecord(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`${label}.${key} must be a plain own data field`);
  }
  return value;
}

function requireOwn(value, fields, label) {
  for (const field of fields) if (!Object.hasOwn(value, field)) throw new TypeError(`${label}.${field} is required`);
}

function machineNeutralReference(value) {
  if (!nonEmptyString(value) || /[\0-\x1f\x7f]/.test(value) || value.includes('\\')) return false;
  if (value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)) return false;
  if (value.split(/[?#]/, 1)[0].split('/').includes('..')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return /^(?:artifact|npm|oci|git\+https):\/\/[^\s]+$/.test(value);
  }
  return /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+)?$/.test(value);
}

function cloneCapabilityEvidence(value, label) {
  denseArray(value, label);
  return value.map((entry, index) => {
    const item = `${label}[${index}]`;
    plainRecord(entry, item);
    const unknown = Object.keys(entry).filter((key) => !EVIDENCE_FIELDS.has(key));
    if (unknown.length) throw new TypeError(`${item} contains unsupported fields: ${unknown.sort().join(', ')}`);
    for (const key of EVIDENCE_FIELDS) if (!Object.hasOwn(entry, key)) throw new TypeError(`${item}.${key} is required`);
    if (!machineNeutralReference(entry.reference)) throw new TypeError(`${item}.reference must be a repo-relative or typed artifact reference`);
    if (!SHA256_RE.test(entry.sha256)) throw new TypeError(`${item}.sha256 must be an exact lowercase sha256`);
    const secretPaths = findRawSecretViolations(entry);
    if (secretPaths.length) throw new TypeError(`${item} contains raw secret material`);
    return { reference: entry.reference, sha256: entry.sha256 };
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Create a deterministic operation result. A nominal success is downgraded to partial
 * whenever an item requires any non-success disposition.
 *
 * @param {string} operation
 * @param {object} [fields]
 */
export function createOperationResult(operation, fields = {}) {
  const items = Array.isArray(fields.items) ? fields.items.map((item) => ({ ...item })) : [];
  let status = fields.status ?? (operation === 'detect' ? 'manual_review' : 'success');
  if (operation !== 'detect' && status === 'success' && items.some((item) => item.status !== 'restored' && item.status !== 'redeemed')) {
    status = 'partial';
  }
  return {
    contract_version: ADAPTER_CONTRACT_VERSION,
    operation,
    status,
    ...(fields.error ? { error: { ...fields.error } } : {}),
    evidence: Array.isArray(fields.evidence) ? [...fields.evidence] : [],
    warnings: Array.isArray(fields.warnings) ? [...fields.warnings] : [],
    diagnostics: isObject(fields.diagnostics) ? structuredClone(fields.diagnostics) : {},
    items,
    ...(fields.runtime_identity ? { runtime_identity: structuredClone(fields.runtime_identity) } : {}),
    ...(fields.capabilities ? { capabilities: structuredClone(fields.capabilities) } : {}),
  };
}

function validateCapabilities(capabilities, path, errors) {
  if (!isObject(capabilities)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const operation of ADAPTER_OPERATIONS) {
    const capability = capabilities[operation];
    if (!isObject(capability)) {
      errors.push(`${path}.${operation} is required`);
      continue;
    }
    if (typeof capability.available !== 'boolean') errors.push(`${path}.${operation}.available must be a boolean`);
    if (!MECHANISM_SET.has(capability.mechanism)) errors.push(`${path}.${operation}.mechanism is invalid`);
    if (!Array.isArray(capability.evidence) || capability.evidence.some((item) => !nonEmptyString(item))) errors.push(`${path}.${operation}.evidence is invalid`);
    if (capability.available === true && Array.isArray(capability.evidence) && capability.evidence.length === 0) errors.push(`${path}.${operation}.evidence is required when available`);
    if (capability.available === false && capability.mechanism !== 'manual_action') errors.push(`${path}.${operation} must use manual_action when unavailable`);
    const unknownFields = Object.keys(capability).filter((key) => !['available', 'mechanism', 'evidence'].includes(key));
    if (unknownFields.length > 0) errors.push(`${path}.${operation} contains unsupported fields: ${unknownFields.sort().join(', ')}`);
  }
  const unknown = Object.keys(capabilities).filter((key) => !OPERATION_SET.has(key));
  if (unknown.length > 0) errors.push(`${path} contains unknown operations: ${unknown.sort().join(', ')}`);
}

function validateDetectedRuntime(identity, errors) {
  if (!isObject(identity)) {
    errors.push('runtime_identity is required for supported detection');
    return;
  }
  for (const key of ['family', 'version']) if (!nonEmptyString(identity[key])) errors.push(`runtime_identity.${key} is required`);
  const unknown = Object.keys(identity).filter((key) => !['family', 'version', 'source_platform', 'profiles', 'agents', 'workspaces', 'detection_evidence'].includes(key));
  if (unknown.length > 0) errors.push(`runtime_identity contains unsupported fields: ${unknown.sort().join(', ')}`);
  if (!isObject(identity.source_platform) || !nonEmptyString(identity.source_platform.os) || !nonEmptyString(identity.source_platform.architecture)) {
    errors.push('runtime_identity.source_platform must identify os and architecture');
  } else {
    const platformUnknown = Object.keys(identity.source_platform).filter((key) => !['os', 'architecture'].includes(key));
    if (platformUnknown.length > 0) errors.push(`runtime_identity.source_platform contains unsupported fields: ${platformUnknown.sort().join(', ')}`);
  }
  for (const key of ['profiles', 'agents', 'workspaces']) {
    if (!Array.isArray(identity[key]) || identity[key].some((item) => !nonEmptyString(item))) errors.push(`runtime_identity.${key} must be an array of non-empty identities`);
  }
  if (!Array.isArray(identity.detection_evidence) || identity.detection_evidence.length === 0 || identity.detection_evidence.some((item) => !nonEmptyString(item))) {
    errors.push('runtime_identity.detection_evidence must be an array of non-empty references');
  }
}

/** @param {unknown} raw */
export function validateOperationResult(raw) {
  const errors = [];
  if (!isObject(raw)) return { ok: false, errors: ['operation result must be an object'] };
  const unknownTop = Object.keys(raw).filter((key) => !['contract_version', 'operation', 'status', 'error', 'evidence', 'warnings', 'diagnostics', 'items', 'runtime_identity', 'capabilities'].includes(key));
  if (unknownTop.length > 0) errors.push(`operation result contains unsupported fields: ${unknownTop.sort().join(', ')}`);
  if (raw.contract_version !== ADAPTER_CONTRACT_VERSION) errors.push(`contract_version must be ${ADAPTER_CONTRACT_VERSION}`);
  if (!OPERATION_SET.has(raw.operation)) errors.push('operation must be a declared adapter operation');
  const statuses = raw.operation === 'detect' ? DETECTION_STATUS_SET : OPERATION_STATUS_SET;
  if (!statuses.has(raw.status)) errors.push(`status is not valid for ${raw.operation || 'this operation'}`);
  if (!Array.isArray(raw.evidence) || raw.evidence.some((item) => !nonEmptyString(item))) errors.push('evidence must be an array of non-empty references');
  if (!Array.isArray(raw.warnings) || raw.warnings.some((item) => !nonEmptyString(item))) errors.push('warnings must be an array of non-empty strings');
  if (!isObject(raw.diagnostics)) errors.push('diagnostics must be an object');
  if (!Array.isArray(raw.items)) {
    errors.push('items must be an array');
  } else {
    raw.items.forEach((item, index) => {
      if (!isObject(item) || !nonEmptyString(item.item_id)) errors.push(`items[${index}].item_id is required`);
      if (!isObject(item) || !ITEM_STATUS_SET.has(item.status)) errors.push(`items[${index}].status is invalid`);
      if (isObject(item) && item.status !== 'restored' && item.status !== 'redeemed' && !nonEmptyString(item.remediation)) {
        errors.push(`items[${index}].remediation is required for non-success dispositions`);
      }
      if (isObject(item)) {
        const unknown = Object.keys(item).filter((key) => !['item_id', 'status', 'remediation', 'evidence'].includes(key));
        if (unknown.length > 0) errors.push(`items[${index}] contains unsupported fields: ${unknown.sort().join(', ')}`);
        if (item.evidence != null && (!Array.isArray(item.evidence) || item.evidence.some((entry) => !nonEmptyString(entry)))) errors.push(`items[${index}].evidence is invalid`);
      }
    });
  }
  if (raw.operation !== 'detect' && raw.status === 'success' && Array.isArray(raw.items) &&
      raw.items.some((item) => isObject(item) && !SUCCESS_ITEM_STATUSES.has(item.status))) {
    errors.push('operation-level success cannot hide an item-level non-success disposition');
  }
  if (raw.operation === 'detect' && raw.status === 'supported') {
    if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) errors.push('supported detection requires evidence references');
    validateDetectedRuntime(raw.runtime_identity, errors);
    validateCapabilities(raw.capabilities, 'capabilities', errors);
  }
  if (raw.operation !== 'detect' && raw.status === 'success' && (!Array.isArray(raw.evidence) || raw.evidence.length === 0)) {
    errors.push('successful operation requires evidence references');
  }
  const detectionFailure = raw.operation === 'detect' && Object.hasOwn(DETECTION_ERROR_CODES, raw.status);
  if (detectionFailure && (!Array.isArray(raw.evidence) || raw.evidence.length === 0)) {
    errors.push(`${raw.status} detection requires evidence references`);
  }
  const operationNonSuccess = raw.operation !== 'detect' && raw.status !== 'success';
  const actionableItems = Array.isArray(raw.items)
    ? raw.items.filter((item) => isObject(item) && !SUCCESS_ITEM_STATUSES.has(item.status) && nonEmptyString(item.remediation))
    : [];
  if (operationNonSuccess && (!Array.isArray(raw.evidence) || raw.evidence.length === 0)) {
    errors.push(`${raw.status} operation requires evidence references`);
  }
  if (raw.operation !== 'detect' && raw.status === 'partial' && actionableItems.length === 0) {
    errors.push('partial operation requires an actionable non-success item');
  }
  if (raw.operation !== 'detect' && raw.status === 'skipped') {
    if (actionableItems.length === 0 && !isObject(raw.error)) errors.push('skipped operation requires an actionable item or structured error');
  }
  if (raw.operation !== 'detect' && !['success', 'partial'].includes(raw.status) && Array.isArray(raw.items) &&
      raw.items.some((item) => isObject(item) && SUCCESS_ITEM_STATUSES.has(item.status))) {
    errors.push(`${raw.status} operation cannot contain successful item dispositions; use partial for mixed outcomes`);
  }
  if (raw.status === 'failed' || raw.status === 'unsupported' || raw.status === 'manual_review' || detectionFailure) {
    if (!isObject(raw.error)) {
      errors.push('error is required for non-success results');
    }
  }
  if ((raw.operation === 'detect' && raw.status === 'supported') || (raw.operation !== 'detect' && raw.status === 'success')) {
    if (raw.error != null) errors.push(`${raw.status} result cannot contain an error`);
  }
  if (raw.error != null) {
    if (!isObject(raw.error)) {
      errors.push('error must be an object');
    } else {
      const unknown = Object.keys(raw.error).filter((key) => !['code', 'message', 'remediation', 'details'].includes(key));
      if (unknown.length > 0) errors.push(`error contains unsupported fields: ${unknown.sort().join(', ')}`);
      if (!ERROR_CODE_SET.has(raw.error.code)) errors.push('error.code must be a stable error code');
      if (detectionFailure && raw.error.code !== DETECTION_ERROR_CODES[raw.status]) {
        errors.push(`error.code must be ${DETECTION_ERROR_CODES[raw.status]} for ${raw.status} detection`);
      }
      if (!nonEmptyString(raw.error.message)) errors.push('error.message is required');
      if (!nonEmptyString(raw.error.remediation)) errors.push('error.remediation is required');
    }
  }
  const secretPaths = findRawSecretViolations(raw);
  if (secretPaths.length > 0) errors.push(`operation result contains raw secret material at: ${secretPaths.join(', ')}`);
  return errors.length === 0 ? { ok: true, value: raw } : { ok: false, errors };
}

/**
 * Validate and freeze an adapter declaration without invoking any adapter operation.
 * Runtime selection and support-matrix matching belong to the later registry slice.
 *
 * @param {object} definition
 */
export function defineRuntimeAdapter(definition) {
  plainRecord(definition, 'adapter definition');
  requireOwn(definition, ['contract_version', 'runtime_family', 'adapter_name', 'adapter_version', 'support_matrix', 'native_probe', 'capabilities', ...ADAPTER_OPERATIONS], 'adapter definition');
  if (definition.contract_version !== ADAPTER_CONTRACT_VERSION) throw new TypeError(`contract_version must be ${ADAPTER_CONTRACT_VERSION}`);
  if (!nonEmptyString(definition.runtime_family)) throw new TypeError('runtime_family is required');
  if (!nonEmptyString(definition.adapter_name)) throw new TypeError('adapter_name is required');
  if (!nonEmptyString(definition.adapter_version)) throw new TypeError('adapter_version is required');
  plainRecord(definition.capabilities, 'capabilities');
  const matrix = definition.support_matrix;
  plainRecord(matrix, 'support_matrix');
  requireOwn(matrix, ['reference', 'revision', 'runtime_version_range', 'adapter_version_range', 'compatible_platforms'], 'support_matrix');
  for (const key of ['reference', 'revision', 'runtime_version_range', 'adapter_version_range']) {
    if (!nonEmptyString(matrix[key])) throw new TypeError(`support_matrix.${key} is required`);
  }
  denseArray(matrix.compatible_platforms, 'support_matrix.compatible_platforms');
  if (matrix.compatible_platforms.length === 0 ||
      matrix.compatible_platforms.some((platform) => !isObject(platform) || !nonEmptyString(platform.os) || !nonEmptyString(platform.architecture))) {
    throw new TypeError('support_matrix.compatible_platforms must contain declared os/architecture pairs');
  }
  matrix.compatible_platforms.forEach((platform, index) => {
    plainRecord(platform, `support_matrix.compatible_platforms[${index}]`);
    requireOwn(platform, ['os', 'architecture'], `support_matrix.compatible_platforms[${index}]`);
    const unknown = Object.keys(platform).filter((key) => !['os', 'os_version', 'architecture', 'runtime', 'runtime_version'].includes(key));
    if (unknown.length > 0) throw new TypeError(`support_matrix.compatible_platforms[${index}] contains unsupported fields: ${unknown.sort().join(', ')}`);
    for (const key of ['os_version', 'runtime', 'runtime_version']) {
      if (Object.hasOwn(platform, key) && !nonEmptyString(platform[key])) throw new TypeError(`support_matrix.compatible_platforms[${index}].${key} must be a non-empty string`);
    }
  });
  const matrixUnknown = Object.keys(matrix).filter((key) => !['reference', 'revision', 'runtime_version_range', 'adapter_version_range', 'compatible_platforms'].includes(key));
  if (matrixUnknown.length > 0) throw new TypeError(`support_matrix contains unsupported fields: ${matrixUnknown.sort().join(', ')}`);
  const probe = definition.native_probe;
  plainRecord(probe, 'native_probe');
  requireOwn(probe, ['executable', 'native_version', 'subcommands', 'flags', 'non_destructive', 'attestation'], 'native_probe');
  for (const key of ['executable', 'native_version']) if (!nonEmptyString(probe[key])) throw new TypeError(`native_probe.${key} is required`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(probe.executable)) throw new TypeError('native_probe.executable must be a machine-neutral command name, not a resolved path');
  for (const key of ['subcommands', 'flags']) {
    denseArray(probe[key], `native_probe.${key}`);
    if (probe[key].some((item) => !nonEmptyString(item))) throw new TypeError(`native_probe.${key} must be an array of non-empty strings`);
    if (findRawSecretViolations({ [key]: probe[key] }).length || probe[key].some((item) => item.includes('\\') || /(?:^|[=\s])(?:\/|[A-Za-z]:[\\/]|\/\/)/.test(item))) {
      throw new TypeError(`native_probe.${key} must not contain secrets or machine-specific paths`);
    }
  }
  if (probe.non_destructive !== true) throw new TypeError('native_probe.non_destructive must be true');
  plainRecord(probe.attestation, 'native_probe.attestation');
  requireOwn(probe.attestation, ['status', 'evidence'], 'native_probe.attestation');
  if (!DETECTION_STATUS_SET.has(probe.attestation.status)) throw new TypeError('native_probe.attestation.status must be a detection status');
  const probeEvidence = cloneCapabilityEvidence(probe.attestation.evidence, 'native_probe.attestation.evidence');
  if (probeEvidence.length === 0) throw new TypeError('native_probe.attestation.evidence must contain immutable evidence references');
  const probeResultUnknown = Object.keys(probe.attestation).filter((key) => !['status', 'evidence'].includes(key));
  if (probeResultUnknown.length > 0) throw new TypeError(`native_probe.attestation contains unsupported fields: ${probeResultUnknown.sort().join(', ')}`);
  const probeUnknown = Object.keys(probe).filter((key) => !['executable', 'native_version', 'subcommands', 'flags', 'non_destructive', 'attestation'].includes(key));
  if (probeUnknown.length > 0) throw new TypeError(`native_probe contains unsupported fields: ${probeUnknown.sort().join(', ')}`);

  const declarationEvidence = new Map();
  for (const operation of ADAPTER_OPERATIONS) {
    if (typeof definition[operation] !== 'function') throw new TypeError(`${operation} must be a function`);
    const capability = definition.capabilities[operation];
    plainRecord(capability, `capabilities.${operation}`);
    requireOwn(capability, ['available', 'mechanism', 'evidence'], `capabilities.${operation}`);
    if (typeof capability.available !== 'boolean') throw new TypeError(`capabilities.${operation}.available must be a boolean`);
    if (!MECHANISM_SET.has(capability.mechanism)) throw new TypeError(`capabilities.${operation}.mechanism is invalid`);
    const evidence = cloneCapabilityEvidence(capability.evidence, `capabilities.${operation}.evidence`);
    if (capability.available === true && capability.evidence.length === 0) {
      throw new TypeError(`available capabilities.${operation}.evidence must contain at least one reference`);
    }
    if (capability.available === false && capability.mechanism !== 'manual_action') {
      throw new TypeError(`unavailable capabilities.${operation} must use manual_action`);
    }
    const unknown = Object.keys(capability).filter((key) => !['available', 'mechanism', 'evidence'].includes(key));
    if (unknown.length) throw new TypeError(`capabilities.${operation} contains unsupported fields: ${unknown.sort().join(', ')}`);
    declarationEvidence.set(operation, evidence);
  }
  for (const operation of Object.keys(definition.capabilities)) {
    if (!OPERATION_SET.has(operation)) throw new TypeError(`capabilities.${operation} is not a declared operation`);
  }

  const supportMatrix = deepFreeze(structuredClone(matrix));
  const nativeProbe = deepFreeze({
    executable: probe.executable,
    native_version: probe.native_version,
    subcommands: [...probe.subcommands],
    flags: [...probe.flags],
    non_destructive: true,
    attestation: { status: probe.attestation.status, evidence: probeEvidence },
  });
  const allowedTop = new Set(['contract_version', 'runtime_family', 'adapter_name', 'adapter_version', 'support_matrix', 'native_probe', 'capabilities', ...ADAPTER_OPERATIONS]);
  const unknownTop = Object.keys(definition).filter((key) => !allowedTop.has(key));
  if (unknownTop.length) throw new TypeError(`adapter definition contains unsupported fields: ${unknownTop.sort().join(', ')}`);
  const capabilities = Object.fromEntries(ADAPTER_OPERATIONS.map((operation) => {
    const source = definition.capabilities[operation];
    return [operation, deepFreeze({ available: source.available, mechanism: source.mechanism, evidence: declarationEvidence.get(operation) })];
  }));
  return Object.freeze({
    contract_version: definition.contract_version,
    runtime_family: definition.runtime_family,
    adapter_name: definition.adapter_name,
    adapter_version: definition.adapter_version,
    support_matrix: supportMatrix,
    native_probe: nativeProbe,
    capabilities: deepFreeze(capabilities),
    ...Object.fromEntries(ADAPTER_OPERATIONS.map((operation) => [operation, definition[operation]])),
  });
}
