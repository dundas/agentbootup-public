// PRD-0054 PR-5 / B-8 — server-side demotion-floor rejection.
//
// Once `memory/**` is demoted off the raw last-writer-wins asset path (the
// `AGENTBOOTUP_MEMORY_VIA_SNAPSHOTS` flip, health-gated on burn-in), the raw
// `memory/**` asset push must stop. The client-side gate (FR 4b) already
// withholds `memory/**` from discovery when converge is armed. THIS module is
// the server-side backstop: it rejects raw `memory/**` asset pushes from
// client versions below the demotion floor, for brains that have opted in.
// Without it, a stale/old client silently re-opens the stale-clobber hole the
// whole PRD exists to close.
//
// SAFETY MODEL (matches the PRD-0054 kill-switch discipline):
//   - Default OFF. `AGENTBOOTUP_MEMORY_DEMOTION_ENABLED=1` arms the server
//     check; until then `rejectMemoryPushIfDemoted` always returns null
//     (allow). No behavior change for any brain until the operator flips it.
//   - Per-brain opt-in via `brain.metadata.memory_demotion_enabled === true`.
//     A brain not opted in is never rejected, even when the server flag is on.
//   - The floor is the first release whose client respects the demotion gate
//     (PR-2 / 0.8.26). Clients at or above the floor are never rejected.
//   - Only RAW `memory/**` pages are rejected (path starts with `memory/`).
//     The snapshot convergence transport pushes under `memory-store/` (see
//     lib/memory/remote-store.js REMOTE_MEMORY_PREFIX) and MUST be allowed
//     through — rejecting it would break convergence itself. `memory-store/`
//     does not start with `memory/`, so the prefix test is exact.
//
// TRUST MODEL (roborev 14641 finding — accepted scope, documented here):
//   The `x-agentbootup-version` header is a STALENESS signal, NOT a security
//   boundary. It is self-reported by the client and therefore spoofable. This
//   is explicitly accepted by PRD-0054, whose threat model is stale/old
//   clients accidentally re-opening the stale-clobber hole — NOT malicious
//   clients. PRD-0054 names "No per-brain server-side authorization model
//   (single-tenant API key stays)" as a NON-GOAL: the API key is the trust
//   boundary, and a client holding it already has full push access (it could
//   equally disable the server flag or unset the brain opt-in). A server-
//   verified client attestation would contradict that non-goal and is a
//   separate piece of work requiring its own PRD. If the fleet ever moves to
//   untrusted/multi-tenant clients, THIS gate must be replaced by an
//   authenticated capability — do not rely on the header alone in that world.
//
// This module is PURE: no I/O, no store mutation. The single call site is in
// routes/brain-assets.ts `handlePushBrainAssets`, after file parsing and before
// `assetStore.push`. It is covered by tests/memory-demotion-floor.test.ts.

import { lt as semverLtRaw, valid as semverValid } from 'semver';
import type { Brain } from '../types';
import { jsonError } from '../errors';

/** Minimum client version allowed to raw-push `memory/**` once demotion is on. */
export const MEMORY_DEMOTION_FLOOR_VERSION = '0.8.26';

const DEMOTION_FLAG = 'AGENTBOOTUP_MEMORY_DEMOTION_ENABLED';
const DEMOTION_FLOOR_OVERRIDE = 'AGENTBOOTUP_MEMORY_DEMOTION_FLOOR';

export interface BrainAssetFileLike {
  path: string;
  asset_type?: string;
}

export interface DemotionRequest {
  brain: Brain | null;
  files: BrainAssetFileLike[];
  clientVersionHeader?: string | null;
  /** When true, every file is treated as a raw memory file (used for the legacy
   *  /v1/memory/:brainId/push route, where all files are memory by definition
   *  and paths are not necessarily `memory/`-prefixed). */
  allMemory?: boolean;
}

function resolveFloor(): string | null {
  const override = (process.env[DEMOTION_FLOOR_OVERRIDE] || '').trim();
  if (!override) return MEMORY_DEMOTION_FLOOR_VERSION;
  // Validate the override (roborev 14642): a malformed floor used to be treated
  // as 0.0.0 and silently allow everything. Now an invalid override returns
  // null and the caller fails CLOSED (rejects the raw memory push) rather than
  // fail-open. The operator fixes the override.
  return semverValid(override) ? String(override).trim() : null;
}

/** Server-level kill switch. Off = no rejection for any brain (default). */
export function isMemoryDemotionEnabled(): boolean {
  return process.env[DEMOTION_FLAG] === '1';
}

