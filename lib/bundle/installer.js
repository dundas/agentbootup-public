import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { getAgentId } from '../project-config.js';
import {
  computeCanonicalBundleHash,
  includeBundleHashFile,
  isSelfManifestSource,
  normalizeBundleDependencies,
} from './bundle-hash-contract.js';
import { AGENTS_SKILL_TARGET_ROOT, CANONICAL_SKILL_TARGET_ROOT } from './roots-config.js';
import {
  assertContainedRelativePath,
  validateManifestSchema,
  collectManifestSchemaWarnings,
  VALID_BUNDLE_TYPES,
  VALID_DISTRIBUTION_MODES,
  VALID_FILE_ROLES,
  VALID_MEMORY_SNAPSHOT_FILE_ROLES,
  RUNTIME_STATE_ROLES,
  FORBIDDEN_KEY_SEGMENTS,
  isValidNpmPackageName,
  isValidNpmVersionRange,
} from './manifest-schema.js';
import { collectSelectedMemoryPaths, isPublishableMemoryPath } from '../memory/brain-backup-selection.js';
import { readSelfManaged } from './self-managed.js';
import { isSecretAssetPath, SECRET_REL_PATHS } from '../brain/asset-contract.js';
import {
  makeBackupCopyPrivate,
  originalModeRecords,
  planStructuralBackupCopy,
  restoreOriginalModes,
  revalidateStructuralBackupCopy,
} from './backup-containment.js';

const DEFAULT_VALIDATION_TIMEOUT_MS = 30_000;
const WORKTREE_SESSION_CLASSIFIER_TEST = './brain/scripts/worktree-session.test.ts';
const WORKTREE_SESSION_CLASSIFIER_COMMAND_PREFIX = `bun test --timeout 15000 ${WORKTREE_SESSION_CLASSIFIER_TEST} --test-name-pattern `;
const WORKTREE_SESSION_CLASSIFIER_TOKENS = ['classifier', "'classifier'", '"classifier"'];

// Kind/role values in active use across fleet manifests. Publish warns on anything
// outside these sets so taxonomy drift is visible instead of silently unmatched
// (a role typo would otherwise exempt a runtime file from install verification).
const KNOWN_FILE_KINDS = new Set(['skill', 'repo', 'docs', 'runtime', 'script', 'test', 'protocol']);
// Roles that designate an executable/importable runtime payload. Explicit set rather
// than a `role.includes('runtime')` substring test, which would false-positive a future
// non-runtime role such as `runtime-adjacent-doc`.
const RUNTIME_FILE_ROLES = new Set(['runtime', 'canonical-runtime', 'runtime-library']);

function normalizeHostedInitializerTargets(entries) {
  if (!Array.isArray(entries)) return entries;
  const latestByTarget = new Map();
  for (const entry of entries) {
    const target = typeof entry === 'string' ? entry : entry?.target;
    if (typeof target !== 'string') continue;
    // One target has one current provenance record. Keeping the latest value
    // bounds state growth when a hosted bundle changes its stripped script.
    try {
      const canonicalTarget = assertContainedRelativePath(target, 'recorded hosted initializer target');
      latestByTarget.set(
        canonicalTarget,
        typeof entry === 'string' ? canonicalTarget : { ...entry, target: canonicalTarget },
      );
    } catch {
      // Preserve malformed legacy records for later diagnostics, but never let
      // their raw spelling alias a valid canonical target.
      latestByTarget.set(`malformed:${target}`, entry);
    }
  }
  return [...latestByTarget.values()];
}

function hostedInitializerTargetsEqual(left, right) {
  const asTuples = (entries) => {
    if (!Array.isArray(entries)) return entries;
    return entries.map((entry) => {
      const rawTarget = typeof entry === 'string' ? entry : entry?.target;
      let target = rawTarget;
      try {
        target = assertContainedRelativePath(rawTarget, 'recorded hosted initializer target');
      } catch {
        // Preserve malformed legacy records as a stable JSON value so a noop
        // cannot erase or churn forensic state it does not understand.
      }
      return [target, typeof entry === 'object' && entry !== null ? entry.hash ?? null : null];
    }).sort(([leftTarget, leftHash], [rightTarget, rightHash]) =>
      String(leftTarget).localeCompare(String(rightTarget)) || String(leftHash).localeCompare(String(rightHash)));
  };
  return JSON.stringify(asTuples(left)) === JSON.stringify(asTuples(right));
}

function payloadTargetsWritten(manifest, sourceRoot) {
  const targets = new Set();
  for (const file of manifest.files) {
    if (file.role && RUNTIME_STATE_ROLES.has(file.role)) continue;
    const source = resolveSourcePath(sourceRoot, file.source);
    if (!fs.existsSync(source)) continue;
    targets.add(file.target);
  }
  for (const mutation of manifest.mutations ?? []) {
    if (mutation.required !== false) targets.add(mutation.path);
  }
  return targets;
}

function dropReownedHostedInitializerTargets(entries, writtenTargets) {
  if (!Array.isArray(entries) || writtenTargets.size === 0) return entries;
  return entries.filter((entry) => {
    const rawTarget = typeof entry === 'string' ? entry : entry?.target;
    try {
      return !writtenTargets.has(assertContainedRelativePath(rawTarget, 'recorded hosted initializer target'));
    } catch {
      // Keep malformed legacy state for the hosted cleanup path to diagnose; a
      // local payload install must not silently erase forensic state it cannot
      // safely identify.
      return true;
    }
  });
}
function sanitizeSegment(value) {
  // State/install paths are generated under ~/.agentbootup; collapse dot-runs here as
  // defense-in-depth for those derived filesystem segment names. Repo target paths are
  // validated separately by manifest normalization.
  return String(value || 'unknown')
    .replace(/[^\w.-]+/g, '_')
    .replace(/\.\.+/g, '_');
}

