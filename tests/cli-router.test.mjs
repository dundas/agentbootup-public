import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isNetworkCommand, runNetworkCommand } from '../lib/network/cli-router.js';
import { getFlagList, hasFlag, parseNetworkExecutionFlags } from '../lib/network/args.js';
import { runPullCommand } from '../lib/network/commands/pull.js';
import { runSyncCommand } from '../lib/network/commands/sync.js';
import { restoreMachineIdEnvAfterEach } from './setup/machine-id-env.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bootupPath = fileURLToPath(new URL('../bootup.mjs', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));

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
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); // nosemgrep: path-join-resolve-traversal -- test helper creates temp dirs under the OS temp root
}

function runCmd(cmd, cwd) {
  return spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf-8' });
}

restoreMachineIdEnvAfterEach(afterEach);

test('isNetworkCommand detects known commands', () => {
  assert.equal(isNetworkCommand('status'), true);
  assert.equal(isNetworkCommand('sync'), true);
  assert.equal(isNetworkCommand('install'), true);
  assert.equal(isNetworkCommand('pull'), true);
  assert.equal(isNetworkCommand('env'), true);
  assert.equal(isNetworkCommand('restore'), true);
  assert.equal(isNetworkCommand('sync-transcripts'), true);
  assert.equal(isNetworkCommand('restore-transcripts'), true);
  assert.equal(isNetworkCommand('analyze'), true);
  assert.equal(isNetworkCommand('app'), true);
  assert.equal(isNetworkCommand('machine-id'), true);
  assert.equal(isNetworkCommand('--help'), false);
});

test('host-extension dry-run honors a leading global cwd without leaking it into subcommand arguments', () => {
  const tempDir = mkd('agentbootup-host-extension-cwd-');
  try {
    const result = spawnSync(process.execPath, [bootupPath, '--cwd', tempDir, 'host-extension', 'dry-run', '--json'], {
      cwd: repoRoot, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.success, true);
    assert.equal(envelope.command, 'host-extension dry-run');
    assert.equal(envelope.data.fixture, 'host-extension-client-v1');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('host-extension serve resolves a relative global cwd once across the Node-to-Bun handoff', () => {
  const tempDir = mkd('agentbootup-host-extension-serve-cwd-');
  try {
    fs.writeFileSync(path.join(tempDir, 'extension.mjs'), 'export const fixture = true;');
    const relativeCwd = path.relative(repoRoot, tempDir);
    const result = spawnSync('node', [bootupPath, '--cwd', relativeCwd, 'host-extension', 'serve', '--module', './extension.mjs', '--jsonl'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 1, result.stderr);
    const record = JSON.parse(result.stdout.trim());
    assert.equal(record.event, 'error');
    assert.match(record.data.message, /module must export installHostExtensions or a default function/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runNetworkCommand prints help', async () => {
  const { io, out } = makeIo();
  const code = await runNetworkCommand(['network', '--help'], io);
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.match(text, /agentbootup network commands/);
  assert.match(text, /install --env/);
  assert.match(text, /pull \[project-id\]/);
  assert.match(text, /env sync <VAR\.\.\.>/);
  assert.match(text, /sync-transcripts/);
  assert.match(text, /restore-transcripts/);
  assert.match(text, /analyze/);
  assert.match(text, /app access grant/);
  assert.match(text, /machine-id/);
});

test('runNetworkCommand with empty argv prints help', async () => {
  const { io, out } = makeIo();
  const code = await runNetworkCommand([], io);
  assert.equal(code, 0);
  assert.match(out.join('\n'), /agentbootup network commands/);
});

test('analyze command requires project-id or --all', async () => {
  const tempDir = mkd('agentbootup-analyze-');
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2)
  );
  const run = makeIo();
  const code = await runNetworkCommand(['analyze', '--cwd', tempDir], run.io);
  assert.equal(code, 1);
  assert.match(run.err.join('\n'), /provide <project-id> or --all/);
});

test('new command argument conflicts are validated', async () => {
  const pullConflict = makeIo();
  const pullCode = await runNetworkCommand(['pull', 'proj-a', '--all'], pullConflict.io);
  assert.equal(pullCode, 1);
  assert.match(pullConflict.err.join('\n'), /either a project-id or --all/);

  const syncConflict = makeIo();
  const syncCode = await runNetworkCommand(['sync-transcripts', 'proj-a', '--all'], syncConflict.io);
  assert.equal(syncCode, 1);
  assert.match(syncConflict.err.join('\n'), /either a project-id or --all/);

  const analyzeConflict = makeIo();
  const analyzeCode = await runNetworkCommand(['analyze', 'proj-a', '--all'], analyzeConflict.io);
  assert.equal(analyzeCode, 1);
  assert.match(analyzeConflict.err.join('\n'), /either a project-id or --all/);
});

test('pull command supports dry-run and requires target selection in network mode', async () => {
  const tempDir = mkd('agentbootup-pull-');
  const projectPath = path.join(tempDir, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });

  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm', branch: 'main' }],
    }, null, 2)
  );

  const missingTarget = makeIo();
  const missingCode = await runNetworkCommand(['pull', '--cwd', tempDir], missingTarget.io);
  assert.equal(missingCode, 1);
  assert.match(missingTarget.err.join('\n'), /provide <project-id> or --all/);

  const dryRun = makeIo();
  const dryCode = await runNetworkCommand(['pull', '--all', '--dry-run', '--cwd', tempDir], dryRun.io);
  assert.equal(dryCode, 0);
  assert.match(dryRun.out.join('\n'), /would run: git pull --ff-only origin main/);
});

test('pull command skips dependency install without --install', () => {
  const root = mkd('agentbootup-pull-no-install-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2));
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm', branch: 'main' }],
    }, null, 2)
  );

  let installCalled = false;
  const run = makeIo();
  const code = runPullCommand(['--all', '--cwd', root], run.io, {
    runCommand: (cmd) => {
      if (cmd[0] === 'git' && cmd[1] === 'rev-parse') return { code: 0, stdout: 'true', stderr: '' };
      if (cmd[0] === 'git' && cmd[1] === 'pull') {
        fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'demo', version: '2.0.0' }, null, 2));
        return { code: 0, stdout: 'updated', stderr: '' };
      }
      if (cmd[1] === 'install') installCalled = true;
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(code, 0);
  assert.equal(installCalled, false);
  assert.match(run.out.join('\n'), /install skipped \(pass --install to enable\)/);
});

