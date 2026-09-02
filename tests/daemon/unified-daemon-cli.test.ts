/**
 * Tests for lib/daemon/unified-daemon-cli.js
 *
 * Covers: sub-command dispatch routing, unknown command exit 1,
 * --no-transcripts + --no-brain rejection, consent gates, and
 * credential pre-validation.
 *
 * Uses process.exit mocking and module-level config/credential overrides via
 * env vars to avoid touching real ~/.agentbootup state.
 */

import { test, expect, beforeEach, afterAll, afterEach, mock } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { Database } from 'bun:sqlite';
import LibsqlDatabase from 'libsql';
import { spawn } from 'child_process';
import { writeCredentials as writeEncryptedCredentials } from '../../lib/auth/credentials.js';
import { indexFile } from '../../lib/brain/index-transcripts.js';

const agentStartCalls: Array<Record<string, any>> = [];
let agentStartImpl: (config: Record<string, any>) => Promise<Record<string, any>>;
let agentStatusImpl: (name: string) => Promise<Record<string, any>>;
const agentStopCalls: string[] = [];
let agentStopImpl: (name: string) => Promise<void>;
const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
let fetchImpl: (url: string, options?: RequestInit) => Promise<Response>;

mock.module('@derivativelabs/agent-process', () => ({
  agentStart: async (config: Record<string, any>) => agentStartImpl(config),
  agentStop: async (name: string) => agentStopImpl(name),
  agentStatus: async (name: string) => agentStatusImpl(name),
  agentLogs: async () => {},
}));

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
  const normalized = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
  fetchCalls.push({ url: normalized, options });
  return fetchImpl(normalized, options);
}) as typeof fetch;

// ── Test isolation ─────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-daemon-cli-test-'));

// Redirect credential + config files to tmp so tests never touch real ~/.agentbootup
const credFile = path.join(tmpDir, 'credentials');
const configFile = path.join(tmpDir, 'config.json');
const daemonStateDir = path.join(tmpDir, 'daemon');
process.env.AGENTBOOTUP_CREDS_FILE = credFile;
process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
process.env.AGENTBOOTUP_DAEMON_DIR = daemonStateDir;

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
  // Restore native fetch so co-runner test files (e.g. webhook-secret-registration)
  // are not affected by this file's globalThis.fetch mock.
  globalThis.fetch = _originalFetch;
  mock.restore();
});

afterEach(async () => {
  const { setUnifiedDaemonRuntimeForTests } = await import('../../lib/daemon/unified-daemon-cli.js');
  setUnifiedDaemonRuntimeForTests(null);
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function captureOutput(): { logs: string[]; errs: string[]; restore: () => void } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  console.error = (...args: unknown[]) => errs.push(args.join(' '));
  return { logs, errs, restore: () => { console.log = origLog; console.error = origErr; } };
}

/**
 * Run runDaemonCommand and capture any process.exit call.
 * Returns { exitCode } if process.exit was called, otherwise { exitCode: null }.
 */
async function runCommand(argv: string[]): Promise<{ exitCode: number | null; logs: string[]; errs: string[] }> {
  const { runDaemonCommand } = await import('../../lib/daemon/unified-daemon-cli.js');
  const cap = captureOutput();
  let exitCode: number | null = null;
  const origExit = process.exit;
  // @ts-ignore
  process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`process.exit(${code})`); };
  try {
    await runDaemonCommand(argv);
  } catch (e: any) {
    if (!String(e.message).startsWith('process.exit(')) throw e;
  } finally {
    process.exit = origExit;
    cap.restore();
  }
  return { exitCode, logs: cap.logs, errs: cap.errs };
}

// Write valid credentials to the tmp file using the same helper and format as runtime.
async function writeCredentials() {
  await writeEncryptedCredentials({
    apiKey: 'test-key',
    serverUrl: 'https://example.com',
  });
}

// Write a config with both consents pre-acknowledged.
async function writeConsentedConfig() {
  await fsp.writeFile(configFile, JSON.stringify({
    brainId: 'test-brain',
    dataTransmissionAcknowledged: true,
    brainAssetTransmissionAcknowledged: true,
  }));
}

// Clear credentials so validateCredentials() will fail.
async function clearCredentials() {
  await fsp.unlink(credFile).catch(() => {});
}

beforeEach(async () => {
  await fsp.unlink(credFile).catch(() => {});
  await fsp.unlink(configFile).catch(() => {});
  agentStartCalls.length = 0;
  agentStartImpl = async (config: Record<string, any>) => {
    agentStartCalls.push(config);
    return { name: config.name, pid: 4321, port: config.port, platform: 'launchd' };
  };
  agentStopCalls.length = 0;
  agentStopImpl = async (name: string) => { agentStopCalls.push(name); };
  agentStatusImpl = async (name: string) => ({ name, state: 'unknown', platform: 'launchd' });
  fetchCalls.length = 0;
  fetchImpl = async () => new Response(JSON.stringify({ data: { files: [] } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

// ── Dispatch routing ───────────────────────────────────────────────────────────

test('unknown sub-command exits 1 with usage message', async () => {
  const { exitCode, errs } = await runCommand(['daemon', 'bogus']);
  expect(exitCode).toBe(1);
  expect(errs.join(' ')).toContain('Usage:');
  expect(errs.join(' ')).toContain('--no-narrative');
});

test('missing sub-command exits 1', async () => {
  const { exitCode } = await runCommand(['daemon']);
  expect(exitCode).toBe(1);
});

// ── --no-transcripts && --no-brain rejection ──────────────────────────────────

test('start with both --no-transcripts and --no-brain exits 1', async () => {
  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--no-brain']);
  expect(exitCode).toBe(1);
  expect(errs.join(' ')).toContain('Nothing to start');
});

test('stop with both --no-transcripts and --no-brain exits 1', async () => {
  const { exitCode, errs } = await runCommand(['daemon', 'stop', '--no-transcripts', '--no-brain']);
  expect(exitCode).toBe(1);
  expect(errs.join(' ')).toContain('Nothing to stop');
});

// ── Credential pre-validation ─────────────────────────────────────────────────
// NOTE: readCredentials() reads from ~/.agentbootup/credentials (AES-256-GCM,
// no env var override). We test the brain-ID guard instead, which IS routed
// through the AGENTBOOTUP_CONFIG_FILE override.

test('start exits 1 when config has no brain ID', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({}));
  const { exitCode, errs } = await runCommand(['daemon', 'start', '--yes']);
  expect(exitCode).toBe(1);
  expect(errs.join(' ')).toContain('No brain ID');
});

// ── Consent gates ─────────────────────────────────────────────────────────────

test('start without --yes exits 1 when transcript consent not acknowledged', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({ brainId: 'b1', brainAssetTransmissionAcknowledged: true }));
  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain']);
  expect(exitCode).toBe(1);
  expect(errs.join(' ')).toContain('transcript sync daemon');
  expect(errs.join(' ')).toContain('--yes');
});

test('start without --yes exits 1 when brain consent not acknowledged', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({ brainId: 'b1', dataTransmissionAcknowledged: true }));
  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts']);
  expect(exitCode).toBe(1);
  expect(errs.join(' ')).toContain('brain asset daemon');
  expect(errs.join(' ')).toContain('--yes');
});

test('start --yes persists both consents in a single pass', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({ brainId: 'b1' }));

  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--yes']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  const persisted = JSON.parse(await fsp.readFile(configFile, 'utf-8'));
  expect(persisted.brainId).toBe('b1');
  expect(persisted.dataTransmissionAcknowledged).toBe(true);
  expect(persisted.brainAssetTransmissionAcknowledged).toBe(true);
});

test('start --yes exits cleanly when consent persistence fails', async () => {
  await writeCredentials();
  const blockedBase = path.join(tmpDir, 'blocked-config-base');
  await fsp.writeFile(blockedBase, 'not-a-directory');
  const originalConfigFile = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = path.join(blockedBase, 'config.json');

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--yes']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toContain('Failed to persist consent acknowledgement');
  } finally {
    process.env.AGENTBOOTUP_CONFIG_FILE = originalConfigFile;
    await fsp.rm(blockedBase, { force: true });
  }
});

test('start --no-transcripts --yes with brain consent skips transcript consent check', async () => {
  await writeCredentials();
  // Only brain consent present — transcript consent intentionally absent.
  await fsp.writeFile(configFile, JSON.stringify({
    brainId: 'b1',
    brainAssetTransmissionAcknowledged: true,
  }));
  // This will fail at agentStart (not in test env), but should NOT exit due to consent.
  // We expect the process to reach agentStart and fail for a different reason.
  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--yes']);
  // Should not be a consent error
  const errText = errs.join(' ');
  expect(errText).not.toContain('agentbootup daemon start --yes');
});

test('single-brain start does not assign a dedicated port to brain daemon', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--yes']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  expect(agentStartCalls).toHaveLength(1);
  expect(agentStartCalls[0].name).toBe('agentbootup-brain');
  expect(agentStartCalls[0].port).toBeUndefined();
  expect(agentStartCalls[0].env?.AGENTBOOTUP_DISABLE_HEALTH_SERVER).toBe('1');
});

test('single-brain transcript daemon binds denylist discovery to its launch project root', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain', '--yes']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  expect(agentStartCalls).toHaveLength(1);
  expect(agentStartCalls[0]).toMatchObject({
    name: 'agentbootup-transcripts',
    workingDirectory: process.cwd(),
    env: {
      AGENTBOOTUP_PROJECT_ROOT: process.cwd(),
      AGENTBOOTUP_REPOSITORY_ROOT: process.cwd(),
    },
  });
});

test('single-brain transcript daemon keeps project scope distinct from a nested repository root', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  const { setUnifiedDaemonRuntimeForTests } = await import('../../lib/daemon/unified-daemon-cli.js');
  setUnifiedDaemonRuntimeForTests({
    resolveSingleProjectScope: () => ({
      projectRoot: '/synthetic/repository-root/apps/foo',
      repositoryRoot: '/synthetic/repository-root',
    }),
  });

  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain', '--yes']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  expect(agentStartCalls[0]).toMatchObject({
    name: 'agentbootup-transcripts',
    workingDirectory: '/synthetic/repository-root',
    env: {
      AGENTBOOTUP_PROJECT_ROOT: '/synthetic/repository-root/apps/foo',
      AGENTBOOTUP_REPOSITORY_ROOT: '/synthetic/repository-root',
    },
  });
});

test('single-brain launcher ignores ambient child project scope', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_PROJECT_ROOT = '/stale/child/project';
  process.env.AGENTBOOTUP_REPOSITORY_ROOT = '/stale/child/repository';

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain', '--yes']);
    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStartCalls[0]).toMatchObject({
      workingDirectory: process.cwd(),
      env: {
        AGENTBOOTUP_PROJECT_ROOT: process.cwd(),
        AGENTBOOTUP_REPOSITORY_ROOT: process.cwd(),
      },
    });
  } finally {
    delete process.env.AGENTBOOTUP_PROJECT_ROOT;
    delete process.env.AGENTBOOTUP_REPOSITORY_ROOT;
  }
});

test('multi-brain start disables per-brain health ports for each project daemon', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--all', '--no-transcripts', '--yes']);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStartCalls).toHaveLength(2);
    expect(agentStartCalls.map((c) => c.name)).toEqual([
      'agentbootup-brain-alpha',
      'agentbootup-brain-beta',
    ]);
    for (const call of agentStartCalls) {
      expect(call.port).toBeUndefined();
      expect(call.env?.AGENTBOOTUP_DISABLE_HEALTH_SERVER).toBe('1');
    }
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('transcript-only start in multi-brain mode does not require a global brain id', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({
    dataTransmissionAcknowledged: true,
  }));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain', '--yes']);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStartCalls).toHaveLength(1);
    expect(agentStartCalls[0].name).toBe('agentbootup-transcripts');
    expect(agentStartCalls[0].env).toBeUndefined();
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('transcript-only start scopes to one project in multi-brain mode', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({
    dataTransmissionAcknowledged: true,
  }));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-transcript-scope-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    const { exitCode, errs, logs } = await runCommand(['daemon', 'start', '--no-brain', 'alpha', '--yes']);
    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(logs.join('\n')).toContain('for project(s): alpha');
    expect(agentStartCalls).toHaveLength(1);
    expect(agentStartCalls[0].name).toBe('agentbootup-transcripts');
    expect(agentStartCalls[0].env?.AGENTBOOTUP_TRANSCRIPT_PROJECT_IDS).toBe('alpha');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('transcript-only start accepts agent_id as scoped selector', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({
    dataTransmissionAcknowledged: true,
  }));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-transcript-scope-agent-id-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain', 'alpha.gm', '--yes']);
    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStartCalls).toHaveLength(1);
    expect(agentStartCalls[0].env?.AGENTBOOTUP_TRANSCRIPT_PROJECT_IDS).toBe('alpha');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('transcript-only start scopes to multiple projects in multi-brain mode', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({
    dataTransmissionAcknowledged: true,
  }));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-transcript-scope-many-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
        { id: 'gamma', agent_id: 'gamma.gm', path: '/tmp/gamma' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain', 'alpha', 'gamma', '--yes']);
    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStartCalls).toHaveLength(1);
    expect(agentStartCalls[0].env?.AGENTBOOTUP_TRANSCRIPT_PROJECT_IDS).toBe('alpha,gamma');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('transcript-only start ignores repeated --skills-mode values when parsing scoped ids', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({
    dataTransmissionAcknowledged: true,
  }));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-transcript-scope-skills-mode-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand([
      'daemon',
      'start',
      '--no-brain',
      '--skills-mode',
      'static',
      'alpha',
      '--skills-mode',
      'mech-storage',
      '--yes',
    ]);
    expect(exitCode).toBeNull();
    expect(errs.join('\n')).not.toContain('Cannot combine');
    expect(agentStartCalls).toHaveLength(1);
    expect(agentStartCalls[0].env?.AGENTBOOTUP_TRANSCRIPT_PROJECT_IDS).toBe('alpha');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('combined brain and transcript start scopes transcript daemon to selected projects', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-transcript-scope-combined-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', 'alpha', '--yes']);
    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain-alpha')).toBe(true);
    const transcriptStart = agentStartCalls.find((call) => call.name === 'agentbootup-transcripts');
    expect(transcriptStart?.env?.AGENTBOOTUP_TRANSCRIPT_PROJECT_IDS).toBe('alpha');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon start rejects --all combined with explicit project IDs', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const { exitCode, errs } = await runCommand(['daemon', 'start', '--all', 'alpha', '--yes']);
  expect(exitCode).toBe(1);
  expect(errs.join('\n')).toContain('Cannot combine --all with explicit project IDs');
});

test('daemon start rejects project-scoped transcript mode outside network root', async () => {
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({
    brainId: 'b1',
    dataTransmissionAcknowledged: true,
  }));

  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain', 'alpha', '--yes']);
  expect(exitCode).toBe(1);
  expect(errs.join('\n')).toContain('Project-scoped daemon start requires a network root');
});

test('single-brain start retries transient launchd bootstrap failures', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  let attempts = 0;
  agentStartImpl = async (config: Record<string, any>) => {
    agentStartCalls.push(config);
    attempts += 1;
    if (attempts === 1) {
      throw new Error('Bootstrap failed: 5: Input/output error');
    }
    return { name: config.name, pid: 5432, port: config.port, platform: 'launchd' };
  };

  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--yes']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  expect(agentStartCalls).toHaveLength(2);
});

test('start summary reports retry and recovery counts', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  let attempts = 0;
  let statusChecks = 0;
  agentStartImpl = async (config: Record<string, any>) => {
    agentStartCalls.push(config);
    attempts += 1;
    throw new Error('Bootstrap failed: 5: Input/output error');
  };
  agentStatusImpl = async (name: string) => {
    statusChecks += 1;
    if (name === 'agentbootup-transcripts' && statusChecks >= 2) {
      return { name, state: 'online', pid: 9999, port: 8766, platform: 'launchd' };
    }
    return { name, state: 'unknown', platform: 'launchd' };
  };

  const { exitCode, logs, errs } = await runCommand(['daemon', 'start', '--no-brain', '--yes']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  expect(attempts).toBe(2);
  const output = logs.join('\n');
  expect(output).toContain('Start summary:');
  expect(output).toContain('Started: 1');
  expect(output).toContain('Already running: 0');
  expect(output).toContain('Failed: 0');
  expect(output).toContain('Retried (transient launchd):');
  expect(output).toContain('transcripts');
  expect(output).toContain('Recovered after transient start failure:');
});

