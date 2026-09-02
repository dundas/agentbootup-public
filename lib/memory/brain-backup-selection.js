import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSecretGuard } from '../brain/secret-guard.js';
import { isValidBrainId } from '../config/brain-id.js';
import { getAgentId } from '../project-config.js';

export const BRAIN_BACKUP_SCHEMA = 'brain-backup/1';
export const BRAIN_BACKUP_FILENAME = 'brain-backup.json';
export const BRAIN_IGNORE_FILENAME = '.brainignore';

const VALID_CLASSES = new Set(['canonical', 'attachment', 'configuration', 'private']);
const MANIFEST_FIELDS = new Set(['schema', 'brain_id', 'include']);
const INCLUDE_FIELDS = new Set(['path', 'class']);
const FILE_TYPE_MASK = BigInt(fs.constants.S_IFMT);
// Keep policy input small enough for operator review and portable filesystems.
const MAX_SELECTOR_LENGTH = 512;
// Prevent adversarial policies from multiplying matcher branches.
const MAX_SELECTOR_WILDCARDS = 64;
// Bound inventory work independently of host-specific path length ceilings.
const MAX_CANDIDATE_PATH_LENGTH = 4096;
// Exclusive ceiling above the maximum selector/candidate state-space product.
const MAX_GLOB_STATES = (
  (MAX_SELECTOR_LENGTH + 1) * (MAX_CANDIDATE_PATH_LENGTH + 1)
) + 1;

// Test-only, scoped one-shot seam for deterministic TOCTOU regression coverage.
let identityReadTestHook = null;

export function __withBrainBackupSelectionIdentityReadTestHook(hook, operation) {
  if (process.env.NODE_ENV !== 'test' || process.env.AGENTBOOTUP_ALLOW_TEST_SESSION !== '1') {
    throw new Error(
      '__withBrainBackupSelectionIdentityReadTestHook requires ' +
      'NODE_ENV=test and AGENTBOOTUP_ALLOW_TEST_SESSION=1',
    );
  }
  if (
    !hook ||
    typeof hook !== 'object' ||
    !['beforeOpen', 'afterRead'].includes(hook.phase) ||
    !['policy', 'selected'].includes(hook.kind) ||
    typeof hook.path !== 'string' ||
    typeof hook.run !== 'function'
  ) {
    throw new TypeError('brain backup selection identity-read test hook is invalid');
  }
  if (typeof operation !== 'function') {
    throw new TypeError('brain backup selection identity-read test operation must be a function');
  }
  if (identityReadTestHook !== null) {
    throw new Error('brain backup selection identity-read test hook is already active');
  }

  identityReadTestHook = hook;
  try {
    return operation();
  } finally {
    if (identityReadTestHook === hook) identityReadTestHook = null;
  }
}

