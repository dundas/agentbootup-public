#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPolicy,
  validateArtifactDirectory,
} from './check-hermes-m0h-evidence.mjs';
import { findRawSecretViolations } from '../../lib/runtime-adapters/security.js';

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const REQUEST_FIELDS = [
  'artifactRoot', 'databaseRoot', 'evidenceRoot', 'executionContext', 'fullRoot',
  'installRoot', 'quiescenceRoot', 'transferRoot',
];
const ROOT_FIELDS = [
  'artifactRoot', 'databaseRoot', 'evidenceRoot', 'fullRoot', 'installRoot',
  'quiescenceRoot', 'transferRoot',
];

function fail(message) {
  throw new Error(`Hermes M0-H evidence projection refused: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(`${label} fields drifted`);
}

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPrivateDirectory(value, label, { absent = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label} must be a normalized absolute path`);
  }
  if (absent) {
    if (fs.existsSync(value)) fail(`${label} must not already exist`);
    const parent = path.dirname(value);
    canonicalPrivateDirectory(parent, `${label} parent`);
    return value;
  }
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== PRIVATE_DIR ||
      stat.uid !== process.getuid() || fs.realpathSync(value) !== value) {
    fail(`${label} must be a current-user, real, private directory`);
  }
  return value;
}

function canonicalPrivateFile(value, label, root) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
      !contained(root, value)) fail(`${label} must be a contained normalized absolute path`);
  const stat = fs.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (stat.mode & 0o777) !== PRIVATE_FILE || stat.uid !== process.getuid() ||
      fs.realpathSync(value) !== value) {
    fail(`${label} must be one current-user private regular file`);
  }
  return stat;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertDirectoryIdentity(root, identity, label) {
  let current;
  try {
    current = fs.lstatSync(root);
  } catch {
    fail(`${label} identity is unavailable`);
  }
  if (!sameIdentity(identity, current) || !current.isDirectory() ||
      current.isSymbolicLink() || current.uid !== process.getuid() ||
      (current.mode & 0o777) !== PRIVATE_DIR || fs.realpathSync(root) !== root) {
    fail(`${label} identity changed during projection`);
  }
}

function readPrivateText(file, label, root, rootIdentity) {
  assertDirectoryIdentity(root, rootIdentity, `${label} root`);
  const before = canonicalPrivateFile(file, label, root);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!sameIdentity(before, opened) || !opened.isFile() || opened.nlink !== 1 ||
        (opened.mode & 0o777) !== PRIVATE_FILE || opened.uid !== process.getuid()) {
      fail(`${label} identity changed before read`);
    }
    const text = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    if (!sameIdentity(opened, after) || opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
        after.nlink !== 1) {
      fail(`${label} identity changed during read`);
    }
    assertDirectoryIdentity(root, rootIdentity, `${label} root`);
    return text;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function rejectDuplicateKeys(text) {
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index += 1;
        index += 1;
      }
      if (index >= text.length) fail('JSON string is unterminated');
      const frame = stack.at(-1);
      if (frame?.type === 'object' && frame.expectKey) {
        const key = JSON.parse(text.slice(start, index + 1));
        if (frame.keys.has(key)) fail('JSON contains a duplicate object key');
        frame.keys.add(key);
        frame.expectKey = false;
      }
    } else if (text[index] === '{') {
      stack.push({ type: 'object', keys: new Set(), expectKey: true });
    } else if (text[index] === '[') {
      stack.push({ type: 'array' });
    } else if (text[index] === '}' || text[index] === ']') {
      stack.pop();
    } else if (text[index] === ',' && stack.at(-1)?.type === 'object') {
      stack.at(-1).expectKey = true;
    }
  }
}

function rejectSupportPromotion(value) {
  const forbiddenKeys = new Set([
    'crossstoresupport', 'generalsupport', 'macossupport',
    'productionqualified', 'supported', 'windowssupport',
  ]);
  const forbiddenValues = new Set([
    'cross_store_supported', 'generally_supported', 'macos_supported',
    'production', 'production_qualified', 'supported', 'windows_supported',
  ]);
  const visit = (current) => {
    if (typeof current === 'string') {
      if (forbiddenValues.has(current.toLowerCase())) fail('input contains a support-promotion claim');
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      const normalized = key.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
      if (forbiddenKeys.has(normalized) && item !== false && item != null) {
        fail('input contains a support-promotion claim');
      }
      visit(item);
    }
  };
  visit(value);
}