test('pull command runs dependency install with --install', () => {
  const root = mkd('agentbootup-pull-install-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2));
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm', branch: 'main' }],
    }, null, 2)
  );

  let installCalled = false;
  const run = makeIo();
  const code = runPullCommand(['--all', '--install', '--cwd', root], run.io, {
    runCommand: (cmd) => {
      if (cmd[0] === 'git' && cmd[1] === 'rev-parse') return { code: 0, stdout: 'true', stderr: '' };
      if (cmd[0] === 'git' && cmd[1] === 'pull') {
        fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'demo', version: '2.0.0' }, null, 2));
        return { code: 0, stdout: 'updated', stderr: '' };
      }
      if (cmd[1] === 'install') {
        installCalled = true;
        return { code: 0, stdout: 'installed', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(code, 0);
  assert.equal(installCalled, true);
  assert.match(run.out.join('\n'), /dependencies refreshed/);
});

test('sync command keeps existing files by default', () => {
  const root = mkd('agentbootup-sync-');
  const sourceRoot = path.join(root, 'source');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(path.join(sourceRoot, '.agents', 'skills', 'portable-demo'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.agents', 'skills', 'portable-demo'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.agents', 'skills', 'portable-demo', 'SKILL.md'), '# source\n');
  fs.writeFileSync(path.join(projectPath, '.agents', 'skills', 'portable-demo', 'SKILL.md'), '# existing\n');
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      skills_source: './source',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm', branch: 'main' }],
    }, null, 2)
  );

  const run = makeIo();
  const code = runSyncCommand(['project-a', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /skip: .*preserved 1 existing file/i);
  assert.equal(
    fs.readFileSync(path.join(projectPath, '.agents', 'skills', 'portable-demo', 'SKILL.md'), 'utf-8'),
    '# existing\n'
  );
});

test('sync command overwrites existing files with --force', () => {
  const root = mkd('agentbootup-sync-force-');
  const sourceRoot = path.join(root, 'source');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(path.join(sourceRoot, '.agents', 'skills', 'portable-demo'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.agents', 'skills', 'portable-demo'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.agents', 'skills', 'portable-demo', 'SKILL.md'), '# source\n');
  fs.writeFileSync(path.join(projectPath, '.agents', 'skills', 'portable-demo', 'SKILL.md'), '# existing\n');
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      skills_source: './source',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm', branch: 'main' }],
    }, null, 2)
  );

  const run = makeIo();
  const code = runSyncCommand(['project-a', '--force', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /Overwrite mode: enabled/);
  assert.match(run.out.join('\n'), /copied: .*\.agents\/skills/i);
  assert.equal(
    fs.readFileSync(path.join(projectPath, '.agents', 'skills', 'portable-demo', 'SKILL.md'), 'utf-8'),
    '# source\n'
  );
});