test('start summary reports partial failures in multi-brain mode', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-summary-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    agentStartImpl = async (config: Record<string, any>) => {
      agentStartCalls.push(config);
      if (config.name === 'agentbootup-brain-beta') {
        throw new Error('boom');
      }
      return { name: config.name, pid: 4321, port: config.port, platform: 'launchd' };
    };

    const { exitCode, logs, errs } = await runCommand(['daemon', 'start', '--all', '--no-transcripts', '--yes']);

    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toContain('beta.gm failed');
    const output = logs.join('\n');
    expect(output).toContain('Start summary:');
    expect(output).toContain('Started: 1');
    expect(output).toContain('Already running: 0');
    expect(output).toContain('Failed: 1');
    expect(output).toContain('Failed services: beta.gm');
    expect(errs.join('\n')).toContain('daemon verify');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon start reapplies transcript scope by restarting an existing daemon', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  let transcriptRunning = true;
  agentStatusImpl = async (name: string) => {
    if (name === 'agentbootup-transcripts' && transcriptRunning) {
      return { name, state: 'online', pid: 7777, port: 8766, platform: 'launchd' };
    }
    return { name, state: 'unknown', platform: 'launchd' };
  };
  agentStopImpl = async (name: string) => {
    agentStopCalls.push(name);
    if (name === 'agentbootup-transcripts') transcriptRunning = false;
  };

  const { exitCode, logs, errs } = await runCommand(['daemon', 'start', '--no-brain', '--yes']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  expect(agentStopCalls).toContain('agentbootup-transcripts');
  expect(agentStartCalls).toHaveLength(1);
  const output = logs.join('\n');
  expect(output).toContain('Transcript sync daemon started (PID 4321)');
  expect(output).toContain('Restarted: 1');
});

test('daemon start --json emits per-service structured outcomes', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-start-json-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    let transcriptRunning = true;
    agentStatusImpl = async (name: string) => {
      if (name === 'agentbootup-transcripts' && transcriptRunning) {
        return { name, state: 'online', pid: 3333, port: 8766, platform: 'launchd' };
      }
      return { name, state: 'unknown', platform: 'launchd' };
    };
    agentStopImpl = async (name: string) => {
      agentStopCalls.push(name);
      if (name === 'agentbootup-transcripts') transcriptRunning = false;
    };
    agentStartImpl = async (config: Record<string, any>) => {
      agentStartCalls.push(config);
      if (config.name === 'agentbootup-brain-beta') {
        throw new Error('boom');
      }
      return { name: config.name, pid: 4321, port: config.port, platform: 'launchd' };
    };

    const { exitCode, logs } = await runCommand(['daemon', 'start', '--all', '--yes', '--json']);

    expect(exitCode).toBe(1);
    const payload = JSON.parse(logs.join('\n'));
    expect(payload.summary.started).toBeGreaterThanOrEqual(1);
    expect(payload.summary.restarted).toBe(1);
    expect(payload.summary.failed).toBe(1);
    expect(payload.summary.exitCode).toBe(1);
    expect(payload.services.some((service: any) => service.label === 'transcripts' && service.status === 'restarted')).toBe(true);
    expect(payload.services.some((service: any) => service.label === 'beta.gm' && service.status === 'failed' && service.error === 'boom')).toBe(true);
    expect(payload.diagnostics).toContain('agentbootup daemon status');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon start --json preserves retry attempts for failed services', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  let attempts = 0;
  agentStartImpl = async (config: Record<string, any>) => {
    agentStartCalls.push(config);
    attempts += 1;
    throw new Error('Bootstrap failed: 5: Input/output error');
  };
  agentStatusImpl = async () => ({ state: 'unknown', platform: 'launchd' } as any);

  const { exitCode, logs } = await runCommand(['daemon', 'start', '--no-brain', '--yes', '--json']);

  expect(exitCode).toBe(1);
  expect(attempts).toBe(2);
  const payload = JSON.parse(logs.join('\n'));
  expect(payload.summary.failed).toBe(1);
  expect(payload.services).toHaveLength(1);
  expect(payload.services[0].status).toBe('failed');
  expect(payload.services[0].attempts).toBe(2);
});

test('transcript start reconciles success if launchd reports online after transient failure', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  let statusChecks = 0;
  agentStartImpl = async (config: Record<string, any>) => {
    agentStartCalls.push(config);
    throw new Error('Bootstrap failed: 5: Input/output error');
  };
  agentStatusImpl = async (name: string) => {
    statusChecks += 1;
    // First status probe must stay unknown so startAgentWithRetry is exercised.
    // The second probe returns online to simulate launchd eventually reporting success.
    if (name === 'agentbootup-transcripts' && statusChecks >= 2) {
      return { name, state: 'online', pid: 9999, port: 8766, platform: 'launchd' };
    }
    return { name, state: 'unknown', platform: 'launchd' };
  };

  const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain', '--yes']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  expect(agentStartCalls).toHaveLength(2);
});

test('transcript start rotates oversized managed launchd logs before agentStart', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  const { setUnifiedDaemonRuntimeForTests } = await import('../../lib/daemon/unified-daemon-cli.js');
  setUnifiedDaemonRuntimeForTests({
    detectLogPlatform: () => 'launchd',
  });

  const logDir = await fsp.mkdtemp(path.join(tmpDir, 'launchd-log-rotation-'));
  const originalLogDir = process.env.AGENTBOOTUP_DAEMON_LOG_DIR;
  const originalMaxBytes = process.env.AGENTBOOTUP_DAEMON_LOG_MAX_BYTES;
  const originalGenerations = process.env.AGENTBOOTUP_DAEMON_LOG_GENERATIONS;
  process.env.AGENTBOOTUP_DAEMON_LOG_DIR = logDir;
  process.env.AGENTBOOTUP_DAEMON_LOG_MAX_BYTES = '5';
  process.env.AGENTBOOTUP_DAEMON_LOG_GENERATIONS = '2';

  const outPath = path.join(logDir, 'agentbootup-transcripts.out.log');
  await fsp.writeFile(outPath, '0123456789', 'utf8');
  await fsp.writeFile(`${outPath}.1`, 'older', 'utf8');

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-brain', '--yes']);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStartCalls).toHaveLength(1);
    expect(agentStartCalls[0].logDir).toBe(logDir);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(await fsp.readFile(`${outPath}.1`, 'utf8')).toBe('0123456789');
    expect(await fsp.readFile(`${outPath}.2`, 'utf8')).toBe('older');
  } finally {
    if (originalLogDir === undefined) delete process.env.AGENTBOOTUP_DAEMON_LOG_DIR;
    else process.env.AGENTBOOTUP_DAEMON_LOG_DIR = originalLogDir;
    if (originalMaxBytes === undefined) delete process.env.AGENTBOOTUP_DAEMON_LOG_MAX_BYTES;
    else process.env.AGENTBOOTUP_DAEMON_LOG_MAX_BYTES = originalMaxBytes;
    if (originalGenerations === undefined) delete process.env.AGENTBOOTUP_DAEMON_LOG_GENERATIONS;
    else process.env.AGENTBOOTUP_DAEMON_LOG_GENERATIONS = originalGenerations;
    await fsp.rm(logDir, { recursive: true, force: true });
  }
});

test('daemon restart rejects --json explicitly', async () => {
  const { exitCode, errs } = await runCommand(['daemon', 'restart', '--json']);

  expect(exitCode).toBe(1);
  expect(errs.join('\n')).toContain('--json is not supported by daemon restart');
});

