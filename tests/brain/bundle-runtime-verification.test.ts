import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  computeBundleHash,
  installBundle,
  bundleStatus,
  publishBundle,
  rollbackBundle,
  isRuntimeFileEntry,
  verifyRequiredTargets,
  collectTaxonomyWarnings,
  normalizeBundleManifest,
} from '../../lib/bundle/installer.js';
import { runBundleCommand } from '../../lib/bundle/cli.js';

const tmpRoots: string[] = [];
const originalHome = process.env.AGENTBOOTUP_HOME;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
    out: () => out.join('\n'),
    err: () => err.join('\n'),
  };
}

afterEach(() => {
  process.env.AGENTBOOTUP_HOME = originalHome;
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRuntimeBundle(opts: { runtimeRole?: string | null; runtimeKind?: string } = {}) {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const sourceRoot = tempDir('ab-source-');
  const targetRoot = tempDir('ab-target-');

  const skillFile = '.claude/skills/demo/SKILL.md';
  const runtimeFile = 'brain/scripts/demo.ts';
  for (const rel of [skillFile, runtimeFile]) {
    const abs = path.join(sourceRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `# ${rel}\n`, 'utf8');
  }
  writeJson(path.join(targetRoot, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-one' });

  const manifest = normalizeBundleManifest({
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'test' },
    files: [
      { source: skillFile, target: skillFile, kind: 'skill', required: true, role: 'entrypoint' },
      {
        source: runtimeFile,
        target: runtimeFile,
        kind: opts.runtimeKind ?? 'runtime',
        required: true,
        role: opts.runtimeRole === undefined ? 'canonical-runtime' : opts.runtimeRole,
      },
    ],
  });
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;
  return { home, sourceRoot, targetRoot, manifest, skillFile, runtimeFile };
}

// --- isRuntimeFileEntry: covers every kind/role combo observed in the fleet ---

test('isRuntimeFileEntry matches all observed runtime taxonomy combos', () => {
  expect(isRuntimeFileEntry({ kind: 'repo', role: 'runtime' })).toBe(true);
  expect(isRuntimeFileEntry({ kind: 'runtime', role: null })).toBe(true);
  expect(isRuntimeFileEntry({ kind: 'runtime', role: 'canonical-runtime' })).toBe(true);
  expect(isRuntimeFileEntry({ kind: 'script', role: 'runtime' })).toBe(true);
  expect(isRuntimeFileEntry({ kind: 'runtime', role: 'runtime-library' })).toBe(true);
  expect(isRuntimeFileEntry({ kind: 'skill', role: 'entrypoint' })).toBe(false);
  expect(isRuntimeFileEntry({ kind: 'repo', role: null })).toBe(false);
  expect(isRuntimeFileEntry(null)).toBe(false);
  // Explicit role set, not a substring match: a future non-runtime role containing
  // the word must not be pulled into the runtime-verification path.
  expect(isRuntimeFileEntry({ kind: 'docs', role: 'runtime-adjacent-doc' })).toBe(false);
});

// --- erosion detection: the mech-browse narrative-generator failure mode ---

test('installBundle refuses to no-op when a required target has been eroded', () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();

  const first = installBundle({ manifest, sourceRoot, targetRoot });
  expect(first.noop).toBe(false);

  // Simulate the destructive clean: runtime payload deleted, ledger untouched.
  fs.rmSync(path.join(targetRoot, runtimeFile));

  expect(() => installBundle({ manifest, sourceRoot, targetRoot })).toThrow(/eroded|missing/i);
  try {
    installBundle({ manifest, sourceRoot, targetRoot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain(runtimeFile);
    expect(message).toContain('--force');
  }
});

test('installBundle still no-ops cleanly when all required targets are present', () => {
  const { sourceRoot, targetRoot, manifest } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });
  const second = installBundle({ manifest, sourceRoot, targetRoot });
  expect(second.noop).toBe(true);
});

test('installBundle noop path also detects erosion of materialized .agents targets', () => {
  const { sourceRoot, targetRoot, manifest, skillFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot, materializeAgents: true });

  const materialized = path.join(targetRoot, skillFile.replace('.claude/skills/', '.agents/skills/'));
  expect(fs.existsSync(materialized)).toBe(true);
  fs.rmSync(materialized);

  // The ledger recorded the materialization, so erosion is detected regardless of
  // whether the rerun passes --materialize-agents.
  expect(() => installBundle({ manifest, sourceRoot, targetRoot, materializeAgents: true })).toThrow(/eroded|missing/i);
  expect(() => installBundle({ manifest, sourceRoot, targetRoot })).toThrow(/eroded|missing/i);
});

test('installBundle noop path does not demand .agents targets the prior install never wrote', () => {
  const { sourceRoot, targetRoot, manifest } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });
  // Prior install did not materialize — a rerun requesting materialization must not
  // report the never-installed .agents copies as eroded.
  const rerun = installBundle({ manifest, sourceRoot, targetRoot, materializeAgents: true });
  expect(rerun.noop).toBe(true);
});

