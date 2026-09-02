/**
 * lib/brain/webhook-secret.js
 *
 * Webhook secret management for inbox daemon push notifications.
 *
 * Each brain that receives push notifications from AgentDispatch needs a
 * per-brain HMAC secret to verify that incoming webhook POSTs are genuine.
 * The secret is generated once during brain provisioning and stored in the
 * global agentbootup config.
 *
 * The secret is also registered with the mech-plane agent registry so that
 * AgentDispatch knows the webhook URL and can sign its push payloads.
 *
 * Usage:
 *   import { provisionWebhookSecret, getWebhookSecret } from './webhook-secret.js';
 *
 *   // During brain restore / provisioning:
 *   const secret = await provisionWebhookSecret(brainId, port, { verbose });
 *
 *   // To look up later (e.g. daemon start):
 *   const secret = await getWebhookSecret(brainId); // null if not provisioned
 */

import crypto from 'crypto';
import { readConfig, writeConfig } from '../config/config.js';

// Capture native fetch at module load time so test suites that replace
// globalThis.fetch with a mock do not affect webhook registration or port
// verification calls, which must reach real local/remote servers.
// Bun 1.0+ always provides native fetch; the null fallback guards non-Bun environments.
const _fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;

const REGISTER_TIMEOUT_MS = 10_000;

// Serialize all provisionWebhookSecret calls to prevent read-modify-write races.
// Matches the pattern used by port-registry.js for allocateInboxPort.
// Note: this lock is process-scoped. Cross-process concurrency (two simultaneous
// `agentbootup brain restore` invocations) is not protected — a file-based lock
// would be needed for that case, but concurrent provisioning from separate
// processes is rare enough to accept as a known limitation.
let _secretLock = Promise.resolve();

/**
 * Read the webhook secret map from config.
 * @returns {Promise<Record<string, string>>}
 */
async function readWebhookSecrets() {
  const config = await readConfig();
  const secrets = config.inboxWebhookSecrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return {};
  return secrets;
}

/**
 * Return the HMAC webhook secret for a brain, or null if not provisioned.
 *
 * @param {string} brainId
 * @returns {Promise<string | null>}
 */
export async function getWebhookSecret(brainId) {
  const secrets = await readWebhookSecrets();
  const s = secrets[brainId];
  return typeof s === 'string' && s.length > 0 ? s : null;
}

/**
 * Provision a webhook secret for a brain.
 *
 * If the brain already has a secret, returns the existing value (idempotent).
 * Otherwise generates a new 32-byte hex secret, persists it to config, and
 * optionally registers the webhook URL with the mech-plane agent registry.
 *
 * @param {string} brainId
 * @param {number} port — The inbox daemon port (used to build the webhook URL).
 * @param {{
 *   mechPlaneUrl?: string | null,
 *   apiKey?: string | null,
 *   verbose?: boolean,
 *   dryRun?: boolean,
 * }} opts
 * @returns {Promise<{ secret: string, webhookUrl: string, registered: boolean }>}
 */