test('daemon verify --json reports transcript and brain cloud presence', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  let callCount = 0;
  fetchImpl = async (url: string) => {
    callCount += 1;
    if (url.includes('/v1/sync/transcripts/pull')) {
      return new Response(JSON.stringify({ data: { transcripts: [{ id: 't1' }, { id: 't2' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: { files: [{ path: 'a', hash: 'h', size: 1 }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { exitCode, logs, errs } = await runCommand(['daemon', 'verify', '--json']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  const payload = JSON.parse(logs.join('\n'));
  expect(payload.transcripts.state).toBe('inventory_present_unverified');
  expect(payload.transcripts.archiveAuthority).toBe(false);
  expect(payload.transcripts.count).toBe(2);
  expect(payload.brain.state).toBe('present');
  expect(payload.brain.count).toBe(1);
  expect(callCount).toBe(2);
});

test('daemon verify human output preserves present brain state', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  fetchImpl = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return new Response(JSON.stringify({ data: { transcripts: [{ id: 't1' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: { files: [{ path: 'a', hash: 'h', size: 1 }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { exitCode, logs, errs } = await runCommand(['daemon', 'verify']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  const output = logs.join('\n');
  expect(output).toContain('[Brain]');
  expect(output).toContain('Cloud state: present');
  expect(output).not.toContain('Cloud state: error');
});

test('daemon verify transcripts falls back to configured brain id outside network mode', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  fetchImpl = async (url: string) => {
    expect(url).toContain('brain_id=test-brain');
    return new Response(JSON.stringify({ data: { files: [{ cli: 'claude', relative_path: 'session-1.jsonl' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { exitCode, logs, errs } = await runCommand(['daemon', 'verify', 'transcripts', '--json']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  const payload = JSON.parse(logs.join('\n'));
  expect(payload.transcripts.brainId).toBe('test-brain');
  expect(payload.transcripts.state).toBe('inventory_present_unverified');
  expect(payload.transcripts.count).toBe(1);
});

test('daemon verify transcripts rejects project filters outside network mode', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const { exitCode, errs } = await runCommand(['daemon', 'verify', 'transcripts', 'alpha']);

  expect(exitCode).toBe(2);
  expect(errs.join('\n')).toContain('Project filters require a network config: alpha');
  expect(fetchCalls).toHaveLength(0);
});

test('daemon verify exits 1 when remote brain inventory is empty', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  fetchImpl = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return new Response(JSON.stringify({ data: { files: [{ cli: 'claude', relative_path: 'session-1.jsonl' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: { files: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { exitCode, logs } = await runCommand(['daemon', 'verify']);

  expect(exitCode).toBe(1);
  expect(logs.join('\n')).toContain('Cloud state: empty');
});

test('daemon verify checks all network brains by default', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-verify-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    fetchImpl = async (url: string) => {
      if (url.includes('alpha.gm') || url.includes('beta.gm')) {
        return new Response(JSON.stringify({ data: { files: [{ path: 'a', hash: 'h', size: 1 }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: { transcripts: [{ id: 't1' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { exitCode, logs } = await runCommand(['daemon', 'verify', 'brain']);

    expect(exitCode).toBeNull();
    expect(logs.join('\n')).toContain('[Brain: alpha.gm]');
    expect(logs.join('\n')).toContain('[Brain: beta.gm]');
    expect(fetchCalls.filter((call) => call.url.includes('/v1/brain-assets/'))).toHaveLength(2);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon verify brain reports memory freshness alongside asset state', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-verify-memory-'));
  const projectRoot = await fsp.mkdtemp(path.join(tmpDir, 'project-verify-memory-'));
  const headsDir = path.join(projectRoot, 'store', 'alpha.gm', 'heads');
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  process.env.AGENTBOOTUP_MEMORY_STORE = `file://${path.join(projectRoot, 'store')}`;

  await fsp.mkdir(path.join(projectRoot, 'brain'), { recursive: true });
  await fsp.mkdir(headsDir, { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'agentbootup.json'), JSON.stringify({ agent_id: 'alpha.gm' }));
  const nowMs = Date.now();
  await fsp.writeFile(
    path.join(headsDir, 'fresh-head.json'),
    JSON.stringify({ updated_at: new Date(nowMs - (60 * 60 * 1000)).toISOString() }, null, 2),
  );
  await fsp.writeFile(
    path.join(headsDir, 'stale-head.json'),
    JSON.stringify({ updated_at: new Date(nowMs - (5 * 24 * 60 * 60 * 1000)).toISOString() }, null, 2),
  );
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: projectRoot },
      ],
    }),
  );

  try {
    fetchImpl = async (url: string) => {
      if (url.includes('/v1/brain-assets/alpha.gm/hashes')) {
        return new Response(JSON.stringify({ data: { files: [{ path: 'a', hash: 'h', size: 1 }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const { exitCode, logs } = await runCommand(['daemon', 'verify', 'brain']);

    expect(exitCode).toBe(1);
    expect(logs.join('\n')).toContain('Memory freshness: stale');
    expect(logs.join('\n')).toContain('Memory reason: publisher known but stale while a sibling head is fresh');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    delete process.env.AGENTBOOTUP_MEMORY_STORE;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    await fsp.rm(projectRoot, { recursive: true, force: true });
  }
});

test('daemon verify brain fails when memory freshness clock skew exceeds five minutes', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-verify-memory-skew-'));
  const projectRoot = await fsp.mkdtemp(path.join(tmpDir, 'project-verify-memory-skew-'));
  const headsDir = path.join(projectRoot, 'store', 'alpha.gm', 'heads');
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  process.env.AGENTBOOTUP_MEMORY_STORE = `file://${path.join(projectRoot, 'store')}`;

  await fsp.mkdir(path.join(projectRoot, 'brain'), { recursive: true });
  await fsp.mkdir(headsDir, { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'agentbootup.json'), JSON.stringify({ agent_id: 'alpha.gm' }));
  const updatedAtMs = Date.now() - (60 * 60 * 1000);
  await fsp.writeFile(
    path.join(headsDir, 'fresh-head.json'),
    JSON.stringify({ updated_at: new Date(updatedAtMs).toISOString() }, null, 2),
  );
  await fsp.utimes(path.join(headsDir, 'fresh-head.json'), new Date(updatedAtMs + (6 * 60 * 1000)), new Date(updatedAtMs + (6 * 60 * 1000)));
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: projectRoot },
      ],
    }),
  );

  try {
    fetchImpl = async (url: string) => {
      if (url.includes('/v1/brain-assets/alpha.gm/hashes')) {
        return new Response(JSON.stringify({ data: { files: [{ path: 'a', hash: 'h', size: 1 }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const { exitCode, logs } = await runCommand(['daemon', 'verify', 'brain']);

    expect(exitCode).toBe(1);
    expect(logs.join('\n')).toContain('Memory freshness: stale');
    expect(logs.join('\n')).toContain('Memory reason: publisher head clock skew exceeds 5m');
    expect(logs.join('\n')).toContain('Memory clock skew: degraded');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    delete process.env.AGENTBOOTUP_MEMORY_STORE;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    await fsp.rm(projectRoot, { recursive: true, force: true });
  }
});

test('daemon verify transcripts checks all network brains by default', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-transcript-verify-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    fetchImpl = async (url: string) => {
      if (url.includes('alpha.gm')) {
        return new Response(JSON.stringify({ data: { files: [{ cli: 'claude', relative_path: 'a1.jsonl' }, { cli: 'codex', relative_path: 'a2.jsonl' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: { files: [{ cli: 'gemini', relative_path: 'b1.json' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { exitCode, logs, errs } = await runCommand(['daemon', 'verify', 'transcripts', '--json']);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    const payload = JSON.parse(logs.join('\n'));
    expect(payload.alpha.brainId).toBe('alpha.gm');
    expect(payload.alpha.state).toBe('inventory_present_unverified');
    expect(payload.alpha.count).toBe(2);
    expect(payload.beta.brainId).toBe('beta.gm');
    expect(payload.beta.state).toBe('inventory_present_unverified');
    expect(payload.beta.count).toBe(1);
    const transcriptPullUrls = fetchCalls
      .filter((call) => call.url.includes('/v1/sync/transcripts/pull'))
      .map((call) => call.url);
    expect(transcriptPullUrls).toHaveLength(2);
    expect(transcriptPullUrls.some((url) => url.includes('brain_id=alpha.gm'))).toBe(true);
    expect(transcriptPullUrls.some((url) => url.includes('brain_id=beta.gm'))).toBe(true);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon verify transcripts supports explicit project filters', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-transcript-filter-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    fetchImpl = async () => new Response(JSON.stringify({ data: { files: [{ cli: 'claude', relative_path: 'a1.jsonl' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const { exitCode, logs, errs } = await runCommand(['daemon', 'verify', 'transcripts', 'alpha', '--json']);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    const payload = JSON.parse(logs.join('\n'));
    expect(Object.keys(payload)).toEqual(['alpha']);
    expect(payload.alpha.brainId).toBe('alpha.gm');
    expect(fetchCalls.filter((call) => call.url.includes('alpha.gm'))).toHaveLength(1);
    expect(fetchCalls.filter((call) => call.url.includes('beta.gm'))).toHaveLength(0);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon verify transcripts rejects unknown project filters', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-transcript-unknown-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'verify', 'transcripts', 'missing']);

    expect(exitCode).toBe(2);
    expect(errs.join('\n')).toContain('No matching projects found for: missing');
    expect(fetchCalls).toHaveLength(0);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon verify rejects ambiguous shorthand project filters without explicit target', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-verify-ambiguous-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'verify', 'alpha']);

    expect(exitCode).toBe(2);
    expect(errs.join('\n')).toContain('Ambiguous verify target: alpha');
    expect(fetchCalls).toHaveLength(0);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon verify --json nests transcript and brain results by project in multi-brain mode', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-verify-all-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    fetchImpl = async (url: string) => {
      if (url.includes('/v1/sync/transcripts/pull')) {
        return new Response(JSON.stringify({ data: { files: [{ cli: 'claude', relative_path: 't1.jsonl' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: { files: [{ path: 'a', hash: 'h', size: 1 }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { exitCode, logs, errs } = await runCommand(['daemon', 'verify', '--json']);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    const payload = JSON.parse(logs.join('\n'));
    expect(payload.transcripts.alpha.brainId).toBe('alpha.gm');
    expect(payload.transcripts.beta.brainId).toBe('beta.gm');
    expect(payload.brain.alpha.brainId).toBe('alpha.gm');
    expect(payload.brain.beta.brainId).toBe('beta.gm');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon verify transcripts accepts legacy transcript arrays for compatibility', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  fetchImpl = async (url: string) => {
    expect(url).toContain('brain_id=test-brain');
    return new Response(JSON.stringify({ data: { transcripts: [{ id: 'legacy-1' }, { id: 'legacy-2' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { exitCode, logs, errs } = await runCommand(['daemon', 'verify', 'transcripts', '--json']);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  const payload = JSON.parse(logs.join('\n'));
  expect(payload.transcripts.brainId).toBe('test-brain');
  expect(payload.transcripts.state).toBe('inventory_present_unverified');
  expect(payload.transcripts.count).toBe(2);
});

test('daemon status suggests daemon verify for cloud confirmation', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: 1234, port: name.includes('transcript') ? 8766 : undefined, platform: 'launchd' });

  const { exitCode, logs } = await runCommand(['daemon', 'status']);

  expect(exitCode).toBeNull();
  const output = logs.join('\n');
  expect(output).toContain('State: online');
  expect(output).toContain('agentbootup daemon verify');
});

test('daemon status --json does not print human-only verify note', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: 1234, port: name.includes('transcript') ? 8766 : undefined, platform: 'launchd' });

  const { exitCode, logs } = await runCommand(['daemon', 'status', '--json']);

  expect(exitCode).toBeNull();
  const output = logs.join('\n');
  expect(output).not.toContain('Note: State above is process health only');
  expect(JSON.parse(output)).toBeDefined();
});

test('daemon status --json includes durable completion evidence for active transcripts', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: 1234, port: 8766, platform: 'launchd' });
  fetchImpl = async (url: string) => {
    if (url === 'http://127.0.0.1:8766/status') {
      return new Response(JSON.stringify({
        lastCompletedAt: '2026-07-24T00:00:00.000Z', pushes: 7, errors: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: { files: [] } }), { status: 200 });
  };

  const { exitCode, logs } = await runCommand(['daemon', 'status', '--json']);

  expect(exitCode).toBeNull();
  expect(JSON.parse(logs.join('\n')).transcripts.completion).toEqual({
    lastCompletedAt: '2026-07-24T00:00:00.000Z', lastPushed: 7, lastErrors: 1,
  });
});

test('daemon status exposes effective converge, gate, and freshness state', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: process.pid, platform: 'launchd' });
  const {
    _setConvergeHealthProvider,
    recordBrainSyncHealth,
  } = await import('../../lib/daemon/brain-asset-sync.mjs');
  _setConvergeHealthProvider(() => ({
    state: 'store_deferred',
    detail: 'raw=SENTINEL_UNIFIED_DETAIL',
    failure: {
      schema: 'memory-convergence-failure/v1',
      phase: 'refresh',
      category: 'authorization',
      exit_code: 7,
    },
    enabled: true,
    configSource: 'default',
    store: 'server://test-brain',
    gateOpen: false,
    lastCycleAt: '2026-07-24T00:00:00.000Z',
    freshnessState: 'stale',
    freshnessCheckedAt: '2026-07-24T00:00:00.000Z',
    freshnessHeadCount: 2,
    escalated: false,
  }));
  recordBrainSyncHealth('test-brain', 0, 0);

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'status', '--json']);
    expect(exitCode).toBeNull();
    const payload = JSON.parse(logs.join('\n'));
    expect(payload.brain.completion.memoryConverge).toMatchObject({
      state: 'store_deferred',
      enabled: true,
      configSource: 'default',
      gateOpen: false,
      lastCycleAt: '2026-07-24T00:00:00.000Z',
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'refresh',
        category: 'authorization',
        exit_code: 7,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('SENTINEL_UNIFIED_DETAIL');
    const text = await runCommand(['daemon', 'status']);
    expect(text.logs.join('\n')).toContain('Last converge cycle: 2026-07-24T00:00:00.000Z');
    expect(text.logs.join('\n')).toContain('Fleet/head freshness: stale');
    expect(text.logs.join('\n')).toContain(
      'Memory detail: refresh authorization failure (exit 7); restore shared-store authorization and retry',
    );
    expect(text.logs.join('\n')).not.toContain('SENTINEL_UNIFIED_DETAIL');
    expect(text.logs.join('\n')).not.toContain('Memory freshness: 2026-07-24T00:00:00.000Z');
  } finally {
    _setConvergeHealthProvider(() => null);
  }
});

test('daemon status human and JSON preserve canonical converge fields under inherited hooks', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: process.pid, platform: 'launchd' });
  const {
    _setConvergeHealthProvider,
    recordBrainSyncHealth,
  } = await import('../../lib/daemon/brain-asset-sync.mjs');
  _setConvergeHealthProvider(() => ({
    state: 'publish_blocked',
    detail: 'raw=SENTINEL_UNIFIED_DETAIL',
    failure: {
      schema: 'memory-convergence-failure/v1',
      phase: 'publish',
      category: 'authorization',
      exit_code: 7,
    },
    enabled: true,
    configSource: 'default',
    store: 'server://test-brain',
    gateOpen: false,
    lastCycleAt: '2026-08-12T00:00:00.000Z',
    freshnessState: 'stale',
    freshnessCheckedAt: '2026-08-12T00:00:00.000Z',
    freshnessHeadCount: 2,
    escalated: false,
  }));
  recordBrainSyncHealth('test-brain', 0, 0);

  const objectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const arrayMap = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
  let jsonLogs: string[] = [];
  let humanLogs: string[] = [];
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => ({ leaked: 'SENTINEL_OBJECT_TO_JSON' }),
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => ['SENTINEL_ARRAY_TO_JSON'],
    });
    Object.defineProperty(Array.prototype, 'map', {
      configurable: true,
      writable: true,
      value: () => ['SENTINEL_ARRAY_MAP'],
    });
    jsonLogs = (await runCommand(['daemon', 'status', '--json'])).logs;
    humanLogs = (await runCommand(['daemon', 'status'])).logs;
  } finally {
    if (objectToJSON) Object.defineProperty(Object.prototype, 'toJSON', objectToJSON);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    if (arrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', arrayToJSON);
    else delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
    if (arrayMap) Object.defineProperty(Array.prototype, 'map', arrayMap);
    else delete Array.prototype.map;
    _setConvergeHealthProvider(() => null);
  }

  const jsonWire = jsonLogs.join('\n');
  expect(JSON.parse(jsonWire).brain.completion.memoryConverge.failure).toEqual({
    schema: 'memory-convergence-failure/v1',
    phase: 'publish',
    category: 'authorization',
    exit_code: 7,
  });
  const humanWire = humanLogs.join('\n');
  expect(humanWire).toContain('Memory converge: publish_blocked');
  expect(humanWire).toContain(
    'Memory detail: publish authorization failure (exit 7); restore shared-store authorization and retry',
  );
  expect(`${jsonWire}\n${humanWire}`).not.toContain('SENTINEL');
});

test('daemon status renders partial legacy converge fields as unknown, never off or closed', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: process.pid, platform: 'launchd' });
  const {
    _setConvergeHealthProvider,
    recordBrainSyncHealth,
  } = await import('../../lib/daemon/brain-asset-sync.mjs');
  _setConvergeHealthProvider(() => ({
    state: 'ok',
    lastCycleAt: '2026-07-24T00:00:00.000Z',
  }));
  recordBrainSyncHealth('test-brain', 0, 0);

  try {
    const { logs } = await runCommand(['daemon', 'status']);
    expect(logs.join('\n')).toContain('effective=unknown');
    expect(logs.join('\n')).toContain('gate=unknown');
    expect(logs.join('\n')).not.toContain('effective=off');
  } finally {
    _setConvergeHealthProvider(() => null);
  }
});

test('daemon status uses agent_id, not project id, for brain DB completion evidence', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'network-db-status-'));
  const projectRoot = path.join(networkRoot, 'project');
  const projectId = 'project-slug';
  const brainId = 'brain-identity.gm';
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.mkdir(path.join(projectRoot, '.brain'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, '.brain', 'brain.db'), '');
  await fsp.writeFile(path.join(projectRoot, '.env'), 'BRAIN_DB_URL=https://db.example.test\nBRAIN_DB_TOKEN=test-token\n');
  await fsp.writeFile(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: 'network', projects: [{ id: projectId, agent_id: brainId, path: projectRoot }],
  }));
  const { recordBrainDbSyncHealth, getBrainDbSyncHealthPath } = await import('../../lib/daemon/brain-db-health.js');
  recordBrainDbSyncHealth(brainId, { now: '2026-07-24T00:00:00.000Z', pid: process.pid });
  agentStatusImpl = async (name: string) => ({ name, state: 'online', pid: process.pid, platform: 'launchd' });

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'status', '--json']);
    expect(exitCode).toBeNull();
    expect(JSON.parse(logs.join('\n'))[`brain-db-${projectId}`].completion).toMatchObject({
      lastCompletedAt: '2026-07-24T00:00:00.000Z',
    });
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(getBrainDbSyncHealthPath(brainId), { force: true });
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon start all failed prints diagnostics to stderr and exits 1', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  agentStartImpl = async () => {
    throw new Error('launchd failed');
  };

  const { exitCode, errs } = await runCommand(['daemon', 'start', '--yes']);

  expect(exitCode).toBe(1);
  const stderr = errs.join('\n');
  expect(stderr).toContain('daemon verify');
  expect(stderr).toContain('daemon status');
  expect(stderr).toContain('daemon logs');
});

// ── validateCredentials export ────────────────────────────────────────────────

test('validateCredentials is exported', async () => {
  const mod = await import('../../lib/daemon/unified-daemon-cli.js');
  expect(typeof mod.validateCredentials).toBe('function');
  expect(typeof mod.checkTranscriptConsent).toBe('function');
  expect(typeof mod.checkBrainConsent).toBe('function');
});

test('validateCredentials reports undecryptable credentials explicitly', async () => {
  await fsp.writeFile(credFile, Buffer.from('not-valid-credentials'));
  const mod = await import('../../lib/daemon/unified-daemon-cli.js');

  const cap = captureOutput();
  const origExit = process.exit;
  let exitCode: number | null = null;
  // @ts-ignore
  process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`process.exit(${code})`); };

  try {
    await expect(mod.validateCredentials()).rejects.toThrow('process.exit(1)');
  } finally {
    process.exit = origExit;
    cap.restore();
  }

  expect(exitCode).toBe(1);
  expect(cap.errs.join('\n')).toContain('cannot be decrypted on this host');
});

test('validateCredentials reports credential read failures explicitly', async () => {
  await fsp.rm(credFile, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(credFile, { recursive: true });
  const mod = await import('../../lib/daemon/unified-daemon-cli.js');

  const cap = captureOutput();
  const origExit = process.exit;
  let exitCode: number | null = null;
  // @ts-ignore
  process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`process.exit(${code})`); };

  try {
    await expect(mod.validateCredentials()).rejects.toThrow('process.exit(1)');
  } finally {
    process.exit = origExit;
    cap.restore();
    await fsp.rm(credFile, { recursive: true, force: true }).catch(() => {});
  }

  expect(exitCode).toBe(1);
  expect(cap.errs.join('\n')).toContain('could not be read on this host');
});

// ── Claude binary detection warning ───────────────────────────────────────────

test('start does not warn about claude CLI when binary exists at known path', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  // Patch fs.existsSync to simulate claude binary present at ~/.claude/local/bin/claude
  const origExistsSync = fs.existsSync;
  const homeDir = os.homedir();
  const claudeBinPath = path.join(homeDir, '.claude', 'local', 'bin', 'claude');
  fs.existsSync = (p: fs.PathLike) => {
    if (String(p) === claudeBinPath) return true;
    return origExistsSync(p);
  };
  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--yes']);
    expect(errs.join('\n')).not.toContain('[warning] claude CLI not found');
    // Start still proceeds (agentStart was called)
    expect(agentStartCalls.length).toBeGreaterThan(0);
  } finally {
    fs.existsSync = origExistsSync;
  }
});

test('start warns about missing claude CLI when not found anywhere', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  // Patch fs.existsSync to simulate claude binary absent everywhere
  const origExistsSync = fs.existsSync;
  const homeDir = os.homedir();
  fs.existsSync = (p: fs.PathLike) => {
    const s = String(p);
    if (s.endsWith('/claude') &&
        (s.includes('/.claude/') || s.includes('/.local/bin') || s.includes('/.bun/bin'))) {
      return false;
    }
    return origExistsSync(p);
  };
  // Also ensure PATH does not contain claude
  const origPath = process.env.PATH;
  process.env.PATH = '/nonexistent-dir';
  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--yes']);
    expect(errs.join('\n')).toContain('[warning] claude CLI not found');
    // Start still proceeds despite missing claude binary
    expect(agentStartCalls.length).toBeGreaterThan(0);
  } finally {
    fs.existsSync = origExistsSync;
    process.env.PATH = origPath;
  }
});

test('start proceeds (agentStart called) even when claude binary is not found', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const origExistsSync = fs.existsSync;
  const homeDir = os.homedir();
  fs.existsSync = (p: fs.PathLike) => {
    const s = String(p);
    if (s.endsWith('/claude') &&
        (s.includes('/.claude/') || s.includes('/.local/bin') || s.includes('/.bun/bin'))) {
      return false;
    }
    return origExistsSync(p);
  };
  const origPath = process.env.PATH;
  process.env.PATH = '/nonexistent-dir';
  try {
    const { exitCode, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--yes']);
    // agentStart must still have been called (non-fatal warning)
    expect(agentStartCalls.length).toBeGreaterThan(0);
    expect(exitCode).toBeNull();
  } finally {
    fs.existsSync = origExistsSync;
    process.env.PATH = origPath;
  }
});

// ── handleLogs argument parsing ───────────────────────────────────────────────

test('handleLogs: --lines flag before target name does not drop the target', async () => {
  // Regression: for-of loop broke on '--lines' token, dropping any target that followed.
  // Passing ['daemon', 'logs', '--lines', '20', 'brain'] must resolve target=brain.
  // We can't run agentLogs in test env, but we can verify the command doesn't exit 1
  // due to unknown target (which would print "Usage:" to stderr).
  const { exitCode, errs } = await runCommand(['daemon', 'logs', '--lines', '20', 'brain']);
  // If the target was parsed correctly it reaches agentLogs (which may throw "not found"
  // in the test env) — critically, it must NOT exit with a Usage error.
  const errText = errs.join(' ');
  expect(errText).not.toContain('Usage:');
});

// ── Consent helper tests ──────────────────────────────────────────────────────

test('checkTranscriptConsent exits 1 when not acknowledged and no --yes', async () => {
  const { checkTranscriptConsent } = await import('../../lib/daemon/unified-daemon-cli.js');
  const cap = captureOutput();
  let exitCode: number | null = null;
  const origExit = process.exit;
  // @ts-ignore
  process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`exit`); };
  // Write config without acknowledgement
  await fsp.writeFile(configFile, JSON.stringify({}));
  try {
    await checkTranscriptConsent({ serverUrl: 'https://x.com' }, false);
  } catch { /* expected */ } finally {
    process.exit = origExit;
    cap.restore();
  }
  expect(exitCode).toBe(1);
  expect(cap.errs.join(' ')).toContain('IMPORTANT');
});

test('checkBrainConsent exits 1 when not acknowledged and no --yes', async () => {
  const { checkBrainConsent } = await import('../../lib/daemon/unified-daemon-cli.js');
  const cap = captureOutput();
  let exitCode: number | null = null;
  const origExit = process.exit;
  // @ts-ignore
  process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`exit`); };
  await fsp.writeFile(configFile, JSON.stringify({}));
  try {
    await checkBrainConsent({ serverUrl: 'https://x.com' }, false);
  } catch { /* expected */ } finally {
    process.exit = origExit;
    cap.restore();
  }
  expect(exitCode).toBe(1);
  expect(cap.errs.join(' ')).toContain('IMPORTANT');
});

// ── index-transcripts integration in daemon start ─────────────────────────────

test('--no-index-transcripts is treated as a named flag, not a project ID', async () => {
  // If the flag were parsed as a positional project filter, handleStart would
  // emit "No matching projects found for: --no-index-transcripts" and exit 1.
  // This test verifies both the flag-parsing (no error) and the UX log (skipped).
  await writeCredentials();
  await writeConsentedConfig();
  const { exitCode, logs, errs } = await runCommand([
    'daemon', 'start', '--no-transcripts', '--no-index-transcripts',
  ]);
  const allOutput = [...logs, ...errs].join(' ');
  // Must NOT produce a "No matching projects" error for the flag string.
  expect(allOutput).not.toMatch(/No matching projects found/);
  // Daemon start should succeed (no exit 1).
  expect(exitCode).not.toBe(1);
  // Skip log must appear so the operator knows indexing was opted out.
  expect(logs.join(' ')).toContain('[index-transcripts] skipped (--no-index-transcripts)');
});

// Helper to set up a temp provisioned project + network config for indexing tests.
// Returns { projectDir, netDir } and sets AGENTBOOTUP_NETWORK_ROOT.
async function setupIndexingTestProject(): Promise<{ projectDir: string; netDir: string }> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-idx-daemon-test-'));
  const brainDir = path.join(projectDir, '.brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, 'brain.db'), '');
  fs.writeFileSync(path.join(projectDir, '.env'), 'BRAIN_DB_URL=https://x.fly.dev\nBRAIN_DB_TOKEN=tok\n');
  const netDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-net-'));
  fs.writeFileSync(path.join(netDir, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [{ id: 'p1', agent_id: 'test.gm', path: projectDir }],
  }));
  await writeCredentials();
  await fsp.writeFile(configFile, JSON.stringify({
    brainId: 'test.gm',
    dataTransmissionAcknowledged: true,
    brainAssetTransmissionAcknowledged: true,
  }));
  process.env.AGENTBOOTUP_NETWORK_ROOT = netDir;
  return { projectDir, netDir };
}

function teardownIndexingTestProject(projectDir: string, netDir: string) {
  delete process.env.AGENTBOOTUP_NETWORK_ROOT;
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(netDir, { recursive: true, force: true });
}

test('transcript indexing success path calls runIndexTranscripts with project path', async () => {
  let indexCalls: string[][] = [];
  const { setUnifiedDaemonRuntimeForTests } = await import('../../lib/daemon/unified-daemon-cli.js');
  setUnifiedDaemonRuntimeForTests({
    runIndexTranscripts: async (argv: string[]) => { indexCalls.push(argv); },
  });

  const { projectDir, netDir } = await setupIndexingTestProject();
  let exitCode: number | null = null;
  let logs: string[] = [];
  try {
    ({ exitCode, logs } = await runCommand(['daemon', 'start', '--no-transcripts', '--no-inbox', '--all', '--yes']));
  } finally {
    teardownIndexingTestProject(projectDir, netDir);
  }

  expect(exitCode).not.toBe(1);
  // runIndexTranscripts should have been called once with --target <projectDir>.
  expect(indexCalls.length).toBe(1);
  expect(indexCalls[0]).toEqual(['--target', projectDir]);
  // Indexing attempt log should appear.
  expect(logs.join(' ')).toMatch(/\[brain-db\] indexing transcripts/);
});

test('transcript indexing failure does not abort daemon start', async () => {
  const { setUnifiedDaemonRuntimeForTests } = await import('../../lib/daemon/unified-daemon-cli.js');
  setUnifiedDaemonRuntimeForTests({
    runIndexTranscripts: async (_argv: string[]) => {
      throw new Error('simulated indexing failure');
    },
  });

  const { projectDir, netDir } = await setupIndexingTestProject();
  let exitCode: number | null = null;
  let logs: string[] = [];
  let errs: string[] = [];
  try {
    ({ exitCode, logs, errs } = await runCommand(['daemon', 'start', '--no-transcripts', '--no-inbox', '--all', '--yes']));
  } finally {
    teardownIndexingTestProject(projectDir, netDir);
  }

  // Daemon start should succeed (exit 0 or null) despite indexing failure.
  expect(exitCode).not.toBe(1);
  // The indexing attempt log should appear (confirming it wasn't silently skipped).
  expect(logs.join(' ')).toMatch(/\[brain-db\] indexing transcripts/);
  // The non-fatal warning should appear in stderr output.
  expect(errs.join(' ')).toMatch(/index-transcripts.*non-fatal|non-fatal.*index-transcripts/i);
});

test('automatic transcript indexing crosses the Bun process boundary', async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, any> }> = [];
  const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
  child.stderr = new PassThrough();
  const { runIndexTranscriptsWithBun } = await import('../../lib/daemon/unified-daemon-cli.js');

  const pending = runIndexTranscriptsWithBun(['--target', '/tmp/project'], {
    spawnImpl: (command: string, args: string[], options: Record<string, any>) => {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  });
  await pending;

  expect(path.basename(calls[0].command)).toBe('bun');
  expect(calls[0].args[0]).toMatch(/bootup\.mjs$/);
  expect(calls[0].args.slice(1)).toEqual(['brain', 'index-transcripts', '--target', '/tmp/project']);
});

function setupFailingIndexerCli() {
  const root = fs.mkdtempSync(path.join(tmpDir, 'indexer-failure-'));
  const home = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  const encodedProject = path.resolve(projectDir).replace(/[\/_]/g, '-');
  const transcriptDir = path.join(home, '.claude', 'projects', encodedProject);
  const dbDir = path.join(projectDir, '.brain');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'agentbootup.json'), JSON.stringify({ agent_id: 'failure.gm' }));
  fs.writeFileSync(path.join(transcriptDir, 'failure-session.jsonl'), JSON.stringify({
    message: { role: 'user', content: [{ type: 'text', text: 'must fail insert' }] },
    timestamp: '2026-08-02T00:00:00.000Z',
  }) + '\n');

  const db = new Database(path.join(dbDir, 'brain.db'), { create: true });
  db.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, brain_id TEXT NOT NULL, project TEXT NOT NULL,
      session_id TEXT NOT NULL, timestamp INTEGER NOT NULL, turn_type TEXT,
      content TEXT NOT NULL, token_count INTEGER, embedding BLOB, chunk_meta TEXT,
      syncable INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE transcript_index (
      source_path TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER NOT NULL,
      session_id TEXT, project TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content, project, session_id, content='chunks', content_rowid='rowid'
    );
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END;
    CREATE TRIGGER reject_indexed_chunk BEFORE INSERT ON chunks
    BEGIN SELECT RAISE(ABORT, 'simulated per-file failure'); END;
  `);
  db.close();
  return { home, projectDir };
}

test('direct index-transcripts CLI exits nonzero when any file fails', () => {
  const { home, projectDir } = setupFailingIndexerCli();
  const entrypoint = path.resolve(import.meta.dir, '../../bootup.mjs');
  const child = Bun.spawnSync({
    cmd: [process.execPath, entrypoint, 'brain', 'index-transcripts', '--target', projectDir],
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toMatch(/simulated per-file failure/);
});

test('direct index-transcripts CLI writes and dry-runs through a canonical libSQL vector index', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'indexer-vector-'));
  const home = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  const encodedProject = path.resolve(projectDir).replace(/[\/_]/g, '-');
  const transcriptDir = path.join(home, '.claude', 'projects', encodedProject);
  const dbDir = path.join(projectDir, '.brain');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'agentbootup.json'), JSON.stringify({ agent_id: 'vector.gm' }));
  fs.writeFileSync(path.join(transcriptDir, 'vector-session.jsonl'), JSON.stringify({
    message: { role: 'user', content: [{ type: 'text', text: 'vector indexed transcript' }] },
    timestamp: '2026-08-02T00:00:00.000Z',
  }) + '\n');

  const db = new LibsqlDatabase(path.join(dbDir, 'brain.db'));
  db.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, brain_id TEXT NOT NULL, project TEXT NOT NULL,
      session_id TEXT NOT NULL, timestamp INTEGER NOT NULL, turn_type TEXT,
      content TEXT NOT NULL, token_count INTEGER, embedding F32_BLOB(384), chunk_meta TEXT,
      syncable INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_chunks_vector ON chunks(libsql_vector_idx(embedding, 'metric=cosine'));
    CREATE TABLE transcript_index (
      source_path TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER NOT NULL,
      session_id TEXT, project TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content, project, session_id, content='chunks', content_rowid='rowid'
    );
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, project, session_id)
      VALUES ('delete', old.rowid, old.content, old.project, old.session_id);
      INSERT INTO chunks_fts(rowid, content, project, session_id)
      VALUES (new.rowid, new.content, new.project, new.session_id);
    END;
  `);
  db.close();

  const entrypoint = path.resolve(import.meta.dir, '../../bootup.mjs');
  const child = Bun.spawnSync({
    cmd: [process.execPath, entrypoint, 'brain', 'index-transcripts', '--target', projectDir],
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe('');
  const verify = new LibsqlDatabase(path.join(dbDir, 'brain.db'));
  const chunkRow = verify.prepare('SELECT brain_id, content FROM chunks').get();
  expect(chunkRow.brain_id).toBe('vector.gm');
  expect(chunkRow.content).toBe('vector indexed transcript');
  const indexRow = verify.prepare('SELECT chunk_count, last_error FROM transcript_index').get();
  expect(indexRow.chunk_count).toBe(1);
  expect(indexRow.last_error).toBe(null);

  fs.appendFileSync(path.join(transcriptDir, 'vector-session.jsonl'), JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'text', text: 'embedded continuation' }] },
    timestamp: '2026-08-02T00:01:00.000Z',
  }) + '\n');
  await indexFile(verify, {
    sourcePath: path.join(transcriptDir, 'vector-session.jsonl'),
    sourceCli: 'claude',
    sessionId: 'vector-session',
    project: encodedProject,
    brainId: 'vector.gm',
    embedFn: async () => new Float32Array(384).fill(0.25),
  });
  const embeddedRow = verify.prepare('SELECT embedding FROM chunks WHERE embedding IS NOT NULL').get();
  expect(embeddedRow.embedding).not.toBe(null);
  expect(embeddedRow.embedding.byteLength).toBe(384 * Float32Array.BYTES_PER_ELEMENT);
  verify.close();

  const snapshotDbArtifacts = () => fs.readdirSync(dbDir)
    .filter((name) => name === 'brain.db' || name.startsWith('brain.db-'))
    .sort()
    .map((name) => {
      const artifactPath = path.join(dbDir, name);
      const stat = fs.statSync(artifactPath);
      return { name, size: stat.size, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(artifactPath) };
    });
  const artifactsBeforeDryRun = snapshotDbArtifacts();
  const dryRunChild = Bun.spawnSync({
    cmd: [process.execPath, entrypoint, 'brain', 'index-transcripts', '--target', projectDir, '--dry-run'],
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(dryRunChild.exitCode).toBe(0);
  expect(dryRunChild.stderr.toString()).toBe('');
  expect(snapshotDbArtifacts()).toEqual(artifactsBeforeDryRun);
});

test('direct index-transcripts dry-run works without brain.db and writes nothing', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'indexer-dry-run-'));
  const home = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  const encodedProject = path.resolve(projectDir).replace(/[\/_]/g, '-');
  const transcriptDir = path.join(home, '.claude', 'projects', encodedProject);
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'agentbootup.json'), JSON.stringify({ agent_id: 'dry-run.gm' }));
  fs.writeFileSync(path.join(transcriptDir, 'dry-run-session.jsonl'), JSON.stringify({
    message: { role: 'user', content: [{ type: 'text', text: 'simulate only' }] },
    timestamp: '2026-08-02T00:00:00.000Z',
  }) + '\n');

  const entrypoint = path.resolve(import.meta.dir, '../../bootup.mjs');
  const child = Bun.spawnSync({
    cmd: [process.execPath, entrypoint, 'brain', 'index-transcripts', '--target', projectDir, '--dry-run'],
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain('simulating a full read with ephemeral index state');
  expect(child.stdout.toString()).toContain('would index: 1 chunks');
  expect(fs.existsSync(path.join(projectDir, '.brain', 'brain.db'))).toBe(false);
});

test('direct index-transcripts dry-run fails closed on legacy persistent index state', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'indexer-legacy-dry-run-'));
  const home = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  const dbDir = path.join(projectDir, '.brain');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'agentbootup.json'), JSON.stringify({ agent_id: 'legacy-dry-run.gm' }));
  const db = new Database(path.join(dbDir, 'brain.db'), { create: true });
  db.exec(`
    CREATE TABLE transcript_index (
      source_path TEXT PRIMARY KEY, source_cli TEXT NOT NULL,
      session_id TEXT NOT NULL, last_byte_offset INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER NOT NULL
    );
  `);
  db.close();

  const entrypoint = path.resolve(import.meta.dir, '../../bootup.mjs');
  const child = Bun.spawnSync({
    cmd: [process.execPath, entrypoint, 'brain', 'index-transcripts', '--target', projectDir, '--dry-run'],
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain('dry-run cannot safely simulate existing index state');
  expect(child.stderr.toString()).toContain('agentbootup brain-db migrate');
  const unchanged = new Database(path.join(dbDir, 'brain.db'), { readonly: true });
  expect(unchanged.prepare('PRAGMA table_info(transcript_index)').all().map((row: any) => row.name))
    .toContain('last_byte_offset');
  unchanged.close();
});

test('daemon Bun child boundary rejects when an indexed file fails', async () => {
  const { home, projectDir } = setupFailingIndexerCli();
  const { runIndexTranscriptsWithBun } = await import('../../lib/daemon/unified-daemon-cli.js');

  await expect(runIndexTranscriptsWithBun(['--target', projectDir], {
    spawnImpl: (command: string, args: string[], options: Record<string, any>) =>
      // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the command and args are produced by the code under test; this injected test adapter only adds a fixture HOME.
      spawn(command, args, { ...options, env: { ...process.env, HOME: home } }),
  })).rejects.toThrow(/exited 1.*simulated per-file failure/i);
});

test('--no-brain-db skips transcript indexing with informational log', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  const { logs } = await runCommand([
    'daemon', 'start', '--no-transcripts', '--no-brain-db',
  ]);
  expect(logs.join(' ')).toContain('[index-transcripts] skipped (--no-brain-db)');
});

test('no provisioned projects logs skipped message (no silent drop)', async () => {
  // Single-brain mode: no network config → getBrainDbAgentEntries() returns [] →
  // indexableProjects is empty → else branch fires with explicit skip log.
  await writeCredentials();
  await writeConsentedConfig();
  const { logs } = await runCommand([
    'daemon', 'start', '--no-transcripts',
  ]);
  expect(logs.join(' ')).toContain('[index-transcripts] skipped (no provisioned projects)');
});

// ── daily narrative runtime integration ──────────────────────────────────────

function createNarrativeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough;
    kill: () => void;
  };
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

test('daemon start invokes the canonical runtime from a modern materialized brain', async () => {
  const { projectDir, netDir } = await setupIndexingTestProject();
  const scriptDir = path.join(projectDir, 'brain', 'scripts');
  const markerPath = path.join(projectDir, 'canonical-narrative-invoked');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptDir, 'narrative-generator.ts'),
    "import fs from 'fs'; fs.writeFileSync('canonical-narrative-invoked', 'yes');\n",
  );

  try {
    const result = await runCommand([
      'daemon', 'start', '--no-transcripts', '--no-inbox', '--no-index-transcripts', '--all', '--yes',
    ]);
    expect(result.exitCode).toBeNull();
    expect(result.logs.join(' ')).toContain('[narrative]');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('yes');
  } finally {
    teardownIndexingTestProject(projectDir, netDir);
  }
});

test('--no-narrative prevents an available canonical runtime from running', async () => {
  const { projectDir, netDir } = await setupIndexingTestProject();
  const scriptDir = path.join(projectDir, 'brain', 'scripts');
  const markerPath = path.join(projectDir, 'narrative-should-not-run');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptDir, 'narrative-generator.ts'),
    "import fs from 'fs'; fs.writeFileSync('narrative-should-not-run', 'no');\n",
  );

  try {
    const result = await runCommand([
      'daemon', 'start', '--no-transcripts', '--no-inbox', '--no-index-transcripts', '--no-narrative', '--all', '--yes',
    ]);
    expect(result.exitCode).toBeNull();
    expect(fs.existsSync(markerPath)).toBe(false);
  } finally {
    teardownIndexingTestProject(projectDir, netDir);
  }
});

test('daily narrative resolver prefers canonical runtime and bounds compatibility to legacy brain path', async () => {
  const { resolveDailyNarrativeRuntime } = await import('../../lib/daemon/unified-daemon-cli.js');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-narrative-resolve-'));
  const canonical = path.join(projectDir, 'brain', 'scripts', 'narrative-generator.ts');
  const legacy = path.join(projectDir, 'brain', 'narrative-generator.ts');
  const skillRuntime = path.join(projectDir, '.claude', 'skills', 'narrative-generator', 'narrative-generator.ts');
  fs.mkdirSync(path.dirname(skillRuntime), { recursive: true });
  fs.writeFileSync(skillRuntime, '');
  try {
    expect(resolveDailyNarrativeRuntime(projectDir)).toBeNull();
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '');
    expect(resolveDailyNarrativeRuntime(projectDir)).toBe(legacy);
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '');
    expect(resolveDailyNarrativeRuntime(projectDir)).toBe(canonical);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daily narrative is idempotent when yesterday output already exists', async () => {
  const { runDailyNarrativeGenerator } = await import('../../lib/daemon/unified-daemon-cli.js');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-narrative-existing-'));
  const yesterday = '2026-07-13';
  fs.mkdirSync(path.join(projectDir, 'brain', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'brain', 'scripts', 'narrative-generator.ts'), '');
  fs.mkdirSync(path.join(projectDir, 'memory', 'narratives'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'memory', 'narratives', `${yesterday}.md`), 'existing');
  let spawnCalls = 0;
  try {
    const result = await runDailyNarrativeGenerator({
      targetPath: projectDir,
      label: 'existing',
      yesterday,
      spawnImpl: () => { spawnCalls += 1; return createNarrativeChild(); },
    });
    expect(result.status).toBe('already_exists');
    expect(spawnCalls).toBe(0);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daily narrative reports and truncates child stderr without failing startup semantics', async () => {
  const { runDailyNarrativeGenerator } = await import('../../lib/daemon/unified-daemon-cli.js');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-narrative-stderr-'));
  fs.mkdirSync(path.join(projectDir, 'brain', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'brain', 'scripts', 'narrative-generator.ts'), '');
  const errors: string[] = [];
  try {
    const result = await runDailyNarrativeGenerator({
      targetPath: projectDir,
      label: 'stderr-case',
      yesterday: '2026-07-13',
      info: () => {},
      error: (message: string) => errors.push(message),
      spawnImpl: () => {
        const child = createNarrativeChild();
        queueMicrotask(() => {
          child.stderr.write('x'.repeat(250));
          child.emit('close', 7);
        });
        return child;
      },
    });
    expect(result.status).toBe('failed');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('exited 7');
    expect(errors[0]).toContain('x'.repeat(200));
    expect(errors[0]).not.toContain('x'.repeat(201));
    expect(errors[0]).toContain('(non-fatal)');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daily narrative kills a timed-out child once and ignores its later close and error events', async () => {
  const { runDailyNarrativeGenerator } = await import('../../lib/daemon/unified-daemon-cli.js');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-narrative-timeout-'));
  fs.mkdirSync(path.join(projectDir, 'brain', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'brain', 'scripts', 'narrative-generator.ts'), '');
  const errors: string[] = [];
  let killCalls = 0;
  let childRef: ReturnType<typeof createNarrativeChild> | null = null;
  try {
    const result = await runDailyNarrativeGenerator({
      targetPath: projectDir,
      label: 'timeout-case',
      yesterday: '2026-07-13',
      info: () => {},
      error: (message: string) => errors.push(message),
      spawnImpl: () => {
        childRef = createNarrativeChild();
        childRef.kill = () => { killCalls += 1; };
        return childRef;
      },
      timeoutMs: 120_000,
      setTimeoutImpl: (callback: () => void) => { callback(); return 1; },
      clearTimeoutImpl: () => {},
    });
    childRef?.emit('close', 1);
    childRef?.emit('error', new Error('late kill error'));
    expect(result.status).toBe('timed_out');
    expect(killCalls).toBe(1);
    expect(errors).toEqual(['[narrative] timeout-case: timed out after 120s (non-fatal)']);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ── daemon status inbox entries ───────────────────────────────────────────────

/**
 * Set up a temp network config with one inbox-enabled brain project.
 * Writes all required config entries (inboxEnabled, portRegistry, inboxWebhookSecrets)
 * to the test config file so getInboxAgentEntries({ allocate: false }) returns an entry.
 *
 * Returns { networkRoot, projectDir, brainId, inboxStateDir } for cleanup.
 */
async function setupInboxStatusProject(): Promise<{
  networkRoot: string;
  projectDir: string;
  brainId: string;
  inboxStateDir: string;
}> {
  const { resolveInboxDaemonStateDir } = await import('../../lib/daemon/unified-daemon-cli.js');
  const brainId = 'bootup.gm';
  const projectId = 'bootup';
  const inboxStateDir = fs.mkdtempSync(path.join(tmpDir, 'ab-inbox-state-'));
  process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR = inboxStateDir;
  const resolvedInboxStateDir = resolveInboxDaemonStateDir();

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-inbox-status-'));
  fs.mkdirSync(path.join(projectDir, '.brain'), { recursive: true });

  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-inbox-status-net-'));
  fs.writeFileSync(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [{ id: projectId, agent_id: brainId, path: projectDir }],
  }));

  await fsp.writeFile(configFile, JSON.stringify({
    brainId: 'test-brain',
    dataTransmissionAcknowledged: true,
    brainAssetTransmissionAcknowledged: true,
    inboxEnabled: { [brainId]: true },
    portRegistry: { inbox: { [brainId]: 8769 } },
    inboxWebhookSecrets: { [brainId]: '3247abcdef01234567890123456789ab3247abcdef01234567890123456789ab' },
  }));

  fs.rmSync(path.join(resolvedInboxStateDir, `${brainId}.json`), { force: true });
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  return { networkRoot, projectDir, brainId, inboxStateDir: resolvedInboxStateDir };
}

function teardownInboxStatusProject(networkRoot: string, projectDir: string, inboxStateDir: string) {
  delete process.env.AGENTBOOTUP_NETWORK_ROOT;
  delete process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR;
  fs.rmSync(networkRoot, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(inboxStateDir, { recursive: true, force: true });
}

test('daemon status shows inbox section when state file missing (offline)', async () => {
  await writeCredentials();
  const { networkRoot, projectDir, inboxStateDir } = await setupInboxStatusProject();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: 1234, platform: 'launchd' });

  // No state file written — inbox should be offline.
  try {
    const { exitCode, logs } = await runCommand(['daemon', 'status']);
    expect(exitCode).toBeNull();
    const output = logs.join('\n');
    expect(output).toContain('[Inbox: bootup.gm]');
    expect(output).toContain('State: offline');
  } finally {
    teardownInboxStatusProject(networkRoot, projectDir, inboxStateDir);
  }
});

test('daemon status shows inbox online when state file exists with live PID', async () => {
  await writeCredentials();
  const { networkRoot, projectDir, brainId, inboxStateDir } = await setupInboxStatusProject();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: 1234, platform: 'launchd' });

  // Write state file using our own PID (guaranteed to be alive).
  fs.mkdirSync(inboxStateDir, { recursive: true });
  const stateFile = path.join(inboxStateDir, `${brainId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    port: 8769,
    brainId,
    startedAt: new Date().toISOString(),
  }));

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'status']);
    expect(exitCode).toBeNull();
    const output = logs.join('\n');
    expect(output).toContain('[Inbox: bootup.gm]');
    expect(output).toContain('State: online');
    expect(output).toContain(`PID: ${process.pid}`);
    expect(output).toContain('Port: 8769');
    expect(output).toContain('Secret: configured');
  } finally {
    fs.rmSync(stateFile, { force: true });
    teardownInboxStatusProject(networkRoot, projectDir, inboxStateDir);
  }
});

test('daemon status shows inbox dead when state file has non-existent PID', async () => {
  await writeCredentials();
  const { networkRoot, projectDir, brainId, inboxStateDir } = await setupInboxStatusProject();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: 1234, platform: 'launchd' });

  // Use PID 999999999 — guaranteed not to exist.
  fs.mkdirSync(inboxStateDir, { recursive: true });
  const stateFile = path.join(inboxStateDir, `${brainId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({
    pid: 999999999,
    port: 8769,
    brainId,
    startedAt: new Date().toISOString(),
  }));

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'status']);
    expect(exitCode).toBeNull();
    const output = logs.join('\n');
    expect(output).toContain('[Inbox: bootup.gm]');
    expect(output).toContain('State: dead (stale state file)');
  } finally {
    fs.rmSync(stateFile, { force: true });
    teardownInboxStatusProject(networkRoot, projectDir, inboxStateDir);
  }
});

test('daemon status --json includes inbox entries with online state', async () => {
  await writeCredentials();
  const { networkRoot, projectDir, brainId, inboxStateDir } = await setupInboxStatusProject();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: 1234, platform: 'launchd' });

  // Write state file with live PID.
  fs.mkdirSync(inboxStateDir, { recursive: true });
  const stateFile = path.join(inboxStateDir, `${brainId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    port: 8769,
    brainId,
    startedAt: new Date().toISOString(),
  }));

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'status', '--json']);
    expect(exitCode).toBeNull();
    const result = JSON.parse(logs.join('\n'));
    expect(result['inbox-bootup']).toBeDefined();
    expect(result['inbox-bootup'].state).toBe('online');
    expect(result['inbox-bootup'].pid).toBe(process.pid);
    expect(result['inbox-bootup'].port).toBe(8769);
    expect(result['inbox-bootup'].brainId).toBe(brainId);
  } finally {
    fs.rmSync(stateFile, { force: true });
    teardownInboxStatusProject(networkRoot, projectDir, inboxStateDir);
  }
});

test('daemon status --json inbox entry offline when state file missing', async () => {
  await writeCredentials();
  const { networkRoot, projectDir, inboxStateDir } = await setupInboxStatusProject();
  agentStatusImpl = async (name: string) =>
    ({ name, state: 'online', pid: 1234, platform: 'launchd' });

  // No state file.
  try {
    const { exitCode, logs } = await runCommand(['daemon', 'status', '--json']);
    expect(exitCode).toBeNull();
    const result = JSON.parse(logs.join('\n'));
    expect(result['inbox-bootup']).toBeDefined();
    expect(result['inbox-bootup'].state).toBe('offline');
  } finally {
    teardownInboxStatusProject(networkRoot, projectDir, inboxStateDir);
  }
});

test('resolveInboxDaemonStateDir ignores blank AGENTBOOTUP_INBOX_DAEMONS_DIR', async () => {
  const { resolveInboxDaemonStateDir } = await import('../../lib/daemon/unified-daemon-cli.js');
  const prev = process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR;
  const expected = path.join(os.homedir(), '.agentbootup', 'inbox-daemons');
  try {
    process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR = '   ';
    expect(resolveInboxDaemonStateDir()).toBe(expected);
    process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR = '';
    expect(resolveInboxDaemonStateDir()).toBe(expected);
    delete process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR;
    expect(resolveInboxDaemonStateDir()).toBe(expected);
  } finally {
    if (prev === undefined) delete process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR;
    else process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR = prev;
  }
});

// ── Inbox daemon naming ───────────────────────────────────────────────────────

// NOTE: this test mutates process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR and cleans
// it up in a finally block. bun:test runs tests within a file sequentially by
// default, so the mutation is safe from cross-test bleed within this file.
test('inbox daemon names use project id (no dots from agent_id .gm suffix)', async () => {
  // Regression guard: inbox daemon names were previously built with p.agent_id
  // (e.g. "agentbootup-inbox-signal.gm"), which contains a dot and is rejected
  // by agent-process validation. Names must use p.id (the slug, no dots).
  // Use a loopback URL that fails immediately (ECONNREFUSED) instead of timing out.
  // webhook-secret.js captures native fetch at module load to prevent test mocks
  // from bypassing real webhook registration — so we must ensure the network call
  // either doesn't happen or fails fast. http://127.0.0.1:1 is plausible (passes
  // isPlausibleServerUrl) but refuses immediately, so registerWebhookWithMechPlane
  // logs a warning and returns false without hitting the 10s REGISTER_TIMEOUT_MS.
  await writeEncryptedCredentials({ apiKey: 'test-key', serverUrl: 'http://127.0.0.1:1' });

  // Create provisioned project dirs: each needs .brain/brain-schema.sql.
  const projectDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-inbox-a-'));
  const projectDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-inbox-b-'));
  fs.mkdirSync(path.join(projectDirA, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(projectDirB, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(projectDirA, '.brain', 'brain-schema.sql'), '-- schema');
  fs.writeFileSync(path.join(projectDirB, '.brain', 'brain-schema.sql'), '-- schema');

  // Pre-seed portRegistry so allocateInboxPort returns known ports immediately
  // (no port scan needed). Ports match the state files written below.
  // dataTransmissionAcknowledged + brainAssetTransmissionAcknowledged are
  // included intentionally — they replicate what writeConsentedConfig sets and
  // are required for the daemon start path to proceed past the consent gate.
  await fsp.writeFile(configFile, JSON.stringify({
    brainId: 'test-brain',
    dataTransmissionAcknowledged: true,
    brainAssetTransmissionAcknowledged: true,
    portRegistry: { inbox: { 'signal.gm': 8700, 'clearauth.gm': 8701 } },
  }));

  // Redirect inbox state files to tmpDir via env var so the post-start state-file
  // poll exits after the first 200 ms iteration without touching the real
  // ~/.agentbootup/inbox-daemons directory.
  // readInboxDaemonState checks process.kill(pid, 0) — using process.pid (the
  // test process itself) ensures the liveness check passes.
  const inboxStateDir = path.join(tmpDir, 'inbox-daemons-naming-test');
  fs.mkdirSync(inboxStateDir, { recursive: true });
  process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR = inboxStateDir;
  fs.writeFileSync(path.join(inboxStateDir, 'signal.gm.json'), JSON.stringify({ pid: process.pid, port: 8700 }));
  fs.writeFileSync(path.join(inboxStateDir, 'clearauth.gm.json'), JSON.stringify({ pid: process.pid, port: 8701 }));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'inbox-naming-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'signal', agent_id: 'signal.gm', path: projectDirA },
        { id: 'clearauth', agent_id: 'clearauth.gm', path: projectDirB },
      ],
    }),
  );

  try {
    const { exitCode } = await runCommand([
      'daemon', 'start', '--all', '--yes', '--no-transcripts', '--no-brain-db', '--no-index-transcripts',
    ]);

    expect(exitCode).toBeNull();

    // Brain asset sync names: agentbootup-brain-<id> (no dots — existing behavior)
    const brainNames = agentStartCalls
      .filter((c) => c.name.startsWith('agentbootup-brain-'))
      .map((c) => c.name);
    for (const name of brainNames) {
      expect(name).not.toContain('.');
    }

    // Inbox daemon names: agentbootup-inbox-<id> (no dots — the fix this test guards)
    const inboxNames = agentStartCalls
      .filter((c) => c.name.startsWith('agentbootup-inbox-'))
      .map((c) => c.name);
    expect(inboxNames.length).toBe(2);
    for (const name of inboxNames) {
      expect(name).not.toContain('.');
    }
    expect(inboxNames).toContain('agentbootup-inbox-signal');
    expect(inboxNames).toContain('agentbootup-inbox-clearauth');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    delete process.env.AGENTBOOTUP_INBOX_DAEMONS_DIR;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDirA, { recursive: true, force: true });
    fs.rmSync(projectDirB, { recursive: true, force: true });
  }
});

// ── daemon reconcile ──────────────────────────────────────────────────────────

/**
 * Set up a temp network config with one brain project suitable for reconcile tests.
 * Configures inbox as enabled with a known port so getExpectedServices returns both
 * brain-asset-sync and inbox entries.
 */
async function setupReconcileProject(opts: { brainId?: string; projectId?: string } = {}): Promise<{
  networkRoot: string;
  projectDir: string;
  brainId: string;
  projectId: string;
}> {
  const brainId = opts.brainId ?? 'reconcile.gm';
  const projectId = opts.projectId ?? 'reconcile';

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-'));
  fs.mkdirSync(path.join(projectDir, '.brain'), { recursive: true });

  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-net-'));
  fs.writeFileSync(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [{ id: projectId, agent_id: brainId, path: projectDir }],
  }));

  await fsp.writeFile(configFile, JSON.stringify({
    brainId: 'test-brain',
    dataTransmissionAcknowledged: true,
    brainAssetTransmissionAcknowledged: true,
    inboxEnabled: { [brainId]: true },
    portRegistry: { inbox: { [brainId]: 8770 } },
    inboxWebhookSecrets: { [brainId]: 'aabbccddeeff00112233445566778899' },
  }));

  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  return { networkRoot, projectDir, brainId, projectId };
}

function teardownReconcileProject(networkRoot: string, projectDir: string) {
  delete process.env.AGENTBOOTUP_NETWORK_ROOT;
  fs.rmSync(networkRoot, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
}

test('daemon reconcile exits 1 without --all or project filter', async () => {
  await writeCredentials();
  const { networkRoot, projectDir } = await setupReconcileProject();
  try {
    const { exitCode, errs } = await runCommand(['daemon', 'reconcile']);
    expect(exitCode).toBe(1);
    expect(errs.join(' ')).toContain('--all');
  } finally {
    teardownReconcileProject(networkRoot, projectDir);
  }
});

test('daemon reconcile --all: starts missing brain-asset-sync service', async () => {
  await writeCredentials();
  const { networkRoot, projectDir } = await setupReconcileProject();

  // brain-asset-sync is NOT running (state: 'stopped')
  agentStatusImpl = async (name: string) => ({
    name,
    state: 'stopped',
    platform: 'launchd',
  });

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'reconcile', '--all']);
    expect(exitCode).toBeNull();
    // At least one agentStart call should have been made for the brain-asset-sync
    const brainStartCalls = agentStartCalls.filter((c) => c.name.startsWith('agentbootup-brain-'));
    expect(brainStartCalls.length).toBeGreaterThan(0);
    // Output should mention "missing" and "starting"
    expect(logs.join('\n')).toContain('missing');
  } finally {
    teardownReconcileProject(networkRoot, projectDir);
  }
});

test('daemon reconcile --all --dry-run: reports missing but does NOT call agentStart', async () => {
  await writeCredentials();
  const { networkRoot, projectDir } = await setupReconcileProject();

  // brain-asset-sync is NOT running
  agentStatusImpl = async (name: string) => ({
    name,
    state: 'stopped',
    platform: 'launchd',
  });

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'reconcile', '--all', '--dry-run']);
    expect(exitCode).toBeNull();
    // agentStart must NOT have been called in dry-run mode
    expect(agentStartCalls).toHaveLength(0);
    // Output must indicate dry-run
    const output = logs.join('\n');
    expect(output).toContain('[dry-run]');
    expect(output).toContain('missing');
  } finally {
    teardownReconcileProject(networkRoot, projectDir);
  }
});

test('daemon reconcile does NOT call agentStop even when services have unexpected state', async () => {
  // Safety invariant: reconcile NEVER stops services, only starts missing ones.
  await writeCredentials();
  const { networkRoot, projectDir } = await setupReconcileProject();

  // All services report running — nothing to do
  agentStatusImpl = async (name: string) => ({
    name,
    state: 'online',
    pid: process.pid,
    platform: 'launchd',
  });

  try {
    const { exitCode } = await runCommand(['daemon', 'reconcile', '--all']);
    expect(exitCode).toBeNull();
    // agentStop must NEVER be called by reconcile
    expect(agentStopCalls).toHaveLength(0);
  } finally {
    teardownReconcileProject(networkRoot, projectDir);
  }
});

test('daemon reconcile <brainId>: reconciles only the matching brain', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-a-'));
  const projectDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-b-'));
  fs.mkdirSync(path.join(projectDirA, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(projectDirB, '.brain'), { recursive: true });

  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-net2-'));
  fs.writeFileSync(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'alpha', agent_id: 'alpha.gm', path: projectDirA },
      { id: 'beta', agent_id: 'beta.gm', path: projectDirB },
    ],
  }));

  // Set up inboxEnabled and portRegistry for both brains.
  await fsp.writeFile(configFile, JSON.stringify({
    brainId: 'test-brain',
    dataTransmissionAcknowledged: true,
    brainAssetTransmissionAcknowledged: true,
    inboxEnabled: { 'alpha.gm': false, 'beta.gm': false },
    portRegistry: { inbox: {} },
    inboxWebhookSecrets: {},
  }));

  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;

  // brain-asset-sync is NOT running for any brain
  agentStatusImpl = async (name: string) => ({
    name,
    state: 'stopped',
    platform: 'launchd',
  });

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'reconcile', 'alpha.gm']);
    expect(exitCode).toBeNull();
    // Only alpha.gm should appear in the output
    const output = logs.join('\n');
    expect(output).toContain('alpha.gm');
    // Only brain-asset-sync for alpha should be started
    const startedNames = agentStartCalls.map((c) => c.name);
    expect(startedNames.every((n) => n.includes('alpha'))).toBe(true);
    expect(startedNames.some((n) => n.includes('beta'))).toBe(false);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    fs.rmSync(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDirA, { recursive: true, force: true });
    fs.rmSync(projectDirB, { recursive: true, force: true });
  }
});

test('daemon reconcile --all: drifted inbox port is reported in output', async () => {
  // Verifies that when an inbox daemon is running on a different port than the
  // portRegistry expects (port drift), computeReconcileDiff classifies it as
  // drifted and handleReconcile logs it accordingly.
  //
  // Note: verifyInboxPortAndReRegister uses a module-level captured _fetch
  // (not globalThis.fetch), so we verify observable output behavior rather
  // than fetch interception. The function call will fail silently because no
  // real HTTP server is listening — which is correct non-fatal behavior.
  await writeCredentials();
  const { networkRoot, projectDir, brainId } = await setupReconcileProject();

  // brain-asset-sync is running
  agentStatusImpl = async (name: string) => ({
    name,
    state: 'online',
    pid: process.pid,
    platform: 'launchd',
  });

  // Write inbox state file with a DIFFERENT port than portRegistry (8770 → 8771).
  // portRegistry in configFile says port 8770; state file says the daemon bound to 8771.
  const inboxDaemonsDir = path.join(os.homedir(), '.agentbootup', 'inbox-daemons');
  fs.mkdirSync(inboxDaemonsDir, { recursive: true });
  const stateFile = path.join(inboxDaemonsDir, `${brainId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid, // alive — so readInboxDaemonState returns state: 'online'
    port: 8771,       // different from portRegistry port 8770 → triggers drift
    brainId,
    startedAt: new Date().toISOString(),
  }));

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'reconcile', '--all']);
    expect(exitCode).toBeNull();
    // Output should mention drifted — computeReconcileDiff detected port mismatch
    const output = logs.join('\n');
    expect(output).toContain('drifted');
    // Drifted port should appear in output (8771 = actual)
    expect(output).toContain('8771');
    // agentStart must NOT have been called for drifted services (re-register, not restart)
    const inboxStartCalls = agentStartCalls.filter((c) => c.name.startsWith('agentbootup-inbox-'));
    expect(inboxStartCalls).toHaveLength(0);
  } finally {
    fs.rmSync(stateFile, { force: true });
    teardownReconcileProject(networkRoot, projectDir);
  }
});

