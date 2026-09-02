/**
 * Legacy-daemon quarantine and dry-run migration (PRD-0059 FR-9/FR-10).
 *
 * A daemon configured the old way — `brain_id` plus a watched `projectRoot`, no
 * persisted source descriptor — is not upgraded in place and is not trusted to
 * guess. It enters a report-only quarantine: it keeps observing and reporting, and
 * it does not publish. Publishing resumes only after an operator names the
 * authoritative source and a receipt records that they did.
 *
 * Nothing here infers authority from newest mtime, daemon liveness, package
 * version, hostname, or the current branch. Those are exactly the signals that
 * feel authoritative and are not; the whole point of the work order is that
 * authority is declared, not detected.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { describeCanonicalRef, describeCheckedOutRef, isGitWorkTree, isWorkTreeDirty } from './canonical-ref.js';
import { validateDescriptor, descriptorHash, SourceDescriptorError } from './source-descriptor.js';
import { IGNORED_STATE_ROOTS } from './canonical-state-root.js';
import { readJsonFile } from '../util/read-file.js';

export const DAEMON_STATES = Object.freeze({
  /** A descriptor exists and resolves. The daemon may publish. */
  READY: 'ready',
  /** Legacy configuration, or an unresolvable canonical ref. Reports, never publishes. */
  QUARANTINED: 'quarantined',
});

export const QUARANTINE_REASONS = Object.freeze({
  NO_DESCRIPTOR: 'no_source_descriptor',
  DESCRIPTOR_INVALID: 'source_descriptor_invalid',
  CANONICAL_REF_UNRESOLVED: 'canonical_ref_unresolved',
  ROOT_MISMATCH: 'descriptor_root_does_not_match_watched_root',
});

const DESCRIPTOR_FILE = 'source-descriptor.json';
const OWNED_DESCRIPTOR_DIRECTORY = 'source-descriptors';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The per-machine AgentBootup-owned descriptor root. Repository `.brain` is not an
 * authority boundary: an untrusted checkout can replace it between any pathname
 * check and a later write. A configured state root is an operator-owned boundary.
 */
export function descriptorStateRoot({ stateRoot } = {}) {
  if (stateRoot != null) return path.resolve(String(stateRoot)); // nosemgrep: path-join-resolve-traversal -- explicit AgentBootup-owned state-root configuration
  if (process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT) {
    return path.resolve(process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT); // nosemgrep: path-join-resolve-traversal -- operator-owned per-machine state-root configuration
  }
  // Never fall back to cwd: a stripped service environment may inherit the
  // watched checkout as cwd, which would reintroduce repository-controlled
  // authority. os.homedir remains per-machine even when HOME is absent.
  const home = process.env.AGENTBOOTUP_HOME || path.join(os.homedir(), '.agentbootup');
  return path.join(path.resolve(home), OWNED_DESCRIPTOR_DIRECTORY); // nosemgrep: path-join-resolve-traversal -- fixed child of AgentBootup-owned home state
}

export function sourceDescriptorId(projectRoot) {
  return sha256(path.resolve(projectRoot)); // nosemgrep: path-join-resolve-traversal -- opaque key for an explicit watched root, never used as a file path
}

/** A deterministic opaque leaf: it deliberately reveals no source pathname. */
export function descriptorPath(projectRoot, options = {}) {
  return path.join(descriptorStateRoot(options), `${sourceDescriptorId(projectRoot)}.json`); // nosemgrep: path-join-resolve-traversal -- fixed opaque SHA-256 filename below owned state root
}