test('sync command adds new upstream files inside existing directories without --force', () => {
  const root = mkd('agentbootup-sync-incremental-');
  const sourceRoot = path.join(root, 'source');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(path.join(sourceRoot, '.agents', 'skills', 'portable-demo'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, '.agents', 'skills', 'new-demo'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.agents', 'skills', 'portable-demo'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.agents', 'skills', 'portable-demo', 'SKILL.md'), '# source\n');
  fs.writeFileSync(path.join(sourceRoot, '.agents', 'skills', 'new-demo', 'SKILL.md'), '# new\n');
  fs.writeFileSync(path.join(projectPath, '.agents', 'skills', 'portable-demo', 'SKILL.md'), '# existing\n');
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      skills_source: './source',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm', branch: 'main' }],
    }, null, 2)
  );

  const run = makeIo();
  const code = runSyncCommand(['project-a', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.equal(
    fs.readFileSync(path.join(projectPath, '.agents', 'skills', 'portable-demo', 'SKILL.md'), 'utf-8'),
    '# existing\n'
  );
  assert.equal(
    fs.readFileSync(path.join(projectPath, '.agents', 'skills', 'new-demo', 'SKILL.md'), 'utf-8'),
    '# new\n'
  );
  assert.match(run.out.join('\n'), /copied: .*1 file synced, 1 preserved/i);
});

test('sync command skips directory targets blocked by existing files', () => {
  const root = mkd('agentbootup-sync-blocked-');
  const sourceRoot = path.join(root, 'source');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(path.join(sourceRoot, '.agents', 'skills', 'portable-demo'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.agents', 'skills', 'portable-demo', 'SKILL.md'), '# source\n');
  fs.writeFileSync(path.join(projectPath, '.agents', 'skills'), '# blocking file\n');
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      skills_source: './source',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm', branch: 'main' }],
    }, null, 2)
  );

  const run = makeIo();
  const code = runSyncCommand(['project-a', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /skip: .*blocked by 1 file path conflict/i);
  assert.equal(
    fs.readFileSync(path.join(projectPath, '.agents', 'skills'), 'utf-8'),
    '# blocking file\n'
  );
});

test('args helpers parse multi-value and execution flags', () => {
  const args = ['sync', 'MECH_APP_ID', 'MECH_API_KEY', '--fly', '--all', '--cli', 'codex', '--since', '7d', '--last', '30d', '--commit'];
  assert.deepEqual(getFlagList(args, 'sync'), ['MECH_APP_ID', 'MECH_API_KEY']);
  assert.equal(hasFlag(args, '--fly'), true);
  const flags = parseNetworkExecutionFlags(args);
  assert.equal(flags.all, true);
  assert.equal(flags.cli, 'codex');
  assert.equal(flags.since, '7d');
  assert.equal(flags.last, '30d');
  assert.equal(flags.commit, true);
});

test('status fails with missing config', async () => {
  const { io, err } = makeIo();
  const code = await runNetworkCommand(['status', '--cwd', os.tmpdir()], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /status failed/);
});

test('add command writes project into network config and prevents duplicates', async () => {
  const tempDir = mkd('agentbootup-router-');
  const cfgPath = path.join(tempDir, 'agentbootup.json');

  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2)
  );

  const first = makeIo();
  const firstCode = await runNetworkCommand(
    ['add', 'proj1', '/tmp/proj1', '--agent', 'proj1-gm', '--cwd', tempDir],
    first.io
  );
  assert.equal(firstCode, 0);

  const second = makeIo();
  const secondCode = await runNetworkCommand(
    ['add', 'proj1', '/tmp/proj1', '--agent', 'proj1-gm', '--cwd', tempDir],
    second.io
  );
  assert.equal(secondCode, 1);
  assert.match(second.err.join('\n'), /already exists/);

  const updated = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.equal(updated.projects.length, 1);
  assert.equal(updated.projects[0].id, 'proj1');
  assert.equal(updated.projects[0].trusted, true);
});

test('add command supports --untrusted opt-out', async () => {
  const tempDir = mkd('agentbootup-router-untrusted-');
  const cfgPath = path.join(tempDir, 'agentbootup.json');

  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2)
  );

  const run = makeIo();
  const code = await runNetworkCommand(
    ['add', 'proj1', '/tmp/proj1', '--agent', 'proj1-gm', '--untrusted', '--cwd', tempDir],
    run.io
  );
  assert.equal(code, 0);

  const updated = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.equal(updated.projects[0].trusted, false);
});

test('app access commands mutate config through the router', async () => {
  const tempDir = mkd('agentbootup-router-app-access-');
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(tempDir, 'machine-id');
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2)
  );

  const grant = makeIo();
  const grantCode = await runNetworkCommand(
    ['app', 'access', 'grant', 'teleportation', '--project', 'proj1', '--cwd', tempDir],
    grant.io
  );
  assert.equal(grantCode, 0);

  const list = makeIo();
  const listCode = await runNetworkCommand(
    ['app', 'access', 'list', '--json', '--cwd', tempDir],
    list.io
  );
  assert.equal(listCode, 0);
  assert.deepEqual(JSON.parse(list.out.join('\n')), { teleportation: { projects: ['proj1'] } });
});

