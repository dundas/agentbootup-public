#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbootup-bundle-pack-smoke-'));
const previousHome = process.env.AGENTBOOTUP_HOME;

try {
  const packResult = JSON.parse(execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', tempRoot,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: path.join(tempRoot, 'npm-cache') },
  }));
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    throw new Error('npm pack did not return exactly one packed artifact');
  }
  const tarball = path.join(tempRoot, packResult[0].filename);
  execFileSync('tar', ['-xzf', tarball, '-C', tempRoot]);
  const packedRoot = path.join(tempRoot, 'package');
  // Exercise packed bytes without registry access. Runtime dependencies are the
  // already-installed, lockfile-qualified checkout dependencies; the package code
  // itself is loaded exclusively from the extracted tarball.
  await fs.symlink(
    path.join(packageRoot, 'node_modules'),
    path.join(packedRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const packedInstaller = path.join(packedRoot, 'lib', 'bundle', 'installer.js');
  const packedContainment = path.join(packedRoot, 'lib', 'bundle', 'backup-containment.js');
  const packedTemplateInstaller = path.join(packedRoot, 'templates', 'scripts', 'skill-bundle.ts');
  await fs.access(packedContainment);
  const packedTemplateBytes = await fs.readFile(packedTemplateInstaller, 'utf8');
  if (!packedTemplateBytes.includes('randomUUID()') || !packedTemplateBytes.includes('refusing to overwrite prior rollback evidence')) {
    throw new Error('packed artifact is missing immutable-generation protection in the template installer');
  }
  const { computeBundleHash, installBundle, normalizeBundleManifest } = await import(
    pathToFileURL(packedInstaller).href
  );

  const sourceRoot = path.join(tempRoot, 'source');
  const targetRoot = path.join(tempRoot, 'target');
  const backupHome = path.join(targetRoot, '.agentbootup');
  await fs.mkdir(path.join(sourceRoot, 'payload'), { recursive: true });
  await fs.mkdir(backupHome, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'payload', 'SKILL.md'), 'packed containment\n');
  process.env.AGENTBOOTUP_HOME = backupHome;
  const raw = {
    bundle_type: 'skill_bundle',
    bundle_name: 'packed-containment-smoke',
    bundle_version: '1.0.0',
    version_id: 'packed-containment-smoke@1.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'packed-smoke' },
    distribution: { mode: 'self_apply' },
    install: { state_file: 'skills/state/packed-smoke.json', backup_root: 'skills/packed-smoke' },
    validation: { commands: [] },
    files: [{ source: 'payload/SKILL.md', target: '.agentbootup', required: true, role: 'entrypoint' }],
  };
  const staged = normalizeBundleManifest(raw);
  const bundleHash = computeBundleHash(staged, sourceRoot);
  const manifest = normalizeBundleManifest({
    ...raw,
    bundle_hash: bundleHash,
    version_id: `packed-containment-smoke@1.0.0+${bundleHash.slice(7, 15)}`,
  });
  let diagnostic = '';
  try {
    installBundle({ manifest, sourceRoot, targetRoot, agentId: 'packed-smoke' });
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : String(error);
  }
  if (!diagnostic.includes('bundle backup structural preflight failed: backup source and destination overlap')) {
    throw new Error(`packed installer did not fail closed: ${diagnostic || 'install succeeded'}`);
  }
  const backupRoot = path.join(backupHome, 'brains', 'packed-smoke', 'backups');
  try {
    await fs.access(backupRoot);
    throw new Error('packed installer created a backup generation after containment failure');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  process.stdout.write(`Packed bundle containment smoke passed for ${packResult[0].filename}\n`);
} finally {
  if (previousHome == null) delete process.env.AGENTBOOTUP_HOME;
  else process.env.AGENTBOOTUP_HOME = previousHome;
  await fs.rm(tempRoot, { recursive: true, force: true });
}