test('daemon reconcile --all bootstraps a legacy provisioned inbox without inboxEnabled or preallocated port', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-legacy-inbox-'));
  fs.mkdirSync(path.join(projectDir, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.brain', 'brain-schema.sql'), '-- schema');

  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-legacy-net-'));
  fs.writeFileSync(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [{ id: 'legacy', agent_id: 'legacy.gm', path: projectDir }],
  }));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;

  agentStatusImpl = async (name: string) => ({
    name,
    state: 'stopped',
    platform: 'launchd',
  });

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'reconcile', '--all']);
    expect(exitCode).toBeNull();

    const inboxStartCalls = agentStartCalls.filter((c) => c.name === 'agentbootup-inbox-legacy');
    expect(inboxStartCalls).toHaveLength(1);
    expect(inboxStartCalls[0].env?.AGENTBOOTUP_BRAIN_ID).toBe('legacy.gm');
    expect(inboxStartCalls[0].env?.AGENTBOOTUP_INBOX_PORT).toBeDefined();
    expect(inboxStartCalls[0].env?.AGENTBOOTUP_INBOX_WEBHOOK_SECRET).toBeDefined();

    const persisted = JSON.parse(await fsp.readFile(configFile, 'utf-8'));
    expect(persisted.inboxEnabled?.['legacy.gm']).toBe(true);
    expect(persisted.portRegistry?.inbox?.['legacy.gm']).toBeDefined();
    expect(persisted.inboxWebhookSecrets?.['legacy.gm']).toBeDefined();
    const output = logs.join('\n');
    expect(output).toContain('Brain: legacy.gm');
    expect(output).toContain('inbox');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    fs.rmSync(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daemon reconcile <brain> only bootstraps the requested legacy inbox', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-scope-alpha-'));
  const projectDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-scope-beta-'));
  fs.mkdirSync(path.join(projectDirA, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(projectDirB, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(projectDirA, '.brain', 'brain-schema.sql'), '-- schema');
  fs.writeFileSync(path.join(projectDirB, '.brain', 'brain-schema.sql'), '-- schema');

  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-scope-net-'));
  fs.writeFileSync(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'alpha', agent_id: 'alpha.gm', path: projectDirA },
      { id: 'beta', agent_id: 'beta.gm', path: projectDirB },
    ],
  }));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;

  agentStatusImpl = async (name: string) => ({
    name,
    state: 'stopped',
    platform: 'launchd',
  });

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'reconcile', 'alpha.gm']);
    expect(exitCode).toBeNull();

    const output = logs.join('\n');
    expect(output).toContain('Brain: alpha.gm');
    expect(output).not.toContain('Brain: beta.gm');

    const startedInboxNames = agentStartCalls
      .map((c) => c.name)
      .filter((name) => name.startsWith('agentbootup-inbox-'));
    expect(startedInboxNames).toContain('agentbootup-inbox-alpha');
    expect(startedInboxNames).not.toContain('agentbootup-inbox-beta');

    const persisted = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(persisted.inboxEnabled?.['alpha.gm']).toBe(true);
    expect(persisted.inboxEnabled?.['beta.gm']).toBeFalsy();
    expect(persisted.portRegistry?.inbox?.['alpha.gm']).toBeDefined();
    expect(persisted.portRegistry?.inbox?.['beta.gm']).toBeUndefined();
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    fs.rmSync(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDirA, { recursive: true, force: true });
    fs.rmSync(projectDirB, { recursive: true, force: true });
  }
});

