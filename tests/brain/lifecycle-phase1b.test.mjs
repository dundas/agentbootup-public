import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { runPublishCode } from '../../lib/brain/publish-code.js';
import { printBrainLifecycleStatus } from '../../lib/brain/lifecycle-status.js';
import { runUninstallBrain } from '../../lib/brain/uninstall-brain.js';

test('publish-code dry-run computes hash from git archive', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-publish-'));
  fs.writeFileSync(
    path.join(tmp, 'agentbootup.json'),
    JSON.stringify({ version: '1', agent_id: 'test-brain', role: 'project' }, null, 2)
  );
  spawnSync('git', ['init'], { cwd: tmp, encoding: 'utf-8' });
  fs.writeFileSync(path.join(tmp, 'README.md'), '# t\n');
  spawnSync('git', ['add', 'README.md', 'agentbootup.json'], { cwd: tmp });
  spawnSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'init'], {
    cwd: tmp,
  });
  const out = [];
  const err = [];
  const io = { stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  const code = await runPublishCode(['--cwd', tmp, '--dry-run'], io);
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.match(text, /sha256/);
});

test('status <brain> prints project row when network config matches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lifecycle-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'agentbootup.json'),
    JSON.stringify({ version: '1', agent_id: 'demo-gm', role: 'project' }, null, 2)
  );
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }, null, 2));
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify(
      {
        version: '2',
        role: 'network',
        projects: [{ id: 'demo', agent_id: 'demo-gm', path: proj, brain: true }],
      },
      null,
      2
    )
  );

  const out = [];
  const err = [];
  const io = { stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  const code = await printBrainLifecycleStatus('demo', root, io);
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.match(text, /demo-gm/);
  assert.match(text, /9\.9\.9/);
});

test('uninstall requires brain argument', async () => {
  const err = [];
  const io = { stdout: () => {}, stderr: (l) => err.push(l) };
  const code = await runUninstallBrain([], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /missing/);
});

test('uninstall dry-run respects AGENTBOOTUP_NETWORK_ROOT', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-uninstall-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'agentbootup.json'),
    JSON.stringify({ version: '1', agent_id: 'u-brain', role: 'project' }, null, 2)
  );
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify(
      {
        version: '2',
        role: 'network',
        projects: [{ id: 'u1', agent_id: 'u-brain', path: proj, brain: true }],
      },
      null,
      2
    )
  );

  const prev = process.env.AGENTBOOTUP_NETWORK_ROOT;
  process.env.AGENTBOOTUP_NETWORK_ROOT = root;
  const out = [];
  const io = { stdout: (l) => out.push(l), stderr: (l) => out.push(l) };
  try {
    const code = await runUninstallBrain(['--dry-run', 'u-brain'], io);
    assert.equal(code, 0);
    assert.match(out.join('\n'), /dry-run/);
  } finally {
    if (prev === undefined) delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    else process.env.AGENTBOOTUP_NETWORK_ROOT = prev;
  }
});

test('uninstall rejects --purge with --skip-push', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bad-combo-'));
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify(
      { version: '2', role: 'network', projects: [{ id: 'x', agent_id: 'x-b', path: '/tmp/z' }] },
      null,
      2
    )
  );
  const prev = process.env.AGENTBOOTUP_NETWORK_ROOT;
  process.env.AGENTBOOTUP_NETWORK_ROOT = root;
  const err = [];
  const io = { stdout: () => {}, stderr: (l) => err.push(l) };
  try {
    const code = await runUninstallBrain(['--yes', '--purge', '--skip-push', 'x-b'], io);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /cannot be combined/);
  } finally {
    if (prev === undefined) delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    else process.env.AGENTBOOTUP_NETWORK_ROOT = prev;
  }
});

test('uninstall --purge without --yes fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-uninstall-purge-'));
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify(
      { version: '2', role: 'network', projects: [{ id: 'p1', agent_id: 'p-brain', path: '/tmp/x' }] },
      null,
      2
    )
  );
  const prev = process.env.AGENTBOOTUP_NETWORK_ROOT;
  process.env.AGENTBOOTUP_NETWORK_ROOT = root;
  const err = [];
  const io = { stdout: () => {}, stderr: (l) => err.push(l) };
  try {
    const code = await runUninstallBrain(['--purge', 'p-brain'], io);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /--yes/);
  } finally {
    if (prev === undefined) delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    else process.env.AGENTBOOTUP_NETWORK_ROOT = prev;
  }
});