test('add command falls back to configured network root without matching cwd', async () => {
  const networkDir = mkd('agentbootup-add-fallback-');
  const emptyDir = mkd('agentbootup-add-nocfg-');
  const cfgPath = path.join(networkDir, 'agentbootup.json');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2)
  );

  // Point global config at our temp network root.
  const globalCfg = path.join(networkDir, 'global-config.json');
  fs.writeFileSync(globalCfg, JSON.stringify({ _version: 1, networkRoot: networkDir }));
  const origEnv = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = globalCfg;

  try {
    const run = makeIo();
    // Pass --cwd pointing to a dir with no agentbootup.json to trigger fallback.
    const code = await runNetworkCommand(
      ['add', 'fallback-proj', '/tmp/fallback-proj', '--agent', 'fallback-gm', '--cwd', emptyDir],
      run.io
    );
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /Added project fallback-proj/);

    const updated = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    assert.equal(updated.projects.length, 1);
    assert.equal(updated.projects[0].id, 'fallback-proj');
  } finally {
    if (origEnv === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = origEnv;
  }
});

test('doctor command reports network health and rejects unknown target', { timeout: 20000 }, async () => {
  const tempDir = mkd('agentbootup-doctor-');
  const projectPath = path.join(tempDir, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });

  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const healthy = makeIo();
  const healthyCode = await runNetworkCommand(['doctor', '--cwd', tempDir], healthy.io);
  assert.equal(healthyCode, 0);
  assert.match(healthy.out.join('\n'), /Network Health/);
  assert.match(healthy.out.join('\n'), /project-a/);

  const unknown = makeIo();
  const unknownCode = await runNetworkCommand(['doctor', 'nope', '--cwd', tempDir], unknown.io);
  assert.equal(unknownCode, 1);
  assert.match(unknown.err.join('\n'), /unknown project/);
});

test('provision command scaffolds brain files and updates project metadata', async () => {
  const tempDir = mkd('agentbootup-provision-');
  const projectPath = path.join(tempDir, 'project-c');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'project-c' }, null, 2));

  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-c', path: projectPath, agent_id: 'project-c-gm', type: 'service' }],
    }, null, 2)
  );

  const { io } = makeIo();
  const code = await runNetworkCommand(['provision', 'project-c', '--cwd', tempDir], io);
  assert.equal(code, 0);

  assert.equal(fs.existsSync(path.join(projectPath, 'brain', 'config.json')), true);
  assert.equal(fs.existsSync(path.join(projectPath, 'brain', 'CLAUDE.md')), true);
  assert.equal(fs.existsSync(path.join(projectPath, 'memory', 'MEMORY.md')), true);

  const gitignore = fs.readFileSync(path.join(projectPath, '.gitignore'), 'utf-8');
  assert.match(gitignore, /brain\/config\.secret\.json/);

  const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
  assert.equal(pkg.scripts['brain:sync'], 'memory-sync');
  assert.match(pkg.scripts['brain:daemon'], /memory-sync-daemon/);
});

test('install --dry-run lists environment projects in manifest order', async () => {
  const tempDir = mkd('agentbootup-install-dry-');
  const p1 = path.join(tempDir, 'pa');
  fs.mkdirSync(p1, { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify(
      {
        version: '2.0',
        role: 'network',
        projects: [
          { id: 'x', path: p1, agent_id: 'x.gm', type: 'service' },
          { id: 'y', path: p1, agent_id: 'y.gm', type: 'service' },
        ],
      },
      null,
      2
    )
  );
  fs.mkdirSync(path.join(tempDir, 'environments'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'environments', 'demo.json'),
    JSON.stringify({
      id: 'demo',
      version: 1,
      projects: ['x', 'y'],
      install_order: ['y', 'x'],
    })
  );

  const run = makeIo();
  const code = await runNetworkCommand(['install', '--env', 'demo', '--dry-run', '--cwd', tempDir], run.io);
  assert.equal(code, 0);
  const yIdx = run.out.findIndex((l) => l.includes('would provision: y'));
  const xIdx = run.out.findIndex((l) => l.includes('would provision: x'));
  assert.ok(yIdx !== -1 && xIdx !== -1 && yIdx < xIdx);
});

test('provision command supports fly provisioning entrypoint flags', async () => {
  const tempDir = mkd('agentbootup-provision-fly-');
  const projectPath = path.join(tempDir, 'project-f');
  fs.mkdirSync(path.join(projectPath, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'fly.toml'), 'app = "demo"\n');
  fs.writeFileSync(
    path.join(projectPath, 'brain', 'fly-secrets.schema'),
    JSON.stringify({ secrets: ['BRAIN_API_KEY', 'MECH_API_KEY'] }, null, 2)
  );

  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-f', path: projectPath, agent_id: 'project-f-gm', type: 'service' }],
    }, null, 2)
  );

  const run = makeIo();
  const code = await runNetworkCommand(['provision', 'project-f', '--fly', '--cwd', tempDir], run.io);
  assert.equal(code, 1);
  assert.match(run.err.join('\n'), /--fly secret provisioning is not implemented yet/);
});

