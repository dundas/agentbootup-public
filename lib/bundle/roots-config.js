import fs from 'fs';
import path from 'path';

export const DEFAULT_BUNDLE_ROOT_CONFIG_PATH = '.agentbootup/bundle-roots.json';
export const VALID_BUNDLE_ROOT_KINDS = new Set(['skill', 'repo/runtime']);
export const CANONICAL_SKILL_TARGET_ROOT = '.claude/skills';
export const AGENTS_SKILL_TARGET_ROOT = '.agents/skills';
export const VALID_SKILL_TARGET_ROOTS = new Set([CANONICAL_SKILL_TARGET_ROOT, AGENTS_SKILL_TARGET_ROOT]);
export const DEFAULT_BUNDLE_SOURCE_ROOTS = Object.freeze([
  Object.freeze({
    id: 'claude-skill',
    kind: 'skill',
    source: '.claude/skills',
    target: CANONICAL_SKILL_TARGET_ROOT,
  }),
  Object.freeze({
    id: 'repo-runtime',
    kind: 'repo/runtime',
    source: 'brain/scripts',
    target: 'brain/scripts',
  }),
]);
export const CANONICAL_SKILL_SOURCE_ROOT = DEFAULT_BUNDLE_SOURCE_ROOTS[0].source;
export const CANONICAL_RUNTIME_SOURCE_ROOT = DEFAULT_BUNDLE_SOURCE_ROOTS[1].source;
export const CANONICAL_RUNTIME_TARGET_ROOT = DEFAULT_BUNDLE_SOURCE_ROOTS[1].target;

function normalizeRelativeDir(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty repo-relative path`);
  }
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (
    path.isAbsolute(normalized) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.endsWith('/..')
  ) {
    throw new Error(`${label} must stay within the repo: ${value}`);
  }
  return normalized.replace(/^\.\/+/, '');
}

function normalizeRootEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`bundleSourceRoots.roots[${index}] must be an object`);
  }
  const kind = entry.kind;
  if (!VALID_BUNDLE_ROOT_KINDS.has(kind)) {
    throw new Error(
      `bundleSourceRoots.roots[${index}].kind must be one of: ${[...VALID_BUNDLE_ROOT_KINDS].join(', ')}`,
    );
  }
  const source = normalizeRelativeDir(entry.source, `bundleSourceRoots.roots[${index}].source`);
  const defaultTarget = kind === 'skill' ? CANONICAL_SKILL_TARGET_ROOT : CANONICAL_RUNTIME_TARGET_ROOT;
  const target = normalizeRelativeDir(entry.target ?? defaultTarget, `bundleSourceRoots.roots[${index}].target`);
  if (kind === 'skill' && !VALID_SKILL_TARGET_ROOTS.has(target)) {
    throw new Error(
      `bundleSourceRoots.roots[${index}].target must be one of: ${[...VALID_SKILL_TARGET_ROOTS].join(', ')}`,
    );
  }
  if (kind === 'repo/runtime' && target !== CANONICAL_RUNTIME_TARGET_ROOT) {
    throw new Error(
      `bundleSourceRoots.roots[${index}].target must remain ${CANONICAL_RUNTIME_TARGET_ROOT} for repo/runtime roots`,
    );
  }
  return {
    id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `${kind}:${source}`,
    kind,
    source,
    target,
  };
}

function dedupeRoots(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const key = `${root.kind}\0${root.source}\0${root.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

export function loadBundleSourceRoots(repoRoot, opts = {}) {
  const explicitConfigPath = opts.configPath;
  const configPath = explicitConfigPath
    ? path.resolve(repoRoot, explicitConfigPath)
    : path.resolve(repoRoot, DEFAULT_BUNDLE_ROOT_CONFIG_PATH);
  const defaults = DEFAULT_BUNDLE_SOURCE_ROOTS.map((root) => ({ ...root }));
  if (!fs.existsSync(configPath)) {
    return {
      configPath,
      mode: 'extend',
      fromConfig: false,
      roots: defaults,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Invalid bundle roots config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = parsed?.bundleSourceRoots ?? parsed;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid bundle roots config at ${configPath}: expected an object or { bundleSourceRoots: ... }`);
  }

  const mode = raw.mode ?? 'extend';
  if (mode !== 'extend' && mode !== 'replace') {
    throw new Error(`Invalid bundle roots config at ${configPath}: mode must be "extend" or "replace"`);
  }
  if (!Array.isArray(raw.roots)) {
    throw new Error(`Invalid bundle roots config at ${configPath}: roots must be an array`);
  }

  const normalizedRoots = raw.roots.map(normalizeRootEntry);
  const roots = dedupeRoots(mode === 'replace' ? normalizedRoots : [...defaults, ...normalizedRoots]);
  if (roots.length === 0) {
    throw new Error(`Invalid bundle roots config at ${configPath}: at least one root must be declared`);
  }
  const hasCanonicalSkillTarget = roots.some(
    (root) => root.kind === 'skill' && root.target === CANONICAL_SKILL_TARGET_ROOT,
  );
  if (!hasCanonicalSkillTarget) {
    throw new Error(
      `Invalid bundle roots config at ${configPath}: at least one skill root must target ${CANONICAL_SKILL_TARGET_ROOT}`,
    );
  }
  return {
    configPath,
    mode,
    fromConfig: true,
    roots,
  };
}
