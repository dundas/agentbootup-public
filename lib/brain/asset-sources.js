/**
 * Brain asset source definitions.
 *
 * Each entry describes one CLI / asset-type pair that the brain-asset-sync
 * daemon should watch and push to the agentbootup server.
 *
 * Usage:
 *   import { getBrainAssetSources } from '../brain/asset-sources.js';
 *   const sources = getBrainAssetSources('/path/to/project');
 */

import path from 'path';

// Shared bundle rollout intentionally excludes mutable memory. Memory moves via
// memory_snapshot materialization, while promotable shared assets remain
// skill/protocol/runtime/config surfaces.
export const PROMOTABLE_BUNDLE_ASSET_TYPES = new Set([
  'skill',
  'agent',
  'command',
  'protocol',
  'config',
  'script',
  'runtime',
]);

/**
 * The exact root-level config filenames that count as "config" brain assets.
 * Only these three files are collected from the project root — everything else
 * at the top level is ignored.
 */
export const PORTABLE_POLICY_FILENAMES = new Set([
  'brain-backup.json',
  '.brainignore',
]);

const CONFIG_FILENAMES = new Set([
  'CLAUDE.md',
  'GEMINI.md',
  'AGENTS.md',
  ...PORTABLE_POLICY_FILENAMES,
]);

/**
 * Returns true when the absolute filePath is inside a directory named exactly
 * "references" (one path segment, not a substring match).
 *
 * Examples:
 *   .claude/skills/foo/references/guide.md  → true
 *   .claude/skills/foo/my-references-backup/secret.pem → false
 */
