import { buildDenylist } from '../daemon/redaction-denylist.js';
import { redactContent } from '../runtime-adapters/redaction.js';

export const ANALYSIS_POLICY_STATE = Object.freeze({
  usable: 'usable',
  unavailable: 'policy_unavailable',
  inputUnprovable: 'input_unprovable',
});

const policySnapshots = new WeakMap();

function isUsableSnapshot(snapshot) {
  return snapshot
    && ['loaded', 'empty-by-config'].includes(snapshot.state)
    && snapshot.health?.redaction_denylist_stale !== true
    && snapshot.health?.redaction_denylist_overflow !== true
    && snapshot.health?.redaction_denylist_file_too_large !== true;
}

/**
 * Build an opaque analysis policy using the transcript-sync redaction substrate.
 * The returned handle deliberately does not expose denylist values or source maps.
 */
export function createAnalysisPrivacyPolicy(projectRoots = [], options = {}) {
  let snapshot;
  try {
    snapshot = options.snapshot ?? buildDenylist(projectRoots, options);
  } catch {
    return Object.freeze({ state: ANALYSIS_POLICY_STATE.unavailable, code: 'analysis_policy_unavailable' });
  }
  if (!isUsableSnapshot(snapshot)) {
    return Object.freeze({ state: ANALYSIS_POLICY_STATE.unavailable, code: 'analysis_policy_unavailable' });
  }
  const handle = Object.freeze({ state: ANALYSIS_POLICY_STATE.usable });
  policySnapshots.set(handle, snapshot);
  return handle;
}

/**
 * Sanitize plain-text analysis input with the same deterministic policy used by
 * transcript sync. Callers receive only redacted content or a stable failure.
 */
export function sanitizeAnalysisText(content, policy) {
  const snapshot = policySnapshots.get(policy);
  if (!snapshot || policy?.state !== ANALYSIS_POLICY_STATE.usable) {
    return Object.freeze({ state: ANALYSIS_POLICY_STATE.unavailable, code: 'analysis_policy_unavailable' });
  }
  let result;
  try {
    result = redactContent(content, {
      format: 'text',
      denylist: snapshot.values,
      sourceMap: snapshot.sourceMap,
      derivedDenylist: snapshot.derivedValues,
      derivedSourceMap: snapshot.derivedSourceMap,
    });
  } catch {
    return Object.freeze({ state: ANALYSIS_POLICY_STATE.inputUnprovable, code: 'analysis_input_unprovable' });
  }
  if (result.blocked || typeof result.cleanContent !== 'string') {
    return Object.freeze({
      state: ANALYSIS_POLICY_STATE.inputUnprovable,
      code: 'analysis_input_unprovable',
      replacements: Number(result?.replacements) || 0,
      heuristicHits: Number(result?.heuristicHits) || 0,
    });
  }
  return Object.freeze({
    state: ANALYSIS_POLICY_STATE.usable,
    cleanContent: result.cleanContent,
    replacements: Number(result.replacements) || 0,
    heuristicHits: Number(result.heuristicHits) || 0,
  });
}
