/**
 * The single shared path-containment helper (PRD-0047 §7 clause 9, Task 2.1a).
 *
 * It lives here — rather than inside any one contract module — because more than
 * one contract now depends on it (bundle manifests, `brain-runtime-manifest/2`),
 * and PRD-0047 forbids a second, command-local path validator. Two validators of
 * one contract drift at every edge; there must be exactly one.
 *
 * This module has no dependencies beyond `node:path` on purpose, so importing the
 * containment gate never drags a contract module's heavier dependency graph into
 * a daemon or CLI path.
 */

import path from 'path';

/**
 * Every manifest/lock source, install target, mutation path, state-file path,
 * backup path, and generated output path resolves through this before any read
 * or write.
 *
 * Rejects absolute paths (POSIX and Windows-drive), NUL bytes, and `..` traversal
 * before normalization. Returns the normalized repo-relative path (leading `./`
 * stripped, backslashes folded to `/`). Never resolves against the filesystem —
 * this is the pure lexical gate; writers still revalidate the resolved path
 * against a verified parent immediately before rename.
 */
export function assertContainedRelativePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  // Messages keep the "repo-relative path" contract that human-readable semgrep
  // suppressions and existing tests rest on, while naming the specific reason.
  if (value.includes('\0')) {
    throw new Error(`${label} must be a repo-relative path (NUL byte rejected): ${JSON.stringify(value)}`);
  }
  const normalized = value.replace(/\\/g, '/');
  // POSIX-absolute, or Windows drive-absolute (C:/...), or UNC (//host/...).
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    throw new Error(`${label} must be a repo-relative path (absolute rejected): ${value}`);
  }
  const stripped = normalized.replace(/^\.\/+/, '');
  if (
    stripped === '..' ||
    stripped.startsWith('../') ||
    stripped.includes('/../') ||
    stripped.endsWith('/..')
  ) {
    throw new Error(`${label} must be a repo-relative path (traversal rejected): ${value}`);
  }
  // `path.posix.normalize` preserves a trailing slash, but writers resolve
  // `a/file` and `a/file/` to the same destination. Canonicalize before the
  // Set-based ownership and conflict checks that consume this helper.
  const canonical = path.posix.normalize(stripped).replace(/\/+$/, '');
  if (!canonical || canonical === '.') {
    throw new Error(`${label} must be a repo-relative path (empty rejected): ${value}`);
  }
  return canonical;
}
