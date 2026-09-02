/**
 * brain-source-descriptor/1 — the explicit declaration of where a brain's shared
 * assets come from (PRD-0059 FR-1).
 *
 * This exists because the asset daemon derived its source from
 * `AGENTBOOTUP_PROJECT_ROOT || process.cwd()` and pushed `{files, machine_id,
 * machine_info}` with no Git ref and no brain `branch_id`. Two machines watching
 * two divergent checkouts of one repo therefore published into one unqualified
 * namespace, last-writer-wins.
 *
 * Three axes are deliberately separate fields, never derived from one another:
 *
 *   source_root  — a filesystem location. Where the bytes are.
 *   repo_ref     — a Git ref. Which commit lineage tracked artifacts belong to.
 *                  Meaningless for `source_kind: 'directory'`.
 *   branch_id    — AgentBootup's runtime-state overlay identity. NOT a Git branch.
 *                  A Git branch name must never populate or alias it; conflating
 *                  the two is the specific confusion this contract exists to end.
 *
 * Canonical-form policy is inherited from `brain-runtime-manifest/2`: a declared
 * descriptor is compared against its own canonical form and rejected if it differs.
 * It is never silently canonicalized — rewriting a declaration would change the
 * document whose hash was computed over it.
 */

import path from 'path';
import { createHash } from 'crypto';
import { assertContainedRelativePath } from '../util/contained-path.js';

export const SOURCE_DESCRIPTOR_VERSION = 'brain-source-descriptor/1';

export const VALID_SOURCE_KINDS = new Set(['git', 'directory']);

const DESCRIPTOR_KEYS = new Set(['version', 'source_kind', 'source_root', 'repo_ref', 'brain_id', 'branch_id']);

// Git refs are validated structurally rather than by asking git — this module must
// work for a `directory` source with no git present.
const REF_RE = /^refs\/[A-Za-z0-9._\-/]+$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_ID_LENGTH = 128;
const MAX_ROOT_LENGTH = 4096;

export class SourceDescriptorError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'SourceDescriptorError';
    this.reason = reason;
  }
}

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalJsonString(value) {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalizeValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SourceDescriptorError('NON_CANONICAL_VALUE');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) throw new SourceDescriptorError('NON_CANONICAL_VALUE');
    return Object.fromEntries(
      Object.keys(value).sort(compareCodeUnits).map((key) => [key, canonicalizeValue(value[key])]),
    );
  }
  throw new SourceDescriptorError('NON_CANONICAL_VALUE');
}

/**
 * A source root is an absolute POSIX path, validated with OS-NEUTRAL rules.
 *
 * The validation deliberately does not use `path.isAbsolute`/`path.normalize`:
 * those follow the host OS, so the same descriptor would validate on one machine
 * and fail on another, and a descriptor whose meaning depends on who reads it is
 * the defect this contract exists to remove. `path.posix` is used explicitly so
 * every machine reaches the same verdict about the same bytes.
 *
 * Windows-style roots are rejected outright rather than half-supported. agentbootup
 * targets macOS and Linux; accepting `C:\repo` here would mean pretending to a
 * portability that nothing downstream honors.
 *
 * Not resolved against the filesystem: existence is a separate, caller-owned check,
 * so a descriptor CAN be validated on a machine that does not host the source.
 */
function canonicalSourceRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new SourceDescriptorError('SOURCE_ROOT_INVALID');
  if (value.includes('\0')) throw new SourceDescriptorError('SOURCE_ROOT_INVALID', 'NUL byte');
  if (value.length > MAX_ROOT_LENGTH) throw new SourceDescriptorError('SOURCE_ROOT_INVALID', 'too long');
  if (/^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
    throw new SourceDescriptorError('SOURCE_ROOT_NOT_POSIX', value);
  }
  // `~` is not expanded here: expansion is environment-dependent, and a descriptor
  // that means different things on two machines is exactly the defect being fixed.
  if (value.startsWith('~')) throw new SourceDescriptorError('SOURCE_ROOT_NOT_ABSOLUTE', 'unexpanded ~');
  if (!value.startsWith('/')) throw new SourceDescriptorError('SOURCE_ROOT_NOT_ABSOLUTE', value);
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function assertId(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new SourceDescriptorError(`${field}_INVALID`);
  if (value.length > MAX_ID_LENGTH) throw new SourceDescriptorError(`${field}_INVALID`, 'too long');
  if (!ID_RE.test(value)) throw new SourceDescriptorError(`${field}_INVALID`, value);
  return value;
}

/**
 * Build the canonical form of a descriptor. Throws on anything that cannot be
 * canonicalized; callers compare against this rather than substituting it.
 */
