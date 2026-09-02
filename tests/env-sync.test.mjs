import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runEnvCommand } from '../lib/network/commands/env.js';
import { loadEnvSchema } from '../lib/network/env/schema.js';

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

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('env command prints usage for help', () => {
  const run = makeIo();
  const code = runEnvCommand(['--help'], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /Usage: agentbootup env sync/);
});

test('env command rejects unknown subcommand', () => {
  const run = makeIo();
  const code = runEnvCommand(['push'], run.io);
  assert.equal(code, 1);
  assert.match(run.err.join('\n'), /unknown subcommand/);
});

test('env command requires variables for sync', () => {
  const run = makeIo();
  const code = runEnvCommand(['sync'], run.io);
  assert.equal(code, 1);
  assert.match(run.err.join('\n'), /requires at least one variable/);
});

test('env schema loader validates schema shape', () => {
  const project = mkd('agentbootup-env-schema-');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'brain', '.env.schema'),
    JSON.stringify({
      required: ['MECH_APP_ID'],
      optional: ['MECH_API_KEY'],
      secrets: ['MECH_API_KEY'],
    }, null, 2)
  );

  const schema = loadEnvSchema(project);
  assert.ok(schema);
  assert.equal(schema.required.length, 1);
  assert.equal(schema.allowed.has('MECH_APP_ID'), true);
  assert.equal(schema.allowed.has('MECH_API_KEY'), true);
});

test('env sync copies only allowed vars into projects', () => {
  const root = mkd('agentbootup-env-sync-');
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  fs.mkdirSync(path.join(projectA, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(projectB, 'brain'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'a', path: projectA, agent_id: 'a-gm' },
        { id: 'b', path: projectB, agent_id: 'b-gm' },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(root, '.env'), 'MECH_APP_ID=abc123\nMECH_API_KEY=sekret\nUNDECLARED=value\n');
  fs.writeFileSync(
    path.join(projectA, 'brain', '.env.schema'),
    JSON.stringify({ required: ['MECH_APP_ID'], optional: ['MECH_API_KEY'], secrets: ['MECH_API_KEY'] }, null, 2)
  );
  fs.writeFileSync(
    path.join(projectB, 'brain', '.env.schema'),
    JSON.stringify({ required: ['MECH_APP_ID'], optional: [], secrets: [] }, null, 2)
  );

  const run = makeIo();
  const code = runEnvCommand(['sync', 'MECH_APP_ID', 'MECH_API_KEY', 'UNDECLARED', '--cwd', root], run.io);
  assert.equal(code, 0);

  const envA = fs.readFileSync(path.join(projectA, '.env'), 'utf-8');
  assert.match(envA, /MECH_APP_ID=abc123/);
  assert.match(envA, /MECH_API_KEY=sekret/);
  assert.doesNotMatch(envA, /UNDECLARED=/);

  const envB = fs.readFileSync(path.join(projectB, '.env'), 'utf-8');
  assert.match(envB, /MECH_APP_ID=abc123/);
  assert.doesNotMatch(envB, /MECH_API_KEY=/);
});

test('env sync reports fly flag as not implemented', () => {
  const root = mkd('agentbootup-env-sync-fly-');
  const projectA = path.join(root, 'project-a');
  fs.mkdirSync(path.join(projectA, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'a', path: projectA, agent_id: 'a-gm' }],
    }, null, 2)
  );
  fs.writeFileSync(path.join(root, '.env'), 'MECH_APP_ID=abc123\n');
  fs.writeFileSync(
    path.join(projectA, 'brain', '.env.schema'),
    JSON.stringify({ required: ['MECH_APP_ID'], optional: [], secrets: [] }, null, 2)
  );

  const run = makeIo();
  const code = runEnvCommand(['sync', 'MECH_APP_ID', '--fly', '--cwd', root], run.io);
  assert.equal(code, 1);
  assert.match(run.err.join('\n'), /--fly is not implemented/);
});

test('env sync strips carriage returns from values before writing', () => {
  const root = mkd('agentbootup-env-sanitize-');
  const project = path.join(root, 'project-a');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'a', path: project, agent_id: 'a-gm' }],
    }, null, 2)
  );
  fs.writeFileSync(path.join(root, '.env'), 'MECH_APP_ID=abc\r\nBAD=one\r\n');
  fs.writeFileSync(
    path.join(project, 'brain', '.env.schema'),
    JSON.stringify({ required: ['BAD'], optional: [], secrets: [] }, null, 2)
  );

  const run = makeIo();
  const code = runEnvCommand(['sync', 'BAD', '--cwd', root], run.io);
  assert.equal(code, 0);

  const synced = fs.readFileSync(path.join(project, '.env'), 'utf-8');
  assert.match(synced, /BAD=one/);
  assert.doesNotMatch(synced, /\r/);
});

test('env sync unquotes wrapped env values from source file', () => {
  const root = mkd('agentbootup-env-unquote-');
  const project = path.join(root, 'project-a');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'a', path: project, agent_id: 'a-gm' }],
    }, null, 2)
  );
  fs.writeFileSync(path.join(root, '.env'), 'QUOTED="abc123"\nSINGLE=\'xyz789\'\n');
  fs.writeFileSync(
    path.join(project, 'brain', '.env.schema'),
    JSON.stringify({ required: ['QUOTED', 'SINGLE'], optional: [], secrets: [] }, null, 2)
  );

  const run = makeIo();
  const code = runEnvCommand(['sync', 'QUOTED', 'SINGLE', '--cwd', root], run.io);
  assert.equal(code, 0);

  const synced = fs.readFileSync(path.join(project, '.env'), 'utf-8');
  assert.match(synced, /QUOTED=abc123/);
  assert.match(synced, /SINGLE=xyz789/);
  assert.doesNotMatch(synced, /QUOTED="abc123"/);
  assert.doesNotMatch(synced, /SINGLE='xyz789'/);
});
