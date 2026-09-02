import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCredentials } from '../lib/auth/credentials.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const bootupPath = path.join(repoRoot, 'bootup.mjs');

let root: string;
let previousEnv: Record<string, string | undefined>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-brain-pull-route-'));
  previousEnv = {
    AGENTBOOTUP_CREDS_FILE: process.env.AGENTBOOTUP_CREDS_FILE,
    AGENTBOOTUP_MACHINE_ID_FILE: process.env.AGENTBOOTUP_MACHINE_ID_FILE,
    AGENTBOOTUP_CONFIG_FILE: process.env.AGENTBOOTUP_CONFIG_FILE,
  };
  process.env.AGENTBOOTUP_CREDS_FILE = path.join(root, 'credentials');
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(root, 'machine-id');
  process.env.AGENTBOOTUP_CONFIG_FILE = path.join(root, 'global-config.json');
  await writeCredentials({
    apiKey: 'route-test-key',
    serverUrl: 'http://127.0.0.1:1',
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return Bun.spawnSync([process.execPath, bootupPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'test', AGENTBOOTUP_ALLOW_TEST_SESSION: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

test('shipped brain pull route advertises asset-pull options', () => {
  const result = runCli(['brain', 'pull', '--help']);
  const stdout = result.stdout.toString();

  expect(result.exitCode).toBe(0);
  expect(stdout).toContain('Download brain assets');
  expect(stdout).toContain('--path <dir>');
  expect(stdout).toContain('--rotate-identity');
  expect(stdout).not.toContain('--output-dir');
});

test('shipped brain pull route resolves camelCase local identity', () => {
  const project = path.join(root, 'camel-project');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'brain', 'config.json'),
    JSON.stringify({ agentId: 'camel-pull.gm' }),
  );

  const result = runCli(['brain', 'pull', '--path', project, '--dry-run']);
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  // The local endpoint is intentionally closed; reaching the hash request proves
  // the shipped route selected the asset-pull handler and resolved its brain ID.
  expect(result.exitCode).toBe(1);
  expect(stdout).toContain('Brain: camel-pull.gm');
  expect(stderr).toContain('brain pull failed:');
  expect(stdout).not.toContain('wrong-global-brain');
});

test('shipped brain pull route rejects conflicting identity before asset fetch', () => {
  const project = path.join(root, 'conflicting-project');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
  );

  const result = runCli(['brain', 'pull', 'snake.gm', '--path', project, '--dry-run']);
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  expect(result.exitCode).toBe(1);
  expect(stdout).not.toContain('Brain:');
  expect(stderr).toContain('agent_id');
  expect(stderr).toContain('agentId');
  expect(stderr).toContain('refusing to choose a brain');
});

test('shipped brain pull rejects a positional ID that conflicts with local identity before asset fetch', () => {
  const project = path.join(root, 'pull-positional-mismatch');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agentId: 'local-pull.gm' }),
  );

  const result = runCli(['brain', 'pull', 'other-pull.gm', '--path', project, '--dry-run']);
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  expect(result.exitCode).toBe(1);
  expect(stdout).not.toContain('Brain:');
  expect(stderr).toContain('other-pull.gm');
  expect(stderr).toContain('local-pull.gm');
  expect(stderr).toContain('conflicts with local project identity');
});

test('shipped brain pull accepts a positional ID that matches local identity', () => {
  const project = path.join(root, 'pull-positional-match');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agentId: 'matching-pull.gm' }),
  );

  const result = runCli(['brain', 'pull', 'matching-pull.gm', '--path', project, '--dry-run']);
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  expect(result.exitCode).toBe(1);
  expect(stdout).toContain('Brain: matching-pull.gm');
  expect(stderr).not.toContain('conflicts with local project identity');
  expect(stderr).toContain('brain pull failed:');
});

test('shipped brain push rejects a positional ID that conflicts with local identity without network access', () => {
  const project = path.join(root, 'push-positional-mismatch');
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agentId: 'local-push.gm' }),
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# Memory\n');

  const result = runCli(['brain', 'push', 'other-push.gm', '--cwd', project, '--dry-run']);
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  expect(result.exitCode).toBe(1);
  expect(stdout).not.toContain('Brain push (dry-run)');
  expect(stderr).toContain('other-push.gm');
  expect(stderr).toContain('local-push.gm');
  expect(stderr).toContain('conflicts with local project identity');
});

test('shipped brain push accepts a positional ID that matches local identity in dry-run', () => {
  const project = path.join(root, 'push-positional-match');
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agentId: 'matching-push.gm' }),
  );
  fs.writeFileSync(
    path.join(project, 'brain-backup.json'),
    JSON.stringify({
      schema: 'brain-backup/1',
      brain_id: 'matching-push.gm',
      include: [{ path: 'memory/**', class: 'canonical' }],
    }),
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# Memory\n');

  const result = runCli(['brain', 'push', 'matching-push.gm', '--cwd', project, '--dry-run']);
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  expect(result.exitCode).toBe(0);
  expect(stdout).toContain('Brain push (dry-run): matching-push.gm');
  expect(stderr).not.toContain('conflicts with local project identity');
});

test('shipped brain restore rejects an existing generic project target with no identity before network access', () => {
  const project = path.join(root, 'restore-generic-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', name: 'generic-project' }),
  );
  fs.writeFileSync(
    process.env.AGENTBOOTUP_CONFIG_FILE!,
    JSON.stringify({ _version: 1, brainId: 'wrong-global.gm' }),
  );

  const result = runCli(['brain', 'restore', '--target', project, '--dry-run']);
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  expect(result.exitCode).toBe(1);
  expect(stdout).not.toContain('Using brain ID');
  expect(stderr).toContain('No non-empty project agent ID');
  expect(stderr).toContain('agentbootup.json');
  expect(stderr).toContain('brain/config.json');
  expect(stderr).not.toContain('Server returned');
});
