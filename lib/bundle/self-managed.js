/**
 * Per-brain self-managed protocol pin (PRD: bundle-sync clobbers repo-local protocol amendments).
 *
 * A repo that commits its own protocol-layer amendment (e.g. circle_computer's protocol-0f)
 * is detected by `agentbootup bundle sync` as DRIFT vs the canonical registry and silently
 * re-applied — clobbering the committed local amendment in the working tree. This module
 * provides the opt-out: a repo declares itself self-managed, and the bundle CLI's hosted
 * sync skips re-applying protocols to it (reporting a distinct `SELF_MANAGED` status instead
 * of `DRIFT`). Read-only for the sync path; the marker is written by an explicit CLI verb.
 *
 * The marker is a separate file (`.ai/protocols/self-managed.json`), NOT a bundle target —
 * it is intentionally absent from every protocol-bundle manifest's `files` list so it cannot
 * itself drift. It carries a human-readable reason and audit fields so an operator can see
 * WHY a brain pinned itself, not just that it did.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

/** Relative to the target repo root. NOT a bundle target — never listed in any manifest. */
export const SELF_MANAGED_MARKER_RELATIVE = path.join('.ai', 'protocols', 'self-managed.json');

function markerPath(targetRoot) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- SELF_MANAGED_MARKER_RELATIVE is a hardcoded constant ('.ai/protocols/self-managed.json'), not manifest/user input; targetRoot is an operator-supplied directory from --target-root/cwd, the same trust class as every other path.join(targetRoot, <fixed-relative>) in lib/bundle.
  return path.join(targetRoot, SELF_MANAGED_MARKER_RELATIVE);
}

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read the self-managed marker. Absent or `enabled: false` ⇒ `null` (not self-managed).
 * A malformed marker is reported as `{ enabled: false, malformed }` so a caller can surface
 * it without treating corruption as a pin (fail-open: a corrupt marker does NOT pin).
 * @param {string} targetRoot
 * @param {{ readFileSync?: typeof fs.readFileSync }} [deps]
 * @returns {{ enabled: true, reason: string, pinned_at: string, pinned_by: string } | { enabled: false, malformed: string } | null}
 */
export function readSelfManaged(targetRoot, deps = {}) {
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  let raw;
  try {
    raw = readFileSync(markerPath(targetRoot), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    // Unreadable for any other reason (EACCES/EISDIR): do NOT silently pin. Report malformed.
    return { enabled: false, malformed: `unreadable marker: ${errMessage(err)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { enabled: false, malformed: `marker is not valid JSON: ${errMessage(err)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { enabled: false, malformed: 'marker is not a JSON object' };
  }
  // No `enabled` field ⇒ treat as not-pinned (absent intent, fail-open). A marker that
  // exists but omits the flag is ambiguous; null keeps sync proceeding normally.
  if (!('enabled' in parsed)) return null;
  // `enabled` present but not a boolean ⇒ malformed (e.g. {"enabled":"true"}). Surface it
  // so the CLI warns rather than silently treating a typo as disabled OR as a pin.
  if (typeof parsed.enabled !== 'boolean') {
    return { enabled: false, malformed: `marker 'enabled' must be a boolean, got ${typeof parsed.enabled}` };
  }
  if (parsed.enabled === false) return null;
  return {
    enabled: true,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    pinned_at: typeof parsed.pinned_at === 'string' ? parsed.pinned_at : '',
    pinned_by: typeof parsed.pinned_by === 'string' ? parsed.pinned_by : '',
  };
}

/**
 * Is the target repo self-managed (marker present AND enabled)? Fail-open: a malformed or
 * unreadable marker is NOT a pin, so sync proceeds normally (an operator sees the DRIFT).
 * @returns {boolean}
 */
export function isSelfManaged(targetRoot, deps = {}) {
  const marker = readSelfManaged(targetRoot, deps);
  return marker?.enabled === true;
}

/**
 * Enable the self-managed pin (write the marker). Idempotent: re-enabling overwrites with a
 * fresh reason/timestamp. The parent dir (.ai/protocols) is created if absent.
 * @param {string} targetRoot
 * @param {{ reason?: string, pinned_by?: string, now?: () => string }} [opts]
 * @param {{ mkdirSync?: typeof fs.mkdirSync, writeFileSync?: typeof fs.writeFileSync }} [deps]
 * @returns {{ enabled: true, reason: string, pinned_at: string, pinned_by: string }}
 */
export function enableSelfManaged(targetRoot, opts = {}, deps = {}) {
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync;
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync;
  const now = opts.now ?? (() => new Date().toISOString());
  const marker = {
    enabled: true,
    reason: typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : 'repo commits its own protocol layer; do not sync',
    pinned_at: now(),
    pinned_by: typeof opts.pinned_by === 'string' && opts.pinned_by.trim() ? opts.pinned_by.trim() : '',
  };
  const file = markerPath(targetRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  return marker;
}

/**
 * Disable the self-managed pin (remove the marker). Idempotent: no error if absent.
 * @param {string} targetRoot
 * @param {{ rmSync?: typeof fs.rmSync, existsSync?: typeof fs.existsSync }} [deps]
 * @returns {boolean} true if a marker was removed, false if it was already absent
 */
export function disableSelfManaged(targetRoot, deps = {}) {
  const rmSync = deps.rmSync ?? fs.rmSync;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const file = markerPath(targetRoot);
  // rmSync({force:true}) swallows ENOENT, so check existence first to distinguish
  // "removed a real marker" (true) from "was already absent" (false).
  if (!existsSync(file)) return false;
  rmSync(file, { force: true, recursive: true });
  return true;
}

export { markerPath as _markerPath };