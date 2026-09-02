import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runBootupMachineCommand,
  setBootupMachineRuntimeForTests,
  resetBootupMachineRuntimeForTests,
} from '../../lib/network/commands/bootup-machine.js';
import { loadNetworkConfig } from '../../lib/network/config.js';
import {
  CREDS_STATE_OK,
  CREDS_STATE_UNDECRYPTABLE,
  CREDS_STATE_READ_ERROR,
} from '../../lib/auth/credentials.js';

test.afterEach(() => {
  resetBootupMachineRuntimeForTests();
});

test('bootup-machine plan create emits a shared bootstrap manifest with defaults', async () => {
  const stdout = [];
  const stderr = [];
  const code = await runBootupMachineCommand(
    [
      'plan',
      'create',
      'infinitrade',
      '--repo',
      'git@github.com:dundas/infinitrade.git',
      '--env-config',
      '/tmp/decisive-env.json',
      '--network-root',
      '/tmp/network',
      '--existing-repo',
      '/tmp/repos/infinitrade',
    ],
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
  );

  assert.equal(code, 0, stderr.join('\n'));
  const plan = JSON.parse(stdout.join('\n'));
  assert.equal(plan.kind, 'agentbootup-bootstrap-plan');
  assert.equal(plan.project_id, 'infinitrade');
  assert.equal(plan.repo.url, 'git@github.com:dundas/infinitrade.git');
  assert.equal(plan.repo.adopt_mode, 'prefer-existing');
  assert.equal(plan.daemon.transcript_scope, 'project');
  assert.equal(plan.network_root, path.resolve('/tmp/network'));
  assert.equal(plan.env_config_path, path.resolve('/tmp/decisive-env.json'));
  assert.equal(plan.repo.existing_path, path.resolve('/tmp/repos/infinitrade'));
});

test('bootup-machine plan validate accepts a generated manifest file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-plan-'));
  try {
    const manifestPath = path.join(root, 'bootstrap-plan.json');
    const createStdout = [];
    const createCode = await runBootupMachineCommand(
      [
        'plan',
        'create',
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        './env/decisive-env.json',
        '--network-root',
        './network',
        '--out',
        manifestPath,
      ],
      { stdout: (line) => createStdout.push(line), stderr: () => {} }
    );

    assert.equal(createCode, 0);
    assert.ok(fs.existsSync(manifestPath));

    const stdout = [];
    const code = await runBootupMachineCommand(
      ['plan', 'validate', manifestPath],
      { stdout: (line) => stdout.push(line), stderr: () => {} }
    );

    assert.equal(code, 0);
    assert.ok(stdout.some((line) => line.includes('bootup-machine plan: valid')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine plan create refuses to overwrite an existing manifest without --force', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-plan-overwrite-'));
  try {
    const manifestPath = path.join(root, 'bootstrap-plan.json');
    fs.writeFileSync(manifestPath, '{}\n');

    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'plan',
        'create',
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        './env/decisive-env.json',
        '--network-root',
        './network',
        '--out',
        manifestPath,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.match(stderr.join('\n'), /refusing to overwrite/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine plan create supports existing-checkout-only manifests', async () => {
  const stdout = [];
  const code = await runBootupMachineCommand(
    [
      'plan',
      'create',
      'infinitrade',
      '--existing-repo',
      './repos/infinitrade',
      '--env-config',
      './env/decisive-env.json',
      '--network-root',
      './network',
    ],
    { stdout: (line) => stdout.push(line), stderr: () => {} }
  );

  assert.equal(code, 0);
  const plan = JSON.parse(stdout.join('\n'));
  assert.equal(plan.repo.url, undefined);
  assert.equal(plan.repo.existing_path, path.resolve('./repos/infinitrade'));
});

test('bootup-machine plan validate reports invalid manifest errors cleanly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-plan-invalid-'));
  try {
    const manifestPath = path.join(root, 'bootstrap-plan.json');
    fs.writeFileSync(manifestPath, '{not json');

    const stderr = [];
    const code = await runBootupMachineCommand(
      ['plan', 'validate', manifestPath],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.match(stderr.join('\n'), /invalid JSON/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine plan usage reflects existing-repo-only and --force support', async () => {
  const stderr = [];
  const code = await runBootupMachineCommand(
    ['plan', '--help'],
    { stdout: () => {}, stderr: (line) => stderr.push(line) }
  );

  assert.equal(code, 1);
  const output = stderr.join('\n');
  assert.match(output, /--existing-repo <path>/);
  assert.match(output, /\[--force\]/);
  assert.match(output, /\[--repo <git-url>\] \[--existing-repo <path>\]/);
  assert.match(output, /plan run <manifest-path>/);
  assert.match(output, /--mode <summary\|push\|pull\|script>/);
});

test('bootup-machine plan show renders push, pull, and script instructions from one manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-plan-show-'));
  try {
    const manifestPath = path.join(root, 'bootstrap-plan.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          kind: 'agentbootup-bootstrap-plan',
          version: 1,
          project_id: 'infinitrade',
          repo: {
            url: 'git@github.com:dundas/infinitrade.git',
            existing_path: './repos/infinitrade',
            adopt_mode: 'prefer-existing',
          },
          network_root: './network',
          env_config_path: './env/decisive-env.json',
          credentials: { mode: 'existing-or-inline' },
          runtime: { strategy: 'auto' },
          daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'project' },
        },
        null,
        2
      )
    );

    for (const mode of ['push', 'pull', 'script']) {
      const stdout = [];
      const code = await runBootupMachineCommand(
        ['plan', 'show', manifestPath, '--mode', mode],
        { stdout: (line) => stdout.push(line), stderr: () => {} }
      );
      assert.equal(code, 0);
      assert.ok(stdout.some((line) => line.includes(`${mode === 'script' ? '# Script mode' : mode === 'push' ? '# Push mode' : '# Pull mode'}`)));
      assert.ok(stdout.some((line) => line.includes('agentbootup bootup-machine --plan')));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine requires a manifest path after --plan', async () => {
  const stderr = [];
  const code = await runBootupMachineCommand(
    [
      'infinitrade',
      '--plan',
    ],
    { stdout: () => {}, stderr: (line) => stderr.push(line) }
  );

  assert.equal(code, 1);
  assert.match(stderr.join('\n'), /--plan requires a manifest path/);
});

