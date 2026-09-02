import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEnvManifest } from './env-manifest.js';

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeManifest(root, name, body) {
  const dir = path.join(root, 'environments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body, null, 2));
}

const baseConfig = {
  projects: [
    { id: 'a', path: '/x/a', agent_id: 'a.gm' },
    { id: 'b', path: '/x/b', agent_id: 'b.gm' },
  ],
};

test('loadEnvManifest resolves order and validates ids', () => {
  const root = mkd('env-manifest-');
  writeManifest(root, 'decisive', {
    id: 'decisive',
    version: 1,
    projects: ['a', 'b'],
    install_order: ['b', 'a'],
  });

  const m = loadEnvManifest(root, 'decisive', baseConfig);
  assert.deepEqual(m.orderedProjectIds, ['b', 'a']);
});

test('loadEnvManifest rejects id vs filename mismatch', () => {
  const root = mkd('env-manifest-');
  writeManifest(root, 'decisive', {
    id: 'wrong',
    version: 1,
    projects: ['a'],
  });

  assert.throws(() => loadEnvManifest(root, 'decisive', baseConfig), /must match filename/);
});

test('loadEnvManifest rejects unknown project id', () => {
  const root = mkd('env-manifest-');
  writeManifest(root, 'decisive', {
    id: 'decisive',
    version: 1,
    projects: ['a', 'missing'],
  });

  assert.throws(() => loadEnvManifest(root, 'decisive', baseConfig), /unknown project id/);
});

test('loadEnvManifest rejects duplicate projects', () => {
  const root = mkd('env-manifest-');
  writeManifest(root, 'decisive', {
    id: 'decisive',
    version: 1,
    projects: ['a', 'a'],
  });

  assert.throws(() => loadEnvManifest(root, 'decisive', baseConfig), /duplicate project id/);
});

test('loadEnvManifest rejects incomplete install_order', () => {
  const root = mkd('env-manifest-');
  writeManifest(root, 'decisive', {
    id: 'decisive',
    version: 1,
    projects: ['a', 'b'],
    install_order: ['a'],
  });

  assert.throws(() => loadEnvManifest(root, 'decisive', baseConfig), /exactly once/);
});
