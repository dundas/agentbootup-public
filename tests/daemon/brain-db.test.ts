/**
 * Tests for lib/brain/brain-db.js
 *
 * Covers provisionBrainDb(), detectPackageManager(), installLibsqlClient().
 * Uses temp directories — never touches real project files.
 */

import { test, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { pathToFileURL } from 'url';

const nativeFetch = globalThis.fetch;

function tmpDir() {
  const d = path.join(os.tmpdir(), `brain-db-test-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── Mock fetch before importing the module ────────────────────────────────────

const mockFetch = mock(async (_url: string, _opts: RequestInit) => ({
  ok: false,
  status: 404,
  text: async () => 'Not Found',
  json: async () => ({}),
}));
(globalThis as any).fetch = mockFetch;

const {
  provisionBrainDb,
  detectPackageManager,
  installLibsqlClient,
  resolveBrainSchemaPathForProject,
} = await import('../../lib/brain/brain-db.js');

// ─────────────────────────────────────────────────────────────────────────────

const BASE_OPTS = {
  brainId: 'test-brain',
  apiKey: 'test-key',
  serverUrl: 'https://agentbootup.test',
  force: false,
  dryRun: false,
  verbose: false,
};

let target: string;

beforeEach(() => {
  target = tmpDir();
  (globalThis as any).fetch = mockFetch;
  mockFetch.mockClear();
});

afterEach(() => {
  fs.rmSync(target, { recursive: true, force: true });
  (globalThis as any).fetch = nativeFetch;
});

function writeFakeLibsqlClient(projectRoot: string) {
  const pkgDir = path.join(projectRoot, 'node_modules', '@libsql', 'client');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@libsql/client', type: 'module', exports: './index.js' }, null, 2),
  );
  fs.writeFileSync(
    path.join(pkgDir, 'index.js'),
    `const state = globalThis.__brainDbTemplateState ??= { calls: [], clients: [] };

export function createClient(config) {
  state.calls.push(config);
  if (config.syncUrl && globalThis.__brainDbTemplateThrowOnSyncedCreate === true) {
    throw new Error('remote unavailable');
  }

  const client = {
    config,
    synced: 0,
    executed: [],
    async sync() {
      this.synced += 1;
    },
    async execute(stmt) {
      this.executed.push(stmt);
      if (stmt?.sql?.startsWith('SELECT value FROM schema_meta')) {
        return { rows: [{ value: 'ok' }] };
      }
      return { rows: [] };
    },
    async close() {},
  };

  state.clients.push(client);
  return client;
}
`,
  );
}

async function importGeneratedBrainDbModule(projectRoot: string) {
  return await import(`${pathToFileURL(path.join(projectRoot, '.brain', 'db.ts')).href}?v=${Date.now()}-${Math.random()}`);
}

// ── detectPackageManager ──────────────────────────────────────────────────────

test('detectPackageManager: returns null when no package.json', () => {
  expect(detectPackageManager(target)).toBeNull();
});

test('detectPackageManager: detects bun via bun.lockb', () => {
  fs.writeFileSync(path.join(target, 'package.json'), '{}');
  fs.writeFileSync(path.join(target, 'bun.lockb'), '');
  expect(detectPackageManager(target)).toBe('bun');
});

test('detectPackageManager: detects modern Bun via bun.lock', () => {
  fs.writeFileSync(path.join(target, 'package.json'), '{}');
  fs.writeFileSync(path.join(target, 'bun.lock'), '');
  expect(detectPackageManager(target)).toBe('bun');
});

test('detectPackageManager: detects yarn via yarn.lock', () => {
  fs.writeFileSync(path.join(target, 'package.json'), '{}');
  fs.writeFileSync(path.join(target, 'yarn.lock'), '');
  expect(detectPackageManager(target)).toBe('yarn');
});

test('detectPackageManager: detects pnpm via pnpm-lock.yaml', () => {
  fs.writeFileSync(path.join(target, 'package.json'), '{}');
  fs.writeFileSync(path.join(target, 'pnpm-lock.yaml'), '');
  expect(detectPackageManager(target)).toBe('pnpm');
});

test('detectPackageManager: falls back to npm', () => {
  fs.writeFileSync(path.join(target, 'package.json'), '{}');
  expect(detectPackageManager(target)).toBe('npm');
});

// ── installLibsqlClient ───────────────────────────────────────────────────────

test('installLibsqlClient: skips when no package.json', () => {
  // Should not throw — non-Node project is a no-op.
  expect(() => installLibsqlClient(target, { dryRun: false, verbose: false })).not.toThrow();
});

test('installLibsqlClient: skips when @libsql/client already in dependencies', () => {
  fs.writeFileSync(
    path.join(target, 'package.json'),
    JSON.stringify({ dependencies: { '@libsql/client': '^0.6.0' } }),
  );
  // Would throw if it tried to spawn bun add (no bun binary in test env for this path).
  // Since it skips, no spawn happens.
  expect(() => installLibsqlClient(target, { dryRun: true, verbose: false })).not.toThrow();
});

test('installLibsqlClient: dry-run does not execute install command', () => {
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ dependencies: {} }));
  fs.writeFileSync(path.join(target, 'bun.lockb'), '');
  // dry-run must not throw and must not install
  expect(() => installLibsqlClient(target, { dryRun: true, verbose: false })).not.toThrow();
  // No node_modules should appear
  expect(fs.existsSync(path.join(target, 'node_modules'))).toBe(false);
});

// ── provisionBrainDb — file-only mode (server 404) ────────────────────────────

test('file-only mode: db.ts and brain-schema.sql written, inbox env vars always provisioned', async () => {
  mockFetch.mockImplementationOnce(async () => ({ ok: false, status: 404, text: async () => '' }));

  const result = await provisionBrainDb({ ...BASE_OPTS, target });

  expect(result.mode).toBe('file-only');
  expect(fs.existsSync(path.join(target, '.brain/db.ts'))).toBe(true);
  expect(fs.existsSync(path.join(target, 'brain/brain-schema.sql'))).toBe(true);
  expect(fs.existsSync(path.join(target, '.brain/brain-schema.sql'))).toBe(true);
  const committed = fs.readFileSync(path.join(target, 'brain/brain-schema.sql'), 'utf-8');
  expect(fs.readFileSync(path.join(target, '.brain/brain-schema.sql'), 'utf-8')).toBe(committed);

  // BRAIN_DB_URL/BRAIN_DB_TOKEN are NOT written in file-only mode (no credentials).
  // AGENTBOOTUP_INBOX_PORT + AGENTBOOTUP_INBOX_WEBHOOK_SECRET ARE always written
  // (port + webhook secret are provisioned regardless of DB mode).
  expect(fs.existsSync(path.join(target, '.env'))).toBe(true);
  const env = fs.readFileSync(path.join(target, '.env'), 'utf-8');
  expect(env).not.toContain('BRAIN_DB_URL=');
  expect(env).not.toContain('BRAIN_DB_TOKEN=');
  expect(env).toContain('AGENTBOOTUP_INBOX_PORT=');
  expect(env).toContain('AGENTBOOTUP_INBOX_WEBHOOK_SECRET=');
});

// ── provisionBrainDb — embedded-replica mode ─────────────────────────────────

test('embedded-replica mode: .env appended with BRAIN_DB_URL and BRAIN_DB_TOKEN', async () => {
  mockFetch.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { db_url: 'https://brain-sqld.fly.dev/test-brain', db_token: 'tok123' } }),
  }));

  await provisionBrainDb({ ...BASE_OPTS, target });

  const env = fs.readFileSync(path.join(target, '.env'), 'utf-8');
  expect(env).toContain('BRAIN_DB_URL=https://brain-sqld.fly.dev/test-brain');
  expect(env).toContain('BRAIN_DB_TOKEN=tok123');
});

test('generated .brain/db.ts exports sync helpers for embedded-replica mode', async () => {
  mockFetch.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { db_url: 'https://brain-sqld.fly.dev/test-brain', db_token: 'tok123' } }),
  }));

  await provisionBrainDb({ ...BASE_OPTS, target });
  writeFakeLibsqlClient(target);
  (globalThis as any).__brainDbTemplateState = { calls: [], clients: [] };
  (globalThis as any).__brainDbTemplateThrowOnSyncedCreate = false;
  process.env.BRAIN_DB_URL = 'https://brain-sqld.fly.dev/test-brain';
  process.env.BRAIN_DB_TOKEN = 'tok123';

  try {
    const mod = await importGeneratedBrainDbModule(target) as {
      brainDbMode: string;
      syncDb: () => Promise<void>;
      verifySyncHealth: () => Promise<boolean>;
    };

    expect(mod.brainDbMode).toBe('embedded-replica');
    await mod.syncDb();
    expect((globalThis as any).__brainDbTemplateState.calls[0]).toEqual({
      url: 'file:.brain/brain.db',
      syncUrl: 'https://brain-sqld.fly.dev/test-brain',
      authToken: 'tok123',
      syncInterval: 300,
    });
    expect((globalThis as any).__brainDbTemplateState.clients[0].synced).toBe(1);
    await expect(mod.verifySyncHealth()).resolves.toBe(true);
    expect((globalThis as any).__brainDbTemplateState.calls[1]).toEqual({
      url: 'https://brain-sqld.fly.dev/test-brain',
      authToken: 'tok123',
    });
  } finally {
    delete process.env.BRAIN_DB_URL;
    delete process.env.BRAIN_DB_TOKEN;
    delete (globalThis as any).__brainDbTemplateState;
    delete (globalThis as any).__brainDbTemplateThrowOnSyncedCreate;
  }
});

test('generated .brain/db.ts falls back to local mode when sync client creation fails', async () => {
  mockFetch.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { db_url: 'https://brain-sqld.fly.dev/test-brain', db_token: 'tok123' } }),
  }));

  await provisionBrainDb({ ...BASE_OPTS, target });
  writeFakeLibsqlClient(target);
  (globalThis as any).__brainDbTemplateState = { calls: [], clients: [] };
  (globalThis as any).__brainDbTemplateThrowOnSyncedCreate = true;
  process.env.BRAIN_DB_URL = 'https://brain-sqld.fly.dev/test-brain';
  process.env.BRAIN_DB_TOKEN = 'tok123';

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));

  try {
    const mod = await importGeneratedBrainDbModule(target) as {
      brainDbMode: string;
      syncDb: () => Promise<void>;
      verifySyncHealth: () => Promise<boolean>;
    };

    expect(mod.brainDbMode).toBe('embedded-replica-offline');
    expect((globalThis as any).__brainDbTemplateState.calls).toEqual([
      {
        url: 'file:.brain/brain.db',
        syncUrl: 'https://brain-sqld.fly.dev/test-brain',
        authToken: 'tok123',
        syncInterval: 300,
      },
      {
        url: 'file:.brain/brain.db',
      },
    ]);
    await expect(mod.syncDb()).resolves.toBeUndefined();
    await expect(mod.verifySyncHealth()).resolves.toBe(false);
    expect(warnings.join('\n')).toContain('continuing with local replica');
  } finally {
    console.warn = originalWarn;
    delete process.env.BRAIN_DB_URL;
    delete process.env.BRAIN_DB_TOKEN;
    delete (globalThis as any).__brainDbTemplateState;
    delete (globalThis as any).__brainDbTemplateThrowOnSyncedCreate;
  }
});

// ── .gitignore ────────────────────────────────────────────────────────────────

test('appends .brain/brain.db to .gitignore', async () => {
  mockFetch.mockImplementationOnce(async () => ({ ok: false, status: 404, text: async () => '' }));

  await provisionBrainDb({ ...BASE_OPTS, target });

  const gitignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf-8');
  expect(gitignore).toContain('.brain/brain.db');
});

test('idempotent: re-running does not duplicate .gitignore entry', async () => {
  mockFetch.mockImplementation(async () => ({ ok: false, status: 404, text: async () => '' }));

  await provisionBrainDb({ ...BASE_OPTS, target });
  await provisionBrainDb({ ...BASE_OPTS, target, force: true });

  const gitignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf-8');
  const count = gitignore.split('\n').filter((l) => l.trim() === '.brain/brain.db').length;
  expect(count).toBe(1);
});

test('idempotent: re-running does not duplicate .env entries', async () => {
  const provisionResp = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { db_url: 'https://brain-sqld.fly.dev/test-brain', db_token: 'tok123' } }),
  });
  mockFetch.mockImplementation(provisionResp);

  await provisionBrainDb({ ...BASE_OPTS, target });
  await provisionBrainDb({ ...BASE_OPTS, target, force: true });

  const env = fs.readFileSync(path.join(target, '.env'), 'utf-8');
  const urlCount = env.split('\n').filter((l) => l.startsWith('BRAIN_DB_URL=')).length;
  expect(urlCount).toBe(1);
});

test('force: --force updates existing BRAIN_DB_TOKEN in .env (token refresh)', async () => {
  mockFetch
    .mockImplementationOnce(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { db_url: 'https://brain-sqld.fly.dev/test-brain', db_token: 'old-token' } }),
    }))
    .mockImplementationOnce(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { db_url: 'https://brain-sqld.fly.dev/test-brain', db_token: 'new-token' } }),
    }));

  await provisionBrainDb({ ...BASE_OPTS, target });
  await provisionBrainDb({ ...BASE_OPTS, target, force: true });

  const env = fs.readFileSync(path.join(target, '.env'), 'utf-8');
  // Token should be updated to new value, not the old one.
  expect(env).toContain('BRAIN_DB_TOKEN=new-token');
  expect(env).not.toContain('BRAIN_DB_TOKEN=old-token');
  // Should appear exactly once (no duplicate).
  const tokenCount = env.split('\n').filter((l) => l.startsWith('BRAIN_DB_TOKEN=')).length;
  expect(tokenCount).toBe(1);
});

// ── dry-run ───────────────────────────────────────────────────────────────────

test('dry-run: writes no files', async () => {
  mockFetch.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { db_url: 'https://brain-sqld.fly.dev/test-brain', db_token: 'tok123' } }),
  }));

  await provisionBrainDb({ ...BASE_OPTS, target, dryRun: true });

  expect(fs.existsSync(path.join(target, '.brain/db.ts'))).toBe(false);
  expect(fs.existsSync(path.join(target, 'brain/brain-schema.sql'))).toBe(false);
  expect(fs.existsSync(path.join(target, '.brain/brain-schema.sql'))).toBe(false);
  expect(fs.existsSync(path.join(target, '.env'))).toBe(false);
  expect(fs.existsSync(path.join(target, '.gitignore'))).toBe(false);
});

// ── regression guards ─────────────────────────────────────────────────────────

test('regression: session-hooks.ts is never written', async () => {
  mockFetch.mockImplementation(async () => ({ ok: false, status: 404, text: async () => '' }));

  await provisionBrainDb({ ...BASE_OPTS, target });

  expect(fs.existsSync(path.join(target, '.brain/session-hooks.ts'))).toBe(false);
});

test('regression: .claude/settings.json is never touched', async () => {
  mockFetch.mockImplementation(async () => ({ ok: false, status: 404, text: async () => '' }));

  await provisionBrainDb({ ...BASE_OPTS, target });

  expect(fs.existsSync(path.join(target, '.claude/settings.json'))).toBe(false);
});

// ── restore.js Phase 4 integration ───────────────────────────────────────────
// Tests that runBrainRestore wires Phase 4 correctly without needing
// a live server. Uses AGENTBOOTUP_CREDS_FILE to inject temp credentials.

const { writeCredentials } = await import('../../lib/auth/credentials.js');
const { runBrainRestore } = await import('../../lib/brain/restore.js');

// Minimal boot-bundle response (empty asset list — we only care about Phase 4).
const BOOT_BUNDLE_RESP = {
  ok: true, status: 200,
  json: async () => ({ data: { brain_assets: [] } }),
  text: async () => '',
};

async function withTempCreds<T>(fn: (credsFile: string) => Promise<T>): Promise<T> {
  const dir = tmpDir();
  const credsFile = path.join(dir, 'credentials');
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  await writeCredentials({ apiKey: 'test-key', serverUrl: 'https://agentbootup.test' });
  try {
    return await fn(credsFile);
  } finally {
    delete process.env.AGENTBOOTUP_CREDS_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function captureRestoreExit(fn: () => Promise<unknown>) {
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  // @ts-ignore test seam
  process.exit = (code?: number) => {
    throw new Error(`process.exit(${code})`);
  };
  try {
    await expect(fn()).rejects.toThrow('process.exit(1)');
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
  return errors;
}

test('restore Phase 4: .brain/db.ts and brain-schema.sql written after restore', async () => {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('boot-bundle')) return BOOT_BUNDLE_RESP;
    // brain-db/provision returns file-only (404)
    return { ok: false, status: 404, text: async () => '' };
  });

  await withTempCreds(async () => {
    await runBrainRestore(['test-brain', '--target', target]);
  });

  expect(fs.existsSync(path.join(target, '.brain/db.ts'))).toBe(true);
  expect(fs.existsSync(path.join(target, 'brain/brain-schema.sql'))).toBe(true);
  expect(fs.existsSync(path.join(target, '.brain/brain-schema.sql'))).toBe(true);
});

test('resolveBrainSchemaPathForProject prefers brain/ over .brain/', () => {
  fs.mkdirSync(path.join(target, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(target, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(target, 'brain', 'brain-schema.sql'), 'committed');
  fs.writeFileSync(path.join(target, '.brain', 'brain-schema.sql'), 'runtime');
  expect(resolveBrainSchemaPathForProject(target)).toBe(path.join(target, 'brain', 'brain-schema.sql'));
});

test('resolveBrainSchemaPathForProject returns null when neither schema file exists', () => {
  expect(resolveBrainSchemaPathForProject(target)).toBeNull();
});

test('resolveBrainSchemaPathForProject falls back to .brain when brain/ missing', () => {
  fs.mkdirSync(path.join(target, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(target, '.brain', 'brain-schema.sql'), 'runtime-only');
  expect(resolveBrainSchemaPathForProject(target)).toBe(path.join(target, '.brain', 'brain-schema.sql'));
});

test('restore Phase 4: .gitignore gets .brain/brain.db entry', async () => {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('boot-bundle')) return BOOT_BUNDLE_RESP;
    return { ok: false, status: 404, text: async () => '' };
  });

  await withTempCreds(async () => {
    await runBrainRestore(['test-brain', '--target', target]);
  });

  const gitignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf-8');
  expect(gitignore).toContain('.brain/brain.db');
});

test('restore Phase 4: network failure in provisionBrainDb does NOT abort restore', async () => {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('boot-bundle')) return BOOT_BUNDLE_RESP;
    // Simulate hard network error
    throw new Error('ECONNREFUSED');
  });

  // runBrainRestore must not throw even when Phase 4 fails
  await withTempCreds(async () => {
    await expect(runBrainRestore(['test-brain', '--target', target])).resolves.toBeUndefined();
  });
});

test('brain restore uses target project agent_id before global default', async () => {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('boot-bundle')) return BOOT_BUNDLE_RESP;
    return { ok: false, status: 404, text: async () => '' };
  });

  const networkRoot = tmpDir();
  const projectPath = path.join(networkRoot, 'project-a');
  fs.mkdirSync(path.join(projectPath, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'brain', 'config.json'),
    JSON.stringify({ agentId: 'project-a-gm' }),
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2),
  );

  const cfgFile = path.join(networkRoot, 'config.json');
  process.env.AGENTBOOTUP_CONFIG_FILE = cfgFile;
  fs.writeFileSync(cfgFile, JSON.stringify({
    _version: 1,
    brainId: 'global-default.gm',
    networkRoot,
  }, null, 2));

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await withTempCreds(async () => {
      await runBrainRestore(['--target', projectPath]);
    });
  } finally {
    console.log = originalLog;
    delete process.env.AGENTBOOTUP_CONFIG_FILE;
    fs.rmSync(networkRoot, { recursive: true, force: true });
  }

  const noteLine = logs.find((line) => line.includes('note: using target project brain ID'));
  expect(noteLine).toContain('project-a-gm');
  expect(noteLine).toContain('global-default.gm');
});

test('brain restore fails before remote access when target network config is malformed', async () => {
  let fetchCalled = false;
  mockFetch.mockImplementation(async () => {
    fetchCalled = true;
    return BOOT_BUNDLE_RESP;
  });

  const networkRoot = tmpDir();
  const projectPath = path.join(networkRoot, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(networkRoot, 'agentbootup.json'), '{invalid-json');

  const cfgFile = path.join(networkRoot, 'config.json');
  process.env.AGENTBOOTUP_CONFIG_FILE = cfgFile;
  fs.writeFileSync(cfgFile, JSON.stringify({
    _version: 1,
    brainId: 'global-default.gm',
    networkRoot,
  }, null, 2));

  let errors: string[] = [];
  try {
    await withTempCreds(async () => {
      errors = await captureRestoreExit(() => runBrainRestore(['--target', projectPath]));
    });
  } finally {
    delete process.env.AGENTBOOTUP_CONFIG_FILE;
    fs.rmSync(networkRoot, { recursive: true, force: true });
  }

  expect(fetchCalled).toBe(false);
  expect(errors.join('\n')).toContain('invalid JSON');
});

test('brain restore accepts target project config agentId before global default', async () => {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('boot-bundle')) return BOOT_BUNDLE_RESP;
    return { ok: false, status: 404, text: async () => '' };
  });

  const projectPath = tmpDir();
  fs.writeFileSync(
    path.join(projectPath, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agentId: 'infinitrade' }, null, 2),
  );

  const cfgFile = path.join(projectPath, 'config.json');
  process.env.AGENTBOOTUP_CONFIG_FILE = cfgFile;
  fs.writeFileSync(cfgFile, JSON.stringify({
    _version: 1,
    brainId: 'global-default.gm',
  }, null, 2));

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await withTempCreds(async () => {
      await runBrainRestore(['--target', projectPath]);
    });
  } finally {
    console.log = originalLog;
    delete process.env.AGENTBOOTUP_CONFIG_FILE;
    fs.rmSync(projectPath, { recursive: true, force: true });
  }

  expect(logs.some((line) => line.includes('using target project brain ID infinitrade'))).toBe(true);
  expect(logs.some((line) => line.includes('Brain restore complete (brain: infinitrade, branch: default)'))).toBe(true);
});

test('brain restore fails before remote access when target project identity disagrees with network', async () => {
  let fetchCalled = false;
  mockFetch.mockImplementation(async () => {
    fetchCalled = true;
    return BOOT_BUNDLE_RESP;
  });

  const networkRoot = tmpDir();
  const projectPath = path.join(networkRoot, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: 'infinitrade' }, null, 2),
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'other-brain.gm' }],
    }, null, 2),
  );

  const cfgFile = path.join(networkRoot, 'config.json');
  process.env.AGENTBOOTUP_CONFIG_FILE = cfgFile;
  fs.writeFileSync(cfgFile, JSON.stringify({
    _version: 1,
    brainId: 'global-default.gm',
    networkRoot,
  }, null, 2));

  let errors: string[] = [];
  try {
    await withTempCreds(async () => {
      errors = await captureRestoreExit(() => runBrainRestore(['--target', projectPath]));
    });
  } finally {
    delete process.env.AGENTBOOTUP_CONFIG_FILE;
    fs.rmSync(networkRoot, { recursive: true, force: true });
  }

  expect(fetchCalled).toBe(false);
  expect(errors.join('\n')).toContain('other-brain.gm');
  expect(errors.join('\n')).toContain('refusing to choose a brain');
});

test('brain restore fails before remote access when a project target has conflicting identity keys', async () => {
  let fetchCalled = false;
  mockFetch.mockImplementation(async () => {
    fetchCalled = true;
    return BOOT_BUNDLE_RESP;
  });
  const projectPath = tmpDir();
  fs.mkdirSync(path.join(projectPath, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
  );
  try {
    let errors: string[] = [];
    await withTempCreds(async () => {
      errors = await captureRestoreExit(() => runBrainRestore(['snake.gm', '--target', projectPath]));
    });
    expect(fetchCalled).toBe(false);
    expect(errors.join('\n')).toContain('agent_id');
    expect(errors.join('\n')).toContain('agentId');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('brain restore fails before remote access when a linked project target has no local identity', async () => {
  let fetchCalled = false;
  mockFetch.mockImplementation(async () => {
    fetchCalled = true;
    return BOOT_BUNDLE_RESP;
  });
  const networkRoot = tmpDir();
  const projectPath = path.join(networkRoot, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [{ id: 'project-a', path: projectPath, agent_id: 'network-only.gm' }],
  }));
  const cfgFile = path.join(networkRoot, 'config.json');
  process.env.AGENTBOOTUP_CONFIG_FILE = cfgFile;
  fs.writeFileSync(cfgFile, JSON.stringify({
    _version: 1,
    brainId: 'global-default.gm',
    networkRoot,
  }));
  try {
    let errors: string[] = [];
    await withTempCreds(async () => {
      errors = await captureRestoreExit(() => runBrainRestore(['--target', projectPath]));
    });
    expect(fetchCalled).toBe(false);
    expect(errors.join('\n')).toContain('No non-empty project agent ID');
  } finally {
    delete process.env.AGENTBOOTUP_CONFIG_FILE;
    fs.rmSync(networkRoot, { recursive: true, force: true });
  }
});

test('brain restore rejects a positional ID that conflicts with a valid local target identity', async () => {
  let fetchCalled = false;
  mockFetch.mockImplementation(async () => {
    fetchCalled = true;
    return BOOT_BUNDLE_RESP;
  });
  const projectPath = tmpDir();
  fs.mkdirSync(path.join(projectPath, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'brain', 'config.json'),
    JSON.stringify({ agentId: 'local.gm' }),
  );
  try {
    let errors: string[] = [];
    await withTempCreds(async () => {
      errors = await captureRestoreExit(() => runBrainRestore(['other.gm', '--target', projectPath]));
    });
    expect(fetchCalled).toBe(false);
    expect(errors.join('\n')).toContain('positional brain ID');
    expect(errors.join('\n')).toContain('local.gm');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('brain restore reports undecryptable credentials explicitly', async () => {
  const credsDir = tmpDir();
  const credsFile = path.join(credsDir, 'credentials');
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  fs.writeFileSync(credsFile, crypto.randomBytes(64));

  const errs: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  let exitCode: number | null = null;
  console.error = (...args: unknown[]) => errs.push(args.join(' '));
  // @ts-ignore
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };

  try {
    await expect(runBrainRestore(['test-brain', '--target', target])).rejects.toThrow('process.exit(1)');
  } finally {
    console.error = originalError;
    process.exit = originalExit;
    delete process.env.AGENTBOOTUP_CREDS_FILE;
    fs.rmSync(credsDir, { recursive: true, force: true });
  }

  expect(exitCode).toBe(1);
  expect(errs.join('\n')).toContain('cannot be decrypted on this host');
});

test('brain restore reports credential read failures explicitly', async () => {
  const credsDir = tmpDir();
  const credsFile = path.join(credsDir, 'credentials');
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  fs.mkdirSync(credsFile, { recursive: true });

  const errs: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  let exitCode: number | null = null;
  console.error = (...args: unknown[]) => errs.push(args.join(' '));
  // @ts-ignore
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };

  try {
    await expect(runBrainRestore(['test-brain', '--target', target])).rejects.toThrow('process.exit(1)');
  } finally {
    console.error = originalError;
    process.exit = originalExit;
    delete process.env.AGENTBOOTUP_CREDS_FILE;
    fs.rmSync(credsDir, { recursive: true, force: true });
  }

  expect(exitCode).toBe(1);
  expect(errs.join('\n')).toContain('could not be read on this host');
});