test('provision ignores inline secrets in network config', async () => {
  const tempDir = mkd('agentbootup-provision-inline-secrets-');
  const projectPath = path.join(tempDir, 'project-s');
  fs.mkdirSync(projectPath, { recursive: true });

  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'project-s',
        path: projectPath,
        agent_id: 'project-s-gm',
        type: 'service',
        secret_key: 'should-not-propagate',
      }],
    }, null, 2)
  );

  const run = makeIo();
  const code = await runNetworkCommand(['provision', 'project-s', '--cwd', tempDir], run.io);
  assert.equal(code, 0);
  assert.match(run.err.join('\n'), /inline project secrets.*ignored/);

  const secretPath = path.join(projectPath, 'brain', 'config.secret.json');
  const secret = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
  assert.equal(secret.secret_key, undefined);
});

test('restore command rehydrates config.secret.json from local vault backup', async () => {
  const tempDir = mkd('agentbootup-restore-');
  const projectPath = path.join(tempDir, 'project-r');
  fs.mkdirSync(projectPath, { recursive: true });

  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-r', path: projectPath, agent_id: 'project-r-gm', type: 'service' }],
    }, null, 2)
  );

  const provisionRun = makeIo();
  const provisionCode = await runNetworkCommand(['provision', 'project-r', '--cwd', tempDir], provisionRun.io);
  assert.equal(provisionCode, 0);

  const secretPath = path.join(projectPath, 'brain', 'config.secret.json');
  fs.writeFileSync(secretPath, '{}\n');

  const restoreRun = makeIo();
  const restoreCode = await runNetworkCommand(['restore', 'project-r', '--cwd', tempDir], restoreRun.io);
  assert.equal(restoreCode, 0);
  assert.match(restoreRun.out.join('\n'), /Restored secrets for project-r/);
  assert.equal(fs.existsSync(secretPath), true);
});