test('daemon reconcile <brain> persists inboxEnabled for a targeted legacy inbox that already has port and secret', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-existing-inbox-'));
  fs.mkdirSync(path.join(projectDir, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.brain', 'brain-schema.sql'), '-- schema');

  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-existing-net-'));
  fs.writeFileSync(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [{ id: 'alpha', agent_id: 'alpha.gm', path: projectDir }],
  }));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;

  const persistedBefore = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  persistedBefore.portRegistry = { inbox: { 'alpha.gm': 22771 } };
  persistedBefore.inboxWebhookSecrets = { 'alpha.gm': 'f'.repeat(64) };
  persistedBefore.inboxEnabled = { 'alpha.gm': false };
  fs.writeFileSync(configFile, JSON.stringify(persistedBefore));

  agentStatusImpl = async (name: string) => ({
    name,
    state: 'stopped',
    platform: 'launchd',
  });

  try {
    const { exitCode } = await runCommand(['daemon', 'reconcile', 'alpha.gm']);
    expect(exitCode).toBeNull();

    const startedInboxNames = agentStartCalls
      .map((c) => c.name)
      .filter((name) => name.startsWith('agentbootup-inbox-'));
    expect(startedInboxNames).toContain('agentbootup-inbox-alpha');

    const persistedAfter = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(persistedAfter.inboxEnabled?.['alpha.gm']).toBe(true);
    expect(persistedAfter.portRegistry?.inbox?.['alpha.gm']).toBe(22771);
    expect(persistedAfter.inboxWebhookSecrets?.['alpha.gm']).toBe('f'.repeat(64));
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    fs.rmSync(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daemon reconcile <brain> persists inboxEnabled for a targeted legacy inbox that is already running', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-running-inbox-'));
  fs.mkdirSync(path.join(projectDir, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.brain', 'brain-schema.sql'), '-- schema');

  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconcile-running-net-'));
  fs.writeFileSync(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [{ id: 'alpha', agent_id: 'alpha.gm', path: projectDir }],
  }));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;

  const persistedBefore = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  persistedBefore.portRegistry = { inbox: { 'alpha.gm': 22772 } };
  persistedBefore.inboxWebhookSecrets = { 'alpha.gm': 'a'.repeat(64) };
  persistedBefore.inboxEnabled = { 'alpha.gm': false };
  fs.writeFileSync(configFile, JSON.stringify(persistedBefore));

  const inboxDaemonsDir = path.join(os.homedir(), '.agentbootup', 'inbox-daemons');
  fs.mkdirSync(inboxDaemonsDir, { recursive: true });
  const stateFile = path.join(inboxDaemonsDir, 'alpha.gm.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    port: 22772,
    brainId: 'alpha.gm',
    startedAt: new Date().toISOString(),
  }));

  agentStatusImpl = async (name: string) => ({
    name,
    state: 'online',
    pid: process.pid,
    platform: 'launchd',
  });

  try {
    const { exitCode } = await runCommand(['daemon', 'reconcile', 'alpha.gm']);
    expect(exitCode).toBeNull();

    const persistedAfter = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(persistedAfter.inboxEnabled?.['alpha.gm']).toBe(true);
    expect(agentStartCalls.filter((c) => c.name === 'agentbootup-inbox-alpha')).toHaveLength(0);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daemon reconcile routes to handleReconcile via runDaemonCommand dispatch', async () => {
  // No network config — reconcile should log "No network config found" and return.
  await writeCredentials();
  await writeConsentedConfig();
  const { exitCode, logs } = await runCommand(['daemon', 'reconcile', '--all']);
  // No network config: should return cleanly (no exit 1 for this particular no-config path)
  // The function prints a message and returns.
  expect(logs.join(' ')).toContain('No network config found');
});

