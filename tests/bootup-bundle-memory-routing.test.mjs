import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bootupPath = fileURLToPath(new URL('../bootup.mjs', import.meta.url));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(args) {
  return spawnSync('bun', [bootupPath, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

test('top-level bundle and memory commands honor leading global flags', () => {
  const cwd = tempDir('agentbootup-top-level-');

  const bundle = run(['--cwd', cwd, 'bundle', '--help']);
  assert.equal(bundle.status, 0);
  assert.match(bundle.stdout, /Usage: agentbootup bundle/);

  const memory = run(['--cwd', cwd, 'memory', '--help']);
  assert.equal(memory.status, 0);
  assert.match(memory.stdout, /Usage: agentbootup memory/);
});
