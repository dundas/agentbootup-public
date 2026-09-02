import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAppCommand } from '../lib/network/commands/app.js';
import { restoreMachineIdEnvAfterEach } from './setup/machine-id-env.mjs';

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

function writeConfig(dir, config) {
  fs.writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify(config, null, 2) + '\n');
}

restoreMachineIdEnvAfterEach(afterEach);

test('app access grant creates apps_access, echoes machine_id, and bumps version', async () => {
  const root = mkd('agentbootup-app-access-');
  const machineIdFile = path.join(root, 'machine-id');
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  writeConfig(root, { version: '2.0', role: 'network', projects: [] });

  const run = makeIo();
  const code = await runAppCommand(['access', 'grant', 'teleportation', '--project', 'alpha', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /Granted teleportation access to project alpha/);

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
  assert.equal(saved.version, '2.1');
  assert.equal(saved.apps_access.teleportation.projects[0], 'alpha');
  assert.match(saved.machine_id, /^[0-9a-f-]{36}$/i);
});

test('app access grant is idempotent', async () => {
  const root = mkd('agentbootup-app-access-idempotent-');
  writeConfig(root, {
    version: '2.1',
    role: 'network',
    machine_id: '123e4567-e89b-42d3-a456-426614174000',
    apps_access: { teleportation: { projects: ['alpha'] } },
    projects: [],
  });

  const run = makeIo();
  const code = await runAppCommand(['access', 'grant', 'teleportation', '--project', 'alpha', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /Already granted/);

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
  assert.deepEqual(saved.apps_access.teleportation.projects, ['alpha']);
});

test('app access revoke cleans up empty entries', async () => {
  const root = mkd('agentbootup-app-access-revoke-');
  writeConfig(root, {
    version: '2.1',
    role: 'network',
    machine_id: '123e4567-e89b-42d3-a456-426614174000',
    apps_access: { teleportation: { projects: ['alpha'] } },
    projects: [],
  });

  const run = makeIo();
  const code = await runAppCommand(['access', 'revoke', 'teleportation', '--project', 'alpha', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /Revoked teleportation access to project alpha/);

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
  assert.equal(saved.apps_access, undefined);
});

test('app access revoke preserves remaining projects', async () => {
  const root = mkd('agentbootup-app-access-partial-revoke-');
  writeConfig(root, {
    version: '2.1',
    role: 'network',
    machine_id: '123e4567-e89b-42d3-a456-426614174000',
    apps_access: { teleportation: { projects: ['alpha', 'beta'] } },
    projects: [],
  });

  const run = makeIo();
  const code = await runAppCommand(['access', 'revoke', 'teleportation', '--project', 'alpha', '--cwd', root], run.io);
  assert.equal(code, 0);

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
  assert.deepEqual(saved.apps_access.teleportation.projects, ['beta']);
});

test('app access list supports json and single-app views', async () => {
  const root = mkd('agentbootup-app-access-list-');
  writeConfig(root, {
    version: '2.1',
    role: 'network',
    machine_id: '123e4567-e89b-42d3-a456-426614174000',
    apps_access: { teleportation: { projects: ['alpha', 'beta'] } },
    projects: [],
  });

  const single = makeIo();
  const singleCode = await runAppCommand(['access', 'list', 'teleportation', '--cwd', root], single.io);
  assert.equal(singleCode, 0);
  assert.deepEqual(single.out, ['alpha', 'beta']);

  const json = makeIo();
  const jsonCode = await runAppCommand(['access', 'list', '--json', '--cwd', root], json.io);
  assert.equal(jsonCode, 0);
  assert.deepEqual(JSON.parse(json.out.join('\n')), { teleportation: { projects: ['alpha', 'beta'] } });
});

test('app access validates app and project input before file writes', async () => {
  const root = mkd('agentbootup-app-access-validate-');
  writeConfig(root, { version: '2.0', role: 'network', projects: [] });

  const badApp = makeIo();
  const badAppCode = await runAppCommand(['access', 'grant', 'bad app', '--project', 'alpha', '--cwd', root], badApp.io);
  assert.equal(badAppCode, 1);
  assert.match(badApp.err.join('\n'), /app id must match/);

  const badProject = makeIo();
  const badProjectCode = await runAppCommand(['access', 'grant', 'teleportation', '--project', '', '--cwd', root], badProject.io);
  assert.equal(badProjectCode, 1);
  assert.match(badProject.err.join('\n'), /project id is required/);
});

test('app access grant rejects project-role configs', async () => {
  const root = mkd('agentbootup-app-access-project-role-');
  writeConfig(root, {
    version: '2.0',
    role: 'project',
    agent_id: 'alpha-gm',
    network: '/tmp/network-root',
    hub: 'https://agentdispatch.example',
  });

  const run = makeIo();
  const code = await runAppCommand(['access', 'grant', 'teleportation', '--project', 'alpha', '--cwd', root], run.io);
  assert.equal(code, 1);
  assert.match(run.err.join('\n'), /command requires role "network"/);
});