test('daemon stop exits 1 when a daemon remains running after stop verification', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '1';

  agentStatusImpl = async (name: string) => {
    if (name === 'agentbootup-brain') {
      return { name, state: 'running', pid: 1234, platform: 'launchd' };
    }
    return { name, state: 'unknown', platform: 'launchd' };
  };

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'stop', '--no-transcripts']);
    expect(exitCode).toBe(1);
    expect(agentStopCalls).toContain('agentbootup-brain');
    expect(errs.join('\n')).toContain('still running (PID 1234)');
  } finally {
    delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
  }
});

test('daemon stop does not treat --no-brain-db and --no-inbox as project filters', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDirAlpha = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-flags-alpha-'));
  const projectDirBeta = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-flags-beta-'));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'stop-flags-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: projectDirAlpha },
        { id: 'beta', agent_id: 'beta.gm', path: projectDirBeta },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'stop', '--all', '--no-brain-db', '--no-inbox']);
    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStopCalls).toContain('agentbootup-brain-alpha');
    expect(agentStopCalls).toContain('agentbootup-brain-beta');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDirAlpha, { recursive: true, force: true });
    fs.rmSync(projectDirBeta, { recursive: true, force: true });
  }
});

// ── daemon restart ────────────────────────────────────────────────────────────

test('daemon restart routes to handleRestart and calls both stop and start', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const { exitCode, logs, errs } = await runCommand([
    'daemon', 'restart', '--no-transcripts', '--yes',
  ]);

  expect(exitCode).toBeNull();
  expect(errs).toEqual([]);
  // agentStop must have been called (stop phase)
  expect(agentStopCalls.length).toBeGreaterThan(0);
  // agentStart must have been called (start phase)
  expect(agentStartCalls.length).toBeGreaterThan(0);
  // Output must indicate both phases and completion
  const output = logs.join('\n');
  expect(output).toContain('Stopping services');
  expect(output).toContain('Starting services');
  expect(output).toContain('Restart complete');
});