test('sync command supports dry-run and copies skill assets', async () => {
  const sourceRoot = mkd('agentbootup-sync-src-');
  const projectPath = path.join(sourceRoot, 'target-project');
  fs.mkdirSync(projectPath, { recursive: true });

  fs.mkdirSync(path.join(sourceRoot, '.claude', 'skills', 'example-skill'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.claude', 'skills', 'example-skill', 'SKILL.md'), '# Skill\n');
  fs.writeFileSync(path.join(sourceRoot, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(sourceRoot, 'GEMINI.md'), '# Gemini\n');

  fs.writeFileSync(
    path.join(sourceRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      skills_source: '.',
      projects: [{ id: 'target', path: projectPath, agent_id: 'target-gm' }],
    }, null, 2)
  );

  const dry = makeIo();
  const dryCode = await runNetworkCommand(['sync', '--dry-run', '--cwd', sourceRoot], dry.io);
  assert.equal(dryCode, 0);
  assert.match(dry.out.join('\n'), /would-copy/);

  const exec = makeIo();
  const execCode = await runNetworkCommand(['sync', '--cwd', sourceRoot], exec.io);
  assert.equal(execCode, 0);

  assert.equal(
    fs.existsSync(path.join(projectPath, '.claude', 'skills', 'example-skill', 'SKILL.md')),
    true
  );
  assert.equal(fs.existsSync(path.join(projectPath, 'AGENTS.md')), true);
  assert.equal(fs.existsSync(path.join(projectPath, 'GEMINI.md')), true);
});

test('sync command targets a single project when id is provided', async () => {
  const sourceRoot = mkd('agentbootup-sync-target-');
  const projectA = path.join(sourceRoot, 'project-a');
  const projectB = path.join(sourceRoot, 'project-b');
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });

  fs.mkdirSync(path.join(sourceRoot, '.claude', 'skills', 'example-skill'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.claude', 'skills', 'example-skill', 'SKILL.md'), '# Skill\n');
  fs.writeFileSync(path.join(sourceRoot, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(sourceRoot, 'GEMINI.md'), '# Gemini\n');

  fs.writeFileSync(
    path.join(sourceRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      skills_source: '.',
      projects: [
        { id: 'a', path: projectA, agent_id: 'a-gm' },
        { id: 'b', path: projectB, agent_id: 'b-gm' },
      ],
    }, null, 2)
  );

  const exec = makeIo();
  const code = await runNetworkCommand(['sync', 'a', '--cwd', sourceRoot], exec.io);
  assert.equal(code, 0);

  assert.equal(fs.existsSync(path.join(projectA, '.claude', 'skills', 'example-skill', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(projectB, '.claude', 'skills', 'example-skill', 'SKILL.md')), false);
});

test('sync command supports --commit for synced files', { timeout: 60000 }, async () => {
  const sourceRoot = mkd('agentbootup-sync-commit-');
  const projectPath = path.join(sourceRoot, 'project-git');
  fs.mkdirSync(projectPath, { recursive: true });

  const init = runCmd(['git', 'init'], projectPath);
  assert.equal(init.status, 0);
  assert.equal(runCmd(['git', 'config', 'user.email', 'agentbootup@example.com'], projectPath).status, 0);
  assert.equal(runCmd(['git', 'config', 'user.name', 'Agent Bootup'], projectPath).status, 0);

  fs.writeFileSync(path.join(projectPath, '.gitignore'), 'node_modules/\n');
  assert.equal(runCmd(['git', 'add', '.gitignore'], projectPath).status, 0);
  assert.equal(runCmd(['git', 'commit', '-m', 'chore: init repo'], projectPath).status, 0);

  fs.mkdirSync(path.join(sourceRoot, '.claude', 'skills', 'example-skill'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.claude', 'skills', 'example-skill', 'SKILL.md'), '# Skill\n');
  fs.writeFileSync(path.join(sourceRoot, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(sourceRoot, 'GEMINI.md'), '# Gemini\n');

  fs.writeFileSync(
    path.join(sourceRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      skills_source: '.',
      projects: [{ id: 'git-project', path: projectPath, agent_id: 'git-project-gm' }],
    }, null, 2)
  );

  const exec = makeIo();
  const code = await runNetworkCommand(['sync', 'git-project', '--commit', '--cwd', sourceRoot], exec.io);
  assert.equal(code, 0);
  assert.match(exec.out.join('\n'), /committed synced files/);

  const log = runCmd(['git', 'log', '--oneline', '-1'], projectPath);
  assert.equal(log.status, 0);
  assert.match(log.stdout, /chore\(agentbootup\): sync skills from network root/);
});

test('trust command persists trusted status', async () => {
  const tempDir = mkd('agentbootup-trust-');

  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'a', path: '/tmp/a', agent_id: 'a-gm', trusted: false },
        { id: 'b', path: '/tmp/b', agent_id: 'b-gm', trusted: false },
      ],
    }, null, 2)
  );

  const one = makeIo();
  const oneCode = await runNetworkCommand(['trust', 'a', '--cwd', tempDir], one.io);
  assert.equal(oneCode, 0);

  let cfg = JSON.parse(fs.readFileSync(path.join(tempDir, 'agentbootup.json'), 'utf-8'));
  assert.equal(cfg.projects.find((p) => p.id === 'a').trusted, true);
  assert.equal(cfg.projects.find((p) => p.id === 'b').trusted, false);

  const all = makeIo();
  const allCode = await runNetworkCommand(['trust', '--all', '--cwd', tempDir], all.io);
  assert.equal(allCode, 0);

  cfg = JSON.parse(fs.readFileSync(path.join(tempDir, 'agentbootup.json'), 'utf-8'));
  assert.equal(cfg.projects.every((p) => p.trusted === true), true);
});

test('trust command rejects conflicting target and --all', async () => {
  const tempDir = mkd('agentbootup-trust-conflict-');
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'a', path: '/tmp/a', agent_id: 'a-gm', trusted: false }],
    }, null, 2)
  );

  const run = makeIo();
  const code = await runNetworkCommand(['trust', 'a', '--all', '--cwd', tempDir], run.io);
  assert.equal(code, 1);
  assert.match(run.err.join('\n'), /either --all or a project-id/);
});

test('watch once mode invokes sync path and invalid interval fails fast', async () => {
  const tempDir = mkd('agentbootup-watch-');
  const projectPath = path.join(tempDir, 'project-b');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-b', path: projectPath, agent_id: 'project-b-gm' }],
    }, null, 2)
  );

  const once = makeIo();
  const onceCode = await runNetworkCommand(['watch', '--once', '--cwd', tempDir], once.io);
  assert.equal(onceCode, 0);
  assert.match(once.out.join('\n'), /Watch once mode/);

  const bad = makeIo();
  const badCode = await runNetworkCommand(['watch', '--interval', 'weird', '--cwd', tempDir], bad.io);
  assert.equal(badCode, 1);
  assert.match(bad.err.join('\n'), /invalid --interval/);
});

test('bare invocation prints help without entering seed mode', () => {
  const tempDir = mkd('agentbootup-bare-seed-migration-');
  const result = spawnSync(
    process.execPath,
    [bootupPath],
    {
      cwd: tempDir,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /Bootup summary:/);
  assert.match(result.stdout, /Auth Commands:/);
  assert.match(result.stdout, /Brain Commands:/);
  assert.match(result.stdout, /seed\/local scaffolding has been removed\./);
});

test('bare invocation inside a network root shows network help instead of seed migration error', () => {
  const tempDir = mkd('agentbootup-bare-network-');
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'demo', path: '/tmp/demo', agent_id: 'demo-gm', trusted: false }],
    }, null, 2)
  );

  const result = spawnSync(
    process.execPath,
    [bootupPath],
    {
      cwd: tempDir,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /Seed mode now requires an explicit subcommand/);
  assert.match(result.stdout, /agentbootup network commands:/);
  assert.match(result.stdout, /doctor \[project-id\]/);
});

