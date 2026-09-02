// Evidence-only Task 1.7 ownership census; deliberately not a product adapter.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRawSecretViolations } from '../../lib/runtime-adapters/security.js';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HERMES = Object.freeze({
  package: '0.19.0',
  tag: 'v2026.7.20',
  commit: '3ef6bbd201263d354fd83ec55b3c306ded2eb72a',
  wheelSha256: 'bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f',
});

export const OWNERSHIP_EVIDENCE = Object.freeze([
  Object.freeze({
    id: 'profile-isolation',
    source: 'hermes-wheel://hermes_cli/profiles.py#get_profile_dir,_get_profiles_root',
    claim: 'The default root and every named profile root are independent Hermes homes.',
  }),
  Object.freeze({
    id: 'profile-portable-surface',
    source: 'hermes-wheel://hermes_cli/profiles.py#_DEFAULT_EXPORT_INCLUDE_ROOT',
    claim: 'Config, persona, skills, cron, sessions, and memories are native profile-export paths.',
  }),
  Object.freeze({
    id: 'profile-exclusions',
    source: 'hermes-wheel://hermes_cli/profiles.py#_DEFAULT_EXPORT_INCLUDE_ROOT,_default_export_ignore',
    claim: 'The operative default-profile root allowlist excludes siblings, credentials, databases, machine state, logs, and caches.',
  }),
  Object.freeze({
    id: 'runtime-and-machine-state',
    source: 'hermes-wheel://hermes_cli/backup.py#_EXCLUDED_DIRS,_EXCLUDED_NAMES,_IMPORT_SKIP_NAMES,_QUICK_STATE_FILES',
    claim: 'Databases and cron are durable state; locks, PIDs, process state, logs, and caches are not portable payload.',
  }),
  Object.freeze({
    id: 'pairing-authorization',
    source: 'hermes-wheel://gateway/pairing.py#PairingStore',
    claim: 'Pairing stores contain per-profile authorization grants and pending authorization state.',
  }),
  Object.freeze({
    id: 'hook-capability',
    source: 'hermes-wheel://gateway/hooks.py#HookRegistry',
    claim: 'Profile hooks are user-controlled executable capabilities under the profile root.',
  }),
  Object.freeze({
    id: 'synthetic-fixture',
    source: 'agentbootup://task-0052e/1.6/run-30479873730',
    claim: 'The exact-lane builder proved three distinct profiles with native session and cron canaries.',
  }),
]);

function refuse(message) {
  throw new Error(`Hermes ownership census refused: ${message}`);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function modeBits(stat) {
  return stat.mode & 0o777;
}

function contained(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

async function canonicalDirectory(value, label, privateOnly = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    refuse(`${label} must be a normalized absolute path`);
  }
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) refuse(`${label} must be an existing non-symlink directory`);
  if (privateOnly && modeBits(stat) !== PRIVATE_DIR_MODE) refuse(`${label} must have mode 0700`);
  if (stat.uid !== process.getuid()) refuse(`${label} must be owned by the current uid`);
  const real = await fs.realpath(value);
  if (real !== value) refuse(`${label} or one of its ancestors is a symlink`);
  return real;
}

async function canonicalFile(value, label, expectedMode = null) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    refuse(`${label} must be a normalized absolute path`);
  }
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) refuse(`${label} must be an existing regular non-symlink file`);
  if (expectedMode != null && modeBits(stat) !== expectedMode) refuse(`${label} must have mode 0600`);
  if (stat.uid !== process.getuid()) refuse(`${label} must be owned by the current uid`);
  const real = await fs.realpath(value);
  if (real !== value) refuse(`${label} or one of its ancestors is a symlink`);
  return real;
}

function entryKind(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return stat.nlink > 1 ? 'hardlink_candidate' : 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'special';
}

async function scanEntries(root) {
  const pending = [''];
  const rows = [];
  while (pending.length) {
    const parent = pending.pop();
    const absolute = path.join(root, parent);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const relative = parent ? `${parent}/${entry.name}` : entry.name;
      const candidate = path.join(root, ...relative.split('/'));
      const stat = await fs.lstat(candidate);
      if (stat.uid !== process.getuid()) refuse('Hermes home contains an entry owned by another uid');
      const kind = entryKind(stat);
      rows.push({
        relative,
        kind,
        fingerprint: [relative, kind, stat.mode, stat.size, stat.mtimeMs, stat.dev, stat.ino, stat.nlink],
      });
      if (kind === 'directory') pending.push(relative);
    }
  }
  return rows.sort((left, right) => compare(left.relative, right.relative));
}