function getValidationTimeoutMs() {
  const raw = Number.parseInt(process.env.AGENTBOOTUP_BUNDLE_VALIDATION_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VALIDATION_TIMEOUT_MS;
}

function normalizeValidationCommand(command) {
  // The bundle validator has a fixed 30-second process cap. This focused
  // classifier lane can otherwise exceed it under Bun's default test
  // concurrency, so keep that one invocation deterministic without changing
  // the manifest command or any other validation form.
  for (const token of WORKTREE_SESSION_CLASSIFIER_TOKENS) {
    const invocation = `${WORKTREE_SESSION_CLASSIFIER_COMMAND_PREFIX}${token}`;
    if (command === invocation) return `${invocation} --concurrent --max-concurrency=3`;
    if (command.startsWith(`${invocation} && `)) {
      return `${invocation} --concurrent --max-concurrency=3${command.slice(invocation.length)}`;
    }
  }
  return command;
}

function getBundleBunCommand() {
  return process.env.AGENTBOOTUP_BUNDLE_BUN_BIN || 'bun';
}

function detectValidationLocale() {
  const proc = spawnSync('locale', ['-a'], { encoding: 'utf8' });
  if ((proc.status ?? 1) !== 0) return null;
  const locales = new Set(
    (proc.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return ['C.UTF-8', 'C.utf8', 'en_US.UTF-8', 'en_US.utf8']
    .find((candidate) => locales.has(candidate)) ??
    [...locales].find((candidate) => /utf-?8/i.test(candidate)) ??
    null;
}

export function resolveValidationEnv() {
  const env = { ...process.env };
  // npm lifecycle scripts inject npm_config_prefix. A login shell that loads
  // nvm rejects that variable before the repo-authored validation command can
  // run, so validation behavior differs between `bun run` and `npm test`.
  // The prefix override is the conflicting input. Preserve other npm_config_*
  // values because repo-authored validation commands may intentionally invoke
  // npm and need registry, user-config, proxy, or authentication settings.
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  const locale = detectValidationLocale();
  if (locale) {
    env.LC_ALL = locale;
    env.LANG = locale;
    env.LANGUAGE = locale;
    return env;
  }
  delete env.LC_ALL;
  if (typeof env.LANG === 'string' && env.LANG.trim().toUpperCase() === 'C.UTF-8') delete env.LANG;
  if (typeof env.LANGUAGE === 'string' && env.LANGUAGE.trim().toUpperCase() === 'C.UTF-8') delete env.LANGUAGE;
  return env;
}

export function getAgentbootupHome() {
  const configured = process.env.AGENTBOOTUP_HOME;
  if (configured && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.agentbootup');
}

export function getBundleStoreRoot() {
  return path.join(getAgentbootupHome(), 'bundles');
}

export function getBrainBundleRoots(agentId) {
  const safeAgentId = sanitizeSegment(agentId || 'unknown');
  const base = path.join(getAgentbootupHome(), 'brains', safeAgentId);
  return {
    root: base,
    installedRoot: path.join(base, 'installed'),
    backupsRoot: path.join(base, 'backups'),
    stateRoot: path.join(base, 'state'),
  };
}

// Delegates to the single shared containment helper (PRD-0047 §7 clause 9, Task 2.1a:
// "no command-local path validator is permitted"). assertContainedRelativePath adds
// NUL and Windows-drive-absolute rejection on top of the prior POSIX/traversal checks.
function ensureRelative(relPath, label) {
  return assertContainedRelativePath(relPath, label);
}

function defaultInstallPaths(bundleType, bundleName) {
  switch (bundleType) {
    case 'skill_bundle':
      return {
        state_file: `skills/state/${bundleName}.json`,
        backup_root: `skills/${bundleName}`,
      };
    case 'protocol_bundle':
      return {
        state_file: `protocols/state/${bundleName}.json`,
        backup_root: `protocols/${bundleName}`,
      };
    case 'memory_snapshot':
      return {
        state_file: `memory/state/${bundleName}.json`,
        backup_root: `memory/${bundleName}`,
      };
    default:
      return {
        state_file: `bundles/state/${bundleName}.json`,
        backup_root: `bundles/${bundleName}`,
      };
  }
}

function normalizeLegacyInstallPath(bundleType, value, bundleName, kind) {
  if (!value) return null;
  const normalized = String(value).replace(/\\/g, '/');
  if (normalized.startsWith('.ai/skills/')) {
    return normalized.replace('.ai/skills/', 'skills/');
  }
  if (normalized.startsWith('.ai/protocols/')) {
    return normalized.replace('.ai/protocols/', 'protocols/');
  }
  if (bundleType === 'memory_snapshot' && normalized.startsWith('memory/')) {
    return normalized;
  }
  if (kind === 'state_file' && normalized.endsWith('.json') && !normalized.includes('/')) {
    return `${bundleType === 'protocol_bundle' ? 'protocols' : 'skills'}/state/${bundleName}.json`;
  }
  return normalized;
}

function normalizeFileEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`files[${index}] must be an object`);
  }
  const source = entry.source ?? entry.path;
  const target = entry.target ?? entry.path;
  if (!source || !target) {
    throw new Error(`files[${index}] must include source/path and target/path`);
  }
  return {
    source: ensureRelative(source, `files[${index}].source`),
    target: ensureRelative(target, `files[${index}].target`),
    kind: entry.kind ?? 'repo',
    // Preserve explicitly supplied values so the mutating schema gate can reject
    // malformed inputs even when callers only retain the normalized manifest.
    // Defaults apply only when the field is omitted: generated_state is not
    // required at install; other roles retain the historical required default.
    required: entry.required === undefined
      ? entry.role === 'generated_state'
        ? false
        : true
      : entry.required,
    role: entry.role ?? null,
    shared: Boolean(entry.shared),
    shared_with: Array.isArray(entry.shared_with) ? [...entry.shared_with] : [],
    // WO §2: preserve the initializer field so it survives normalization.
    // validateManifestSchema() already verified it's a contained relative path
    // only present with role: required_data. Canonicalize through ensureRelative
    // (same as source/target) so ./prefix and backslash separators don't leak.
    initializer: entry.initializer != null
      ? ensureRelative(entry.initializer, `files[${index}].initializer`)
      : null,
  };
}

function normalizeMutation(mutation, index) {
  if (!mutation || typeof mutation !== 'object') {
    throw new Error(`mutations[${index}] must be an object`);
  }
  if (mutation.type === 'append_block_if_missing') {
    return {
      ...mutation,
      path: ensureRelative(mutation.path, `mutations[${index}].path`),
    };
  }
  if (mutation.type === 'json_set') {
    assertSafeJsonKeyPath(mutation.key_path, `mutations[${index}].key_path`);
    return {
      ...mutation,
      path: ensureRelative(mutation.path, `mutations[${index}].path`),
    };
  }
  throw new Error(`Unsupported bundle mutation type: ${mutation.type}`);
}

function assertSafeJsonKeyPath(keyPath, label) {
  if (!Array.isArray(keyPath) || keyPath.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const segment of keyPath) {
    if (typeof segment !== 'string' || !segment.trim()) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    if (FORBIDDEN_KEY_SEGMENTS.has(segment)) {
      throw new Error(`${label} contains a forbidden key segment`);
    }
  }
}

function normalizeMutations(mutations) {
  return Array.isArray(mutations) ? mutations.map(normalizeMutation) : [];
}

const normalizeDependencies = normalizeBundleDependencies;

export function normalizeBundleManifest(rawManifest) {
  if (!rawManifest || typeof rawManifest !== 'object') {
    throw new Error('manifest must be an object');
  }

  const bundleType = rawManifest.bundle_type ?? (rawManifest.skill ? 'skill_bundle' : null);
  const bundleName = rawManifest.bundle_name ?? rawManifest.skill ?? null;
  if (!bundleType || !VALID_BUNDLE_TYPES.has(bundleType)) {
    throw new Error(`manifest bundle_type must be one of: ${[...VALID_BUNDLE_TYPES].join(', ')}`);
  }
  if (!bundleName || typeof bundleName !== 'string') {
    throw new Error('manifest bundle_name is required');
  }
  if (!rawManifest.bundle_version || !rawManifest.version_id || !rawManifest.bundle_hash) {
    throw new Error('manifest must include bundle_version, version_id, and bundle_hash');
  }
  if (!Array.isArray(rawManifest.files) || rawManifest.files.length === 0) {
    throw new Error('manifest must include a non-empty files array');
  }

  const defaults = defaultInstallPaths(bundleType, bundleName);
  const distributionMode =
    rawManifest.distribution?.mode ??
    (bundleType === 'memory_snapshot' ? 'snapshot' : 'self_apply');
  if (!VALID_DISTRIBUTION_MODES.has(distributionMode)) {
    throw new Error(`manifest distribution.mode must be one of: ${[...VALID_DISTRIBUTION_MODES].join(', ')}`);
  }

  const stateFile = normalizeLegacyInstallPath(
    bundleType,
    rawManifest.install?.state_file ?? defaults.state_file,
    bundleName,
    'state_file',
  );
  const backupRoot = normalizeLegacyInstallPath(
    bundleType,
    rawManifest.install?.backup_root ?? defaults.backup_root,
    bundleName,
    'backup_root',
  );

  return {
    ...rawManifest,
    bundle_type: bundleType,
    bundle_name: bundleName,
    distribution: {
      ...(rawManifest.distribution ?? {}),
      mode: distributionMode,
    },
    install: {
      ...(rawManifest.install ?? {}),
      state_file: ensureRelative(stateFile, 'install.state_file'),
      backup_root: ensureRelative(backupRoot, 'install.backup_root'),
    },
    validation: {
      // Tolerant coercion is retained here so read-only diagnostics (status, report,
      // doctor) can still load and reason about a slightly-malformed manifest. Strict
      // rejection of non-string commands (and non-string install paths) happens at the
      // mutating gate — validateManifestSchema(raw) inside publishBundle/installBundle —
      // BEFORE any command is executed. Diagnostics never execute commands.
      commands: Array.isArray(rawManifest.validation?.commands)
        ? rawManifest.validation.commands.map((command) => String(command))
        : [],
    },
    dependencies: normalizeDependencies(rawManifest.dependencies),
    projection: rawManifest.projection && typeof rawManifest.projection === 'object' && !Array.isArray(rawManifest.projection)
      ? {
        ...rawManifest.projection,
        ...(Array.isArray(rawManifest.projection.targets)
          ? { targets: rawManifest.projection.targets.map((target, index) =>
            ensureRelative(target, `projection.targets[${index}]`)) }
          : {}),
      }
      : rawManifest.projection,
    files: rawManifest.files.map(normalizeFileEntry),
    mutations: normalizeMutations(rawManifest.mutations),
  };
}

export function loadBundleManifest(manifestPath) {
  const absolutePath = path.resolve(manifestPath);
  const raw = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  // Fail-closed schema validation is scoped to the publish and install gates
  // (PRD-0047 §7) — enforced inside publishBundle/installBundle — not to every read.
  // Doctor, status, report, and memory-snapshot reads flow through here too and must
  // keep reading a manifest to diagnose it rather than rejecting it wholesale. We do
  // surface non-fatal alias deprecations so publish can print them.
  const manifest = normalizeBundleManifest(raw);
  Object.defineProperty(manifest, '__bundleManifestPath', {
    value: absolutePath, enumerable: false, configurable: true,
  });
  return {
    manifestPath: absolutePath,
    raw,
    schemaWarnings: collectManifestSchemaWarnings(raw),
    manifest,
  };
}

function resolveSourcePath(root, relPath) {
  return path.resolve(root, relPath);
}

export function buildEffectiveInstallManifest(manifest, options = {}) {
  const materializeAgents = options.materializeAgents === true;
  if (!materializeAgents || manifest.bundle_type !== 'skill_bundle') {
    return manifest;
  }

  const canonicalPrefix = `${CANONICAL_SKILL_TARGET_ROOT}/${manifest.bundle_name}/`;
  const agentsPrefix = `${AGENTS_SKILL_TARGET_ROOT}/${manifest.bundle_name}/`;
  const seenTargets = new Set(manifest.files.map((file) => file.target));
  const synthesized = [];

  for (const file of manifest.files) {
    if (!file.target.startsWith(canonicalPrefix)) continue;
    const mirroredTarget = `${agentsPrefix}${file.target.slice(canonicalPrefix.length)}`;
    if (seenTargets.has(mirroredTarget)) continue;
    seenTargets.add(mirroredTarget);
    synthesized.push({
      ...file,
      target: mirroredTarget,
      role: file.role ?? 'portable_materialized',
    });
  }

  if (synthesized.length === 0) return manifest;
  return {
    ...manifest,
    files: [...manifest.files, ...synthesized],
  };
}

function manifestHashPlaceholder(manifest) {
  return normalizeBundleManifest({
    ...manifest,
    bundle_hash: 'sha256:pending',
    version_id: `${manifest.bundle_name}@${manifest.bundle_version}+sha256_pending`,
  });
}

function manifestSelfSources(manifest, sourceRoot, manifestPath = null) {
  const actualPath = manifestPath ?? manifest.__bundleManifestPath;
  const candidates = Array.isArray(manifest.__bundleSelfSources)
    ? manifest.__bundleSelfSources
    : [manifest.__bundleSelfSource ??
      (actualPath ? path.relative(sourceRoot, actualPath).replace(/\\/g, '/') : null)];
  // Identity normalization is an explicit relationship between the control
  // manifest and a declared contained payload entry. A random manifest-shaped
  // file, or an external control manifest, receives no normalization.
  const sources = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let source;
    try {
      source = assertContainedRelativePath(candidate, 'self manifest source');
    } catch {
      return [];
    }
    if (!manifest.files.some((file) => file.source === source)) return [];
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

function selfManifestOverrides(manifest, selfManifestSources) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  const overrides = new Map();
  for (const file of manifest.files) {
    if (isSelfManifestSource(file.source, selfManifestSources)) overrides.set(file.source, bytes);
  }
  return overrides;
}

export function computeInlineBundleHash(fileEntries, opts = {}) {
  const normalizedMutations = normalizeMutations(opts.mutations);
  return computeCanonicalBundleHash(fileEntries, {
    bundleType: opts.bundleType,
    readFile: (file) => typeof file.content === 'string' || file.content instanceof Uint8Array || Buffer.isBuffer(file.content)
      ? file.content : Buffer.from(String(file.content ?? '')),
    mutations: normalizedMutations,
    validationCommands: Array.isArray(opts.validationCommands) ? opts.validationCommands : [],
    dependencies: opts.dependencies ? normalizeDependencies(opts.dependencies) : null,
    selfManifestSources: Array.isArray(opts.selfManifestSources) ? opts.selfManifestSources : [],
  });
}

export function computeBundleHash(manifest, sourceRoot, opts = {}) {
  const overrides = opts.fileContentOverrides instanceof Map ? opts.fileContentOverrides : null;
  const files = [];
  for (const file of manifest.files) {
    if (file.role && RUNTIME_STATE_ROLES.has(file.role)) {
      files.push(file);
      continue;
    }
    if (!includeBundleHashFile(file, manifest.bundle_type)) continue;
    const abs = resolveSourcePath(sourceRoot, file.source);
    if (!fs.existsSync(abs)) {
      if (file.required) throw new Error(`Required source file missing: ${file.source}`);
      continue;
    }
    const stats = fs.statSync(abs);
    if (!stats.isFile()) throw new Error(`Bundle file must be a file: ${file.source}`);
    files.push(file);
  }
  return computeCanonicalBundleHash(files, {
    bundleType: manifest.bundle_type,
    readFile: (file) => overrides?.get(file.source) ?? fs.readFileSync(resolveSourcePath(sourceRoot, file.source)),
    mutations: manifest.mutations,
    validationCommands: manifest.validation.commands,
    dependencies: normalizeDependencies(manifest.dependencies ?? {}),
    selfManifestSources: Array.isArray(opts.selfManifestSources)
      ? opts.selfManifestSources
      : manifestSelfSources(manifest, sourceRoot, opts.manifestPath),
  });
}

// The bundle identity includes the source and target names as well as content. To
// verify an installed payload, retain those manifest identifiers but read each file
// from its target path. This is deliberately separate from computeBundleHash(): the
// latter validates the source artifact, while this one detects byte drift in a
// target whose ledger merely claims the same version was applied.
function computeInstalledPayloadHash(manifest, targetRoot, selfManifestSources = []) {
  const missing = [];
  const files = [];
  for (const file of manifest.files) {
    if (file.role && RUNTIME_STATE_ROLES.has(file.role)) {
      files.push(file);
      continue;
    }
    if (!includeBundleHashFile(file, manifest.bundle_type)) continue;
    const target = resolveSourcePath(targetRoot, file.target);
    let stats;
    try {
      stats = fs.statSync(target);
    } catch {
      stats = null;
    }
    if (!stats?.isFile()) {
      if (file.required) missing.push(file.target);
      continue;
    }
    files.push(file);
  }
  if (missing.length > 0) return { hash: null, missing };
  return {
    hash: computeCanonicalBundleHash(files, {
      bundleType: manifest.bundle_type,
      readFile: (file) => fs.readFileSync(resolveSourcePath(targetRoot, file.target)),
      mutations: manifest.mutations,
      validationCommands: manifest.validation.commands,
      dependencies: normalizeDependencies(manifest.dependencies ?? {}),
      selfManifestSources,
    }),
    missing: [],
  };
}

export function rehashBundleManifest(manifest, sourceRoot, opts = {}) {
  // `loadBundleManifest` records the actual control-file path as a
  // non-enumerable property. Capture it before staging spreads the manifest,
  // otherwise a nested self manifest loses its explicit identity and rehashing
  // treats those recursive fields as ordinary drift.
  const selfManifestSources = manifestSelfSources(manifest, sourceRoot, opts.manifestPath);
  const staged = manifestHashPlaceholder(manifest);
  const bundleHash = computeBundleHash(staged, sourceRoot, {
    fileContentOverrides: selfManifestOverrides(staged, selfManifestSources),
    selfManifestSources,
  });
  return normalizeBundleManifest({
    ...staged,
    bundle_hash: bundleHash,
    version_id: `${staged.bundle_name}@${staged.bundle_version}+sha256_${bundleHash.replace('sha256:', '').slice(0, 8)}`,
  });
}

function resolveAgentId(targetRoot, explicitAgentId) {
  return explicitAgentId || getAgentId(targetRoot) || path.basename(path.resolve(targetRoot)) || 'unknown';
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function lstatExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function sanitizeBackupFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('bundle backup structural preflight failed:')) throw new Error(message);
  throw new Error('bundle backup structural preflight failed: filesystem operation failed');
}