/** Evidence only. Never reads, parses, or trusts a repository descriptor. */
export function legacyDescriptorEvidence(projectRoot) {
  const root = path.resolve(projectRoot); // nosemgrep: path-join-resolve-traversal -- observed local root; legacy metadata is never read or trusted
  const legacyDir = path.join(root, '.brain'); // nosemgrep: path-join-resolve-traversal -- fixed legacy evidence child; never traversed or read
  const legacyFile = path.join(legacyDir, DESCRIPTOR_FILE); // nosemgrep: path-join-resolve-traversal -- fixed legacy evidence filename; lstat only
  try {
    const dir = fs.lstatSync(legacyDir);
    if (dir.isSymbolicLink() || !dir.isDirectory()) return 'unsafe';
    try {
      const file = fs.lstatSync(legacyFile);
      return file.isSymbolicLink() || !file.isFile() ? 'unsafe' : 'present';
    } catch (err) {
      return err?.code === 'ENOENT' ? 'absent' : 'unknown';
    }
  } catch (err) {
    return err?.code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

export function loadDescriptor(projectRoot, options = {}) {
  const read = readJsonFile(descriptorPath(projectRoot, options));
  // A corrupt descriptor is NOT a missing one. Reporting it as missing quarantines
  // for the wrong reason and hides on-disk corruption from the operator — the same
  // absent-vs-error collapse that hit the state index and the lease.
  if (read.state === 'absent') return null;
  if (read.state === 'invalid') return { __invalid: `descriptor_${read.detail}` };
  try {
    return validateDescriptor(read.value);
  } catch (err) {
    if (err instanceof SourceDescriptorError) return { __invalid: err.reason };
    throw err;
  }
}

export function saveDescriptor(projectRoot, descriptor, options = {}) {
  const validated = validateDescriptor(descriptor);
  const root = descriptorStateRoot(options);
  const target = descriptorPath(projectRoot, options);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  return validated;
}

/**
 * Decide whether a daemon may publish.
 *
 * Deliberately takes the watched root as an argument rather than reading cwd: a
 * function that can consult `process.cwd()` will eventually be called somewhere
 * that makes cwd wrong, which is how the original defect arrived.
 */
export function evaluateDaemonSource(watchedRoot, { runner, stateRoot } = {}) {
  const root = path.resolve(watchedRoot); // nosemgrep: path-join-resolve-traversal -- watchedRoot is the operator-declared watched root
  const descriptor = loadDescriptor(root, { stateRoot });
  const legacy_descriptor = legacyDescriptorEvidence(root);

  if (descriptor == null) {
    return {
      state: DAEMON_STATES.QUARANTINED,
      reason: QUARANTINE_REASONS.NO_DESCRIPTOR,
      may_publish: false,
      descriptor: null,
      legacy_descriptor,
      watched_root: root,
    };
  }
  if (descriptor.__invalid) {
    return {
      state: DAEMON_STATES.QUARANTINED,
      reason: QUARANTINE_REASONS.DESCRIPTOR_INVALID,
      detail: descriptor.__invalid,
      may_publish: false,
      descriptor: null,
      legacy_descriptor,
      watched_root: root,
    };
  }
  if (descriptor.source_root !== root) {
    // A descriptor pointing somewhere else is not a descriptor for this daemon.
    return {
      state: DAEMON_STATES.QUARANTINED,
      reason: QUARANTINE_REASONS.ROOT_MISMATCH,
      detail: `${descriptor.source_root} != ${root}`,
      may_publish: false,
      descriptor,
      legacy_descriptor,
      watched_root: root,
    };
  }

  if (descriptor.source_kind === 'git') {
    const resolved = describeCanonicalRef(root, { declaredRef: descriptor.repo_ref, runner });
    if (!resolved.resolved) {
      return {
        state: DAEMON_STATES.QUARANTINED,
        reason: QUARANTINE_REASONS.CANONICAL_REF_UNRESOLVED,
        detail: resolved.reason,
        may_publish: false,
        descriptor,
        legacy_descriptor,
        watched_root: root,
      };
    }
    return {
      state: DAEMON_STATES.READY,
      may_publish: true,
      descriptor,
      legacy_descriptor,
      canonical_ref: resolved.ref,
      ref_source: resolved.source,
      watched_root: root,
    };
  }

  return { state: DAEMON_STATES.READY, may_publish: true, descriptor, legacy_descriptor, canonical_ref: null, watched_root: root };
}

/** Public, closed descriptor-state projection for report and CLI consumers. */
export function descriptorStateLabel(evaluation) {
  if (evaluation?.descriptor) return 'owned_present';
  return evaluation?.reason === QUARANTINE_REASONS.DESCRIPTOR_INVALID ? 'owned_invalid' : 'owned_absent';
}

/**
 * Classify a watched root's assets as Git-tracked vs ignored mutable state.
 *
 * The two classes have different homes — tracked artifacts belong to the canonical
 * ref, ignored state belongs to the canonical state root — so an operator being
 * asked to choose an authoritative source needs to see the split, not a total.
 */
export function classifyAssets(watchedRoot, { runner } = {}) {
  const root = path.resolve(watchedRoot); // nosemgrep: path-join-resolve-traversal -- relRoot is from the IGNORED_STATE_ROOTS allowlist
  const ignoredRoots = [];
  const unsafeRoots = [];
  for (const relRoot of IGNORED_STATE_ROOTS) {
    const abs = path.join(root, relRoot); // nosemgrep: path-join-resolve-traversal -- relRoot is from the IGNORED_STATE_ROOTS allowlist
    let stat;
    try {
      // lstat is required here, not only in collection: existsSync returns false
      // for a dangling symlink, silently dropping a declared policy root before
      // the collector can reject it.
      stat = fs.lstatSync(abs);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      // A migration report is descriptive: surface an unsafe root so the
      // operator can remediate it. The machine-add executor rejects this state
      // before it ever collects or proposes assets.
      unsafeRoots.push({ root: relRoot, reason: 'symlink_denied' });
    } else if (stat.isDirectory()) {
      ignoredRoots.push(relRoot);
    } else {
      unsafeRoots.push({ root: relRoot, reason: 'not_directory' });
    }
  }
  return {
    git_backed: isGitWorkTree(root, runner),
    ignored_state_roots: ignoredRoots,
    unsafe_ignored_state_roots: unsafeRoots,
  };
}

/**
 * The dry-run migration report (FR-10).
 *
 * It reports and never writes. It deliberately does NOT nominate an authoritative
 * source: naming one would be the inference this contract exists to forbid, and an
 * operator reading a recommendation tends to accept it.
 */
export function buildMigrationReport(watchedRoot, { runner, stateRoot, competingWriters = [], serverRevision = null } = {}) {
  const root = path.resolve(watchedRoot); // nosemgrep: path-join-resolve-traversal -- watchedRoot is the operator-declared watched root
  const evaluation = evaluateDaemonSource(root, { runner, stateRoot });
  const classification = classifyAssets(root, { runner });
  const checkedOut = classification.git_backed ? describeCheckedOutRef(root, runner) : null;
  const dirty = classification.git_backed ? isWorkTreeDirty(root, runner) : null;

  return {
    dry_run: true,
    watched_root: root,
    daemon_state: evaluation.state,
    quarantine_reason: evaluation.reason ?? null,
    descriptor: evaluation.descriptor,
    descriptor_state: descriptorStateLabel(evaluation),
    legacy_descriptor: evaluation.legacy_descriptor,
    git_backed: classification.git_backed,
    checked_out_ref: checkedOut?.ref ?? null,
    checked_out_detached: checkedOut?.detached ?? null,
    work_tree_dirty: dirty,
    canonical_ref: evaluation.canonical_ref ?? null,
    ref_source: evaluation.ref_source ?? null,
    ignored_state_roots: classification.ignored_state_roots,
    unsafe_ignored_state_roots: classification.unsafe_ignored_state_roots,
    server_revision: serverRevision,
    competing_writers: competingWriters,
    proposed_state_root: evaluation.descriptor
      ? { brain_id: evaluation.descriptor.brain_id, branch_id: evaluation.descriptor.branch_id }
      : null,
    // No recommendation, by design. See the note above.
    authoritative_source: null,
  };
}

/**
 * Record an operator's explicit authoritative-source selection.
 *
 * `selectedBy` is required and free-form: a receipt that cannot say who decided is
 * not a receipt. The descriptor is validated and persisted as part of the same
 * call, so there is no window where a selection is recorded but not in effect.
 */
function isCanonicalUtcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const [date, time] = value.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second] = time.slice(0, 8).split(':').map(Number);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === day
    && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute
    && parsed.getUTCSeconds() === second;
}

