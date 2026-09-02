/**
 * lib/brain/port-registry.js
 *
 * Generic port allocation registry for agentbootup daemons.
 *
 * Each daemon type that needs a stable, unique port per brain registers its
 * own range via createDaemonPortRegistry(). Allocations are persisted to the
 * global config so the same brain always gets the same port across restarts.
 *
 * Built-in port ranges:
 *   8766          — transcript-sync daemon (reserved, do not touch)
 *   8767–8867     — inbox daemon pool (100 slots, one per brain)
 *   8868–8967     — available for custom project daemons
 *
 * Usage (built-in daemon):
 *   import { allocateInboxPort, getInboxPort } from './port-registry.js';
 *   const port = await allocateInboxPort(brainId);
 *
 * Usage (custom project daemon):
 *   import { createDaemonPortRegistry } from './port-registry.js';
 *   const registry = createDaemonPortRegistry('my-daemon', 8868, 8967);
 *   const port = await registry.allocate(brainId);
 *
 * Config storage:
 *   portRegistry.<daemonKey>.<id> → port number
 *   (Migrated lazily from legacy inboxPorts on first inbox write.)
 */

import net from 'net';
import { readConfig, writeConfig } from '../config/config.js';

// ── Shared allocation lock ────────────────────────────────────────────────────
//
// Serialize ALL allocations across ALL daemon types within a single process to
// prevent TOCTOU races when two concurrent callers scan overlapping port ranges
// at the same time and claim the same port.
//
// ⚠️ Cross-process limitation: this lock is process-scoped only. Two separate
// `agentbootup` processes running simultaneously can still race — both read the
// same config snapshot and claim the same port. A file-based advisory lock
// (O_EXCL sentinel or lockfile) would close this gap. Given that concurrent
// multi-process provisioning is rare in practice, this is accepted as a known
// limitation. Callers can retry on EADDRINUSE at daemon start time.
let _allocationLock = Promise.resolve();

/**
 * Check whether a port is available by attempting to bind it briefly.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

// ── Synchronous config-extraction helpers ─────────────────────────────────────
//
// Accept a pre-read config object so callers can do a single readConfig() per
// lock window rather than triggering multiple reads for the same operation.

/**
 * Extract and return the port map for a single daemon key from a pre-read config.
 * Returns a mutable copy of id → port (numbers).
 * Values are coerced via Number() to guard against string-valued entries from
 * hand-edited or older-serialised config files.
 *
 * @param {string} daemonKey
 * @param {Record<string, unknown>} config
 * @returns {Record<string, number>}
 */
function extractDaemonPorts(daemonKey, config) {
  const registry = config.portRegistry;

  // New-style storage: portRegistry.<daemonKey>
  if (registry && typeof registry === 'object' && !Array.isArray(registry)) {
    const map = registry[daemonKey];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const result = {};
      for (const [id, raw] of Object.entries(map)) {
        const port = Number(raw);
        if (!isNaN(port)) result[id] = port;
      }
      return result;
    }
  }

  // Legacy migration: inboxPorts → portRegistry.inbox
  if (daemonKey === 'inbox' && config.inboxPorts &&
      typeof config.inboxPorts === 'object' && !Array.isArray(config.inboxPorts)) {
    const result = {};
    for (const [id, raw] of Object.entries(config.inboxPorts)) {
      const port = Number(raw);
      if (!isNaN(port)) result[id] = port;
    }
    return result;
  }

  return {};
}

/**
 * Collect all ports currently allocated by every daemon key EXCEPT the given one.
 * Coerces values to numbers uniformly (covers both new-style and legacy storage).
 * Used to prevent cross-registry port conflicts when ranges overlap.
 *
 * @param {string} excludeKey
 * @param {Record<string, unknown>} config
 * @returns {Set<number>}
 */
function extractOtherClaimedPorts(excludeKey, config) {
  const claimed = new Set();
  const registry = config.portRegistry;

  if (registry && typeof registry === 'object' && !Array.isArray(registry)) {
    for (const [key, map] of Object.entries(registry)) {
      if (key === excludeKey) continue;
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        for (const raw of Object.values(map)) {
          const port = Number(raw);
          if (!isNaN(port)) claimed.add(port);
        }
      }
    }
  }

  // Include legacy inboxPorts when excludeKey is not inbox, so a new daemon
  // type doesn't grab a port the inbox daemon already owns.
  // Coerce to number: older config files may have stored port values as strings.
  if (excludeKey !== 'inbox' && config.inboxPorts &&
      typeof config.inboxPorts === 'object' && !Array.isArray(config.inboxPorts)) {
    for (const raw of Object.values(config.inboxPorts)) {
      const port = Number(raw);
      if (!isNaN(port)) claimed.add(port);
    }
  }

  return claimed;
}

