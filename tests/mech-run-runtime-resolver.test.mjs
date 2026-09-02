import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globalRuntimeBins, resolveMechRunRuntime } from '../scripts/mech-run-runtime-resolver.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root() { const value = mkdtempSync(join(tmpdir(), 'agentbootup-mech-run-resolver-')); roots.push(value); return value; }
function runtime(file, version) {
  mkdirSync(join(file, '..'), { recursive: true });
  if (file.includes('/node_modules/@mech/run/bin/')) {
    const packageRoot = dirname(dirname(file));
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@mech/run', version }));
  }
  writeFileSync(file, `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('mech-run v${version}');\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}
function shellRuntime(file, version) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `#!/bin/sh\necho 'mech-run v${version}'\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}
function trustedGlobal(file, version) {
  runtime(file, version);
  const root = join(file, '..', 'node_modules', '@mech', 'run');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@mech/run', version }));
  return file;
}
function resolverEnv(overrides = {}) {
  return {
    ...process.env,
    MECH_RUN_BIN: undefined,
    AGENTBOOTUP_MECH_RUN_SOURCE: undefined,
    MECH_RUN_MIN_VERSION: undefined,
    MECH_RUN_VERSION: undefined,
    AGENTBOOTUP_BUN_BIN: process.execPath,
    PATH: '',
    ...overrides,
  };
}

test('selects a compatible project-local runtime before a compatible global one', () => {
  const temp = root();
  const project = join(temp, 'project');
  const local = runtime(join(project, 'node_modules/@mech/run/bin/mech-run.js'), '0.4.12');
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { '@mech/run': '^0.4.12' } }));
  const globalDir = join(temp, 'global');
  trustedGlobal(join(globalDir, 'mech-run'), '0.4.13');
  const result = resolveMechRunRuntime({ cwd: project, env: resolverEnv({ PATH: globalDir }) });
  expect(result.ok).toBe(true);
  expect(result.selected.source).toBe('project-local');
  expect(result.selected.bin).toContain(local.replace('/var/', '/private/var/'));
});

test('rejects an incompatible project declaration and falls back to a compatible global runtime', () => {
  const temp = root();
  const project = join(temp, 'project');
  runtime(join(project, 'node_modules/@mech/run/bin/mech-run.js'), '0.4.12');
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { '@mech/run': '0.4.11' } }));
  const globalDir = join(temp, 'global');
  const global = trustedGlobal(join(globalDir, 'mech-run'), '0.4.13');
  const result = resolveMechRunRuntime({ cwd: project, env: resolverEnv({ PATH: `${globalDir}:${process.env.PATH}` }) });
  expect(result.ok).toBe(true);
  expect(result.selected.source).toBe('global');
  expect(result.selected.bin).toContain(global.replace('/var/', '/private/var/'));
  expect(result.candidates[0]).toMatchObject({ source: 'project-local', compatible: false });
});

test('skips any AgentBootup launcher on PATH to prevent recursive execution', () => {
  const temp = root();
  const recursiveDir = join(temp, 'recursive');
  const oldAgentbootup = join(temp, 'old-agentbootup');
  mkdirSync(recursiveDir, { recursive: true });
  mkdirSync(join(oldAgentbootup, 'scripts'), { recursive: true });
  writeFileSync(join(oldAgentbootup, 'package.json'), JSON.stringify({ name: 'agentbootup' }));
  writeFileSync(join(oldAgentbootup, 'scripts/mech-run-launcher.mjs'), '#!/usr/bin/env node\nthrow new Error("must not recurse");\n', { mode: 0o755 });
  symlinkSync(join(oldAgentbootup, 'scripts/mech-run-launcher.mjs'), join(recursiveDir, 'mech-run'));
  const globalDir = join(temp, 'global');
  const global = trustedGlobal(join(globalDir, 'mech-run'), '0.4.12');
  const result = resolveMechRunRuntime({ cwd: temp, env: resolverEnv({ PATH: `${recursiveDir}:${globalDir}:${process.env.PATH}` }) });
  expect(result.ok).toBe(true);
  expect(result.selected.source).toBe('global');
  expect(result.selected.bin).toContain(global.replace('/var/', '/private/var/'));
});

