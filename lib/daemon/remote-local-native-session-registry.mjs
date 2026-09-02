/**
 * Local-only native-session registry for PRD-0072 Task 3.2.
 *
 * The caller supplies a protected observer for sessions that already exist.
 * This module has no runtime launcher and deliberately never returns a native
 * session identifier. The connector will use the private handle lookup in a
 * later task to address the fixed local Mech Plane adapter.
 */
import { randomBytes } from 'node:crypto';

export const REMOTE_LOCAL_MAX_SESSIONS = 32;
const RUNTIME_CLASSES = new Set(['codex_cli', 'claude_code', 'gemini_cli', 'openclaw']);
const AVAILABILITY = new Set(['online', 'offline', 'draining']);
const ACTIVITY = new Set(['active', 'idle', 'unknown']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDLE = /^rsh_[A-Za-z0-9_-]{16,128}$/;
const NATIVE_ID_MAX_BYTES = 1024;

function equalFence(left, right) {
  return left?.brainId === right?.brainId
    && left?.deviceId === right?.deviceId
    && left?.authorityRevision === right?.authorityRevision;
}

function validFence(fence) {
  return !!fence && typeof fence === 'object' && !Array.isArray(fence)
    && IDENTIFIER.test(fence.brainId) && IDENTIFIER.test(fence.deviceId)
    && IDENTIFIER.test(fence.authorityRevision);
}

function validObservation(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'activity,availability,nativeSessionId,runtimeClass'
    && typeof value.nativeSessionId === 'string' && value.nativeSessionId.length > 0
    && Buffer.byteLength(value.nativeSessionId, 'utf8') <= NATIVE_ID_MAX_BYTES
    && RUNTIME_CLASSES.has(value.runtimeClass) && AVAILABILITY.has(value.availability)
    && ACTIVITY.has(value.activity);
}

/**
 * @param {{ listExistingSessions?: () => Promise<Array<{nativeSessionId: string, runtimeClass: string, availability: string, activity: string}>>, randomBytesImpl?: typeof randomBytes }} options
 */
export function createRemoteLocalNativeSessionRegistry({ listExistingSessions = async () => [], randomBytesImpl = randomBytes } = {}) {
  if (typeof listExistingSessions !== 'function') throw new Error('native session observer must be a function');
  if (typeof randomBytesImpl !== 'function') throw new Error('native session registry requires secure random bytes');

  let fence = null;
  let generation = 0;
  let availableAliasNumbers = Array.from({ length: REMOTE_LOCAL_MAX_SESSIONS }, (_, index) => index + 1);
  let inventoryTail = Promise.resolve();
  const byNativeId = new Map();
  const byHandle = new Map();
  // Handles are server-issued, but retain every value accepted locally so a
  // reconnect/fence transition can never bind an old handle to a new session.
  const consumedHandles = new Set();

  const clearLiveMappings = () => {
    generation += 1;
    byNativeId.clear();
    byHandle.clear();
    availableAliasNumbers = Array.from({ length: REMOTE_LOCAL_MAX_SESSIONS }, (_, index) => index + 1);
  };

  const releaseAlias = (entry) => {
    const aliasNumber = Number(entry.alias.slice('session-'.length));
    availableAliasNumbers.push(aliasNumber);
    availableAliasNumbers.sort((left, right) => left - right);
  };

  const newConnectorReference = () => {
    for (let attempts = 0; attempts < 8; attempts += 1) {
      const reference = `sar_${randomBytesImpl(24).toString('base64url')}`;
      if (![...byNativeId.values()].some((entry) => entry.connectorReference === reference)) return reference;
    }
    throw new Error('native session registry could not create a unique connector reference');
  };

  const assertFence = (currentFence) => {
    if (!validFence(currentFence)) throw new Error('native session registry requires a complete fence');
    if (fence && !equalFence(fence, currentFence)) clearLiveMappings();
    fence = Object.freeze({ brainId: currentFence.brainId, deviceId: currentFence.deviceId, authorityRevision: currentFence.authorityRevision });
  };

  return Object.freeze({
    /** Observe only existing sessions. No runtime is created when this is empty. */
    async inventory(currentFence) {
      // Observer calls may involve local IPC. Queue refreshes so an older call
      // cannot apply after a newer inventory/fence transition.
      let release;
      const prior = inventoryTail;
      inventoryTail = new Promise((resolve) => { release = resolve; });
      await prior;
      try {
      assertFence(currentFence);
      const observedFence = fence;
      const observedGeneration = generation;
      const observed = await listExistingSessions();
      if (generation !== observedGeneration || !equalFence(fence, observedFence)) {
        throw new Error('native session inventory became stale during observation');
      }
      if (!Array.isArray(observed) || observed.length > REMOTE_LOCAL_MAX_SESSIONS || !observed.every(validObservation)) {
        throw new Error('native session observer returned invalid inventory');
      }
      const nativeIds = new Set(observed.map((session) => session.nativeSessionId));
      if (nativeIds.size !== observed.length) throw new Error('native session observer returned duplicate native session IDs');

      for (const nativeSessionId of byNativeId.keys()) {
        if (!nativeIds.has(nativeSessionId)) {
          const entry = byNativeId.get(nativeSessionId);
          byNativeId.delete(nativeSessionId);
          if (entry.handle) byHandle.delete(entry.handle);
          releaseAlias(entry);
        }
      }
      for (const session of observed) {
        const prior = byNativeId.get(session.nativeSessionId);
        const aliasNumber = prior ? null : availableAliasNumbers.shift();
        if (!prior && aliasNumber === undefined) throw new Error('native session registry exhausted safe aliases');
        const entry = prior ?? { connectorReference: newConnectorReference(), alias: `session-${aliasNumber}`, handle: null };
        entry.runtimeClass = session.runtimeClass;
        entry.availability = session.availability;
        entry.activity = session.activity;
        byNativeId.set(session.nativeSessionId, entry);
      }
      return observed.map((session) => {
        const entry = byNativeId.get(session.nativeSessionId);
        return Object.freeze({ connectorReference: entry.connectorReference, alias: entry.alias, runtimeClass: entry.runtimeClass, availability: entry.availability, activity: entry.activity });
      });
      } finally { release(); }
    },

    /** Bind fresh server handles to currently advertised connector references. */
    bind(currentFence, bindings) {
      assertFence(currentFence);
      if (!Array.isArray(bindings) || bindings.length > REMOTE_LOCAL_MAX_SESSIONS) throw new Error('invalid native session bindings');
      const references = new Set();
      const handles = new Set();
      for (const binding of bindings) {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)
          || Object.keys(binding).sort().join(',') !== 'connectorReference,handle'
          || typeof binding.connectorReference !== 'string' || !HANDLE.test(binding.handle)
          || references.has(binding.connectorReference) || handles.has(binding.handle) || consumedHandles.has(binding.handle)) {
          throw new Error('invalid or reused native session binding');
        }
        references.add(binding.connectorReference); handles.add(binding.handle);
      }
      const byReference = new Map([...byNativeId.entries()].map(([nativeSessionId, entry]) => [entry.connectorReference, [nativeSessionId, entry]]));
      if (![...references].every((reference) => byReference.has(reference))) throw new Error('native session binding references an unadvertised session');
      for (const binding of bindings) {
        const [nativeSessionId, entry] = byReference.get(binding.connectorReference);
        if (entry.handle) throw new Error('native session already has a handle');
        entry.handle = binding.handle;
        byHandle.set(binding.handle, { nativeSessionId, fence });
        consumedHandles.add(binding.handle);
      }
    },

    /** Private lookup for the future local adapter; native identity is never serialized. */
    nativeSessionIdForHandle(currentFence, handle) {
      assertFence(currentFence);
      const entry = byHandle.get(handle);
      return entry && equalFence(entry.fence, fence) ? entry.nativeSessionId : null;
    },

    /** Invalidate server handles before re-advertising the observed sessions. */
    refreshBindings(currentFence) {
      assertFence(currentFence);
      generation += 1;
      byHandle.clear();
      for (const entry of byNativeId.values()) entry.handle = null;
    },

    endNativeSession(nativeSessionId) {
      // An end notification can win a race with the first observation, before
      // this registry has seen the native ID. Invalidate either way.
      generation += 1;
      const entry = byNativeId.get(nativeSessionId);
      if (!entry) return false;
      byNativeId.delete(nativeSessionId);
      if (entry.handle) byHandle.delete(entry.handle);
      releaseAlias(entry);
      return true;
    },

    reconnect() { clearLiveMappings(); },
    fenceChanged(currentFence) { assertFence(currentFence); },
    size() { return byNativeId.size; },
  });
}
