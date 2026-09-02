import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { validateBrainWorkspaceV1 } from '../../lib/brain/brain-workspace.js';
import { validateBrainWorkspaceV1 as validateBrainWorkspaceV1FromIndex } from '../../lib/brain/index.js';

test('brain-workspace-v1 schema artifact exists and pins v1 schema_version', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve('schemas/brain-workspace-v1.schema.json'), 'utf-8'));
  assert.equal(schema.required.includes('schema_version'), true);
  assert.equal(schema.required.includes('repo'), true);
  assert.equal(schema.required.includes('ref'), true);
  assert.equal(schema.required.includes('volume_strategy'), true);
  assert.equal(schema.required.includes('mount_path'), true);
  assert.deepEqual(schema.properties.volume_strategy.enum, ['fly_volume_fork', 'local_worktree']);
});

test('validateBrainWorkspaceV1 accepts pinned checkout workspace definition', () => {
  const r = validateBrainWorkspaceV1({
    schema_version: '1.0',
    repo: 'https://github.com/dundas/agent-host.git',
    ref: '0123456789abcdef0123456789abcdef01234567',
    depth: 1,
    auth: {
      type: 'vault',
      vault_secret: 'agent-host/github-token',
    },
    volume_strategy: 'fly_volume_fork',
    worktree_include: ['packages/agent-host', 'schemas'],
    env_allowlist: ['github-token', 'openai-api-key'],
    output_paths: ['dist', 'logs/bootstrap.json'],
    post_clone: ['bun install', 'bun run build'],
    mount_path: '/workspace/agent-host',
  });
  assert.equal(r.ok, true);
});

test('brain workspace validator is exported from the brain helper index', () => {
  assert.equal(validateBrainWorkspaceV1FromIndex, validateBrainWorkspaceV1);
});

test('validateBrainWorkspaceV1 rejects incompatible schema versions', () => {
  const r = validateBrainWorkspaceV1({
    schema_version: '2.0',
    repo: 'https://github.com/dundas/agent-host.git',
    ref: '0123456789abcdef0123456789abcdef01234567',
    volume_strategy: 'local_worktree',
    mount_path: '/workspace/agent-host',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /schema_version/);
});

test('validateBrainWorkspaceV1 rejects missing required fields and invalid depth', () => {
  const r = validateBrainWorkspaceV1({
    schema_version: '1.0',
    repo: '',
    ref: '0123456789abcdef0123456789abcdef01234567',
    depth: 0,
    mount_path: '',
  });
  assert.equal(r.ok, false);
  const joined = r.errors.join('\n');
  assert.match(joined, /repo is required/);
  assert.match(joined, /depth must be an integer >= 1/);
  assert.match(joined, /volume_strategy must be one of/);
  assert.match(joined, /mount_path is required/);
});

test('validateBrainWorkspaceV1 rejects non-pinned refs and invalid auth shape', () => {
  const r = validateBrainWorkspaceV1({
    schema_version: '1.0',
    repo: 'https://github.com/dundas/agent-host.git',
    ref: 'main',
    auth: { type: 'vault' },
    volume_strategy: 'local_worktree',
    mount_path: '/workspace/agent-host',
  });
  assert.equal(r.ok, false);
  const joined = r.errors.join('\n');
  assert.match(joined, /pinned full git SHA/);
  assert.match(joined, /auth\.vault_secret/);
});

test('validateBrainWorkspaceV1 rejects unknown properties and invalid array entries', () => {
  const r = validateBrainWorkspaceV1({
    schema_version: '1.0',
    repo: 'https://github.com/dundas/agent-host.git',
    ref: '0123456789abcdef0123456789abcdef01234567',
    volume_strategy: 'local_worktree',
    mount_path: '/workspace/agent-host',
    unknown_field: true,
    auth: {
      type: 'vault',
      vault_secret: 'agent-host/github-token',
      extra: 'nope',
    },
    worktree_include: ['ok', 42],
  });
  assert.equal(r.ok, false);
  const joined = r.errors.join('\n');
  assert.match(joined, /unknown_field is not allowed/);
  assert.match(joined, /auth\.extra is not allowed/);
  assert.match(joined, /worktree_include entries must be non-empty strings/);
});