/** Per-brain opt-in. Lives on the brain's freeform metadata; no schema migration. */
export function isBrainOptedIn(brain: Brain | null): boolean {
  const meta = brain?.metadata as Record<string, unknown> | undefined;
  return Boolean(meta && meta.memory_demotion_enabled === true);
}

/** Pull the client-reported version from the `x-agentbootup-version` header. */
export function getClientVersion(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== 'string') return null;
  const v = headerValue.trim();
  return v ? v : null;
}

/** Only raw memory pages — never the `memory-store/` snapshot transport. */
export function isRawMemoryFile(file: BrainAssetFileLike): boolean {
  return typeof file?.path === 'string' && file.path.startsWith('memory/');
}

export function findRawMemoryFiles(files: BrainAssetFileLike[]): BrainAssetFileLike[] {
  return (files || []).filter(isRawMemoryFile);
}

/**
 * Is the client below the floor? Delegates to the `semver` package (a prod dep)
 * for correct prerelease handling: 0.8.26-beta.1 < 0.8.26 (roborev 14642).
 * A missing or malformed client version is treated as below-floor (old-client
 * backstop — an old client that doesn't send x-agentbootup-version is exactly
 * who this gate catches).
 */
export function isClientBelowFloor(clientVersion: string | null, floor: string): boolean {
  if (!clientVersion) return true;
  const v = semverValid(clientVersion);
  if (!v) return true; // malformed client version → below floor (fail-closed)
  return semverLtRaw(v, floor);
}

/**
 * Decide whether a raw `memory/**` asset push must be rejected.
 * Returns a JSON error Response to reject, or `null` to allow.
 *
 * Allow (null) when ANY of: demotion off, brain missing/not opted-in, client
 * at/above floor, or no raw `memory/` files in the push. Reject only when ALL
 * of: demotion on, brain opted-in, client below floor, and >=1 raw memory file.
 */
export function rejectMemoryPushIfDemoted(req: DemotionRequest): Response | null {
  if (!isMemoryDemotionEnabled()) return null;
  if (!isBrainOptedIn(req.brain)) return null;

  const rawMemory = req.allMemory ? req.files : findRawMemoryFiles(req.files);
  if (rawMemory.length === 0) return null;

  // Resolve the floor only when a raw memory push is actually present, so a
  // misconfigured floor never affects skills/code/secrets pushes.
  const floor = resolveFloor();
  const brainId = req.brain?.id ?? '<unknown>';
  if (!floor) {
    // Fail CLOSED: an invalid AGENTBOOTUP_MEMORY_DEMOTION_FLOOR override used
    // to be treated as 0.0.0 and silently allow everything (roborev 14642).
    // Now the raw memory push is rejected with a server-misconfigured error
    // until the operator fixes the override.
    const override = (process.env[DEMOTION_FLOOR_OVERRIDE] || '').trim();
    return jsonError(
      500,
      'server_misconfigured_floor',
      `Brain '${brainId}': AGENTBOOTUP_MEMORY_DEMOTION_FLOOR override '${override}' is not a valid semver. ` +
        `Set it to a valid X.Y.Z (e.g. '${MEMORY_DEMOTION_FLOOR_VERSION}') or unset it. Fail-closed: raw memory/** pushes are rejected until fixed.`,
    );
  }

  const clientVersion = getClientVersion(req.clientVersionHeader);
  // A missing/malformed version is treated as below-floor: an old client that
  // does not send x-agentbootup-version is exactly the client this backstop
  // catches. Operators who run legacy pushers that cannot be upgraded can
  // disable demotion for that brain (opt-out) or flip the server flag off —
  // both are deliberate, logged, reversible.
  if (!isClientBelowFloor(clientVersion, floor)) return null;

  return jsonError(
    426,
    'client_version_below_demotion_floor',
    `Brain '${brainId}' has memory demotion enabled: raw memory/** asset pushes are demoted in favor of the snapshot protocol. ` +
      `Use 'agentbootup memory publish' / 'memory refresh --from-store' (via AGENTBOOTUP_MEMORY_STORE) to move memory. ` +
      `If this client is agentbootup, upgrade to >= ${floor} (reported '${clientVersion ?? 'missing'}'); ` +
      `if it is a non-agentbootup client, route its memory writes through the snapshot store instead of raw asset push, ` +
      `or have an operator disable demotion for this brain (brain.metadata.memory_demotion_enabled).`,
  );
}
