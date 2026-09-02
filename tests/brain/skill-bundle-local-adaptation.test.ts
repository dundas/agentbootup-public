import { afterEach, expect, test } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeBundleHash as computeGeneratedBundleHash } from '../../scripts/generate-skill-manifests.ts';
import { computeBundleHash as computeInstallerBundleHash, computeInlineBundleHash } from '../../lib/bundle/installer.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function manifest(sourceText: string, version: string, validationCommands: string[] = [], mutations: unknown[] = []) {
  const source = 'skill/SKILL.md';
  const target = '.claude/skills/demo/SKILL.md';
  const contentHash = crypto.createHash('sha256').update(sourceText).digest('hex');
  const hash = crypto.createHash('sha256').update(`${source}\0${target}\0${contentHash}\0`);
  if (mutations.length > 0) hash.update(`mutations\0${JSON.stringify(mutations)}`);
  if (validationCommands.length > 0) hash.update(`\0validation\0${JSON.stringify(validationCommands)}`);
  const bundleHash = `sha256:${hash.digest('hex')}`;
  return {
    skill: 'demo', bundle_version: version, version_id: `demo@${version}`, bundle_hash: bundleHash,
    source: { repo: 'test' }, distribution: { mode: 'self_apply' },
    install: { state_file: '.state/demo.json', backup_root: '.backups/demo' },
    validation: { commands: validationCommands },
    mutations,
    files: [{ source, target, kind: 'skill', required: true, role: 'entrypoint' }],
  };
}