test('bootup-machine executes a manifest via --plan and reuses an existing checkout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-plan-exec-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    const existingRepo = path.join(root, 'repos', 'infinitrade');
    fs.mkdirSync(envSkills, { recursive: true });
    fs.mkdirSync(path.join(existingRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(existingRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(existingRepo, 'agentbootup.json'),
      JSON.stringify({ version: '2.0', role: 'project', agent_id: 'infinitrade' }, null, 2)
    );

    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const manifestPath = path.join(root, 'bootstrap-plan.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          kind: 'agentbootup-bootstrap-plan',
          version: 1,
          project_id: 'infinitrade',
          repo: {
            existing_path: existingRepo,
            adopt_mode: 'prefer-existing',
          },
          network_root: networkRoot,
          env_config_path: envConfigPath,
          credentials: { mode: 'existing-or-inline' },
          runtime: { strategy: 'auto' },
          daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'project' },
        },
        null,
        2
      )
    );

    const calls = [];
    let configuredNetworkRoot = null;
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return configuredNetworkRoot;
      },
      async setNetworkRoot(next) {
        configuredNetworkRoot = next;
      },
      cloneRepo() {
        throw new Error('clone should not run when manifest points at an existing checkout');
      },
      async runBrainRestore(argv) {
        calls.push(['restore', ...argv]);
      },
      async runInstallCommand(argv) {
        calls.push(['install', ...argv]);
        return 0;
      },
      async runDaemonCommand(argv) {
        calls.push(argv);
      },
    });

    const stdout = [];
    const stderr = [];
    const code = await runBootupMachineCommand(
      ['--plan', manifestPath],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 0, stderr.join('\n'));
    assert.equal(configuredNetworkRoot, networkRoot);
    assert.ok(stdout.some((line) => line.includes(`bootup-machine: adopted existing repo at ${existingRepo}`)));
    assert.equal(calls.some((entry) => entry[0] === 'restore'), true);
    assert.equal(calls.some((entry) => entry[0] === 'install'), true);
    assert.deepEqual(calls.filter((entry) => entry[0] === 'daemon'), [
      ['daemon', 'start', 'infinitrade', '--yes'],
    ]);

    const loaded = loadNetworkConfig(networkRoot);
    const project = loaded.config.projects.find((item) => item.id === 'infinitrade');
    assert.ok(project);
    assert.equal(project.path, existingRepo);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine plan run supports portfolio transcript scope by splitting brain and transcript starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-plan-run-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    const existingRepo = path.join(root, 'repos', 'infinitrade');
    fs.mkdirSync(envSkills, { recursive: true });
    fs.mkdirSync(path.join(existingRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(existingRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const manifestPath = path.join(root, 'bootstrap-plan.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          kind: 'agentbootup-bootstrap-plan',
          version: 1,
          project_id: 'infinitrade',
          repo: {
            existing_path: existingRepo,
            adopt_mode: 'prefer-existing',
          },
          network_root: networkRoot,
          env_config_path: envConfigPath,
          credentials: { mode: 'existing-or-inline' },
          runtime: { strategy: 'auto' },
          daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'portfolio' },
        },
        null,
        2
      )
    );

    const calls = [];
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return null;
      },
      async setNetworkRoot() {},
      async runBrainRestore() {},
      async runInstallCommand() {
        return 0;
      },
      async runDaemonCommand(argv) {
        calls.push(argv);
      },
    });

    const code = await runBootupMachineCommand(
      ['plan', 'run', manifestPath],
      { stdout: () => {}, stderr: () => {} }
    );

    assert.equal(code, 0);
    assert.deepEqual(calls, [
      ['daemon', 'start', 'infinitrade', '--yes', '--no-transcripts'],
      ['daemon', 'start', '--all', '--no-brain', '--yes'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine plan run uses checkout-backed runtime for install and daemon commands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-runtime-checkout-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    const existingRepo = path.join(root, 'repos', 'infinitrade');
    const runtimeCheckout = path.join(root, 'agentbootup-current');
    fs.mkdirSync(envSkills, { recursive: true });
    fs.mkdirSync(path.join(existingRepo, '.git'), { recursive: true });
    fs.mkdirSync(runtimeCheckout, { recursive: true });
    fs.writeFileSync(path.join(existingRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(runtimeCheckout, 'bootup.mjs'), '#!/usr/bin/env node\n');
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const manifestPath = path.join(root, 'bootstrap-plan.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          kind: 'agentbootup-bootstrap-plan',
          version: 1,
          project_id: 'infinitrade',
          repo: {
            existing_path: existingRepo,
            adopt_mode: 'prefer-existing',
          },
          network_root: networkRoot,
          env_config_path: envConfigPath,
          credentials: { mode: 'existing-or-inline' },
          runtime: { strategy: 'checkout', checkout_path: runtimeCheckout },
          daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'project' },
        },
        null,
        2
      )
    );

    const calls = [];
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return null;
      },
      async setNetworkRoot() {},
      async runBrainRestore() {
        calls.push(['restore']);
      },
      async runInstallCommand() {
        throw new Error('install should run from checkout-backed runtime');
      },
      async runDaemonCommand() {
        throw new Error('daemon should run from checkout-backed runtime');
      },
      runAgentbootupCommand(runtimeRoot, argv) {
        calls.push(['runtime', runtimeRoot, ...argv]);
        return 0;
      },
    });

    const stdout = [];
    const stderr = [];
    const code = await runBootupMachineCommand(
      ['plan', 'run', manifestPath],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 0, stderr.join('\n'));
    assert.ok(stdout.some((line) => line.includes('bootup-machine: cli runtime local-checkout')));
    assert.ok(stdout.some((line) => line.includes(`bootup-machine: selected runtime copied-bootstrap-checkout (${runtimeCheckout})`)));
    assert.ok(stderr.some((line) => line.includes('CLI/runtime drift detected')));
    assert.deepEqual(calls, [
      ['restore'],
      ['runtime', runtimeCheckout, 'install', 'infinitrade', '--env-config', envConfigPath, '--cwd', networkRoot],
      ['runtime', runtimeCheckout, 'daemon', 'start', 'infinitrade', '--yes'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine delegated runtime launcher proxies child stdout, stderr, and exit code', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-runtime-launcher-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    const existingRepo = path.join(root, 'repos', 'infinitrade');
    const runtimeCheckout = path.join(root, 'agentbootup-current');
    fs.mkdirSync(envSkills, { recursive: true });
    fs.mkdirSync(path.join(existingRepo, '.git'), { recursive: true });
    fs.mkdirSync(runtimeCheckout, { recursive: true });
    fs.writeFileSync(path.join(existingRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(runtimeCheckout, 'bootup.mjs'), '#!/usr/bin/env bun\n');
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const manifestPath = path.join(root, 'bootstrap-plan.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          kind: 'agentbootup-bootstrap-plan',
          version: 1,
          project_id: 'infinitrade',
          repo: {
            existing_path: existingRepo,
            adopt_mode: 'prefer-existing',
          },
          network_root: networkRoot,
          env_config_path: envConfigPath,
          credentials: { mode: 'existing-or-inline' },
          runtime: { strategy: 'checkout', checkout_path: runtimeCheckout },
          daemon: { start: true, brain: true, transcripts: false, transcript_scope: 'project' },
        },
        null,
        2
      )
    );

    const calls = [];
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return null;
      },
      async setNetworkRoot() {},
      async runBrainRestore() {},
      async runInstallCommand() {
        throw new Error('install should run from delegated runtime');
      },
      async runDaemonCommand() {
        throw new Error('daemon should run from delegated runtime');
      },
      spawnProcess(command, argv) {
        calls.push([command, ...argv]);
        return {
          status: 23,
          stdout: 'delegated stdout\n',
          stderr: 'delegated stderr\n',
        };
      },
    });

    const stdout = [];
    const stderr = [];
    const code = await runBootupMachineCommand(
      ['plan', 'run', manifestPath],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 23);
    assert.equal(calls.length, 1);
    assert.equal(path.basename(calls[0][0]), 'bun');
    assert.deepEqual(calls[0].slice(1), [
      path.join(runtimeCheckout, 'bootup.mjs'),
      'install',
      'infinitrade',
      '--env-config',
      envConfigPath,
      '--cwd',
      networkRoot,
    ]);
    assert.ok(stdout.includes('delegated stdout'));
    assert.ok(stderr.includes('delegated stderr'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine delegated runtime launcher surfaces spawn errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-runtime-spawn-error-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    const existingRepo = path.join(root, 'repos', 'infinitrade');
    const runtimeCheckout = path.join(root, 'agentbootup-current');
    fs.mkdirSync(envSkills, { recursive: true });
    fs.mkdirSync(path.join(existingRepo, '.git'), { recursive: true });
    fs.mkdirSync(runtimeCheckout, { recursive: true });
    fs.writeFileSync(path.join(existingRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(runtimeCheckout, 'bootup.mjs'), '#!/usr/bin/env bun\n');
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const manifestPath = path.join(root, 'bootstrap-plan.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          kind: 'agentbootup-bootstrap-plan',
          version: 1,
          project_id: 'infinitrade',
          repo: {
            existing_path: existingRepo,
            adopt_mode: 'prefer-existing',
          },
          network_root: networkRoot,
          env_config_path: envConfigPath,
          credentials: { mode: 'existing-or-inline' },
          runtime: { strategy: 'checkout', checkout_path: runtimeCheckout },
          daemon: { start: true, brain: true, transcripts: false, transcript_scope: 'project' },
        },
        null,
        2
      )
    );

    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return null;
      },
      async setNetworkRoot() {},
      async runBrainRestore() {},
      spawnProcess() {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('spawn EPERM'),
        };
      },
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      ['plan', 'run', manifestPath],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.match(stderr.join('\n'), /could not start delegated runtime: spawn EPERM/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine rejects global runtime strategy when current CLI is not a global install', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-runtime-global-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    const existingRepo = path.join(root, 'repos', 'infinitrade');
    fs.mkdirSync(envSkills, { recursive: true });
    fs.mkdirSync(path.join(existingRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(existingRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const manifestPath = path.join(root, 'bootstrap-plan.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          kind: 'agentbootup-bootstrap-plan',
          version: 1,
          project_id: 'infinitrade',
          repo: {
            existing_path: existingRepo,
            adopt_mode: 'prefer-existing',
          },
          network_root: networkRoot,
          env_config_path: envConfigPath,
          credentials: { mode: 'existing-or-inline' },
          runtime: { strategy: 'global' },
          daemon: { start: false, brain: false, transcripts: false, transcript_scope: 'project' },
        },
        null,
        2
      )
    );

    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return null;
      },
      async setNetworkRoot() {},
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      ['plan', 'run', manifestPath],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.match(stderr.join('\n'), /runtime strategy "global" requires running bootup-machine from a global install/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine direct CLI path supports checkout runtime flags', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-direct-runtime-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    const runtimeCheckout = path.join(root, 'agentbootup-current');
    fs.mkdirSync(envSkills, { recursive: true });
    fs.mkdirSync(runtimeCheckout, { recursive: true });
    fs.writeFileSync(path.join(runtimeCheckout, 'bootup.mjs'), '#!/usr/bin/env bun\n');
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const calls = [];
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return null;
      },
      async setNetworkRoot() {},
      cloneRepo(repoUrl, clonePath) {
        fs.mkdirSync(path.join(clonePath, '.git'), { recursive: true });
        fs.writeFileSync(path.join(clonePath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        fs.writeFileSync(
          path.join(clonePath, 'agentbootup.json'),
          JSON.stringify({ version: '2.0', role: 'project', agent_id: 'infinitrade' }, null, 2)
        );
      },
      async runBrainRestore() {
        calls.push(['restore']);
      },
      async runInstallCommand() {
        throw new Error('install should run from delegated runtime');
      },
      async runDaemonCommand() {
        throw new Error('daemon should run from delegated runtime');
      },
      spawnProcess(command, argv) {
        calls.push([command, ...argv]);
        return { status: 0, stdout: 'delegated stdout\n', stderr: '' };
      },
    });

    const stdout = [];
    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
        '--runtime-strategy',
        'checkout',
        '--runtime-checkout',
        runtimeCheckout,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 0, stderr.join('\n'));
    assert.ok(stdout.some((line) => line.includes(`bootup-machine: selected runtime copied-bootstrap-checkout (${runtimeCheckout})`)));
    assert.ok(stderr.some((line) => line.includes('CLI/runtime drift detected')));
    assert.ok(calls.some((entry) => entry[0] === 'restore'));
    const delegatedCalls = calls.filter((entry) => entry[0] !== 'restore');
    assert.equal(delegatedCalls.length, 2);
    assert.equal(path.basename(delegatedCalls[0][0]), 'bun');
    assert.equal(path.basename(delegatedCalls[1][0]), 'bun');
    assert.deepEqual(delegatedCalls[0].slice(1), [
      path.join(runtimeCheckout, 'bootup.mjs'),
      'install',
      'infinitrade',
      '--env-config',
      envConfigPath,
      '--cwd',
      networkRoot,
    ]);
    assert.deepEqual(delegatedCalls[1].slice(1), [
      path.join(runtimeCheckout, 'bootup.mjs'),
      'daemon',
      'start',
      'infinitrade',
      '--yes',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine orchestrates clone/add/trust/restore/install/daemon for a fresh machine', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-'));
  try {
    const networkRoot = path.join(root, 'decisive_redux');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['bootup'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    let creds = null;
    let configuredNetworkRoot = null;
    const calls = [];

    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return creds;
      },
      async writeCredentials(next) {
        creds = next;
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return configuredNetworkRoot;
      },
      async setNetworkRoot(next) {
        configuredNetworkRoot = next;
      },
      cloneRepo(repoUrl, clonePath) {
        calls.push(['clone', repoUrl, clonePath]);
        fs.mkdirSync(clonePath, { recursive: true });
        fs.writeFileSync(
          path.join(clonePath, 'agentbootup.json'),
          JSON.stringify(
            {
              version: '2.0',
              role: 'project',
              agent_id: 'bootup',
              type: 'service',
              reports_to: 'decisive',
              capabilities: ['brain-provisioning'],
            },
            null,
            2
          )
        );
      },
      async runBrainRestore(argv) {
        calls.push(['restore', ...argv]);
      },
      async runInstallCommand(argv) {
        calls.push(['install', ...argv]);
        return 0;
      },
      async runDaemonCommand(argv) {
        calls.push(['daemon', ...argv]);
      },
    });

    const stdout = [];
    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'agentbootup',
        '--repo',
        'git@github.com:dundas/agentbootup.git',
        '--env-config',
        envConfigPath,
        '--api-key',
        'test-key',
        '--network-root',
        networkRoot,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 0, stderr.join('\n'));
    assert.equal(creds?.apiKey, 'test-key');
    assert.equal(configuredNetworkRoot, networkRoot);
    assert.equal(calls[0][0], 'clone');
    assert.equal(calls.some((entry) => entry[0] === 'restore'), true);
    assert.equal(calls.some((entry) => entry[0] === 'install'), true);
    assert.equal(calls.some((entry) => entry[0] === 'daemon'), true);

    const loaded = loadNetworkConfig(networkRoot);
    const project = loaded.config.projects.find((item) => item.id === 'agentbootup');
    assert.ok(project);
    assert.equal(project.path, path.join(root, 'agentbootup'));
    assert.equal(project.agent_id, 'bootup');
    assert.equal(project.trusted, true);
    assert.ok(stdout.some((line) => line.includes('bootup-machine: ready (agentbootup)')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine fails loudly when required environment_skills are missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-missing-'));
  try {
    const networkRoot = path.join(root, 'decisive_redux');
    const envRoot = path.join(root, 'env');
    fs.mkdirSync(envRoot, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['bootup'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    let cloned = false;
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      cloneRepo() {
        cloned = true;
      },
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'agentbootup',
        '--repo',
        'git@github.com:dundas/agentbootup.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.equal(cloned, false);
    assert.match(stderr.join('\n'), /required environment_skills path is missing/);
    assert.match(stderr.join('\n'), /scp -r <source-machine>:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine rejects unsafe inferred repo directory names', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-unsafe-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    fs.mkdirSync(envRoot, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['bootup'],
          environment_skills: { path: './environment-skills/decisive', optional: true },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      cloneRepo() {
        throw new Error('clone should not run');
      },
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'agentbootup',
        '--repo',
        'https://example.com/org/..',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.match(stderr.join('\n'), /cannot infer a safe directory name from repo URL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine fails clearly when the target directory exists but is not a valid git repo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-reclone-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['bootup'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const clonePath = path.join(root, 'agentbootup');
    fs.mkdirSync(clonePath, { recursive: true });
    fs.writeFileSync(path.join(clonePath, 'README.md'), 'partial clone');

    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      cloneRepo() {
        throw new Error('clone should not run for invalid existing checkout');
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'agentbootup',
        '--repo',
        'git@github.com:dundas/agentbootup.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.match(stderr.join('\n'), /invalid existing checkout/);
    assert.match(stderr.join('\n'), new RegExp(clonePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine reuses an existing linked repo without cloning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-linked-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['bootup'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const linkedRepo = path.join(root, 'existing-agentbootup');
    fs.mkdirSync(path.join(linkedRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(linkedRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(linkedRepo, 'agentbootup.json'),
      JSON.stringify(
        { version: '2.0', role: 'project', agent_id: 'bootup', type: 'service', reports_to: 'decisive', capabilities: [] },
        null,
        2
      )
    );

    fs.mkdirSync(networkRoot, { recursive: true });
    fs.writeFileSync(
      path.join(networkRoot, 'agentbootup.json'),
      JSON.stringify(
        {
          version: '2.0',
          role: 'network',
          projects: [{ id: 'agentbootup', path: linkedRepo, agent_id: 'bootup', trusted: true }],
        },
        null,
        2
      )
    );

    let cloneCalled = false;
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      cloneRepo() {
        cloneCalled = true;
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
    });

    const stdout = [];
    const code = await runBootupMachineCommand(
      [
        'agentbootup',
        '--repo',
        'git@github.com:dundas/agentbootup.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: (line) => stdout.push(line), stderr: () => {} }
    );

    assert.equal(code, 0);
    assert.equal(cloneCalled, false);
    assert.ok(stdout.some((line) => line.includes(`repo already present at ${linkedRepo}`)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine reuses an existing linked git worktree without cloning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-worktree-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['bootup'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const linkedRepo = path.join(root, 'existing-agentbootup-worktree');
    fs.mkdirSync(linkedRepo, { recursive: true });
    const fakeGitdir = path.join(root, 'shared-gitdir');
    fs.mkdirSync(fakeGitdir, { recursive: true });
    fs.writeFileSync(path.join(fakeGitdir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(linkedRepo, '.git'), `gitdir: ${fakeGitdir}\n`);
    fs.writeFileSync(
      path.join(linkedRepo, 'agentbootup.json'),
      JSON.stringify(
        { version: '2.0', role: 'project', agent_id: 'bootup', type: 'service', reports_to: 'decisive', capabilities: [] },
        null,
        2
      )
    );

    fs.mkdirSync(networkRoot, { recursive: true });
    fs.writeFileSync(
      path.join(networkRoot, 'agentbootup.json'),
      JSON.stringify(
        {
          version: '2.0',
          role: 'network',
          projects: [{ id: 'agentbootup', path: linkedRepo, agent_id: 'bootup', trusted: true }],
        },
        null,
        2
      )
    );

    let cloneCalled = false;
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      cloneRepo() {
        cloneCalled = true;
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
    });

    const stdout = [];
    const code = await runBootupMachineCommand(
      [
        'agentbootup',
        '--repo',
        'git@github.com:dundas/agentbootup.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: (line) => stdout.push(line), stderr: () => {} }
    );

    assert.equal(code, 0);
    assert.equal(cloneCalled, false);
    assert.ok(stdout.some((line) => line.includes(`repo already present at ${linkedRepo}`)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine ignores an invalid in-root checkout and clones to the sibling path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-invalid-inroot-'));
  try {
    const networkRoot = path.join(root, 'dev_env');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const invalidInRootRepo = path.join(networkRoot, 'infinitrade');
    fs.mkdirSync(invalidInRootRepo, { recursive: true });
    fs.writeFileSync(path.join(invalidInRootRepo, '.git'), 'not-a-worktree-pointer\n');

    const calls = [];
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      getRepoOriginUrl() {
        return 'git@github.com:dundas/infinitrade.git';
      },
      cloneRepo(repoUrl, clonePath) {
        calls.push(['clone', repoUrl, clonePath]);
        fs.mkdirSync(path.join(clonePath, '.git'), { recursive: true });
        fs.writeFileSync(path.join(clonePath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        fs.writeFileSync(
          path.join(clonePath, 'agentbootup.json'),
          JSON.stringify(
            { version: '2.0', role: 'project', agent_id: 'infinitrade', type: 'service', reports_to: 'decisive', capabilities: [] },
            null,
            2
          )
        );
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'clone');
    assert.equal(calls[0][2], path.join(root, 'infinitrade'));
    assert.ok(stderr.some((line) => line.includes(`ignoring invalid existing checkout at ${invalidInRootRepo}`)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine fails clearly when both in-root and sibling checkouts are invalid', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-both-invalid-'));
  try {
    const networkRoot = path.join(root, 'dev_env');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const invalidInRootRepo = path.join(networkRoot, 'infinitrade');
    fs.mkdirSync(invalidInRootRepo, { recursive: true });
    fs.writeFileSync(path.join(invalidInRootRepo, '.git'), 'not-a-worktree-pointer\n');

    const invalidSiblingRepo = path.join(root, 'infinitrade');
    fs.mkdirSync(invalidSiblingRepo, { recursive: true });
    fs.writeFileSync(path.join(invalidSiblingRepo, '.git'), 'still-not-a-worktree-pointer\n');

    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      cloneRepo() {
        throw new Error('clone should not run when both candidate checkouts are invalid');
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.ok(stderr.some((line) => line.includes(`invalid existing checkout at ${invalidInRootRepo}`)));
    assert.ok(stderr.some((line) => line.includes(`invalid existing checkout also present at ${invalidSiblingRepo}`)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine adopts an existing repo inside the network root before cloning elsewhere', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-adopt-'));
  try {
    const networkRoot = path.join(root, 'dev_env');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const existingRepo = path.join(networkRoot, 'infinitrade');
    fs.mkdirSync(path.join(existingRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(existingRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(existingRepo, 'agentbootup.json'),
      JSON.stringify(
        { version: '2.0', role: 'project', agent_id: 'infinitrade', type: 'service', reports_to: 'decisive', capabilities: [] },
        null,
        2
      )
    );

    let cloneCalled = false;
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      getRepoOriginUrl(repoPath) {
        if (repoPath === existingRepo) {
          return 'git@github.com:dundas/infinitrade.git';
        }
        return null;
      },
      cloneRepo() {
        cloneCalled = true;
        throw new Error('clone should not run when adoptable repo exists');
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
    });

    const stdout = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: (line) => stdout.push(line), stderr: () => {} }
    );

    assert.equal(code, 0);
    assert.equal(cloneCalled, false);
    assert.ok(stdout.some((line) => line.includes(`adopted existing repo at ${existingRepo}`)));

    const loaded = loadNetworkConfig(networkRoot);
    const project = loaded.config.projects.find((item) => item.id === 'infinitrade');
    assert.ok(project);
    assert.equal(project.path, existingRepo);
    assert.equal(project.agent_id, 'infinitrade');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine skips adoptable candidates whose remote does not match --repo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-mismatch-'));
  try {
    const networkRoot = path.join(root, 'dev_env');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const existingRepo = path.join(networkRoot, 'infinitrade');
    fs.mkdirSync(path.join(existingRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(existingRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(existingRepo, 'agentbootup.json'),
      JSON.stringify(
        { version: '2.0', role: 'project', agent_id: 'infinitrade', type: 'service', reports_to: 'decisive', capabilities: [] },
        null,
        2
      )
    );

    const calls = [];
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      getRepoOriginUrl(repoPath) {
        if (repoPath === existingRepo) {
          return 'git@github.com:dundas/not-infinitrade.git';
        }
        return null;
      },
      cloneRepo(repoUrl, clonePath) {
        calls.push(['clone', repoUrl, clonePath]);
        fs.mkdirSync(clonePath, { recursive: true });
        fs.writeFileSync(
          path.join(clonePath, 'agentbootup.json'),
          JSON.stringify(
            { version: '2.0', role: 'project', agent_id: 'infinitrade', type: 'service', reports_to: 'decisive', capabilities: [] },
            null,
            2
          )
        );
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
    });

    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: () => {}, stderr: () => {} }
    );

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'clone');
    assert.equal(calls[0][2], path.join(root, 'infinitrade'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine reports undecryptable credentials explicitly when no inline api key is provided', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-creds-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async inspectCredentials() {
        return { state: CREDS_STATE_UNDECRYPTABLE };
      },
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.ok(stderr.some((line) => line.includes('cannot be decrypted on this host')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine reports credential read failures explicitly when no inline api key is provided', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-creds-read-error-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async inspectCredentials() {
        return { state: CREDS_STATE_READ_ERROR, error: new Error('EISDIR: illegal operation on a directory') };
      },
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 1);
    assert.ok(stderr.some((line) => line.includes('credentials file could not be read')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine replaces unreadable credentials when --api-key is provided', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-creds-replace-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const writes = [];
    let credentialState = { state: CREDS_STATE_UNDECRYPTABLE };
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async inspectCredentials() {
        return credentialState;
      },
      async writeCredentials(creds) {
        writes.push(creds);
        credentialState = {
          state: CREDS_STATE_OK,
          creds: { apiKey: creds.apiKey, serverUrl: creds.serverUrl },
        };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      cloneRepo(repoUrl, clonePath) {
        fs.mkdirSync(clonePath, { recursive: true });
        fs.writeFileSync(
          path.join(clonePath, 'agentbootup.json'),
          JSON.stringify(
            { version: '2.0', role: 'project', agent_id: 'infinitrade', type: 'service', reports_to: 'decisive', capabilities: [] },
            null,
            2
          )
        );
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
    });

    const stdout = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
        '--api-key',
        'replacement-key',
      ],
      { stdout: (line) => stdout.push(line), stderr: () => {} }
    );

    assert.equal(code, 0);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], {
      apiKey: 'replacement-key',
      serverUrl: 'https://agentbootup.fly.dev',
    });
    assert.ok(stdout.some((line) => line.includes('replacing unreadable credentials with provided api-key')));
    assert.ok(stdout.some((line) => line.includes('credentials saved')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine skips daemon start when the managed-daemon probe fails for this session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-no-service-manager-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    const clonePath = path.join(path.dirname(networkRoot), 'infinitrade');
    const daemonCalls = [];
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      probeManagedDaemonSupport() {
        return { ok: false, reason: 'launchctl is present but no per-user service domain is available in this session' };
      },
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return null;
      },
      async setNetworkRoot() {},
      cloneRepo(_repoUrl, nextClonePath) {
        fs.mkdirSync(path.join(nextClonePath, '.git'), { recursive: true });
        fs.writeFileSync(path.join(nextClonePath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        fs.writeFileSync(
          path.join(nextClonePath, 'agentbootup.json'),
          JSON.stringify({ version: '2.0', role: 'project', agent_id: 'infinitrade' }, null, 2)
        );
      },
      async runBrainRestore() {},
      async runInstallCommand() {
        return 0;
      },
      async runDaemonCommand(argv) {
        daemonCalls.push(argv);
      },
    });

    const stdout = [];
    const stderr = [];
    const code = await runBootupMachineCommand(
      ['infinitrade', '--repo', 'git@github.com:dundas/infinitrade.git', '--env-config', envConfigPath, '--network-root', networkRoot],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 0, stderr.join('\n'));
    assert.deepEqual(daemonCalls, []);
    assert.ok(stderr.some((line) => line.includes('daemon start skipped')));
    assert.ok(
      stderr.some((line) =>
        line.includes('launchctl is present but no per-user service domain is available in this session')
      )
    );
    assert.ok(stdout.some((line) => line.includes('bootup-machine: ready (infinitrade)')));
    assert.ok(fs.existsSync(clonePath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine does not probe managed daemon support when no daemons are requested', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-no-daemon-request-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    let probeCalls = 0;
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      probeManagedDaemonSupport() {
        probeCalls += 1;
        return { ok: false, reason: 'probe should not run' };
      },
      async readCredentials() {
        return { apiKey: 'x', serverUrl: 'https://agentbootup.fly.dev' };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return null;
      },
      async setNetworkRoot() {},
      cloneRepo(_repoUrl, nextClonePath) {
        fs.mkdirSync(path.join(nextClonePath, '.git'), { recursive: true });
        fs.writeFileSync(path.join(nextClonePath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        fs.writeFileSync(
          path.join(nextClonePath, 'agentbootup.json'),
          JSON.stringify({ version: '2.0', role: 'project', agent_id: 'infinitrade' }, null, 2)
        );
      },
      async runBrainRestore() {},
      async runInstallCommand() {
        return 0;
      },
      async runDaemonCommand() {
        throw new Error('daemon should not start when no daemons are requested');
      },
    });

    const stdout = [];
    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
        '--no-brain',
        '--no-transcripts',
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 0, stderr.join('\n'));
    assert.equal(probeCalls, 0);
    assert.ok(stderr.every((line) => !line.includes('daemon start skipped on this host')));
    assert.ok(stdout.some((line) => line.includes('bootup-machine: ready (infinitrade)')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine records a bootstrap summary after success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-summary-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    let writtenSummary = null;
    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async inspectCredentials() {
        return {
          state: CREDS_STATE_OK,
          creds: { apiKey: 'key', serverUrl: 'https://agentbootup.fly.dev' },
        };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      cloneRepo(repoUrl, clonePath) {
        fs.mkdirSync(clonePath, { recursive: true });
        fs.writeFileSync(
          path.join(clonePath, 'agentbootup.json'),
          JSON.stringify(
            { version: '2.0', role: 'project', agent_id: 'infinitrade', type: 'service', reports_to: 'decisive', capabilities: [] },
            null,
            2
          )
        );
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
      async writeBootstrapSummary(summary) {
        writtenSummary = summary;
        return '/tmp/bootstrap-summary.json';
      },
    });

    const stdout = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: (line) => stdout.push(line), stderr: () => {} }
    );

    assert.equal(code, 0);
    assert.ok(writtenSummary?.last_success);
    assert.equal(writtenSummary.last_success.project_id, 'infinitrade');
    assert.equal(writtenSummary.last_success.env_config_path, path.resolve(envConfigPath));
    assert.equal(writtenSummary.last_success.network_root, path.resolve(networkRoot));
    assert.equal(writtenSummary.last_success.path_details.network_root.role, 'operator-input');
    assert.equal(writtenSummary.last_success.path_details.network_root.durability, 'ephemeral-staging');
    assert.equal(writtenSummary.last_success.path_details.env_config_path.durability, 'ephemeral-staging');
    assert.equal(writtenSummary.last_success.path_details.project_path.role, 'target-project');
    assert.equal(writtenSummary.last_success.repo.url, 'git@github.com:dundas/infinitrade.git');
    assert.equal(writtenSummary.last_success.daemon.start, true);
    assert.ok(Array.isArray(writtenSummary.last_success.artifact_refs));
    assert.ok(stdout.some((line) => line.includes('summary: /tmp/bootstrap-summary.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine warns but succeeds when bootstrap summary recording fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bootup-machine-summary-warn-'));
  try {
    const networkRoot = path.join(root, 'network');
    const envRoot = path.join(root, 'env');
    const envSkills = path.join(envRoot, 'environment-skills', 'decisive');
    fs.mkdirSync(envSkills, { recursive: true });
    const envConfigPath = path.join(envRoot, 'decisive-env.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          schema_version: '1.0',
          environment: 'decisive',
          brains: ['infinitrade'],
          environment_skills: { path: './environment-skills/decisive', optional: false },
          secret_source: { provider: 'mech-vault', namespace: 'ns' },
          routing: { provider: 'mech-plane', endpoint: 'http://localhost:3100', approval_mode: 'confidence' },
          approval_flow: 'orchestrate',
        },
        null,
        2
      )
    );

    setBootupMachineRuntimeForTests({
      validateToolchain() {},
      async inspectCredentials() {
        return {
          state: CREDS_STATE_OK,
          creds: { apiKey: 'key', serverUrl: 'https://agentbootup.fly.dev' },
        };
      },
      async fetchNetworkConfig() {
        return { version: '2.0', role: 'network', projects: [] };
      },
      async getNetworkRoot() {
        return networkRoot;
      },
      async setNetworkRoot() {},
      cloneRepo(repoUrl, clonePath) {
        fs.mkdirSync(clonePath, { recursive: true });
        fs.writeFileSync(
          path.join(clonePath, 'agentbootup.json'),
          JSON.stringify(
            { version: '2.0', role: 'project', agent_id: 'infinitrade', type: 'service', reports_to: 'decisive', capabilities: [] },
            null,
            2
          )
        );
      },
      async runBrainRestore() {},
      async runInstallCommand() { return 0; },
      async runDaemonCommand() {},
      async writeBootstrapSummary() {
        throw new Error('disk full');
      },
    });

    const stderr = [];
    const code = await runBootupMachineCommand(
      [
        'infinitrade',
        '--repo',
        'git@github.com:dundas/infinitrade.git',
        '--env-config',
        envConfigPath,
        '--network-root',
        networkRoot,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) }
    );

    assert.equal(code, 0);
    assert.ok(stderr.some((line) => line.includes('could not record bootstrap summary: disk full')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootup-machine status reports when no summary has been recorded', async () => {
  setBootupMachineRuntimeForTests({
    async readBootstrapSummary() {
      return null;
    },
    getBootstrapSummaryPath() {
      return '/tmp/missing-bootstrap-summary.json';
    },
  });

  const stdout = [];
  const code = await runBootupMachineCommand(['status'], {
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  });

  assert.equal(code, 1);
  assert.ok(stdout.some((line) => line.includes('No bootstrap summary recorded. Expected file: /tmp/missing-bootstrap-summary.json')));
});

test('bootup-machine status renders the last successful bootstrap summary', async () => {
  setBootupMachineRuntimeForTests({
    async readBootstrapSummary() {
      return {
        version: 1,
        last_success: {
          recorded_at: '2026-05-01T12:00:00.000Z',
          project_id: 'infinitrade',
          target_host: { hostname: 'fly-test-host' },
          project_path: '/tmp/infinitrade',
          network_root: '/tmp/network-root',
          env_config_path: '/tmp/decisive-env.json',
          manifest_path: '/tmp/bootstrap-plan.json',
          repo: { url: 'git@github.com:dundas/infinitrade.git' },
          runtime: {
            selected: { source: 'copied-bootstrap-checkout', root: '/tmp/agentbootup' },
          },
          path_details: {
            project_path: { path: '/tmp/infinitrade', role: 'target-project', durability: 'ephemeral-staging' },
            network_root: { path: '/tmp/network-root', role: 'operator-input', durability: 'ephemeral-staging' },
            env_config_path: { path: '/tmp/decisive-env.json', role: 'operator-input', durability: 'ephemeral-staging' },
            manifest_path: { path: '/tmp/bootstrap-plan.json', role: 'operator-input', durability: 'ephemeral-staging' },
          },
          artifact_refs: [
            {
              label: 'project checkout',
              path: '/tmp/infinitrade',
              role: 'target-project',
              durability: 'ephemeral-staging',
              expected_usable: true,
            },
          ],
        },
      };
    },
    getBootstrapSummaryPath() {
      return '/tmp/bootstrap-summary.json';
    },
  });

  const stdout = [];
  const code = await runBootupMachineCommand(['status'], {
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  });

  assert.equal(code, 0);
  assert.ok(stdout.some((line) => line.includes('Bootstrap summary: /tmp/bootstrap-summary.json')));
  assert.ok(stdout.some((line) => line.includes('project_id: infinitrade')));
  assert.ok(stdout.some((line) => line.includes('target_host: fly-test-host')));
  assert.ok(stdout.some((line) => line.includes('network_root: /tmp/network-root [operator-input, ephemeral-staging]')));
  assert.ok(stdout.some((line) => line.includes('env_config_path: /tmp/decisive-env.json [operator-input, ephemeral-staging]')));
  assert.ok(stdout.some((line) => line.includes('treat them as staging artifacts, not canonical reusable paths')));
  assert.ok(stdout.some((line) => line.includes('project checkout: /tmp/infinitrade [target-project, ephemeral-staging, expected-usable]')));
});
