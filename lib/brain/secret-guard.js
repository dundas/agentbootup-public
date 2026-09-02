/**
 * secret-guard — filters out sensitive files before brain pushes.
 *
 * Usage:
 *   const guard = createSecretGuard('/path/to/project');
 *   if (guard.shouldSkip('/path/to/project/.env')) { ... }
 *
 * No external dependencies — uses only Node.js built-ins (fs, path).
 */

import fs from 'fs';
import path from 'path';

// ── Hardcoded block patterns ───────────────────────────────────────────────────
// Matched against both the basename AND the full relative path (POSIX separators).

const STRICT_BLOCK_PATTERNS = [
  // Environment / config files
  '*.env',
  '.env.*',
  '*.env.local',
  '*.env.production',
  'brain/config.secret.json',
  // Private keys and certificates
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.crt',
  '*.cert',
  // Well-known key files
  'id_rsa',
  'id_ed25519',
  // Package manager auth / netrc
  '.npmrc',
  '.netrc',
  // Docker credentials
  '.docker/config.json',
  // AgentHost host/device credentials are local-only. They have no portable
  // brain-asset pathway and cannot be re-allowed by .gitignore negation.
  '.agenthost/**',
  '.agent-host/**',
  'brain/.agenthost/**',
  'brain/.agent-host/**',
  'agenthost-host-*key*',
  'agenthost-device-*key*',
  'agenthost-transport-*credential*',
];

const OVERRIDABLE_BLOCK_PATTERNS = [
  // Generic secret/credential names (matched as extensions/suffixes to avoid
  // blocking legitimate skill files like 'token-counter.md' or 'secrets-manager-usage.md')
  '*secret*',
  '*credential*',
  '*password*',
  '*.token',
];

// ── Minimal glob matching ─────────────────────────────────────────────────────

/**
 * Convert a gitignore-style glob pattern into a RegExp.
 *
 * Supported syntax:
 *   - `*`  → matches any character sequence within a single path segment
 *   - `**` → matches any sequence of path segments (zero or more)
 *   - `?`  → matches exactly one character within a path segment
 *   - All other regex-special characters are escaped
 *
 * If the pattern contains a `/` (after removing a leading `/`), the match is
 * anchored to the relative-path root.  Otherwise the pattern is matched against
 * any trailing segment (like a typical gitignore basename match).
 *
 * @param {string} pattern — a single gitignore pattern (already stripped of
 *   leading/trailing whitespace and `!` negation prefix)
 * @returns {RegExp}
 */
function patternToRegex(pattern) {
  // Trailing `/` means "directory only" — drop it for simplicity (we treat
  // files and directories the same in this guard).
  pattern = pattern.replace(/\/$/, '');

  // Leading `/` means "anchored to repo root" — consume it.
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);

  // Determine whether the pattern is path-aware (contains `/`).
  // After removing the leading `/`, a remaining `/` means the pattern must
  // match a specific sub-path, not just a basename.
  const pathAware = pattern.includes('/');

  // Escape regex special chars except `*` and `?` which we handle ourselves.
  let reStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars
    .replace(/\*\*/g, '\u0000')            // temporarily replace ** with sentinel
    .replace(/\*/g, '[^/]*')              // * → match within segment
    .replace(/\?/g, '[^/]')              // ? → single char within segment
    .replace(/\u0000/g, '.*');             // ** → match across segments

  if (pathAware || anchored) {
    // Anchor to start — match from the beginning of the relative path.
    reStr = '^' + reStr + '(/.*)?$';
  } else {
    // No slash — match against any segment or the full relative path.
    reStr = '(^|/)' + reStr + '(/.*)?$';
  }

  return new RegExp(reStr, 'i'); // nosemgrep: detect-non-literal-regexp — intentional: converts gitignore glob patterns to RegExp
}

/**
 * Parse `.gitignore` content into a list of `{ regex, negated }` rules.
 *
 * @param {string} content
 * @returns {Array<{ regex: RegExp, negated: boolean }>}
 */
function parseGitignore(content) {
  const rules = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    // Skip blanks and comments.
    if (!line || line.startsWith('#')) continue;

    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    if (!pattern) continue;

    try {
      rules.push({ regex: patternToRegex(pattern), negated });
    } catch {
      // Ignore un-parseable patterns — safety-first, skip the pattern.
    }
  }
  return rules;
}

// Pre-compile BLOCK_PATTERNS regexes once at module load — shouldSkip() is
// called for every file on every daemon sync cycle, so avoiding repeated
// RegExp construction saves meaningful work at scale.
const STRICT_BLOCK_REGEXES = STRICT_BLOCK_PATTERNS.map(patternToRegex);
const OVERRIDABLE_BLOCK_REGEXES = OVERRIDABLE_BLOCK_PATTERNS.map(patternToRegex);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a secret guard scoped to `projectRoot`.
 *
 * @param {string} projectRoot — absolute path to the project root
 * @param {{
 *   honorGitignore?: boolean,
 *   honorGitignoreNegations?: boolean,
 *   warn?: boolean,
 * }} [options]
 * @returns {{ shouldSkip(absoluteFilePath: string): boolean }}
 */
