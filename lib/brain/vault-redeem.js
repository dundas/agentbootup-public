/**
 * Thin vault-redeem client (PRD-0038 FR-2, Task 2) — the keystone of the dead-key fix.
 *
 * Resolves an `ingressKeyRef` (`vault://<namespace>/<name>`) to live secret material by
 * redeeming it at the central mech-vault, so credentials are injected at launch from a
 * reference rather than baked or read from `~/.brain`. Repo-self-contained: no cross-repo
 * import, no `~/.brain` access. The redemption transport is injectable so the check can be
 * exercised mock-first (2.1a) without a live vault, then pointed at mech-vault (2.1b).
 *
 * Reference impl: agent-host `redeemSecrets` (`GET {vault}/api/redeem/{token}` → env map).
 *
 * SECURITY: redeemed secret VALUES are never logged and never written to disk by this
 * module. Callers inject them into process env / `/brain/.env` and must not persist them.
 */

/**
 * The vault could not be REACHED to complete a redemption (network error, timeout, or a 5xx
 * server error) — as opposed to the vault answering with a proven-bad result (4xx, invalid
 * ref, or empty material). The doctor's `credentials_authenticate` check maps THIS to
 * `unknown` (→ Degraded, never a false-Stuck on a vault blip); every other failure stays a
 * proven `fail` (the dead-key signal). PRD-0039 FR-3. Fail-closed: only this typed error
 * degrades — an unclassified throw is still treated as a proven failure.
 */
export class VaultUnreachableError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'VaultUnreachableError';
    if (cause !== undefined) this.cause = cause;
  }
}

// Single charset for vault path segments — no '.', '..', or separators, so neither the
// ref parser nor the transport can ever build a traversal-shaped redeem path.
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

// Transient HTTP statuses that mean "retry later", NOT "proven dead key" — a rate-limited or
// momentarily-timed-out vault must degrade to unknown, never false-Stuck (PRD-0039 finding 1).
const TRANSIENT_REDEEM_STATUS = new Set([408, 425, 429]);

/**
 * Parse and validate a vault reference. Stricter than a generic identifier: the only
 * accepted shape is `vault://<namespace>/<name>` where each segment matches
 * `^[A-Za-z0-9_-]{1,128}$` — so `.`, `..`, and path separators can never produce a
 * traversal-shaped redeem path.
 * @param {string} ref
 * @returns {{ namespace: string, name: string }}
 */

// Shared fail-closed assertion so both layers (redeemSecret + the transport) reject the
// same way with one message: secret material must be a non-empty plain object.
function assertUsableSecretMap(value, ctx) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error(`vault redeem for ${ctx} returned no usable secret material`);
  }
}

export function parseVaultRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('vault://')) {
    throw new TypeError(`Invalid ingressKeyRef: expected 'vault://<namespace>/<name>', got ${JSON.stringify(ref)}`);
  }
  const rest = ref.slice('vault://'.length);
  const parts = rest.split('/');
  if (parts.length !== 2) {
    throw new TypeError(`Invalid ingressKeyRef '${ref}': expected exactly <namespace>/<name>`);
  }
  const [namespace, name] = parts;
  if (!SEGMENT.test(namespace) || !SEGMENT.test(name)) {
    throw new TypeError(
      `Invalid ingressKeyRef '${ref}': namespace and name must match ^[A-Za-z0-9_-]{1,128}$ (no '.', '..', or separators)`,
    );
  }
  return { namespace, name };
}

/**
 * Default HTTP redemption transport — the live (2.1b) path, modeled on agent-host's
 * `GET {vault}/api/redeem/...`. `fetch` is injectable for testing. The exact mech-vault
 * route is the one live-wiring point to confirm against mech-vault before relying on it.
 * @param {{ vaultBaseUrl: string, fetch?: typeof globalThis.fetch }} opts
 * @returns {(parsed: {namespace:string,name:string}) => Promise<Record<string,string>>}
 */