test('skips a plain Windows npm shim that wraps another AgentBootup launcher', () => {
  const temp = root();
  const recursiveDir = join(temp, 'recursive');
  const oldPackage = join(recursiveDir, 'node_modules', 'agentbootup');
  mkdirSync(join(oldPackage, 'scripts'), { recursive: true });
  writeFileSync(join(oldPackage, 'package.json'), JSON.stringify({ name: 'agentbootup' }));
  writeFileSync(join(oldPackage, 'scripts', 'mech-run-launcher.mjs'), '#!/usr/bin/env node\nthrow new Error("must not recurse");\n');
  writeFileSync(join(recursiveDir, 'mech-run.cmd'), '@echo off\r\nnode "%~dp0\\node_modules\\agentbootup\\scripts\\mech-run-launcher.mjs" %*\r\n');
  const globalDir = join(temp, 'global');
  const global = trustedGlobal(join(globalDir, 'mech-run.cmd'), '0.4.12');
  const commandShell = shellRuntime(join(temp, 'command-shell'), '0.4.12');
  const result = resolveMechRunRuntime({ cwd: temp, platform: 'win32', env: resolverEnv({ PATH: `${recursiveDir};${globalDir}`, COMSPEC: commandShell }) });
  expect(result.ok).toBe(true);
  expect(result.selected.source).toBe('global');
  expect(result.selected.bin).toContain(global.replace('/var/', '/private/var/'));
});

test('skips a local Windows npm .bin shim that wraps another AgentBootup launcher', () => {
  const temp = root();
  const recursiveDir = join(temp, 'project', 'node_modules', '.bin');
  const oldPackage = join(temp, 'project', 'node_modules', 'agentbootup');
  mkdirSync(join(oldPackage, 'scripts'), { recursive: true });
  mkdirSync(recursiveDir, { recursive: true });
  writeFileSync(join(oldPackage, 'package.json'), JSON.stringify({ name: 'agentbootup' }));
  writeFileSync(join(oldPackage, 'scripts', 'mech-run-launcher.mjs'), '#!/usr/bin/env node\nthrow new Error("must not recurse");\n');
  writeFileSync(join(recursiveDir, 'mech-run.cmd'), '@echo off\r\nnode "%~dp0%\\..\\agentbootup\\scripts\\mech-run-launcher.mjs" %*\r\n');
  const globalDir = join(temp, 'global');
  const global = trustedGlobal(join(globalDir, 'mech-run.cmd'), '0.4.12');
  const commandShell = shellRuntime(join(temp, 'command-shell'), '0.4.12');
  const result = resolveMechRunRuntime({ cwd: temp, platform: 'win32', env: resolverEnv({ PATH: `${recursiveDir};${globalDir}`, COMSPEC: commandShell }) });
  expect(result.ok).toBe(true);
  expect(result.selected.source).toBe('global');
  expect(result.selected.bin).toContain(global.replace('/var/', '/private/var/'));
});

test('rejects an unverified global executable even when it reports a compatible version', () => {
  const temp = root();
  const globalDir = join(temp, 'global');
  runtime(join(globalDir, 'mech-run'), '0.4.12');
  const result = resolveMechRunRuntime({ cwd: temp, env: resolverEnv({ PATH: globalDir }) });
  expect(result.ok).toBe(true);
  expect(result.selected.source).toBe('bundled');
  expect(result.candidates[0]).toMatchObject({ source: 'global', reason: 'package_identity_invalid', compatible: false });
});

test('fails closed for an explicit incompatible runtime instead of silently selecting another source', () => {
  const temp = root();
  const explicit = runtime(join(temp, 'explicit.js'), '0.4.5');
  const result = resolveMechRunRuntime({ cwd: temp, env: resolverEnv({ MECH_RUN_BIN: explicit }) });
  expect(result).toMatchObject({ ok: false, code: 'EXPLICIT_RUNTIME_INCOMPATIBLE', requiredRange: '>=0.4.12' });
});

