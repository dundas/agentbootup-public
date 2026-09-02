import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

import path from 'path';
import {
  writeCredentials,
  readCredentials,
  CREDS_FILE,
  exportCredentialsPayload,
  _resetAtRestKeyCache,
} from '../../lib/auth/credentials.js';
import {
  handleAuthLogin,
  handleAuthStatus,
  handleAuthExport,
  handleAuthImport,
  handleAuthRewrap,
  runAuthCommand,
} from '../../lib/auth/auth.js';

// Capture io output for assertions
function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    get out() { return out; },
    get err() { return err; },
  };
}

// Back up / restore real credentials around tests
let backupFile: string | null = null;
let originalExists = false;
let machineIdDir: string | null = null;
let originalMachineIdFile: string | undefined;

beforeEach(async () => {
  // writeCredentials() now derives its key from the machine identity, and getMachineId()
  // creates ~/.agentbootup/machine-id on the real host when absent. Point it at a tmp
  // path so a test run never mints the machine's real identity.
  originalMachineIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  machineIdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-auth-machine-id-'));
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(machineIdDir, 'machine-id');
  _resetAtRestKeyCache();

  originalExists = fs.existsSync(CREDS_FILE);
  if (originalExists) {
    backupFile = CREDS_FILE + '.auth-test-backup';
    fs.copyFileSync(CREDS_FILE, backupFile);
  }
  if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE);
  // Reset exitCode before each test
  process.exitCode = 0;
});

afterEach(() => {
  if (originalMachineIdFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  else process.env.AGENTBOOTUP_MACHINE_ID_FILE = originalMachineIdFile;
  if (machineIdDir) fs.rmSync(machineIdDir, { recursive: true, force: true });
  machineIdDir = null;
  _resetAtRestKeyCache();

  if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE);
  if (originalExists && backupFile && fs.existsSync(backupFile)) {
    fs.copyFileSync(backupFile, CREDS_FILE);
    fs.unlinkSync(backupFile);
  } else if (backupFile && fs.existsSync(backupFile)) {
    fs.unlinkSync(backupFile);
  }
  process.exitCode = 0;
});

