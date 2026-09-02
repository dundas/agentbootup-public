import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import forbidden from './fixtures/hermes-m0h-evidence-forbidden.json';
import { projectHermesM0hEvidence } from '../../scripts/runtime-adapters/hermes-m0h-project-evidence.mjs';
import {
  loadPolicy,
  validateArtifactDirectory,
} from '../../scripts/runtime-adapters/check-hermes-m0h-evidence.mjs';

const roots: string[] = [];
const names = ['default', 'atlas', 'beacon'];

function privateRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-projector-')));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writeJson(root: string, relative: string, value: unknown) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function fixture() {
  const base = privateRoot();
  const dirs = Object.fromEntries(
    ['database', 'evidence', 'full', 'install', 'quiescence', 'transfer']
      .map((name) => {
        const value = path.join(base, name);
        fs.mkdirSync(value, { mode: 0o700 });
        return [name, value];
      }),
  ) as Record<string, string>;
  fs.mkdirSync(path.join(dirs.install, 'artifacts'), { mode: 0o700 });

  const receipt = {
    bootstrap: {}, closureManifestSha256: 'a'.repeat(64), dependencyInstallFlags: [],
    executionClass: 'github_actions_exact_lane',
    executionContext: {
      imageOS: 'ubuntu24', imageVersion: 'fixture', kernel: 'fixture',
      machine: 'x86_64', runnerArch: 'X64', runnerOS: 'Linux',
    },
    hermesInstallFlags: [], network: 'package_index_and_network_fallback_disabled_no_egress_boundary_claimed',
    pinnedInputs: {
      'hermes_agent-0.19.0-py3-none-any.whl': 'a'.repeat(64),
      'python-3.13.13-linux-24.04-x64.tar.gz': 'b'.repeat(64),
      'requirements.txt': 'c'.repeat(64),
      'uv-x86_64-unknown-linux-gnu.tar.gz': 'd'.repeat(64),
      'uv.lock': 'e'.repeat(64),
    },
    schema: 'agentbootup.hermes-offline-install/v1',
    selectedWheelCount: 1, trustBoundary: 'fixture',
  };
  const manifest = {
    artifacts: [{ filename: 'one.whl', name: 'one', sha256: 'b'.repeat(64), version: '1' }],
    requirementsSha256: '317e6f4a0dbf56999fafafcefe481dcd49cd64995d657592c08b3e7acaee0971',
    schema: 'agentbootup.hermes-wheelhouse/v1',
  };
  const synthetic = {
    closure: {
      artifacts: [{}], binding: {}, closureManifestSha256: 'a'.repeat(64),
      installReceipt: { executionClass: 'github_actions_exact_lane' }, uv: {},
    },
    hermes: {}, profiles: names.map((name) => ({
      cronDisabled: true, databaseIntegrityVerified: true, expectedCanaries: [],
      mutationGuardsVerified: true, name, root: name, secretSentinelsPresent: true,
    })),
    protectedRootCount: 2, qualification: 'exact_ci_evidence_pending_review',
    schema: 'agentbootup.hermes-synthetic-install/v1', secretPolicy: {},
    trustedRootsStable: true, trustBoundary: 'fixture',
  };
  const probe = (name: string, profiles = false) => ({
    metadata: { architecture: 'x86_64', executable: 'hermes', python: '3.13.13' },
    phase: 'post_install', probe: name,
    ...(profiles ? { profiles: names.map((name, index) => ({ default: index === 0, name, root: name })) } : {}),
    qualification: 'task_1_5_probe_nonqualifying_support_evidence_only',
    schema: 'agentbootup.hermes-probe/v1', status: 'ok', trustBoundary: 'fixture',
  });
  const transfer = {
    blockers: [], decision: 'native_profile_transfer_requires_filtering_and_supplements',
    executionClass: 'github_actions_exact_lane', hermes: {},
    nativeBehavior: { rawArchivesRetained: false, sourceHomeStable: true },
    qualification: 'task_1_8_evidence_only',
    restoreOracleDraft: Array.from({ length: 19 }, (_, index) => ({
      checkId: `t${index}`, default: 'pass', named: 'pass', reason: 'fixture',
    })),
    rows: Array.from({ length: 17 }, (_, index) => ({
      default: { archiveMemberCount: 0, restoredEntryCount: 0 },
      logicalItemId: `i${index}`,
      named: { archiveMemberCount: 0, restoredEntryCount: 0 },
      sourceEntryCount: 0, stateClass: 'portable_core',
    })),
    schema: 'agentbootup.hermes-m0h-profile-transfer/v1', trustBoundary: 'fixture',
  };
  const full = {
    archive: { accountedMemberCount: 62 }, blockers: [],
    cleanup: { boundedIdentityCleanupRemovedAllRawArtifacts: true },
    decision: 'full_backup_is_installation_wide_transient_input_only',
    executionClass: 'github_actions_exact_lane',
    failureSemantics: {
      invalidArchiveExitCode: 1, invalidMarkerExitCode: 1,
      sqliteFailureRetainedIncompleteArchive: true,
      sqliteFailureReturnedNormally: true,
      traversalFailureReturnedNormallyAfterPartialWrite: true,
      writeFailureReturnedNormallyAfterPartialWrite: true,
    }, hermes: {},
    qualification: 'task_1_9_evidence_only', restore: { accountedMemberCount: 62 },
    restoreOracleComparison: Array.from({ length: 19 }, (_, index) => ({
      checkId: `f${index}`, reason: 'fixture', status: 'pass',
    })),
    restoreOracleExtensions: Array.from({ length: 6 }, (_, index) => ({
      checkId: `x${index}`, reason: 'fixture', status: 'pass',
    })),
    schema: 'agentbootup.hermes-m0h-full-backup/v1', sourceHomeStable: true,
    sourceScenario: {
      fileStateStableAfterBoundedCleanup: true,
      fileStateStableDuringNativeBackup: false,
    }, trustBoundary: 'fixture',
  };
  const quiescence = {
    blockers: [], cronLifecycle: {
      separateDaemon: false, separateStartAllowed: false,
    }, decision: 'installation_wide_quiescence_required',
    executionClass: 'github_actions_exact_lane', hermes: {},
    lifecycleModel: { scenarios: Array(23).fill({}) },
    qualification: 'task_1_10_evidence_only',
    restoreOracleExtensions: Array.from({ length: 11 }, (_, index) => ({
      checkId: `q${index}`, reason: 'fixture', status: 'pass',
    })),
    schema: 'agentbootup.hermes-m0h-quiescence/v1',
    scopeDecision: {
      scope: 'installation_wide', profileScopedSafe: false,
      nativeLifecycleActuationTested: false, siblingConsentRequired: true,
    },
    sourceEvidence: Array(12).fill({}), trustBoundary: 'fixture',
    writerMatrix: Array(14).fill({}),
  };
  const database = {
    blockers: [], cleanup: {
      boundedIdentityCleanup: true, rawArchivesRetained: false,
      snapshotsRetained: false, temporaryHomesRetained: false,
    },
    decision: 'sqlite_api_capture_qualified_for_six_captured_databases',
    engineSafeSnapshots: { allQualified: true, count: 6 },
    executionClass: 'github_actions_exact_lane',
    failureSemantics: {
      fullBackup: {
        archiveRetainedByNativeCommand: true, probeRetainedRawArchive: false,
        reportedIncomplete: true, returnedNormally: true,
      },
      safeCopy: {
        destinationDeleted: true, returnedFalse: true, sourceStillValid: true,
      },
    },
    hermes: {}, nativeFullBackup: {
      allSixEquivalentToEngineSafe: true, databaseMembersQualified: 6,
    },
    qualification: 'task_1_11_evidence_only',
    restoreOracleDraft: [
      ['HERMES-RO-DB-INTEGRITY-001', 'six_engine_safe_snapshots_full_integrity'],
      ['HERMES-RO-DB-SCHEMA-001', 'six_exact_schema_fingerprints'],
      ['HERMES-RO-DB-CANARY-001', 'six_native_fixture_and_wal_canary_sets'],
      ['HERMES-RO-DB-WAL-001', 'six_open_wal_writers_raw_copy_rejected'],
      ['HERMES-RO-DB-BACKUP-FAIL-CLOSED-001', 'low_level_safe_copy_primitive_only'],
      ['HERMES-RO-DB-SOURCE-SIDECAR-DISPOSITION-001', 'measured_disposable_sidecars_identity_bound_cleanup'],
    ].map(([checkId, evidence]) => ({
      checkId, evidence, status: 'pass',
      strategy: 'profile_export_plus_engine_safe_supplements',
    })),
    schema: 'agentbootup.hermes-m0h-database/v1',
    scope: {
      databaseClasses: 2, disposableCloneOnly: true, liveHomeTouched: false,
      openCommittedWalWriters: 6, profiles: 3, scenarioSidecarsCreated: 12,
      scenarioSidecarDisposition: 'deleted_with_bounded_disposable_clone',
      sourceSidecarsTouched: false,
    },
    strategyComparison: {
      rawMainOnly: { committedWalCanariesMissed: 6, qualified: false },
      rawProfileExport: { profilesTested: 3, qualified: false },
    },
  };

  writeJson(dirs.install, 'offline-install-receipt.json', receipt);
  writeJson(dirs.install, 'artifacts/closure-manifest.json', manifest);
  writeJson(dirs.evidence, 'synthetic-report.json', synthetic);
  writeJson(dirs.evidence, 'artifact-preflight-report.json', probe('artifact_preflight'));
  writeJson(dirs.evidence, 'profile-list-report.json', probe('profile_list', true));
  writeJson(dirs.transfer, 'profile-transfer-report.json', transfer);
  writeJson(dirs.full, 'full-backup-report.json', full);
  writeJson(dirs.quiescence, 'quiescence-report.json', quiescence);
  writeJson(dirs.database, 'database-report.json', database);

  const options = {
    artifactRoot: path.join(base, 'upload'),
    databaseRoot: dirs.database, evidenceRoot: dirs.evidence,
    executionContext: {
      imageOS: 'ubuntu24', imageVersion: 'fixture', kernel: 'fixture',
      machine: 'x86_64', runnerArch: 'X64', runnerOS: 'Linux',
    },
    fullRoot: dirs.full, installRoot: dirs.install,
    quiescenceRoot: dirs.quiescence, transferRoot: dirs.transfer,
  };
  return { base, dirs, options };
}

