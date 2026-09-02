/**
 * Shared memory-convergence safety contract.
 *
 * Raw memory publication is allowed only when convergence is explicitly off
 * (the rollback path), or when this process has completed and retained an open
 * pull-before-push gate. Health is safe only with complete converge evidence;
 * missing or partial evidence never inherits process liveness.
 */

const SAFE_CONVERGE_STATES = new Set(['ok', 'never_synced']);
const SAFE_FRESHNESS_STATES = new Set(['ok', 'idle', 'never_synced']);

function parseBooleanOverride(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  return null;
}

export function resolveConvergeSetting(config = {}, env = process.env) {
  if (parseBooleanOverride(env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED) === true) {
    return { enabled: false, source: 'env:AGENTBOOTUP_MEMORY_CONVERGE_DISABLED' };
  }
  const legacyOverride = parseBooleanOverride(env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED);
  if (legacyOverride !== null) {
    return { enabled: legacyOverride, source: 'env:AGENTBOOTUP_MEMORY_CONVERGE_ENABLED' };
  }
  if (typeof config?.memoryConvergeEnabled === 'boolean') {
    return { enabled: config.memoryConvergeEnabled, source: 'persisted' };
  }
  return { enabled: true, source: 'default' };
}

export function isRawMemoryPublicationAllowed(setting, gateOpen) {
  if (setting?.enabled === false) return true;
  return setting?.enabled === true && gateOpen === true;
}

export function hasCompleteConvergeHealth(converge) {
  const commonFieldsComplete = Boolean(
    converge &&
    typeof converge.state === 'string' &&
    typeof converge.enabled === 'boolean' &&
    typeof converge.configSource === 'string' &&
    typeof converge.store === 'string' &&
    typeof converge.gateOpen === 'boolean'
  );
  if (
    commonFieldsComplete &&
    converge.state === 'disabled' &&
    converge.enabled === false &&
    converge.gateOpen === true
  ) return true;
  return Boolean(
    commonFieldsComplete &&
    typeof converge.lastCycleAt === 'string' &&
    Number.isFinite(Date.parse(converge.lastCycleAt)) &&
    typeof converge.freshnessState === 'string' &&
    SAFE_FRESHNESS_STATES.has(converge.freshnessState) &&
    typeof converge.freshnessCheckedAt === 'string' &&
    Number.isFinite(Date.parse(converge.freshnessCheckedAt))
  );
}

export function isConvergeHealthSafe(converge) {
  return Boolean(
    hasCompleteConvergeHealth(converge) &&
    converge.enabled === true &&
    converge.gateOpen === true &&
    SAFE_CONVERGE_STATES.has(converge.state)
  );
}
