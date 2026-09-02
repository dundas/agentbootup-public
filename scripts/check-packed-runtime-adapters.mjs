#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbootup-pack-smoke-'));
const sourcePackage = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
// The published Storage SDK is hosted on Mech's scoped registry, as documented
// by its consumer installation guide. The isolated pack consumer must model
// that documented configuration rather than accidentally querying npmjs.
const mechNpmRegistry = 'https://registry.mechdna.net/api/packages/mech/npm/';

try {
  const packOutput = execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', tempRoot,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: path.join(tempRoot, 'npm-cache') },
  });
  const packResult = JSON.parse(packOutput);
  if (!Array.isArray(packResult) || packResult.length !== 1 || typeof packResult[0]?.filename !== 'string') {
    throw new Error('npm pack did not return exactly one packed artifact');
  }
  if (packResult[0].version !== sourcePackage.version) {
    throw new Error(`packed artifact version mismatch: expected ${sourcePackage.version}, received ${packResult[0].version}`);
  }
  const sourceOnlyEntries = (packResult[0].files ?? []).map((entry) => entry.path).filter((relative) =>
    /(^|\/)(tests?|fixtures?)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)docs\/evidence(\/|$)|(^|\/)tasks(\/|$)|(^|\/)\.env($|\.)/.test(relative));
  if (sourceOnlyEntries.length) {
    throw new Error(`source-only test, fixture, evidence, or secret-container files were published: ${sourceOnlyEntries.join(', ')}`);
  }

  const tarball = path.join(tempRoot, packResult[0].filename);
  execFileSync('tar', ['-xzf', tarball, '-C', tempRoot]);
  const packedRoot = path.join(tempRoot, 'package');
  const adapterRoot = path.join(packedRoot, 'lib', 'runtime-adapters');
  const shippedModules = (await fs.readdir(adapterRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();

  if (shippedModules.length === 0) throw new Error('packed artifact contains no runtime-adapter modules');
  if (!shippedModules.includes('portable-path.js')) {
    throw new Error('packed artifact is missing the shared portable-path runtime dependency');
  }
  if (shippedModules.includes('fixture-drift.js')) {
    throw new Error('source-only fixture-drift tooling must not be published');
  }
  if (shippedModules.includes('circle-agent.js') || shippedModules.includes('circle-candidate.js')) {
    throw new Error('deferred source-only Circle candidate implementation must not be published');
  }

  const productionVerifier = path.join(packedRoot, 'scripts', 'verify-transcript-archive-production.mjs');
  try {
    await fs.access(productionVerifier);
  } catch {
    throw new Error('packed artifact is missing the production transcript archive verifier');
  }
  const denylistHelper = path.join(packedRoot, 'scripts', 'append-redact-denylist.mjs');
  try {
    await fs.access(denylistHelper);
  } catch {
    throw new Error('packed artifact is missing the protected denylist append helper');
  }

  const sourceArchiveRoot = path.join(packageRoot, 'lib', 'transcript-archive');
  const packedArchiveRoot = path.join(packedRoot, 'lib', 'transcript-archive');
  const expectedArchiveModules = (await fs.readdir(sourceArchiveRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();
  const packedArchiveModules = (await fs.readdir(packedArchiveRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(packedArchiveModules) !== JSON.stringify(expectedArchiveModules)) {
    throw new Error(`packed transcript archive modules differ from source: expected ${expectedArchiveModules.join(', ')}, received ${packedArchiveModules.join(', ')}`);
  }
  const consumerRoot = path.join(tempRoot, 'consumer');
  await fs.mkdir(consumerRoot, { recursive: true });
  await fs.writeFile(path.join(consumerRoot, '.npmrc'), `@mech:registry=${mechNpmRegistry}\n`, 'utf8');
  execFileSync('npm', ['install', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund',
    '--prefix', consumerRoot, tarball], {
    cwd: tempRoot,
    stdio: 'pipe',
    env: { ...process.env, npm_config_cache: path.join(tempRoot, 'npm-cache') },
  });
  const installedArchiveRoot = path.join(consumerRoot, 'node_modules', 'agentbootup', 'lib', 'transcript-archive');
  const installedRoot = path.join(consumerRoot, 'node_modules', 'agentbootup');
  const installedPackage = JSON.parse(await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  if (installedPackage.version !== sourcePackage.version) {
    throw new Error(`installed package version mismatch: expected ${sourcePackage.version}, received ${installedPackage.version}`);
  }
  const configHome = path.join(tempRoot, 'clean-home');
  const configFile = path.join(configHome, '.agentbootup', 'config.json');
  const installedCli = path.join(consumerRoot, 'node_modules', '.bin', `agentbootup${process.platform === 'win32' ? '.cmd' : ''}`);
  const convergeCommand = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : installedCli;
  const convergeArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', `"${installedCli.replaceAll('"', '""')}" config set-converge on`]
    : ['config', 'set-converge', 'on'];
  const convergeProbe = spawnSync(convergeCommand, convergeArgs, {
    encoding: 'utf8',
    env: { ...process.env, HOME: configHome, USERPROFILE: configHome, AGENTBOOTUP_CONFIG_FILE: configFile },
  });
  if (convergeProbe.status !== 0) {
    throw new Error(`installed CLI cannot persist convergence: ${convergeProbe.stderr || convergeProbe.error?.message || 'unknown failure'}`);
  }
  const persistedConfig = JSON.parse(await fs.readFile(configFile, 'utf8'));
  if (persistedConfig.memoryConvergeEnabled !== true) {
    throw new Error('installed CLI did not persist memoryConvergeEnabled: true');
  }
  const installedDenylistHelper = path.join(
    consumerRoot, 'node_modules', '.bin',
    `agentbootup-append-redact-denylist${process.platform === 'win32' ? '.cmd' : ''}`,
  );
  try {
    await fs.access(installedDenylistHelper);
  } catch {
    throw new Error('installed package is missing the denylist append helper binary');
  }
  const helperCommand = process.platform === 'win32'
    ? (process.env.ComSpec ?? 'cmd.exe')
    : installedDenylistHelper;
  const helperArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', `"${installedDenylistHelper.replaceAll('"', '""')}"`]
    : [];
  const helperProbe = spawnSync(helperCommand, helperArgs, {
    input: '', encoding: 'utf8',
    env: { ...process.env, AGENTBOOTUP_REDACT_DENYLIST_FILE: path.join(tempRoot, 'probe-denylist') },
  });
  const expectedHelperDiagnostic = process.platform === 'win32'
    ? 'protected denylist append is unsupported on Windows'
    : 'refusing to append an empty denylist value';
  if (helperProbe.status === null || !helperProbe.stderr.includes(expectedHelperDiagnostic)) {
    throw new Error(`installed denylist helper is not executable: ${helperProbe.error?.code ?? helperProbe.stderr}`);
  }

  for (const relative of [
    'config/runtime-adapter-support-matrix-v1.json',
    'scripts/check-runtime-fixture-drift.mjs',
    'tests/runtime-adapters/fixtures',
    'tests/transcript-archive',
    'tests/soak',
    'docs/evidence',
    'tasks/0052a-native-command-probe-evidence.md',
  ]) {
    try {
      await fs.access(path.join(packedRoot, relative));
      throw new Error(`source-only runtime evidence was published: ${relative}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('source-only runtime evidence')) throw error;
    }
  }

  for (const moduleName of shippedModules) {
    await import(pathToFileURL(path.join(adapterRoot, moduleName)).href);
  }
  for (const moduleName of packedArchiveModules) {
    await import(pathToFileURL(path.join(installedArchiveRoot, moduleName)).href);
  }
  await import(pathToFileURL(productionVerifier).href);
  process.stdout.write(`Imported ${shippedModules.length} runtime-adapter and ${packedArchiveModules.length} installed transcript-archive modules from the package on Node ${process.versions.node}\n`);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