export function canonicalDescriptor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SourceDescriptorError('DESCRIPTOR_INVALID');
  if (!Object.keys(raw).every((key) => DESCRIPTOR_KEYS.has(key))) {
    throw new SourceDescriptorError('DESCRIPTOR_UNKNOWN_FIELD');
  }
  if (raw.version !== SOURCE_DESCRIPTOR_VERSION) throw new SourceDescriptorError('DESCRIPTOR_VERSION_UNSUPPORTED', String(raw.version));
  if (!VALID_SOURCE_KINDS.has(raw.source_kind)) throw new SourceDescriptorError('SOURCE_KIND_INVALID', String(raw.source_kind));

  const descriptor = {
    version: SOURCE_DESCRIPTOR_VERSION,
    source_kind: raw.source_kind,
    source_root: canonicalSourceRoot(raw.source_root),
    brain_id: assertId(raw.brain_id, 'BRAIN_ID'),
    repo_ref: null,
    branch_id: null,
  };

  if (raw.source_kind === 'git') {
    // A git source without a canonical ref is exactly the ambiguity this contract
    // forbids. Fail closed and make the operator declare it — never infer `main`.
    if (raw.repo_ref == null) throw new SourceDescriptorError('REPO_REF_REQUIRED');
    if (typeof raw.repo_ref !== 'string' || !REF_RE.test(raw.repo_ref) || raw.repo_ref.includes('..')) {
      throw new SourceDescriptorError('REPO_REF_INVALID', String(raw.repo_ref));
    }
    descriptor.repo_ref = raw.repo_ref;
  } else if (raw.repo_ref != null) {
    // A directory source has no refs. Carrying one would invite a later reader to
    // act on it.
    throw new SourceDescriptorError('REPO_REF_NOT_APPLICABLE');
  }

  if (raw.branch_id != null) {
    descriptor.branch_id = assertId(raw.branch_id, 'BRANCH_ID');
  }

  // Enforced HERE, in the one place every descriptor is constructed, rather than
  // as a helper a caller is trusted to remember. It was briefly the latter, and a
  // test proved the helper worked while nothing proved it was ever reached — a
  // guard that exists but is not wired in is not a guard.
  assertBranchIdNotDerivedFromRef(descriptor);

  return descriptor;
}

/**
 * Validate a declared descriptor: it must already BE its canonical form.
 *
 * Same policy as `brain-runtime-manifest/2` — compare, never substitute. A
 * descriptor that merely *means* the right thing but is spelled differently is
 * rejected, so a stored descriptor and a rebuilt one are byte-comparable.
 */
export function validateDescriptor(raw) {
  const canonical = canonicalDescriptor(raw);
  if (canonicalJsonString(raw) !== canonicalJsonString(canonical)) {
    throw new SourceDescriptorError('DESCRIPTOR_NOT_CANONICAL');
  }
  return canonical;
}

export function descriptorHash(descriptor) {
  return createHash('sha256').update(canonicalJsonString(canonicalDescriptor(descriptor))).digest('hex');
}

/**
 * Build a descriptor from explicit operator-supplied parts.
 *
 * There is intentionally no `fromCwd`, `detect`, or `infer` entry point. Every
 * field arrives from an explicit declaration; that is the whole point of the
 * contract, and an inference helper would immediately become the thing callers
 * reach for.
 */
export function declareDescriptor({ sourceKind, sourceRoot, repoRef = null, brainId, branchId = null }) {
  return validateDescriptor({
    version: SOURCE_DESCRIPTOR_VERSION,
    source_kind: sourceKind,
    // Passed through UNCHANGED. This briefly canonicalized the operator's path
    // before validating it, which quietly accepted `/repo/./src/` — the one door
    // rewriting a declaration while the other rejected it. A source-of-truth
    // declaration that gets silently rewritten is the ambiguity being removed.
    source_root: sourceRoot,
    brain_id: brainId,
    repo_ref: sourceKind === 'git' ? repoRef : (repoRef ?? null),
    branch_id: branchId,
  });
}

/**
 * The guard for PRD-0059 FR-1's central rule (WO test 6): a Git ref must never
 * become a runtime `branch_id`. Callers that have both values pass them here
 * before persisting.
 */
export function assertBranchIdNotDerivedFromRef(descriptor) {
  const { repo_ref: repoRef, branch_id: branchId } = descriptor;
  if (repoRef == null || branchId == null) return descriptor;
  // Every suffix of the ref's path, not a fixed list of prefixes to strip.
  // Stripping `refs/(heads|remotes|tags)/` left `refs/remotes/origin/main` to
  // shorten to `origin/main`, so `branch_id: 'main'` — plainly derived — passed.
  // Enumerating what the ref can shorten to closes the whole family instead of
  // the two spellings someone happened to think of.
  const segments = repoRef.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    if (branchId === segments.slice(index).join('/')) {
      throw new SourceDescriptorError('BRANCH_ID_DERIVED_FROM_REF', `${branchId} <- ${repoRef}`);
    }
  }
  return descriptor;
}