test('bare invocation inside a project repo shows general help instead of network help', () => {
  const tempDir = mkd('agentbootup-bare-project-');
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      id: 'demo',
      agent_id: 'demo-gm',
      network: '~/network-root',
      trusted: false,
    }, null, 2)
  );

  const result = spawnSync(
    process.execPath,
    [bootupPath],
    {
      cwd: tempDir,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /agentbootup network commands:/);
  assert.match(result.stdout, /Auth Commands:/);
  assert.match(result.stdout, /seed\/local scaffolding has been removed\./);
});

test('bare invocation with leading --cwd into a network root shows network help', () => {
  const tempDir = mkd('agentbootup-bare-network-cwd-');
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [],
    }, null, 2)
  );

  const result = spawnSync(
    process.execPath,
    [bootupPath, '--cwd', tempDir],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /agentbootup network commands:/);
});

test('leading --cwd keeps generic unknown-command handling for legacy seed-like flags', () => {
  const tempDir = mkd('agentbootup-seed-like-cwd-');
  const result = spawnSync(
    process.execPath,
    [bootupPath, '--cwd', tempDir, '--target', tempDir, '--dry-run'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 1);
  // Without a literal `seed` token, legacy flag-only invocations now fall through the
  // top-level parser's generic unknown-command branch instead of a seed migration path.
  assert.match(result.stderr, /Unknown command "--target"\./);
  assert.doesNotMatch(result.stdout, /Bootup summary:/);
});

test('leading --cwd still routes top-level doctor instead of network doctor', { timeout: 20000 }, () => {
  const tempDir = mkd('agentbootup-doctor-cwd-');
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [],
    }, null, 2)
  );

  const result = spawnSync(
    process.execPath,
    [bootupPath, '--cwd', tempDir, 'doctor', '--json'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
    }
  );

  // Doctor exit status reflects live host findings, which are outside this
  // routing test. A nonzero status is valid only when the JSON explains it
  // with at least one normal doctor error finding.
  assert.ok([0, 1].includes(result.status), result.stderr);
  assert.doesNotMatch(result.stdout, /agentbootup network commands:/);
  assert.doesNotMatch(result.stdout, /Network Status/);
  assert.doesNotMatch(result.stderr, /Unknown option: --json/);
  assert.doesNotMatch(result.stderr, /doctor failed/);
  let output;
  const diagnostic = `stdout=${result.stdout}\nstderr=${result.stderr}`;
  assert.doesNotThrow(() => { output = JSON.parse(result.stdout); }, diagnostic);
  assert.ok(Array.isArray(output.issues), diagnostic);
  assert.equal(result.status, output.issues.some((issue) => issue.severity === 'error') ? 1 : 0, diagnostic);
});

test('brain doctor routes to branch-mode doctor through the brain command surface', () => {
  const tempDir = mkd('agentbootup-brain-doctor-');
  const result = spawnSync(
    process.execPath,
    [bootupPath, 'brain', 'doctor', '--branch-mode', '--brain', 'brain-a', '--branch', 'tenant-acme', '--json'],
    {
      cwd: tempDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        AGENTBOOTUP_CONFIG_FILE: path.join(tempDir, 'config.json'),
        AGENTBOOTUP_SYNC_STATE_FILE: path.join(tempDir, 'sync-state.json'),
        AGENTBOOTUP_DAEMON_DIR: path.join(tempDir, 'daemon'),
        AGENTBOOTUP_TRANSCRIPTS_DIR: path.join(tempDir, 'transcripts'),
        AGENTBOOTUP_CREDS_FILE: path.join(tempDir, 'credentials'),
      },
    }
  );

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.issues));
  assert.ok(parsed.issues.some((issue) => issue.category === 'provisioning'));
});

