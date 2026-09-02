/**
 * brain-runtime-manifest/2 — the canonical non-secret runtime inventory used to
 * prove second-machine parity (PRD-0058 FR-2/FR-3).
 *
 * Contract shape:
 *   {
 *     version, roots[], files[], file_count, total_bytes,  // the hashed parity payload
 *     sha256,                                              // digest of the canonical payload
 *     source: { revision, generated_at }                   // provenance, NEVER hashed
 *   }
 *
 * `source` is deliberately outside the digest: the acceptance criterion is that a
 * source and a target checkout produce *identical* manifest hashes, so anything
 * that legitimately differs between the two machines (git revision, build time)
 * must not participate in the parity hash.
 *
 * Root authority: builder and verifier share ONE normalization gate. A caller may
 * narrow the root set via `options.roots`, but never widen it past `RUNTIME_ROOTS` —
 * a hostile manifest must not be able to steer the verifier over an arbitrary tree,
 * and the builder must not be able to emit a manifest the verifier is required to
 * reject. Two ends of one contract that disagree are a contract with a hole in it.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createSecretGuard } from './secret-guard.js';
import { assertContainedRelativePath } from '../util/contained-path.js';

export const RUNTIME_MANIFEST_VERSION = 'brain-runtime-manifest/2';
/**
 * The incomplete contract that shipped in 0.8.31 under the `/1` name. `/2` added
 * the root inventory, entry `type`/`mode`, bounds, and a canonical hash payload —
 * none of it backward compatible — so the version was bumped rather than left
 * denoting two incompatible schemas. Kept only to name a `/1` manifest on sight.
 */
export const LEGACY_MANIFEST_VERSION = 'brain-runtime-manifest/1';

/**
 * Allowlisted runtime roots (FR-3). Every manifest entry must live under exactly
 * one of these; anything else is rejected rather than silently dropped, so a
 * hostile or drifted manifest can never widen the restore surface.
 *
 * COUPLING — this list is a claim about what the restore path must materialize.
 * A root declared here that the restore path does not carry produces parity that
 * can never go green, which is worse than not declaring it: the operator is told
 * something is wrong forever, with a correct transport. Task 2.2 owns restoring
 * every root in this list, and `tests/brain/runtime-manifest.test.js` asserts the
 * two lists are the same so neither can drift alone.
 *
 * `memory` is the live case: the existing *share* surface (`SHARE_ROOT_SPECS` in
 * lib/share/cli.js) does not carry it, and raw memory publication is suppressed
 * outright when memory-converge is enabled. The 0058 bootstrap path restores from
 * this manifest by construction, so it is consistent there — but the two paths
 * are not the same path, and that difference is exactly what must not be assumed.
 */
export const RUNTIME_ROOTS = Object.freeze([
  '.agents/agents',
  '.agents/commands',
  '.agents/skills',
  '.brain/scripts',
  '.claude/agents',
  '.claude/commands',
  '.claude/skills',
  'brain',
  'memory',
]);

// Bounds (FR-2 "unbounded size"). A runtime tree that exceeds any of these is
// rejected outright — a restore surface this large is a declaration error, not
// something to truncate silently.
export const MAX_RUNTIME_FILES = 20000;
export const MAX_RUNTIME_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_RUNTIME_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_RUNTIME_PATH_LENGTH = 1024;
/**
 * Scan bound, distinct from the manifest bound above. The walk sees files that
 * filtering later drops (ephemeral, secret-guarded), so capping the *scan* at
 * MAX_RUNTIME_FILES would refuse trees that yield a perfectly legal manifest.
 * This is the runaway-walk backstop; MAX_RUNTIME_FILES is the contract.
 */
export const MAX_RUNTIME_SCAN_FILES = MAX_RUNTIME_FILES * 4;

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '__pycache__', '.next', '.nuxt', 'vendor', '.worktrees']);
const EPHEMERAL_FILE = /(?:\.log|\.tmp|\.cache|\.swp|\.bak|\.pyc)$/i;
const HEX_256_RE = /^[a-f0-9]{64}$/;
const GIT_REVISION_RE = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;