function fail(message) {
  throw new Error(`brain backup selection: ${message}`);
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFingerprint(actual, expected) {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && (actual.mode & FILE_TYPE_MASK) === (expected.mode & FILE_TYPE_MASK)
    && actual.size === expected.size
    && actual.mtimeNs === expected.mtimeNs
    && actual.ctimeNs === expected.ctimeNs;
}

function assertIdentity(actual, expected, label) {
  if (!sameFingerprint(actual, expected)) {
    fail(`${label} changed identity during selection`);
  }
}

function runIdentityReadTestHook(kind, phase, file, label) {
  const hook = identityReadTestHook;
  if (!hook || hook.kind !== kind || hook.phase !== phase || hook.path !== file.absolute) return;

  // Clear before invoking user-supplied test code so re-entrant selection cannot
  // reuse a hook intended for one exact read boundary.
  identityReadTestHook = null;
  hook.run({ kind, phase, label, path: file.absolute });
}

function assertContainedPath(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} escapes the project root`);
  }
}

function captureAncestors(root, filePath, rootStat, label) {
  assertContainedPath(root, filePath, label);
  const relativeParent = path.relative(root, path.dirname(filePath));
  const ancestors = [{ path: root, stat: rootStat }];
  let current = root;
  if (relativeParent) {
    for (const segment of relativeParent.split(path.sep)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink()) fail(`${label} has a symlinked ancestor`);
      if (!stat.isDirectory()) fail(`${label} has a non-directory ancestor`);
      ancestors.push({ path: current, stat });
    }
  }
  return ancestors;
}

function assertAncestorsUnchanged(ancestors, label) {
  for (const ancestor of ancestors) {
    let actual;
    try {
      actual = fs.lstatSync(ancestor.path, { bigint: true });
    } catch (error) {
      const detail = error?.code === 'ENOENT' ? 'was deleted' : 'became inaccessible';
      fail(`${label} ancestor ${detail} during selection`);
    }
    if (actual.isSymbolicLink() || !actual.isDirectory()) {
      fail(`${label} has a symlinked or non-directory ancestor`);
    }
    assertIdentity(actual, ancestor.stat, `${label} ancestor`);
  }
}

function validatedRegularFile(root, filePath, rootStat, label, optional = false) {
  const stat = lstatIfPresent(filePath);
  if (!stat) {
    if (optional) return null;
    fail(`${label} disappeared during selection`);
  }
  if (stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  if (!stat.isFile()) fail(`${label} must be a regular file`);
  return {
    absolute: filePath,
    stat,
    ancestors: captureAncestors(root, filePath, rootStat, label),
  };
}

function readValidatedRegularFile(file, label, kind) {
  assertAncestorsUnchanged(file.ancestors, label);
  runIdentityReadTestHook(kind, 'beforeOpen', file, label);

  // O_NOFOLLOW is an additional kernel guard where available. On platforms
  // without it, the captured lstat identity is still checked against fstat
  // immediately after open and again after the read, so a followed replacement
  // cannot satisfy the expected fingerprint.
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(file.absolute, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    fail(`${label} could not be opened safely (${error instanceof Error ? error.message : String(error)})`);
  }

  try {
    const openedStat = fs.fstatSync(descriptor, { bigint: true });
    if (!openedStat.isFile()) fail(`${label} must remain a regular file`);
    assertIdentity(openedStat, file.stat, label);

    const bytes = fs.readFileSync(descriptor);
    runIdentityReadTestHook(kind, 'afterRead', file, label);

    const completedStat = fs.fstatSync(descriptor, { bigint: true });
    assertIdentity(completedStat, file.stat, label);
    assertAncestorsUnchanged(file.ancestors, label);
    const currentStat = fs.lstatSync(file.absolute, { bigint: true });
    if (currentStat.isSymbolicLink() || !currentStat.isFile()) {
      fail(`${label} changed to a non-regular or symlink file during selection`);
    }
    assertIdentity(currentStat, file.stat, label);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('brain backup selection:')) throw error;
    fail(`${label} could not be read safely (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    fs.closeSync(descriptor);
  }
}

// Canonical inventories sort by raw UTF-16 code units, never host locale, so
// the same checkout produces identical order on every machine.
function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertKnownFields(value, allowedFields, label) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) fail(`${label} contains unsupported field ${JSON.stringify(field)}`);
  }
}

/**
 * Policy paths are deliberately stricter than general repo-relative paths.
 * Normalizing invalid input would make two differently-authored policies mean
 * the same thing and could conceal traversal or portability mistakes.
 */