test('seed-like flags without a command produce an unknown-command error', () => {
  const tempDir = mkd('agentbootup-legacy-');
  const result = spawnSync(
    process.execPath,
    ['bootup.mjs', '--dry-run', '--target', tempDir, '--subset', 'docs'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 1);
  // Migration guidance is reserved for the removed `seed` subcommand itself; bare legacy
  // flags are treated as unrecognized top-level arguments.
  assert.match(result.stderr, /Unknown command "--dry-run"\./);
  assert.doesNotMatch(result.stdout, /Bootup summary:/);
});

test('explicit seed subcommand reports removal and migration targets', () => {
  const tempDir = mkd('agentbootup-seed-subcommand-');
  const result = spawnSync(
    process.execPath,
    ['bootup.mjs', 'seed', '--dry-run', '--target', tempDir, '--subset', 'docs'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /`agentbootup seed` has been removed\./);
  assert.match(result.stderr, /agentbootup brain restore/);
  assert.match(result.stdout, /seed\/local scaffolding has been removed\./);
});

test('--help exits 0 and prints top-level help sections', () => {
  const result = spawnSync(
    process.execPath,
    [bootupPath, '--help'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Auth Commands:/);
  assert.match(result.stdout, /Brain Commands:/);
  assert.match(result.stdout, /Daemon Commands:/);
  assert.match(result.stdout, /--no-index-transcripts/);
  assert.match(result.stdout, /--no-inbox/);
  assert.match(result.stdout, /--no-narrative/);
  assert.match(result.stdout, /--skills-mode=static\|mech-storage/);
  assert.match(result.stdout, /transcripts offload \[--older-than <duration> \| --before <date> \| --session <id>\]/);
  assert.match(result.stdout, /--dry-run.*--apply \[--yes\].*--json/);
  assert.match(result.stdout, /production evidence is PAUSE; dry-run never deletes files/);
  assert.match(result.stdout, /seed\/local scaffolding has been removed\./);
});

test('--version prints package version', () => {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const result = spawnSync(
    process.execPath,
    [bootupPath, '--version'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('bare status with no network config routes to brain status semantics', () => {
  const tempDir = mkd('agentbootup-fallback-');
  const emptyConfigPath = path.join(tempDir, 'empty-config.json');
  fs.writeFileSync(emptyConfigPath, '{}');
  const result = spawnSync(
    process.execPath,
    [bootupPath, 'status', '--dry-run', '--target', tempDir, '--subset', 'docs'],
    {
      cwd: tempDir,
      encoding: 'utf-8',
      env: { ...process.env, AGENTBOOTUP_CONFIG_FILE: emptyConfigPath },
    }
  );

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /Bootup summary:/);
  assert.match(result.stdout, /"brain_id": "--dry-run"|Brain not mounted/);
});

test('bare status without network config routes to brain status', () => {
  const tempDir = mkd('agentbootup-status-brain-');
  const emptyConfigPath = path.join(tempDir, 'empty-config.json');
  fs.writeFileSync(emptyConfigPath, '{}');
  const result = spawnSync(
    process.execPath,
    [bootupPath, 'status', 'bootup.gm'],
    {
      cwd: tempDir,
      encoding: 'utf-8',
      env: { ...process.env, AGENTBOOTUP_CONFIG_FILE: emptyConfigPath },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"brain_id": "bootup\.gm"|Brain not mounted/);
});

test('status with seed-mode flags and no network config does not fall through to seed mode', () => {
  const tempDir = mkd('agentbootup-status-no-seed-');
  const emptyConfigPath = path.join(tempDir, 'empty-config.json');
  fs.writeFileSync(emptyConfigPath, '{}');
  const result = spawnSync(
    process.execPath,
    [bootupPath, 'status', '--dry-run', '--target', tempDir, '--subset', 'docs'],
    {
      cwd: tempDir,
      encoding: 'utf-8',
      env: { ...process.env, AGENTBOOTUP_CONFIG_FILE: emptyConfigPath },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Bootup summary:/);
  assert.match(result.stdout, /"brain_id": "--dry-run"|Brain not mounted/);
});

test('explicit network namespace still routes without config', () => {
  const tempDir = mkd('agentbootup-network-explicit-');
  const result = spawnSync(
    process.execPath,
    ['bootup.mjs', 'network', 'status', '--cwd', tempDir],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /status failed|Missing agentbootup\.json/);
});

test('explicit network namespace still routes with leading --cwd', () => {
  const tempDir = mkd('agentbootup-network-explicit-cwd-');
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2)
  );

  const result = spawnSync(
    process.execPath,
    [bootupPath, '--cwd', tempDir, 'network', 'status'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Network Status|No projects found|Install state summary|agentbootup network commands:/);
});

test('bare status with network flags routes to network status when config exists', () => {
  const tempDir = mkd('agentbootup-status-env-');
  fs.writeFileSync(
    path.join(tempDir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'demo', agent_id: 'demo.gm', path: '/tmp/demo', brain: true }],
    }, null, 2)
  );
  fs.mkdirSync(path.join(tempDir, 'environments'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'environments', 'decisive.json'),
    JSON.stringify({ id: 'decisive', version: 1, projects: ['demo'] }, null, 2)
  );

  const result = spawnSync(
    process.execPath,
    [bootupPath, 'status', '--env', 'decisive', '--cwd', tempDir],
    {
      cwd: tempDir,
      encoding: 'utf-8',
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Network Status/);
  assert.match(result.stdout, /Projects: 1/);
});