test('daemon restart forces a fresh start when the old daemon is still running', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '1';

  let brainRunning = true;
  agentStopImpl = async (name: string) => {
    agentStopCalls.push(name);
    if (name === 'agentbootup-brain' && agentStopCalls.filter((call) => call === name).length >= 2) {
      brainRunning = false;
    }
  };

  agentStatusImpl = async (name: string) => {
    if (name === 'agentbootup-brain') {
      return brainRunning
        ? { name, state: 'running', pid: 1234, platform: 'launchd' }
        : { name, state: 'stopped', platform: 'launchd' };
    }
    return { name, state: 'unknown', platform: 'launchd' };
  };

  try {
    const { exitCode, logs, errs } = await runCommand([
      'daemon', 'restart', '--no-transcripts', '--yes',
    ]);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStopCalls).toContain('agentbootup-brain');
    expect(agentStopCalls.filter((call) => call === 'agentbootup-brain')).toHaveLength(2);
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain')).toBe(true);
    const output = logs.join('\n');
    expect(output).toContain('still running (PID 1234); continuing with forced restart');
    expect(output).toContain('Restart complete');
  } finally {
    delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
  }
});

/**
 * Factory for the agentStatusImpl used by the three probe-error-path SIGKILL tests.
 *
 * After the 2nd brain agentStop fires, the first status call is delayed 10ms to ensure
 * the 1ms stop-verification deadline is exceeded (so waitForAgentStopped exits after
 * exactly one poll). The second call throws, exercising the kill-0 fallback path.
 *
 * The stopCountRef must be incremented by the test's agentStopImpl for 'agentbootup-brain'.
 */
function makeProbeErrorStatusImpl(
  stopCountRef: { value: number },
  syntheticPid: number,
): (name: string) => Promise<Record<string, any>> {
  let callsAfterSecondStop = 0;
  return async (name: string) => {
    if (name !== 'agentbootup-brain') return { name, state: 'unknown', platform: 'launchd' };
    if (stopCountRef.value >= 2) {
      callsAfterSecondStop += 1;
      if (callsAfterSecondStop === 1) {
        // Delay ensures the 1ms deadline is exceeded and waitForAgentStopped exits
        // after exactly this iteration (returning stopped:false with PID).
        await new Promise((r) => setTimeout(r, 10));
      }
      // First call = waitForAgentStopped poll → running → stopped:false.
      // Second call = pre-SIGKILL recheck → THROW → exercises kill-0 fallback path.
      if (callsAfterSecondStop >= 2) {
        throw new Error('simulated service manager probe failure');
      }
    }
    return { name, state: 'running', pid: syntheticPid, platform: 'launchd' };
  };
}

test('daemon restart falls back to SIGKILL when stop verification times out, then starts successfully', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '1';
  process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS = '1';

  // Use a synthetic PID that is guaranteed to not belong to us, then mock
  // process.kill so the test controls signal delivery and the kill-0 probe.
  const SYNTHETIC_PID = 54321;
  const killCalls: Array<{ pid: number; signal: string }> = [];
  const originalKill = process.kill.bind(process);
  (process as any).kill = (pid: number, signal: string | number) => {
    killCalls.push({ pid, signal: String(signal) });
    if (signal === 0) {
      // kill -0 probe: simulate the process dies after SIGKILL is delivered.
      if (killCalls.some((c) => c.pid === pid && c.signal === 'SIGKILL')) {
        const err: any = new Error('kill ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return; // still alive before SIGKILL
    }
    // SIGKILL: delivered silently (no real process to kill).
  };

  agentStopImpl = async (name: string) => {
    agentStopCalls.push(name);
    // Graceful stop never works — simulates slow-to-stop daemon.
  };

  agentStatusImpl = async (name: string) => {
    if (name !== 'agentbootup-brain') {
      return { name, state: 'unknown', platform: 'launchd' };
    }
    // Always report running via agentStatus (stop verification windows time out).
    // The settle phase uses process.kill(0) instead, mocked above to report dead.
    return { name, state: 'running', pid: SYNTHETIC_PID, platform: 'launchd' };
  };

  try {
    const { exitCode, logs, errs } = await runCommand([
      'daemon', 'restart', '--no-transcripts', '--yes',
    ]);

    // SIGKILL path should produce a successful restart, not a failure.
    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    // Verify SIGKILL was actually sent to the correct PID.
    expect(killCalls.some((c) => c.pid === SYNTHETIC_PID && c.signal === 'SIGKILL')).toBe(true);
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain')).toBe(true);
    const output = logs.join('\n');
    expect(output).toContain('Restart complete');
  } finally {
    (process as any).kill = originalKill;
    delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
    delete process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS;
  }
});

test('daemon restart fails cleanly when daemon survives SIGKILL', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '1';
  process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS = '1';

  // Mock process.kill: SIGKILL succeeds silently, kill -0 always reports process alive.
  // agentStatusImpl always returns running with SYNTHETIC_PID, so the pre-SIGKILL
  // recheck takes path (a) — agentStatus recheck sets verifiedPid, not the kill-0 fallback.
  const SYNTHETIC_PID = 54321;
  const killCalls: Array<{ pid: number; signal: string }> = [];
  const originalKill = process.kill.bind(process);
  (process as any).kill = (pid: number, signal: string | number) => {
    killCalls.push({ pid, signal: String(signal) });
    // Both SIGKILL and kill -0 return normally — process survives SIGKILL.
  };

  agentStopImpl = async (name: string) => {
    agentStopCalls.push(name);
  };

  agentStatusImpl = async (name: string) => {
    if (name !== 'agentbootup-brain') {
      return { name, state: 'unknown', platform: 'launchd' };
    }
    return { name, state: 'running', pid: SYNTHETIC_PID, platform: 'launchd' };
  };

  try {
    const { exitCode, errs } = await runCommand([
      'daemon', 'restart', '--no-transcripts', '--yes',
    ]);

    expect(exitCode).toBe(1);
    // SIGKILL was attempted but daemon survived.
    expect(killCalls.some((c) => c.pid === SYNTHETIC_PID && c.signal === 'SIGKILL')).toBe(true);
    // Error message should surface that SIGKILL was tried.
    expect(errs.join('\n')).toMatch(/survived SIGKILL/);
    // Daemon should NOT have been started — it was never confirmed dead.
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain')).toBe(false);
  } finally {
    (process as any).kill = originalKill;
    delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
    delete process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS;
  }
});

test('daemon restart SIGKILL path: agentStatus probe error triggers kill-0 fallback for verifiedPid', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '1';
  process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS = '1';

  const SYNTHETIC_PID = 54321;
  const stopCountRef = { value: 0 };

  agentStopImpl = async (name: string) => {
    agentStopCalls.push(name);
    if (name === 'agentbootup-brain') stopCountRef.value += 1;
  };
  agentStatusImpl = makeProbeErrorStatusImpl(stopCountRef, SYNTHETIC_PID);

  // Mock process.kill: kill -0 returns normally (alive), SIGKILL returns normally,
  // subsequent kill -0 settle probes keep returning normally (still alive).
  const killCalls: Array<{ pid: number; signal: string }> = [];
  const originalKill = process.kill.bind(process);
  (process as any).kill = (pid: number, signal: string | number) => {
    killCalls.push({ pid, signal: String(signal) });
    // All kill variants return normally — kill -0 reports alive, SIGKILL silent.
  };

  try {
    const { exitCode, errs } = await runCommand([
      'daemon', 'restart', '--no-transcripts', '--yes',
    ]);

    expect(exitCode).toBe(1);
    // kill -0 probe (signal '0') confirms the fallback path was actually traversed.
    expect(killCalls.some((c) => c.pid === SYNTHETIC_PID && c.signal === '0')).toBe(true);
    // kill -0 set verifiedPid → SIGKILL attempted.
    expect(killCalls.some((c) => c.pid === SYNTHETIC_PID && c.signal === 'SIGKILL')).toBe(true);
    expect(errs.join('\n')).toMatch(/survived SIGKILL/);
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain')).toBe(false);
  } finally {
    (process as any).kill = originalKill;
    delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
    delete process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS;
  }
});

test('daemon restart kill-0 fallback: ESRCH from kill-0 means daemon already gone → direct start', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '1';

  const SYNTHETIC_PID = 54321;
  const stopCountRef = { value: 0 };

  agentStopImpl = async (name: string) => {
    agentStopCalls.push(name);
    if (name === 'agentbootup-brain') stopCountRef.value += 1;
  };
  agentStatusImpl = makeProbeErrorStatusImpl(stopCountRef, SYNTHETIC_PID);

  const killCalls: Array<{ pid: number; signal: string }> = [];
  const originalKill = process.kill.bind(process);
  (process as any).kill = (pid: number, signal: string | number) => {
    killCalls.push({ pid, signal: String(signal) });
    if (String(signal) === '0') {
      // kill -0 probe: throw ESRCH to simulate process already gone.
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }
  };

  try {
    const { exitCode, logs } = await runCommand([
      'daemon', 'restart', '--no-transcripts', '--yes',
    ]);

    // ESRCH → early-return without SIGKILL → startAgentWithRetry → restarted.
    expect(exitCode).toBeNull(); // no process.exit = success
    // Confirm early-return: kill -0 fired but SIGKILL was never sent.
    expect(killCalls.some((c) => c.signal === '0')).toBe(true);
    expect(killCalls.every((c) => c.signal !== 'SIGKILL')).toBe(true);
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain')).toBe(true);
    expect(logs.join('\n')).toMatch(/Restart complete/);
  } finally {
    (process as any).kill = originalKill;
    delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
  }
});

test('daemon restart kill-0 fallback: EPERM from kill-0 → skip SIGKILL, report failed', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '1';

  // EPERM from kill -0 means process is alive but caller lacks permission to signal it.
  // verifiedPid is left null → SIGKILL skipped entirely → failed result.
  const SYNTHETIC_PID = 54321;
  const stopCountRef = { value: 0 };

  agentStopImpl = async (name: string) => {
    agentStopCalls.push(name);
    if (name === 'agentbootup-brain') stopCountRef.value += 1;
  };
  agentStatusImpl = makeProbeErrorStatusImpl(stopCountRef, SYNTHETIC_PID);

  const killCalls: Array<{ pid: number; signal: string }> = [];
  const originalKill = process.kill.bind(process);
  (process as any).kill = (pid: number, signal: string | number) => {
    killCalls.push({ pid, signal: String(signal) });
    if (String(signal) === '0') {
      // kill -0: throw EPERM — process alive but no permission to signal.
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }
  };

  try {
    const { exitCode } = await runCommand([
      'daemon', 'restart', '--no-transcripts', '--yes',
    ]);

    // EPERM → verifiedPid = null → SIGKILL skipped → failed.
    expect(exitCode).toBe(1);
    // Confirm kill-0 fired (EPERM branch was actually exercised).
    expect(killCalls.some((c) => c.signal === '0')).toBe(true);
    // Confirm SIGKILL was never attempted.
    expect(killCalls.every((c) => c.signal !== 'SIGKILL')).toBe(true);
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain')).toBe(false);
  } finally {
    (process as any).kill = originalKill;
    delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
  }
});

test('daemon restart skips the second stop when the daemon clears during restart handoff', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '1';

  let brainRunning = true;
  let brainStatusChecks = 0;
  agentStopImpl = async (name: string) => {
    agentStopCalls.push(name);
    if (name === 'agentbootup-brain') {
      brainRunning = false;
    }
  };

  agentStatusImpl = async (name: string) => {
    if (name !== 'agentbootup-brain') {
      return { name, state: 'unknown', platform: 'launchd' };
    }

    brainStatusChecks += 1;
    if (brainStatusChecks === 1) {
      return { name, state: 'running', pid: 1234, platform: 'launchd' };
    }
    if (brainStatusChecks === 2) {
      return { name, state: 'running', pid: 1234, platform: 'launchd' };
    }
    return { name, state: 'stopped', platform: 'launchd' };
  };

  try {
    const { exitCode, errs } = await runCommand([
      'daemon', 'restart', '--no-transcripts', '--yes',
    ]);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStopCalls.filter((call) => call === 'agentbootup-brain')).toHaveLength(1);
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain')).toBe(true);
  } finally {
    delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
  }
});

test('daemon restart retries the final stop when the restart handoff probe errors', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '1';

  let brainRunning = true;
  let brainStatusChecks = 0;
  agentStopImpl = async (name: string) => {
    agentStopCalls.push(name);
    if (name === 'agentbootup-brain' && agentStopCalls.filter((call) => call === name).length >= 2) {
      brainRunning = false;
    }
  };

  agentStatusImpl = async (name: string) => {
    if (name !== 'agentbootup-brain') {
      return { name, state: 'unknown', platform: 'launchd' };
    }

    brainStatusChecks += 1;
    if (brainStatusChecks <= 3) {
      return { name, state: 'running', pid: 1234, platform: 'launchd' };
    }
    if (brainStatusChecks === 4) {
      throw new Error('status probe failed');
    }
    return brainRunning
      ? { name, state: 'running', pid: 1234, platform: 'launchd' }
      : { name, state: 'stopped', platform: 'launchd' };
  };

  try {
    const { exitCode, errs } = await runCommand([
      'daemon', 'restart', '--no-transcripts', '--yes',
    ]);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStopCalls.filter((call) => call === 'agentbootup-brain')).toHaveLength(2);
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain')).toBe(true);
  } finally {
    delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
  }
});