function assertPolicyGlob(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty selector path`);
  }
  if (value.length > MAX_SELECTOR_LENGTH) {
    fail(`${label} exceeds ${MAX_SELECTOR_LENGTH} characters`);
  }
  const wildcardCount = [...value].filter((character) => character === '*' || character === '?').length;
  if (wildcardCount > MAX_SELECTOR_WILDCARDS) {
    fail(`${label} exceeds ${MAX_SELECTOR_WILDCARDS} wildcard characters`);
  }
  if (
    // `!` is reserved by schema brain-backup/1. A future meaning requires a
    // schema bump rather than silently reinterpreting an existing policy.
    value.startsWith('!') ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail(`${label} is not a valid selector path: ${JSON.stringify(value)}`);
  }

  const segments = value.split('/');
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    segments[0] !== 'memory' ||
    segments.length < 2
  ) {
    fail(`${label} is not a normalized path contained under memory/: ${JSON.stringify(value)}`);
  }
  return value;
}

function globMatches(glob, candidate) {
  // All production callers pass selectors through assertPolicyGlob first.
  // Retain a local contract guard so future internal call sites fail loudly.
  if (typeof glob !== 'string' || glob.length === 0 || glob.length > MAX_SELECTOR_LENGTH) {
    fail(`matcher requires a non-empty selector of at most ${MAX_SELECTOR_LENGTH} characters`);
  }
  if (candidate.length > MAX_CANDIDATE_PATH_LENGTH) {
    fail(`memory inventory path exceeds ${MAX_CANDIDATE_PATH_LENGTH} characters`);
  }
  // Treat matching as reachability through a finite state graph. An explicit
  // stack avoids consuming the JavaScript call stack for long valid paths.
  const candidateWidth = candidate.length + 1;
  const pending = [[0, 0]];
  const seen = new Set();
  let visitedStates = 0;

  while (pending.length > 0) {
    const [globIndex, candidateIndex] = pending.pop();
    const key = globIndex * candidateWidth + candidateIndex;
    if (seen.has(key)) continue;
    seen.add(key);
    visitedStates += 1;
    if (visitedStates >= MAX_GLOB_STATES) {
      fail(`selector match exceeds ${MAX_GLOB_STATES} bounded states`);
    }

    if (globIndex === glob.length) {
      if (candidateIndex === candidate.length) return true;
    } else if (glob.startsWith('**/', globIndex)) {
      pending.push([globIndex + 3, candidateIndex]);
      if (candidateIndex < candidate.length) pending.push([globIndex, candidateIndex + 1]);
    } else if (glob.startsWith('**', globIndex)) {
      pending.push([globIndex + 2, candidateIndex]);
      if (candidateIndex < candidate.length) pending.push([globIndex, candidateIndex + 1]);
    } else if (glob[globIndex] === '*') {
      pending.push([globIndex + 1, candidateIndex]);
      if (candidateIndex < candidate.length && candidate[candidateIndex] !== '/') {
        pending.push([globIndex, candidateIndex + 1]);
      }
    } else if (glob[globIndex] === '?') {
      if (candidateIndex < candidate.length && candidate[candidateIndex] !== '/') {
        pending.push([globIndex + 1, candidateIndex + 1]);
      }
    } else if (candidate[candidateIndex] === glob[globIndex]) {
      pending.push([globIndex + 1, candidateIndex + 1]);
    }
  }

  return false;
}

function readManifest(root, rootStat) {
  const manifestPath = path.join(root, BRAIN_BACKUP_FILENAME);
  const manifestFile = validatedRegularFile(
    root,
    manifestPath,
    rootStat,
    BRAIN_BACKUP_FILENAME,
    true,
  );
  if (!manifestFile) return null;

  const manifestBytes = readValidatedRegularFile(
    manifestFile,
    BRAIN_BACKUP_FILENAME,
    'policy',
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail(`${BRAIN_BACKUP_FILENAME} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`${BRAIN_BACKUP_FILENAME} schema requires an object`);
  }
  assertKnownFields(manifest, MANIFEST_FIELDS, BRAIN_BACKUP_FILENAME);
  if (manifest.schema !== BRAIN_BACKUP_SCHEMA) {
    fail(`${BRAIN_BACKUP_FILENAME} schema must be "${BRAIN_BACKUP_SCHEMA}"`);
  }
  if (typeof manifest.brain_id !== 'string' || !manifest.brain_id.trim()) {
    fail(`${BRAIN_BACKUP_FILENAME} schema requires a non-empty brain_id`);
  }
  if (manifest.brain_id !== manifest.brain_id.trim()) {
    fail(`${BRAIN_BACKUP_FILENAME} brain_id must be normalized`);
  }
  if (!isValidBrainId(manifest.brain_id)) {
    fail(`${BRAIN_BACKUP_FILENAME} brain_id is not a valid project brain identifier`);
  }
  const projectBrainId = getAgentId(root);
  if (projectBrainId && manifest.brain_id !== projectBrainId) {
    fail(`${BRAIN_BACKUP_FILENAME} brain_id "${manifest.brain_id}" does not match project brain "${projectBrainId}"`);
  }
  if (!Array.isArray(manifest.include)) {
    fail(`${BRAIN_BACKUP_FILENAME} schema requires an include array`);
  }

  const seen = new Set();
  const include = manifest.include.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`include[${index}] must be an object`);
    }
    assertKnownFields(entry, INCLUDE_FIELDS, `include[${index}]`);
    const selector = assertPolicyGlob(entry.path, `include[${index}] selector path`);
    if (seen.has(selector)) fail(`duplicate selector path: ${selector}`);
    seen.add(selector);
    if (!VALID_CLASSES.has(entry.class)) {
      fail(`include[${index}].class must be canonical, attachment, configuration, or private`);
    }
    return { path: selector, class: entry.class, matches: (candidate) => globMatches(selector, candidate) };
  });

  return { schema: manifest.schema, brain_id: manifest.brain_id, include };
}