test('template installer hash matches the generator for the real brain-message-inbox manifest', async () => {
  const templatesRoot = path.resolve('templates');
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bundle-parity-target-'));
  roots.push(targetRoot);
  const manifestPath = path.join(templatesRoot, '.claude/skills/brain-message-inbox/skill-bundle-manifest.json');
  const fixture = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expected = await computeGeneratedBundleHash(
    fixture.files.map((file) => ({ ...file, absSource: path.join(templatesRoot, file.source) })),
    {
      mutationsCanonical: JSON.stringify(fixture.mutations),
      validationCanonical: JSON.stringify(fixture.validation.commands),
    },
  );

  const result = Bun.spawnSync([
    'bun', 'templates/scripts/skill-bundle.ts', 'status',
    '--manifest', '.claude/skills/brain-message-inbox/skill-bundle-manifest.json',
    '--source-root', templatesRoot,
    '--target-root', targetRoot,
  ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`actual_hash:  ${expected}`);
});

test('template installer and generator agree on state-seed exclusion and self-manifest normalization', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bundle-parity-self-manifest-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  const skillDir = path.join(sourceRoot, 'skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'payload\n');
  fs.writeFileSync(path.join(sourceRoot, 'state-seed.json'), '{"local":true}\n');

  const raw = manifest('payload\n', '1.0.0');
  raw.files.push(
    {
      source: 'skill-bundle-manifest.json', target: '.claude/skills/demo/skill-bundle-manifest.json',
      kind: 'repo', required: true, role: 'reference',
    },
    { source: 'state-seed.json', target: '.state/seed.json', kind: 'state', required: false, role: 'state_seed' },
  );
  const manifestPath = path.join(sourceRoot, 'skill-bundle-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(raw));
  const inputs = raw.files.map((file) => ({ ...file, absSource: path.join(sourceRoot, file.source) }));
  const generatedHash = await computeGeneratedBundleHash(inputs, { selfManifestSource: 'skill-bundle-manifest.json' });
  raw.bundle_hash = generatedHash;
  raw.version_id = `demo@1.0.0+sha256_${generatedHash.slice('sha256:'.length, 'sha256:'.length + 8)}`;
  fs.writeFileSync(manifestPath, JSON.stringify(raw));

  // State-seed changes are intentionally outside the managed payload hash.
  fs.writeFileSync(path.join(sourceRoot, 'state-seed.json'), '{"local":false}\n');
  expect(await computeGeneratedBundleHash(inputs, { selfManifestSource: 'skill-bundle-manifest.json' })).toBe(generatedHash);

  const result = Bun.spawnSync([
    'bun', 'templates/scripts/skill-bundle.ts', 'status', '--manifest', 'skill-bundle-manifest.json',
    '--source-root', sourceRoot, '--target-root', targetRoot,
  ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`actual_hash:  ${generatedHash}`);
});

test('an undeclared top-level manifest-named fixture stays raw when provenance is absent', () => {
  const fixture = (version: string, hash: string) => JSON.stringify({ version_id: version, bundle_hash: hash, fixture: true });
  const entry = {
    source: 'skill-bundle-manifest.json',
    target: '.claude/skills/demo/fixtures/skill-bundle-manifest.json',
    kind: 'skill', role: 'reference', required: true,
  };
  const initial = computeInlineBundleHash([{ ...entry, content: fixture('fixture@one', 'sha256:one') }], {
    bundleType: 'skill_bundle',
    selfManifestSources: [],
  });
  const changed = computeInlineBundleHash([{ ...entry, content: fixture('fixture@two', 'sha256:two') }], {
    bundleType: 'skill_bundle',
  });
  expect(changed).not.toBe(initial);
  // `null` is defensive input, but retains the same no-provenance contract.
  expect(computeInlineBundleHash([{ ...entry, content: fixture('fixture@two', 'sha256:two') }], {
    bundleType: 'skill_bundle', selfManifestSources: null as never,
  })).toBe(changed);
});

test('installer, generator, and bundled template share the full hash contract', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bundle-hash-contract-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(path.join(sourceRoot, 'skill'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'skill/SKILL.md'), 'payload\n');
  fs.writeFileSync(path.join(sourceRoot, 'state.json'), '{"state":1}\n');
  fs.writeFileSync(path.join(sourceRoot, 'protocol-bundle-manifest.json'), JSON.stringify({ version_id: 'protocol@1', bundle_hash: 'sha256:old', note: 'protocol payload' }));
  // This is deliberately malformed. It is a fixture, not the root self
  // manifest, and therefore must remain raw and hash-sensitive.
  fs.writeFileSync(path.join(sourceRoot, 'fixtures/skill-bundle-manifest.json'), '{not json');
  const full = {
    ...manifest('payload\n', '1.0.0', ['bun test']),
    dependencies: { zebra: '^2.0.0', alpha: '^1.0.0' },
    files: [
      { source: 'skill/SKILL.md', target: '.claude/skills/demo/SKILL.md', kind: 'skill', required: true, role: 'entrypoint' },
      { source: 'skill-bundle-manifest.json', target: '.claude/skills/demo/skill-bundle-manifest.json', kind: 'repo', required: true, role: 'reference' },
      { source: 'protocol-bundle-manifest.json', target: '.ai/protocols/demo/protocol-bundle-manifest.json', kind: 'repo', required: true, role: 'reference' },
      { source: 'fixtures/skill-bundle-manifest.json', target: '.claude/skills/demo/fixtures/skill-bundle-manifest.json', kind: 'skill', required: true, role: 'reference' },
      { source: 'state.json', target: '.state/demo.json', kind: 'state', required: true, role: 'state_seed' },
    ],
  };
  const manifestPath = path.join(sourceRoot, 'skill-bundle-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(full));
  const inputs = full.files.map((file) => ({ ...file, absSource: path.join(sourceRoot, file.source) }));
  const expected = await computeGeneratedBundleHash(inputs, {
    mutationsCanonical: JSON.stringify(full.mutations), validationCanonical: JSON.stringify(full.validation.commands), dependenciesCanonical: JSON.stringify(full.dependencies), selfManifestSource: 'skill-bundle-manifest.json',
  });
  expect(await computeGeneratedBundleHash(inputs, {
    mutationsCanonical: JSON.stringify(full.mutations), validationCanonical: JSON.stringify(full.validation.commands),
    dependenciesCanonical: JSON.stringify({ alpha: '^1.0.0', zebra: '^2.0.0' }), selfManifestSource: 'skill-bundle-manifest.json',
  })).toBe(expected);
  full.bundle_hash = expected;
  full.version_id = `demo@1.0.0+sha256_${expected.slice('sha256:'.length, 'sha256:'.length + 8)}`;
  fs.writeFileSync(manifestPath, JSON.stringify(full));
  expect(computeInstallerBundleHash(full, sourceRoot, { manifestPath })).toBe(expected);
  const status = Bun.spawnSync(['bun', 'templates/scripts/skill-bundle.ts', 'status', '--manifest', 'skill-bundle-manifest.json', '--source-root', sourceRoot, '--target-root', targetRoot], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(status.exitCode).toBe(0);
  expect(status.stdout.toString()).toContain(`actual_hash:  ${expected}`);

  fs.writeFileSync(path.join(sourceRoot, 'fixtures/skill-bundle-manifest.json'), '{still not json');
  const changedFixture = await computeGeneratedBundleHash(inputs, { mutationsCanonical: JSON.stringify(full.mutations), validationCanonical: JSON.stringify(full.validation.commands), dependenciesCanonical: JSON.stringify(full.dependencies), selfManifestSource: 'skill-bundle-manifest.json' });
  expect(changedFixture).not.toBe(expected);

  const snapshot = { ...full, bundle_type: 'memory_snapshot', bundle_hash: 'sha256:pending', version_id: 'demo@1.0.0+sha256_pending' };
  fs.writeFileSync(manifestPath, JSON.stringify(snapshot));
  const snapshotHash = await computeGeneratedBundleHash(inputs, { bundleType: 'memory_snapshot', mutationsCanonical: JSON.stringify(snapshot.mutations), validationCanonical: JSON.stringify(snapshot.validation.commands), dependenciesCanonical: JSON.stringify(snapshot.dependencies), selfManifestSource: 'skill-bundle-manifest.json' });
  expect(computeInstallerBundleHash(snapshot, sourceRoot, { manifestPath })).toBe(snapshotHash);
  snapshot.bundle_hash = snapshotHash;
  fs.writeFileSync(manifestPath, JSON.stringify(snapshot));
  const snapshotTemplate = Bun.spawnSync(['bun', 'templates/scripts/skill-bundle.ts', 'status', '--manifest', 'skill-bundle-manifest.json', '--source-root', sourceRoot, '--target-root', targetRoot], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(snapshotTemplate.exitCode).toBe(0);
  expect(snapshotTemplate.stdout.toString()).toContain(`actual_hash:  ${snapshotHash}`);
  fs.writeFileSync(path.join(sourceRoot, 'state.json'), '{"state":2}\n');
  expect(await computeGeneratedBundleHash(inputs, { bundleType: 'memory_snapshot', mutationsCanonical: JSON.stringify(snapshot.mutations), validationCanonical: JSON.stringify(snapshot.validation.commands), dependenciesCanonical: JSON.stringify(snapshot.dependencies), selfManifestSource: 'skill-bundle-manifest.json' })).not.toBe(snapshotHash);

  const malformedRoot = path.join(root, 'malformed-self');
  fs.mkdirSync(malformedRoot, { recursive: true });
  fs.writeFileSync(path.join(malformedRoot, 'skill-bundle-manifest.json'), '{malformed self manifest');
  const malformed = {
    ...manifest('ignored', '1.0.0'),
    files: [{ source: 'skill-bundle-manifest.json', target: '.claude/skills/demo/skill-bundle-manifest.json', kind: 'repo', required: true, role: 'reference' }],
  };
  fs.writeFileSync(path.join(malformedRoot, 'manifest.json'), JSON.stringify(malformed));
  const malformedInputs = malformed.files.map((file) => ({ ...file, absSource: path.join(malformedRoot, file.source) }));
  const malformedHash = await computeGeneratedBundleHash(malformedInputs);
  malformed.bundle_hash = malformedHash;
  fs.writeFileSync(path.join(malformedRoot, 'manifest.json'), JSON.stringify(malformed));
  expect(computeInstallerBundleHash(malformed, malformedRoot)).toBe(malformedHash);
  const malformedStatus = Bun.spawnSync(['bun', 'templates/scripts/skill-bundle.ts', 'status', '--manifest', 'manifest.json', '--source-root', malformedRoot, '--target-root', targetRoot], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(malformedStatus.exitCode).toBe(0);
  expect(malformedStatus.stdout.toString()).toContain(`actual_hash:  ${malformedHash}`);
  fs.writeFileSync(path.join(malformedRoot, 'skill-bundle-manifest.json'), '{different malformed root manifest');
  expect(await computeGeneratedBundleHash(malformedInputs)).not.toBe(malformedHash);
});

test('normal bundles skip absent state seeds while memory snapshots require them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bundle-absent-state-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(path.join(sourceRoot, 'skill'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'skill/SKILL.md'), 'payload');
  const normal = {
    ...manifest('payload', '1.0.0'),
    files: [
      { source: 'skill/SKILL.md', target: '.claude/skills/demo/SKILL.md', kind: 'skill', required: true, role: 'entrypoint' },
      { source: 'missing-state.json', target: '.state/demo.json', kind: 'state', required: true, role: 'state_seed' },
    ],
  };
  const inputs = normal.files.map((file) => ({ ...file, absSource: path.join(sourceRoot, file.source) }));
  normal.bundle_hash = await computeGeneratedBundleHash(inputs);
  fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(normal));
  const normalStatus = Bun.spawnSync(['bun', 'templates/scripts/skill-bundle.ts', 'status', '--manifest', 'manifest.json', '--source-root', sourceRoot, '--target-root', targetRoot], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(normalStatus.exitCode).toBe(0);
  expect(normalStatus.stdout.toString()).toContain(`actual_hash:  ${normal.bundle_hash}`);

  const snapshot = { ...normal, bundle_type: 'memory_snapshot', bundle_hash: 'sha256:pending' };
  fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(snapshot));
  await expect(computeGeneratedBundleHash(inputs, { bundleType: 'memory_snapshot' })).rejects.toThrow();
  const snapshotStatus = Bun.spawnSync(['bun', 'templates/scripts/skill-bundle.ts', 'status', '--manifest', 'manifest.json', '--source-root', sourceRoot, '--target-root', targetRoot], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(snapshotStatus.exitCode).not.toBe(0);
  expect(snapshotStatus.stderr.toString()).toContain('Required source file missing');
});

test('nested declared self-manifest upgrades remain conflict-free', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bundle-self-upgrade-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  const sourceManifestRel = '.claude/skills/demo/skill-bundle-manifest.json';
  fs.mkdirSync(path.join(sourceRoot, '.claude/skills/demo'), { recursive: true });
  const self = {
    ...manifest('ignored', '1.0.0'),
    files: [{ source: sourceManifestRel, target: sourceManifestRel, kind: 'repo', required: true, role: 'reference' }],
  };
  const manifestPath = path.join(sourceRoot, sourceManifestRel);
  fs.writeFileSync(manifestPath, JSON.stringify(self));
  const inputs = self.files.map((file) => ({ ...file, absSource: path.join(sourceRoot, file.source) }));
  self.bundle_hash = await computeGeneratedBundleHash(inputs, { selfManifestSource: sourceManifestRel });
  self.version_id = 'demo@first';
  fs.writeFileSync(manifestPath, JSON.stringify(self));
  const run = () => Bun.spawnSync(['bun', 'templates/scripts/skill-bundle.ts', 'install', '--manifest', sourceManifestRel, '--source-root', sourceRoot, '--target-root', targetRoot, '--on-conflict', 'fail'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(run().exitCode).toBe(0);
  self.version_id = 'demo@second'; // self identity only: normalized bytes stay equal.
  fs.writeFileSync(manifestPath, JSON.stringify(self));
  const upgrade = run();
  expect(upgrade.exitCode).toBe(0);
  expect(upgrade.stderr.toString()).not.toContain('Local/upstream conflict');
});

function install(root: string, text: string, version: string, policy = 'fail', validationCommands: string[] = [], force = false, mutations: unknown[] = []) {
  const sourceRoot = `${root}${path.sep}source`;
  const targetRoot = `${root}${path.sep}target`;
  const skillRoot = `${sourceRoot}${path.sep}skill`;
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(`${skillRoot}${path.sep}SKILL.md`, text);
  fs.writeFileSync(`${sourceRoot}${path.sep}manifest.json`, JSON.stringify(manifest(text, version, validationCommands, mutations)));
  return Bun.spawnSync([
    'bun', 'templates/scripts/skill-bundle.ts', 'install', '--manifest', 'manifest.json',
    '--source-root', sourceRoot, '--target-root', targetRoot, '--on-conflict', policy,
    ...(force ? ['--force'] : []),
  ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
}

function rollback(root: string) {
  const sourceRoot = `${root}${path.sep}source`;
  const targetRoot = `${root}${path.sep}target`;
  return Bun.spawnSync([
    'bun', 'templates/scripts/skill-bundle.ts', 'rollback', '--manifest', 'manifest.json',
    '--source-root', sourceRoot, '--target-root', targetRoot,
  ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
}

function status(root: string) {
  const sourceRoot = `${root}${path.sep}source`;
  const targetRoot = `${root}${path.sep}target`;
  return Bun.spawnSync([
    'bun', 'templates/scripts/skill-bundle.ts', 'status', '--manifest', 'manifest.json',
    '--source-root', sourceRoot, '--target-root', targetRoot,
  ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
}

test('same-version force installs use immutable distinct backup generations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bundle-immutable-backup-'));
  roots.push(root);
  expect(install(root, 'upstream', '1.0.0').exitCode).toBe(0);
  const statePath = path.join(root, 'target/.state/demo.json');
  const firstState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const firstBackup = path.join(root, 'target', firstState.backup_path);
  const firstMetadata = fs.readFileSync(path.join(firstBackup, 'backup-metadata.json'));
  fs.writeFileSync(path.join(root, 'target/.claude/skills/demo/SKILL.md'), 'local-before-force');

  expect(install(root, 'upstream', '1.0.0', 'fail', [], true).exitCode).toBe(0);
  const secondState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const secondBackup = path.join(root, 'target', secondState.backup_path);
  expect(secondBackup).not.toBe(firstBackup);
  expect(fs.readFileSync(path.join(firstBackup, 'backup-metadata.json'))).toEqual(firstMetadata);
  expect(fs.readFileSync(path.join(secondBackup, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe('local-before-force');
});

test('failed template backup leaves prior generation and live targets unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bundle-backup-failure-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(path.join(sourceRoot, 'skill'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'skill/SKILL.md'), 'upstream skill');
  fs.writeFileSync(path.join(sourceRoot, 'skill/config.json'), '{"upstream":true}\n');
  const raw = {
    ...manifest('upstream skill', '1.0.0'),
    files: [
      { source: 'skill/SKILL.md', target: '.claude/skills/demo/SKILL.md', kind: 'skill', required: true, role: 'entrypoint' },
      { source: 'skill/config.json', target: '.claude/skills/demo/config.json', kind: 'repo', required: true, role: 'reference' },
    ],
  };
  raw.bundle_hash = computeInstallerBundleHash(raw, sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(raw));
  const run = () => Bun.spawnSync([
    'bun', 'templates/scripts/skill-bundle.ts', 'install', '--manifest', 'manifest.json',
    '--source-root', sourceRoot, '--target-root', targetRoot, '--on-conflict', 'theirs', '--force',
  ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(run().exitCode).toBe(0);
  const statePath = path.join(targetRoot, '.state/demo.json');
  const priorState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const priorBackup = path.join(targetRoot, priorState.backup_path);
  const priorMetadata = fs.readFileSync(path.join(priorBackup, 'backup-metadata.json'));
  const generationsRoot = path.dirname(priorBackup);

  fs.writeFileSync(path.join(targetRoot, '.claude/skills/demo/SKILL.md'), 'local skill');
  fs.rmSync(path.join(targetRoot, '.claude/skills/demo/config.json'));
  fs.mkdirSync(path.join(targetRoot, '.claude/skills/demo/config.json'));
  fs.writeFileSync(path.join(targetRoot, '.claude/skills/demo/config.json/local.txt'), 'local config');
  const failed = run();
  expect(failed.exitCode).not.toBe(0);
  expect(fs.readFileSync(path.join(priorBackup, 'backup-metadata.json'))).toEqual(priorMetadata);
  expect(fs.readdirSync(generationsRoot)).toEqual([path.basename(priorBackup)]);
  expect(fs.readFileSync(path.join(targetRoot, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe('local skill');
  expect(fs.readFileSync(path.join(targetRoot, '.claude/skills/demo/config.json/local.txt'), 'utf8')).toBe('local config');
});

test('three-way install preserves local-only changes and fails simultaneous changes with .bundle-new', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-'));
  roots.push(root);
  expect(install(root, 'base', '1.0.0').exitCode).toBe(0);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'target/.state/demo.json'), 'utf8'));
  expect(state.installed_file_hashes['.claude/skills/demo/SKILL.md']).toBe(
    crypto.createHash('sha256').update('base').digest('hex'),
  );

  // Upstream-only: local still equals base, so the new source applies.
  expect(install(root, 'upstream', '2.0.0').exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('upstream');

  // Local-only: upstream remains at the recorded base, so local wins.
  fs.writeFileSync(target, 'local-only');
  expect(install(root, 'upstream', '3.0.0').exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('local-only');

  // Both changed: non-TTY fail policy keeps local and writes the upstream candidate.
  const result = install(root, 'upstream-both', '4.0.0');
  expect(result.exitCode).not.toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('local-only');
  expect(fs.readFileSync(`${target}.bundle-new`, 'utf8')).toBe('upstream-both');
});

test('three-way detection treats a nested manifest fixture as raw bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-nested-manifest-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(path.join(sourceRoot, 'skill'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'fixtures'), { recursive: true });
  const fixture = (version: string, hash: string) => JSON.stringify({ version_id: version, bundle_hash: hash, fixture: true });
  fs.writeFileSync(path.join(sourceRoot, 'skill/SKILL.md'), 'base');
  fs.writeFileSync(path.join(sourceRoot, 'fixtures/skill-bundle-manifest.json'), fixture('fixture@1', 'sha256:one'));
  const files = [
    { source: 'skill/SKILL.md', target: '.claude/skills/demo/SKILL.md', kind: 'skill', required: true, role: 'entrypoint' },
    { source: 'fixtures/skill-bundle-manifest.json', target: '.claude/skills/demo/fixtures/skill-bundle-manifest.json', kind: 'skill', required: true, role: 'reference' },
  ];
  const makeBundle = async (version: string) => {
    const bundle = { ...manifest('base', version), files };
    bundle.bundle_hash = await computeGeneratedBundleHash(files.map((file) => ({ ...file, absSource: path.join(sourceRoot, file.source) })));
    fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(bundle));
    return bundle;
  };
  await makeBundle('1.0.0');
  expect(Bun.spawnSync(['bun', 'templates/scripts/skill-bundle.ts', 'install', '--manifest', 'manifest.json', '--source-root', sourceRoot, '--target-root', targetRoot, '--on-conflict', 'theirs'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
  const targetFixture = path.join(targetRoot, '.claude/skills/demo/fixtures/skill-bundle-manifest.json');
  fs.writeFileSync(targetFixture, fixture('fixture@local', 'sha256:local'));
  fs.writeFileSync(path.join(sourceRoot, 'skill/SKILL.md'), 'upstream');
  await makeBundle('2.0.0');
  const upgraded = Bun.spawnSync(['bun', 'templates/scripts/skill-bundle.ts', 'install', '--manifest', 'manifest.json', '--source-root', sourceRoot, '--target-root', targetRoot, '--on-conflict', 'fail'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(upgraded.exitCode).toBe(0);
  expect(fs.readFileSync(targetFixture, 'utf8')).toBe(fixture('fixture@local', 'sha256:local'));
});

test('explicit conflict policy can keep local content or take upstream content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-policy-'));
  roots.push(root);
  expect(install(root, 'base', '1.0.0').exitCode).toBe(0);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');

  fs.writeFileSync(target, 'local-keep');
  expect(install(root, 'upstream-keep', '2.0.0', 'keep').exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('local-keep');

  expect(install(root, 'upstream-theirs', '3.0.0', 'theirs').exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('upstream-theirs');
});

test('matching local and upstream bytes advance the three-way baseline without conflict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-converged-'));
  roots.push(root);
  expect(install(root, 'base', '1.0.0').exitCode).toBe(0);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');
  fs.writeFileSync(target, 'converged');

  expect(install(root, 'converged', '2.0.0').exitCode).toBe(0);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'target/.state/demo.json'), 'utf8'));
  expect(state.installed_file_hashes['.claude/skills/demo/SKILL.md']).toBe(
    crypto.createHash('sha256').update('converged').digest('hex'),
  );
});

test('first install does not overwrite a pre-existing target without an explicit policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-first-install-'));
  roots.push(root);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'pre-existing-local');

  const failed = install(root, 'upstream', '1.0.0');
  expect(failed.exitCode).not.toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('pre-existing-local');
  expect(fs.readFileSync(`${target}.bundle-new`, 'utf8')).toBe('upstream');

  expect(install(root, 'upstream', '1.0.0', 'theirs').exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('upstream');
});

test('first-install keep records the upstream ancestor for a later upgrade', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-first-keep-'));
  roots.push(root);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'local');
  expect(install(root, 'base', '1.0.0', 'keep').exitCode).toBe(0);
  expect(install(root, 'next', '2.0.0', 'keep').exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('local');
});

test('rollback preserves the hash baseline needed for the next three-way install', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-rollback-'));
  roots.push(root);
  expect(install(root, 'base', '1.0.0').exitCode).toBe(0);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');

  expect(install(root, 'broken', '2.0.0', 'fail', ['bun -e "process.exit(1)"']).exitCode).not.toBe(0);
  const rolledBack = JSON.parse(fs.readFileSync(path.join(root, 'target/.state/demo.json'), 'utf8'));
  expect(rolledBack.installed_file_hashes['.claude/skills/demo/SKILL.md']).toBe(
    crypto.createHash('sha256').update('base').digest('hex'),
  );

  expect(install(root, 'recovered', '3.0.0').exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('recovered');
});

test('explicit rollback restores the prior hash baseline for a later upgrade', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-explicit-rollback-'));
  roots.push(root);
  expect(install(root, 'base', '1.0.0').exitCode).toBe(0);
  expect(install(root, 'second', '2.0.0').exitCode).toBe(0);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');

  expect(rollback(root).exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('base');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'target/.state/demo.json'), 'utf8'));
  expect(state.installed_file_hashes['.claude/skills/demo/SKILL.md']).toBe(
    crypto.createHash('sha256').update('base').digest('hex'),
  );

  expect(install(root, 'third', '3.0.0').exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('third');
});

test('force reinstall restores the pristine contents of a locally adapted file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-force-'));
  roots.push(root);
  expect(install(root, 'base', '1.0.0').exitCode).toBe(0);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');
  fs.writeFileSync(target, 'local-adaptation');

  expect(install(root, 'base', '1.0.0', 'fail', [], true).exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('base');
});

test('force reinstall takes upstream when both local and upstream changed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-force-both-'));
  roots.push(root);
  expect(install(root, 'base', '1.0.0').exitCode).toBe(0);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');
  fs.writeFileSync(target, 'local-change');

  expect(install(root, 'upstream-change', '2.0.0', 'fail', [], true).exitCode).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe('upstream-change');
});