test('fails closed when an explicit runtime is another AgentBootup launcher', () => {
  const temp = root();
  const oldAgentbootup = join(temp, 'old-agentbootup');
  mkdirSync(join(oldAgentbootup, 'scripts'), { recursive: true });
  writeFileSync(join(oldAgentbootup, 'package.json'), JSON.stringify({ name: 'agentbootup' }));
  const explicit = join(oldAgentbootup, 'scripts/mech-run-launcher.mjs');
  writeFileSync(explicit, '#!/usr/bin/env node\nthrow new Error("must not recurse");\n', { mode: 0o755 });
  const result = resolveMechRunRuntime({ cwd: temp, env: resolverEnv({ MECH_RUN_BIN: explicit }) });
  expect(result).toMatchObject({ ok: false, code: 'EXPLICIT_RUNTIME_INCOMPATIBLE' });
  expect(result.candidates[0]).toMatchObject({ reason: 'invalid_or_recursive_explicit_bin' });
});

test('discovers Windows global executable names without parsing PATH as Unix-only', () => {
  const temp = root();
  const global = join(temp, 'global');
  trustedGlobal(join(global, 'mech-run.cmd'), '0.4.12');
  const winPath = `${global};C:\\other`;
  expect(globalRuntimeBins({ PATH: winPath }, 'win32')).toContain(join(global, 'mech-run.cmd'));
});

test('selects a Windows .cmd global shim through COMSPEC', () => {
  const temp = root();
  const global = join(temp, 'global');
  trustedGlobal(join(global, 'mech-run.cmd'), '0.4.12');
  const commandShell = shellRuntime(join(temp, 'command-shell'), '0.4.12');
  const result = resolveMechRunRuntime({ cwd: temp, platform: 'win32', env: resolverEnv({ PATH: global, COMSPEC: commandShell }) });
  expect(result.ok).toBe(true);
  expect(result.selected).toMatchObject({ source: 'global', version: '0.4.12', command: commandShell });
  expect(result.selected.args).toEqual(['/d', '/s', '/c', join(global, 'mech-run.cmd')]);
  expect(result.selected.packageRoot).toContain(join('global', 'node_modules', '@mech', 'run'));
});

test.skipIf(process.platform !== 'win32')('executes a real Windows .cmd shim through cmd.exe', () => {
  const temp = root();
  const global = join(temp, 'global');
  const runtimeJs = runtime(join(global, 'runtime.js'), '0.4.12');
  const shim = join(global, 'mech-run.cmd');
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${runtimeJs}" %*\r\n`, { mode: 0o755 });
  const result = resolveMechRunRuntime({ cwd: temp, platform: 'win32',
    env: resolverEnv({ PATH: global, ComSpec: process.env.ComSpec || 'cmd.exe' }) });
  expect(result.ok).toBe(true);
  expect(result.selected).toMatchObject({ source: 'global', version: '0.4.12' });
});

test('honors MECH_RUN_VERSION as the caller compatibility contract', () => {
  const temp = root();
  const explicit = runtime(join(temp, 'explicit.js'), '0.4.12');
  const result = resolveMechRunRuntime({ cwd: temp, env: resolverEnv({ MECH_RUN_BIN: explicit, MECH_RUN_VERSION: '>=0.4.13' }) });
  expect(result).toMatchObject({ ok: false, code: 'EXPLICIT_RUNTIME_INCOMPATIBLE', requiredRange: '>=0.4.13' });
});

test('honors the deterministic bundled escape hatch and reports provenance', () => {
  const temp = root();
  const result = resolveMechRunRuntime({ cwd: temp, env: resolverEnv({ AGENTBOOTUP_MECH_RUN_SOURCE: 'bundled' }) });
  expect(result.ok).toBe(true);
  expect(result.selected).toMatchObject({ source: 'bundled', version: '0.4.12', requiredRange: '>=0.4.12' });
});