export async function provisionWebhookSecret(brainId, port, opts = {}) {
  const { mechPlaneUrl = null, apiKey = null, verbose = false, dryRun = false } = opts;

  // Serialize via module-level lock to prevent read-modify-write races when
  // multiple brains are provisioned concurrently within the same process.
  let resolve;
  const prev = _secretLock;
  _secretLock = new Promise((r) => { resolve = r; });

  let secret;
  let alreadyExisted = false;

  try {
    await prev;

    const secrets = await readWebhookSecrets();

    secret = secrets[brainId];

    if (typeof secret === 'string' && secret.length > 0) {
      alreadyExisted = true;
      if (verbose) console.log(`  [webhook-secret] ${brainId}: existing secret reused`);
    } else {
      // Generate a new 32-byte (256-bit) HMAC secret.
      secret = crypto.randomBytes(32).toString('hex');
      if (!dryRun) {
        await writeConfig({ inboxWebhookSecrets: { ...secrets, [brainId]: secret } });
      }
      if (verbose) console.log(`  [webhook-secret] ${brainId}: generated new HMAC secret`);
    }
  } finally {
    resolve();
  }

  const webhookUrl = `http://127.0.0.1:${port}/webhook`;

  // Register with mech-plane agent registry so AgentDispatch can push messages.
  let registered = false;
  if (mechPlaneUrl && apiKey && !dryRun) {
    registered = await registerWebhookWithMechPlane(brainId, webhookUrl, secret, {
      mechPlaneUrl,
      apiKey,
      verbose,
    });
  } else if (mechPlaneUrl && dryRun && verbose) {
    // Check dryRun before !apiKey: when both conditions hold, dryRun is the
    // intended diagnostic — "apiKey missing" would be a misleading message here.
    console.log(`  [dry-run] would register webhook URL ${webhookUrl} with mech-plane for ${brainId}`);
  } else if (mechPlaneUrl && !apiKey && verbose) {
    console.warn(`  [webhook-secret] ${brainId}: mechPlaneUrl provided but apiKey missing — webhook registration skipped`);
  } else if (!mechPlaneUrl && verbose && !alreadyExisted) {
    console.log(`  [webhook-secret] ${brainId}: mech-plane URL not available — webhook registration skipped`);
    console.log(`  [webhook-secret]   Re-run after mech-plane is configured to register: ${webhookUrl}`);
  }

  return { secret, webhookUrl, registered };
}

/**
 * Update portRegistry with the actual port a brain's inbox daemon bound to, then
 * re-register the new webhook URL with mech-plane (if credentials are available).
 *
 * Use this when drift is ALREADY CONFIRMED (e.g. from a state file read or reconcile
 * diff). Does NOT probe any port — it writes the given actualPort directly.
 *
 * portRegistryUpdated invariant: mech-plane is only patched if the local config write
 * succeeds. If writeConfig throws, the function logs a warning and returns registered:false
 * to prevent the two sources of truth from diverging.
 *
 * @param {string} brainId
 * @param {number} actualPort — The port the daemon actually bound to.
 * @param {{
 *   mechPlaneUrl?: string | null,
 *   apiKey?: string | null,
 *   verbose?: boolean,
 * }} opts
 * @returns {Promise<{ portRegistryUpdated: boolean, registered: boolean }>}
 */
export async function updatePortAndReRegister(brainId, actualPort, opts = {}) {
  const { mechPlaneUrl = null, apiKey = null, verbose = false } = opts;

  // Serialize portRegistry reads/writes via the same module-level lock used by
  // provisionWebhookSecret. Without serialization, concurrent calls (e.g. reconcile
  // running over many brains) would read the same stale config and the second write
  // would silently drop the first brain's port update.
  //
  // Lock scope: covers only the portRegistry read/write (inside the try block).
  // The mech-plane PATCH below runs after the lock is released — PATCH is idempotent,
  // so concurrent PATCH calls from two reconcile runs are safe even if interleaved.
  let resolve;
  const prev = _secretLock;
  _secretLock = new Promise((r) => { resolve = r; });

  let portRegistryUpdated = false;
  try {
    await prev;

    const config = await readConfig();
    const portReg = (config.portRegistry && typeof config.portRegistry === 'object')
      ? config.portRegistry : {};
    const inboxPorts = (portReg.inbox && typeof portReg.inbox === 'object')
      ? portReg.inbox : {};
    await writeConfig({ portRegistry: { ...portReg, inbox: { ...inboxPorts, [brainId]: actualPort } } });
    portRegistryUpdated = true;
    if (verbose) console.log(`  [webhook-secret] ${brainId}: portRegistry updated to :${actualPort}`);
  } catch (err) {
    console.warn(`  [webhook-secret] ${brainId}: failed to update portRegistry: ${err.message}`);
  } finally {
    resolve();
  }

  let registered = false;
  if (portRegistryUpdated && mechPlaneUrl && apiKey) {
    try {
      const secret = await getWebhookSecret(brainId);
      if (secret) {
        const newUrl = `http://127.0.0.1:${actualPort}/webhook`;
        registered = await registerWebhookWithMechPlane(brainId, newUrl, secret, {
          mechPlaneUrl, apiKey, verbose,
        });
      } else {
        // Always log — error paths are not verbose-gated (consistent with registerWebhookWithMechPlane).
        console.warn(`  [webhook-secret] ${brainId}: webhook secret not found — mech-plane re-registration skipped`);
      }
    } catch (err) {
      console.warn(`  [webhook-secret] ${brainId}: failed to re-register webhook: ${err.message}`);
    }
  }

  return { portRegistryUpdated, registered };
}