test('self-install is a no-op rather than an attempted self-copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-self-install-'));
  roots.push(root);
  const source = 'same.md';
  const content = 'self-managed';
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const bundleHash = `sha256:${crypto.createHash('sha256').update(`${source}\0${source}\0${contentHash}\0`).digest('hex')}`;
  const m = {
    skill: 'self', bundle_version: '1.0.0', version_id: 'self@1.0.0', bundle_hash: bundleHash,
    source: { repo: 'test' }, distribution: { mode: 'self_apply' },
    install: { state_file: '.state/self.json', backup_root: '.backups/self' }, files: [{ source, target: source, kind: 'skill', required: true, role: 'entrypoint' }],
  };
  fs.writeFileSync(path.join(root, source), content);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(m));

  const result = Bun.spawnSync([
    'bun', 'templates/scripts/skill-bundle.ts', 'install', '--manifest', 'manifest.json',
    '--source-root', root, '--target-root', root,
  ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  expect(fs.readFileSync(path.join(root, source), 'utf8')).toBe(content);
});

test('mutation-managed files honor keep and fail policies instead of changing local content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-mutation-'));
  roots.push(root);
  const targetRoot = path.join(root, 'target');
  const config = path.join(targetRoot, '.config');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(config, 'local-config\n');
  const mutations = [{ type: 'append_block_if_missing', path: '.config', content: 'managed-config' }];

  const first = install(root, 'base', '1.0.0', 'fail', [], false, mutations);
  expect(first.exitCode).not.toBe(0);
  expect(fs.readFileSync(config, 'utf8')).toBe('local-config\n');
  expect(fs.readFileSync(`${config}.bundle-new`, 'utf8')).toContain('managed-config');

  expect(install(root, 'base', '1.0.0', 'theirs', [], false, mutations).exitCode).toBe(0);
  const managedState = JSON.parse(fs.readFileSync(path.join(targetRoot, '.state/demo.json'), 'utf8'));
  fs.appendFileSync(config, 'local-change\n');
  expect(install(root, 'next', '2.0.0', 'fail', [], false, mutations).exitCode).toBe(0);
  expect(fs.readFileSync(config, 'utf8')).toContain('local-change');
  const state = JSON.parse(fs.readFileSync(path.join(targetRoot, '.state/demo.json'), 'utf8'));
  expect(state.kept_local_mutation_targets).toEqual([]);
  expect(state.kept_local_mutation_hashes).toEqual({});
  expect(state.installed_file_hashes['.config']).toBe(managedState.installed_file_hashes['.config']);
  expect(state.installed_mutation_hashes['.config']).toBe(managedState.installed_mutation_hashes['.config']);

  const changed = [{ type: 'append_block_if_missing', path: '.config', content: 'changed-managed-config' }];
  const changedResult = install(root, 'changed', '3.0.0', 'fail', [], false, changed);
  expect(changedResult.exitCode).not.toBe(0);
  expect(fs.readFileSync(`${config}.bundle-new`, 'utf8')).toContain('changed-managed-config');
});