function insideReferencesSegment(filePath) {
  const parts = filePath.split(path.sep);
  return parts.includes('references');
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', 'coverage', 'vendor', '.worktrees']);

/**
 * Directory names the asset walker must prune without descending. Shared with
 * brain-asset-sync's walkDir so the walk-time prune and the match-time filter
 * can never drift apart: a directory skipped by match() is also never walked.
 */
export const WALK_SKIP_DIRS = SKIP_DIRS;

/**
 * Returns true when the absolute filePath should be excluded from brain push
 * because it is inside a well-known large/non-asset directory.
 */
function inSkipDir(filePath) {
  return filePath.split(path.sep).some((seg) => SKIP_DIRS.has(seg));
}

/**
 * The common match predicate for skill directories (supported roots only).
 *
 * Matches all files under the skill directory that are not inside a skip directory.
 * The two-layer filter (allowlist + secret-guard) is applied later in discoverAssets.
 *
 * PRD-0030 FR-1: sync the full portable skill surface, not just SKILL.md/reference.md.
 *
 * Runtime layout (PRD-0040 FR-2):
 *   scripts/<name>.ts     — top-level only; live Channel-B sync (asset_type: script)
 *   scripts/lib/**        — install-time helpers (seed copies recursively); NOT live-synced
 *   brain/scripts/<name>.ts — bundle/skill-manifest install targets; synced via runtime source
 */
function skillMatch(filePath) {
  return !inSkipDir(filePath);
}

/**
 * PRD-0040 FR-1: brain/ runtime substrate (not config.json / config.secret.json).
 *
 * @param {string} filePath  Absolute path
 * @param {string} root      Project root (absolute)
 */
export function brainRuntimeMatch(filePath, root) {
  if (inSkipDir(filePath)) return false;
  const brainRoot = path.join(root, 'brain'); // nosemgrep: path-join-resolve-traversal
  if (!filePath.startsWith(brainRoot + path.sep)) return false;

  const rel = path.relative(brainRoot, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;

  const base = path.basename(filePath);
  if (base === 'config.json' || base === 'config.secret.json') return false;

  if (rel === 'brain-msg.ts' || rel === 'brain-schema.sql') return true;

  const parts = rel.split(path.sep);
  const isRuntimeScript =
    /\.(ts|js)$/.test(base) && !/\.(test|spec)\.(ts|js)$/.test(base) && !base.endsWith('.d.ts');

  if (parts[0] === 'lib') return isRuntimeScript;
  if (parts[0] === 'scripts') return isRuntimeScript;

  // Role runtime substrate (WO msg-1784741816564-q66m6g): role-engine, roles,
  // personas carry the role runtime — resolve.ts, *.class.json, SYSTEM.md,
  // SPEC.md. Extension allowlist is extended to .json and .md for these dirs
  // (the role runtime is not just code — it includes role descriptors and
  // persona system prompts). Test/spec/d.ts files remain excluded everywhere.
  // config.json / config.secret.json are already rejected above by basename.
  if (parts[0] === 'role-engine' || parts[0] === 'roles' || parts[0] === 'personas') {
    // Test/spec exclusion is extension-agnostic here (roborev): these dirs allow
    // .json and .md, so *.spec.json and *.test.md must also be rejected — the
    // .ts/.js-only regex used for lib/scripts would leak test files in the new
    // dirs. Match .test. or .spec. as a name segment regardless of extension.
    return /\.(ts|js|json|md)$/.test(base)
      && !/\.(test|spec)\./.test(base)
      && !base.endsWith('.d.ts');
  }

  return false;
}

/**
 * Return the full list of brain asset source definitions scoped to the given
 * project root.
 *
 * Each entry carries:
 *   cli            — which AI CLI owns this asset ('claude'|'gemini'|'codex'|'cursor'|'shared')
 *   asset_type     — semantic category ('skill'|'agent'|'command'|'memory'|'protocol'|'config'|'script')
 *   rootFn         — zero-argument function that returns the absolute watch-root path
 *   match          — predicate: returns true when an absolute file path is a brain asset
 *   watchRecursive — (optional, default true) whether fs.watch should use recursive: true.
 *                    Set to false for sources whose rootFn() returns a broad directory (e.g. the
 *                    project root) to avoid watching node_modules and other non-asset trees.
 *   walkDepth      — (optional) maximum directory depth the sync walker may descend below
 *                    rootFn(). Set to 0 for sources whose match() only ever accepts files
 *                    directly inside the root, so broad roots (e.g. the project root) are
 *                    never traversed recursively on every sync cycle.
 *
 * @param {string} projectRoot  Absolute path to the project directory.
 * @returns {Array<{
 *   cli: string,
 *   asset_type: string,
 *   rootFn: () => string,
 *   match: (filePath: string) => boolean,
 *   watchRecursive?: boolean,
 * }>}
 */
export function getBrainAssetSources(projectRoot) {
  const root = path.resolve(projectRoot);

  return [
    // ── Claude ──────────────────────────────────────────────────────────────

    {
      cli: 'claude',
      asset_type: 'skill',
      rootFn: () => path.join(root, '.claude', 'skills'),
      match: skillMatch,
    },

    {
      cli: 'claude',
      asset_type: 'agent',
      rootFn: () => path.join(root, '.claude', 'agents'),
      match: skillMatch,
    },

    {
      cli: 'claude',
      asset_type: 'command',
      rootFn: () => path.join(root, '.claude', 'commands'),
      match: skillMatch,
    },

    // ── Shared ──────────────────────────────────────────────────────────────

    {
      cli: 'shared',
      asset_type: 'memory',
      rootFn: () => path.join(root, 'memory'),
      match: (filePath) =>
        // .json under self-improve/ is deliberately broad (not just skill-usage.json)
        // so future self-improve telemetry artifacts auto-sync without an allowlist update.
        filePath.endsWith('.md') ||
        (filePath.includes(path.sep + 'self-improve' + path.sep) && filePath.endsWith('.json')),
    },

    {
      cli: 'shared',
      asset_type: 'protocol',
      rootFn: () => path.join(root, '.ai', 'protocols'),
      match: (filePath) => filePath.endsWith('.md'),
    },

    {
      cli: 'shared',
      asset_type: 'config',
      // The root-level config files live directly in the project root.
      rootFn: () => root,
      // Non-recursive watch: only watch files directly in the project root.
      watchRecursive: false,
      // match() only accepts direct children of the project root, so walking
      // any deeper (node_modules, .git, vendored trees) is pure wasted work —
      // and on large repos it wedged the initial sync entirely.
      walkDepth: 0,
      match: (filePath) =>
        path.dirname(filePath) === root && CONFIG_FILENAMES.has(path.basename(filePath)),
    },

    {
      cli: 'shared',
      asset_type: 'config',
      // brain/config.json carries agent identity (agent_id, role, capabilities).
      // brain/config.secret.json is NEVER synced — it holds the per-brain ADMP key.
      rootFn: () => path.join(root, 'brain'),
      watchRecursive: false,
      // match() only accepts brain/config.json itself — no recursion needed.
      walkDepth: 0,
      match: (filePath) =>
        path.dirname(filePath) === path.join(root, 'brain') && // nosemgrep: path-join-resolve-traversal
        path.basename(filePath) === 'config.json',
    },

    {
      cli: 'shared',
      asset_type: 'script',
      // Live-synced operator scripts: scripts/<name>.ts only (not scripts/lib/**).
      rootFn: () => path.join(root, 'scripts'),
      // match() only accepts direct children of scripts/ — no recursion needed.
      walkDepth: 0,
      match: (filePath) => {
        // match() always receives absolute paths (walkDirSync/readdirShallow guarantee this).
        const scriptsRoot = path.join(root, 'scripts'); // nosemgrep: path-join-resolve-traversal
        const base = path.basename(filePath);
        return (
          path.dirname(filePath) === scriptsRoot &&
          /\.(ts|js)$/.test(base) &&
          !/\.(test|spec)\.(ts|js)$/.test(base) &&
          !base.endsWith('.d.ts')
        );
      },
    },

    {
      cli: 'shared',
      asset_type: 'runtime',
      // PRD-0040 FR-1: brain-msg.ts, brain-schema.sql, brain/lib/**, brain/scripts/**,
      //   brain/role-engine/**, brain/roles/**, brain/personas/** (WO msg-1784741816564)
      rootFn: () => path.join(root, 'brain'),
      match: (filePath) => brainRuntimeMatch(filePath, root),
    },

    // ── Portable harness-neutral surface (PRD-0040 FR-4) ─────────────────────

    {
      cli: 'shared',
      asset_type: 'skill',
      rootFn: () => path.join(root, '.agents', 'skills'),
      match: skillMatch,
    },

    {
      cli: 'shared',
      asset_type: 'agent',
      rootFn: () => path.join(root, '.agents', 'agents'),
      match: skillMatch,
    },

    {
      cli: 'shared',
      asset_type: 'command',
      rootFn: () => path.join(root, '.agents', 'commands'),
      match: skillMatch,
    },
  ];
}

export { insideReferencesSegment };