export function recordAuthoritativeSelection(watchedRoot, descriptor, { selectedBy, selectedAt, rationale = null, stateRoot } = {}) {
  if (typeof selectedBy !== 'string' || !selectedBy.trim()) {
    throw new SourceDescriptorError('SELECTION_ACTOR_REQUIRED');
  }
  if (!isCanonicalUtcTimestamp(selectedAt)) {
    throw new SourceDescriptorError('SELECTION_TIMESTAMP_REQUIRED');
  }
  // "Selection and effect are one call" has to be true, not merely documented. A
  // descriptor for a different root would persist happily and then quarantine the
  // daemon with ROOT_MISMATCH — handing back a receipt for a choice that never took
  // effect, which is exactly the false evidence this contract must not emit.
  const resolvedRoot = path.resolve(watchedRoot); // nosemgrep: path-join-resolve-traversal -- watchedRoot is the operator-declared watched root
  const candidate = validateDescriptor(descriptor);
  if (candidate.source_root !== resolvedRoot) {
    throw new SourceDescriptorError('SELECTION_ROOT_MISMATCH', `${candidate.source_root} != ${resolvedRoot}`);
  }
  const saved = saveDescriptor(watchedRoot, descriptor, { stateRoot });
  return {
    receipt_version: 'brain-source-selection/1',
    watched_root: path.resolve(watchedRoot), // nosemgrep: path-join-resolve-traversal -- watchedRoot is the operator-declared watched root
    descriptor: saved,
    descriptor_hash: descriptorHash(saved),
    selected_by: selectedBy,
    selected_at: selectedAt,
    rationale,
  };
}