function readJson(file, label, root, rootIdentity) {
  const text = readPrivateText(file, label, root, rootIdentity);
  rejectDuplicateKeys(text);
  let value;
  try { value = JSON.parse(text); } catch { fail(`${label} is not valid JSON`); }
  if (findRawSecretViolations(value).length) fail(`${label} contains raw secret material`);
  rejectSupportPromotion(value);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function requireValue(condition, label) {
  if (!condition) fail(`${label} qualification drifted`);
}

function projectOffline(value) {
  exactKeys(value, [
    'bootstrap', 'closureManifestSha256', 'dependencyInstallFlags',
    'executionClass', 'executionContext', 'hermesInstallFlags', 'network',
    'pinnedInputs', 'schema', 'selectedWheelCount', 'trustBoundary',
  ], 'offline receipt');
  exactKeys(value.executionContext, [
    'imageOS', 'imageVersion', 'kernel', 'machine', 'runnerArch', 'runnerOS',
  ], 'receipt execution context');
  exactKeys(value.pinnedInputs, [
    'hermes_agent-0.19.0-py3-none-any.whl',
    'python-3.13.13-linux-24.04-x64.tar.gz',
    'requirements.txt', 'uv-x86_64-unknown-linux-gnu.tar.gz', 'uv.lock',
  ], 'receipt pinned inputs');
  requireValue(
    value.schema === 'agentbootup.hermes-offline-install/v1' &&
    value.executionClass === 'github_actions_exact_lane' &&
    Number.isInteger(value.selectedWheelCount) && value.selectedWheelCount > 0 &&
    value.network === 'package_index_and_network_fallback_disabled_no_egress_boundary_claimed',
    'offline receipt',
  );
  return value;
}

function projectClosure(value) {
  exactKeys(value, ['artifacts', 'requirementsSha256', 'schema'], 'closure manifest');
  requireValue(
    value.schema === 'agentbootup.hermes-wheelhouse/v1' &&
    value.requirementsSha256 === '317e6f4a0dbf56999fafafcefe481dcd49cd64995d657592c08b3e7acaee0971' &&
    Array.isArray(value.artifacts) && value.artifacts.length > 0 &&
    value.artifacts.every((row) => {
      try { exactKeys(row, ['filename', 'name', 'sha256', 'version'], 'closure artifact'); return true; } catch { return false; }
    }),
    'closure manifest',
  );
  return value;
}

function projectSynthetic(value) {
  exactKeys(value, [
    'closure', 'hermes', 'profiles', 'protectedRootCount', 'qualification',
    'schema', 'secretPolicy', 'trustedRootsStable', 'trustBoundary',
  ], 'synthetic report');
  requireValue(
    value.schema === 'agentbootup.hermes-synthetic-install/v1' &&
    value.qualification === 'exact_ci_evidence_pending_review' &&
    value.closure?.installReceipt?.executionClass === 'github_actions_exact_lane' &&
    value.trustedRootsStable === true && value.profiles?.length === 3,
    'synthetic report',
  );
  const profiles = value.profiles.map((profile) => {
    exactKeys(profile, [
      'cronDisabled', 'databaseIntegrityVerified', 'expectedCanaries',
      'mutationGuardsVerified', 'name', 'root', 'secretSentinelsPresent',
    ], 'synthetic profile');
    return {
      name: profile.name, root: profile.root,
      secretSentinelsPresent: profile.secretSentinelsPresent,
      databaseIntegrityVerified: profile.databaseIntegrityVerified,
      cronDisabled: profile.cronDisabled,
      mutationGuardsVerified: profile.mutationGuardsVerified,
    };
  });
  return {
    schema: value.schema, qualification: value.qualification,
    trustBoundary: value.trustBoundary, hermes: value.hermes,
    closure: {
      closureManifestSha256: value.closure.closureManifestSha256,
      installReceipt: value.closure.installReceipt,
      binding: value.closure.binding, uv: value.closure.uv,
      artifactCount: value.closure.artifacts.length,
    },
    profiles, protectedRootCount: value.protectedRootCount,
    trustedRootsStable: value.trustedRootsStable, secretPolicy: value.secretPolicy,
  };
}

function projectProbe(value, probe) {
  exactKeys(value, probe === 'profile_list'
    ? ['metadata', 'phase', 'probe', 'profiles', 'qualification', 'schema', 'status', 'trustBoundary']
    : ['metadata', 'phase', 'probe', 'qualification', 'schema', 'status', 'trustBoundary'],
  `${probe} report`);
  exactKeys(value.metadata, ['architecture', 'executable', 'python'], 'probe metadata');
  requireValue(
    value.schema === 'agentbootup.hermes-probe/v1' &&
    value.qualification === 'task_1_5_probe_nonqualifying_support_evidence_only' &&
    value.probe === probe && value.status === 'ok',
    `${probe} report`,
  );
  const projected = {
    schema: value.schema, trustBoundary: value.trustBoundary,
    qualification: value.qualification, phase: value.phase, probe: value.probe,
    status: value.status, metadata: value.metadata,
  };
  if (probe === 'profile_list') {
    requireValue(value.profiles?.length === 3, 'profile list');
    projected.profiles = value.profiles.map((profile) => {
      exactKeys(profile, ['default', 'name', 'root'], 'profile-list row');
      return profile;
    });
  }
  return projected;
}

function projectTransfer(value) {
  exactKeys(value, [
    'blockers', 'decision', 'executionClass', 'hermes', 'nativeBehavior',
    'qualification', 'restoreOracleDraft', 'rows', 'schema', 'trustBoundary',
  ], 'profile transfer report');
  requireValue(
    value.schema === 'agentbootup.hermes-m0h-profile-transfer/v1' &&
    value.qualification === 'task_1_8_evidence_only' &&
    value.executionClass === 'github_actions_exact_lane' &&
    value.decision === 'native_profile_transfer_requires_filtering_and_supplements' &&
    value.nativeBehavior?.rawArchivesRetained === false &&
    value.nativeBehavior?.sourceHomeStable === true &&
    value.rows?.length === 17 && value.restoreOracleDraft?.length === 19,
    'profile transfer',
  );
  for (const row of value.rows) {
    exactKeys(row, ['default', 'logicalItemId', 'named', 'sourceEntryCount', 'stateClass'], 'profile transfer row');
    exactKeys(row.default, ['archiveMemberCount', 'restoredEntryCount'], 'default transfer outcome');
    exactKeys(row.named, ['archiveMemberCount', 'restoredEntryCount'], 'named transfer outcome');
  }
  for (const row of value.restoreOracleDraft) {
    const blocked = row.default === 'blocked' || row.named === 'blocked';
    exactKeys(row, blocked
      ? ['checkId', 'default', 'dependency', 'named', 'reason']
      : ['checkId', 'default', 'named', 'reason'], 'restore oracle row');
    requireValue(
      ['pass', 'fail', 'blocked'].includes(row.default) &&
      ['pass', 'fail', 'blocked'].includes(row.named) &&
      (!blocked || row.dependency === 'task_1_11'),
      'restore oracle row',
    );
  }
  return value;
}

function projectFull(value) {
  exactKeys(value, [
    'archive', 'blockers', 'cleanup', 'decision', 'executionClass',
    'failureSemantics', 'hermes', 'qualification', 'restore',
    'restoreOracleComparison', 'restoreOracleExtensions', 'schema',
    'sourceHomeStable', 'sourceScenario', 'trustBoundary',
  ], 'full backup report');
  requireValue(
    value.schema === 'agentbootup.hermes-m0h-full-backup/v1' &&
    value.qualification === 'task_1_9_evidence_only' &&
    value.executionClass === 'github_actions_exact_lane' &&
    value.decision === 'full_backup_is_installation_wide_transient_input_only' &&
    value.archive?.accountedMemberCount === 62 && value.restore?.accountedMemberCount === 62 &&
    value.cleanup?.boundedIdentityCleanupRemovedAllRawArtifacts === true &&
    value.sourceHomeStable === true &&
    value.sourceScenario?.fileStateStableDuringNativeBackup === false &&
    value.sourceScenario?.fileStateStableAfterBoundedCleanup === true &&
    value.restoreOracleComparison?.length === 19 &&
    value.restoreOracleExtensions?.length === 6,
    'full backup',
  );
  for (const row of [...value.restoreOracleComparison, ...value.restoreOracleExtensions]) {
    const blocked = row.status === 'blocked';
    exactKeys(row, blocked
      ? ['checkId', 'dependency', 'reason', 'status']
      : ['checkId', 'reason', 'status'], 'full backup oracle row');
    requireValue(
      ['pass', 'fail', 'blocked'].includes(row.status) &&
      (!blocked || row.dependency === 'task_1_11'),
      'full backup oracle row',
    );
  }
  requireValue(
    value.failureSemantics?.sqliteFailureReturnedNormally === true &&
    value.failureSemantics?.sqliteFailureRetainedIncompleteArchive === true &&
    value.failureSemantics?.traversalFailureReturnedNormallyAfterPartialWrite === true &&
    value.failureSemantics?.writeFailureReturnedNormallyAfterPartialWrite === true &&
    value.failureSemantics?.invalidArchiveExitCode === 1 &&
    value.failureSemantics?.invalidMarkerExitCode === 1,
    'full backup failure semantics',
  );
  return value;
}

function projectQuiescence(value) {
  exactKeys(value, [
    'blockers', 'cronLifecycle', 'decision', 'executionClass', 'hermes',
    'lifecycleModel', 'qualification', 'restoreOracleExtensions', 'schema',
    'scopeDecision', 'sourceEvidence', 'trustBoundary', 'writerMatrix',
  ], 'quiescence report');
  requireValue(
    value.schema === 'agentbootup.hermes-m0h-quiescence/v1' &&
    value.qualification === 'task_1_10_evidence_only' &&
    value.executionClass === 'github_actions_exact_lane' &&
    value.decision === 'installation_wide_quiescence_required' &&
    value.scopeDecision?.scope === 'installation_wide' &&
    value.scopeDecision?.profileScopedSafe === false &&
    value.scopeDecision?.siblingConsentRequired === true &&
    value.scopeDecision?.nativeLifecycleActuationTested === false &&
    value.cronLifecycle?.separateDaemon === false &&
    value.cronLifecycle?.separateStartAllowed === false &&
    value.sourceEvidence?.length === 12 && value.writerMatrix?.length === 14 &&
    value.lifecycleModel?.scenarios?.length === 23 &&
    value.restoreOracleExtensions?.length === 11,
    'quiescence',
  );
  for (const row of value.restoreOracleExtensions) {
    const blocked = row.status === 'blocked';
    exactKeys(row, blocked
      ? ['checkId', 'dependency', 'reason', 'status']
      : ['checkId', 'reason', 'status'], 'quiescence oracle row');
    requireValue(
      ['pass', 'blocked'].includes(row.status) &&
      (!blocked || row.dependency === 'task_4'),
      'quiescence oracle row',
    );
  }
  return value;
}

function projectDatabase(value) {
  exactKeys(value, [
    'blockers', 'cleanup', 'decision', 'engineSafeSnapshots', 'executionClass',
    'failureSemantics', 'hermes', 'nativeFullBackup', 'qualification',
    'restoreOracleDraft', 'schema', 'scope', 'strategyComparison',
  ], 'database report');
  requireValue(
    value.schema === 'agentbootup.hermes-m0h-database/v1' &&
    value.qualification === 'task_1_11_evidence_only' &&
    value.executionClass === 'github_actions_exact_lane' &&
    value.decision === 'sqlite_api_capture_qualified_for_six_captured_databases' &&
    value.scope?.profiles === 3 && value.scope?.databaseClasses === 2 &&
    value.scope?.openCommittedWalWriters === 6 &&
    value.scope?.disposableCloneOnly === true && value.scope?.liveHomeTouched === false &&
    value.scope?.scenarioSidecarsCreated === 12 &&
    value.scope?.sourceSidecarsTouched === false &&
    value.scope?.scenarioSidecarDisposition === 'deleted_with_bounded_disposable_clone' &&
    value.engineSafeSnapshots?.count === 6 &&
    value.engineSafeSnapshots?.allQualified === true &&
    value.nativeFullBackup?.databaseMembersQualified === 6 &&
    value.nativeFullBackup?.allSixEquivalentToEngineSafe === true &&
    value.strategyComparison?.rawMainOnly?.committedWalCanariesMissed === 6 &&
    value.strategyComparison?.rawMainOnly?.qualified === false &&
    value.strategyComparison?.rawProfileExport?.profilesTested === 3 &&
    value.strategyComparison?.rawProfileExport?.qualified === false &&
    value.failureSemantics?.safeCopy?.returnedFalse === true &&
    value.failureSemantics?.safeCopy?.destinationDeleted === true &&
    value.failureSemantics?.safeCopy?.sourceStillValid === true &&
    value.failureSemantics?.fullBackup?.returnedNormally === true &&
    value.failureSemantics?.fullBackup?.archiveRetainedByNativeCommand === true &&
    value.failureSemantics?.fullBackup?.reportedIncomplete === true &&
    value.failureSemantics?.fullBackup?.probeRetainedRawArchive === false &&
    value.restoreOracleDraft?.length === 6 &&
    value.cleanup?.rawArchivesRetained === false &&
    value.cleanup?.snapshotsRetained === false &&
    value.cleanup?.temporaryHomesRetained === false &&
    value.cleanup?.boundedIdentityCleanup === true,
    'database',
  );
  const expected = new Map([
    ['HERMES-RO-DB-INTEGRITY-001', 'six_engine_safe_snapshots_full_integrity'],
    ['HERMES-RO-DB-SCHEMA-001', 'six_exact_schema_fingerprints'],
    ['HERMES-RO-DB-CANARY-001', 'six_native_fixture_and_wal_canary_sets'],
    ['HERMES-RO-DB-WAL-001', 'six_open_wal_writers_raw_copy_rejected'],
    ['HERMES-RO-DB-BACKUP-FAIL-CLOSED-001', 'low_level_safe_copy_primitive_only'],
    ['HERMES-RO-DB-SOURCE-SIDECAR-DISPOSITION-001', 'measured_disposable_sidecars_identity_bound_cleanup'],
  ]);
  const observed = new Set();
  for (const row of value.restoreOracleDraft) {
    exactKeys(row, ['checkId', 'evidence', 'status', 'strategy'], 'database oracle row');
    requireValue(
      row.status === 'pass' &&
      row.strategy === 'profile_export_plus_engine_safe_supplements' &&
      expected.get(row.checkId) === row.evidence && !observed.has(row.checkId),
      'database oracle row',
    );
    observed.add(row.checkId);
  }
  requireValue(observed.size === expected.size, 'database oracle coverage');
  return value;
}

const HANDLERS = new Map([
  ['artifact-preflight-report.json', ({ evidenceRoot, rootIdentities }) =>
    projectProbe(readJson(path.join(evidenceRoot, 'artifact-preflight-report.json'), 'artifact preflight', evidenceRoot, rootIdentities.evidenceRoot), 'artifact_preflight')],
  ['closure-manifest.json', ({ installRoot, rootIdentities }) =>
    projectClosure(readJson(path.join(installRoot, 'artifacts/closure-manifest.json'), 'closure manifest', installRoot, rootIdentities.installRoot))],
  ['database-report.json', ({ databaseRoot, rootIdentities }) =>
    projectDatabase(readJson(path.join(databaseRoot, 'database-report.json'), 'database report', databaseRoot, rootIdentities.databaseRoot))],
  ['full-backup-report.json', ({ fullRoot, rootIdentities }) =>
    projectFull(readJson(path.join(fullRoot, 'full-backup-report.json'), 'full backup report', fullRoot, rootIdentities.fullRoot))],
  ['offline-install-receipt.json', ({ installRoot, rootIdentities }) =>
    projectOffline(readJson(path.join(installRoot, 'offline-install-receipt.json'), 'offline receipt', installRoot, rootIdentities.installRoot))],
  ['profile-list-report.json', ({ evidenceRoot, rootIdentities }) =>
    projectProbe(readJson(path.join(evidenceRoot, 'profile-list-report.json'), 'profile list', evidenceRoot, rootIdentities.evidenceRoot), 'profile_list')],
  ['profile-transfer-report.json', ({ transferRoot, rootIdentities }) =>
    projectTransfer(readJson(path.join(transferRoot, 'profile-transfer-report.json'), 'profile transfer report', transferRoot, rootIdentities.transferRoot))],
  ['quiescence-report.json', ({ quiescenceRoot, rootIdentities }) =>
    projectQuiescence(readJson(path.join(quiescenceRoot, 'quiescence-report.json'), 'quiescence report', quiescenceRoot, rootIdentities.quiescenceRoot))],
  ['runner-context.json', ({ executionContext }) => {
    exactKeys(executionContext, ['imageOS', 'imageVersion', 'kernel', 'machine', 'runnerArch', 'runnerOS'], 'execution context');
    return { schema: 'agentbootup.hermes-m0h-runner-context/v1', ...executionContext };
  }],
  ['synthetic-report.json', ({ evidenceRoot, rootIdentities }) =>
    projectSynthetic(readJson(path.join(evidenceRoot, 'synthetic-report.json'), 'synthetic report', evidenceRoot, rootIdentities.evidenceRoot))],
]);

export function projectHermesM0hEvidence(options) {
  exactKeys(options, REQUEST_FIELDS, 'projection request');
  const policy = loadPolicy();
  const roots = {};
  const rootIdentities = {};
  for (const field of ROOT_FIELDS) {
    roots[field] = canonicalPrivateDirectory(options[field], field, { absent: field === 'artifactRoot' });
    if (field !== 'artifactRoot') rootIdentities[field] = fs.lstatSync(roots[field]);
  }
  for (let index = 0; index < ROOT_FIELDS.length; index += 1) {
    for (let other = index + 1; other < ROOT_FIELDS.length; other += 1) {
      const left = roots[ROOT_FIELDS[index]];
      const right = roots[ROOT_FIELDS[other]];
      if (contained(left, right) || contained(right, left)) fail('projection roots must be pairwise non-overlapping');
    }
  }
  const expected = policy.artifacts.members.map((row) => row.name);
  const handlers = [...HANDLERS.keys()].sort();
  if (expected.join('\0') !== handlers.join('\0')) fail('policy artifact members and projector handlers drifted');
  const stage = fs.mkdtempSync(`${options.artifactRoot}.stage-`);
  fs.chmodSync(stage, PRIVATE_DIR);
  const stageIdentity = fs.lstatSync(stage);
  try {
    const projected = new Map();
    for (const member of policy.artifacts.members) {
      const value = canonicalize(HANDLERS.get(member.name)({ ...options, rootIdentities }));
      projected.set(member.name, value);
      const file = path.join(stage, member.name);
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE, flag: 'wx' });
    }
    if (projected.get('offline-install-receipt.json').selectedWheelCount !==
        projected.get('closure-manifest.json').artifacts.length) {
      fail('offline receipt and closure manifest artifact counts drifted');
    }
    validateArtifactDirectory(stage, policy);
    fs.renameSync(stage, options.artifactRoot);
    return { files: expected.length, artifactRoot: options.artifactRoot };
  } catch (error) {
    if (fs.existsSync(stage)) {
      const quarantine = `${stage}.cleanup`;
      fs.renameSync(stage, quarantine);
      const cleanupIdentity = fs.lstatSync(quarantine);
      if (!sameIdentity(stageIdentity, cleanupIdentity) ||
          !cleanupIdentity.isDirectory() || cleanupIdentity.isSymbolicLink() ||
          cleanupIdentity.uid !== process.getuid()) {
        fail('staging directory identity changed; cleanup refused');
      }
      fs.rmSync(quarantine, { recursive: true, force: true });
    }
    throw error;
  }
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--request') {
    fail('usage: hermes-m0h-project-evidence.mjs --request /absolute/request.json');
  }
  const requestPath = path.resolve(argv[1]);
  if (requestPath !== argv[1]) fail('request path must be normalized and absolute');
  const parent = canonicalPrivateDirectory(path.dirname(requestPath), 'request parent');
  const request = readJson(requestPath, 'request', parent, fs.lstatSync(parent));
  const result = projectHermesM0hEvidence(request);
  process.stdout.write(`${JSON.stringify({ files: result.files })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