function readIgnoreRules(root, rootStat) {
  const ignorePath = path.join(root, BRAIN_IGNORE_FILENAME);
  const ignoreFile = validatedRegularFile(
    root,
    ignorePath,
    rootStat,
    BRAIN_IGNORE_FILENAME,
    true,
  );
  if (!ignoreFile) return [];

  const rules = [];
  const contents = readValidatedRegularFile(ignoreFile, BRAIN_IGNORE_FILENAME, 'policy').toString('utf8');
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      fail(`${BRAIN_IGNORE_FILENAME} negation is not allowed (line ${index + 1})`);
    }
    const glob = assertPolicyGlob(line, `${BRAIN_IGNORE_FILENAME} line ${index + 1} selector path`);
    rules.push({ path: glob, matches: (candidate) => globMatches(glob, candidate) });
  }
  return rules;
}

function inventoryMemory(root, rootStat) {
  const memoryRoot = path.join(root, 'memory');
  const memoryStat = lstatIfPresent(memoryRoot);
  if (!memoryStat) return [];
  if (memoryStat.isSymbolicLink()) fail('memory root is a symlink');
  if (!memoryStat.isDirectory()) fail('memory must be a directory');

  const files = [];
  const memoryAncestors = captureAncestors(root, path.join(memoryRoot, '.inventory'), rootStat, 'memory inventory');
  function walk(directory, relativeDirectory, ancestors) {
    assertAncestorsUnchanged(ancestors, `memory/${relativeDirectory || ''}`);
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const repositoryPath = `memory/${relative}`;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) fail(`symlink is not allowed in memory inventory: ${repositoryPath}`);
      if (stat.isDirectory()) {
        walk(absolute, relative, [...ancestors, { path: absolute, stat }]);
      } else if (stat.isFile()) {
        files.push({
          path: repositoryPath,
          absolute,
          stat,
          ancestors,
        });
      } else {
        fail(`unsupported non-file entry in memory inventory: ${repositoryPath}`);
      }
    }
    assertAncestorsUnchanged(ancestors, `memory/${relativeDirectory || ''}`);
  }
  walk(memoryRoot, '', memoryAncestors);
  return files.sort((left, right) => compareCodeUnits(left.path, right.path));
}

function publicRecord(file, status, extra = {}) {
  return {
    path: file.path,
    status,
    ...extra,
  };
}

function selectedRecord(file, selectedBy) {
  const bytes = readValidatedRegularFile(file, file.path, 'selected');
  return publicRecord(file, 'SELECTED', {
    class: selectedBy.class,
    selector: selectedBy.path,
    size: bytes.length,
    sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
  });
}

