const NONDURABLE_SEMANTIC_ROLES = new Set(['lock', 'pid', 'active_lease', 'pending_approval', 'live_harness_state']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the relational policy invariants shared by inventory reports and
 * runtime manifests. Shape/grammar validation remains the responsibility of
 * each owning document validator.
 *
 * @param {Record<string, any>} item
 * @param {string} path
 * @returns {string[]}
 */
export function itemInvariantErrors(item, path) {
  const errors = [];
  const nondurableExcluded = NONDURABLE_SEMANTIC_ROLES.has(item.semantic_role) &&
    item.durability === 'non_durable' && item.state_class === 'machine_local' &&
    item.capture_method === 'excluded' && item.disposition === 'excluded' && item.restore_policy === 'recreate';

  if (item.kind === 'unsupported' ? !nonEmptyString(item.discovered_kind) : item.discovered_kind != null) {
    errors.push(`${path}.discovered_kind is required only for unsupported items`);
  }
  if (item.kind === 'unsupported' && item.state_class !== 'manual_review' && !nondurableExcluded) {
    errors.push(`${path} unsupported items must remain manual_review or excluded nondurable machine_local state`);
  }

  if (item.link != null && item.kind !== 'symlink') errors.push(`${path}.link is only valid for symlink items`);
  if (item.capture != null && item.kind !== 'symlink') errors.push(`${path}.capture is only valid for symlink items`);
  if (item.kind === 'symlink' && (item.link == null || item.capture == null)) {
    errors.push(`${path} symlink items require link and capture safety evidence`);
  }

  if (item.kind === 'hardlink' && item.hardlink?.status === 'complete' && item.hardlink_to == null) {
    errors.push(`${path} complete hardlink items require hardlink_to safety evidence`);
  }
  if (item.kind === 'hardlink' && item.hardlink?.status === 'incomplete' && item.hardlink_to != null) {
    errors.push(`${path} incomplete hardlink items must not fabricate hardlink_to evidence`);
  }
  if (item.hardlink_to != null && (item.kind !== 'hardlink' || item.hardlink?.status !== 'complete')) {
    errors.push(`${path}.hardlink_to is only valid for complete hardlink items`);
  }
  if (item.hardlink != null && !['file', 'hardlink'].includes(item.kind)) {
    errors.push(`${path}.hardlink is only valid for file or hardlink items`);
  }
  if (item.hardlink?.status === 'incomplete') {
    const manualNoncapture = item.state_class === 'manual_review' && item.capture_method === 'manual_action' && item.disposition === 'manual_review';
    if (!manualNoncapture && !nondurableExcluded) {
      errors.push(`${path} incomplete hardlink evidence must remain manual_review or excluded nondurable machine_local state`);
    }
  }

  if (item.capture?.follow === true && item.external_reference == null) {
    errors.push(`${path} followed links require an external_reference`);
  }
  if (item.external_reference != null &&
      (item.kind !== 'symlink' || item.state_class !== 'external_state' || item.capture?.follow !== true)) {
    errors.push(`${path} external_reference requires followed external-state symlink evidence`);
  }
  if (item.capture?.follow === true && item.state_class !== 'external_state') {
    errors.push(`${path} followed links must be classified as external_state`);
  }
  if (item.capture?.follow === true && item.external_reference?.logical_root !== item.capture.external_root) {
    errors.push(`${path} followed-link evidence must use the same external provider root`);
  }

  if (item.collision_types != null && item.state_class !== 'manual_review' && !nondurableExcluded) {
    errors.push(`${path} collision evidence must remain manual_review or excluded nondurable machine_local state`);
  }

  if (item.state_class === 'secret') {
    if (item.sensitivity !== 'secret_metadata') errors.push(`${path} secret items must use secret_metadata sensitivity`);
    if (!['reference_only', 'excluded', 'manual_action'].includes(item.capture_method)) errors.push(`${path} secret items cannot use automatic payload capture`);
    if (!['referenced', 'excluded', 'manual_review'].includes(item.disposition)) errors.push(`${path} secret items cannot have captured disposition`);
    if (!['redeem', 're_enroll', 'skip', 'manual_review'].includes(item.restore_policy)) errors.push(`${path} secret restore policy must redeem, re-enroll, skip, or require manual review`);
    if ((item.capture_method === 'reference_only') !== (item.disposition === 'referenced')) errors.push(`${path} reference_only secret handling must use referenced disposition`);
    if (item.capture_method === 'excluded' && (item.disposition !== 'excluded' || item.restore_policy !== 'skip')) errors.push(`${path} excluded secret handling must be excluded and skipped`);
    if (item.capture_method === 'manual_action' && (item.disposition !== 'manual_review' || item.restore_policy !== 'manual_review')) errors.push(`${path} manual secret handling must remain manual_review`);
  }
  if (item.state_class === 'manual_review') {
    const excludedByPolicy = item.capture_method === 'excluded' && item.disposition === 'excluded' &&
      item.restore_policy === 'skip' && nonEmptyString(item.policy_decision_ref);
    const unresolved = item.capture_method === 'manual_action' && item.disposition === 'manual_review' && item.restore_policy === 'manual_review';
    if (!excludedByPolicy && !unresolved) errors.push(`${path} manual_review items cannot be captured and must remain unresolved or be explicitly excluded by policy`);
  }
  if (['reproducible', 'machine_local', 'cache'].includes(item.state_class)) {
    const expectedRestore = item.state_class === 'cache' ? 'skip' : 'recreate';
    if (item.capture_method !== 'excluded' || item.disposition !== 'excluded' || item.restore_policy !== expectedRestore) {
      errors.push(`${path} ${item.state_class} state must be excluded with ${expectedRestore} restore policy`);
    }
  }
  if (NONDURABLE_SEMANTIC_ROLES.has(item.semantic_role) && !nondurableExcluded) {
    errors.push(`${path} nondurable semantic roles must use non_durable durability and excluded machine_local state with recreate policy`);
  }

  return errors;
}

/**
 * Validate relations that require the complete declared-root and inventory
 * snapshots. Callers retain responsibility for field shape validation.
 *
 * @param {Array<Record<string, any>>} items
 * @param {Map<string, Record<string, any>>} rootsById
 * @param {string} path
 * @returns {string[]}
 */
export function inventoryInvariantErrors(items, rootsById, path = 'inventory') {
  const errors = [];
  const pathLocators = new Set();
  const storeLocators = new Set();

  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!item || typeof item !== 'object') return;
    const root = rootsById.get(item.logical_root);
    if (!root) errors.push(`${itemPath}.logical_root must reference a declared logical root`);
    if (nonEmptyString(item.relative_path)) {
      if (root?.kind === 'logical_store') errors.push(`${itemPath}.relative_path requires a non-logical_store root`);
      if (item.kind === 'logical_record') errors.push(`${itemPath}.relative_path is invalid for logical_record items`);
      const locator = `${item.logical_root}\0${item.relative_path}`;
      if (pathLocators.has(locator)) errors.push(`${itemPath} duplicates another (logical_root, relative_path) locator`);
      pathLocators.add(locator);
    }
    if (nonEmptyString(item.logical_store_id)) {
      if (item.kind !== 'logical_record') errors.push(`${itemPath}.logical_store_id requires kind logical_record`);
      if (root?.kind !== 'logical_store') errors.push(`${itemPath}.logical_store_id requires a declared logical_store root`);
      const locator = `${item.logical_root}\0${item.logical_store_id}`;
      if (storeLocators.has(locator)) errors.push(`${itemPath} duplicates another (logical_root, logical_store_id) locator`);
      storeLocators.add(locator);
    }
    if (item.kind === 'logical_record' && !nonEmptyString(item.logical_store_id)) {
      errors.push(`${itemPath} logical_record items require logical_store_id`);
    }
    if (root?.kind === 'logical_store' && !nonEmptyString(item.logical_store_id)) {
      errors.push(`${itemPath} items under a logical_store root require logical_store_id`);
    }
    if (item.capture?.follow === true && rootsById.get(item.capture.external_root)?.kind !== 'external_provider') {
      errors.push(`${itemPath}.capture.external_root must reference a declared external_provider root`);
    }
    if (item.external_reference != null && rootsById.get(item.external_reference.logical_root)?.kind !== 'external_provider') {
      errors.push(`${itemPath}.external_reference.logical_root must reference a declared external_provider root`);
    }
    if (item.hardlink_to != null && !rootsById.has(item.hardlink_to.logical_root)) {
      errors.push(`${itemPath}.hardlink_to.logical_root must reference a declared root`);
    }
  });

  const byPath = new Map(items.filter((item) => item && typeof item === 'object' && nonEmptyString(item.relative_path))
    .map((item) => [`${item.logical_root}\0${item.relative_path}`, item]));
  items.forEach((item, index) => {
    if (!item?.hardlink_to) return;
    const itemPath = `${path}[${index}]`;
    const target = byPath.get(`${item.hardlink_to.logical_root}\0${item.hardlink_to.relative_path}`);
    if (!target) errors.push(`${itemPath}.hardlink_to must reference an inventoried item`);
    else if (item.logical_root !== target.logical_root || item.state_class !== target.state_class ||
      item.durability !== target.durability || item.semantic_role !== target.semantic_role ||
      item.capture_method !== target.capture_method || item.restore_policy !== target.restore_policy ||
      item.disposition !== target.disposition || ['secret', 'manual_review'].includes(target.state_class) ||
      target.kind !== 'file' || target.hardlink?.status !== 'complete') {
      errors.push(`${itemPath}.hardlink_to must reference a capture-compatible primary item in the same logical root`);
    }
  });
  items.forEach((item, index) => {
    if (item?.kind !== 'file' || item.hardlink?.status !== 'complete' || !nonEmptyString(item.relative_path)) return;
    const hasAlias = items.some((candidate) => candidate?.kind === 'hardlink' && candidate.hardlink?.status === 'complete' &&
      candidate.hardlink_to?.logical_root === item.logical_root && candidate.hardlink_to?.relative_path === item.relative_path);
    if (!hasAlias) errors.push(`${path}[${index}] complete hardlink primary requires an inventoried alias`);
  });
  return errors;
}
