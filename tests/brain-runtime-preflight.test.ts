import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { runBrainRuntime } from '../lib/brain/runtime-cli.js';
import { runBrainCommand } from '../lib/network/commands/brain.js';
import { buildRuntimeManifest } from '../lib/brain/runtime-manifest.js';

const tempDirs: string[] = [];

function mkd(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), `.${prefix}`));
  tempDirs.push(dir);
  return dir;
}

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) } };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('runtime preflight requires an explicit source and target rather than inferring either', async () => {
  const { io, err } = makeIo();
  const code = await runBrainCommand(['runtime', 'preflight'], io);

  assert.equal(code, 2);
  assert.match(err.join('\n'), /missing value for --source/);
});

test('runtime verify retains its missing-manifest-value usage behavior', () => {
  const { io, err } = makeIo();
  const code = runBrainRuntime(['verify', '--manifest', '--json'], io);

  assert.equal(code, 2);
  assert.match(err.join('\n'), /runtime verify/);
});

test('runtime verify preserves first-manifest behavior for repeated declarations', () => {
  const root = mkd('brain-runtime-verify-');
  fs.mkdirSync(path.join(root, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brain', 'runtime.mjs'), 'export const ready = true;\n');
  fs.writeFileSync(path.join(root, 'first.json'), JSON.stringify(buildRuntimeManifest(root)));
  fs.writeFileSync(path.join(root, 'second.json'), '{"not":"a valid manifest"}');

  const { io, out, err } = makeIo();
  const code = runBrainRuntime(['verify', '--cwd', root, '--manifest', 'first.json', '--manifest', 'second.json', '--json'], io);

  assert.equal(code, 0);
  assert.equal(err.length, 0);
  assert.equal(JSON.parse(out[0]).runtime_parity.state, 'green');
});

test('runtime preflight is dry-run only and returns a non-secret declared source inventory', async () => {
  const source = mkd('brain-runtime-source-');
  const target = mkd('brain-runtime-target-');
  fs.mkdirSync(path.join(source, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(source, 'brain', 'runtime.mjs'), 'export const ready = true;\n');
  fs.writeFileSync(path.join(source, 'brain', '.env'), 'TOKEN=must-not-appear\n');
  const targetBefore = fs.readdirSync(target);

  const { io, out, err } = makeIo();
  const code = await runBrainCommand(['runtime', 'preflight', '--source', source, '--target', target, '--json'], io);

  assert.equal(code, 0);
  assert.equal(err.length, 0);
  assert.deepEqual(fs.readdirSync(target), targetBefore, 'preflight must not create or copy anything');
  const result = JSON.parse(out[0]);
  assert.equal(result.runtime_preflight.state, 'ready');
  assert.equal(result.runtime_preflight.source.declared, path.resolve(source));
  assert.equal(result.runtime_preflight.target.path, path.resolve(target));
  assert.deepEqual(result.runtime_preflight.source.manifest.files.map((file: { path: string }) => file.path), ['brain/runtime.mjs']);
});

test('runtime preflight fails closed for an unsafe target and has no apply mode', async () => {
  const source = mkd('brain-runtime-source-');
  const target = mkd('brain-runtime-target-');
  fs.mkdirSync(path.join(source, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(source, 'brain', 'runtime.mjs'), 'export {};\n');
  const link = path.join(mkd('brain-runtime-link-parent-'), 'target-link');
  fs.symlinkSync(target, link);

  const unsafe = makeIo();
  const unsafeCode = await runBrainCommand(['runtime', 'preflight', '--source', source, '--target', link], unsafe.io);
  assert.equal(unsafeCode, 1);
  assert.match(unsafe.out.join('\n'), /target_symlink_denied/);

  const apply = makeIo();
  const applyCode = await runBrainCommand(['runtime', 'preflight', '--source', source, '--target', target, '--apply'], apply.io);
  assert.equal(applyCode, 2);
  assert.match(apply.err.join('\n'), /dry-run only/);

  const positional = makeIo();
  const positionalCode = await runBrainCommand(['runtime', 'preflight', 'unexpected', '--source', source, '--target', target], positional.io);
  assert.equal(positionalCode, 2);
  assert.match(positional.err.join('\n'), /Usage:/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('runtime preflight rejects duplicate source declarations', () => {
  const source = mkd('brain-runtime-source-');
  const target = mkd('brain-runtime-target-');
  const { io, err } = makeIo();

  const code = runBrainRuntime(['preflight', '--source', source, '--source', source, '--target', target], io);

  assert.equal(code, 2);
  assert.match(err.join('\n'), /duplicate value for --source/);
});

test('runtime preflight rejects symlinked source ancestors and target runtime destinations', () => {
  const fixtureRoot = mkd('brain-runtime-parent-');
  const parent = path.join(fixtureRoot, 'actual-parent');
  const source = path.join(parent, 'source');
  const target = path.join(parent, 'target');
  fs.mkdirSync(path.join(source, 'brain'), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(source, 'brain', 'runtime.mjs'), 'export {};\n');

  const parentLink = path.join(fixtureRoot, 'parent-link');
  fs.symlinkSync(parent, parentLink);
  const sourceResult = makeIo();
  assert.equal(runBrainRuntime(['preflight', '--source', path.join(parentLink, 'source'), '--target', target], sourceResult.io), 1);
  assert.match(sourceResult.out.join('\n'), /source_symlink_denied/);

  const outside = mkd('brain-runtime-outside-');
  fs.symlinkSync(outside, path.join(target, 'brain'));
  const targetResult = makeIo();
  assert.equal(runBrainRuntime(['preflight', '--source', source, '--target', target], targetResult.io), 1);
  assert.match(targetResult.out.join('\n'), /target_symlink_denied/);
});