// ── Config write helper ───────────────────────────────────────────────────────

/**
 * Persist the port map for a single daemon key.
 * Merges into the existing portRegistry object so other daemon keys are
 * preserved, and removes the legacy inboxPorts key when migrating inbox.
 *
 * @param {string} daemonKey
 * @param {Record<string, number>} ports
 * @returns {Promise<void>}
 */
async function writeDaemonPorts(daemonKey, ports) {
  const config = await readConfig();
  const existing = (config.portRegistry && typeof config.portRegistry === 'object')
    ? config.portRegistry
    : {};

  /** @type {Record<string, unknown>} */
  const updates = { portRegistry: { ...existing, [daemonKey]: ports } };

  // Explicitly remove the legacy top-level key when we first write under the
  // new portRegistry namespace. writeConfig serialises via JSON.stringify, which
  // drops keys whose value is `undefined` — this is the standard key-removal
  // idiom for this config API (ECMAScript §25.5.2 defines the omission of
  // undefined-valued properties). The behaviour is intentional and stable.
  if (daemonKey === 'inbox' && 'inboxPorts' in config) {
    updates.inboxPorts = undefined;
  }

  await writeConfig(updates);
}

// ── Shared scan helper ────────────────────────────────────────────────────────

/**
 * Scan rangeStart–rangeEnd for the first port not in claimedPorts and bindable.
 * Writes to config and returns the claimed port.
 *
 * @param {string} daemonKey
 * @param {string} id
 * @param {Record<string, number>} ports  — in-memory map for this daemon (read-only; new port is merged into a copy before writing)
 * @param {Set<number>} claimedPorts      — union of all claimed ports to skip
 * @param {number} rangeStart
 * @param {number} rangeEnd
 * @returns {Promise<number>}
 */
async function scanAndClaim(daemonKey, id, ports, claimedPorts, rangeStart, rangeEnd) {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (claimedPorts.has(port)) continue;
    const available = await isPortAvailable(port);
    if (available) {
      // Write the new allocation before returning; pass a fresh object so the
      // caller's ports reference stays consistent with on-disk state if the
      // write throws.
      await writeDaemonPorts(daemonKey, { ...ports, [id]: port });
      return port;
    }
  }
  throw new Error(
    `[port-registry:${daemonKey}] No available port in range ${rangeStart}–${rangeEnd}. ` +
    `All slots are either claimed or in use.`,
  );
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a port registry for a daemon type.
 *
 * The returned object has four methods:
 *   allocate(id)    — get or claim a stable port (returns cached unconditionally)
 *   reallocate(id)  — verify the cached port is bindable; re-allocate if occupied
 *   get(id)         — look up without allocating (returns null if not set)
 *   release(id)     — free the allocation (e.g. when a brain is deregistered)
 *
 * ## allocate vs reallocate
 *
 * `allocate(id)` returns the cached port unconditionally if one exists. This is
 * safe at daemon start when the daemon is already running (it holds its port, so
 * isPortAvailable would return false — returning the same port is correct).
 *
 * `reallocate(id)` is for startup conflict-recovery only: call it BEFORE
 * binding, when you know the daemon is not yet running, to detect and clear a
 * port that has been claimed by an unrelated process. If the port is free, it
 * returns the same cached port. If occupied by something else, it clears the
 * stale assignment and scans for a new free port.
 *
 * @param {string} daemonKey   — unique key for this daemon type (e.g. 'inbox')
 * @param {number} rangeStart  — first port in the allocation range (inclusive)
 * @param {number} rangeEnd    — last port in the allocation range (inclusive)
 * @returns {{
 *   allocate(id: string): Promise<number>,
 *   reallocate(id: string): Promise<number>,
 *   get(id: string): Promise<number|null>,
 *   release(id: string): Promise<void>
 * }}
 */