const SOURCE_KEYS = new Set(['revision', 'revision_source', 'generated_at']);
const VALID_REVISION_SOURCES = new Set([
  'declared',
  'loose_ref',
  'packed_ref',
  'detached_head',
  'no_git_dir',
  'head_unreadable',
  'head_unparsable',
  'ref_unresolved',
]);
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const ENTRY_KEYS = new Set(['path', 'type', 'mode', 'sha256', 'bytes']);
const ROOT_KEYS = new Set(['path', 'present', 'file_count']);
const MANIFEST_KEYS = new Set(['version', 'roots', 'files', 'file_count', 'total_bytes', 'sha256', 'source']);

const VALID_ENTRY_TYPES = new Set(['file']);
const VALID_MODE_CLASSES = new Set(['regular', 'exec']);
const ALLOWLISTED_ROOTS = new Set(RUNTIME_ROOTS);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic JSON serialization: object keys sorted by code unit, recursively.
 * Both the builder and the verifier hash through this single funnel, so a manifest
 * that round-trips through `JSON.parse` (which preserves the producer's key order)
 * still digests to the same value the builder emitted.
 */
export function canonicalJsonString(value, label = 'runtime manifest') {
  return JSON.stringify(canonicalizeValue(value, label));
}

function canonicalizeValue(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`RUNTIME_MANIFEST_NON_CANONICAL:${label}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeValue(item, label));
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) throw new Error(`RUNTIME_MANIFEST_NON_CANONICAL:${label}`);
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCodeUnits)
        .map((key) => [key, canonicalizeValue(value[key], label)]),
    );
  }
  throw new Error(`RUNTIME_MANIFEST_NON_CANONICAL:${label}`);
}

/**
 * The parity payload — everything the source and target must agree on, and
 * nothing that legitimately differs between two machines.
 */
function parityPayload(manifest) {
  return {
    version: manifest.version,
    roots: manifest.roots,
    files: manifest.files,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
  };
}

export function computeRuntimeManifestHash(manifest) {
  return digest(canonicalJsonString(parityPayload(manifest)));
}

/**
 * One root-normalization gate for builder and verifier alike. A caller may narrow
 * the root set (fixtures, scoped verification) but may never widen it: the builder
 * must not be able to emit a manifest the verifier is required to reject.
 */
function normalizeRoots(roots) {
  const declared = roots ?? RUNTIME_ROOTS;
  if (!Array.isArray(declared) || declared.length === 0) throw new Error('RUNTIME_ROOTS_INVALID');
  const normalized = declared.map((root) => assertContainedRelativePath(root, 'runtime root'));
  const outside = normalized.find((root) => !ALLOWLISTED_ROOTS.has(root));
  if (outside) throw new Error(`RUNTIME_ROOT_NOT_ALLOWLISTED:${outside}`);
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) throw new Error('RUNTIME_ROOTS_DUPLICATE');
  return [...unique].sort(compareCodeUnits);
}

/** Returns the declared root a relative path belongs to, or null when unowned. */
function owningRoot(relPath, roots) {
  return roots.find((root) => relPath === root || relPath.startsWith(`${root}/`)) ?? null;
}

function safeRelative(root, file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) throw new Error('RUNTIME_PATH_INVALID');
  return assertContainedRelativePath(rel, 'runtime path');
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`RUNTIME_SYMLINK_DENIED:${entry.name}`);
    const full = path.join(dir, entry.name); // nosemgrep: path-join-resolve-traversal -- readdir entry names cannot contain a separator; the parent dir is already contained
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(full, out);
    } else if (entry.isFile()) {
      if (out.length >= MAX_RUNTIME_SCAN_FILES) throw new Error('RUNTIME_SCAN_LIMIT_EXCEEDED');
      out.push(full);
    }
  }
}

/** Mode class, not raw mode bits: umask differs per machine, the exec bit is the contract. */
function modeClass(stat) {
  return (stat.mode & 0o111) === 0 ? 'regular' : 'exec';
}

export function assertPortableRuntimePaths(entries) {
  const canonicalPath = (entry) => entry.path.normalize('NFC').toLocaleLowerCase('en-US');
  const sortedCanonical = [...entries].sort((a, b) => compareCodeUnits(canonicalPath(a), canonicalPath(b)));
  const duplicate = sortedCanonical.find((entry, i) => i && canonicalPath(sortedCanonical[i - 1]) === canonicalPath(entry));
  if (duplicate) throw new Error(`RUNTIME_PATH_COLLISION:${duplicate.path}`);
  const namespaces = new Set();
  for (const entry of entries) {
    const parts = canonicalPath(entry).split('/');
    for (let i = 1; i < parts.length; i++) namespaces.add(parts.slice(0, i).join('/'));
  }
  if (entries.some((entry) => namespaces.has(canonicalPath(entry)))) throw new Error('RUNTIME_PATH_NAMESPACE_COLLISION');
}

function assertSizeBounds(entries) {
  if (entries.length > MAX_RUNTIME_FILES) throw new Error('RUNTIME_FILE_COUNT_EXCEEDED');
  let total = 0;
  for (const entry of entries) {
    if (entry.bytes > MAX_RUNTIME_FILE_BYTES) throw new Error(`RUNTIME_FILE_TOO_LARGE:${entry.path}`);
    total += entry.bytes;
    if (total > MAX_RUNTIME_TOTAL_BYTES) throw new Error('RUNTIME_TOTAL_BYTES_EXCEEDED');
  }
  return total;
}

function assertAllowlistedPath(relPath, roots, label) {
  const canonical = assertContainedRelativePath(relPath, label);
  if (canonical.length > MAX_RUNTIME_PATH_LENGTH) throw new Error(`RUNTIME_PATH_TOO_LONG:${canonical}`);
  if (!owningRoot(canonical, roots)) throw new Error(`RUNTIME_PATH_NOT_ALLOWLISTED:${canonical}`);
  return canonical;
}

/**
 * The single classification gate for an allowlisted runtime root. Every way a root
 * can fail to be a plain directory — absent, dangling symlink, live symlink,
 * regular file, unreadable, or any of those on an intermediate segment — is
 * decided here, in one place, walking every segment with `lstat`.
 *
 * This exists as one function because it was twice written as an ad-hoc
 * `existsSync` + `statSync` sequence, and twice leaked a corrupt root through as
 * "absent": first a regular file, then a dangling symlink (`existsSync` follows
 * links, so a broken one reads as missing). The third instance of a class is a
 * signal to delete the class.
 *
 * @returns {{ present: boolean }} — present:false means genuinely absent. Anything
 *   that exists but is not a traversable directory throws.
 */
function resolveRootState(root, relRoot) {
  const parts = relRoot.split('/');
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]); // nosemgrep: path-join-resolve-traversal -- each segment comes from an allowlisted root already validated by assertContainedRelativePath
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (err) {
      if (err?.code === 'ENOENT') return { present: false };
      throw new Error(`RUNTIME_ROOT_UNREADABLE:${relRoot}`);
    }
    // lstat, so this catches a dangling symlink as readily as a live one.
    if (stat.isSymbolicLink()) throw new Error(`RUNTIME_SYMLINK_DENIED:${relRoot}`);
    if (!stat.isDirectory()) {
      const at = parts.slice(0, index + 1).join('/');
      throw new Error(`RUNTIME_ROOT_NOT_DIRECTORY:${at}`);
    }
  }
  return { present: true };
}

/**
 * Resolve the git directory for `root`. In a linked worktree `.git` is a *file*
 * containing `gitdir: <path>`, not a directory — the case that made provenance
 * silently null in exactly the environment this repo develops in.
 */
function resolveGitDir(root) {
  const dotGit = path.join(root, '.git'); // nosemgrep: path-join-resolve-traversal -- root is a resolved project root; ".git" is a literal
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  const pointer = fs.readFileSync(dotGit, 'utf8').trim();
  if (!pointer.startsWith('gitdir:')) return null;
  const target = pointer.slice('gitdir:'.length).trim();
  if (!target) return null;
  return path.isAbsolute(target) ? target : path.resolve(root, target); // nosemgrep: path-join-resolve-traversal -- a linked worktree gitdir legitimately points outside the project root; read-only, best-effort, and the only value it can yield is a hex revision
}

/**
 * Best-effort provenance. It is not hashed, so an unavailable revision must never
 * fail manifest construction — but it reports *why* it is unavailable rather than
 * returning a bare null, so "no revision" is never mistaken for "not a repo".
 *
 * @returns {{ revision: string|null, revision_source: string }}
 */
function resolveSourceRevision(root) {
  let gitDir;
  try {
    gitDir = resolveGitDir(root);
  } catch {
    return { revision: null, revision_source: 'no_git_dir' };
  }
  if (!gitDir) return { revision: null, revision_source: 'no_git_dir' };

  let head;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); // nosemgrep: path-join-resolve-traversal -- gitDir is resolved from the gitdir pointer above; "HEAD" is a literal
  } catch {
    return { revision: null, revision_source: 'head_unreadable' };
  }
  if (!head.startsWith('ref:')) {
    return GIT_REVISION_RE.test(head)
      ? { revision: head, revision_source: 'detached_head' }
      : { revision: null, revision_source: 'head_unparsable' };
  }

  const ref = head.slice(4).trim();
  if (!/^refs\/[A-Za-z0-9._\-/]+$/.test(ref) || ref.includes('..')) {
    return { revision: null, revision_source: 'head_unparsable' };
  }
  // `commondir` points at the shared git dir. A linked worktree keeps HEAD locally
  // but its branch refs and packed-refs live in the common dir, so both must be tried.
  const commonDir = (() => {
    try {
      const value = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim(); // nosemgrep: path-join-resolve-traversal -- gitDir resolved above; "commondir" is a literal
      return value ? path.resolve(gitDir, value) : gitDir; // nosemgrep: path-join-resolve-traversal -- git commondir legitimately points outside the project root; read-only provenance
    } catch {
      return gitDir;
    }
  })();

  for (const dir of new Set([gitDir, commonDir])) {
    try {
      const loose = fs.readFileSync(path.join(dir, ref), 'utf8').trim(); // nosemgrep: path-join-resolve-traversal -- ref is regex-validated as refs/<safe chars> with ".." rejected
      if (GIT_REVISION_RE.test(loose)) return { revision: loose, revision_source: 'loose_ref' };
    } catch {
      // Fall through — a freshly cloned or gc'd repo has no loose ref.
    }
  }
  try {
    const packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const match = /^([a-f0-9]{40,64})\s+(.+)$/.exec(line.trim());
      if (match && match[2] === ref && GIT_REVISION_RE.test(match[1])) {
        return { revision: match[1], revision_source: 'packed_ref' };
      }
    }
  } catch {
    // No packed-refs either.
  }
  return { revision: null, revision_source: 'ref_unresolved' };
}

/**
 * Build a deterministic, non-secret inventory for second-machine parity.
 *
 * @param {string} projectRoot
 * @param {{ roots?: string[], generatedAt?: string, revision?: string|null }} [options]
 */
export function buildRuntimeManifest(projectRoot, options = {}) {
  const root = path.resolve(projectRoot); // nosemgrep: path-join-resolve-traversal -- projectRoot is the operator-declared local project root
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('RUNTIME_SYMLINK_DENIED:project_root');
  const roots = normalizeRoots(options.roots);
  const guard = createSecretGuard(root, { honorGitignore: false, honorGitignoreNegations: false });

  const files = [];
  const presentRoots = new Set();
  for (const relRoot of roots) {
    // One gate decides absent vs corrupt. A root that exists but is not a plain
    // directory is a broken checkout, never a missing one — reporting it "absent"
    // would hide corruption behind a plausible-looking parity result.
    if (!resolveRootState(root, relRoot).present) continue;
    presentRoots.add(relRoot);
    walk(path.join(root, relRoot), files); // nosemgrep: path-join-resolve-traversal -- relRoot comes from normalizeRoots, which rejects absolute and traversal paths
  }

  const entries = files
    .map((file) => {
      if (EPHEMERAL_FILE.test(path.basename(file))) return null;
      if (guard.shouldSkip(file)) return null;
      const rel = assertAllowlistedPath(safeRelative(root, file), roots, 'runtime path');
      const stat = fs.statSync(file);
      return { path: rel, type: 'file', mode: modeClass(stat), sha256: digest(fs.readFileSync(file)), bytes: stat.size };
    })
    .filter(Boolean)
    .sort((a, b) => compareCodeUnits(a.path, b.path));

  assertPortableRuntimePaths(entries);
  const totalBytes = assertSizeBounds(entries);

  const countByRoot = new Map(roots.map((relRoot) => [relRoot, 0]));
  for (const entry of entries) {
    const owner = owningRoot(entry.path, roots);
    countByRoot.set(owner, countByRoot.get(owner) + 1);
  }
  const rootInventory = roots.map((relRoot) => ({
    path: relRoot,
    present: presentRoots.has(relRoot),
    file_count: countByRoot.get(relRoot),
  }));

  const manifest = {
    version: RUNTIME_MANIFEST_VERSION,
    roots: rootInventory,
    files: entries,
    file_count: entries.length,
    total_bytes: totalBytes,
  };
  const provenance = options.revision !== undefined
    ? { revision: options.revision, revision_source: 'declared' }
    : resolveSourceRevision(root);
  const source = {
    revision: provenance.revision,
    revision_source: provenance.revision_source,
    generated_at: options.generatedAt ?? new Date().toISOString(),
  };
  // The builder is held to the verifier's own predicate, not a parallel set of
  // rules. Without this an override like `{ revision: 'HEAD' }` produces a manifest
  // that this module's own verifier is guaranteed to reject — the second time a
  // builder/verifier divergence appeared in this contract, after `options.roots`.
  if (!isValidSource(source)) throw new Error('RUNTIME_SOURCE_INVALID');
  return {
    ...manifest,
    sha256: computeRuntimeManifestHash(manifest),
    source,
  };
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * The canonical form of a declared manifest's parity payload: every path spelled
 * canonically, every array in canonical order. A declared manifest must already
 * equal this — the builder emits it, and the hash depends on it byte for byte.
 * Callers compare rather than substitute: silently canonicalizing an incoming
 * manifest would change the document the hash was computed over.
 */
/**
 * The `source` block. Required: the builder always emits it, and a manifest with
 * no provenance at all is one whose origin cannot be stated. `revision` is nullable
 * because provenance is genuinely unavailable outside a git checkout — but
 * `revision_source` must then say which of those cases it was.
 */
function isValidSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  if (!hasOnlyKeys(source, SOURCE_KEYS)) return false;
  if (!VALID_REVISION_SOURCES.has(source.revision_source)) return false;
  if (typeof source.generated_at !== 'string' || !ISO_INSTANT_RE.test(source.generated_at)) return false;
  if (source.revision === null) return true;
  return typeof source.revision === 'string' && GIT_REVISION_RE.test(source.revision);
}

function canonicalDeclaredPayload(expected) {
  const canonicalPath = (value, label) => assertContainedRelativePath(value, label);
  return {
    version: expected.version,
    roots: expected.roots
      .map((root) => ({ path: canonicalPath(root.path, 'runtime root'), present: root.present, file_count: root.file_count }))
      .sort((a, b) => compareCodeUnits(a.path, b.path)),
    files: expected.files
      .map((file) => ({
        path: canonicalPath(file.path, 'declared runtime path'),
        type: file.type,
        mode: file.mode,
        sha256: file.sha256,
        bytes: file.bytes,
      }))
      .sort((a, b) => compareCodeUnits(a.path, b.path)),
    file_count: expected.file_count,
    total_bytes: expected.total_bytes,
  };
}

/**
 * Recognize the `/1` manifest shape that shipped in 0.8.31: a `files` array with
 * no root inventory, whose entries carry neither `type` nor `mode`. `/2` is not
 * backward compatible with it, so name it rather than reporting generic tampering.
 */
function isLegacyManifestShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.version !== LEGACY_MANIFEST_VERSION) return false;
  if (!Array.isArray(value.files) || value.roots !== undefined) return false;
  return value.files.every((file) => file && typeof file === 'object' && file.type === undefined && file.mode === undefined);
}

/**
 * Structural validation of an untrusted declared manifest. Fail-closed: anything
 * unrecognized, out of bounds, or outside the allowlisted roots is rejected
 * before a single byte of the local tree is read.
 *
 * @returns {{ roots: string[] }|null} null means "reject".
 */
function validateDeclaredManifest(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return null;
  if (!hasOnlyKeys(expected, MANIFEST_KEYS)) return null;
  if (expected.version !== RUNTIME_MANIFEST_VERSION) return null;
  if (typeof expected.sha256 !== 'string' || !HEX_256_RE.test(expected.sha256)) return null;
  if (!Array.isArray(expected.roots) || expected.roots.length === 0) return null;
  if (!Array.isArray(expected.files)) return null;
  // Bounds first: never do O(n) work — let alone read the local tree — against an
  // unbounded declaration.
  if (expected.files.length > MAX_RUNTIME_FILES) return null;
  if (!Number.isSafeInteger(expected.file_count) || expected.file_count !== expected.files.length) return null;
  if (!Number.isSafeInteger(expected.total_bytes) || expected.total_bytes < 0 || expected.total_bytes > MAX_RUNTIME_TOTAL_BYTES) return null;
  // `source` is unhashed provenance, which is exactly why it needs validating here:
  // nothing downstream would catch junk in it. Being outside the parity payload
  // makes it lower stakes, not unchecked.
  if (!isValidSource(expected.source)) return null;

  let roots;
  try {
    for (const root of expected.roots) {
      if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
      if (!hasOnlyKeys(root, ROOT_KEYS)) return null;
      if (typeof root.present !== 'boolean') return null;
      if (!Number.isSafeInteger(root.file_count) || root.file_count < 0) return null;
    }
    roots = normalizeRoots(expected.roots.map((root) => root.path));
  } catch {
    return null;
  }

  const declaredCountByRoot = new Map(roots.map((root) => [root, 0]));
  let total = 0;
  for (const file of expected.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
    if (!hasOnlyKeys(file, ENTRY_KEYS)) return null;
    if (!VALID_ENTRY_TYPES.has(file.type)) return null;
    if (!VALID_MODE_CLASSES.has(file.mode)) return null;
    if (typeof file.sha256 !== 'string' || !HEX_256_RE.test(file.sha256)) return null;
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_RUNTIME_FILE_BYTES) return null;
    total += file.bytes;
    if (total > MAX_RUNTIME_TOTAL_BYTES) return null;
    let owner;
    try {
      owner = owningRoot(assertAllowlistedPath(file.path, roots, 'declared runtime path'), roots);
    } catch {
      return null;
    }
    declaredCountByRoot.set(owner, declaredCountByRoot.get(owner) + 1);
  }
  if (total !== expected.total_bytes) return null;

  // A manifest whose root inventory contradicts its own file list is invalid, not
  // merely divergent — reject it here rather than letting the verifier report a
  // parity "mismatch" for a document that was never internally consistent.
  for (const root of expected.roots) {
    const canonical = assertContainedRelativePath(root.path, 'runtime root');
    if (root.file_count !== declaredCountByRoot.get(canonical)) return null;
    if (!root.present && declaredCountByRoot.get(canonical) > 0) return null;
  }

  try {
    assertPortableRuntimePaths(expected.files);
  } catch {
    return null;
  }

  // ONE canonical-form check, not a checklist of canonicality rules.
  //
  // Everything the hash is sensitive to must be declared in exactly the form the
  // builder emits: array order, and every path's spelling (`./brain`, `brain/`,
  // and `brain` are the same location but not the same bytes). Checking those
  // rules one at a time produced a defect per rule — mis-ordered arrays, then
  // non-canonical root spellings — each accepted by the validator and then
  // guaranteed to fail verification. Comparing the declared payload against its
  // own canonical form catches every member of that class at once, including the
  // ones not yet found.
  let recomputed;
  try {
    const declaredPayload = canonicalJsonString(parityPayload(expected));
    if (declaredPayload !== canonicalJsonString(canonicalDeclaredPayload(expected))) return null;
    recomputed = digest(declaredPayload);
  } catch {
    return null;
  }
  if (recomputed !== expected.sha256) return null;

  return { roots };
}

/**
 * Compare the local tree against a declared manifest.
 *
 * @returns {{ state: 'green'|'missing'|'mismatch'|'unknown', ... }}
 */
export function verifyRuntimeManifest(projectRoot, expected) {
  // A `/1` manifest from 0.8.31 is genuinely unverifiable here, but say so
  // specifically — a generic `invalid_manifest` sends an operator hunting for
  // tampering that never happened.
  if (isLegacyManifestShape(expected)) return { state: 'unknown', reason: 'legacy_manifest_shape' };

  const declared = validateDeclaredManifest(expected);
  if (!declared) return { state: 'unknown', reason: 'invalid_manifest' };

  let actual;
  try {
    // Verify against the roots the manifest itself declares, so a target cannot
    // pass by inventorying a different surface than the source did.
    actual = buildRuntimeManifest(projectRoot, { roots: declared.roots });
  } catch (err) {
    return { state: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
  if (actual.sha256 === expected.sha256) return { state: 'green', manifest: actual };

  const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));
  const missing = expected.files.filter((file) => !actualByPath.has(file.path)).map((file) => file.path);
  const mismatch = actual.files
    .filter((file) => {
      const declaredFile = expectedByPath.get(file.path);
      return declaredFile != null && (declaredFile.sha256 !== file.sha256 || declaredFile.mode !== file.mode);
    })
    .map((file) => file.path);
  const unexpected = actual.files.filter((file) => !expectedByPath.has(file.path)).map((file) => file.path);

  // Root-inventory divergence is a real parity failure with no per-file evidence:
  // a source that declares a root the target lacks differs in hash while every
  // file agrees. Without this, the verifier reports a difference it cannot explain.
  const actualRootByPath = new Map(actual.roots.map((root) => [root.path, root]));
  const roots_diverged = expected.roots
    .map((declaredRoot) => {
      const actualRoot = actualRootByPath.get(declaredRoot.path);
      if (actualRoot && actualRoot.present === declaredRoot.present && actualRoot.file_count === declaredRoot.file_count) return null;
      return {
        path: declaredRoot.path,
        expected: { present: declaredRoot.present, file_count: declaredRoot.file_count },
        actual: actualRoot ? { present: actualRoot.present, file_count: actualRoot.file_count } : null,
      };
    })
    .filter(Boolean);

  const result = {
    state: missing.length ? 'missing' : 'mismatch',
    missing,
    mismatch,
    unexpected,
    roots_diverged,
    manifest: actual,
  };
  if (!missing.length && !mismatch.length && !unexpected.length && !roots_diverged.length) {
    // Fail loudly rather than hand an operator a non-green status with nothing to
    // act on. Reaching here means the hash covers something this diff does not.
    return { state: 'unknown', reason: 'parity_difference_unexplained', manifest: actual };
  }
  return result;
}