test('daemon restart exits 1 in multi-brain mode with no project filter and no --all', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'restart-multi-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand(['daemon', 'restart', '--yes']);
    expect(exitCode).toBe(1);
    expect(errs.join(' ')).toContain('Multiple brains detected');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon restart ignores forwarded flag values when checking scoped projects', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'restart-multi-skills-mode-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: '/tmp/alpha' },
        { id: 'beta', agent_id: 'beta.gm', path: '/tmp/beta' },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand([
      'daemon',
      'restart',
      '--skills-mode',
      'static',
      '--no-inbox',
      '--no-brain-db',
      '--no-index-transcripts',
      '--no-narrative',
      '--yes',
    ]);
    expect(exitCode).toBe(1);
    expect(errs.join(' ')).toContain('Multiple brains detected');
    expect(errs.join(' ')).not.toContain('No matching projects found for: static');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
  }
});

test('daemon restart --all restarts all brains (stop then start)', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  // Create real temp dirs so getBrainAgentEntries() does not skip the entries.
  const projectDirAlpha = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-alpha-'));
  const projectDirBeta = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-beta-'));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'restart-all-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: projectDirAlpha },
        { id: 'beta', agent_id: 'beta.gm', path: projectDirBeta },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand([
      'daemon', 'restart', '--all', '--no-transcripts', '--yes',
    ]);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    // agentStop called for both brains
    expect(agentStopCalls.length).toBeGreaterThanOrEqual(2);
    // agentStart called for both brains after stop
    expect(agentStartCalls.length).toBe(2);
    expect(agentStartCalls.map((c) => c.name)).toEqual([
      'agentbootup-brain-alpha',
      'agentbootup-brain-beta',
    ]);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDirAlpha, { recursive: true, force: true });
    fs.rmSync(projectDirBeta, { recursive: true, force: true });
  }
});

test('daemon restart <projectId> restarts only the matching brain', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  // Create real temp dirs so getBrainAgentEntries() does not skip the entries.
  const projectDirAlpha = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-single-alpha-'));
  const projectDirBeta = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-single-beta-'));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'restart-single-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: projectDirAlpha },
        { id: 'beta', agent_id: 'beta.gm', path: projectDirBeta },
      ],
    }),
  );

  try {
    const { exitCode, errs } = await runCommand([
      'daemon', 'restart', 'alpha', '--no-transcripts', '--yes',
    ]);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    // Only alpha's brain daemon was stopped
    expect(agentStopCalls).toContain('agentbootup-brain-alpha');
    expect(agentStopCalls).not.toContain('agentbootup-brain-beta');
    // Only alpha's brain daemon was started
    expect(agentStartCalls).toHaveLength(1);
    expect(agentStartCalls[0].name).toBe('agentbootup-brain-alpha');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDirAlpha, { recursive: true, force: true });
    fs.rmSync(projectDirBeta, { recursive: true, force: true });
  }
});

test('daemon restart <projectId> does not cycle the shared transcript daemon when it was not stop-targeted', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDirAlpha = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-transcript-alpha-'));
  const projectDirBeta = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-transcript-beta-'));

  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'restart-transcript-scope-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'alpha', agent_id: 'alpha.gm', path: projectDirAlpha },
        { id: 'beta', agent_id: 'beta.gm', path: projectDirBeta },
      ],
    }),
  );

  agentStatusImpl = async (name: string) => {
    if (name === 'agentbootup-transcripts') {
      return { name, state: 'running', pid: 2222, platform: 'launchd' };
    }
    return { name, state: 'unknown', platform: 'launchd' };
  };

  try {
    const { exitCode, errs } = await runCommand([
      'daemon', 'restart', 'alpha', '--yes',
    ]);

    expect(exitCode).toBeNull();
    expect(errs).toEqual([]);
    expect(agentStopCalls).not.toContain('agentbootup-transcripts');
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-transcripts')).toBe(false);
    expect(agentStartCalls.some((call) => call.name === 'agentbootup-brain-alpha')).toBe(true);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDirAlpha, { recursive: true, force: true });
    fs.rmSync(projectDirBeta, { recursive: true, force: true });
  }
});

// ── daemon health ─────────────────────────────────────────────────────────────

test('daemon health: no network config prints single-brain message', async () => {
  // No AGENTBOOTUP_NETWORK_ROOT set — single-brain mode.
  delete process.env.AGENTBOOTUP_NETWORK_ROOT;
  const { logs } = await runCommand(['daemon', 'health']);
  expect(logs.join('\n')).toContain('single-brain');
});

test('daemon health: process liveness without converge evidence fails closed', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-health-brain-'));
  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'health-brain-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'health-proj', agent_id: 'health.gm', path: projectDir }],
    }),
  );

  agentStatusImpl = async (name: string) => ({ name, state: 'running', pid: 1234, platform: 'launchd' });

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'health']);
    expect(exitCode).toBeNull();
    const output = logs.join('\n');
    expect(output).toContain('health.gm');
    expect(output).toContain('memory converge health unknown/incomplete');
    expect(output).toMatch(/✗/);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daemon health separates live transcript process from degraded backup health', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-health-transcript-'));
  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'health-transcript-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: 'network', projects: [{ id: 'transcript-proj', agent_id: 'transcript.gm', path: projectDir }],
  }));
  agentStatusImpl = async (name: string) => ({ name, state: 'running', pid: process.pid, platform: 'launchd' });
  fetchImpl = async (url: string) => {
    if (url.includes(':8766/health')) {
      return new Response(JSON.stringify({
        healthy: false,
        liveness: { healthy: true, uptime: 30 },
        backup: { healthy: false, state: 'degraded_remote', reasons: ['remote_sync_error'], authority: 'legacy_unverified' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const { logs } = await runCommand(['daemon', 'health', '--json']);
    const payload = JSON.parse(logs.join('\n'));
    expect(payload.transcripts.liveness.healthy).toBe(true);
    expect(payload.transcripts.backup).toMatchObject({ healthy: false, state: 'degraded_remote' });
    expect(payload.brains[0].transcriptsHealthy).toBe(false);
    expect(payload.summary.unhealthy).toBeGreaterThan(0);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daemon health: reports a live degraded brain-asset-sync record', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-health-degraded-'));
  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'health-degraded-'));
  const daemonDir = await fsp.mkdtemp(path.join(tmpDir, 'daemon-health-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  process.env.AGENTBOOTUP_DAEMON_DIR = daemonDir;
  await fsp.writeFile(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: 'network', projects: [{ id: 'degraded-proj', agent_id: 'degraded.gm', path: projectDir }],
  }));
  const { getBrainSyncHealthPath } = await import('../../lib/daemon/brain-asset-sync.mjs');
  await fsp.writeFile(getBrainSyncHealthPath('degraded.gm'), JSON.stringify({
    brainId: 'degraded.gm', pid: process.pid, degraded: true, consecutiveFailedCycles: 3,
  }) + '\n');
  agentStatusImpl = async (name: string) => ({ name, state: 'running', pid: process.pid, platform: 'launchd' });
  try {
    const { logs } = await runCommand(['daemon', 'health', '--json']);
    const payload = JSON.parse(logs.join('\n'));
    const service = payload.brains[0].services.find((entry: any) => entry.type === 'brain-asset-sync');
    expect(service.healthy).toBe(false);
    expect(service.syncHealth).toMatchObject({ brainId: 'degraded.gm', degraded: true });
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    delete process.env.AGENTBOOTUP_DAEMON_DIR;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    await fsp.rm(daemonDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daemon health --json preserves nested conflicts under inherited numeric and schema setters', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-health-prototype-'));
  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'health-prototype-'));
  const daemonDir = await fsp.mkdtemp(path.join(tmpDir, 'daemon-health-prototype-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  process.env.AGENTBOOTUP_DAEMON_DIR = daemonDir;
  await fsp.writeFile(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: 'network',
    projects: [{ id: 'prototype', agent_id: 'prototype.gm', path: projectDir }],
  }));
  const { getBrainSyncHealthPath } = await import('../../lib/daemon/brain-asset-sync.mjs');
  await fsp.writeFile(getBrainSyncHealthPath('prototype.gm'), JSON.stringify({
    brainId: 'prototype.gm',
    consecutiveFailedCycles: 1,
    lastSyncAt: '2026-08-12T00:00:00.000Z',
    lastPushed: 0,
    lastErrors: 1,
    pid: process.pid,
    degraded: false,
    memoryReplay: { pending: 0, degraded: 0, invalid: false },
    memoryConverge: {
      state: 'publish_blocked',
      detail: 'raw=SENTINEL_UNTRUSTED_DETAIL',
      failure: {
        schema: 'memory-convergence-failure/v1',
        phase: 'publish',
        category: 'conflict',
        exit_code: 3,
        conflict: {
          schema: 'memory-conflict/v1',
          conflicts: [{ path: 'memory/a.md', reason_code: 'store_changed_since_baseline' }],
          omitted_count: 0,
        },
      },
      enabled: true,
      configSource: 'default',
      store: 'server://prototype.gm',
      gateOpen: false,
      lastCycleAt: '2026-08-12T00:00:00.000Z',
      freshnessState: 'stale',
      freshnessCheckedAt: '2026-08-12T00:00:00.000Z',
      freshnessHeadCount: 2,
      escalated: false,
    },
  }) + '\n');
  agentStatusImpl = async (name: string) => ({ name, state: 'running', pid: process.pid, platform: 'launchd' });
  fetchImpl = async (url: string) => new Response(JSON.stringify(url.includes(':8766/health') ? {
    healthy: true,
    backup: { healthy: true, state: 'ok', reasons: [], authority: 'verified' },
  } : {}), { status: 200, headers: { 'content-type': 'application/json' } });

  const schema = Object.getOwnPropertyDescriptor(Object.prototype, 'schema');
  const numeric = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let wire = '';
  try {
    Object.defineProperty(Object.prototype, 'schema', {
      configurable: true,
      set(value) {
        Object.defineProperty(this, 'schema', {
          configurable: true, enumerable: true, writable: true,
          value: String(value).includes('memory-') ? 'SENTINEL_INHERITED_SCHEMA' : value,
        });
      },
    });
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set(value) {
        Object.defineProperty(this, '0', {
          configurable: true, enumerable: true, writable: true,
          value: value?.path === 'memory/a.md'
            ? { path: 'memory/SENTINEL_INHERITED.md', reason_code: 'store_changed_since_baseline' }
            : value,
        });
      },
    });
    wire = (await runCommand(['daemon', 'health', '--json'])).logs.join('\n');
  } finally {
    if (schema) Object.defineProperty(Object.prototype, 'schema', schema);
    else delete (Object.prototype as Record<string, unknown>).schema;
    if (numeric) Object.defineProperty(Array.prototype, '0', numeric);
    else delete (Array.prototype as unknown as Record<string, unknown>)['0'];
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    delete process.env.AGENTBOOTUP_DAEMON_DIR;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    await fsp.rm(daemonDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  const payload = JSON.parse(wire);
  const service = payload.brains[0].services.find((entry: any) => entry.type === 'brain-asset-sync');
  expect(service.syncHealth.memoryConverge.failure).toEqual({
    schema: 'memory-convergence-failure/v1',
    phase: 'publish',
    category: 'conflict',
    exit_code: 3,
    conflict: {
      schema: 'memory-conflict/v1',
      conflicts: [{ path: 'memory/a.md', reason_code: 'store_changed_since_baseline' }],
      omitted_count: 0,
    },
  });
  expect(wire).not.toContain('SENTINEL');
});

test('daemon health: reports an invalid replay queue as unhealthy', async () => {
  await writeCredentials();
  await writeConsentedConfig();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-health-replay-invalid-'));
  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'health-replay-invalid-'));
  const daemonDir = await fsp.mkdtemp(path.join(tmpDir, 'daemon-health-replay-invalid-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  process.env.AGENTBOOTUP_DAEMON_DIR = daemonDir;
  await fsp.writeFile(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: 'network', projects: [{ id: 'replay-invalid-proj', agent_id: 'replay-invalid.gm', path: projectDir }],
  }));
  const { getBrainSyncHealthPath } = await import('../../lib/daemon/brain-asset-sync.mjs');
  await fsp.writeFile(getBrainSyncHealthPath('replay-invalid.gm'), JSON.stringify({
    brainId: 'replay-invalid.gm', pid: process.pid, degraded: false, memoryReplay: { pending: null, degraded: 0, invalid: true },
  }) + '\n');
  agentStatusImpl = async (name: string) => ({ name, state: 'running', pid: process.pid, platform: 'launchd' });
  try {
    const { logs } = await runCommand(['daemon', 'health', '--json']);
    const payload = JSON.parse(logs.join('\n'));
    const service = payload.brains[0].services.find((entry: any) => entry.type === 'brain-asset-sync');
    expect(service).toMatchObject({ healthy: false, detail: '(memory replay queue invalid)' });
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    delete process.env.AGENTBOOTUP_DAEMON_DIR;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    await fsp.rm(daemonDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daemon health: shows unhealthy inbox when fetch throws', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-health-inbox-'));
  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'health-inbox-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'inbox-proj', agent_id: 'inbox-h.gm', path: projectDir }],
    }),
  );

  // Provision an inbox for this brain
  const agentId = 'inbox-h.gm';
  const testPort = 22000 + Math.floor(Math.random() * 900);
  const config = await import('../../lib/config/config.js');
  await config.writeConfig({
    portRegistry: { inbox: { [agentId]: testPort } },
    inboxWebhookSecrets: { [agentId]: 'g'.repeat(64) },
  });
  await config.setInboxEnabled(agentId, true);

  agentStatusImpl = async (name: string) => ({ name, state: 'running', pid: 1234, platform: 'launchd' });
  // Fetch throws (inbox not responding)
  fetchImpl = async () => { throw new Error('ECONNREFUSED'); };

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'health']);
    expect(exitCode).toBeNull();
    const output = logs.join('\n');
    // Inbox should show as unhealthy
    expect(output).toMatch(/✗/);
    expect(output).toContain('no response');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daemon health --json: emits parseable JSON with brains array', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-health-json-'));
  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'health-json-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'json-proj', agent_id: 'json-h.gm', path: projectDir }],
    }),
  );

  agentStatusImpl = async (name: string) => ({ name, state: 'running', pid: 1234, platform: 'launchd' });

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'health', '--json']);
    expect(exitCode).toBeNull();
    const payload = JSON.parse(logs.join('\n'));
    expect(Array.isArray(payload.brains)).toBe(true);
    expect(payload.summary).toBeDefined();
    expect(typeof payload.summary.total).toBe('number');
    expect(typeof payload.summary.healthy).toBe('number');
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('daemon health: summary counts healthy vs total correctly', async () => {
  await writeCredentials();
  await writeConsentedConfig();

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-health-summary-'));
  const networkRoot = await fsp.mkdtemp(path.join(tmpDir, 'health-summary-'));
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  await fsp.writeFile(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'summary-proj', agent_id: 'summary.gm', path: projectDir }],
    }),
  );

  // brain-asset-sync is healthy; transcript-sync is unhealthy
  agentStatusImpl = async (name: string) => {
    if (name === 'agentbootup-brain-summary-proj') {
      return { name, state: 'running', pid: 1234, platform: 'launchd' };
    }
    return { name, state: 'stopped', platform: 'launchd' };
  };

  try {
    const { exitCode, logs } = await runCommand(['daemon', 'health']);
    expect(exitCode).toBeNull();
    const output = logs.join('\n');
    expect(output).toContain('Summary:');
    // Should show N/M format
    expect(output).toMatch(/\d+\/\d+ healthy/);
  } finally {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    await fsp.rm(networkRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
