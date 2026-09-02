const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUNTIME_KEYS = ['approvalExpiresInMs', 'authorityScope', 'daemon', 'planeAuthority'];
const ENROLLMENT_RUNTIME_KEYS = ['approvalExpiresInMs', 'daemon', 'planeAuthority'];
const SCOPE_KEYS = ['tenantId', 'consumerId'];
const PLANE_AUTHORITY_KEYS = ['mountId', 'functionalityId', 'resourceId', 'principalId', 'mountEpoch', 'assurance'];

function exact(value, keys) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function validStrings(value, keys) { return exact(value, keys) && keys.every((key) => typeof value[key] === 'string' && ID.test(value[key])); }

/** The local-only, sealed runtime profile accepted by the daemon. */
export function isValidRemoteLocalRuntime(value) {
  return exact(value, RUNTIME_KEYS) && validStrings(value.authorityScope, SCOPE_KEYS)
    && Number.isSafeInteger(value.approvalExpiresInMs) && value.approvalExpiresInMs >= 1_000 && value.approvalExpiresInMs <= 600_000
    && exact(value.daemon, ['credential', 'bindAddress', 'runtime'])
    && typeof value.daemon.credential === 'string' && ID.test(value.daemon.credential)
    && value.daemon.bindAddress === '127.0.0.1'
    && exact(value.daemon.runtime, ['runtimeIdentity', 'provider', 'workspace', 'capabilityPolicyId', 'sessionDiscoveryMaxAgeMs', 'sessionClockSkewToleranceMs'])
    && ID.test(value.daemon.runtime.runtimeIdentity) && value.daemon.runtime.provider === 'codex'
    && typeof value.daemon.runtime.workspace === 'string' && value.daemon.runtime.workspace.startsWith('/')
    && ID.test(value.daemon.runtime.capabilityPolicyId)
    && Number.isSafeInteger(value.daemon.runtime.sessionDiscoveryMaxAgeMs)
    && value.daemon.runtime.sessionDiscoveryMaxAgeMs >= 1_000 && value.daemon.runtime.sessionDiscoveryMaxAgeMs <= 86_400_000
    && Number.isSafeInteger(value.daemon.runtime.sessionClockSkewToleranceMs)
    && value.daemon.runtime.sessionClockSkewToleranceMs >= 0 && value.daemon.runtime.sessionClockSkewToleranceMs <= 60_000
    && validStrings(value.planeAuthority, PLANE_AUTHORITY_KEYS);
}

/**
 * The operator-owned portion of a profile. The identity scope is deliberately
 * absent: it is derived by the authenticated enrollment authority and sealed
 * into the resulting daemon state.
 */
export function isValidRemoteLocalEnrollmentRuntime(value) {
  return exact(value, ENROLLMENT_RUNTIME_KEYS)
    && Number.isSafeInteger(value.approvalExpiresInMs) && value.approvalExpiresInMs >= 1_000 && value.approvalExpiresInMs <= 600_000
    && exact(value.daemon, ['credential', 'bindAddress', 'runtime'])
    && typeof value.daemon.credential === 'string' && ID.test(value.daemon.credential)
    && value.daemon.bindAddress === '127.0.0.1'
    && exact(value.daemon.runtime, ['runtimeIdentity', 'provider', 'workspace', 'capabilityPolicyId', 'sessionDiscoveryMaxAgeMs', 'sessionClockSkewToleranceMs'])
    && ID.test(value.daemon.runtime.runtimeIdentity) && value.daemon.runtime.provider === 'codex'
    && typeof value.daemon.runtime.workspace === 'string' && value.daemon.runtime.workspace.startsWith('/')
    && ID.test(value.daemon.runtime.capabilityPolicyId)
    && Number.isSafeInteger(value.daemon.runtime.sessionDiscoveryMaxAgeMs)
    && value.daemon.runtime.sessionDiscoveryMaxAgeMs >= 1_000 && value.daemon.runtime.sessionDiscoveryMaxAgeMs <= 86_400_000
    && Number.isSafeInteger(value.daemon.runtime.sessionClockSkewToleranceMs)
    && value.daemon.runtime.sessionClockSkewToleranceMs >= 0 && value.daemon.runtime.sessionClockSkewToleranceMs <= 60_000
    && validStrings(value.planeAuthority, PLANE_AUTHORITY_KEYS);
}
