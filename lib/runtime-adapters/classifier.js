import path from 'node:path';
import { STATE_CLASSES } from './types.js';
import { normalizePortableRelativePath } from './portable-path.js';

const ROOT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const LOGICAL_STORE_ID_RE = /^(?!.*\.\.)[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HEX_256_RE = /^[a-f0-9]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const ALLOWED_ROOT_KINDS = new Set(['runtime', 'workspace', 'profile', 'external_provider', 'logical_store']);
const ALLOWED_ENTRY_KINDS = new Set(['file', 'directory', 'database', 'native_archive', 'logical_record', 'symlink', 'hardlink']);
const UNSUPPORTED_ENTRY_KINDS = new Set(['socket', 'fifo', 'character_device', 'block_device', 'device', 'unknown']);
const NONDURABLE_SEMANTIC_ROLES = new Set(['lock', 'pid', 'active_lease', 'pending_approval', 'live_harness_state']);
const SEMANTIC_ROLES = new Set(['durable', ...NONDURABLE_SEMANTIC_ROLES]);
const STATE_CLASS_SET = new Set(STATE_CLASSES);
const SENSITIVITIES = new Set(['ordinary', 'personal', 'confidential', 'secret_metadata']);
const EXTERNAL_REQUIRED_FIELDS = Object.freeze([
  'provider', 'ownership', 'approved_destination_class', 'containment_policy', 'restoration_requirements',
]);

function fail(message) {
  throw new TypeError(message);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isAbsolutePortable(value) {
  return path.posix.isAbsolute(value) || WINDOWS_ABSOLUTE_RE.test(value);
}

function pathApiFor(value) {
  return WINDOWS_ABSOLUTE_RE.test(value) ? path.win32 : path.posix;
}

function isContained(root, candidate) {
  if (!nonEmptyString(root) || !nonEmptyString(candidate)) return false;
  const rootApi = pathApiFor(root);
  if (rootApi !== pathApiFor(candidate)) return false;
  const relative = rootApi.relative(rootApi.resolve(root), rootApi.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !rootApi.isAbsolute(relative));
}

export function normalizeRelativePath(value) {
  return normalizePortableRelativePath(value);
}

function validateAbsoluteLocalPath(value, field) {
  if (!nonEmptyString(value) || CONTROL_RE.test(value) || !isAbsolutePortable(value)) {
    fail(`${field} must be an absolute local path without control characters`);
  }
}

export function validateLogicalRoots(logicalRoots) {
  if (!Array.isArray(logicalRoots) || logicalRoots.length === 0) fail('logical_roots must be a non-empty array');
  const ids = new Set();
  return logicalRoots.map((input, index) => {
    if (!isPlainRecord(input)) fail(`logical_roots[${index}] must be a plain object`);
    if (!own(input, 'id') || !nonEmptyString(input.id) || !ROOT_ID_RE.test(input.id)) fail(`logical root id at index ${index} is invalid`);
    if (ids.has(input.id)) fail(`logical root id ${input.id} is duplicated`);
    ids.add(input.id);
    if (!own(input, 'kind') || !ALLOWED_ROOT_KINDS.has(input.kind)) fail(`logical root ${input.id} has an invalid kind`);
    if (input.kind !== 'logical_store') {
      if (!own(input, 'source_path') || !own(input, 'real_path')) fail(`logical root ${input.id} filesystem paths must be own properties`);
      validateAbsoluteLocalPath(input.source_path, `logical root ${input.id}.source_path`);
      validateAbsoluteLocalPath(input.real_path, `logical root ${input.id}.real_path`);
    }
    if (input.kind === 'external_provider') {
      for (const field of EXTERNAL_REQUIRED_FIELDS) {
        if (!own(input, field) || input[field] == null || input[field] === '' ||
            (field === 'restoration_requirements' && (!Array.isArray(input[field]) || input[field].length === 0))) {
          fail(`external logical root ${input.id}.${field} is required`);
        }
      }
      if (!nonEmptyString(input.provider)) fail(`external logical root ${input.id}.provider must be a non-empty string`);
      if (!nonEmptyString(input.ownership)) fail(`external logical root ${input.id}.ownership must be a non-empty string`);
      if (input.approved_destination_class !== 'external_state') fail(`external logical root ${input.id}.approved_destination_class must be external_state`);
      if (input.containment_policy !== 'realpath_within_root') fail(`external logical root ${input.id}.containment_policy is unsupported`);
      if (input.restoration_requirements.some((value) => !nonEmptyString(value))) fail(`external logical root ${input.id}.restoration_requirements must contain non-empty strings`);
    }
    return Object.freeze({
      ...input,
      ...(Array.isArray(input.restoration_requirements)
        ? { restoration_requirements: Object.freeze([...input.restoration_requirements]) }
        : {}),
    });
  });
}

function portableLinkDescription(linkTarget) {
  if (!nonEmptyString(linkTarget)) return { target_type: 'unknown', target_recorded: false };
  if (isAbsolutePortable(linkTarget)) return { target_type: 'absolute', target_recorded: false };
  try {
    return { target_type: 'relative', target_recorded: true, target: normalizeRelativePath(linkTarget) };
  } catch {
    return { target_type: 'unsafe', target_recorded: false };
  }
}

function inventoryMetadata(entry) {
  if (!['item_id', 'durability', 'semantic_role', 'size_bytes', 'checksum', 'sensitivity', 'provenance', 'reason'].every((key) => own(entry, key))) return null;
  if (!nonEmptyString(entry.item_id)) return null;
  if (!['required', 'potentially_durable', 'non_durable'].includes(entry.durability)) return null;
  if (!SEMANTIC_ROLES.has(entry.semantic_role)) return null;
  if (!Number.isInteger(entry.size_bytes) || entry.size_bytes < 0) return null;
  if (!isPlainRecord(entry.checksum) || !['required', 'metadata_only', 'not_applicable'].includes(entry.checksum.policy)) return null;
  const checksumKeys = Object.keys(entry.checksum);
  if (checksumKeys.some((key) => !['policy', 'algorithm', 'digest'].includes(key))) return null;
  if (entry.checksum.policy === 'required' &&
      (!['sha256', 'hmac-sha256'].includes(entry.checksum.algorithm) || !HEX_256_RE.test(entry.checksum.digest))) return null;
  if (entry.checksum.policy !== 'required' && (entry.checksum.algorithm != null || entry.checksum.digest != null)) return null;
  if (!SENSITIVITIES.has(entry.sensitivity)) return null;
  if (!isPlainRecord(entry.provenance) || !nonEmptyString(entry.provenance.source) ||
      Object.keys(entry.provenance).some((key) => !['source', 'native_artifact_id'].includes(key)) ||
      (entry.provenance.native_artifact_id != null && !nonEmptyString(entry.provenance.native_artifact_id))) return null;
  if (!nonEmptyString(entry.reason)) return null;
  return {
    item_id: entry.item_id,
    durability: entry.durability,
    semantic_role: entry.semantic_role,
    size_bytes: entry.size_bytes,
    checksum: { ...entry.checksum },
    sensitivity: entry.sensitivity,
    provenance: { ...entry.provenance },
    reason: entry.reason,
  };
}

function withClassifiedMetadata(entry, classified) {
  const metadata = inventoryMetadata(classified);
  if (metadata == null) fail(`classified inventory entry ${String(classified?.item_id ?? '<unknown>')} lost requirement-11 metadata`);
  return { ...entry, ...metadata };
}

function locatorFor(entry, root) {
  if (entry.kind === 'logical_record') {
    if (root.kind !== 'logical_store' || !own(entry, 'logical_store_id') || !LOGICAL_STORE_ID_RE.test(entry.logical_store_id) || own(entry, 'relative_path')) {
      fail('logical_record entries require exactly one typed logical_store_id under a logical_store root');
    }
    return { logical_root: root.id, logical_store_id: entry.logical_store_id };
  }
  if (root.kind === 'logical_store') fail('filesystem entries cannot use a logical_store root');
  if (!own(entry, 'relative_path') || own(entry, 'logical_store_id')) fail('filesystem entries require exactly one own relative_path');
  return { logical_root: root.id, relative_path: normalizeRelativePath(entry.relative_path) };
}

function manualReview(entry, locator, reasonCode, kind = entry.kind, extras = {}) {
  const metadata = inventoryMetadata(entry);
  if (metadata == null) fail(`inventory entry ${String(entry.item_id ?? '<unknown>')} has incomplete requirement-11 metadata`);
  return {
    ...locator,
    kind,
    ...metadata,
    state_class: 'manual_review',
    disposition: 'manual_review',
    capture_method: 'manual_action',
    restore_policy: 'manual_review',
    reason_code: reasonCode,
    ...extras,
  };
}

function nondurableResult(entry, locator, reasonCode, kind = entry.kind, extras = {}) {
  const metadata = inventoryMetadata(entry);
  if (metadata == null) fail(`inventory entry ${String(entry.item_id ?? '<unknown>')} has incomplete requirement-11 metadata`);
  return {
    ...locator,
    kind,
    ...metadata,
    ...extras,
    state_class: 'machine_local',
    disposition: 'excluded',
    capture_method: 'excluded',
    restore_policy: 'recreate',
    reason_code: reasonCode,
  };
}

function classifyByRules(locator, root, rules) {
  for (const rule of rules) {
    if (rule.logical_root !== locator.logical_root) continue;
    if (rule.logical_store_id != null && rule.logical_store_id === locator.logical_store_id) return rule;
    if (rule.relative_path != null && rule.relative_path === locator.relative_path) return rule;
    if (rule.path_prefix != null && (locator.relative_path === rule.path_prefix || locator.relative_path?.startsWith(`${rule.path_prefix}/`))) return rule;
  }
  return null;
}

function rulesOverlap(left, right) {
  if (left.logical_root !== right.logical_root) return false;
  if (left.logical_store_id != null || right.logical_store_id != null) {
    return left.logical_store_id != null && left.logical_store_id === right.logical_store_id;
  }
  if (left.relative_path != null && right.relative_path != null) return left.relative_path === right.relative_path;
  if (left.path_prefix != null && right.path_prefix != null) {
    return left.path_prefix === right.path_prefix || left.path_prefix.startsWith(`${right.path_prefix}/`) || right.path_prefix.startsWith(`${left.path_prefix}/`);
  }
  const exact = left.relative_path ?? right.relative_path;
  const prefix = left.path_prefix ?? right.path_prefix;
  return exact === prefix || exact.startsWith(`${prefix}/`);
}

function rulePolicySignature(rule) {
  return `${rule.state_class}\0${rule.semantic_role}`;
}

function ruleSortKey(rule) {
  if (rule.logical_store_id != null) return `0\0${rule.logical_root}\0${rule.logical_store_id}`;
  if (rule.relative_path != null) return `0\0${rule.logical_root}\0${rule.relative_path}`;
  return `1\0${rule.logical_root}\0${String(999999 - rule.path_prefix.length).padStart(6, '0')}\0${rule.path_prefix}`;
}

function validateRules(rules, rootsById) {
  if (!Array.isArray(rules)) fail('rules must be an array');
  const validated = rules.map((rule, index) => {
    if (!isPlainRecord(rule)) fail(`rules[${index}] must be a plain object`);
    if (!own(rule, 'logical_root') || !rootsById.has(rule.logical_root)) fail(`rules[${index}].logical_root is invalid`);
    if (!own(rule, 'state_class') || !STATE_CLASS_SET.has(rule.state_class)) fail(`rules[${index}].state_class is invalid`);
    if (!own(rule, 'semantic_role') || !SEMANTIC_ROLES.has(rule.semantic_role)) fail(`rules[${index}].semantic_role is invalid`);
    if (NONDURABLE_SEMANTIC_ROLES.has(rule.semantic_role) && rule.state_class !== 'machine_local') {
      fail(`rules[${index}] nondurable semantic_role requires machine_local state_class`);
    }
    if (rootsById.get(rule.logical_root).kind === 'external_provider' && rule.state_class !== 'external_state') {
      fail(`rules[${index}] for an external_provider root must classify only external_state`);
    }
    const selectors = ['relative_path', 'path_prefix', 'logical_store_id'].filter((key) => own(rule, key));
    if (selectors.length !== 1) fail(`rules[${index}] must declare exactly one relative_path, path_prefix, or logical_store_id`);
    const selector = selectors[0];
    if (selector === 'logical_store_id') {
      if (rootsById.get(rule.logical_root).kind !== 'logical_store' || !LOGICAL_STORE_ID_RE.test(rule.logical_store_id)) fail(`rules[${index}].logical_store_id is invalid`);
      return Object.freeze({ logical_root: rule.logical_root, state_class: rule.state_class, semantic_role: rule.semantic_role, logical_store_id: rule.logical_store_id });
    }
    if (rootsById.get(rule.logical_root).kind === 'logical_store') fail(`rules[${index}] filesystem selector cannot use a logical_store root`);
    return Object.freeze({ logical_root: rule.logical_root, state_class: rule.state_class, semantic_role: rule.semantic_role, [selector]: normalizeRelativePath(rule[selector]) });
  });
  for (let left = 0; left < validated.length; left += 1) {
    for (let right = left + 1; right < validated.length; right += 1) {
      if (rulesOverlap(validated[left], validated[right]) && rulePolicySignature(validated[left]) !== rulePolicySignature(validated[right])) {
        fail(`ambiguous overlapping rules[${left}] and rules[${right}] declare different state classes or semantic roles`);
      }
    }
  }
  return validated.sort((left, right) => ruleSortKey(left).localeCompare(ruleSortKey(right)));
}

function externalReferenceFor(realPath, externalRoots) {
  if (!nonEmptyString(realPath) || CONTROL_RE.test(realPath) || !isAbsolutePortable(realPath)) return null;
  for (const root of externalRoots) {
    if (!isContained(root.real_path, realPath)) continue;
    const api = pathApiFor(root.real_path);
    const relative = api.relative(api.resolve(root.real_path), api.resolve(realPath)).split(api.sep).join('/');
    if (!relative) return null;
    return { logical_root: root.id, relative_path: normalizeRelativePath(relative) };
  }
  return null;
}

function createEntryClassifier(config) {
  if (!isPlainRecord(config)) fail('classifier config must be a plain object');
  if (!own(config, 'logical_roots')) fail('classifier config logical_roots must be an own property');
  const logicalRoots = validateLogicalRoots(config.logical_roots);
  const rootsById = new Map(logicalRoots.map((root) => [root.id, root]));
  const rules = validateRules(own(config, 'rules') ? config.rules : [], rootsById);
  const externalRoots = logicalRoots.filter((root) => root.kind === 'external_provider')
    .sort((left, right) => right.real_path.length - left.real_path.length);

  function classify(entry) {
    if (!isPlainRecord(entry)) fail('inventory entry must be a plain object with own properties');
    if (!own(entry, 'logical_root') || !own(entry, 'kind')) fail('inventory entry logical_root and kind must be own properties');
    const root = rootsById.get(entry.logical_root);
    if (!root) fail(`inventory entry references unknown logical root ${String(entry.logical_root)}`);
    const locator = locatorFor(entry, root);
    const metadata = inventoryMetadata(entry);
    if (metadata == null) fail(`inventory entry ${String(entry.item_id ?? '<unknown>')} has incomplete requirement-11 metadata`);
    const sourceRule = classifyByRules(locator, root, rules);
    if (sourceRule?.state_class === 'secret') {
      const reasonCode = sourceRule.semantic_role === entry.semantic_role
        ? 'SECRET_PAYLOAD_CAPTURE_FORBIDDEN'
        : 'SEMANTIC_ROLE_MISMATCH';
      const secretMetadata = {
        ...metadata,
        semantic_role: sourceRule.semantic_role,
        checksum: { policy: 'metadata_only' },
        sensitivity: 'secret_metadata',
      };
      if (UNSUPPORTED_ENTRY_KINDS.has(entry.kind) || !ALLOWED_ENTRY_KINDS.has(entry.kind)) {
        return manualReview({ ...entry, ...secretMetadata }, locator, reasonCode, 'unsupported', { discovered_kind: String(entry.kind) });
      }
      if (entry.kind === 'hardlink') {
        return manualReview({ ...entry, ...secretMetadata }, locator, reasonCode, 'hardlink', { hardlink: { status: 'incomplete' } });
      }
      if (entry.kind === 'symlink') {
        return {
          ...locator, kind: 'symlink', ...secretMetadata,
          link: portableLinkDescription(own(entry, 'link_target') ? entry.link_target : undefined),
          state_class: 'secret', disposition: 'manual_review', capture_method: 'manual_action',
          restore_policy: 'manual_review', capture: { follow: false }, reason_code: reasonCode,
        };
      }
      return {
        ...locator, kind: entry.kind, ...secretMetadata, state_class: 'secret',
        disposition: 'manual_review', capture_method: 'manual_action', restore_policy: 'manual_review',
        reason_code: reasonCode,
      };
    }
    if (NONDURABLE_SEMANTIC_ROLES.has(entry.semantic_role)) {
      if (UNSUPPORTED_ENTRY_KINDS.has(entry.kind) || !ALLOWED_ENTRY_KINDS.has(entry.kind)) {
        return nondurableResult(entry, locator, 'PROCESS_STATE_UNSUPPORTED_FILE_TYPE', 'unsupported', {
          discovered_kind: String(entry.kind),
        });
      }
      if (entry.kind === 'hardlink') {
        return nondurableResult(entry, locator, 'PROCESS_STATE_UNRESOLVED_HARDLINK', 'hardlink', {
          hardlink: { status: 'incomplete' },
        });
      }
      if (entry.kind === 'symlink') {
        return nondurableResult(entry, locator, 'PROCESS_STATE_SYMLINK_NOT_FOLLOWED', 'symlink', {
          link: portableLinkDescription(own(entry, 'link_target') ? entry.link_target : undefined),
          capture: { follow: false },
        });
      }
      return nondurableResult(entry, locator, 'PROCESS_STATE_NOT_DURABLE');
    }
    if (UNSUPPORTED_ENTRY_KINDS.has(entry.kind) || !ALLOWED_ENTRY_KINDS.has(entry.kind)) {
      return manualReview(entry, locator, 'UNSUPPORTED_FILE_TYPE', 'unsupported', { discovered_kind: String(entry.kind) });
    }
    if (entry.kind === 'hardlink') return manualReview(entry, locator, 'UNRESOLVED_HARDLINK', 'hardlink', { hardlink: { status: 'incomplete' } });
    if (entry.kind === 'symlink') {
      const base = { ...locator, kind: 'symlink', link: portableLinkDescription(own(entry, 'link_target') ? entry.link_target : undefined) };
      const sourceClass = sourceRule?.state_class ?? 'manual_review';
      if (base.link.target_type === 'unknown' || base.link.target_type === 'unsafe') {
        return manualReview(entry, locator, 'SYMLINK_TARGET_UNSAFE', 'symlink', { link: base.link, capture: { follow: false } });
      }
      if (sourceRule != null && sourceRule.semantic_role !== entry.semantic_role) {
        return manualReview(entry, locator, 'SEMANTIC_ROLE_MISMATCH', 'symlink', { link: base.link, capture: { follow: false } });
      }
      if (!own(entry, 'follow') || entry.follow !== true) {
        if (sourceClass === 'manual_review') {
          return manualReview(entry, locator, 'SYMLINK_INVENTORIED_NOT_FOLLOWED', 'symlink', { link: base.link, capture: { follow: false } });
        }
        if (['machine_local', 'cache', 'reproducible'].includes(sourceClass)) {
          return { ...base, ...metadata, state_class: sourceClass, disposition: 'excluded', capture_method: 'excluded', restore_policy: sourceClass === 'cache' ? 'skip' : 'recreate', capture: { follow: false }, reason_code: 'SYMLINK_SOURCE_EXCLUDED' };
        }
        return { ...base, ...metadata, state_class: sourceClass, disposition: 'referenced', capture_method: 'reference_only', restore_policy: 'manual_review', capture: { follow: false }, reason_code: 'SYMLINK_INVENTORIED_NOT_FOLLOWED' };
      }
      if (['machine_local', 'cache', 'reproducible'].includes(sourceClass)) {
        return { ...base, ...metadata, state_class: sourceClass, disposition: 'excluded', capture_method: 'excluded', restore_policy: sourceClass === 'cache' ? 'skip' : 'recreate', capture: { follow: false }, reason_code: 'SYMLINK_SOURCE_EXCLUDED' };
      }
      if (sourceClass === 'manual_review') {
        return manualReview(entry, locator, 'SYMLINK_SOURCE_NOT_CAPTURE_ELIGIBLE', 'symlink', { link: base.link, capture: { follow: false } });
      }
      const externalReference = externalReferenceFor(entry.real_path, externalRoots);
      if (!externalReference) return manualReview(entry, locator, 'EXTERNAL_PATH_UNAPPROVED', 'symlink', { link: base.link, capture: { follow: false } });
      const externalRoot = rootsById.get(externalReference.logical_root);
      const externalRule = classifyByRules(externalReference, externalRoot, rules);
      if (externalRule?.state_class !== 'external_state' || externalRule.semantic_role !== entry.semantic_role) {
        return manualReview(entry, locator, 'EXTERNAL_PATH_UNAPPROVED', 'symlink', { link: base.link, capture: { follow: false } });
      }
      return {
        ...base, ...metadata, state_class: externalRoot.approved_destination_class,
        disposition: 'captured', capture_method: 'safe_filesystem', restore_policy: 'restore',
        capture: { follow: true, external_root: externalReference.logical_root }, external_reference: externalReference,
      };
    }

    if (entry.kind !== 'logical_record' &&
        (!own(entry, 'real_path') || !nonEmptyString(entry.real_path) || !isAbsolutePortable(entry.real_path) || !isContained(root.real_path, entry.real_path))) {
      return manualReview(entry, locator, own(entry, 'real_path') ? 'LOGICAL_ROOT_ESCAPE' : 'REALPATH_EVIDENCE_REQUIRED');
    }
    const matchedRule = sourceRule;
    if (matchedRule == null) return manualReview(entry, locator, 'UNMATCHED_CLASSIFICATION_RULE');
    if (matchedRule.semantic_role !== entry.semantic_role) return manualReview(entry, locator, 'SEMANTIC_ROLE_MISMATCH');
    const stateClass = matchedRule.state_class;
    if (NONDURABLE_SEMANTIC_ROLES.has(matchedRule.semantic_role)) {
      return {
        ...locator, kind: entry.kind, ...metadata,
        state_class: 'machine_local', disposition: 'excluded', capture_method: 'excluded',
        restore_policy: 'recreate', reason_code: 'PROCESS_STATE_NOT_DURABLE',
      };
    }
    if (stateClass === 'secret') {
      return {
        ...locator, kind: entry.kind, ...metadata, checksum: { policy: 'metadata_only' }, sensitivity: 'secret_metadata', state_class: 'secret',
        disposition: 'manual_review', capture_method: 'manual_action', restore_policy: 'manual_review',
        reason_code: 'SECRET_PAYLOAD_CAPTURE_FORBIDDEN',
      };
    }
    if (['reproducible', 'machine_local', 'cache'].includes(stateClass)) {
      return {
        ...locator, kind: entry.kind, ...metadata, state_class: stateClass,
        disposition: 'excluded', capture_method: 'excluded',
        restore_policy: stateClass === 'cache' ? 'skip' : 'recreate',
        reason_code: 'STATE_CLASS_NOT_CAPTURED',
      };
    }
    return {
      ...locator, kind: entry.kind, ...metadata, state_class: stateClass, disposition: 'captured',
      capture_method: entry.kind === 'logical_record' ? 'database_api' : 'safe_filesystem', restore_policy: 'restore',
    };
  }

  const portableRoots = logicalRoots.map((root) => Object.freeze({
    id: root.id, kind: root.kind,
    ...(root.kind === 'external_provider' ? {
      provider: root.provider, ownership: root.ownership,
      approved_destination_class: root.approved_destination_class,
      containment_policy: root.containment_policy,
      restoration_requirements: root.restoration_requirements,
    } : {}),
  }));
  return Object.freeze({ classify, logical_roots: Object.freeze(portableRoots) });
}

export function createClassifier(config) {
  if (!isPlainRecord(config) || !own(config, 'target_semantics')) fail('target semantics are required as an own property for public classification');
  const entryClassifier = createEntryClassifier(config);
  const targetSemantics = snapshotTargetSemantics(config.target_semantics);
  return Object.freeze({
    classifyEntries(entries) { return classifyEntriesWithSnapshot(entries, entryClassifier, targetSemantics); },
    logical_roots: entryClassifier.logical_roots,
  });
}

function snapshotTargetSemantics(targetSemantics) {
  // Validate before copying so the retained snapshot contains only the two
  // contract fields and cannot alias caller-owned objects.
  detectPathCollisions([], targetSemantics);
  return Object.freeze({
    case_sensitive: targetSemantics.case_sensitive,
    unicode_normalization: targetSemantics.unicode_normalization,
  });
}

export function classifyFilesystemEntries(entries, config) {
  if (!Array.isArray(entries)) fail('entries must be an array');
  if (!isPlainRecord(config) || !own(config, 'target_semantics')) fail('target semantics are required as an own property for batch classification');
  const targetSemantics = snapshotTargetSemantics(config.target_semantics);
  const classifier = createEntryClassifier(config);
  return classifyEntriesWithSnapshot(entries, classifier, targetSemantics);
}

function classifyEntriesWithSnapshot(entries, classifier, targetSemantics) {
  if (!Array.isArray(entries)) fail('entries must be an array');
  const itemIds = new Set();
  for (const entry of entries) {
    if (!isPlainRecord(entry)) fail('inventory entry must be a plain object with own properties');
    if (!own(entry, 'semantic_role') || !SEMANTIC_ROLES.has(entry.semantic_role)) {
      fail(`inventory entry ${String(entry.item_id ?? '<unknown>')}.semantic_role must be an own validated semantic role`);
    }
    if (own(entry, 'process_state')) fail(`inventory entry ${String(entry.item_id ?? '<unknown>')}.process_state is unsupported; use semantic_role`);
    if (NONDURABLE_SEMANTIC_ROLES.has(entry.semantic_role) && entry.durability !== 'non_durable') {
      fail(`inventory entry ${String(entry.item_id ?? '<unknown>')} nondurable semantic_role requires durability non_durable`);
    }
    const metadata = inventoryMetadata(entry);
    if (metadata == null) fail(`inventory entry ${String(entry.item_id ?? '<unknown>')} has incomplete requirement-11 metadata`);
    if (itemIds.has(metadata.item_id)) fail(`inventory entry item_id ${metadata.item_id} is duplicated`);
    itemIds.add(metadata.item_id);
  }
  const classified = entries.map((entry) => classifier.classify(entry));

  const filesystemItems = [];
  const filesystemIndexes = [];
  classified.forEach((item, index) => {
    if (item.relative_path != null) { filesystemItems.push(item); filesystemIndexes.push(index); }
  });
  const collisions = detectPathCollisions(filesystemItems, targetSemantics);
  const collisionTypesByIndex = new Map();
  for (const collision of collisions) {
    for (const localIndex of collision.item_indexes) {
      const index = filesystemIndexes[localIndex];
      const types = collisionTypesByIndex.get(index) ?? new Set();
      types.add(collision.type);
      collisionTypesByIndex.set(index, types);
    }
  }
  for (const [index, types] of collisionTypesByIndex) {
    const current = classified[index];
    const quarantinedEntry = withClassifiedMetadata(entries[index], current);
    const extras = { collision_types: [...types].sort() };
    if (current.kind === 'symlink') {
      Object.assign(extras, { link: current.link, capture: { follow: false } });
    } else if (current.kind === 'unsupported') {
      Object.assign(extras, { discovered_kind: current.discovered_kind });
    } else if (current.kind === 'hardlink' || current.hardlink != null) {
      Object.assign(extras, { hardlink: { status: 'incomplete' } });
    }
    const locator = { logical_root: current.logical_root, relative_path: current.relative_path };
    classified[index] = NONDURABLE_SEMANTIC_ROLES.has(current.semantic_role)
      ? nondurableResult(quarantinedEntry, locator, 'PROCESS_STATE_TARGET_PATH_COLLISION', current.kind, extras)
      : manualReview(quarantinedEntry, locator, 'TARGET_PATH_COLLISION', current.kind, extras);
  }

  const groups = new Map();
  entries.forEach((entry, index) => {
    if (entry.kind !== 'file') return;
    const hasHardlinkMetadata = own(entry, 'device') || own(entry, 'inode') || own(entry, 'link_count');
    if (!hasHardlinkMetadata) return;
    if (!Number.isInteger(entry.link_count) || entry.link_count < 1 ||
        (entry.link_count > 1 && (!own(entry, 'device') || !own(entry, 'inode') || entry.device == null || entry.inode == null))) {
      const locator = { logical_root: classified[index].logical_root, relative_path: classified[index].relative_path };
      const quarantinedEntry = withClassifiedMetadata(entry, classified[index]);
      classified[index] = NONDURABLE_SEMANTIC_ROLES.has(classified[index].semantic_role)
        ? nondurableResult(quarantinedEntry, locator, 'PROCESS_STATE_INVALID_HARDLINK_METADATA', 'file', { hardlink: { status: 'incomplete' } })
        : manualReview(quarantinedEntry, locator, 'INVALID_HARDLINK_METADATA', 'file');
      return;
    }
    if (entry.link_count <= 1) return;
    const key = `${typeof entry.device}:${String(entry.device)}:${typeof entry.inode}:${String(entry.inode)}`;
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });
  for (const indexes of groups.values()) {
    const declaredLinks = Math.max(...indexes.map((index) => entries[index].link_count));
    const observedLinks = indexes.length;
    const structurallyComplete = observedLinks === declaredLinks && indexes.every((index) => entries[index].link_count === declaredLinks);
    // hardlink_to is a logical-root-relative reference. A physical inode observed
    // through multiple roots cannot be represented as one portable hardlink group.
    const crossesLogicalRoots = new Set(indexes.map((index) => classified[index].logical_root)).size > 1;
    const policySignature = (index) => {
      const item = classified[index];
      return [item.logical_root, item.state_class, item.durability, item.semantic_role, item.capture_method, item.restore_policy, item.disposition,
        item.sensitivity, item.size_bytes, JSON.stringify(item.checksum)].join('\0');
    };
    const representationEligible = indexes.every((index) =>
      ((classified[index].disposition === 'captured' && ['safe_filesystem', 'database_api'].includes(classified[index].capture_method)) ||
       (classified[index].disposition === 'excluded' && classified[index].capture_method === 'excluded')) &&
      !['secret', 'manual_review'].includes(classified[index].state_class));
    const policyConsistent = indexes.every((index) => policySignature(index) === policySignature(indexes[0]));
    const groupCollisionTypes = [...new Set(indexes.flatMap((index) => classified[index].collision_types ?? []))].sort();
    if (!structurallyComplete || crossesLogicalRoots || !representationEligible || !policyConsistent || groupCollisionTypes.length > 0) {
      const reasonCode = groupCollisionTypes.length > 0
        ? 'HARDLINK_GROUP_COLLISION'
        : (!structurallyComplete
            ? 'INCOMPLETE_HARDLINK_GROUP'
            : (crossesLogicalRoots ? 'CROSS_LOGICAL_ROOT_HARDLINK_GROUP' : 'HARDLINK_GROUP_POLICY_CONFLICT'));
      for (const index of indexes) {
        const locator = { logical_root: classified[index].logical_root, relative_path: classified[index].relative_path };
        // Quarantine changes representation policy, but must not resurrect raw
        // secret metadata that classification has already redacted.
        const quarantinedEntry = withClassifiedMetadata(entries[index], classified[index]);
        const extras = {
          hardlink: { status: 'incomplete' },
          ...(groupCollisionTypes.length > 0 ? { collision_types: groupCollisionTypes } : {}),
        };
        classified[index] = NONDURABLE_SEMANTIC_ROLES.has(classified[index].semantic_role)
          ? nondurableResult(quarantinedEntry, locator, `PROCESS_STATE_${reasonCode}`, 'file', extras)
          : manualReview(quarantinedEntry, locator, reasonCode, 'file', extras);
      }
      continue;
    }
    const first = indexes[0];
    classified[first] = { ...classified[first], hardlink: { status: 'complete' } };
    for (const index of indexes.slice(1)) {
      classified[index] = {
        ...classified[index], kind: 'hardlink',
        hardlink: { status: 'complete' },
        hardlink_to: { logical_root: classified[first].logical_root, relative_path: classified[first].relative_path },
      };
    }
  }
  return classified;
}

export function detectPathCollisions(items, targetSemantics) {
  if (!Array.isArray(items)) fail('items must be an array');
  if (!targetSemantics || typeof targetSemantics.case_sensitive !== 'boolean') fail('target semantics must declare case_sensitive');
  if (!['NFC', 'NFD', 'none'].includes(targetSemantics.unicode_normalization)) fail('target semantics unicode_normalization must be NFC, NFD, or none');
  const seen = new Map();
  const collisions = [];
  items.forEach((item, index) => {
    if (!nonEmptyString(item.logical_root)) fail(`items[${index}].logical_root is required`);
    const sourcePath = normalizeRelativePath(item.relative_path);
    const normalizedPath = targetSemantics.unicode_normalization === 'none' ? sourcePath : sourcePath.normalize(targetSemantics.unicode_normalization);
    const targetPath = targetSemantics.case_sensitive ? normalizedPath : normalizedPath.toLowerCase();
    const key = `${item.logical_root}\0${targetPath}`;
    const prior = seen.get(key);
    if (!prior) { seen.set(key, { sourcePath, normalizedPath, index }); return; }
    let type = 'exact';
    if (prior.normalizedPath !== prior.sourcePath || normalizedPath !== sourcePath) type = 'path_normalization';
    else if (prior.sourcePath !== sourcePath && prior.sourcePath.toLowerCase() === sourcePath.toLowerCase()) type = 'case_only';
    collisions.push({ type, logical_root: item.logical_root, paths: [prior.sourcePath, sourcePath], item_indexes: [prior.index, index], target_path: targetPath });
  });
  return collisions;
}