export function httpRedeemTransport({ vaultBaseUrl, fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (!vaultBaseUrl) throw new TypeError('httpRedeemTransport requires vaultBaseUrl');
  const base = vaultBaseUrl.replace(/\/$/, '');
  return async ({ namespace, name }) => {
    // Re-validate here: this function is exported and callable independently of
    // parseVaultRef, so it must not trust its inputs (defense-in-depth + encode).
    if (!SEGMENT.test(namespace) || !SEGMENT.test(name)) {
      throw new Error(`vault redeem: invalid segment(s) ${JSON.stringify({ namespace, name })}`);
    }
    const url = `${base}/api/redeem/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
    // Bounded: a hung vault must fail closed within timeoutMs, not block the doctor.
    // A transport-level rejection (connection refused, DNS, TLS, AbortSignal timeout) means
    // the vault could not be REACHED → VaultUnreachableError (→ unknown), not a proven dead key.
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new VaultUnreachableError(`vault redeem unreachable for ${namespace}/${name}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!res || !res.ok) {
      const status = res ? res.status : 'no-response';
      // Unreachable / retryable (→ unknown, never a false-Stuck):
      //  - 5xx / no-response: vault reachable-but-broken or absent.
      //  - 408 / 425 / 429: TRANSIENT — request-timeout, too-early, rate-limited. A throttled
      //    vault under fleet load must not look like a proven dead key (adversarial finding 1).
      // Proven-bad (→ fail): any other 4xx (401/403/404…) — the vault ANSWERED and rejected
      // THIS ref (unauthorized / not-found), which is a real credential/identity problem.
      if (!res || res.status >= 500 || TRANSIENT_REDEEM_STATUS.has(res.status)) {
        throw new VaultUnreachableError(`vault redeem unreachable for ${namespace}/${name}: HTTP ${status}`);
      }
      throw new Error(`vault redeem failed for ${namespace}/${name}: HTTP ${status}`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      // A 200 with a non-JSON body (e.g. an HTML error page behind a proxy) must fail closed.
      throw new Error(`vault redeem for ${namespace}/${name}: response was not valid JSON`);
    }
    // Fail-closed at the transport too (not only in redeemSecret): direct callers must
    // not be able to bypass the non-object / array / empty-map rejections.
    assertUsableSecretMap(body, `${namespace}/${name}`);
    return body;
  };
}

/**
 * Redeem a vault reference to secret material via the given transport.
 * The transport is REQUIRED — there is no implicit default, so a misconfigured caller
 * fails loudly rather than silently skipping redemption (fail-closed).
 * @param {string} ref  vault://<namespace>/<name>
 * @param {{ transport: (parsed:{namespace:string,name:string}) => Promise<Record<string,string>> }} opts
 * @returns {Promise<Record<string,string>>} redeemed env map (secret values — do not log/persist)
 */
export async function redeemSecret(ref, { transport } = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError('redeemSecret requires a transport function (inject a mock or httpRedeemTransport)');
  }
  const parsed = parseVaultRef(ref);
  const secrets = await transport(parsed);
  // Fail-closed: reject non-object, array, AND empty ({}) material — an empty/blank vault
  // response is a redemption failure (nothing redeemed), and without this it could reach
  // the round-trip authenticator and go green (false-green on a never-redeemed credential).
  assertUsableSecretMap(secrets, ref);
  return secrets;
}

/**
 * Build the env object to inject at launch. Returns a frozen shallow copy — this module
 * never writes ~/.brain and never logs values. Callers assign into process.env or write
 * `/brain/.env`; they must not persist the secrets elsewhere.
 *
 * Belongs to the launch-injection path (wired by a later task), NOT the doctor check —
 * the `credentials_authenticate` check only proves the round-trip, it does not inject.
 * @param {Record<string,string>} secretMap
 * @returns {Readonly<Record<string,string>>}
 */
export function buildInjectedEnv(secretMap) {
  if (!secretMap || typeof secretMap !== 'object' || Array.isArray(secretMap)) {
    throw new TypeError('buildInjectedEnv requires a secret map object');
  }
  // Values are written into process env / /brain/.env — a non-string (e.g. a nested
  // object from a misconfigured vault) would stringify to "[object Object]". Fail loud.
  for (const [k, v] of Object.entries(secretMap)) {
    if (typeof v !== 'string') {
      throw new TypeError(`buildInjectedEnv: value for "${k}" is not a string`);
    }
  }
  return Object.freeze({ ...secretMap });
}