test('installBundle --force repairs an eroded target', () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });
  fs.rmSync(path.join(targetRoot, runtimeFile));

  const repaired = installBundle({ manifest, sourceRoot, targetRoot, force: true });
  expect(repaired.noop).toBe(false);
  expect(fs.existsSync(path.join(targetRoot, runtimeFile))).toBe(true);
});

test('fresh install fails and rolls back when a required target vanishes before state write', () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  // Validation command deletes the runtime after apply — verification must catch it
  // and the install must not record status:applied.
  manifest.validation = { commands: [`rm ${runtimeFile}`] };
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;

  expect(() => installBundle({ manifest, sourceRoot, targetRoot })).toThrow(/missing/i);

  const status = bundleStatus({ manifest, sourceRoot, targetRoot });
  expect(status.installed_state?.status).toBe('failed');
  // A never-successfully-installed bundle must NOT be diagnosed as eroded — the ledger
  // says 'failed', not 'applied'. Reporting "payload is eroded" would send a debugger
  // hunting a destructive clean that never happened.
  expect(status.target_status).toBe('NOT_APPLIED');
  expect(status.missing_required_targets).toEqual([]);
});

test('bundle report does not report a failed first install as eroded', async () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  manifest.validation = { commands: [`rm ${runtimeFile}`] };
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;
  expect(() => installBundle({ manifest, sourceRoot, targetRoot })).toThrow();

  const manifestPath = path.join(sourceRoot, 'skill-bundle-manifest.json');
  writeJson(manifestPath, manifest);
  const cap = makeIo();
  const code = await runBundleCommand(
    ['report', '--manifest', manifestPath, '--source-root', sourceRoot, '--target-root', targetRoot],
    cap.io,
  );
  expect(code).toBe(0);
  expect(`${cap.out()}\n${cap.err()}`).not.toContain('eroded');
});

test('a directory left at a required target path is not mistaken for the file', () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });

  // A partial clean (or a tool that recreates structure but not contents) can leave a
  // directory where the runtime file was. existsSync() would call that present.
  const dest = path.join(targetRoot, runtimeFile);
  fs.rmSync(dest);
  fs.mkdirSync(dest);

  const result = verifyRequiredTargets(manifest, targetRoot);
  expect(result.ok).toBe(false);
  expect(result.missing[0].target).toBe(runtimeFile);
  expect(bundleStatus({ manifest, sourceRoot, targetRoot }).target_status).toBe('MISSING_REQUIRED');
  expect(() => installBundle({ manifest, sourceRoot, targetRoot })).toThrow(/eroded|missing/i);
});

// --- verifyRequiredTargets ---

test('verifyRequiredTargets reports missing required files with runtime classification', () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });
  fs.rmSync(path.join(targetRoot, runtimeFile));

  const result = verifyRequiredTargets(manifest, targetRoot);
  expect(result.ok).toBe(false);
  expect(result.missing).toHaveLength(1);
  expect(result.missing[0].target).toBe(runtimeFile);
  expect(result.missing[0].runtime).toBe(true);
});

// --- bundleStatus surfaces target erosion ---

test('bundleStatus reports MISSING_REQUIRED when an installed target is eroded', () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });
  fs.rmSync(path.join(targetRoot, runtimeFile));

  const status = bundleStatus({ manifest, sourceRoot, targetRoot });
  expect(status.installed).toBe(true);
  expect(status.target_status).toBe('MISSING_REQUIRED');
  expect(status.missing_required_targets).toEqual([runtimeFile]);
});

test('bundleStatus reports erosion of previously materialized .agents targets', () => {
  const { sourceRoot, targetRoot, manifest, skillFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot, materializeAgents: true });

  const materializedRel = skillFile.replace('.claude/skills/', '.agents/skills/');
  fs.rmSync(path.join(targetRoot, materializedRel));

  const status = bundleStatus({ manifest, sourceRoot, targetRoot });
  expect(status.target_status).toBe('MISSING_REQUIRED');
  expect(status.missing_required_targets).toEqual([materializedRel]);
});