export function createDaemonPortRegistry(daemonKey, rangeStart, rangeEnd) {
  async function allocate(id) {
    let resolve;
    const prev = _allocationLock;
    _allocationLock = new Promise((r) => { resolve = r; });

    try {
      await prev;

      const config = await readConfig(); // single read for this lock window
      const ports = extractDaemonPorts(daemonKey, config);

      // Fast path: return the cached port unconditionally.
      // The daemon owns its port while running — isPortAvailable would return
      // false for a live daemon, which must not trigger re-allocation.
      if (typeof ports[id] === 'number') return ports[id];

      // No existing allocation — scan for a free port not claimed by any daemon.
      const otherClaimed = extractOtherClaimedPorts(daemonKey, config);
      const claimedPorts = new Set([...otherClaimed, ...Object.values(ports)]);
      return scanAndClaim(daemonKey, id, ports, claimedPorts, rangeStart, rangeEnd);
    } finally {
      resolve();
    }
  }

  /**
   * Startup-only conflict recovery. Verifies the cached port is still bindable
   * and re-allocates if an unrelated process has claimed it. Should only be
   * called when the daemon is known to not be running (e.g. before first bind).
   */
  async function reallocate(id) {
    let resolve;
    const prev = _allocationLock;
    _allocationLock = new Promise((r) => { resolve = r; });

    try {
      await prev;

      const config = await readConfig();
      const ports = extractDaemonPorts(daemonKey, config);

      let stalePort;
      if (typeof ports[id] === 'number') {
        const existing = ports[id];
        const available = await isPortAvailable(existing);
        // Port is free — daemon is not yet running, safe to use.
        if (available) return existing;
        // Port is occupied by an unrelated process — clear and re-allocate.
        delete ports[id];
        stalePort = existing;
      }

      const otherClaimed = extractOtherClaimedPorts(daemonKey, config);
      const claimedPorts = new Set([...otherClaimed, ...Object.values(ports)]);
      // Explicitly exclude the stale port even if the occupier exits during the
      // scan — prevents re-assigning it in the same recovery pass.
      if (stalePort !== undefined) claimedPorts.add(stalePort);
      return scanAndClaim(daemonKey, id, ports, claimedPorts, rangeStart, rangeEnd);
    } finally {
      resolve();
    }
  }

  async function get(id) {
    // Intentionally not protected by _allocationLock: get() is read-only and
    // callers (e.g. status checks) must not block behind ongoing allocations.
    const config = await readConfig();
    const ports = extractDaemonPorts(daemonKey, config);
    return typeof ports[id] === 'number' ? ports[id] : null;
  }

  async function release(id) {
    let resolve;
    const prev = _allocationLock;
    _allocationLock = new Promise((r) => { resolve = r; });

    try {
      await prev;
      const config = await readConfig();
      const ports = extractDaemonPorts(daemonKey, config);
      if (!(id in ports)) return;
      delete ports[id];
      await writeDaemonPorts(daemonKey, ports);
    } finally {
      resolve();
    }
  }

  return { allocate, reallocate, get, release };
}

// ── Built-in inbox registry ───────────────────────────────────────────────────
//
// Pre-built instance for the agentbootup inbox daemon. Callers that imported
// the named functions directly continue to work without any changes.

const _inboxRegistry = createDaemonPortRegistry('inbox', 8767, 8867);

/**
 * Allocate a stable inbox port for a brain.
 * Returns the cached port unconditionally — safe for idempotent daemon starts.
 *
 * ## Allocation persistence
 * PortRegistry entries survive daemon stop and are NEVER re-allocated unless
 * the port is unavailable (use `reallocateInboxPort` for startup conflict
 * recovery). If the daemon binds a different port due to EADDRINUSE, callers
 * should use `verifyInboxPortAndReRegister` (webhook-secret.js) which writes
 * the actual port directly via writeConfig — effectively a `force` override
 * that bypasses the scan-and-claim logic.
 *
 * @param {string} brainId
 * @returns {Promise<number>}
 */
export const allocateInboxPort = (brainId) => _inboxRegistry.allocate(brainId);

/**
 * Startup-only: verify the cached port is still bindable; re-allocate if
 * occupied by an unrelated process. Call this before first daemon bind, when
 * the daemon is known to not be running.
 * @param {string} brainId
 * @returns {Promise<number>}
 */
export const reallocateInboxPort = (brainId) => _inboxRegistry.reallocate(brainId);

/**
 * Return the previously allocated inbox port for a brain, or null if none.
 * @param {string} brainId
 * @returns {Promise<number | null>}
 */
export const getInboxPort = (brainId) => _inboxRegistry.get(brainId);

/**
 * Release the inbox port allocation for a brain.
 * @param {string} brainId
 * @returns {Promise<void>}
 */
export const releaseInboxPort = (brainId) => _inboxRegistry.release(brainId);
