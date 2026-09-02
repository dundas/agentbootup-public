import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  validateNetworkConfig,
  normalizeRole,
  saveNetworkConfig,
  loadNetworkConfig,
} from '../lib/network/config.js';

test('normalizeRole returns role unchanged', () => {
  assert.equal(normalizeRole('network'), 'network');
  assert.equal(normalizeRole('portfolio'), 'portfolio');
  assert.equal(normalizeRole('project'), 'project');
});

test('validateNetworkConfig accepts valid network config', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'network',
    hub: 'https://agentdispatch.fly.dev',
    skills_source: '.',
    transcriptSync: {
      enabled: true,
      clis: ['claude', 'codex', 'gemini', 'cursor'],
      retentionDays: 90,
    },
    projects: [
      { id: 'alpha', path: '/tmp/alpha', agent_id: 'alpha-gm', branch: 'main' },
    ],
  });

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateNetworkConfig accepts canonical agent-host registry fixture', () => {
  const fixturePath = path.resolve('tests/fixtures/agent-host-network-root.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const result = validateNetworkConfig(fixture);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(fixture.projects[0].id, 'agent-host');
});

test('validateNetworkConfig accepts valid project config with network path', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'project',
    agent_id: 'alpha-gm',
    network: '/tmp/network-root',
    capabilities: ['x'],
  });

  assert.equal(result.valid, true);
});

test('validateNetworkConfig accepts camelCase project identity during migration', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'project',
    agentId: 'camel-brain',
    network: '/tmp/network',
  });
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('validateNetworkConfig accepts matching dual project identity keys', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'project',
    agent_id: 'matching-brain',
    agentId: 'matching-brain',
    network: '/tmp/network',
  });
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('validateNetworkConfig rejects conflicting dual project identity keys', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'project',
    agent_id: 'snake-brain',
    agentId: 'camel-brain',
    network: '/tmp/network',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' | '), /agent_id/);
  assert.match(result.errors.join(' | '), /agentId/);
  assert.match(result.errors.join(' | '), /refusing to choose a brain/);
  assert.doesNotMatch(result.errors.join(' | '), /requires agent_id/);
});

test('validateNetworkConfig rejects role portfolio', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'portfolio',
    projects: [],
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /role must be/);
});

test('validateNetworkConfig rejects project config with portfolio key instead of network key', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'project',
    agent_id: 'alpha-gm',
    portfolio: '/tmp/network-root',
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /network path/);
});

test('validateNetworkConfig rejects duplicate project ids', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'alpha', path: '/tmp/alpha', agent_id: 'alpha-gm' },
      { id: 'alpha', path: '/tmp/beta', agent_id: 'beta-gm' },
    ],
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /duplicate project id/);
});

test('validateNetworkConfig rejects invalid transcript sync and branch values', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'network',
    transcriptSync: {
      enabled: 'yes',
      clis: ['claude', 'invalid-cli'],
      retentionDays: 0,
    },
    projects: [
      { id: 'alpha', path: '/tmp/alpha', agent_id: 'alpha-gm', branch: '' },
    ],
  });

  assert.equal(result.valid, false);
  const joined = result.errors.join(' | ');
  assert.match(joined, /transcriptSync\.enabled/);
  assert.match(joined, /transcriptSync\.clis/);
  assert.match(joined, /transcriptSync\.retentionDays/);
  assert.match(joined, /project\.branch/);
});

test('validateNetworkConfig requires role and version', () => {
  const result = validateNetworkConfig({});
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /role is required/);
  assert.match(result.errors.join(' '), /version is required/);
});