function ensurePrivateBackupDirectory(directory, backupsRoot) {
  const relative = path.relative(backupsRoot, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('bundle backup structural preflight failed: backup output escaped protected storage');
  }
  let cursor = backupsRoot;
  fs.mkdirSync(cursor, { recursive: true, mode: 0o700 });
  fs.chmodSync(cursor, 0o700);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    fs.mkdirSync(cursor, { recursive: true, mode: 0o700 });
    fs.chmodSync(cursor, 0o700);
  }
}

function inventoryPaths(manifest) {
  const out = new Set();
  const isSecretDeniedInventory = (value) => {
    const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return isSecretAssetPath(normalized)
      || SECRET_REL_PATHS.some((secretPath) => secretPath.startsWith(`${normalized}/`));
  };
  for (const file of manifest.files) {
    if (isSecretDeniedInventory(file.target)) {
      throw new Error('bundle backup structural preflight failed: secret-denied inventory path');
    }
    out.add(file.target);
  }
  for (const mutation of manifest.mutations) {
    if (isSecretDeniedInventory(mutation.path)) {
      throw new Error('bundle backup structural preflight failed: secret-denied inventory path');
    }
    out.add(mutation.path);
  }
  return [...out].sort();
}

function resolveInstalledStatePath(manifest, targetRoot, explicitAgentId) {
  const agentId = resolveAgentId(targetRoot, explicitAgentId);
  const roots = getBrainBundleRoots(agentId);
  return {
    agentId,
    roots,
    path: path.join(roots.installedRoot, manifest.install.state_file),
  };
}

function resolveBackupDir(manifest, targetRoot, explicitAgentId, backupVersionId) {
  const agentId = resolveAgentId(targetRoot, explicitAgentId);
  const roots = getBrainBundleRoots(agentId);
  return {
    agentId,
    roots,
    path: path.join(roots.backupsRoot, manifest.install.backup_root, sanitizeSegment(backupVersionId)),
  };
}

function uniqueBackupVersionId(backupVersionId) {
  return `${backupVersionId}-attempt-${randomUUID()}`;
}

/**
 * The ledger entry for a bundle in a target checkout, or null when none exists.
 * Exposed so out-of-band verifiers (doctor) can distinguish "installed then eroded"
 * from "declared but never installed" instead of reporting both as erosion.
 */
export function readBundleInstallState(manifest, targetRoot, explicitAgentId) {
  return readInstalledState(manifest, targetRoot, explicitAgentId).value;
}

export function pruneHostedInitializerTargets(manifest, targetRoot, explicitAgentId, removedTargets, dryRun = false) {
  if (dryRun || !(removedTargets instanceof Set) || removedTargets.size === 0) return false;
  const current = readInstalledState(manifest, targetRoot, explicitAgentId);
  if (!Array.isArray(current.value?.hosted_initializer_targets)) return false;
  const retained = current.value.hosted_initializer_targets.filter((entry) => {
    const rawTarget = typeof entry === 'string' ? entry : entry?.target;
    try {
      return !removedTargets.has(assertContainedRelativePath(rawTarget, 'recorded hosted initializer target'));
    } catch {
      return true;
    }
  });
  if (retained.length === current.value.hosted_initializer_targets.length) return false;
  writeInstalledState(manifest, targetRoot, explicitAgentId, {
    ...current.value,
    hosted_initializer_targets: retained,
  }, false);
  return true;
}

function readInstalledState(manifest, targetRoot, explicitAgentId) {
  const state = resolveInstalledStatePath(manifest, targetRoot, explicitAgentId);
  if (!fs.existsSync(state.path)) return { ...state, value: null };
  return {
    ...state,
    value: JSON.parse(fs.readFileSync(state.path, 'utf8')),
  };
}