function treeDigest(root: string) {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(root).sort()) {
    hash.update(name).update('\0').update(fs.readFileSync(path.join(root, name)));
  }
  return hash.digest('hex');
}

function reverseObjectKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]),
  );
}

function reorderJsonTree(root: string) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) reorderJsonTree(candidate);
    else if (entry.name.endsWith('.json')) {
      writeJson(path.dirname(candidate), path.basename(candidate),
        reverseObjectKeys(JSON.parse(fs.readFileSync(candidate, 'utf8'))));
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Hermes M0-H evidence projector', () => {
  test('projects the policy-exact set deterministically and validates before publish', () => {
    const first = fixture();
    const expectedFiles = loadPolicy().artifacts.members.length;
    expect(projectHermesM0hEvidence(first.options).files).toBe(expectedFiles);
    expect(validateArtifactDirectory(first.options.artifactRoot).files).toBe(expectedFiles);
    const digest = treeDigest(first.options.artifactRoot);

    const second = fixture();
    for (const root of Object.values(second.dirs)) reorderJsonTree(root);
    projectHermesM0hEvidence(second.options);
    expect(treeDigest(second.options.artifactRoot)).toBe(digest);
  });

  test('detects an input-root replacement during projection and publishes nothing', () => {
    const value = fixture();
    const originalRead = fs.readFileSync;
    let swapped = false;
    (fs as any).readFileSync = function (...args: any[]) {
      if (!swapped && typeof args[0] === 'number') {
        swapped = true;
        const displaced = `${value.dirs.database}-displaced`;
        fs.renameSync(value.dirs.database, displaced);
        fs.mkdirSync(value.dirs.database, { mode: 0o700 });
        fs.copyFileSync(
          path.join(displaced, 'database-report.json'),
          path.join(value.dirs.database, 'database-report.json'),
        );
        fs.chmodSync(path.join(value.dirs.database, 'database-report.json'), 0o600);
      }
      return originalRead.apply(fs, args as any);
    };
    try {
      expect(() => projectHermesM0hEvidence(value.options)).toThrow(/identity changed/i);
    } finally {
      (fs as any).readFileSync = originalRead;
    }
    expect(swapped).toBe(true);
    expect(fs.existsSync(value.options.artifactRoot)).toBe(false);
    expect(fs.readdirSync(value.base).some((name) => name.includes('.stage-'))).toBe(false);
  });

  test('rejects duplicate keys and cleans staging without publishing', () => {
    const value = fixture();
    const file = path.join(value.dirs.database, 'database-report.json');
    fs.writeFileSync(file, '{"schema":"a","schema":"b"}\n', { mode: 0o600 });
    expect(() => projectHermesM0hEvidence(value.options)).toThrow(/duplicate object key/i);
    expect(fs.existsSync(value.options.artifactRoot)).toBe(false);
    expect(fs.readdirSync(value.base).some((name) => name.includes('.stage-'))).toBe(false);
  });

  test('never alters an existing output and rejects overlapping, linked, or loose inputs', () => {
    const existing = fixture();
    fs.mkdirSync(existing.options.artifactRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(existing.options.artifactRoot, 'sentinel'), 'keep', { mode: 0o600 });
    expect(() => projectHermesM0hEvidence(existing.options)).toThrow(/must not already exist/i);
    expect(fs.readFileSync(path.join(existing.options.artifactRoot, 'sentinel'), 'utf8')).toBe('keep');

    const overlap = fixture();
    expect(() => projectHermesM0hEvidence({
      ...overlap.options, transferRoot: overlap.options.evidenceRoot,
    })).toThrow(/pairwise non-overlapping/i);

    const linked = fixture();
    const report = path.join(linked.dirs.database, 'database-report.json');
    const target = path.join(linked.dirs.database, 'target.json');
    fs.renameSync(report, target);
    fs.symlinkSync(target, report);
    expect(() => projectHermesM0hEvidence(linked.options)).toThrow(/regular file/i);

    const hardlinked = fixture();
    const hardlinkReport = path.join(hardlinked.dirs.database, 'database-report.json');
    fs.linkSync(hardlinkReport, path.join(hardlinked.dirs.database, 'second-link.json'));
    expect(() => projectHermesM0hEvidence(hardlinked.options)).toThrow(/regular file/i);

    const loose = fixture();
    fs.chmodSync(path.join(loose.dirs.database, 'database-report.json'), 0o644);
    expect(() => projectHermesM0hEvidence(loose.options)).toThrow(/private regular file/i);

    const linkedRoot = fixture();
    const realEvidence = linkedRoot.options.evidenceRoot;
    const symlinkRoot = path.join(linkedRoot.base, 'linked-evidence');
    fs.symlinkSync(realEvidence, symlinkRoot);
    expect(() => projectHermesM0hEvidence({
      ...linkedRoot.options, evidenceRoot: symlinkRoot,
    })).toThrow(/real, private directory/i);
  });

  test('rejects every exact forbidden fixture without publishing or echoing it', () => {
    for (const testCase of forbidden.cases) {
      const value = fixture();
      const file = path.join(value.dirs.database, 'database-report.json');
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      const forbiddenValue = 'fragments' in testCase
        ? testCase.fragments.join('')
        : testCase.value;
      if (testCase.kind === 'unexpected_field') report[testCase.field] = forbiddenValue;
      else report.blockers = [forbiddenValue];
      writeJson(value.dirs.database, 'database-report.json', report);
      let message = '';
      try {
        projectHermesM0hEvidence(value.options);
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/refused|rejected/i);
      expect(message).not.toContain(typeof forbiddenValue === 'string'
        ? forbiddenValue
        : JSON.stringify(forbiddenValue));
      expect(fs.existsSync(value.options.artifactRoot)).toBe(false);
      expect(fs.readdirSync(value.base).some((name) => name.includes('.stage-'))).toBe(false);
    }
  });

  test('CLI requires a private request and publishes the same validated set', () => {
    const value = fixture();
    const request = writeJson(value.dirs.evidence, 'project-request.json', value.options);
    const script = path.resolve('scripts/runtime-adapters/hermes-m0h-project-evidence.mjs');
    const run = spawnSync(process.execPath, [script, '--request', request], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const expectedFiles = loadPolicy().artifacts.members.length;
    expect(JSON.parse(run.stdout)).toEqual({ files: expectedFiles });
    expect(validateArtifactDirectory(value.options.artifactRoot).files).toBe(expectedFiles);

    const loose = fixture();
    const looseRequest = writeJson(loose.dirs.evidence, 'loose-request.json', loose.options);
    fs.chmodSync(looseRequest, 0o644);
    const refused = spawnSync(process.execPath, [script, '--request', looseRequest], { encoding: 'utf8' });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/private regular file/i);
    expect(fs.existsSync(loose.options.artifactRoot)).toBe(false);
  });
});