function fingerprint(rows) {
  return createHash('sha256').update(JSON.stringify(rows.map((row) => row.fingerprint))).digest('hex');
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function serializeOwnershipCensus(value) {
  return `${JSON.stringify(sortValue(value))}\n`;
}

function profileRootsFromReport(report) {
  if (!report || Object.getPrototypeOf(report) !== Object.prototype) refuse('synthetic report must be an object');
  for (const [key, expected] of Object.entries(HERMES)) {
    if (report.hermes?.[key] !== expected) refuse(`synthetic report Hermes ${key} drifted`);
  }
  if (!Array.isArray(report.profiles) || report.profiles.length < 3) {
    refuse('synthetic report must contain default and at least two named profiles');
  }
  const seen = new Set();
  const profiles = report.profiles.map((profile) => {
    if (!profile || Object.getPrototypeOf(profile) !== Object.prototype ||
        typeof profile.name !== 'string' || !PROFILE_ID.test(profile.name) || seen.has(profile.name)) {
      refuse('synthetic report contains an invalid or duplicate profile');
    }
    seen.add(profile.name);
    const expectedRoot = profile.name === 'default' ? '.' : `profiles/${profile.name}`;
    if (profile.root !== expectedRoot) refuse(`synthetic report root drifted for profile ${profile.name}`);
    return Object.freeze({ name: profile.name, root: expectedRoot });
  }).sort((left, right) => compare(left.name, right.name));
  if (!seen.has('default')) refuse('synthetic report must contain the default profile');
  return profiles;
}

const result = (logicalItemId, pathClass, stateClass, evidenceSource, reason, snapshotEligibility) => ({
  logicalItemId, pathClass, stateClass, evidenceSource, reason,
  snapshotEligible: snapshotEligibility === 'eligible',
  snapshotEligibility,
});

function matchesPrefixKind(relative, prefix, kind) {
  return relative === prefix ? kind === 'directory' : relative.startsWith(`${prefix}/`);
}

function classifyProfilePath(relative, kind) {
  const first = relative.split('/')[0];
  if ((relative === '.env' || relative === 'auth.json') && kind === 'file' ||
      first === 'pairing' && matchesPrefixKind(relative, 'pairing', kind)) {
    return result('profile.authorization', 'profile_root/authorization', 'secret',
      ['pairing-authorization', 'profile-exclusions'], 'Credential or authorization state is excluded from the non-secret profile payload.', 'excluded');
  }
  if (relative === 'config.yaml' && kind === 'file') {
    return result('profile.config', 'profile_root/config', 'portable_core',
      ['profile-portable-surface'], 'Declarative profile configuration.', 'candidate_after_content_policy');
  }
  if (relative === 'SOUL.md' && kind === 'file') {
    return result('profile.identity', 'profile_root/identity', 'portable_core',
      ['profile-portable-surface'], 'Declarative profile identity and instructions.', 'candidate_after_content_policy');
  }
  if (first === 'memories' && matchesPrefixKind(relative, 'memories', kind)) {
    return result('profile.memory', 'profile_root/memory', 'portable_core',
      ['profile-portable-surface'], 'Profile-owned durable memory documents.', 'candidate_after_content_policy');
  }
  if (first === 'skills' && matchesPrefixKind(relative, 'skills', kind)) {
    return result('profile.skills', 'profile_root/skills', 'portable_core',
      ['profile-portable-surface'], 'Profile-owned capability files.', 'candidate_after_content_policy');
  }
  if (first === 'hooks' && matchesPrefixKind(relative, 'hooks', kind)) {
    return result('profile.hooks', 'profile_root/hooks', 'portable_core',
      ['hook-capability', 'profile-isolation'], 'Profile-owned executable capability files require later restore consent policy.', 'candidate_after_content_policy');
  }
  if (first === 'sessions' && matchesPrefixKind(relative, 'sessions', kind)) {
    return result('profile.sessions', 'profile_root/sessions', 'runtime_state',
      ['runtime-and-machine-state', 'synthetic-fixture'], 'Profile-owned durable session state; capture method remains gated on Task 1.8.', 'pending_engine_safe_capture');
  }
  if (relative === 'state.db' && kind === 'file') {
    return result('profile.session_database', 'profile_root/database', 'runtime_state',
      ['runtime-and-machine-state', 'synthetic-fixture'], 'Profile-owned SQLite state; capture method remains gated on Task 1.8.', 'pending_engine_safe_capture');
  }
  if (relative === 'cron/.jobs.lock' && kind === 'file') {
    return result('profile.cron_lock', 'profile_root/lock', 'machine_local',
      ['runtime-and-machine-state'], 'Live scheduler lock state is machine-local.', 'excluded');
  }
  if (matchesPrefixKind(relative, 'cron/output', kind)) {
    return result('profile.cron_output', 'profile_root/log', 'cache',
      ['runtime-and-machine-state'], 'Cron execution output is regenerable/log state.', 'excluded');
  }
  if (relative === 'cron' && kind === 'directory' ||
      (relative === 'cron/jobs.json' || relative === 'cron/executions.db') && kind === 'file') {
    return result('profile.cron_state', 'profile_root/cron', 'runtime_state',
      ['runtime-and-machine-state', 'synthetic-fixture'], 'Profile-owned cron definitions and execution database; capture method remains gated on Task 1.8.', 'pending_engine_safe_capture');
  }
  if (relative === 'external-state.json' && kind === 'file') {
    return result('profile.external_memory', 'profile_root/external_declaration', 'external_state',
      ['synthetic-fixture'], 'External-provider declaration is referenced separately from the profile payload.', 'reference_only');
  }
  if (['.cache', 'image_cache', 'audio_cache', 'logs'].includes(first) &&
      matchesPrefixKind(relative, first, kind)) {
    return result('profile.cache', 'profile_root/cache_or_log', 'cache',
      ['profile-exclusions', 'runtime-and-machine-state'], 'Generated cache or log state is excluded.', 'excluded');
  }
  if (['gateway.pid', 'cron.pid', 'gateway.lock', 'gateway_state.json', 'processes.json'].includes(relative) &&
      kind === 'file') {
    return result('profile.machine_state', 'profile_root/machine_state', 'machine_local',
      ['runtime-and-machine-state'], 'PID, lock, process, or desired-service state is machine-local.', 'excluded');
  }
  return null;
}

function aggregateRows(scanned, profiles) {
  const profileByPrefix = [...profiles]
    .filter((profile) => profile.name !== 'default')
    .sort((left, right) => right.root.length - left.root.length);
  const groups = new Map();
  let unknownIndex = 0;

  function add(classification, owner, kind) {
    const key = `${owner}\0${classification.logicalItemId}\0${classification.pathClass}`;
    const current = groups.get(key) ?? {
      ...classification,
      owner,
      kinds: new Set(),
      observedEntryCount: 0,
    };
    current.kinds.add(kind);
    current.observedEntryCount += 1;
    groups.set(key, current);
  }

  for (const entry of scanned) {
    if (entry.relative === 'profiles') {
      add(result('installation.profile_namespace', 'installation_root/profile_namespace', 'reproducible',
        ['profile-isolation', 'profile-exclusions'], 'Shared structural namespace; it never enters a profile payload.', 'excluded'),
      'shared_installation', entry.kind);
      continue;
    }
    const rootMarker = profileByPrefix.find((profile) => entry.relative === profile.root);
    if (rootMarker) {
      add(result('profile.root', 'profile_root/root_marker', 'reproducible',
        ['profile-isolation'], 'Structural root for exactly one named profile.', 'excluded'),
      `profile:${rootMarker.name}`, entry.kind);
      continue;
    }
    const named = profileByPrefix.find((profile) => entry.relative.startsWith(`${profile.root}/`));
    const owner = named ? `profile:${named.name}` : 'profile:default';
    const relative = named ? entry.relative.slice(named.root.length + 1) : entry.relative;
    let classification = entry.kind === 'file' || entry.kind === 'directory'
      ? classifyProfilePath(relative, entry.kind)
      : null;
    if (!classification) {
      unknownIndex += 1;
      classification = result(`profile.unknown.${String(unknownIndex).padStart(4, '0')}`,
        'profile_root/unknown', 'manual_review', ['profile-isolation'],
        'No pinned Task 1.7 ownership/classification rule matched this observed entry.', 'manual_review');
    }
    add(classification, owner, entry.kind);
  }

  return [...groups.values()].map((row) => ({
    ...row,
    kinds: [...row.kinds].sort(compare),
  })).sort((left, right) =>
    compare(`${left.owner}\0${left.logicalItemId}`, `${right.owner}\0${right.logicalItemId}`));
}

export async function buildOwnershipCensus({ hermesHome, syntheticReportPath }) {
  const home = await canonicalDirectory(hermesHome, 'Hermes home', true);
  const liveHome = await fs.realpath(os.homedir());
  if (contained(liveHome, home) || contained(home, liveHome)) refuse('Hermes home overlaps the live user home');
  const reportFile = await canonicalFile(syntheticReportPath, 'synthetic report', PRIVATE_FILE_MODE);
  if (contained(home, reportFile)) refuse('synthetic report must remain outside the Hermes home');
  const syntheticReport = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  const profiles = profileRootsFromReport(syntheticReport);
  const expectedNamed = profiles.filter((profile) => profile.name !== 'default').map((profile) => profile.name);
  const actualNamed = (await fs.readdir(path.join(home, 'profiles'), { withFileTypes: true }))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROFILE_ID.test(entry.name)) {
        refuse('profiles namespace contains an invalid entry');
      }
      return entry.name;
    }).sort(compare);
  if (JSON.stringify(actualNamed) !== JSON.stringify(expectedNamed)) {
    refuse('profiles namespace differs from the synthetic report');
  }

  const pre = await scanEntries(home);
  const rows = aggregateRows(pre, profiles);
  const post = await scanEntries(home);
  if (fingerprint(pre) !== fingerprint(post)) refuse('Hermes home changed during the census');
  const observedEntryCount = pre.length;
  const classifiedEntryCount = rows.reduce((sum, row) => sum + row.observedEntryCount, 0);
  if (observedEntryCount !== classifiedEntryCount) refuse('observed and classified entry counts differ');
  const manualReviewCount = rows
    .filter((row) => row.stateClass === 'manual_review')
    .reduce((sum, row) => sum + row.observedEntryCount, 0);
  const census = {
    schema: 'agentbootup.hermes-m0h-ownership-census/v1',
    qualification: 'task_1_7_evidence_only',
    hermes: HERMES,
    profiles,
    sourceEvidence: OWNERSHIP_EVIDENCE,
    trustBoundary: 'current_uid_private_roots_no_concurrent_same_uid_mutation',
    status: manualReviewCount ? 'manual_review' : 'complete_pending_capture_strategy',
    snapshotEligible: false,
    snapshotEligibility: manualReviewCount ? 'blocked_manual_review' : 'blocked_pending_task_1_8',
    observedEntryCount,
    classifiedEntryCount,
    manualReviewCount,
    rows,
  };
  if (findRawSecretViolations(census).length) refuse('structured census contains raw secret material');
  return census;
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--request' || !path.isAbsolute(argv[1])) {
    refuse('usage: hermes-m0h-ownership-census.mjs --request /absolute/request.json');
  }
  const requestPath = path.normalize(argv[1]);
  if (requestPath !== argv[1]) refuse('request path must be normalized');
  await canonicalDirectory(path.dirname(requestPath), 'request parent', true);
  await canonicalFile(requestPath, 'request', PRIVATE_FILE_MODE);
  const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  const allowed = new Set(['hermesHome', 'syntheticReportPath', 'evidenceRoot', 'outputPath']);
  if (!request || Object.getPrototypeOf(request) !== Object.prototype ||
      Object.keys(request).some((key) => !allowed.has(key))) {
    refuse('request schema mismatch');
  }
  const evidenceRoot = await canonicalDirectory(request.evidenceRoot, 'evidence root', true);
  if (!contained(evidenceRoot, requestPath)) refuse('request must be inside the evidence root');
  if (typeof request.syntheticReportPath !== 'string' || !path.isAbsolute(request.syntheticReportPath) ||
      path.normalize(request.syntheticReportPath) !== request.syntheticReportPath ||
      !contained(evidenceRoot, request.syntheticReportPath)) {
    refuse('synthetic report must be a normalized path inside the evidence root');
  }
  if (typeof request.outputPath !== 'string' || !path.isAbsolute(request.outputPath) ||
      path.normalize(request.outputPath) !== request.outputPath) {
    refuse('output path must be a normalized path inside the evidence root');
  }
  const outputParent = await canonicalDirectory(path.dirname(request.outputPath), 'output parent', true);
  if (!contained(evidenceRoot, outputParent)) refuse('output parent must be physically inside the evidence root');
  if (await fs.lstat(request.outputPath).catch(() => null)) refuse('output path must not exist');
  const census = await buildOwnershipCensus(request);
  await fs.writeFile(request.outputPath, serializeOwnershipCensus(census), {
    encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE,
  });
  process.stdout.write(serializeOwnershipCensus(census));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.message || 'Hermes ownership census refused'}\n`);
    process.exitCode = 1;
  });
}
