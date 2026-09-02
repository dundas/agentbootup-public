/**
 * Tests for brain link / unlink / remove commands
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { writeCredentials } from '../../lib/auth/credentials.js';

// Set up isolated config + network root
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-brain-link-'));
let networkRoot: string;
let configFile: string;
let credsFile: string;
const originalEnvCredsFile = process.env.AGENTBOOTUP_CREDS_FILE;
const originalFetch = globalThis.fetch;

const { runBrainLink, runBrainUnlink, runBrainRemove, runBrainList } = await import('../../lib/brain/link.js');

function makeIO() {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    io: {
      stdout: (l: string) => logs.push(l),
      stderr: (l: string) => errs.push(l),
    },
    logs,
    errs,
  };
}

function writeNetworkConfig(config: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
}

function readNetworkConfig() {
  return JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
}

beforeEach(async () => {
  // Fresh network root per test
  networkRoot = path.join(tmpDir, `network-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(networkRoot, { recursive: true });

  // Point global config at our network root
  configFile = path.join(tmpDir, `config-${Date.now()}.json`);
  credsFile = path.join(tmpDir, `credentials-${Date.now()}.json`);
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  fs.writeFileSync(configFile, JSON.stringify({ _version: 1, networkRoot }, null, 2));
  // @ts-ignore
  globalThis.fetch = undefined;

  // Create base config
  writeNetworkConfig({
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'alpha', agent_id: 'alpha.gm', path: '~/dev_env/alpha' },
      { id: 'beta', agent_id: 'beta.gm' },
    ],
  });
});

afterAll(async () => {
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
  if (originalEnvCredsFile === undefined) {
    delete process.env.AGENTBOOTUP_CREDS_FILE;
  } else {
    process.env.AGENTBOOTUP_CREDS_FILE = originalEnvCredsFile;
  }
  // @ts-ignore
  globalThis.fetch = originalFetch;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── brain link ───────────────────────────────────────────────────────────────

describe('brain link', () => {
  test('links brain to CWD when no --path', async () => {
    const origCwd = process.cwd();
    const projectDir = path.join(networkRoot, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    try {
      const { io, logs } = makeIO();
      const code = await runBrainLink(['beta.gm'], io);
      expect(code).toBe(0);
      expect(logs.some((l: string) => l.includes('Linked beta.gm'))).toBe(true);

      const config = readNetworkConfig();
      const proj = config.projects.find((p: any) => p.agent_id === 'beta.gm');
      expect(proj.path).toBe('./my-project');
    } finally {
      process.chdir(origCwd);
    }
  });

  test('links brain to explicit --path', async () => {
    const projectDir = path.join(networkRoot, 'explicit-proj');
    fs.mkdirSync(projectDir, { recursive: true });

    const { io, logs } = makeIO();
    const code = await runBrainLink(['beta.gm', '--path', projectDir], io);
    expect(code).toBe(0);
    expect(logs.some((l: string) => l.includes('Linked beta.gm'))).toBe(true);

    const config = readNetworkConfig();
    const proj = config.projects.find((p: any) => p.agent_id === 'beta.gm');
    expect(proj.path).toBe('./explicit-proj');
  });

  test('stores ./relative when under network root', async () => {
    const projectDir = path.join(networkRoot, 'sub', 'deep');
    fs.mkdirSync(projectDir, { recursive: true });

    const { io } = makeIO();
    await runBrainLink(['beta.gm', '--path', projectDir], io);

    const config = readNetworkConfig();
    const proj = config.projects.find((p: any) => p.agent_id === 'beta.gm');
    expect(proj.path).toBe('./sub/deep');
  });

  test('stores absolute path when outside network root', async () => {
    const outsideDir = path.join(tmpDir, 'outside-project');
    fs.mkdirSync(outsideDir, { recursive: true });

    const { io } = makeIO();
    await runBrainLink(['beta.gm', '--path', outsideDir], io);

    const config = readNetworkConfig();
    const proj = config.projects.find((p: any) => p.agent_id === 'beta.gm');
    // Should be absolute or ~/ relative, not ./
    expect(proj.path.startsWith('./')).toBe(false);
  });

  test('updates existing entry path', async () => {
    const projectDir = path.join(networkRoot, 'new-path');
    fs.mkdirSync(projectDir, { recursive: true });

    const { io } = makeIO();
    await runBrainLink(['alpha.gm', '--path', projectDir], io);

    const config = readNetworkConfig();
    const proj = config.projects.find((p: any) => p.agent_id === 'alpha.gm');
    expect(proj.path).toBe('./new-path');
  });

  test('prints warning when re-linking to different path', async () => {
    const projectDir = path.join(networkRoot, 'different-path');
    fs.mkdirSync(projectDir, { recursive: true });

    const { io, logs } = makeIO();
    await runBrainLink(['alpha.gm', '--path', projectDir], io);

    expect(logs.some((l: string) => l.includes('Warning') && l.includes('re-linking'))).toBe(true);
  });

  test('creates minimal entry when brain not in config', async () => {
    const projectDir = path.join(networkRoot, 'new-brain');
    fs.mkdirSync(projectDir, { recursive: true });

    const { io, logs } = makeIO();
    const code = await runBrainLink(['gamma.gm', '--path', projectDir], io);
    expect(code).toBe(0);

    const config = readNetworkConfig();
    const proj = config.projects.find((p: any) => p.agent_id === 'gamma.gm');
    expect(proj).toBeDefined();
    expect(proj.id).toBe('gamma');
    expect(proj.path).toBe('./new-brain');
    expect(proj.brain).toBe(true);
  });

  test('warns when linked brain is not registered on the current server', async () => {
    const projectDir = path.join(networkRoot, 'new-brain');
    fs.mkdirSync(projectDir, { recursive: true });
    await writeCredentials({ apiKey: 'test-key', serverUrl: 'https://agentbootup.test' });
    // @ts-ignore
    globalThis.fetch = async () =>
      new Response('Not Found', { status: 404 });

    const { io, errs } = makeIO();
    const code = await runBrainLink(['gamma.gm', '--path', projectDir], io);
    expect(code).toBe(0);
    expect(
      errs.some((l: string) => l.includes('linked locally but not registered on the current server')),
    ).toBe(true);
  });

  test('warns cleanly when registration probe fails', async () => {
    const projectDir = path.join(networkRoot, 'probe-failure');
    fs.mkdirSync(projectDir, { recursive: true });
    await writeCredentials({ apiKey: 'test-key', serverUrl: 'https://agentbootup.test' });
    // @ts-ignore
    globalThis.fetch = async () => { throw 'boom'; };

    const { io, errs } = makeIO();
    const code = await runBrainLink(['gamma.gm', '--path', projectDir], io);
    expect(code).toBe(0);
    expect(
      errs.some((l: string) => l.includes('could not verify server-side registration for gamma.gm: boom')),
    ).toBe(true);
  });

  test('does not warn about registration when credentials are unavailable', async () => {
    const projectDir = path.join(networkRoot, 'no-creds');
    fs.mkdirSync(projectDir, { recursive: true });
    const previousCredsFile = process.env.AGENTBOOTUP_CREDS_FILE;
    const missingCredsFile = path.join(tmpDir, `missing-creds-${Date.now()}.json`);
    try {
      process.env.AGENTBOOTUP_CREDS_FILE = missingCredsFile;
      // @ts-ignore
      globalThis.fetch = async () => {
        throw new Error('fetch should not be called without credentials');
      };

      const { io, logs, errs } = makeIO();
      const code = await runBrainLink(['gamma.gm', '--path', projectDir], io);
      expect(code).toBe(0);
      expect(logs.some((l: string) => l.includes('server-side registration'))).toBe(false);
      expect(errs.some((l: string) => l.includes('server-side registration'))).toBe(false);
    } finally {
      if (previousCredsFile === undefined) {
        delete process.env.AGENTBOOTUP_CREDS_FILE;
      } else {
        process.env.AGENTBOOTUP_CREDS_FILE = previousCredsFile;
      }
    }
  });

  test('exits 1 when no network root configured', async () => {
    // Clear network root
    fs.writeFileSync(configFile, JSON.stringify({ _version: 1 }, null, 2));

    const { io, errs } = makeIO();
    const code = await runBrainLink(['beta.gm'], io);
    expect(code).toBe(1);
    expect(errs.some((e: string) => e.includes('no network root'))).toBe(true);
  });

  test('exits 1 when no agent-id provided', async () => {
    const { io, errs } = makeIO();
    const code = await runBrainLink([], io);
    expect(code).toBe(1);
    expect(errs.some((e: string) => e.includes('Usage'))).toBe(true);
  });

  test('exits 1 when path does not exist', async () => {
    const { io, errs } = makeIO();
    const code = await runBrainLink(['beta.gm', '--path', '/nonexistent/path'], io);
    expect(code).toBe(1);
    expect(errs.some((e: string) => e.includes('does not exist'))).toBe(true);
  });
});

// ── brain unlink ─────────────────────────────────────────────────────────────

describe('brain unlink', () => {
  test('removes path but keeps project entry', async () => {
    const { io, logs } = makeIO();
    const code = await runBrainUnlink(['alpha.gm'], io);
    expect(code).toBe(0);
    expect(logs.some((l: string) => l.includes('Unlinked alpha.gm'))).toBe(true);

    const config = readNetworkConfig();
    const proj = config.projects.find((p: any) => p.agent_id === 'alpha.gm');
    expect(proj).toBeDefined();
    expect(proj.path).toBeUndefined();
    expect(proj.id).toBe('alpha');
  });

  test('exits 1 for non-existent agent-id', async () => {
    const { io, errs } = makeIO();
    const code = await runBrainUnlink(['nonexistent.gm'], io);
    expect(code).toBe(1);
    expect(errs.some((e: string) => e.includes('no project'))).toBe(true);
  });
});

// ── brain remove ─────────────────────────────────────────────────────────────

describe('brain remove', () => {
  test('removes project entry entirely', async () => {
    const { io, logs } = makeIO();
    const code = await runBrainRemove(['alpha.gm'], io);
    expect(code).toBe(0);
    expect(logs.some((l: string) => l.includes('Removed alpha.gm'))).toBe(true);

    const config = readNetworkConfig();
    expect(config.projects.find((p: any) => p.agent_id === 'alpha.gm')).toBeUndefined();
    // beta should still be there
    expect(config.projects.find((p: any) => p.agent_id === 'beta.gm')).toBeDefined();
  });

  test('exits 1 for non-existent agent-id', async () => {
    const { io, errs } = makeIO();
    const code = await runBrainRemove(['nonexistent.gm'], io);
    expect(code).toBe(1);
    expect(errs.some((e: string) => e.includes('no project'))).toBe(true);
  });
});

// ── brain list ───────────────────────────────────────────────────────────────

describe('brain list', () => {
  test('lists all brains with correct status', async () => {
    const { io, logs } = makeIO();
    const code = await runBrainList([], io);
    expect(code).toBe(0);
    expect(logs.some((l: string) => l.includes('alpha.gm'))).toBe(true);
    expect(logs.some((l: string) => l.includes('beta.gm'))).toBe(true);
    // alpha has path (linked), beta doesn't (not linked)
    expect(logs.some((l: string) => l.includes('linked') && !l.includes('not linked'))).toBe(true);
    expect(logs.some((l: string) => l.includes('not linked'))).toBe(true);
  });

  test('shows "not linked" for brains without path', async () => {
    writeNetworkConfig({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'only', agent_id: 'only.gm' },
      ],
    });
    const { io, logs } = makeIO();
    const code = await runBrainList([], io);
    expect(code).toBe(0);
    expect(logs.some((l: string) => l.includes('not linked'))).toBe(true);
    expect(logs.some((l: string) => l.includes('(no path)'))).toBe(true);
  });
});
