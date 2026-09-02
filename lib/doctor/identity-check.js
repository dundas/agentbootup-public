/**
 * FR-4 `identity_materializes` check (PRD-0038 Task 4).
 *
 * Attests an agent's identity against the REGISTRY of record — keys valid AND the registry
 * agrees — not merely "a config file is present." Owned by agentbootup (the registry owner).
 *
 * unknown-vs-fail discipline (PRD-0038 §5):
 *  - registry UNREACHABLE → `unknown` (we cannot attest; infra blip, not proven-bad → the
 *    reducer maps this to Degraded, never a false-Stuck nor a false-green).
 *  - registry reachable but agent NOT registered, id mismatch, or key fingerprint mismatch
 *    → `fail` (identity does not materialize → Stuck).
 *  - registry agrees and the key fingerprint matches → `pass`.
 *
 * `fetchRegistry` is injectable so this is exercised mock-first without a live registry.
 */

// Severity tracks the state: pass→info, unknown→warning (infra blip, not proven-bad —
// the reducer maps it to Degraded), fail→error. Keeps severity consistent for any
// consumer (logging/alerting) that reads it independently of the reducer.
const SEVERITY_FOR_STATE = { pass: 'info', unknown: 'warning', fail: 'error' };
function result(state, message, severity = SEVERITY_FOR_STATE[state] ?? 'error') {
  return { state, severity, category: 'identity', message };
}
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// Trim surrounding whitespace (a common artifact, e.g. a trailing newline from a file)
// before comparing fingerprints — a legitimate agent must not flip to Stuck over a stray
// newline. Case is preserved (significant for base64-encoded fingerprints).
function normalizeFingerprint(fp) {
  return typeof fp === 'string' ? fp.trim() : '';
}

/**
 * @param {object} input
 * @param {string} input.agentId
 * @param {{ id?: string, key_fingerprint?: string }} input.localIdentity  The agent's claimed
 *   identity. `id` is an optional secondary consistency check (enforced only when present);
 *   key-fingerprint agreement with the registry is the load-bearing attestation.
 * @param {(agentId: string) => Promise<{ id?: string, key_fingerprint?: string } | null>} input.fetchRegistry
 *        Returns the registry record (or null if not registered); throws if the registry is unreachable.
 * @returns {Promise<{state:'pass'|'fail'|'unknown', severity, category:'identity', message:string}>}
 */
export async function checkIdentityMaterializes(input = {}) {
  const { agentId, localIdentity, fetchRegistry } = input;
  if (!agentId) return result('fail', 'no agentId provided — cannot attest identity');
  if (!localIdentity || typeof localIdentity !== 'object' || Array.isArray(localIdentity)) {
    return result('fail', 'no local identity provided — cannot attest against the registry');
  }
  // The claimed local identity must be self-consistent: if it carries an id, it must be
  // the agent we are attesting (a disagreement here is a misconfigured/spoofed claim).
  if (localIdentity.id !== undefined && localIdentity.id !== agentId) {
    return result('fail', `local identity id '${localIdentity.id}' does not match agent '${agentId}'`);
  }
  if (typeof fetchRegistry !== 'function') {
    // No way to reach the registry of record → cannot attest. Unknown, not a false pass.
    return result('unknown', 'no registry accessor provided — cannot attest identity');
  }

  let record;
  try {
    record = await fetchRegistry(agentId);
  } catch (err) {
    // Registry unreachable is an infra condition, not proven-bad identity → unknown.
    return result('unknown', `registry unreachable — cannot attest identity: ${errMessage(err)}`);
  }

  if (record == null) {
    return result('fail', `agent '${agentId}' is not registered — identity does not materialize`);
  }
  if (typeof record !== 'object' || Array.isArray(record)) {
    return result('fail', `malformed registry record for '${agentId}' — cannot attest identity`);
  }
  if (record.id !== undefined && record.id !== agentId) {
    return result('fail', `registry record id '${record.id}' does not match agent '${agentId}'`);
  }
  const localFp = normalizeFingerprint(localIdentity.key_fingerprint);
  if (!localFp) {
    return result('fail', `local identity has no key_fingerprint — cannot prove key validity`);
  }
  const registryFp = normalizeFingerprint(record.key_fingerprint);
  if (!registryFp) {
    return result('fail', `registry has no key_fingerprint for '${agentId}' — cannot attest key validity`);
  }
  if (registryFp !== localFp) {
    return result('fail', `key fingerprint mismatch — registry does not agree the key is valid for '${agentId}'`);
  }
  return result('pass', `identity attested against the registry (key fingerprint agrees) for '${agentId}'`);
}