test('bundleStatus does not verify targets for a version the ledger never recorded', () => {
  const { sourceRoot, targetRoot, manifest, skillFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot, materializeAgents: true });
  fs.rmSync(path.join(targetRoot, skillFile.replace('.claude/skills/', '.agents/skills/')));

  // Inspecting a newer manifest version against the older ledger entry must not
  // reconstruct .agents mirrors that version never installed, nor claim erosion for
  // a version that was never applied.
  const newer = { ...manifest, bundle_version: '1.0.1', version_id: 'demo@1.0.1+sha256_other' };
  newer.bundle_hash = computeBundleHash(newer, sourceRoot);
  const status = bundleStatus({ manifest: newer, sourceRoot, targetRoot });
  expect(status.target_status).toBe('NOT_APPLIED');
  expect(status.missing_required_targets).toEqual([]);
});

test('rollback to empty (no prior version) is not reported as erosion', () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });
  rollbackBundle({ manifest, targetRoot });

  // The first install had no predecessor, so rollback removed the payload and the
  // ledger records rolled_back with a null version_id. Absence is intentional.
  expect(fs.existsSync(path.join(targetRoot, runtimeFile))).toBe(false);
  const status = bundleStatus({ manifest, sourceRoot, targetRoot });
  expect(status.installed_state?.status).toBe('rolled_back');
  expect(status.installed_state?.version_id).toBeNull();
  expect(status.target_status).toBe('NOT_APPLIED');
  expect(status.missing_required_targets).toEqual([]);
});

test('a failed upgrade that restores the previous version verifies that version, not the new one', () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });

  // v2 adds a required file and fails validation → rolls back to v1.
  const extraRel = '.claude/skills/demo/EXTRA.md';
  fs.writeFileSync(path.join(sourceRoot, extraRel), '# extra\n', 'utf8');
  const v2 = normalizeBundleManifest({
    ...manifest,
    bundle_version: '2.0.0',
    files: [...manifest.files, { source: extraRel, target: extraRel, kind: 'skill', required: true, role: 'reference' }],
    validation: { commands: ['exit 1'] },
  });
  v2.bundle_hash = computeBundleHash(v2, sourceRoot);
  v2.version_id = `demo@2.0.0+sha256_${v2.bundle_hash.replace('sha256:', '').slice(0, 8)}`;
  expect(() => installBundle({ manifest: v2, sourceRoot, targetRoot })).toThrow();

  // Ledger: rolled_back, pinned to v1. v2's extra file is intentionally absent.
  const v2Status = bundleStatus({ manifest: v2, sourceRoot, targetRoot });
  expect(v2Status.target_status).toBe('NOT_APPLIED');
  expect(v2Status.missing_required_targets).toEqual([]);

  // v1 is what is actually on disk, and it still verifies.
  const v1Status = bundleStatus({ manifest, sourceRoot, targetRoot });
  expect(v1Status.installed_state?.version_id).toBe(manifest.version_id);
  expect(v1Status.target_status).toBe('OK');

  // And v1 erosion is still caught.
  fs.rmSync(path.join(targetRoot, runtimeFile));
  expect(bundleStatus({ manifest, sourceRoot, targetRoot }).target_status).toBe('MISSING_REQUIRED');
});

test('bundleStatus reports target_status OK when targets are intact', () => {
  const { sourceRoot, targetRoot, manifest } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });
  const status = bundleStatus({ manifest, sourceRoot, targetRoot });
  expect(status.target_status).toBe('OK');
  expect(status.missing_required_targets).toEqual([]);
});

// --- bundle report fails on erosion ---

test('bundle report exits non-zero when a required target is missing', async () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });

  const manifestPath = path.join(sourceRoot, 'skill-bundle-manifest.json');
  writeJson(manifestPath, manifest);

  const ok = makeIo();
  const okCode = await runBundleCommand(
    ['report', '--manifest', manifestPath, '--source-root', sourceRoot, '--target-root', targetRoot],
    ok.io,
  );
  expect(okCode).toBe(0);

  // Human output carries target_status on the happy path too, not just the failure paths.
  expect(ok.out()).toContain('target_status: OK');

  fs.rmSync(path.join(targetRoot, runtimeFile));
  const eroded = makeIo();
  const erodedCode = await runBundleCommand(
    ['report', '--manifest', manifestPath, '--source-root', sourceRoot, '--target-root', targetRoot],
    eroded.io,
  );
  expect(erodedCode).not.toBe(0);
  expect(`${eroded.out()}\n${eroded.err()}`).toContain(runtimeFile);
  expect(eroded.out()).toContain('target_status: MISSING_REQUIRED');
});