test('kept mutation provenance survives an unchanged manifest version and changed definitions conflict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-kept-mutation-provenance-'));
  roots.push(root);
  const targetRoot = path.join(root, 'target');
  const config = path.join(targetRoot, '.config');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(config, 'locally-managed\n');
  const original = [{ type: 'append_block_if_missing', path: '.config', content: 'upstream-managed' }];
  const originalHash = crypto.createHash('sha256').update(JSON.stringify(original)).digest('hex');

  // First installation deliberately keeps the existing target instead of
  // applying the mutation.
  expect(install(root, 'one', '1.0.0', 'keep', [], false, original).exitCode).toBe(0);
  let state = JSON.parse(fs.readFileSync(path.join(targetRoot, '.state/demo.json'), 'utf8'));
  expect(state.kept_local_mutation_targets).toEqual(['.config']);
  expect(state.kept_local_mutation_hashes).toEqual({ '.config': originalHash });
  expect(state.installed_file_hashes?.['.config']).toBeUndefined();
  expect(state.installed_mutation_hashes?.['.config']).toBeUndefined();

  // A new manifest version with the exact same mutation retains that decision.
  expect(install(root, 'two', '2.0.0', 'fail', [], false, original).exitCode).toBe(0);
  state = JSON.parse(fs.readFileSync(path.join(targetRoot, '.state/demo.json'), 'utf8'));
  expect(state.kept_local_mutation_targets).toEqual(['.config']);
  expect(state.kept_local_mutation_hashes).toEqual({ '.config': originalHash });
  const statusResult = status(root);
  expect(statusResult.exitCode).toBe(0);
  expect(statusResult.stdout.toString()).toContain('kept_local_mutation_targets: .config');

  const changed = [{ type: 'append_block_if_missing', path: '.config', content: 'new-upstream-managed' }];
  const changedResult = install(root, 'three', '3.0.0', 'fail', [], false, changed);
  expect(changedResult.exitCode).not.toBe(0);
  expect(fs.readFileSync(`${config}.bundle-new`, 'utf8')).toContain('new-upstream-managed');
});