export function createSecretGuard(projectRoot, options = {}) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `projectRoot` defines the guard boundary; every candidate is checked against this resolved root below.
  const resolvedRoot = path.resolve(projectRoot);
  const honorGitignore = options.honorGitignore !== false;
  const honorGitignoreNegations = options.honorGitignoreNegations === true || honorGitignore;
  const warn = options.warn !== false;

  // Parse .gitignore once at construction time (sync read is intentional —
  // this is called during initialisation, not in a hot path).
  let gitignoreRules = [];
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- fixed filename under the resolved, trusted project root.
  const gitignorePath = path.join(resolvedRoot, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    gitignoreRules = parseGitignore(content);
  } catch {
    // No .gitignore or unreadable — proceed without gitignore rules.
  }

  /**
   * Returns `true` when the file should be excluded from a brain push.
   *
   * Evaluation order:
   *   1. Path-escape safety check (always runs first).
   *   2. .gitignore rules (last match wins).  A terminal negation rule (`!pat`)
   *      is treated as an explicit whitelist and bypasses block patterns — this
   *      is the escape hatch described in the block-pattern warning message.
   *   3. Hardcoded block patterns (BLOCK_REGEXES).
   *   4. Positive .gitignore ignore rules.
   *
   * @param {string} absoluteFilePath
   * @returns {boolean}
   */
  function shouldSkip(absoluteFilePath) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- untrusted candidates are resolved solely to test and reject root escape before any file operation.
    const resolved = path.resolve(absoluteFilePath);

    // 1. Safety: reject files that escape the project root.
    const rootPrefix = resolvedRoot + path.sep;
    if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix)) {
      return true;
    }

    const basename = path.basename(resolved);

    // Relative path from project root, POSIX separators.
    const relPosix = resolved
      .slice(resolvedRoot.length)
      .replace(/\\/g, '/')
      .replace(/^\//, ''); // strip leading slash

    for (const regex of STRICT_BLOCK_REGEXES) {
      if (regex.test(basename) || regex.test(relPosix)) {
        if (warn) {
          console.warn(
            `[secret-guard] skipping ${relPosix} — matches a hardcoded block pattern.` +
            ' This secret-bearing file cannot be re-allowed via .gitignore negation.',
          );
        }
        return true;
      }
    }

    let gitignoreIgnored = false;
    let gitignoreNegated = false;
    if (honorGitignore || honorGitignoreNegations) {
      // 2. Walk .gitignore rules first (last match wins, gitignore semantics).
      //    A terminal negation (`!pattern`) is an explicit whitelist for
      //    overridable patterns — strict secret files still return above.
      for (const rule of gitignoreRules) {
        if (rule.regex.test(relPosix)) {
          gitignoreIgnored = !rule.negated;
          gitignoreNegated = rule.negated;
        }
      }
      if (honorGitignoreNegations && gitignoreNegated) return false;
    }

    // 3. Check remaining hardcoded block patterns against basename AND full relative path.
    //    Directory-scoped patterns like '.docker/config.json' need the full path.
    //    NOTE: broad substring patterns like '*secret*' will match filenames that
    //    contain the word "secret" (e.g. secrets-manager-usage.md). A warning is
    //    logged so users can diagnose unexpectedly missing assets.
    for (const regex of OVERRIDABLE_BLOCK_REGEXES) {
      if (regex.test(basename) || regex.test(relPosix)) {
        if (warn) {
          console.warn(
            `[secret-guard] skipping ${relPosix} — matches a hardcoded block pattern.` +
            ' If this file is safe to sync, add a ! negation rule to .gitignore.',
          );
        }
        return true;
      }
    }

    // 4. Honour positive .gitignore ignore rules.
    if (honorGitignore && gitignoreIgnored) return true;

    return false;
  }

  return { shouldSkip };
}

// ── Allowlist (PRD-0030 FR-2) ─────────────────────────────────────────────────

/**
 * Allowed file extensions for brain push (primary allowlist filter).
 * Applied BEFORE the secret-guard denylist — fail-closed for remote upload.
 *
 * The `references/` escape hatch lets skill authors include non-standard
 * file types inside a directory segment named exactly "references".
 */
const ALLOWED_EXTENSIONS = new Set(['.md', '.ts', '.js', '.json', '.txt', '.sql']);

/**
 * Returns true when a file is eligible for brain push based on its extension
 * or location inside a `references/` directory segment.
 *
 * Rules:
 *  - Extension in ALLOWED_EXTENSIONS → allowed
 *  - File inside a path segment named exactly "references" → allowed (escape hatch)
 *  - Anything else → denied
 *
 * The secret-guard denylist is applied AFTER this check; a file that passes
 * the allowlist can still be blocked by the denylist (e.g. a .ts file named
 * *secret* or a file inside references/ matching a STRICT_BLOCK_PATTERN).
 *
 * @param {string} absoluteFilePath
 * @returns {boolean}
 */
export function isAllowedExtension(absoluteFilePath) {
  const ext = path.extname(absoluteFilePath).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext)) return true;

  // Escape hatch: file inside a path segment named exactly "references"
  const parts = absoluteFilePath.split(path.sep);
  return parts.includes('references');
}