function writeInstalledState(manifest, targetRoot, explicitAgentId, value, dryRun) {
  const state = resolveInstalledStatePath(manifest, targetRoot, explicitAgentId);
  if (!dryRun) {
    ensureParent(state.path);
    fs.writeFileSync(state.path, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
  return state;
}

function backupBundle(manifest, targetRoot, explicitAgentId, backupVersionId, dryRun) {
  let incompleteGeneration = null;
  try {
    const backup = resolveBackupDir(manifest, targetRoot, explicitAgentId, backupVersionId);
    if (lstatExists(backup.path)) {
      throw new Error('bundle backup structural preflight failed: generated backup destination already exists');
    }
    const entries = inventoryPaths(manifest).map((relPath) => {
      const absTarget = resolveSourcePath(targetRoot, relPath);
      const existed = lstatExists(absTarget);
      const absBackup = path.join(backup.path, relPath);
      const plan = existed ? planStructuralBackupCopy({
        sourcePath: absTarget,
        destinationPath: absBackup,
        targetRoot,
        backupHome: getAgentbootupHome(),
        backupsRoot: backup.roots.backupsRoot,
      }) : null;
      return { path: relPath, existed, plan, modes: plan ? originalModeRecords(plan) : undefined };
    });

    const dependencyEntries = Object.keys(manifest.dependencies ?? {}).length === 0 ? [] : ['package.json', 'bun.lock', 'bun.lockb', 'node_modules'].map((name) => {
      const source = path.join(targetRoot, name);
      const existed = lstatExists(source);
      const destination = path.join(backup.path, '.dependencies', name);
      const plan = existed ? planStructuralBackupCopy({
        sourcePath: source,
        destinationPath: destination,
        targetRoot,
        backupHome: getAgentbootupHome(),
        backupsRoot: backup.roots.backupsRoot,
        allowNestedSymlinks: name === 'node_modules',
      }) : null;
      return { name, existed, plan, modes: plan ? originalModeRecords(plan) : undefined };
    });

    if (!dryRun) {
      // The complete structural plan and its first revalidation finish before the
      // first backup write. Slice B owns race-free recursive-copy primitives; this
      // Slice A revalidation is intentionally best-effort pathname containment.
      for (const entry of [...entries, ...dependencyEntries]) {
        if (entry.plan) revalidateStructuralBackupCopy(entry.plan, { targetRoot, backupHome: getAgentbootupHome() });
      }
      // A newly-created generation has no valid rollback meaning until its metadata
      // is durable. Every attempt uses a fresh immutable destination; retention is
      // intentionally owned by Slice D, while Slice B owns crash recovery/markers.
      incompleteGeneration = backup.path;
      ensurePrivateBackupDirectory(backup.path, backup.roots.backupsRoot);
      for (const entry of entries) {
        if (!entry.plan) continue;
        revalidateStructuralBackupCopy(entry.plan, { targetRoot, backupHome: getAgentbootupHome() });
        const absBackup = path.join(backup.path, entry.path);
        ensurePrivateBackupDirectory(path.dirname(absBackup), backup.roots.backupsRoot);
        fs.rmSync(absBackup, { recursive: true, force: true });
        // Inventory targets can legitimately be directories after local drift.
        fs.cpSync(entry.plan.source.logical, absBackup, { recursive: true });
        makeBackupCopyPrivate(absBackup, entry.modes);
      }
      for (const entry of dependencyEntries) {
        if (!entry.plan) continue;
        revalidateStructuralBackupCopy(entry.plan, { targetRoot, backupHome: getAgentbootupHome() });
        const destination = path.join(backup.path, '.dependencies', entry.name);
        ensurePrivateBackupDirectory(path.dirname(destination), backup.roots.backupsRoot);
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(entry.plan.source.logical, destination, { recursive: true });
        makeBackupCopyPrivate(destination, entry.modes);
      }
      const metadataEntries = entries.map(({ plan, ...entry }) => entry);
      const metadataDependencyEntries = dependencyEntries.map(({ plan, ...entry }) => entry);
      fs.writeFileSync(
        path.join(backup.path, 'backup-metadata.json'),
        JSON.stringify({ entries: metadataEntries, dependency_entries: metadataDependencyEntries }, null, 2) + '\n',
        { encoding: 'utf8', mode: 0o600 },
      );
      fs.chmodSync(path.join(backup.path, 'backup-metadata.json'), 0o600);
      incompleteGeneration = null;
    }

    return { ...backup, entries, dependencyEntries };
  } catch (error) {
    if (incompleteGeneration) {
      try {
        fs.rmSync(incompleteGeneration, { recursive: true, force: true });
      } catch {
        // Preserve the original sanitized failure. Slice B owns durable journaling
        // and crash recovery when best-effort cleanup itself cannot complete.
      }
    }
    sanitizeBackupFailure(error);
  }
}

function restoreDependencyBackup(targetRoot, backupDir, entries, dryRun) {
  for (const entry of entries ?? []) {
    const target = path.join(targetRoot, entry.name);
    if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
    if (entry.existed && !dryRun) {
      fs.cpSync(path.join(backupDir, '.dependencies', entry.name), target, { recursive: true });
      restoreOriginalModes(target, entry.modes);
    }
  }
}

function applyMutation(mutation, targetRoot, dryRun) {
  const dest = resolveSourcePath(targetRoot, mutation.path);
  if (mutation.type === 'append_block_if_missing') {
    const required = mutation.required ?? true;
    if (!fs.existsSync(dest)) {
      if (!required || dryRun) return;
      ensureParent(dest);
      fs.writeFileSync(dest, mutation.content.endsWith('\n') ? mutation.content : `${mutation.content}\n`, 'utf8');
      return;
    }
    const current = fs.readFileSync(dest, 'utf8');
    const match = mutation.match ?? mutation.content;
    if (current.includes(match) || dryRun) return;
    const prefix = current.endsWith('\n') || current.length === 0 ? '' : '\n';
    const block = mutation.content.endsWith('\n') ? mutation.content : `${mutation.content}\n`;
    fs.writeFileSync(dest, current + prefix + block, 'utf8');
    return;
  }

  if (mutation.type === 'json_set') {
    const required = mutation.required ?? true;
    assertSafeJsonKeyPath(mutation.key_path, 'mutation.key_path');
    if (!fs.existsSync(dest)) {
      if (!required || dryRun) return;
      ensureParent(dest);
      fs.writeFileSync(dest, '{}\n', 'utf8');
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
    } catch (error) {
      throw new Error(
        `Failed to parse JSON for mutation at ${mutation.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let cursor = parsed;
    for (let i = 0; i < mutation.key_path.length - 1; i++) {
      const key = mutation.key_path[i];
      const nextValue = Reflect.get(cursor, key);
      if (!nextValue || typeof nextValue !== 'object' || Array.isArray(nextValue)) {
        Reflect.set(cursor, key, {});
      }
      cursor = Reflect.get(cursor, key);
    }
    Reflect.set(cursor, mutation.key_path[mutation.key_path.length - 1], mutation.value);
    if (!dryRun) {
      fs.writeFileSync(dest, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    }
  }
}

function applyBundle(manifest, sourceRoot, targetRoot, dryRun) {
  for (const file of manifest.files) {
    // WO §2: runtime-state roles are NOT in the source bundle — skip copy.
    if (file.role && RUNTIME_STATE_ROLES.has(file.role)) continue;
    const source = resolveSourcePath(sourceRoot, file.source);
    if (!fs.existsSync(source)) {
      if (file.required) throw new Error(`Required source file missing during apply: ${file.source}`);
      continue;
    }
    if (dryRun) continue;
    const dest = resolveSourcePath(targetRoot, file.target);
    ensureParent(dest);
    fs.cpSync(source, dest);
  }
  for (const mutation of manifest.mutations) {
    applyMutation(mutation, targetRoot, dryRun);
  }
}

function restoreBackup(manifest, targetRoot, backupDir, entries, dryRun) {
  for (const entry of entries) {
    const target = resolveSourcePath(targetRoot, entry.path);
    const backup = path.join(backupDir, entry.path);
    if (entry.existed) {
      if (dryRun) continue;
      if (!fs.existsSync(backup)) {
        throw new Error(`Backup file missing during rollback: ${backup}`);
      }
      // Stage a readable copy before touching the live target. A missing or
      // corrupt backup must leave the failed-install result intact rather than
      // erasing the only recoverable copy during rollback.
      ensureParent(target);
      const rollbackDir = fs.mkdtempSync(path.join(path.dirname(target), '.agentbootup-rollback-'));
      const staged = path.join(rollbackDir, 'backup');
      const displaced = path.join(rollbackDir, 'failed-install-target');
      let preserveRollbackDir = false;
      try {
        fs.cpSync(backup, staged, { recursive: true });
        restoreOriginalModes(staged, entry.modes);
        // Rename, rather than delete, the failed-install result so a failed
        // final swap can restore it without data loss. All paths share the
        // target parent and therefore the same filesystem.
        const hadTarget = fs.existsSync(target);
        if (hadTarget) fs.renameSync(target, displaced);
        try {
          fs.renameSync(staged, target);
        } catch (error) {
          if (hadTarget) {
            try {
              fs.renameSync(displaced, target);
            } catch {
              // Do not destroy the displaced failed-install copy if both swaps
              // fail. Leave it recoverable and make its location explicit.
              preserveRollbackDir = true;
              throw new Error(
                `Rollback swap failed; recover the displaced target from ${displaced}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          throw error;
        }
      } finally {
        if (!preserveRollbackDir) fs.rmSync(rollbackDir, { recursive: true, force: true });
      }
    } else if (fs.existsSync(target) && !dryRun) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

function runValidation(manifest, targetRoot, dryRun, skipValidation = false) {
  const results = [];
  if (skipValidation) {
    for (const command of manifest.validation.commands) {
      results.push({ command, exitCode: null, stdout: '', stderr: '', skipped: true });
    }
    return results;
  }
  let env = null;
  for (const command of manifest.validation.commands) {
    if (dryRun) {
      results.push({ command, exitCode: 0, stdout: '', stderr: '', dryRun: true });
      continue;
    }
    env ??= resolveValidationEnv();
    const timeoutMs = getValidationTimeoutMs();
    const executableCommand = normalizeValidationCommand(command);
    // Validation commands are only trusted for repo-authored manifests; hosted sync
    // strips them before install so the planner cannot trigger local shell execution.
    const proc = spawnSync('bash', ['-lc', executableCommand], {
      cwd: targetRoot,
      encoding: 'utf8',
      env,
      timeout: timeoutMs,
    });
    const timedOut = proc.error?.code === 'ETIMEDOUT';
    results.push({
      command,
      exitCode: proc.status ?? 1,
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? '',
      timedOut,
    });
    if (timedOut) {
      throw new Error(
        [
          `Validation timed out after ${timeoutMs}ms: ${command}`,
          proc.stdout ? `stdout:\n${proc.stdout.trim()}` : null,
          proc.stderr ? `stderr:\n${proc.stderr.trim()}` : null,
        ].filter(Boolean).join('\n\n'),
      );
    }
    if ((proc.status ?? 1) !== 0) {
      throw new Error(proc.stderr?.trim() || proc.stdout?.trim() || `Validation failed: ${command}`);
    }
  }
  return results;
}

function resolveInstalledDependency(name, range, targetRoot) {
  const resolved = spawnSync(getBundleBunCommand(), ['-e', 'const p = `${process.cwd()}/node_modules/${process.env.AGENTBOOTUP_BUNDLE_DEPENDENCY}/package.json`; const pkg = await Bun.file(p).json(); if (!Bun.semver.satisfies(pkg.version, process.env.AGENTBOOTUP_BUNDLE_RANGE)) process.exit(1);'], {
    cwd: targetRoot,
    encoding: 'utf8',
    env: { ...process.env, AGENTBOOTUP_BUNDLE_DEPENDENCY: name, AGENTBOOTUP_BUNDLE_RANGE: range },
  });
  if (resolved.error || resolved.status !== 0) {
    const detail = resolved.stderr?.trim() || resolved.stdout?.trim() || resolved.error?.message || 'module did not resolve';
    throw new Error(`Bundle runtime dependency ${name} does not resolve from ${targetRoot}: ${detail}`);
  }
  return { name, range, resolved: true };
}

/**
 * Install manifest-declared runtime dependencies in the consumer repository.
 * This is deliberately separate from validation.commands: dependency resolution is
 * an install invariant and therefore cannot be skipped with --skip-validation.
 * Lifecycle scripts are intentionally left enabled here because dependency installs
 * are limited to repo-authored manifests; hosted/remote sync strips dependencies
 * before install, and some trusted packages require install-time build hooks.
 */
function installManifestDependenciesWithRollback(manifest, targetRoot, dryRun) {
  const dependencies = normalizeDependencies(manifest.dependencies);
  const entries = Object.entries(dependencies);
  if (entries.length === 0) return { dependencies: [] };

  const packageJsonPath = path.join(targetRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) {
    throw new Error(
      `Bundle ${manifest.bundle_name} declares runtime dependencies, but target has no package.json: ${packageJsonPath}`,
    );
  }
  for (const [name, range] of entries) {
    if (!isValidNpmPackageName(name) || !isValidNpmVersionRange(range)) {
      throw new Error(`Invalid dependency declaration for ${name}; manifest schema validation should have rejected it`);
    }
  }
  if (dryRun) return { dependencies: entries.map(([name, range]) => ({ name, range, dryRun: true })) };

  const packageSpecs = entries.map(([name, range]) => `${name}@${range}`);
  const install = spawnSync(getBundleBunCommand(), ['add', ...packageSpecs], {
    cwd: targetRoot,
    encoding: 'utf8',
  });
  if (install.error || install.status !== 0) {
    const detail = install.stderr?.trim() || install.stdout?.trim() || install.error?.message || 'unknown bun add failure';
    throw new Error(`Failed to install bundle runtime dependencies in ${targetRoot}: ${detail}`);
  }

  const resolvedDependencies = entries.map(([name, range]) => resolveInstalledDependency(name, range, targetRoot));
  return { dependencies: resolvedDependencies };
}

function verifyManifestDependencies(manifest, targetRoot, dryRun = false) {
  const entries = Object.entries(normalizeDependencies(manifest.dependencies));
  if (entries.length === 0) return;
  if (dryRun) return;
  const packageJsonPath = path.join(targetRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) {
    throw new Error(`Bundle ${manifest.bundle_name} declares runtime dependencies, but target has no package.json: ${packageJsonPath}`);
  }
  for (const [name, range] of entries) {
    resolveInstalledDependency(name, range, targetRoot);
  }
}

/**
 * Runtime files appear under five kind/role combos in fleet manifests (repo|runtime,
 * runtime|null, runtime|canonical-runtime, script|runtime, runtime|runtime-library).
 * Matching role === 'runtime' alone would miss 10 of 18 fleet runtime files —
 * including narrative-generator, the bundle whose erosion motivated this check.
 */
export function isRuntimeFileEntry(file) {
  if (!file || typeof file !== 'object') return false;
  return file.kind === 'runtime' || RUNTIME_FILE_ROLES.has(file.role);
}

/**
 * WO msg-1784803031106-5b7jf2 §2: run initializers for required_data files that
 * are absent at the target. An initializer is a script (`.ts`/`.js`/`.mjs`) that
 * creates the file if it doesn't exist. Called after the file-copy phase of
 * install, BEFORE verifyRequiredTargets — so a required_data file with an
 * initializer is created on install, and a required_data file WITHOUT an
 * initializer is caught by verifyRequiredTargets (fail closed).
 *
 * @returns {{ ran: string[], failed: Array<{ target: string, error: string }>, preserved: Array<{ target: string, dir: string, path: string }> }}
 */
export function runInitializers(manifest, targetRoot, options = {}) {
  const ran = [];
  const failed = [];
  const preserved = [];
  const runInitializer = options.runInitializer ?? ((scriptPath, targetPath) => {
    // Default: run the script with bun, passing the target path as an arg.
    // The script is responsible for creating the file at targetPath.
    // cwd: targetRoot — same context as validation/dependency commands, so
    // initializers that read sibling-relative paths or use process.cwd() work.
    // Use the configured Bun binary (AGENTBOOTUP_BUNDLE_BUN_BIN) for consistency
    // with dependency installs and validation.
    const result = spawnSync(getBundleBunCommand(), [scriptPath, targetPath], { encoding: 'utf-8', cwd: targetRoot });
    if (result.status !== 0) {
      const reason = result.error?.message ?? result.stderr ?? '';
      throw new Error(`initializer ${scriptPath} exited ${result.status}: ${reason}`);
    }
  });
  for (const file of manifest.files) {
    if (file.role !== 'required_data' || !file.initializer) continue;
    const dest = resolveSourcePath(targetRoot, file.target);
    // WO §2 (roborev r12): treat only a regular FILE as "already initialized" —
    // a directory or other non-file at the target path is a bad state that should
    // be removed and re-initialized, not skipped.
    // WO §2 (roborev r13): if the path exists but is NOT a file (stale directory),
    // remove it BEFORE running the initializer so it can create the file cleanly.
    let isFile = false;
    let exists = false;
    try {
      const stats = fs.statSync(dest);
      exists = true;
      isFile = stats.isFile();
    } catch { exists = false; }
    if (isFile) continue;  // already present — nothing to initialize
    const scriptPath = resolveSourcePath(targetRoot, file.initializer);
    if (!fs.existsSync(scriptPath)) {
      // Do not destroy a stale target until the required initializer is known
      // to be available; a failed install must leave prior local state intact.
      failed.push({ target: file.target, error: `initializer script not found: ${file.initializer}` });
      continue;
    }
    let staleBackupDir = null;
    let staleBackupPath = null;
    if (exists) {
      // Move stale local state aside rather than deleting it. If launching the
      // initializer fails, restore it so a failed install is non-destructive.
      try {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- dest comes from resolveSourcePath after manifest containment validation.
        staleBackupDir = fs.mkdtempSync(path.join(path.dirname(dest), '.agentbootup-init-'));
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- staleBackupDir is created above, not manifest-controlled.
        staleBackupPath = path.join(staleBackupDir, 'prior-target');
        fs.renameSync(dest, staleBackupPath);
      } catch (err) {
        failed.push({ target: file.target, error: `could not preserve stale target: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
    }
    try {
      runInitializer(scriptPath, dest);
      ran.push(file.target);
      if (staleBackupDir) preserved.push({ target: file.target, dir: staleBackupDir, path: staleBackupPath });
    } catch (err) {
      // WO §2 (roborev r5): clean up partial output so retries can re-run.
      // If the initializer wrote a partial file before failing, existsSync(dest)
      // would return true on retry and skip the initializer — leaving corrupted
      // state permanently. Remove the target on failure (recursive in case the
      // initializer created a directory instead of a file).
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
      let preservedRestoreFailed = false;
      if (staleBackupPath) {
        try { fs.renameSync(staleBackupPath, dest); } catch { preservedRestoreFailed = true; }
      }
      if (staleBackupDir && !preservedRestoreFailed) {
        try { fs.rmSync(staleBackupDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      const restoreHint = preservedRestoreFailed
        ? `; prior target preserved at ${staleBackupPath}`
        : '';
      failed.push({ target: file.target, error: `${err instanceof Error ? err.message : String(err)}${restoreHint}` });
    }
  }
  return { ran, failed, preserved };
}

/**
 * Verify every required manifest target exists in the target tree. The install
 * ledger records that a bundle was applied, not that its files are still there;
 * this check is what detects post-install erosion (e.g. a destructive git clean
 * removing untracked runtime payload).
 */
export function verifyRequiredTargets(manifest, targetRoot) {
  const missing = [];
  for (const file of manifest.files) {
    // WO §2: generated_state is NOT required at install (created at runtime).
    if (file.role === 'generated_state') continue;
    // WO §2: required_data implies "must be present at target" even if the
    // `required` boolean is not explicitly true.
    if (!file.required && file.role !== 'required_data') continue;
    const dest = resolveSourcePath(targetRoot, file.target);
    // isFile(), not existsSync(): a leftover directory at a required target path
    // (partial clean, or a tool that recreates structure but not contents) would
    // otherwise pass as present — a silent false negative in the very check this
    // function exists to make. Mirrors the isFile() validation on the source side.
    let present = false;
    try {
      present = fs.statSync(dest).isFile();
    } catch {
      present = false;
    }
    if (!present) {
      missing.push({
        target: file.target,
        kind: file.kind ?? null,
        role: file.role ?? null,
        runtime: isRuntimeFileEntry(file),
      });
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * The manifest to verify a target tree against, given what the ledger says was
 * installed: when the prior install materialized .agents mirrors, those targets are
 * part of the installed contract and must be verified too — keyed on installed
 * state, never on the current request's flags.
 */
function verificationManifestForState(manifest, stateValue) {
  // Only reconstruct materialized targets from THIS manifest when the ledger entry is
  // for this exact version — expanding a newer manifest against an older install would
  // demand .agents mirrors that were never written. (Persisting the exact installed
  // target set is the ledger-design track; this stays reconstruction-based until then.)
  const priorMaterialized =
    Array.isArray(stateValue?.materialized_targets) &&
    stateValue.materialized_targets.length > 0 &&
    stateValue.version_id === manifest.version_id;
  return priorMaterialized ? buildEffectiveInstallManifest(manifest, { materializeAgents: true }) : manifest;
}

export function collectTaxonomyWarnings(manifest) {
  const warnings = [];
  // memory_snapshot bundles use kind:state / role:state_seed as first-class values
  // (same bundle-type gate as computeInlineBundleHash / computeBundleHash).
  // Publish validates roles before reaching this diagnostic. Retain the role check for
  // direct callers and as defense in depth if a future call site reports before validating.
  const isMemorySnapshot = manifest.bundle_type === 'memory_snapshot';
  manifest.files.forEach((file, index) => {
    const kindOk = (isMemorySnapshot && file.kind === 'state') || file.kind == null || KNOWN_FILE_KINDS.has(file.kind);
    const validRoles = isMemorySnapshot ? VALID_MEMORY_SNAPSHOT_FILE_ROLES : VALID_FILE_ROLES;
    const roleOk = file.role == null || validRoles.has(file.role);
    if (!kindOk) {
      warnings.push(`files[${index}] (${file.target}): unknown kind "${file.kind}"`);
    }
    if (!roleOk) {
      warnings.push(`files[${index}] (${file.target}): unknown role "${file.role}"`);
    }
  });
  return warnings;
}

/**
 * Erosion means "THIS manifest version landed and its payload later vanished". A state
 * file alone does not prove that, and neither does a status:
 *  - `failed`      — a first install that never landed (version_id null); targets were
 *                    never written, so absence is expected, not erosion.
 *  - `rolled_back` — either restored to nothing (version_id null) or restored a
 *                    *different* version; this manifest's files are intentionally absent.
 * Only a ledger entry recording this exact version_id as currently on disk warrants
 * target verification.
 */
export function isVersionInstalled(stateValue, manifest) {
  if (!stateValue || stateValue.version_id !== manifest.version_id) return false;
  return stateValue.status === 'applied' || stateValue.status === 'rolled_back';
}

export function bundleStatus({ manifest, sourceRoot, targetRoot, agentId }) {
  const computedHash = computeBundleHash(manifest, sourceRoot);
  const state = readInstalledState(manifest, targetRoot, agentId);
  const everApplied = isVersionInstalled(state.value, manifest);
  const targets = everApplied
    ? verifyRequiredTargets(verificationManifestForState(manifest, state.value), targetRoot)
    : { ok: true, missing: [] };
  // Status is intentionally passive, but an applied ledger entry is only a claim:
  // prove its payload bytes still match the manifest as well as checking erosion.
  // Keep source and target hash outcomes distinct so an operator can tell whether
  // the artifact itself drifted or the installed checkout did.
  const installedPayload = everApplied
    ? computeInstalledPayloadHash(manifest, targetRoot, manifestSelfSources(manifest, sourceRoot))
    : { hash: null, missing: [] };
  const payloadHashStatus = !everApplied
    ? 'NOT_APPLIED'
    : installedPayload.hash === manifest.bundle_hash
      ? 'OK'
      : 'DRIFT';
  // Self-managed pin: a repo that commits its own PROTOCOL amendment has intentionally
  // diverged from canonical. Keep hash_status as the pure SOURCE hash (a self-managed repo
  // can still have a genuinely drifted source artifact — that must stay visible). Surface
  // the self-managed state on the TARGET-facing fields, and ONLY for protocol_bundle — a
  // protocol pin must not hide skill-bundle drift (which is still actionable via install).
  // SELF_MANAGED replaces only the DRIFT case (intentional content divergence with all
  // required files present); it must NOT mask MISSING_REQUIRED (eroded files) — a pinned
  // repo whose protocol files are actually gone still needs that erosion surfaced.
  // Read fail-open: a malformed marker is not a pin, so DRIFT still surfaces normally.
  const selfManagedMarker = readSelfManaged(targetRoot);
  const selfManaged = selfManagedMarker?.enabled === true;
  const selfManagedProtocol = selfManaged && manifest.bundle_type === 'protocol_bundle';
  const intentionalDivergence = selfManagedProtocol && payloadHashStatus === 'DRIFT';
  const targetStatus = !everApplied
    ? 'NOT_APPLIED'
    : !targets.ok
      ? 'MISSING_REQUIRED'
      : intentionalDivergence
        ? 'SELF_MANAGED'
        : payloadHashStatus === 'OK' ? 'OK' : 'DRIFT';
  const installedPayloadHashStatus = !everApplied
    ? 'NOT_APPLIED'
    : !targets.ok
      ? payloadHashStatus
      : intentionalDivergence
        ? 'SELF_MANAGED'
        : payloadHashStatus;
  return {
    bundle_type: manifest.bundle_type,
    bundle_name: manifest.bundle_name,
    bundle_version: manifest.bundle_version,
    version_id: manifest.version_id,
    distribution_mode: manifest.distribution.mode,
    source_root: sourceRoot,
    target_root: targetRoot,
    file_count: manifest.files.length,
    manifest_hash: manifest.bundle_hash,
    actual_hash: computedHash,
    hash_status: manifest.bundle_hash === computedHash ? 'OK' : 'DRIFT',
    self_managed: selfManaged,
    ...(selfManaged ? { self_managed_reason: selfManagedMarker.reason } : {}),
    installed: Boolean(state.value),
    installed_state_path: state.path,
    installed_state: state.value,
    agent_id: state.agentId,
    target_status: targetStatus,
    missing_required_targets: targets.missing.map((entry) => entry.target),
    installed_payload_hash: installedPayload.hash,
    installed_payload_hash_status: installedPayloadHashStatus,
    missing_payload_targets: installedPayload.missing,
  };
}

// PRD-0047 §7 Task 2.3: content hash is identity; the version string is for humans.
// Refuse to publish changed content (a differing bundle_hash) under an unchanged
// bundle_version — the defect behind `ohok/agent-loop` vs `decisive/agent-loop`.
// Scans previously-published versions of the same bundle in the local store.
// O(published versions): reads each prior version's manifest for this bundle. Fine at
// fleet scale, and consistent with the "per-host heuristic, not authority" framing — the
// authoritative version identity is the lock/registry (decisive's Phase-1).
function assertVersionContentIdentity(manifest) {
  const bundleDir = path.join(
    getBundleStoreRoot(),
    manifest.bundle_type,
    sanitizeSegment(manifest.bundle_name),
  );
  if (!fs.existsSync(bundleDir)) return;
  for (const entry of fs.readdirSync(bundleDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const priorPath = path.join(bundleDir, entry.name, 'bundle-manifest.json');
    if (!fs.existsSync(priorPath)) continue;
    let prior;
    try {
      prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'));
    } catch {
      continue; // A corrupt prior manifest is not authority to block a fresh publish.
    }
    if (prior.bundle_version === manifest.bundle_version && prior.bundle_hash !== manifest.bundle_hash) {
      throw new Error(
        [
          `Refusing publish: content changed under an unchanged bundle_version.`,
          `  bundle:        ${manifest.bundle_name}`,
          `  bundle_version: ${manifest.bundle_version} (already published with different content)`,
          `  published hash: ${prior.bundle_hash}`,
          `  new hash:       ${manifest.bundle_hash}`,
          `Bump bundle_version — content hash is identity, the version string is for humans.`,
        ].join('\n'),
      );
    }
  }
}

export function publishBundle({ manifest, rawManifest, sourceRoot, dryRun = false }) {
  // Fail-closed at the mutating gate (PRD-0047 §7). Validate BOTH: `manifest` is what
  // actually gets hashed and published, so it must pass regardless; `rawManifest` (when
  // the caller has it) additionally catches raw-vs-normalized coercion (validation.commands,
  // non-string install paths) that normalization would otherwise mask. Validating only raw
  // would let a caller that mutated the normalized manifest bypass the gate.
  validateManifestSchema(manifest, { label: manifest.bundle_name });
  if (rawManifest && rawManifest !== manifest) {
    validateManifestSchema(rawManifest, { label: manifest.bundle_name });
  }
  assertVersionContentIdentity(manifest);

  const computedHash = computeBundleHash(manifest, sourceRoot);
  if (computedHash !== manifest.bundle_hash) {
    throw new Error(
      `Bundle hash mismatch.\nExpected: ${manifest.bundle_hash}\nActual:   ${computedHash}\nRefuse publish until manifest is updated.`,
    );
  }

  const publishRoot = path.join(
    getBundleStoreRoot(),
    manifest.bundle_type,
    sanitizeSegment(manifest.bundle_name),
    sanitizeSegment(manifest.version_id),
  );
  const payloadRoot = path.join(publishRoot, 'payload');

  if (!dryRun) {
    fs.mkdirSync(payloadRoot, { recursive: true });
    for (const file of manifest.files) {
      // WO §2: runtime-state roles are NOT in the source bundle — skip publish copy.
      if (file.role && RUNTIME_STATE_ROLES.has(file.role)) continue;
      const source = resolveSourcePath(sourceRoot, file.source);
      if (!fs.existsSync(source)) {
        if (file.required) {
          throw new Error(`Required source file missing during publish: ${file.source}`);
        }
        continue;
      }
      const dest = path.join(payloadRoot, file.source);
      ensureParent(dest);
      fs.cpSync(source, dest);
    }
    fs.writeFileSync(path.join(publishRoot, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  return {
    publish_root: publishRoot,
    payload_root: payloadRoot,
    file_count: manifest.files.length,
    dry_run: dryRun,
    taxonomy_warnings: collectTaxonomyWarnings(manifest),
  };
}

export function installBundle({
  manifest,
  sourceRoot,
  targetRoot,
  force = false,
  dryRun = false,
  agentId,
  skipValidation = false,
  materializeAgents = false,
  hostedInitializerTargets = undefined,
  dryRunProvidedTargets = undefined,
  postApplyGuard = undefined,
  rawManifest,
}) {
  // Fail-closed at the mutating gate (PRD-0047 §7). Validate BOTH: `manifest` is what
  // actually gets installed (hashed, copied, mutated, commands run), so it must pass
  // regardless; `rawManifest` (when the caller has it) additionally catches raw-vs-
  // normalized coercion before any write. installBundle is the shared funnel for cli
  // install, rollout, hosted sync, and memory restore.
  validateManifestSchema(manifest, { label: manifest.bundle_name });
  if (rawManifest && rawManifest !== manifest) {
    validateManifestSchema(rawManifest, { label: manifest.bundle_name });
  }

  const computedHash = computeBundleHash(manifest, sourceRoot);
  if (computedHash !== manifest.bundle_hash) {
    throw new Error(
      `Bundle hash mismatch.\nExpected: ${manifest.bundle_hash}\nActual:   ${computedHash}\nRefuse install until manifest is updated.`,
    );
  }

  const current = readInstalledState(manifest, targetRoot, agentId);
  const normalizedHostedInitializerTargets = normalizeHostedInitializerTargets(hostedInitializerTargets);
  let repairDrift = null;
  if (!force && current.value?.version_id === manifest.version_id) {
    // The ledger says this version is installed, but the ledger records intent, not
    // state: verify the required payload is actually still on disk before trusting it.
    // A silent no-op here is how an eroded runtime stays "installed" forever
    // (mech-browse bug). Materialized .agents targets are verified iff the ledger says
    // the prior install wrote them — keyed on installed state, not the request's flag.
    const targets = isVersionInstalled(current.value, manifest)
      ? verifyRequiredTargets(verificationManifestForState(manifest, current.value), targetRoot)
      : { ok: true, missing: [] };
    if (!targets.ok) {
      const nonRuntimeStateTargets = targets.missing.filter((entry) => entry.role !== 'required_data');
      if (nonRuntimeStateTargets.length > 0) {
        const lines = targets.missing.map(
          (entry) => `  - ${entry.target}${entry.runtime ? ' (runtime)' : ''}`,
        );
        throw new Error(
          [
            `Ledger says ${manifest.bundle_name}@${manifest.bundle_version} is installed, but required target file(s) are missing (eroded):`,
            ...lines,
            'Review local changes in the target, then repair with: bundle install --force',
          ].join('\n'),
        );
      }
      // A missing required_data target can be repaired by a trusted initializer,
      // but must not turn an unrelated payload edit into an implicit overwrite.
      // Runtime-state roles are excluded from this hash, so it distinguishes the
      // safe "only state eroded" case from payload drift without requiring force.
      const installed = computeInstalledPayloadHash(manifest, targetRoot, manifestSelfSources(manifest, sourceRoot));
      if (installed.hash !== manifest.bundle_hash) {
        const lines = targets.missing.map(
          (entry) => `  - ${entry.target}${entry.runtime ? ' (runtime)' : ''}`,
        );
        throw new Error(
          [
            `Ledger says ${manifest.bundle_name}@${manifest.bundle_version} is installed, but required target file(s) are missing or payload bytes drifted:`,
            ...lines,
            'Review local changes in the target, then repair with: bundle install --force',
          ].join('\n'),
        );
      }
      // Never let the ledger turn missing required_data into a no-op. Falling
      // through lets a trusted initializer repair it; without one, the normal
      // post-apply verification fails closed and rolls back.
      repairDrift = {
        expected_hash: manifest.bundle_hash,
        actual_hash: null,
        missing_targets: targets.missing.map((entry) => entry.target),
      };
    } else {
      // Hash the canonical payload described by the source manifest. Materialized
      // .agents mirrors are an installation-side projection and are checked for
      // existence above, but are not part of the source manifest's bundle_hash.
      const installed = computeInstalledPayloadHash(manifest, targetRoot, manifestSelfSources(manifest, sourceRoot));
      if (installed.hash === manifest.bundle_hash) {
        verifyManifestDependencies(manifest, targetRoot, dryRun);
        // Compare canonical target/hash tuples rather than JSON object order.
        // Provenance is a set of records, so source ordering is not meaningful.
        const hostedTargetsChanged = !hostedInitializerTargetsEqual(
          normalizedHostedInitializerTargets,
          current.value?.hosted_initializer_targets,
        );
        if (!dryRun && hostedInitializerTargets !== undefined && hostedTargetsChanged) {
          writeInstalledState(manifest, targetRoot, agentId, {
            ...current.value,
            hosted_initializer_targets: normalizedHostedInitializerTargets,
          }, false);
        }
        return {
          noop: true,
          reason: `Already installed: ${manifest.version_id}`,
          state_path: current.path,
          agent_id: current.agentId,
          materialized_targets: Array.isArray(current.value?.materialized_targets)
            ? [...current.value.materialized_targets]
            : [],
        };
      }
      repairDrift = {
        expected_hash: manifest.bundle_hash,
        actual_hash: installed.hash,
        missing_targets: installed.missing,
      };
    }
  }

  const backupVersionId =
    current.value?.version_id ?? `preinstall-${new Date().toISOString().replace(/[:]/g, '-')}`;
  const effectiveManifest = buildEffectiveInstallManifest(manifest, { materializeAgents });
  const reownedPayloadTargets = payloadTargetsWritten(effectiveManifest, sourceRoot);
  // Every attempt gets an immutable generation. Reusing the prior version's
  // directory would let a mid-copy failure mix new bytes with old metadata.
  const backup = backupBundle(
    effectiveManifest,
    targetRoot,
    agentId,
    uniqueBackupVersionId(backupVersionId),
    dryRun,
  );

  let dependencyInstall = null;
  // WO §2 (roborev r15): track initializer-created files so they can be cleaned up
  // on install failure. Without this, a failed install leaves stale files that
  // cause retries to skip initialization (existsSync returns true).
  let initCreatedFiles = [];
  let initPreservedTargets = [];
  try {
    dependencyInstall = installManifestDependenciesWithRollback(effectiveManifest, targetRoot, dryRun);
    const { dependencies } = dependencyInstall;
    applyBundle(effectiveManifest, sourceRoot, targetRoot, dryRun);
    // Hosted sync supplies a filesystem-identity guard here. It runs inside
    // this transaction so a detected write alias takes the ordinary rollback
    // path instead of leaving materialized bytes behind.
    if (typeof postApplyGuard === 'function') {
      postApplyGuard({ manifest: effectiveManifest, targetRoot, dryRun });
    }
    if (dryRun) {
      // A preview must not claim success when the real install would fail
      // before validation. Initializers are intentionally not executed here,
      // so only initializer-less required_data targets must already exist.
      const missingWithoutInitializer = effectiveManifest.files
        .filter((file) => file.role === 'required_data' && file.initializer == null)
        .filter((file) => !effectiveManifest.mutations.some(
          (mutation) => mutation.required !== false && mutation.path === file.target,
        ))
        .filter((file) => !(dryRunProvidedTargets instanceof Set && dryRunProvidedTargets.has(file.target)))
        .filter((file) => {
          try { return !fs.statSync(resolveSourcePath(targetRoot, file.target)).isFile(); } catch { return true; }
        })
        .map((file) => file.target);
      if (missingWithoutInitializer.length > 0) {
        throw new Error(
          `required_data file(s) missing with no initializer (fail-closed dry run): ${missingWithoutInitializer.join(', ')}`,
        );
      }
    } else {
      // WO §2: run initializers BEFORE validation — validation commands may check
      // the installed tree for required_data file completeness. A required_data
      // file with an initializer is created here; a required_data file WITHOUT an
      // initializer falls through to verifyRequiredTargets below and fails closed.
      const initResult = runInitializers(effectiveManifest, targetRoot);
      initCreatedFiles = initResult.ran;
      initPreservedTargets = initResult.preserved;
      if (initResult.failed.length > 0) {
        throw new Error(
          `Install initialization failed — required_data initializer(s) failed: ${initResult.failed
            .map((entry) => `${entry.target} (${entry.error})`)
            .join(', ')}`,
        );
      }
      // WO §2 (roborev r9): required_data files WITHOUT initializers must already
      // exist at this point — don't let validation commands manufacture them and
      // bypass the fail-closed contract. Check BEFORE runValidation.
      // WO §2 (roborev r14): check ALL required_data files, including those with
      // initializers — if the initializer ran but didn't create the file, catch it
      // here before validation can mask the failure.
      const preCheckMissing = [];
      for (const file of effectiveManifest.files) {
        if (file.role !== 'required_data') continue;
        const dest = resolveSourcePath(targetRoot, file.target);
        let present = false;
        try { present = fs.statSync(dest).isFile(); } catch { present = false; }
        if (!present) preCheckMissing.push(file.target);
      }
      if (preCheckMissing.length > 0) {
        throw new Error(
          `required_data file(s) missing with no initializer (fail-closed before validation): ${preCheckMissing.join(', ')}`,
        );
      }
    }
    const validation = runValidation(effectiveManifest, targetRoot, dryRun, skipValidation);
    if (!dryRun) {
      // Verify what actually landed before recording status:applied — a state file
      // must never claim success for payload that is not on disk.
      const targets = verifyRequiredTargets(effectiveManifest, targetRoot);
      if (!targets.ok) {
        throw new Error(
          `Install verification failed — required target file(s) missing after apply: ${targets.missing
            .map((entry) => entry.target)
            .join(', ')}`,
        );
      }
    }
    const retainedHostedInitializerTargets = normalizedHostedInitializerTargets !== undefined
      ? normalizedHostedInitializerTargets
      : Array.isArray(current.value?.hosted_initializer_targets)
        ? normalizeHostedInitializerTargets(current.value.hosted_initializer_targets)
        : undefined;
    const liveHostedInitializerTargets = normalizedHostedInitializerTargets !== undefined
      ? retainedHostedInitializerTargets
      : dropReownedHostedInitializerTargets(
        retainedHostedInitializerTargets,
        reownedPayloadTargets,
      );
    const nextState = {
      bundle_type: manifest.bundle_type,
      bundle_name: manifest.bundle_name,
      installed_version: manifest.bundle_version,
      version_id: manifest.version_id,
      bundle_hash: manifest.bundle_hash,
      source_repo: manifest.source?.repo ?? 'unknown',
      applied_at: dryRun ? null : new Date().toISOString(),
      previous_version: current.value?.installed_version ?? null,
      previous_version_id: current.value?.version_id ?? null,
      backup_path: backup.path,
      status: 'applied',
      validation: {
        skipped: skipValidation,
        command_count: manifest.validation.commands.length,
      },
      dependencies: manifest.dependencies,
      materialized_targets: effectiveManifest !== manifest ? [AGENTS_SKILL_TARGET_ROOT] : [],
      ...(liveHostedInitializerTargets !== undefined
        ? { hosted_initializer_targets: liveHostedInitializerTargets }
        : {}),
    };
    const state = writeInstalledState(manifest, targetRoot, agentId, nextState, dryRun);
    // The installed-state write is part of the transaction. Keep preserved
    // stale targets recoverable until it succeeds; otherwise the catch path
    // below can restore the original target if state persistence fails.
    for (const preserved of initPreservedTargets) {
      try { fs.rmSync(preserved.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    initPreservedTargets = [];
    // Return per-command validation outcomes to the caller; the installed state persists
    // only a compact audit summary because command stdout/stderr can be bulky and transient.
    return {
      noop: false,
      installed: true,
      dry_run: dryRun,
      backup_path: backup.path,
      state_path: state.path,
      validation,
      dependencies,
      agent_id: backup.agentId,
      version_id: manifest.version_id,
      effective_manifest: effectiveManifest,
      repaired_drift: repairDrift,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // WO §2 (roborev r15): clean up initializer-created files on failure so retries
    // can re-run cleanly. Without this, a failed install leaves stale files that
    // cause retries to skip initialization (existsSync returns true).
    for (const target of initCreatedFiles) {
      try { fs.rmSync(resolveSourcePath(targetRoot, target), { recursive: true, force: true }); } catch { /* best effort */ }
    }
    for (const preserved of initPreservedTargets) {
      try { fs.rmSync(resolveSourcePath(targetRoot, preserved.target), { recursive: true, force: true }); } catch { /* best effort */ }
      let restored = false;
      try {
        fs.renameSync(preserved.path, resolveSourcePath(targetRoot, preserved.target));
        restored = true;
      } catch { /* retain the backup directory for manual recovery */ }
      if (restored) {
        try { fs.rmSync(preserved.dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    restoreBackup(effectiveManifest, targetRoot, backup.path, backup.entries, dryRun);
    restoreDependencyBackup(targetRoot, backup.path, backup.dependencyEntries, dryRun);
    const rolledBackState = {
      bundle_type: manifest.bundle_type,
      bundle_name: manifest.bundle_name,
      installed_version: current.value?.installed_version ?? null,
      version_id: current.value?.version_id ?? null,
      bundle_hash: current.value?.bundle_hash ?? null,
      source_repo: current.value?.source_repo ?? manifest.source?.repo ?? 'unknown',
      applied_at: current.value?.applied_at ?? null,
      previous_version: current.value?.previous_version ?? null,
      previous_version_id: current.value?.previous_version_id ?? null,
      ...(Array.isArray(current.value?.hosted_initializer_targets)
        ? { hosted_initializer_targets: current.value.hosted_initializer_targets }
        : {}),
      backup_path: backup.path,
      status: current.value ? 'rolled_back' : 'failed',
      last_attempt: {
        version_id: manifest.version_id,
        bundle_version: manifest.bundle_version,
        ...(current.value
          ? { rolled_back_at: new Date().toISOString() }
          : { failed_at: new Date().toISOString() }),
        error: message,
      },
    };
    writeInstalledState(manifest, targetRoot, agentId, rolledBackState, dryRun);
    throw new Error(message);
  }
}

export function rollbackBundle({ manifest, targetRoot, dryRun = false, agentId }) {
  const current = readInstalledState(manifest, targetRoot, agentId);
  if (!current.value?.backup_path) {
    throw new Error(`No backup_path recorded for ${manifest.bundle_name}`);
  }
  const metaPath = path.join(current.value.backup_path, 'backup-metadata.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error(`Backup metadata missing: ${metaPath}`);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  restoreBackup(manifest, targetRoot, current.value.backup_path, meta.entries ?? [], dryRun);
  restoreDependencyBackup(targetRoot, current.value.backup_path, meta.dependency_entries, dryRun);
  const nextState = {
    bundle_type: manifest.bundle_type,
    bundle_name: manifest.bundle_name,
    installed_version: current.value.previous_version ?? null,
    version_id: current.value.previous_version_id ?? null,
    bundle_hash: null,
    source_repo: current.value.source_repo,
    applied_at: current.value.applied_at,
    previous_version: null,
    previous_version_id: null,
    backup_path: current.value.backup_path,
    status: 'rolled_back',
    last_attempt: {
      version_id: current.value.version_id ?? manifest.version_id,
      bundle_version: current.value.installed_version ?? manifest.bundle_version,
      rolled_back_at: new Date().toISOString(),
    },
  };
  const state = writeInstalledState(manifest, targetRoot, agentId, nextState, dryRun);
  return {
    rolled_back: true,
    dry_run: dryRun,
    backup_path: current.value.backup_path,
    state_path: state.path,
    agent_id: current.agentId,
  };
}

function walkFiles(absDir, outRel, root) {
  if (!fs.existsSync(absDir)) return;
  const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = path.relative(root, abs).replaceAll('\\', '/');
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      walkFiles(abs, outRel, root);
    } else if (entry.isFile()) {
      outRel.push(rel);
    }
  }
}

export function createMemorySnapshotManifest({ targetRoot, snapshotId, files, sourceRepo = 'local', commit = null, agentId: requestedAgentId = null }) {
  const agentId = requestedAgentId || resolveAgentId(targetRoot);
  const bundleName = agentId;
  const bundleVersion = snapshotId;
  const normalizedFiles = [...files].sort();
  const pendingManifest = normalizeBundleManifest({
    bundle_type: 'memory_snapshot',
    bundle_name: bundleName,
    bundle_version: bundleVersion,
    version_id: `${bundleName}@${bundleVersion}+sha256_pending`,
    bundle_hash: 'sha256:pending',
    source: {
      repo: sourceRepo,
      commit,
      generated_at: new Date().toISOString(),
      agent_id: agentId,
    },
    distribution: {
      mode: 'snapshot',
    },
    files: normalizedFiles.map((rel) => ({
      source: rel,
      target: rel,
      kind: 'state',
      required: true,
      role: rel === 'memory/MEMORY.md' ? 'entrypoint' : 'state_seed',
    })),
  });
  const bundleHash = computeBundleHash(pendingManifest, targetRoot);
  return normalizeBundleManifest({
    ...pendingManifest,
    bundle_hash: bundleHash,
    version_id: `${bundleName}@${bundleVersion}+sha256_${bundleHash.replace('sha256:', '').slice(0, 8)}`,
  });
}

export function collectTrustedInternalMemoryFiles(targetRoot) {
  const absMemoryRoot = path.join(path.resolve(targetRoot), 'memory');
  const files = [];
  walkFiles(absMemoryRoot, files, path.resolve(targetRoot));
  return files.filter((rel) => rel.startsWith('memory/')).sort();
}

/**
 * Collect the operator-selected memory publication set. Payload roots and
 * replay inventories must use collectTrustedInternalMemoryFiles explicitly.
 */
export function collectMemoryFiles(targetRoot, operation = 'memory snapshot') {
  return collectSelectedMemoryPaths(targetRoot, operation, { allowEmpty: true })
    .filter(isPublishableMemoryPath);
}
