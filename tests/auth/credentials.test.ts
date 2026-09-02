import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';

import {
  writeCredentials,
  readCredentials,
  inspectCredentials,
  CREDS_STATE_MISSING,
  CREDS_STATE_OK,
  CREDS_STATE_READ_ERROR,
  CREDS_STATE_UNDECRYPTABLE,
  formatCredentialsRecoveryMessage,
  credentialsExist,
  exportCredentialsPayload,
  importCredentialsPayload,
  DEFAULT_CREDS_HANDOFF_TTL_SECONDS,
  _resetAtRestKeyCache,
} from '../../lib/auth/credentials.js';

describe('credentials store', () => {
  let originalEnvCredsFile: string | undefined;
  let originalEnvMachineIdFile: string | undefined;
  let testCredsDir: string;
  let testCredsFile: string;

  beforeEach(async () => {
    originalEnvCredsFile = process.env.AGENTBOOTUP_CREDS_FILE;
    originalEnvMachineIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    testCredsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-creds-test-'));
    testCredsFile = path.join(testCredsDir, 'credentials');
    // Isolate the machine identity too: writeCredentials() now derives its key from it
    // and creates ~/.agentbootup/machine-id on the real host when absent. A test run
    // must never mint the machine's real identity.
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(testCredsDir, 'machine-id');
    _resetAtRestKeyCache();
    process.env.AGENTBOOTUP_CREDS_FILE = testCredsFile;
  });

  afterEach(() => {
    if (originalEnvCredsFile === undefined) {
      delete process.env.AGENTBOOTUP_CREDS_FILE;
    } else {
      process.env.AGENTBOOTUP_CREDS_FILE = originalEnvCredsFile;
    }
    if (originalEnvMachineIdFile === undefined) {
      delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    } else {
      process.env.AGENTBOOTUP_MACHINE_ID_FILE = originalEnvMachineIdFile;
    }
    _resetAtRestKeyCache();
    fs.rmSync(testCredsDir, { recursive: true, force: true });
  });

  test('writeCredentials then readCredentials round-trips correctly', async () => {
    const creds = { apiKey: 'test-key-123', serverUrl: 'https://example.com' };
    await writeCredentials(creds);
    const result = await readCredentials();
    expect(result).toEqual(creds);
  });

  test('readCredentials returns null when file is absent', async () => {
    const result = await readCredentials();
    expect(result).toBeNull();
  });

  test('inspectCredentials reports missing when file is absent', async () => {
    const result = await inspectCredentials();
    expect(result).toEqual({ state: CREDS_STATE_MISSING });
  });

  test('credentialsExist returns false when file is absent', async () => {
    expect(await credentialsExist()).toBe(false);
  });

  test('credentialsExist returns true after writing credentials', async () => {
    await writeCredentials({ apiKey: 'k', serverUrl: 'https://s.example.com' });
    expect(await credentialsExist()).toBe(true);
  });

  test('written file has mode 0o600', async () => {
    await writeCredentials({ apiKey: 'secure-key', serverUrl: 'https://example.com' });
    const stat = fs.statSync(testCredsFile);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('credentials directory has mode 0o700', async () => {
    await writeCredentials({ apiKey: 'secure-key', serverUrl: 'https://example.com' });
    const stat = fs.statSync(path.dirname(testCredsFile));
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test('tampered ciphertext (bit-flip) returns null', async () => {
    await writeCredentials({ apiKey: 'my-key', serverUrl: 'https://example.com' });
    const raw = fs.readFileSync(testCredsFile);
    // Flip a byte in the ciphertext region (after 12-byte IV + 16-byte auth tag = 28 bytes)
    const tampered = Buffer.from(raw);
    tampered[28] ^= 0xff;
    fs.writeFileSync(testCredsFile, tampered);
    const result = await readCredentials();
    expect(result).toBeNull();
  });

  test('inspectCredentials reports undecryptable for tampered ciphertext', async () => {
    await writeCredentials({ apiKey: 'my-key', serverUrl: 'https://example.com' });
    const raw = fs.readFileSync(testCredsFile);
    const tampered = Buffer.from(raw);
    tampered[28] ^= 0xff;
    fs.writeFileSync(testCredsFile, tampered);
    const result = await inspectCredentials();
    // The state object now carries diagnostic fields (format, key ids) alongside state.
    expect(result).toMatchObject({ state: CREDS_STATE_UNDECRYPTABLE });
  });

  test('inspectCredentials reports read_error for non-ENOENT read failures', async () => {
    fs.rmSync(testCredsDir, { recursive: true, force: true });
    fs.mkdirSync(testCredsFile, { recursive: true });
    try {
      const result = await inspectCredentials();
      expect(result.state).toBe(CREDS_STATE_READ_ERROR);
      expect(result.error).toBeInstanceOf(Error);
    } finally {
      fs.rmSync(testCredsFile, { recursive: true, force: true });
      fs.mkdirSync(testCredsDir, { recursive: true });
    }
  });

  test('truncated file (too short to contain IV + tag + 1 byte) returns null', async () => {
    fs.writeFileSync(testCredsFile, Buffer.alloc(10), { mode: 0o600 });
    const result = await readCredentials();
    expect(result).toBeNull();
  });

  test('file containing random noise (auth tag mismatch) returns null', async () => {
    fs.writeFileSync(testCredsFile, crypto.randomBytes(64), { mode: 0o600 });
    const result = await readCredentials();
    expect(result).toBeNull();
  });

  test('overwrites existing credentials on second write', async () => {
    const first = { apiKey: 'first-key', serverUrl: 'https://first.example.com' };
    const second = { apiKey: 'second-key', serverUrl: 'https://second.example.com' };
    await writeCredentials(first);
    await writeCredentials(second);
    const result = await readCredentials();
    expect(result).toEqual(second);
  });

  test('round-trip preserves long API keys with special characters', async () => {
    const creds = {
      apiKey: 'sk-proj-AbCdEf123456_-~!@#$%',
      serverUrl: 'https://api.agentbootup.fly.dev:443/v1',
    };
    await writeCredentials(creds);
    const result = await readCredentials();
    expect(result).toEqual(creds);
  });

  test('inspectCredentials reports ok with parsed creds after a valid write', async () => {
    const creds = { apiKey: 'test-key-123', serverUrl: 'https://example.com' };
    await writeCredentials(creds);
    const result = await inspectCredentials();
    expect(result).toEqual({ state: CREDS_STATE_OK, creds });
  });

  test('formatCredentialsRecoveryMessage distinguishes all non-ok states', () => {
    expect(formatCredentialsRecoveryMessage(CREDS_STATE_MISSING)).toContain('No credentials found');
    expect(formatCredentialsRecoveryMessage(CREDS_STATE_UNDECRYPTABLE)).toContain('cannot be decrypted on this host');
    expect(
      formatCredentialsRecoveryMessage({
        state: CREDS_STATE_READ_ERROR,
        error: new Error('EISDIR: illegal operation on a directory'),
      }, { includeErrorDetail: true })
    ).toContain('EISDIR');
  });

  test('encrypted file content is not plaintext-readable', async () => {
    const apiKey = 'super-secret-api-key-do-not-reveal';
    await writeCredentials({ apiKey, serverUrl: 'https://example.com' });
    const raw = fs.readFileSync(testCredsFile);
    expect(raw.toString('utf8')).not.toContain(apiKey);
  });

  test('export/import payload round-trips for the current host', async () => {
    const creds = { apiKey: 'handoff-key', serverUrl: 'https://example.com' };
    const payload = exportCredentialsPayload(creds, os.hostname());
    const imported = importCredentialsPayload(payload);
    expect(imported).toEqual(creds);
  });

  test('export payload includes default ttl and omits plaintext source hostname', async () => {
    const payload = JSON.parse(
      exportCredentialsPayload({ apiKey: 'handoff-key', serverUrl: 'https://example.com' }, os.hostname())
    );
    expect(payload.ttl_seconds).toBe(DEFAULT_CREDS_HANDOFF_TTL_SECONDS);
    expect(payload.source_hostname).toBeUndefined();
  });

  test('importCredentialsPayload rejects payloads for another host', async () => {
    const payload = exportCredentialsPayload(
      { apiKey: 'handoff-key', serverUrl: 'https://example.com' },
      'definitely-not-this-host'
    );
    expect(() => importCredentialsPayload(payload)).toThrow(/not this host/);
  });

  test('importCredentialsPayload rejects tampered payloads', async () => {
    const payload = JSON.parse(
      exportCredentialsPayload(
        { apiKey: 'handoff-key', serverUrl: 'https://example.com' },
        os.hostname()
      )
    );
    payload.ciphertext = payload.ciphertext.slice(0, -4) + 'AAAA';
    expect(() => importCredentialsPayload(JSON.stringify(payload))).toThrow(/decryption failed|invalid/);
  });

  test('importCredentialsPayload rejects expired payloads', async () => {
    const payload = JSON.parse(
      exportCredentialsPayload(
        { apiKey: 'handoff-key', serverUrl: 'https://example.com' },
        os.hostname(),
        { ttlSeconds: 1 }
      )
    );
    payload.exported_at = '2000-01-01T00:00:00.000Z';
    expect(() => importCredentialsPayload(JSON.stringify(payload))).toThrow(/expired/);
  });
});