describe('handleAuthLogin', () => {
  test('valid args write credentials and print confirmation', async () => {
    const io = makeIo();
    await handleAuthLogin(['--api-key', 'my-key-abc', '--server-url', 'https://custom.example.com'], io);
    expect(process.exitCode).toBe(0);
    expect(io.out.some(l => l.includes('Credentials saved'))).toBe(true);
    expect(io.out.some(l => l.includes('https://custom.example.com'))).toBe(true);
  });

  test('written credentials are persisted and readable', async () => {
    const io = makeIo();
    await handleAuthLogin(['--api-key', 'persist-key', '--server-url', 'https://srv.example.com'], io);
    const creds = await readCredentials();
    expect(creds?.apiKey).toBe('persist-key');
    expect(creds?.serverUrl).toBe('https://srv.example.com');
  });

  test('defaults to agentbootup.fly.dev when --server-url omitted', async () => {
    const io = makeIo();
    await handleAuthLogin(['--api-key', 'my-key'], io);
    const creds = await readCredentials();
    expect(creds?.serverUrl).toBe('https://agentbootup.fly.dev');
  });

  test('interactive login without --api-key saves polled credentials', async () => {
    let pollCalls = 0;
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/v1/device-auth/start')) {
        return new Response(JSON.stringify({
          data: {
            device_code: 'device-abc',
            user_code: 'WXYZ-9999',
            verification_uri: 'https://agentbootup.fly.dev/developer/device?code=WXYZ-9999',
            expires_in: 60,
            interval: 0.001,
          },
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      pollCalls += 1;
      if (pollCalls === 1) {
        return new Response(JSON.stringify({ data: { status: 'pending' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        data: {
          status: 'approved',
          api_key: 'abu_live_interactive_secret',
          key_id: 'key_interactive',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const io = makeIo();
    await handleAuthLogin([], io, { fetchImpl, openBrowser: () => {} });
    expect(process.exitCode).toBe(0);
    expect(io.out.some(l => l.includes('Verification URL'))).toBe(true);
    expect(io.out.some(l => l.includes('WXYZ-9999'))).toBe(true);
    const creds = await readCredentials();
    expect(creds?.apiKey).toBe('abu_live_interactive_secret');
    expect(creds?.serverUrl).toBe('https://agentbootup.fly.dev');
  });

  test('empty --api-key value prints notice and uses interactive login path', async () => {
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/v1/device-auth/start')) {
        return new Response(JSON.stringify({
          data: {
            device_code: 'device-empty',
            user_code: 'EMPTY-0001',
            verification_uri: 'https://custom.example.com/developer/device?code=EMPTY-0001',
            expires_in: 60,
            interval: 0.001,
          },
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: { status: 'approved', api_key: 'abu_live_from_empty' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const io = makeIo();
    await handleAuthLogin(['--api-key', '   ', '--server-url', 'https://custom.example.com'], io, {
      fetchImpl,
      openBrowser: () => {},
    });
    expect(process.exitCode).toBe(0);
    expect(io.err.some(l => l.includes('starting interactive login instead'))).toBe(true);
    const creds = await readCredentials();
    expect(creds?.apiKey).toBe('abu_live_from_empty');
  });

  test('interactive login with --no-browser does not open browser', async () => {
    let browserOpened = false;
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/v1/device-auth/start')) {
        return new Response(JSON.stringify({
          data: {
            device_code: 'device-nobrowser',
            user_code: 'NOBR-0001',
            verification_uri: 'https://agentbootup.fly.dev/developer/device?code=NOBR-0001',
            expires_in: 60,
            interval: 0.001,
          },
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: { status: 'approved', api_key: 'abu_live_no_browser' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const io = makeIo();
    await handleAuthLogin(['--no-browser'], io, {
      fetchImpl,
      openBrowser: () => { browserOpened = true; },
    });
    expect(browserOpened).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  test('trims whitespace from api key before writing', async () => {
    const io = makeIo();
    await handleAuthLogin(['--api-key', '  trimmed-key  '], io);
    const creds = await readCredentials();
    expect(creds?.apiKey).toBe('trimmed-key');
  });

  test('invalid --server-url (non-parseable) sets exitCode 1 and prints error', async () => {
    const io = makeIo();
    await handleAuthLogin(['--api-key', 'my-key', '--server-url', 'not-a-url'], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('server-url'))).toBe(true);
  });

  test('non-http(s) --server-url (e.g. file://) sets exitCode 1', async () => {
    const io = makeIo();
    await handleAuthLogin(['--api-key', 'my-key', '--server-url', 'file:///etc/passwd'], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('server-url'))).toBe(true);
  });
});

describe('handleAuthStatus', () => {
  test('no credentials: sets exitCode 1 and prints not-configured message', async () => {
    const io = makeIo();
    await handleAuthStatus(io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('Not configured'))).toBe(true);
    expect(io.err.some(l => l.includes('auth login'))).toBe(true);
  });

  test('undecryptable credentials: sets exitCode 1 and prints recovery message', async () => {
    fs.writeFileSync(CREDS_FILE, crypto.randomBytes(64), { mode: 0o600 });
    const io = makeIo();
    await handleAuthStatus(io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('cannot be decrypted on this host'))).toBe(true);
    expect(io.err.some(l => l.includes('auth login'))).toBe(true);
  });

  test('with credentials: exits 0 and prints masked API key', async () => {
    await writeCredentials({ apiKey: 'abcd-full-key-12345', serverUrl: 'https://example.com' });
    const io = makeIo();
    await handleAuthStatus(io);
    expect(process.exitCode).toBe(0);
    // Key should be masked (shows first 4 chars + asterisks)
    expect(io.out.some(l => l.includes('abcd') && l.includes('*'))).toBe(true);
    expect(io.out.some(l => l.includes('https://example.com'))).toBe(true);
    expect(io.out.some(l => l.includes('supports auth export/auth import'))).toBe(true);
  });

  test('masked key does not reveal full API key', async () => {
    const fullKey = 'abcd-full-key-12345';
    await writeCredentials({ apiKey: fullKey, serverUrl: 'https://example.com' });
    const io = makeIo();
    await handleAuthStatus(io);
    const allOutput = [...io.out, ...io.err].join('\n');
    expect(allOutput).not.toContain(fullKey);
  });
});

describe('handleAuthExport', () => {
  test('exports a host-bound payload for a configured machine', async () => {
    await writeCredentials({ apiKey: 'export-key', serverUrl: 'https://example.com' });
    const io = makeIo();
    await handleAuthExport(['--for-host', os.hostname(), '--json'], io);
    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(io.out.join('\n'));
    expect(payload.target_hostname).toBe(os.hostname());
    expect(payload.ciphertext).toBeTruthy();
    expect(payload.source_hostname).toBeUndefined();
  });

  test('requires --for-host', async () => {
    await writeCredentials({ apiKey: 'export-key', serverUrl: 'https://example.com' });
    const io = makeIo();
    await handleAuthExport([], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('--for-host'))).toBe(true);
  });

  test('reports undecryptable local credentials during export', async () => {
    fs.writeFileSync(CREDS_FILE, crypto.randomBytes(64), { mode: 0o600 });
    const io = makeIo();
    await handleAuthExport(['--for-host', os.hostname()], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('cannot be decrypted on this host'))).toBe(true);
  });

  test('reports local credential read failures during export', async () => {
    const blockedDir = fs.mkdtempSync(CREDS_FILE + '.export-dir-');
    const originalEnv = process.env.AGENTBOOTUP_CREDS_FILE;
    process.env.AGENTBOOTUP_CREDS_FILE = blockedDir;
    try {
      const io = makeIo();
      await handleAuthExport(['--for-host', os.hostname()], io);
      expect(process.exitCode).toBe(1);
      expect(io.err.some(l => l.includes('could not be read on this host'))).toBe(true);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AGENTBOOTUP_CREDS_FILE;
      } else {
        process.env.AGENTBOOTUP_CREDS_FILE = originalEnv;
      }
      fs.rmSync(blockedDir, { recursive: true, force: true });
    }
  });
});

describe('handleAuthImport', () => {
  test('imports a valid host-bound payload into the local credentials store', async () => {
    const payload = exportCredentialsPayload(
      { apiKey: 'import-key', serverUrl: 'https://example.com' },
      os.hostname()
    );
    const io = makeIo();
    await handleAuthImport([], { ...io, readStdin: async () => payload });
    expect(process.exitCode).toBe(0);
    const creds = await readCredentials();
    expect(creds).toEqual({ apiKey: 'import-key', serverUrl: 'https://example.com' });
  });

  test('rejects invalid payload input', async () => {
    const io = makeIo();
    await handleAuthImport([], { ...io, readStdin: async () => '{"bad":true}' });
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('Error importing credentials'))).toBe(true);
  });

  test('imports a payload from --payload-file', async () => {
    const payload = exportCredentialsPayload(
      { apiKey: 'file-import-key', serverUrl: 'https://example.com' },
      os.hostname()
    );
    const payloadPath = CREDS_FILE + '.handoff';
    fs.writeFileSync(payloadPath, payload);
    try {
      const io = makeIo();
      await handleAuthImport(['--payload-file', payloadPath], io);
      expect(process.exitCode).toBe(0);
      const creds = await readCredentials();
      expect(creds?.apiKey).toBe('file-import-key');
    } finally {
      if (fs.existsSync(payloadPath)) {
        fs.unlinkSync(payloadPath);
      }
    }
  });

  test('rejects wrong-host payload through the command handler', async () => {
    const payload = exportCredentialsPayload(
      { apiKey: 'wrong-host-key', serverUrl: 'https://example.com' },
      'definitely-not-this-host'
    );
    const io = makeIo();
    await handleAuthImport([], { ...io, readStdin: async () => payload });
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('not this host'))).toBe(true);
  });
});

describe('runAuthCommand', () => {
  test('auth login routes to handleAuthLogin', async () => {
    const io = makeIo();
    await runAuthCommand(['auth', 'login', '--api-key', 'route-test-key'], io);
    expect(process.exitCode).toBe(0);
    expect(io.out.some(l => l.includes('Credentials saved'))).toBe(true);
  });

  test('auth status routes to handleAuthStatus', async () => {
    const io = makeIo();
    await runAuthCommand(['auth', 'status'], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('Not configured'))).toBe(true);
  });

  test('auth export routes to handleAuthExport', async () => {
    await writeCredentials({ apiKey: 'route-export-key', serverUrl: 'https://example.com' });
    const io = makeIo();
    await runAuthCommand(['auth', 'export', '--for-host', os.hostname(), '--json'], io);
    expect(process.exitCode).toBe(0);
    expect(() => JSON.parse(io.out.join('\n'))).not.toThrow();
  });

  test('auth import routes to handleAuthImport', async () => {
    const payload = exportCredentialsPayload(
      { apiKey: 'route-import-key', serverUrl: 'https://example.com' },
      os.hostname()
    );
    const io = makeIo();
    await runAuthCommand(['auth', 'import'], { ...io, readStdin: async () => payload });
    expect(process.exitCode).toBe(0);
    const creds = await readCredentials();
    expect(creds?.apiKey).toBe('route-import-key');
  });

  test('unknown subcommand sets exitCode 1 and lists available subcommands', async () => {
    const io = makeIo();
    await runAuthCommand(['auth', 'unknown'], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some(l => l.includes('login'))).toBe(true);
    expect(io.err.some(l => l.includes('export'))).toBe(true);
    expect(io.err.some(l => l.includes('import'))).toBe(true);
    expect(io.err.some(l => l.includes('status'))).toBe(true);
  });

  test('missing subcommand sets exitCode 1', async () => {
    const io = makeIo();
    await runAuthCommand(['auth'], io);
    expect(process.exitCode).toBe(1);
  });
});


// Writes a legacy v1 credentials file: scryptSync(hostname + 'agentbootup-v1', SALT),
// then raw iv|tag|ciphertext with no header — the pre-v2 on-disk format.
function writeLegacyCredsFile(filePath: string, hostname: string, creds: { apiKey: string; serverUrl: string }) {
  const salt = Buffer.from('agentbootup-creds-v1-salt-32byts');
  const key = crypto.scryptSync(hostname + 'agentbootup-v1', salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
  fs.writeFileSync(filePath, Buffer.concat([iv, cipher.getAuthTag(), ct]), { mode: 0o600 });
}

describe('handleAuthRewrap', () => {
  const CREDS = { apiKey: 'rewrap-test-key', serverUrl: 'https://example.com' };
  const OLD_HOST = 'old-box-42.vpn.example.com';

  test('missing --from-hostname prints usage and sets exitCode 1', async () => {
    const io = makeIo();
    await handleAuthRewrap([], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some((l) => l.includes('--from-hostname'))).toBe(true);
  });

  test('no credentials file: reports it and sets exitCode 1', async () => {
    const io = makeIo();
    await handleAuthRewrap(['--from-hostname', OLD_HOST], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some((l) => l.includes('No credentials file'))).toBe(true);
  });

  test('wrong hostname: refuses, leaves the file untouched, sets exitCode 1', async () => {
    writeLegacyCredsFile(CREDS_FILE, OLD_HOST, CREDS);
    const before = fs.readFileSync(CREDS_FILE);

    const io = makeIo();
    await handleAuthRewrap(['--from-hostname', 'some-other-host'], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some((l) => l.includes('Could not decrypt'))).toBe(true);
    expect(fs.readFileSync(CREDS_FILE).equals(before)).toBe(true);
  });

  test('a file already bound to this machine is not rewrapped', async () => {
    await writeCredentials(CREDS); // writes v2
    const io = makeIo();
    await handleAuthRewrap(['--from-hostname', os.hostname()], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some((l) => l.includes('already bound to this machine'))).toBe(true);
  });

  test('correct hostname: rewraps to v2 and the credentials read back', async () => {
    writeLegacyCredsFile(CREDS_FILE, OLD_HOST, CREDS);
    expect(fs.readFileSync(CREDS_FILE).subarray(0, 4).toString('latin1')).not.toBe('ABC2');

    const io = makeIo();
    await handleAuthRewrap(['--from-hostname', OLD_HOST], io);
    expect(process.exitCode).toBe(0);
    expect(io.out.some((l) => l.includes('Rewrapped'))).toBe(true);

    expect(fs.readFileSync(CREDS_FILE).subarray(0, 5).toString('latin1')).toBe('ABC2\0');
    expect(await readCredentials()).toEqual(CREDS);
  });

  test('a corrupt machine-id fails the rewrap cleanly instead of throwing', async () => {
    // The harness already points AGENTBOOTUP_MACHINE_ID_FILE at a tmp path.
    fs.writeFileSync(process.env.AGENTBOOTUP_MACHINE_ID_FILE!, 'not-a-uuid\n');
    _resetAtRestKeyCache();

    writeLegacyCredsFile(CREDS_FILE, OLD_HOST, CREDS);
    const io = makeIo();
    await handleAuthRewrap(['--from-hostname', OLD_HOST], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some((l) => l.includes('Could not save rewrapped credentials'))).toBe(true);
    // The legacy file is left as it was, still recoverable.
    expect(fs.readFileSync(CREDS_FILE).subarray(0, 4).toString('latin1')).not.toBe('ABC2');
  });

  test('decrypted-but-invalid contents are reported rather than re-encrypted', async () => {
    // Legacy-encrypted, but the plaintext is not a credentials object.
    const salt = Buffer.from('agentbootup-creds-v1-salt-32byts');
    const key = crypto.scryptSync(OLD_HOST + 'agentbootup-v1', salt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const ct = Buffer.concat([cipher.update('{"nope":1}', 'utf8'), cipher.final()]);
    fs.writeFileSync(CREDS_FILE, Buffer.concat([iv, cipher.getAuthTag(), ct]), { mode: 0o600 });

    const io = makeIo();
    await handleAuthRewrap(['--from-hostname', OLD_HOST], io);
    expect(process.exitCode).toBe(1);
    expect(io.err.some((l) => l.includes('not valid credentials'))).toBe(true);
    expect(fs.readFileSync(CREDS_FILE).subarray(0, 4).toString('latin1')).not.toBe('ABC2');
  });
});

describe('runAuthCommand rewrap routing', () => {
  test("dispatches the 'rewrap' subcommand", async () => {
    const io = makeIo();
    await runAuthCommand(['auth', 'rewrap'], io);
    // Reached the handler (usage error), not the unknown-subcommand branch.
    expect(process.exitCode).toBe(1);
    expect(io.err.some((l) => l.includes('--from-hostname'))).toBe(true);
    expect(io.err.some((l) => l.includes('Unknown auth subcommand'))).toBe(false);
  });

  test('unknown subcommand help advertises rewrap', async () => {
    const io = makeIo();
    await runAuthCommand(['auth', 'nonsense'], io);
    expect(io.err.some((l) => l.includes('Unknown auth subcommand'))).toBe(true);
    expect(io.err.some((l) => l.includes('auth rewrap --from-hostname'))).toBe(true);
  });
});