test('bundle report prints target_status NOT_APPLIED for a never-installed bundle', async () => {
  const { sourceRoot, targetRoot, manifest } = makeRuntimeBundle();
  const manifestPath = path.join(sourceRoot, 'skill-bundle-manifest.json');
  writeJson(manifestPath, manifest);

  const cap = makeIo();
  const code = await runBundleCommand(
    ['report', '--manifest', manifestPath, '--source-root', sourceRoot, '--target-root', targetRoot],
    cap.io,
  );
  expect(code).toBe(0);
  expect(cap.out()).toContain('target_status: NOT_APPLIED');
});

test('bundle install exits VERIFICATION (7) on an eroded target', async () => {
  const { sourceRoot, targetRoot, manifest, runtimeFile } = makeRuntimeBundle();
  installBundle({ manifest, sourceRoot, targetRoot });
  fs.rmSync(path.join(targetRoot, runtimeFile));

  const manifestPath = path.join(sourceRoot, 'skill-bundle-manifest.json');
  writeJson(manifestPath, manifest);
  const cap = makeIo();
  const code = await runBundleCommand(
    ['install', '--manifest', manifestPath, '--source-root', sourceRoot, '--target-root', targetRoot],
    cap.io,
  );
  expect(code).toBe(7);
  expect(cap.err()).toContain('eroded');
});

// --- publish taxonomy warnings ---

test('collectTaxonomyWarnings does not flag memory_snapshot state/state_seed entries', () => {
  const manifest = normalizeBundleManifest({
    bundle_type: 'memory_snapshot',
    bundle_name: 'brain-memory',
    bundle_version: '1.0.0',
    version_id: 'x',
    bundle_hash: 'y',
    files: [
      { source: 'memory/MEMORY.md', target: 'memory/MEMORY.md', kind: 'state', role: 'state_seed' },
      { source: 'memory/daily/log.md', target: 'memory/daily/log.md', kind: 'state', role: 'state_seed' },
    ],
  });
  expect(collectTaxonomyWarnings(manifest)).toEqual([]);

  // The exemption is per-field: a memory_snapshot row mixing a valid state field
  // with an invalid partner field still warns on the invalid field.
  const mixed = normalizeBundleManifest({
    bundle_type: 'memory_snapshot',
    bundle_name: 'brain-memory',
    bundle_version: '1.0.0',
    version_id: 'x',
    bundle_hash: 'y',
    files: [
      { source: 'a.md', target: 'a.md', kind: 'state', role: 'typo-role' },
      { source: 'b.md', target: 'b.md', kind: 'typo-kind', role: 'state_seed' },
    ],
  });
  const mixedWarnings = collectTaxonomyWarnings(mixed);
  expect(mixedWarnings).toHaveLength(2);
  expect(mixedWarnings[0]).toContain('typo-role');
  expect(mixedWarnings[1]).toContain('typo-kind');

  // The same values on a skill_bundle are still flagged.
  const skillManifest = normalizeBundleManifest({
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'x',
    bundle_hash: 'y',
    files: [{ source: 'a.md', target: 'a.md', kind: 'state', role: 'state_seed' }],
  });
  expect(collectTaxonomyWarnings(skillManifest)).toHaveLength(2);
});

test('collectTaxonomyWarnings flags unknown kind/role values', () => {
  const manifest = normalizeBundleManifest({
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'x',
    bundle_hash: 'y',
    files: [
      { source: 'a.md', target: 'a.md', kind: 'skill', role: 'entrypoint' },
      { source: 'b.ts', target: 'b.ts', kind: 'mystery', role: 'sidekick' },
    ],
  });
  const warnings = collectTaxonomyWarnings(manifest);
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain('mystery');
  expect(warnings[1]).toContain('sidekick');
});

test('publishBundle surfaces taxonomy warnings in its result', () => {
  const { sourceRoot, manifest } = makeRuntimeBundle({ runtimeRole: 'runtime', runtimeKind: 'weird-kind' });
  const result = publishBundle({ manifest, sourceRoot, dryRun: true });
  expect(Array.isArray(result.taxonomy_warnings)).toBe(true);
  expect(result.taxonomy_warnings.some((w: string) => w.includes('weird-kind'))).toBe(true);
});