function assertRepositoryMemoryPath(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('memory/') ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail(`path is not a normalized repository-relative memory path: ${JSON.stringify(value)}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`path is not a normalized repository-relative memory path: ${JSON.stringify(value)}`);
  }
  return value;
}

function classifyWithPolicy(policy, repositoryPath) {
  const safePath = assertRepositoryMemoryPath(repositoryPath);
  const selectedBy = policy.manifest?.include.find((entry) => entry.matches(safePath));
  if (!selectedBy) return { path: safePath, status: 'UNSELECTED' };
  if (policy.secretGuard.shouldSkip(path.join(policy.root, ...safePath.split('/')))) {
    return {
      path: safePath,
      status: 'SECRET_BLOCKED',
      class: selectedBy.class,
      selector: selectedBy.path,
    };
  }
  if (policy.ignoreRules.some((rule) => rule.matches(safePath))) {
    return {
      path: safePath,
      status: 'IGNORED',
      class: selectedBy.class,
      selector: selectedBy.path,
    };
  }
  return {
    path: safePath,
    status: 'SELECTED',
    class: selectedBy.class,
    selector: selectedBy.path,
  };
}

function resolvePolicy(root, rootStat) {
  const manifest = readManifest(root, rootStat);
  const ignoreRules = readIgnoreRules(root, rootStat);
  const secretGuard = createSecretGuard(root, {
    honorGitignore: false,
    honorGitignoreNegations: false,
  });
  return { root, manifest, ignoreRules, secretGuard };
}

/**
 * Resolve the operator-owned positive selection without mutating the project.
 * File contents are handled only as Buffers while producing deterministic
 * byte counts and hashes; extension and text decodability never affect selection.
 */
export function resolveBrainBackupSelection(projectRoot) {
  const root = path.resolve(projectRoot);
  const rootStat = lstatIfPresent(root);
  if (!rootStat) fail('project root must be an existing directory');
  if (rootStat.isSymbolicLink()) fail('project root must not be a symlink');
  if (!rootStat.isDirectory()) fail('project root must be an existing directory');

  const policy = resolvePolicy(root, rootStat);
  const { manifest } = policy;
  const inventory = inventoryMemory(root, rootStat);

  const records = inventory.map((file) => {
    const classification = classifyWithPolicy(policy, file.path);

    // Secret guards apply to publication candidates, not to unrelated local
    // proposal records. This avoids turning an unselected filename into a
    // publication blocker or exposing a content fingerprint for it.
    if (classification.status === 'UNSELECTED') {
      return publicRecord(file, 'UNSELECTED');
    }
    if (classification.status === 'SECRET_BLOCKED') {
      return publicRecord(file, 'SECRET_BLOCKED', classification);
    }
    if (classification.status === 'IGNORED') {
      return publicRecord(file, 'IGNORED', {
        class: classification.class,
        selector: classification.selector,
      });
    }
    return selectedRecord(file, classification);
  });

  const selected = records.filter((record) => record.status === 'SELECTED');
  const ignored = records.filter((record) => record.status === 'IGNORED');
  const secretBlocked = records.filter((record) => record.status === 'SECRET_BLOCKED');
  const unselected = records.filter((record) => record.status === 'UNSELECTED');
  const state = manifest == null
    ? 'MISSING_MANIFEST'
    : selected.length === 0
      ? 'EMPTY_SELECTION'
      : 'READY';

  return {
    schema: BRAIN_BACKUP_SCHEMA,
    brainId: manifest?.brain_id ?? getAgentId(root),
    manifestPath: manifest ? path.join(root, BRAIN_BACKUP_FILENAME) : null,
    includeCount: manifest?.include.length ?? 0,
    state,
    selected,
    ignored,
    secretBlocked,
    unselected,
    records,
    counts: {
      SELECTED: selected.length,
      IGNORED: ignored.length,
      SECRET_BLOCKED: secretBlocked.length,
      UNSELECTED: unselected.length,
    },
    // Internal validated policy data lets historical/missing paths be classified
    // without pretending that absence means policy exclusion.
    policy,
  };
}

/**
 * Classify an arbitrary repository-relative memory path against the already
 * validated current policy. The target does not need to exist.
 */
export function classifyBrainBackupPath(result, repositoryPath) {
  if (!result?.policy) fail('path classification requires a resolved selection result');
  return classifyWithPolicy(result.policy, repositoryPath);
}

export function selectedHistoricalMemoryPaths(result, paths) {
  const selected = [];
  for (const repositoryPath of paths) {
    let classification;
    try {
      classification = classifyBrainBackupPath(result, repositoryPath);
    } catch {
      continue;
    }
    if (classification.status === 'SELECTED') selected.push(classification.path);
  }
  return selected;
}

export function assertHistoricalMemoryPathsSelected(
  result,
  paths,
  operation = 'memory replay publication',
) {
  assertBrainBackupPolicyReady(result, operation);
  const selected = new Set(selectedHistoricalMemoryPaths(result, paths));
  const rejected = [...new Set(paths)].filter((repositoryPath) => !selected.has(repositoryPath));
  if (rejected.length > 0) {
    fail(
      `${operation} refused because frozen path(s) are not selected by the current policy: ` +
      rejected.join(', '),
    );
  }
  return result;
}

export function assertBrainBackupPolicyReady(result, operation = 'memory publication') {
  if (!result || typeof result !== 'object') {
    fail(`${operation} requires a resolved selection result`);
  }
  if (result.state === 'MISSING_MANIFEST') {
    fail(
      `${operation} requires ${BRAIN_BACKUP_FILENAME}; run the local proposal/dry-run to select memory files ` +
      `(classified counts: SELECTED=${result.counts?.SELECTED ?? 0}, IGNORED=${result.counts?.IGNORED ?? 0}, ` +
      `SECRET_BLOCKED=${result.counts?.SECRET_BLOCKED ?? 0}, UNSELECTED=${result.counts?.UNSELECTED ?? 0})`,
    );
  }
  if (!Number.isInteger(result.includeCount) || result.includeCount < 1) {
    fail(`${operation} requires a non-empty ${BRAIN_BACKUP_FILENAME} include policy`);
  }
  if (result.secretBlocked?.length) {
    const paths = result.secretBlocked.map((record) => record.path).join(', ');
    fail(
      `${operation} refused because selected path(s) are SECRET_BLOCKED: ${paths}. ` +
      `Remove the matching selector from ${BRAIN_BACKUP_FILENAME}, move the sensitive data to an encrypted secret store, ` +
      'or rename a false-positive file before rerunning the proposal',
    );
  }
  return result;
}

export function assertBrainBackupSelectionReady(result, operation = 'memory publication') {
  assertBrainBackupPolicyReady(result, operation);
  if (result.state === 'EMPTY_SELECTION') {
    fail(`${operation} has an empty selected set; update ${BRAIN_BACKUP_FILENAME} and rerun the proposal`);
  }
  if (result.state !== 'READY') {
    fail(`${operation} selection is not ready (${String(result.state)})`);
  }
  return result;
}

/**
 * Resolve and fail-close a publication selection, returning repository-relative
 * memory paths. Callers must read bytes from the same project root.
 */
export function collectSelectedMemoryPaths(projectRoot, operation = 'memory publication', { allowEmpty = false } = {}) {
  const result = resolveBrainBackupSelection(projectRoot);
  if (allowEmpty) assertBrainBackupPolicyReady(result, operation);
  else assertBrainBackupSelectionReady(result, operation);
  return result.selected.map((record) => record.path);
}

/**
 * .gitkeep is a repository-directory sentinel, not durable brain state. The
 * brain-asset contract deliberately rejects empty bodies, so publishing it
 * would poison a replay FIFO forever. Keep it visible in policy diagnostics,
 * but exclude it from every transport inventory.
 */
export function isPublishableMemoryPath(repositoryPath) {
  return path.posix.basename(repositoryPath.replaceAll('\\', '/')) !== '.gitkeep';
}
