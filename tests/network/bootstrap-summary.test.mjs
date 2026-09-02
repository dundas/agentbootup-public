import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildBootstrapArtifactRefs,
  buildBootstrapPathDetails,
  classifyBootstrapPath,
  formatBootstrapSummaryLines,
  readBootstrapSummary,
  summarizeRuntimeInfo,
  writeBootstrapSummary,
} from '../../lib/network/bootstrap-summary.js';

test.afterEach(() => {
  delete process.env.AGENTBOOTUP_BOOTSTRAP_SUMMARY_FILE;
});

test('readBootstrapSummary returns null for invalid JSON', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootstrap-summary-invalid-'));
  try {
    const summaryPath = path.join(root, 'bootstrap-summary.json');
    fs.writeFileSync(summaryPath, '{not-json}\n');
    process.env.AGENTBOOTUP_BOOTSTRAP_SUMMARY_FILE = summaryPath;

    const summary = await readBootstrapSummary();

    assert.equal(summary, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readBootstrapSummary rethrows non-ENOENT read failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootstrap-summary-read-error-'));
  try {
    process.env.AGENTBOOTUP_BOOTSTRAP_SUMMARY_FILE = root;
    await assert.rejects(readBootstrapSummary(), /EISDIR|illegal operation on a directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeBootstrapSummary removes temp files when rename fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootstrap-summary-rename-'));
  try {
    const summaryPath = path.join(root, 'bootstrap-summary.json');
    process.env.AGENTBOOTUP_BOOTSTRAP_SUMMARY_FILE = summaryPath;
    const failingFs = {
      ...fsp,
      async rename() {
        throw new Error('rename failed');
      },
    };

    await assert.rejects(
      writeBootstrapSummary({ last_success: { project_id: 'infinitrade' } }, failingFs),
      /rename failed/
    );

    assert.equal(fs.existsSync(`${summaryPath}.tmp`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('summarizeRuntimeInfo only keeps safe runtime fields', () => {
  const summary = summarizeRuntimeInfo({
    source: 'local-checkout',
    root: '/tmp/agentbootup',
    bootupPath: '/tmp/agentbootup/bootup.mjs',
    apiKey: 'should-not-leak',
    token: 'should-not-leak',
  });

  assert.deepEqual(summary, {
    source: 'local-checkout',
    root: '/tmp/agentbootup',
    bootup_path: '/tmp/agentbootup/bootup.mjs',
  });
});

test('classifyBootstrapPath marks tmpdir paths as ephemeral staging', () => {
  const classified = classifyBootstrapPath(path.join(os.tmpdir(), 'bootup-staging', 'env.json'), 'operator-input');

  assert.deepEqual(classified, {
    path: path.resolve(path.join(os.tmpdir(), 'bootup-staging', 'env.json')),
    role: 'operator-input',
    durability: 'ephemeral-staging',
  });
});

test('buildBootstrapArtifactRefs annotates durability and role', () => {
  const refs = buildBootstrapArtifactRefs({
    projectPath: path.join(os.tmpdir(), 'proj'),
    networkRoot: path.join(os.tmpdir(), 'network'),
    envConfigPath: path.join(process.cwd(), 'decisive-env.json'),
    runtimeContext: {
      selected: { root: path.join(process.cwd(), 'agentbootup') },
    },
  });

  assert.equal(refs.find((ref) => ref.kind === 'project')?.durability, 'ephemeral-staging');
  assert.equal(refs.find((ref) => ref.kind === 'network-root')?.role, 'operator-input');
  assert.equal(refs.find((ref) => ref.kind === 'env-config')?.durability, 'durable');
  assert.equal(refs.find((ref) => ref.kind === 'runtime')?.role, 'runtime-support');
});

test('formatBootstrapSummaryLines warns when operator inputs are temp staging paths', () => {
  const networkRoot = path.join(os.tmpdir(), 'network-root');
  const envConfigPath = path.join(os.tmpdir(), 'decisive-env.json');
  const projectPath = path.join(os.tmpdir(), 'proj');
  const pathDetails = buildBootstrapPathDetails({
    projectPath,
    networkRoot,
    envConfigPath,
  });

  const lines = formatBootstrapSummaryLines({
    last_success: {
      recorded_at: '2026-05-02T12:00:00.000Z',
      project_id: 'infinitrade',
      target_host: { hostname: 'host' },
      project_path: projectPath,
      network_root: networkRoot,
      env_config_path: envConfigPath,
      path_details: pathDetails,
      artifact_refs: [],
    },
  }, '/tmp/bootstrap-summary.json');

  assert.ok(lines.some((line) => line.includes('network_root:') && line.includes('operator-input, ephemeral-staging')));
  assert.ok(lines.some((line) => line.includes('env_config_path:') && line.includes('operator-input, ephemeral-staging')));
  assert.ok(lines.some((line) => line.includes('treat them as staging artifacts, not canonical reusable paths')));
});
