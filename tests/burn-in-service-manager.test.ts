import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const starts: Array<Record<string, unknown>> = [];
const stops: string[] = [];
let status = { state: 'stopped', platform: 'launchd' };

mock.module('@derivativelabs/agent-process', () => ({
  agentStart: async (config: Record<string, unknown>) => {
    starts.push(config);
    return { name: config.name, pid: 1234, platform: 'launchd' };
  },
  agentStop: async (name: string) => { stops.push(name); },
  agentStatus: async () => status,
}));

const roots: string[] = [];
let root = '';
let runtime = '';
let state = '';
let knownHosts = '';

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    AGENTBOOTUP_BURNIN_BRAIN: 'bootup',
    AGENTBOOTUP_BURNIN_LOCAL_DIR: runtime,
    AGENTBOOTUP_BURNIN_MINI_SSH: 'operator@mini',
    AGENTBOOTUP_BURNIN_KNOWN_HOSTS: knownHosts,
    AGENTBOOTUP_BURNIN_REMOTE_DIR: '/srv/bootup',
    AGENTBOOTUP_BURNIN_STORE: 'server://bootup',
    AGENTBOOTUP_BURNIN_CANONICAL_REF: 'refs/heads/main',
    AGENTBOOTUP_BURNIN_CANONICAL_COMMIT: 'a'.repeat(40),
    AGENTBOOTUP_BURNIN_STATE_ROOT: state,
    AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE: '1',
    AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT: path.join(root, 'descriptor-state'),
    AGENTBOOTUP_DAEMON_DIR: path.join(root, 'daemon-state'),
    AGENTBOOTUP_CONFIG_FILE: path.join(root, 'agentbootup.json'),
    AGENTBOOTUP_NETWORK_ROOT: path.join(root, 'network-root'),
    AGENTBOOTUP_HOME: path.join(root, 'agentbootup-home'),
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'burn-in-service-')));
  roots.push(root);
  runtime = path.join(root, 'runtime');
  state = path.join(root, 'state');
  fs.mkdirSync(runtime);
  fs.mkdirSync(state, { mode: 0o700 });
  knownHosts = path.join(root, 'known_hosts');
  fs.writeFileSync(knownHosts, 'mini ssh-ed25519 AAAA');
  fs.chmodSync(knownHosts, 0o600);
  starts.length = 0;
  stops.length = 0;
  status = { state: 'stopped', platform: 'launchd' };
});

afterEach(() => {
  for (const item of roots.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});

test('install uses the released burn-in daemon with only explicit burn-in configuration', async () => {
  const { installBurnInService } = await import('../lib/burn-in/service-manager.js');
  const result = await installBurnInService({ env: env(), preflight: async () => ({ ready: true }) });

  expect(result.name).toBe('agentbootup-burn-in-bootup');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({
    name: 'agentbootup-burn-in-bootup',
    script: expect.stringContaining('scripts/burn-in-daemon.ts'),
    workingDirectory: runtime,
    env: {
      AGENTBOOTUP_BURNIN_BRAIN: 'bootup',
      AGENTBOOTUP_BURNIN_STATE_ROOT: state,
      AGENTBOOTUP_BURNIN_LOCAL_DIR: runtime,
      AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE: '1',
      AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT: path.join(root, 'descriptor-state'),
      AGENTBOOTUP_DAEMON_DIR: path.join(root, 'daemon-state'),
      AGENTBOOTUP_CONFIG_FILE: path.join(root, 'agentbootup.json'),
      AGENTBOOTUP_NETWORK_ROOT: path.join(root, 'network-root'),
      AGENTBOOTUP_HOME: path.join(root, 'agentbootup-home'),
    },
  });
  expect(Object.keys(starts[0].env as Record<string, string>).every((key) => key === 'PATH' || key.startsWith('AGENTBOOTUP_BURNIN_') || [
    'AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE',
    'AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT',
    'AGENTBOOTUP_DAEMON_DIR',
    'AGENTBOOTUP_CONFIG_FILE',
    'AGENTBOOTUP_NETWORK_ROOT',
    'AGENTBOOTUP_HOME',
  ].includes(key))).toBe(true);
  expect(fs.readdirSync(root).sort()).toEqual(['known_hosts', 'runtime', 'state']);
});

test('start, stop, and restart target only the derived per-brain service name', async () => {
  const service = await import('../lib/burn-in/service-manager.js');
  const options = { env: env(), preflight: async () => ({ ready: true }) };

  await service.startBurnInService(options);
  await service.stopBurnInService(options);
  await service.restartBurnInService(options);

  expect(starts).toHaveLength(2);
  expect(stops).toEqual(['agentbootup-burn-in-bootup', 'agentbootup-burn-in-bootup']);
});

test('stop remains a rollback path when the configured runtime is missing', async () => {
  const { stopBurnInService } = await import('../lib/burn-in/service-manager.js');
  fs.rmSync(runtime, { recursive: true, force: true });

  await stopBurnInService({ env: env() });

  expect(stops).toEqual(['agentbootup-burn-in-bootup']);
  expect(starts).toEqual([]);
});

test('declares the adapter-owned macOS plist separately from burn-in state', async () => {
  const { burnInServiceArtifact } = await import('../lib/burn-in/service-manager.js');
  const config = { brain: 'bootup' };
  expect(burnInServiceArtifact(config, 'darwin', '/Users/operator')).toBe(
    '/Users/operator/Library/LaunchAgents/com.dundas.agentbootup-burn-in-bootup.plist',
  );
  expect(burnInServiceArtifact(config, 'linux', '/home/operator')).toBeNull();
});

test('failed preflight never installs or starts a service', async () => {
  const { installBurnInService } = await import('../lib/burn-in/service-manager.js');
  await expect(installBurnInService({ env: env(), preflight: async () => ({ ready: false, code: 'attestation_failed' }) })).rejects.toThrow('preflight');
  expect(starts).toEqual([]);
  expect(stops).toEqual([]);
});

test('status calls out a stale ledger without inspecting paths outside its owned state root', async () => {
  const { burnInServiceStatus } = await import('../lib/burn-in/service-manager.js');
  const ledger = path.join(state, 'burn-in-bootup.jsonl');
  fs.writeFileSync(ledger, `${JSON.stringify({ ts: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), tick: 1, kind: 'health', machine: 'macbook', state: 'ok' })}\n`);

  const result = await burnInServiceStatus({ env: env(), now: Date.now(), staleLedgerMs: 60 * 60_000 });
  expect(result).toMatchObject({ name: 'agentbootup-burn-in-bootup', ledger: 'stale', service: 'stopped' });
  expect(fs.readdirSync(root).sort()).toEqual(['known_hosts', 'runtime', 'state']);
});
