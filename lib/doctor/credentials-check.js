/**
 * FR-2 `credentials_authenticate` check (PRD-0038 Task 2) — the dead-key fix.
 *
 * Proves a credential AUTHENTICATES against its service, not merely that it is present or
 * redeemable. This is the keystone against false-green readiness: a redeemed-but-revoked
 * key must surface as `fail` (→ Stuck via the reducer), never pass.
 *
 * Fail-closed contract:
 *  - the round-trip `authenticate` is NON-SKIPPABLE: if absent, the check FAILS (we cannot
 *    prove the credential, so we must not pass it) — never "skip" to a green result.
 *  - any redeem error, auth=false, or thrown error → `fail`.
 *  - only an explicit successful round-trip → `pass`.
 *
 * Emits a per-check result in the health-record shape (state/severity/category/message).
 */

import { redeemSecret, VaultUnreachableError } from '../brain/vault-redeem.js';

/**
 * @param {object} input
 * @param {string} input.ingressKeyRef            vault://<namespace>/<name>
 * @param {(parsed:{namespace:string,name:string}) => Promise<Record<string,string>>} input.transport
 *        Redemption transport (mock in tests; httpRedeemTransport against mech-vault live).
 * @param {(secrets: Record<string,string>) => Promise<boolean>} input.authenticate
 *        REQUIRED round-trip: authenticates the redeemed secret against the real service.
 * @returns {Promise<{state:'pass'|'fail'|'unknown', severity:string, category:'credentials', message:string}>}
 *   `unknown` only when the vault/auth service is unreachable (VaultUnreachableError) — PRD-0039 FR-3.
 */
export async function checkCredentialsAuthenticate(input = {}) {
  const { ingressKeyRef, transport, authenticate } = input;

  if (typeof authenticate !== 'function') {
    // Non-skippable: with no round-trip we cannot PROVE the credential — fail closed.
    return fail('no round-trip authenticator provided — cannot prove credentials authenticate');
  }
  if (!ingressKeyRef) {
    return fail('no ingressKeyRef configured — credential reference is missing');
  }

  let secrets;
  try {
    secrets = await redeemSecret(ingressKeyRef, { transport });
  } catch (err) {
    // Fail-closed by default: a redemption failure is a proven dead/missing credential (→ Stuck)
    // — EXCEPT a typed VaultUnreachableError, which means the vault could not be reached (network
    // / 5xx / timeout) so we could not determine the credential → unknown (→ Degraded, never a
    // false-Stuck on a vault blip). Invalid ref, empty material, and 4xx all stay `fail`. (FR-3)
    if (err instanceof VaultUnreachableError) {
      return unknown(`credential redemption unreachable: ${errMessage(err)}`);
    }
    return fail(`credential redemption failed: ${errMessage(err)}`);
  }

  let authed;
  try {
    authed = await authenticate(secrets);
  } catch (err) {
    // Same discipline for the auth round-trip: a typed unreachable degrades to unknown; any
    // other throw is fail-closed (we could not prove the credential authenticates).
    if (err instanceof VaultUnreachableError) {
      return unknown(`credential round-trip unreachable: ${errMessage(err)}`);
    }
    return fail(`credential round-trip threw: ${errMessage(err)}`);
  }

  if (authed === true) {
    return { state: 'pass', severity: 'info', category: 'credentials', message: 'credential redeemed and authenticated against the service' };
  }
  return fail('redeemed credential did NOT authenticate against the service (revoked/expired/invalid)');
}

function fail(message) {
  return { state: 'fail', severity: 'error', category: 'credentials', message };
}

// Source-unreachable / could-not-complete → unknown (→ Degraded via the reducer, never Stuck).
// A revoked credential that redeems-then-fails-auth is still a `fail` (the dead-key signal);
// only an inability to REACH the redeem/auth service degrades to unknown.
function unknown(message) {
  return { state: 'unknown', severity: 'warning', category: 'credentials', message };
}

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
