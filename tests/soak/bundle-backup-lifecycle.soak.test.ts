import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeBundleHash,
  installBundle,
  normalizeBundleManifest,
} from '../../lib/bundle/installer.js';
import {
  originalModeRecords,
  planStructuralBackupCopy,
  revalidateStructuralBackupCopy,
} from '../../lib/bundle/backup-containment.js';

const originalHome = process.env.AGENTBOOTUP_HOME;
const tempRoots: string[] = [];

afterEach(() => {
  if (originalHome == null) delete process.env.AGENTBOOTUP_HOME;
  else process.env.AGENTBOOTUP_HOME = originalHome;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function footprint(root: string) {
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const visit = (current: string) => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      directories += 1;
      for (const name of fs.readdirSync(current)) visit(path.join(current, name));
    } else {
      files += 1;
      bytes += stat.size;
    }
  };
  visit(root);
  return { files, directories, bytes };
}

function versionedManifest(sourceRoot: string, version: number) {
  const raw = {
    bundle_type: 'skill_bundle',
    bundle_name: 'containment-soak',
    bundle_version: `1.0.${version}`,
    version_id: `containment-soak@1.0.${version}+sha256_pending`,
    bundle_hash: 'sha256:pending',
    source: { repo: 'local-soak' },
    distribution: { mode: 'self_apply' },
    install: { state_file: 'skills/state/containment-soak.json', backup_root: 'skills/containment-soak' },
    validation: { commands: [] },
    files: [{ source: 'payload.txt', target: 'managed/payload.txt', required: true, role: 'entrypoint' }],
  };
  const pending = normalizeBundleManifest(raw);
  const hash = computeBundleHash(pending, sourceRoot);
  return normalizeBundleManifest({
    ...raw,
    bundle_hash: hash,
    version_id: `containment-soak@1.0.${version}+${hash.slice(7, 15)}`,
  });
}

test('ten distinct upgrade generations remain linear and never contain prior backups', () => {
  const sourceRoot = temp('ab-backup-soak-src-');
  const targetRoot = temp('ab-backup-soak-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-soak-home-');
  fs.writeFileSync(path.join(sourceRoot, 'payload.txt'), 'fleet payload\n');
  fs.mkdirSync(path.join(targetRoot, 'managed'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'managed/payload.txt'), 'local-0\n');

  for (let version = 0; version < 10; version += 1) {
    fs.writeFileSync(path.join(targetRoot, 'managed/payload.txt'), `local-${version}\n`);
    installBundle({
      manifest: versionedManifest(sourceRoot, version),
      sourceRoot,
      targetRoot,
      agentId: 'soak-agent',
      force: true,
    });
  }

  const generationRoot = path.join(
    process.env.AGENTBOOTUP_HOME,
    'brains/soak-agent/backups/skills/containment-soak',
  );
  const generations = fs.readdirSync(generationRoot).sort();
  expect(generations).toHaveLength(10);
  const sizes = generations.map((name) => footprint(path.join(generationRoot, name)));
  expect(Math.max(...sizes.map((entry) => entry.files))).toBeLessThanOrEqual(2);
  expect(Math.max(...sizes.map((entry) => entry.directories))).toBeLessThanOrEqual(3);
  expect(Math.max(...sizes.map((entry) => entry.bytes)))
    .toBeLessThanOrEqual(Math.min(...sizes.map((entry) => entry.bytes)) + 512);
  for (const generation of generations) {
    const relativePaths: string[] = [];
    const visit = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        relativePaths.push(path.relative(path.join(generationRoot, generation), absolute));
        if (entry.isDirectory()) visit(absolute);
      }
    };
    visit(path.join(generationRoot, generation));
    expect(relativePaths.some((relative) => relative.split(path.sep).includes('backups'))).toBe(false);
  }
});

test('ten structurally recursive attempts fail before creating the backup root', () => {
  const sourceRoot = temp('ab-backup-reject-soak-src-');
  const targetRoot = temp('ab-backup-reject-soak-target-');
  process.env.AGENTBOOTUP_HOME = path.join(targetRoot, '.agentbootup');
  fs.mkdirSync(process.env.AGENTBOOTUP_HOME);
  fs.writeFileSync(path.join(sourceRoot, 'payload.txt'), 'fleet payload\n');

  for (let version = 0; version < 10; version += 1) {
    const base = versionedManifest(sourceRoot, version);
    const raw = {
      ...base,
      files: [{ source: 'payload.txt', target: '.agentbootup', required: true, role: 'entrypoint' }],
      bundle_hash: 'sha256:pending',
      version_id: `containment-soak@1.0.${version}+sha256_pending`,
    };
    const pending = normalizeBundleManifest(raw);
    const hash = computeBundleHash(pending, sourceRoot);
    const fixture = normalizeBundleManifest({ ...raw, bundle_hash: hash, version_id: `containment-soak@1.0.${version}+${hash.slice(7, 15)}` });
    expect(() => installBundle({ manifest: fixture, sourceRoot, targetRoot, agentId: 'soak-agent' }))
      .toThrow('backup source and destination overlap');
  }

  expect(fs.readdirSync(process.env.AGENTBOOTUP_HOME)).toEqual([]);
});

test('representative dependency inventory remains bounded at ten thousand files', () => {
  const targetRoot = temp('ab-backup-scale-target-');
  const backupHome = temp('ab-backup-scale-home-');
  const nodeModules = path.join(targetRoot, 'node_modules');
  const backupsRoot = path.join(backupHome, 'brains/scale-agent/backups');
  fs.mkdirSync(backupsRoot, { recursive: true });
  for (let packageIndex = 0; packageIndex < 200; packageIndex += 1) {
    const packageRoot = path.join(nodeModules, `package-${packageIndex}`);
    fs.mkdirSync(packageRoot, { recursive: true });
    for (let fileIndex = 0; fileIndex < 50; fileIndex += 1) {
      fs.writeFileSync(path.join(packageRoot, `file-${fileIndex}.js`), 'export default 1;\n');
    }
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const plan = planStructuralBackupCopy({
    sourcePath: nodeModules,
    destinationPath: path.join(backupsRoot, 'generation/.dependencies/node_modules'),
    targetRoot,
    backupHome,
    backupsRoot,
    allowNestedSymlinks: true,
  });
  revalidateStructuralBackupCopy(plan, { targetRoot, backupHome });
  const modes = originalModeRecords(plan);
  const elapsedMs = performance.now() - startedAt;
  const heapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

  expect(modes).toHaveLength(10_201);
  expect(Buffer.byteLength(JSON.stringify(modes))).toBeLessThan(800_000);
  expect(heapGrowthBytes).toBeLessThan(64 * 1024 * 1024);
  // Generous enough for shared CI while still detecting accidental quadratic
  // traversal. Peak RSS is retained by the external `/usr/bin/time -l` gate.
  expect(elapsedMs).toBeLessThan(15_000);
});