/**
 * Register a brain's webhook URL with the mech-plane agent registry.
 * Idempotent — safe to call on every provision (PATCH semantics).
 *
 * @param {string} brainId
 * @param {string} webhookUrl
 * @param {string} secret
 * @param {{ mechPlaneUrl: string, apiKey: string, verbose: boolean }} opts
 * @returns {Promise<boolean>} true on success, false on failure (non-fatal).
 */
export async function registerWebhookWithMechPlane(brainId, webhookUrl, secret, opts) {
  const { mechPlaneUrl, apiKey, verbose } = opts;

  try {
    const resp = await _fetch(`${mechPlaneUrl}/v1/brains/${encodeURIComponent(brainId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ webhookUrl, webhookSecret: secret }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    if (resp.ok) {
      if (verbose) console.log(`  [webhook-secret] registered webhook URL with mech-plane for ${brainId}`);
      return true;
    }
    // Always log errors (not verbose-gated) so auth failures and server errors
    // surface in production logs without needing --verbose.
    if (resp.status === 401 || resp.status === 403) {
      console.warn(`  [webhook-secret] mech-plane auth failure (${resp.status}) for ${brainId} — check API key`);
    } else if (resp.status === 404) {
      console.warn(`  [webhook-secret] ${brainId} not found in mech-plane registry — skipping webhook registration`);
    } else {
      const msg = await resp.text().catch(() => `HTTP ${resp.status}`);
      console.warn(`  [webhook-secret] mech-plane webhook registration failed (${resp.status}): ${msg}`);
    }
    return false;
  } catch (err) {
    console.warn(`  [webhook-secret] mech-plane connection error: ${err.message}`);
    return false;
  }
}

/**
 * Probe the inbox daemon at expectedPort and re-register with mech-plane if it
 * self-reports a different port.
 *
 * IMPORTANT: This function can only detect drift when a process IS responding at
 * expectedPort AND its /health body.port disagrees with expectedPort — an unusual
 * edge case. If the daemon drifted to a different port entirely (nothing on
 * expectedPort), the probe fails and the function returns { drifted: false,
 * verified: false } — a silent false-negative. For reliable post-start drift
 * detection, read the daemon state file instead (see readInboxDaemonState in
 * unified-daemon-cli.js, which the handleStart path uses).
 *
 * This function is appropriate for external callers that only know the registered
 * port and want to confirm the daemon is healthy there.
 *
 * Never throws — always returns a result object.
 *
 * @param {string} brainId
 * @param {number} expectedPort
 * @param {{
 *   mechPlaneUrl?: string | null,
 *   apiKey?: string | null,
 *   verbose?: boolean,
 * }} opts
 * @returns {Promise<{ drifted: boolean, verified: boolean, actualPort?: number, registered?: boolean }>}
 */
export async function verifyInboxPortAndReRegister(brainId, expectedPort, opts = {}) {
  const { mechPlaneUrl = null, apiKey = null, verbose = false } = opts;

  // Hit /health on the expected port with a short timeout.
  if (!_fetch) return { drifted: false, verified: false };
  let actualPort;
  try {
    const resp = await _fetch(`http://127.0.0.1:${expectedPort}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return { drifted: false, verified: false };
    const body = await resp.json();
    actualPort = body.port;
    if (typeof actualPort !== 'number') return { drifted: false, verified: false };
  } catch {
    return { drifted: false, verified: false };
  }

  if (actualPort === expectedPort) {
    return { drifted: false, verified: true };
  }

  // Port drifted — delegate to shared helper that enforces portRegistryUpdated invariant.
  if (verbose) {
    console.log(
      `  [webhook-secret] ${brainId}: port drifted from ${expectedPort} to ${actualPort} — updating registry`,
    );
  }
  const { registered } = await updatePortAndReRegister(brainId, actualPort, {
    mechPlaneUrl, apiKey, verbose,
  });

  return { drifted: true, verified: true, actualPort, registered };
}
