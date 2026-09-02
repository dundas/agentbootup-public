/**
 * Tests for rotate-keys.js (FR-12 — brain rotate-keys command)
 *
 * Run with: bun test lib/brain/rotate-keys.test.js
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';

import { rotateKeysCore, runBrainRotateKeys } from './rotate-keys.js';
import { CREDS_STATE_OK } from '../auth/credentials.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpId() {
  return crypto.randomBytes(8).toString('hex');
}

let tmpDir;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `rotate-keys-test-${tmpId()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function makeIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    out,
    err,
  };
}

async function writeBrainDir(brainId = 'test-brain', secretContent = null) {
  const brainDir = path.join(tmpDir, 'brain');
  await fsp.mkdir(brainDir, { recursive: true });

  const cfg = { agent_id: brainId, registry: { identity: 'old-identity-key' } };
  await fsp.writeFile(path.join(brainDir, 'config.json'), JSON.stringify(cfg, null, 2));

  const secret = secretContent ?? {
    registry_private_key: 'old-private-key-base64',
    other_field: 'should-survive',
  };
  await fsp.writeFile(
    path.join(brainDir, 'config.secret.json'),
    JSON.stringify(secret, null, 2),
    { mode: 0o600 },
  );

  return tmpDir;
}

function makeProvisionResult(secretChanged = true) {
  return async () => ({ ok: true, status: 'configured', secretChanged });
}

function makeTestDeps(overrides = {}) {
  return {
    inspectCredentials: async () => ({
      state: CREDS_STATE_OK,
      creds: { apiKey: 'test-api-key', serverUrl: 'https://agentbootup.fly.dev' },
    }),
    provisionRegistryAccess: makeProvisionResult(true),
    admpRegister: () => ({ ok: true, skipped: false }),
    rotateKeysCore,
    ...overrides,
  };
}

// ── rotateKeysCore ─────────────────────────────────────────────────────────────

test('rotateKeysCore: (e) missing config.secret.json → error no_secret', async () => {
  // No brain dir written — secret file absent
  const brainDir = path.join(tmpDir, 'empty');
  await fsp.mkdir(brainDir, { recursive: true });
  await fsp.mkdir(path.join(brainDir, 'brain'), { recursive: true });
  const { io, err } = makeIo();

  const result = await rotateKeysCore(brainDir, 'brain-1', io, {}, {
    provisionRegistryAccess: makeProvisionResult(true),
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe('no_secret');
  expect(err.some((l) => /nothing to rotate/i.test(l))).toBe(true);
});

test('rotateKeysCore: (a) new keypair is distinct from prior — secretChanged assertion passes', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const { io } = makeIo();
  let provisionCalled = false;

  const result = await rotateKeysCore(brainDir, 'brain-1', io, {}, {
    provisionRegistryAccess: async (opts) => {
      provisionCalled = true;
      expect(opts.projectPath).toBe(brainDir);
      // Simulate that provisioning generated a new key
      const secretPath = path.join(brainDir, 'brain', 'config.secret.json');
      const secret = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
      secret.registry_private_key = 'new-private-key-base64';
      fs.writeFileSync(secretPath, JSON.stringify(secret, null, 2), { mode: 0o600 });
      return { ok: true, status: 'configured', secretChanged: true };
    },
  });

  expect(provisionCalled).toBe(true);
  expect(result.ok).toBe(true);
  expect(result.provResult.secretChanged).toBe(true);
  // oldSecretContent is returned for rollback
  expect(result.oldSecretContent).toContain('old-private-key-base64');
});

test('rotateKeysCore: (b) config.secret.json old key is cleared before provisioning', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const { io } = makeIo();
  let secretAtProvisionTime;

  await rotateKeysCore(brainDir, 'brain-1', io, {}, {
    provisionRegistryAccess: async () => {
      const secretPath = path.join(brainDir, 'brain', 'config.secret.json');
      secretAtProvisionTime = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
      return { ok: true, status: 'configured', secretChanged: true };
    },
  });

  // Key was cleared before provisioning so provisionRegistryAccess regenerates it
  expect(secretAtProvisionTime.registry_private_key).toBeUndefined();
  // Other fields survive
  expect(secretAtProvisionTime.other_field).toBe('should-survive');
});

test('rotateKeysCore: silent no-op detection — secretChanged: false → error no_rotation', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const { io, err } = makeIo();

  const result = await rotateKeysCore(brainDir, 'brain-1', io, {}, {
    provisionRegistryAccess: makeProvisionResult(false),
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe('no_rotation');
  expect(err.some((l) => /rotation failed/i.test(l))).toBe(true);
});

test('rotateKeysCore: provision returns ok: false → error provision_incomplete', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const { io } = makeIo();

  const result = await rotateKeysCore(brainDir, 'brain-1', io, {}, {
    provisionRegistryAccess: async () => ({ ok: false, reason: 'auth_failed' }),
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe('provision_incomplete');
});

test('rotateKeysCore: commandLabel opt prefixes error messages (guards brain pull contract)', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const { io, err } = makeIo();

  await rotateKeysCore(brainDir, 'brain-1', io, { commandLabel: 'brain pull' }, {
    provisionRegistryAccess: async () => ({ ok: false, reason: 'auth_failed' }),
  });

  expect(err.some((l) => l.startsWith('brain pull:'))).toBe(true);
  expect(err.every((l) => !l.startsWith('brain rotate-keys:'))).toBe(true);
});

// ── runBrainRotateKeys ────────────────────────────────────────────────────────

test('runBrainRotateKeys: --help exits 0', async () => {
  const { io } = makeIo();
  const code = await runBrainRotateKeys(['--help'], io, makeTestDeps());
  expect(code).toBe(0);
});

test('runBrainRotateKeys: rotateKeysCore failure → exits 1', async () => {
  const { io } = makeIo();
  const deps = makeTestDeps({
    rotateKeysCore: async () => ({ ok: false, error: 'provision_failed' }),
  });
  const code = await runBrainRotateKeys(['brain-1', '--path', tmpDir, '--yes'], io, deps);
  expect(code).toBe(1);
});

test('runBrainRotateKeys: missing --yes exits 1 with clear message', async () => {
  const { io, err } = makeIo();
  const code = await runBrainRotateKeys(['brain-1', '--path', tmpDir], io, makeTestDeps());
  expect(code).toBe(1);
  expect(err.some((l) => /--yes/i.test(l))).toBe(true);
});

test('runBrainRotateKeys: bad credentials exits 1', async () => {
  const { io, err } = makeIo();
  const deps = makeTestDeps({
    inspectCredentials: async () => ({ state: 'missing' }),
  });
  const code = await runBrainRotateKeys(['brain-1', '--path', tmpDir, '--yes'], io, deps);
  expect(code).toBe(1);
  expect(err.length).toBeGreaterThan(0);
});

test('runBrainRotateKeys: (c) ADMP re-registration is called on success path', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const { io } = makeIo();
  let admpCalled = false;
  let admpBrainId;

  const deps = makeTestDeps({
    rotateKeysCore: async () => ({
      ok: true,
      provResult: { ok: true, secretChanged: true },
      oldSecretContent: '{"registry_private_key":"old"}',
      oldConfigContent: null,
    }),
    admpRegister: (brainId, target, ioArg) => {
      admpCalled = true;
      admpBrainId = brainId;
      return { ok: true, skipped: false };
    },
  });

  const code = await runBrainRotateKeys(['brain-1', '--path', brainDir, '--yes'], io, deps);
  expect(code).toBe(0);
  expect(admpCalled).toBe(true);
  expect(admpBrainId).toBe('brain-1');
});

test('runBrainRotateKeys: (d) ADMP failure → both config.secret.json and config.json restored, exits 1', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const secretPath = path.join(brainDir, 'brain', 'config.secret.json');
  const configPath = path.join(brainDir, 'brain', 'config.json');
  const { io, err } = makeIo();

  const oldSecretContent = '{"registry_private_key":"old-key-restored"}';
  const oldConfigContent = '{"agent_id":"brain-1","registry":{"identity":"old-identity"}}';

  const deps = makeTestDeps({
    rotateKeysCore: async () => ({
      ok: true,
      provResult: { ok: true, secretChanged: true },
      oldSecretContent,
      oldConfigContent,
    }),
    admpRegister: () => ({ ok: false, skipped: false }),
  });

  const code = await runBrainRotateKeys(['brain-1', '--path', brainDir, '--yes'], io, deps);
  expect(code).toBe(1);
  expect(err.some((l) => /rollback/i.test(l))).toBe(true);
  const restoredSecret = fs.readFileSync(secretPath, 'utf-8');
  const restoredConfig = fs.readFileSync(configPath, 'utf-8');
  expect(restoredSecret).toBe(oldSecretContent);
  expect(restoredConfig).toBe(oldConfigContent);
});

test('runBrainRotateKeys: (d-integration) real rotateKeysCore rollback restores both config files', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const secretPath = path.join(brainDir, 'brain', 'config.secret.json');
  const configPath = path.join(brainDir, 'brain', 'config.json');
  const { io, err } = makeIo();

  const origSecret = fs.readFileSync(secretPath, 'utf-8');
  const origConfig = fs.readFileSync(configPath, 'utf-8');

  // provisionRegistryAccess stub that writes a new identity into config.json
  const deps = makeTestDeps({
    provisionRegistryAccess: async () => {
      const newIdentity = { registry: { identity: { did: 'did:key:new', publicKey: 'new-pub-key' } } };
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      fs.writeFileSync(configPath, JSON.stringify({ ...existing, ...newIdentity }, null, 2));
      const secretObj = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
      secretObj.registry_private_key = 'new-private-key';
      fs.writeFileSync(secretPath, JSON.stringify(secretObj, null, 2), { mode: 0o600 });
      return { ok: true, status: 'configured', secretChanged: true };
    },
    admpRegister: () => ({ ok: false, skipped: false }),
  });

  const code = await runBrainRotateKeys(['brain-1', '--path', brainDir, '--yes'], io, deps);
  expect(code).toBe(1);
  expect(err.some((l) => /rollback/i.test(l))).toBe(true);

  // Both files should be back to original state — exact content equality
  const restoredSecret = fs.readFileSync(secretPath, 'utf-8');
  const restoredConfig = fs.readFileSync(configPath, 'utf-8');
  expect(JSON.parse(restoredSecret).registry_private_key).toBe('old-private-key-base64');
  expect(restoredConfig).toBe(origConfig);
});

test('runBrainRotateKeys: (d-integration-absent) config.json absent before rotation — orphaned identity cleared on rollback', async () => {
  // Set up brain dir without config.json (only config.secret.json exists)
  const brainDir = path.join(tmpDir, 'absent-config');
  await fsp.mkdir(path.join(brainDir, 'brain'), { recursive: true });
  const secretPath = path.join(brainDir, 'brain', 'config.secret.json');
  const configPath = path.join(brainDir, 'brain', 'config.json');
  await fsp.writeFile(secretPath, JSON.stringify({ registry_private_key: 'old-key' }), { mode: 0o600 });
  // config.json intentionally absent

  const { io, err } = makeIo();

  // provisionRegistryAccess stub creates config.json with new identity
  const deps = makeTestDeps({
    provisionRegistryAccess: async () => {
      fs.writeFileSync(configPath, JSON.stringify({ registry: { identity: { did: 'did:key:new' } } }, null, 2));
      const secretObj = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
      secretObj.registry_private_key = 'new-private-key';
      fs.writeFileSync(secretPath, JSON.stringify(secretObj, null, 2), { mode: 0o600 });
      return { ok: true, status: 'configured', secretChanged: true };
    },
    admpRegister: () => ({ ok: false, skipped: false }),
  });

  const code = await runBrainRotateKeys(['brain-1', '--path', brainDir, '--yes'], io, deps);
  expect(code).toBe(1);

  // config.json should no longer contain registry.identity (orphaned identity cleared)
  const restoredConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  expect(restoredConfig.registry?.identity).toBeUndefined();
  // secret should be rolled back to old key
  const restoredSecret = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
  expect(restoredSecret.registry_private_key).toBe('old-key');
});

test('runBrainRotateKeys: (d-integration-absent-malformed) orphan-clear failure warning emitted when config.json is malformed', async () => {
  const brainDir = path.join(tmpDir, 'malformed-config');
  await fsp.mkdir(path.join(brainDir, 'brain'), { recursive: true });
  const secretPath = path.join(brainDir, 'brain', 'config.secret.json');
  const configPath = path.join(brainDir, 'brain', 'config.json');
  await fsp.writeFile(secretPath, JSON.stringify({ registry_private_key: 'old-key' }), { mode: 0o600 });
  // config.json intentionally absent before rotation

  const { io, err } = makeIo();

  // provisionRegistryAccess writes malformed JSON to config.json so JSON.parse throws on rollback
  const deps = makeTestDeps({
    provisionRegistryAccess: async () => {
      fs.writeFileSync(configPath, 'NOT VALID JSON {{{');
      const secretObj = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
      secretObj.registry_private_key = 'new-private-key';
      fs.writeFileSync(secretPath, JSON.stringify(secretObj, null, 2), { mode: 0o600 });
      return { ok: true, status: 'configured', secretChanged: true };
    },
    admpRegister: () => ({ ok: false, skipped: false }),
  });

  const code = await runBrainRotateKeys(['brain-1', '--path', brainDir, '--yes'], io, deps);
  expect(code).toBe(1);
  // The parse-failure warning branch should fire
  expect(err.some((l) => /could not be cleared/i.test(l))).toBe(true);
  expect(err.some((l) => /Recovery.*registry\.identity/i.test(l))).toBe(true);
  // Secret should still be rolled back
  const restoredSecret = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
  expect(restoredSecret.registry_private_key).toBe('old-key');
});

test('runBrainRotateKeys: (f) orphaned-daemon warning printed on success', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const { io, out } = makeIo();

  const deps = makeTestDeps({
    rotateKeysCore: async () => ({
      ok: true,
      provResult: { ok: true, secretChanged: true },
      oldSecretContent: '{"registry_private_key":"old"}',
      oldConfigContent: null,
    }),
    admpRegister: () => ({ ok: true, skipped: false }),
  });

  const code = await runBrainRotateKeys(['brain-1', '--path', brainDir, '--yes'], io, deps);
  expect(code).toBe(0);
  expect(out.some((l) => /daemon/i.test(l) && /failing silently/i.test(l))).toBe(true);
});

test('runBrainRotateKeys: ADMP skipped → explicit unregistered warning, exits 0', async () => {
  const brainDir = await writeBrainDir('brain-1');
  const { io, out } = makeIo();

  const deps = makeTestDeps({
    rotateKeysCore: async () => ({
      ok: true,
      provResult: { ok: true, secretChanged: true },
      oldSecretContent: '{"registry_private_key":"old"}',
      oldConfigContent: null,
    }),
    admpRegister: () => ({ ok: true, skipped: true }),
  });

  const code = await runBrainRotateKeys(['brain-1', '--path', brainDir, '--yes'], io, deps);
  expect(code).toBe(0);
  expect(out.some((l) => /ADMP registration was skipped/i.test(l))).toBe(true);
  expect(out.some((l) => /cannot authenticate/i.test(l))).toBe(true);
});

test('runBrainRotateKeys: resolves brain-id from config.json when not provided', async () => {
  const brainDir = await writeBrainDir('config-brain-id');
  const { io, out } = makeIo();
  let rotateCalledWithId;

  const deps = makeTestDeps({
    rotateKeysCore: async (dir, brainId) => {
      rotateCalledWithId = brainId;
      return {
        ok: true,
        provResult: { ok: true, secretChanged: true },
        oldSecretContent: '{"registry_private_key":"old"}',
        oldConfigContent: null,
      };
    },
    admpRegister: () => ({ ok: true, skipped: false }),
  });

  // No brainId in argv — should be read from brain/config.json
  const code = await runBrainRotateKeys(['--path', brainDir, '--yes'], io, deps);
  expect(code).toBe(0);
  expect(rotateCalledWithId).toBe('config-brain-id');
});