test('validateNetworkConfig accepts valid apps_access and machine_id', () => {
  const result = validateNetworkConfig({
    version: '2.1',
    role: 'network',
    machine_id: '123e4567-e89b-42d3-a456-426614174000',
    apps_access: {
      teleportation: {
        projects: ['alpha', 'beta'],
      },
    },
    projects: [],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateNetworkConfig rejects malformed apps_access and machine_id', () => {
  const result = validateNetworkConfig({
    version: '2.1',
    role: 'network',
    machine_id: 'not-a-uuid',
    apps_access: {
      teleportation: {
        projects: ['alpha', ''],
      },
    },
    projects: [],
  });
  assert.equal(result.valid, false);
  const joined = result.errors.join(' | ');
  assert.match(joined, /apps_access\.teleportation\.projects entries must be non-empty strings/);
  assert.match(joined, /machine_id must be a valid UUID v4/);
});

test('validateNetworkConfig rejects non-object apps_access', () => {
  const result = validateNetworkConfig({
    version: '2.1',
    role: 'network',
    apps_access: [],
    projects: [],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' | '), /apps_access must be a plain object/);
});

test('validateNetworkConfig rejects apps_access entries without projects array', () => {
  const result = validateNetworkConfig({
    version: '2.1',
    role: 'network',
    apps_access: {
      teleportation: {},
    },
    projects: [],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' | '), /apps_access\.teleportation\.projects must be an array/);
});

test('validateNetworkConfig rejects apps_access and machine_id on project role', () => {
  const result = validateNetworkConfig({
    version: '2.1',
    role: 'project',
    agent_id: 'alpha-gm',
    network: '/tmp/network-root',
    machine_id: '123e4567-e89b-42d3-a456-426614174000',
    apps_access: {
      teleportation: {
        projects: ['alpha'],
      },
    },
  });
  assert.equal(result.valid, false);
  const joined = result.errors.join(' | ');
  assert.match(joined, /apps_access is only valid on network role/);
  assert.match(joined, /machine_id is only valid on network role/);
});

test('saveNetworkConfig and loadNetworkConfig roundtrip', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-network-'));
  const config = {
    version: '2.0',
    role: 'network',
    projects: [{ id: 'demo', path: '/tmp/demo', agent_id: 'demo-gm' }],
  };

  saveNetworkConfig(config, tempDir);
  const loaded = loadNetworkConfig(tempDir);

  assert.equal(loaded.config.role, 'network');
  assert.equal(loaded.config.projects.length, 1);
  assert.equal(loaded.config.projects[0].id, 'demo');
});

test('saveNetworkConfig canonicalizes camelCase-only project identity on disk', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-save-project-camel-'));
  try {
    saveNetworkConfig({
      version: '2.0',
      role: 'project',
      agentId: 'camel-save.gm',
      network: '/tmp/network-root',
      hub: 'https://hub.example',
    }, projectRoot);
    const saved = JSON.parse(fs.readFileSync(path.join(projectRoot, 'agentbootup.json'), 'utf8'));
    assert.equal(saved.agent_id, 'camel-save.gm');
    assert.equal(Object.hasOwn(saved, 'agentId'), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('saveNetworkConfig removes matching compatibility key from project identity writes', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-save-project-dual-'));
  try {
    saveNetworkConfig({
      version: '2.0',
      role: 'project',
      agent_id: 'matching-save.gm',
      agentId: 'matching-save.gm',
      network: '/tmp/network-root',
      hub: 'https://hub.example',
    }, projectRoot);
    const saved = JSON.parse(fs.readFileSync(path.join(projectRoot, 'agentbootup.json'), 'utf8'));
    assert.equal(saved.agent_id, 'matching-save.gm');
    assert.equal(Object.hasOwn(saved, 'agentId'), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('loadNetworkConfig normalizes compatible camelCase identity to canonical agent_id', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-project-camel-'));
  fs.writeFileSync(
    path.join(projectRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agentId: 'camel-brain',
      network: '/tmp/network-root',
      hub: 'https://hub.example',
    }),
  );
  try {
    const loaded = loadNetworkConfig(projectRoot);
    assert.equal(loaded.config.agent_id, 'camel-brain');
    assert.equal(Object.hasOwn(loaded.config, 'agentId'), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('loadNetworkConfig resolves ${network.hub} from project config', () => {
  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-network-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-project-'));

  saveNetworkConfig(
    {
      version: '2.0',
      role: 'network',
      hub: 'https://agentdispatch.fly.dev',
      projects: [{ id: 'demo', path: '/tmp/demo', agent_id: 'demo-gm' }],
    },
    networkRoot
  );

  saveNetworkConfig(
    {
      version: '2.0',
      role: 'project',
      agent_id: 'demo-gm',
      network: networkRoot,
      hub: '${network.hub}',
    },
    projectRoot
  );

  const loaded = loadNetworkConfig(projectRoot);
  assert.equal(loaded.config.hub, 'https://agentdispatch.fly.dev');
});

test('loadNetworkConfig throws actionable error for stale ${portfolio.hub} placeholder', () => {
  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-network-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-project-'));

  saveNetworkConfig(
    {
      version: '2.0',
      role: 'network',
      hub: 'https://agentdispatch.fly.dev',
      projects: [{ id: 'demo', path: '/tmp/demo', agent_id: 'demo-gm' }],
    },
    networkRoot
  );

  // Write the config directly (bypassing saveNetworkConfig validation) to simulate
  // a brain/config.json that was provisioned before the portfolio→network rename.
  // saveNetworkConfig would reject '${portfolio.hub}' as an invalid role config,
  // so we write the stale fixture as the tool previously would have produced it.
  const staleConfig = {
    version: '2.0',
    role: 'project',
    agent_id: 'demo-gm',
    network: networkRoot,
    hub: '${portfolio.hub}',
  };
  fs.writeFileSync(
    path.join(projectRoot, 'agentbootup.json'),
    JSON.stringify(staleConfig, null, 2) + '\n'
  );

  assert.throws(
    () => loadNetworkConfig(projectRoot),
    /Stale hub placeholder.*portfolio\.hub.*re-run.*provision/
  );
});

test('validateNetworkConfig accepts projects without path (unlinked)', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'alpha', agent_id: 'alpha-gm' },
      { id: 'beta', agent_id: 'beta-gm' },
    ],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateNetworkConfig accepts mix of path formats', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'a', agent_id: 'a.gm', path: '~/dev_env/foo' },
      { id: 'b', agent_id: 'b.gm', path: '/opt/projects/bar' },
      { id: 'c', agent_id: 'c.gm', path: './baz' },
      { id: 'd', agent_id: 'd.gm' },
    ],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateNetworkConfig rejects non-string path', () => {
  const result = validateNetworkConfig({
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'a', agent_id: 'a.gm', path: 123 },
    ],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /project\.path must be a string/);
});

test('loadNetworkConfig resolves ./relative paths against config dir', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-network-'));
  const config = {
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'rel', path: './my-project', agent_id: 'rel-gm' },
    ],
  };

  saveNetworkConfig(config, tempDir);
  const loaded = loadNetworkConfig(tempDir);
  assert.equal(loaded.config.projects[0].path, path.resolve(tempDir, './my-project'));
});

test('loadNetworkConfig handles projects with no path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-network-'));
  const config = {
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'linked', path: '/tmp/linked', agent_id: 'linked-gm' },
      { id: 'unlinked', agent_id: 'unlinked-gm' },
    ],
  };

  saveNetworkConfig(config, tempDir);
  const loaded = loadNetworkConfig(tempDir);
  assert.equal(loaded.config.projects[0].path, '/tmp/linked');
  assert.equal(loaded.config.projects[1].path, undefined);
});

test('loadNetworkConfig fails when project hub placeholder cannot resolve', () => {
  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-network-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-project-'));

  saveNetworkConfig(
    {
      version: '2.0',
      role: 'network',
      projects: [{ id: 'demo', path: '/tmp/demo', agent_id: 'demo-gm' }],
    },
    networkRoot
  );

  saveNetworkConfig(
    {
      version: '2.0',
      role: 'project',
      agent_id: 'demo-gm',
      network: networkRoot,
      hub: '${network.hub}',
    },
    projectRoot
  );

  assert.throws(() => loadNetworkConfig(projectRoot), /Unable to resolve network hub/);
});