test('file/mutation overlap fails before creating a backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-overlap-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(path.join(sourceRoot, 'skill'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'skill/SKILL.md'), 'upstream');
  const collision = [{ type: 'append_block_if_missing', path: '.config', content: 'managed' }];
  const raw = manifest('upstream', '1.0.0', [], collision);
  raw.files[0].target = '.config';
  const contentHash = crypto.createHash('sha256').update('upstream').digest('hex');
  const bundleHash = crypto.createHash('sha256')
    .update(`skill/SKILL.md\0.config\0${contentHash}\0mutations\0${JSON.stringify(collision)}`)
    .digest('hex');
  raw.bundle_hash = `sha256:${bundleHash}`;
  fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(raw));

  const result = Bun.spawnSync([
    'bun', 'templates/scripts/skill-bundle.ts', 'install', '--manifest', 'manifest.json',
    '--source-root', sourceRoot, '--target-root', targetRoot,
  ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('cannot combine file entries and mutations');
  expect(fs.existsSync(path.join(targetRoot, '.backups'))).toBe(false);
});

test('a same-target mutation sequence produces one complete conflict candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-mutation-sequence-'));
  roots.push(root);
  const targetRoot = path.join(root, 'target');
  const config = path.join(targetRoot, '.config');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(config, 'local-config\n');
  const mutations = [
    { type: 'append_block_if_missing', path: '.config', content: 'first-block' },
    { type: 'append_block_if_missing', path: '.config', content: 'second-block' },
  ];

  expect(install(root, 'base', '1.0.0', 'fail', [], false, mutations).exitCode).not.toBe(0);
  expect(fs.readFileSync(`${config}.bundle-new`, 'utf8')).toContain('first-block');
  expect(fs.readFileSync(`${config}.bundle-new`, 'utf8')).toContain('second-block');
  expect(install(root, 'base', '1.0.0', 'theirs', [], false, mutations).exitCode).toBe(0);
  expect(fs.readFileSync(config, 'utf8')).toContain('first-block');
  expect(fs.readFileSync(config, 'utf8')).toContain('second-block');
});

