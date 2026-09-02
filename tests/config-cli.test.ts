import { afterAll, beforeEach, expect, test } from 'bun:test';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { writeCredentials } from '../lib/auth/credentials.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-config-cli-test-'));
const credFile = path.join(tmpDir, 'credentials');
const originalEnvCredsFile = process.env.AGENTBOOTUP_CREDS_FILE;
const originalFetch = globalThis.fetch;
process.env.AGENTBOOTUP_CREDS_FILE = credFile;

afterAll(async () => {
  if (originalEnvCredsFile === undefined) {
    delete process.env.AGENTBOOTUP_CREDS_FILE;
  } else {
    process.env.AGENTBOOTUP_CREDS_FILE = originalEnvCredsFile;
  }
  // @ts-ignore
  globalThis.fetch = originalFetch;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fsp.rm(credFile, { recursive: true, force: true }).catch(() => {});
  // @ts-ignore
  globalThis.fetch = undefined;
});

async function runConfig(argv: string[]) {
  const { runConfigCommand } = await import('../lib/config/config-cli.js');
  const errs: string[] = [];
  const origError = console.error;
  const origExit = process.exit;
  let exitCode: number | null = null;
  console.error = (...args: unknown[]) => errs.push(args.join(' '));
  // @ts-ignore
  process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`process.exit(${code})`); };

  try {
    await runConfigCommand(argv);
  } catch (err: any) {
    if (!String(err?.message).startsWith('process.exit(')) {
      throw err;
    }
  } finally {
    console.error = origError;
    process.exit = origExit;
  }

  return { exitCode, errs };
}

test('config list-brains reports undecryptable credentials explicitly', async () => {
  await fsp.writeFile(credFile, crypto.randomBytes(64));
  const { exitCode, errs } = await runConfig(['config', 'list-brains']);
  expect(exitCode).toBe(1);
  expect(errs.join('\n')).toContain('cannot be decrypted on this host');
});

test('config list-brains reports credential read failures explicitly', async () => {
  await fsp.mkdir(credFile, { recursive: true });
  const { exitCode, errs } = await runConfig(['config', 'list-brains']);
  expect(exitCode).toBe(1);
  expect(errs.join('\n')).toContain('could not be read on this host');
});

test('config list-brains explains server-side registration when no brains are registered', async () => {
  await writeCredentials({ apiKey: 'test-key', serverUrl: 'https://agentbootup.test' });
  // @ts-ignore
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { brains: [], total: 0 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    const { exitCode } = await runConfig(['config', 'list-brains']);
    expect(exitCode).toBeNull();
  } finally {
    console.log = origLog;
  }

  expect(logs.join('\n')).toContain('No brains registered on the current server');
  expect(logs.join('\n')).toContain(
    'Local brain links or cross-brain messaging (ADMP) registration do not create server-side restore entries',
  );
});