test('an unchanged json_set mutation preserves a locally reformatted target on upgrade', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-json-set-'));
  roots.push(root);
  const targetRoot = path.join(root, 'target');
  const config = path.join(targetRoot, '.config.json');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(config, '{"user":true}\n');
  const mutations = [{ type: 'json_set', path: '.config.json', key_path: ['managed'], value: true }];

  expect(install(root, 'base', '1.0.0', 'theirs', [], false, mutations).exitCode).toBe(0);
  fs.writeFileSync(config, '{\n  "user": false,\n  "managed": true\n}\n');

  expect(install(root, 'next', '2.0.0', 'fail', [], false, mutations).exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ user: false, managed: true });
});

test('automatic mutation adaptation retains its managed baseline for a later revert and changed definition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-auto-mutation-'));
  roots.push(root);
  const targetRoot = path.join(root, 'target');
  const config = path.join(targetRoot, '.config');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(config, 'base\n');
  const original = [{ type: 'append_block_if_missing', path: '.config', content: 'managed-one' }];

  expect(install(root, 'one', '1.0.0', 'theirs', [], false, original).exitCode).toBe(0);
  const managedBaseline = fs.readFileSync(config, 'utf8');
  const initialState = JSON.parse(fs.readFileSync(path.join(targetRoot, '.state/demo.json'), 'utf8'));
  expect(initialState.installed_file_hashes['.config']).toBe(
    crypto.createHash('sha256').update(managedBaseline).digest('hex'),
  );

  fs.appendFileSync(config, 'local-adaptation\n');
  // The same mutation is automatically skipped, rather than treated as an
  // explicit keep decision.
  expect(install(root, 'two', '2.0.0', 'fail', [], false, original).exitCode).toBe(0);
  let state = JSON.parse(fs.readFileSync(path.join(targetRoot, '.state/demo.json'), 'utf8'));
  expect(state.kept_local_mutation_targets).toEqual([]);
  expect(state.kept_local_mutation_hashes).toEqual({});
  expect(state.installed_file_hashes['.config']).toBe(initialState.installed_file_hashes['.config']);
  expect(state.installed_mutation_hashes['.config']).toBe(initialState.installed_mutation_hashes['.config']);
  const adaptationStatus = status(root);
  expect(adaptationStatus.exitCode).toBe(0);
  expect(adaptationStatus.stdout.toString()).toContain('locally_adapted_mutation_targets: .config');

  // Once the target returns to the managed bytes, a changed mutation can apply
  // without a conflict because the installer still knows its common ancestor.
  fs.writeFileSync(config, managedBaseline);
  const changed = [{ type: 'append_block_if_missing', path: '.config', content: 'managed-two' }];
  const changedResult = install(root, 'three', '3.0.0', 'fail', [], false, changed);
  expect(changedResult.exitCode).toBe(0);
  expect(fs.readFileSync(config, 'utf8')).toContain('managed-two');
  expect(fs.existsSync(`${config}.bundle-new`)).toBe(false);
  state = JSON.parse(fs.readFileSync(path.join(targetRoot, '.state/demo.json'), 'utf8'));
  expect(state.kept_local_mutation_targets).toEqual([]);
  expect(state.installed_mutation_hashes['.config']).toBe(
    crypto.createHash('sha256').update(JSON.stringify(changed)).digest('hex'),
  );
});

test('a changed mutation definition invalidates the declared bundle hash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-mutation-hash-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(path.join(sourceRoot, 'skill'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'skill/SKILL.md'), 'base');
  const declared = manifest('base', '1.0.0', [], [
    { type: 'append_block_if_missing', path: '.config', content: 'original' },
  ]);
  declared.mutations = [{ type: 'append_block_if_missing', path: '.config', content: 'tampered' }];
  fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(declared));

  const result = Bun.spawnSync([
    'bun', 'templates/scripts/skill-bundle.ts', 'install', '--manifest', 'manifest.json',
    '--source-root', sourceRoot, '--target-root', targetRoot,
  ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Bundle hash mismatch');
});

test('prompt conflict policy fails immediately in non-interactive execution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-local-adaptation-prompt-'));
  roots.push(root);
  const target = path.join(root, 'target/.claude/skills/demo/SKILL.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'local');
  const result = install(root, 'upstream', '1.0.0', 'prompt');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('requires an interactive terminal');
});
