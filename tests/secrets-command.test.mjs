import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { writeCredentials } from '../lib/auth/credentials.js';
import {
  ASSET_CONTRACT_VERSION,
  ASSET_TYPES,
  MAX_SECRET_BYTES,
  SECRET_CAPABILITY_POLICY,
  SECRET_REL_PATHS,
  SECRET_TTL_MAX_SECONDS,
  SECRET_TTL_MIN_SECONDS,
} from '../lib/brain/asset-contract.js';
import {
  buildSecretsChildEnv,
  resolveTrustedSecretsBun,
  runSecretsCleanup,
  runSecretsPull,
  runSecretsPush,
} from '../lib/network/commands/secrets.js';

const REAL_FETCH = globalThis.fetch;
const tempDirs = [];

function mkd(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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

function makeProjectDir() {
  const dir = mkd('agentbootup-secrets-');
  fs.writeFileSync(
    path.join(dir, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'test-brain',
      network: '~/dev_env/decisive_redux',
    }, null, 2)
  );
  return dir;
}

async function setupCreds(dir) {
  process.env.AGENTBOOTUP_CREDS_FILE = path.join(dir, 'credentials');
  await writeCredentials({ apiKey: 'test-key', serverUrl: 'https://server.example.com' });
}

function capabilityResponse() {
  return new Response(JSON.stringify({
    data: {
      contract_version: ASSET_CONTRACT_VERSION,
      asset_types: ASSET_TYPES,
      secret: SECRET_CAPABILITY_POLICY,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  delete process.env.AGENTBOOTUP_CREDS_FILE;
  globalThis.fetch = REAL_FETCH;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('secret helper runtime requires an absolute non-writable regular executable', () => {
  const dir = mkd('agentbootup-secret-bun-');
  const executable = path.join(dir, 'bun');
  fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(resolveTrustedSecretsBun({ AGENTBOOTUP_BUN_PATH: executable }), executable);
  assert.throws(() => resolveTrustedSecretsBun({ PATH: dir }), /AGENTBOOTUP_BUN_PATH/);
  fs.chmodSync(executable, 0o722);
  assert.throws(
    () => resolveTrustedSecretsBun({ AGENTBOOTUP_BUN_PATH: executable }),
    /writable by group or other/,
  );
});

test('secret helper runtime receives only the explicit environment allowlist', () => {
  const childEnv = buildSecretsChildEnv({
    HOME: '/trusted-home',
    AGENTBOOTUP_CREDS_FILE: '/trusted-creds',
    UNRELATED_SECRET_TOKEN: 'must-not-cross-process-boundary',
  });
  assert.equal(childEnv.HOME, '/trusted-home');
  assert.equal(childEnv.AGENTBOOTUP_CREDS_FILE, '/trusted-creds');
  assert.equal(childEnv.UNRELATED_SECRET_TOKEN, undefined);
  assert.equal(childEnv.PATH, process.platform === 'win32' ? '' : '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('secrets preflight fails closed when manual, retention, authorization, or logging policy drifts', async () => {
  for (const mutate of [
    (secret) => { secret.manual_only = false; },
    (secret) => { secret.retention.without_ttl = 'forever'; },
    (secret) => { secret.authorization.principal = 'anonymous'; },
    (secret) => { secret.logging.payload_logged = true; },
  ]) {
    const dir = makeProjectDir();
    await setupCreds(dir);
    fs.writeFileSync(path.join(dir, '.env'), 'fixture-only\n');
    globalThis.fetch = async () => {
      const payload = await capabilityResponse().json();
      mutate(payload.data.secret);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { io } = makeIo();
    assert.equal(await runSecretsPush(dir, io, { dryRun: true }), 1);
  }
});

test('secret allowlist includes Cloudflare .dev.vars', () => {
  assert.ok(SECRET_REL_PATHS.includes('.dev.vars'));
});

test('secrets push dry-run lists .dev.vars when present', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  fs.writeFileSync(path.join(dir, '.dev.vars'), 'WORKER_SECRET=value\n');

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return capabilityResponse();
  };

  const { io, out } = makeIo();
  const code = await runSecretsPush(dir, io, { dryRun: true });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/brain-assets\/test-brain\/capabilities$/);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.match(out.join('\n'), /\.dev\.vars/);
  assert.match(out.join('\n'), /not securely opened or transmitted/i);
});

test('secrets push accepts an ephemeral credential reader without persisted credentials', async () => {
  const dir = makeProjectDir();
  process.env.AGENTBOOTUP_CREDS_FILE = path.join(dir, 'must-not-exist');
  fs.writeFileSync(path.join(dir, '.env'), 'fixture-only\n');

  let authorization;
  globalThis.fetch = async (_url, init) => {
    authorization = init.headers.Authorization;
    return capabilityResponse();
  };

  const { io } = makeIo();
  const code = await runSecretsPush(dir, io, {
    dryRun: true,
    readCredentialsImpl: async () => ({
      apiKey: 'ephemeral-runtime-key',
      serverUrl: 'https://server.example.com',
    }),
  });

  assert.equal(code, 0);
  assert.equal(authorization, 'Bearer ephemeral-runtime-key');
  assert.equal(fs.existsSync(process.env.AGENTBOOTUP_CREDS_FILE), false);
});

test('secrets push dry-run fails closed when server lacks the secret capability', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  fs.writeFileSync(path.join(dir, '.env'), Buffer.from([0x41, 0x00, 0xff]));

  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      contract_version: ASSET_CONTRACT_VERSION,
      asset_types: ASSET_TYPES.filter((value) => value !== 'secret'),
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const { io, err } = makeIo();
  const code = await runSecretsPush(dir, io, { dryRun: true });

  assert.equal(code, 1);
  assert.match(err.join('\n'), /does not advertise the required secret asset capability/i);
});

test('secrets push dry-run fails closed when the server asset type enum drifts', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  fs.writeFileSync(path.join(dir, '.env'), 'fixture-only\n');

  globalThis.fetch = async () => {
    const payload = await capabilityResponse().json();
    payload.data.asset_types = [...payload.data.asset_types, 'server-only-type'];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { io, err } = makeIo();
  assert.equal(await runSecretsPush(dir, io, { dryRun: true }), 1);
  assert.match(err.join('\n'), /does not advertise the required secret asset capability/i);
});

test('secrets push dry-run fails closed when the capability endpoint is absent', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  fs.writeFileSync(path.join(dir, '.env'), 'fixture-only\n');

  globalThis.fetch = async () => new Response('not found', { status: 404 });

  const { io, err } = makeIo();
  const code = await runSecretsPush(dir, io, { dryRun: true });

  assert.equal(code, 1);
  assert.match(err.join('\n'), /contract preflight failed: HTTP 404/i);
});

test('secrets push dry-run fails when advertised paths reject the real request', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  fs.writeFileSync(path.join(dir, '.dev.vars'), 'fixture-only\n');
  globalThis.fetch = async () => {
    const response = await capabilityResponse();
    const payload = await response.json();
    payload.data.secret.paths = ['.env', 'brain/config.secret.json'];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { io, err } = makeIo();
  const code = await runSecretsPush(dir, io, { dryRun: true });

  assert.equal(code, 1);
  assert.match(err.join('\n'), /does not advertise the required secret asset capability/i);
});

test('secrets push sends exact bytes for every allowlisted source', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  const fixtures = new Map([
    ['.env', Buffer.from([0x41, 0x3d, 0x00, 0xff, 0x0a])],
    ['.dev.vars', Buffer.from([0xef, 0xbb, 0xbf, 0x42, 0x3d, 0x31, 0x0d, 0x0a])],
    ['brain/config.secret.json', Buffer.from('{"fixture":"line\\r\\nvalue"}\r\n', 'utf8')],
  ]);
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  for (const [relPath, bytes] of fixtures) {
    fs.writeFileSync(path.join(dir, relPath), bytes);
  }

  let payload;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/capabilities')) return capabilityResponse();
    payload = JSON.parse(init.body);
    return new Response(JSON.stringify({
      data: {
        pushed: 3,
        updated: 0,
        errors: 0,
        results: [...fixtures.keys()].map((path) => ({ path, status: 'pushed' })),
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { io } = makeIo();
  const code = await runSecretsPush(dir, io, { ttlSeconds: 300 });

  assert.equal(code, 0);
  assert.equal(payload.ttl_seconds, 300);
  assert.equal(payload.files.length, fixtures.size);
  for (const file of payload.files) {
    assert.equal(file.asset_type, 'secret');
    assert.deepEqual(Buffer.from(file.content_base64, 'base64'), fixtures.get(file.path));
  }
});

test('secrets push rejects a target swapped to a symlink after discovery', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink fixture requires POSIX');
  const dir = makeProjectDir();
  await setupCreds(dir);
  const target = path.join(dir, '.env');
  const outside = path.join(mkd('agentbootup-secrets-push-outside-'), 'outside.env');
  fs.writeFileSync(target, 'intended\n');
  fs.writeFileSync(outside, 'secret!!\n');
  let payloadPosts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/capabilities')) {
      fs.unlinkSync(target);
      fs.symlinkSync(outside, target);
      return capabilityResponse();
    }
    payloadPosts += 1;
    return new Response('{}', { status: 500 });
  };

  const { io, err } = makeIo();
  assert.equal(await runSecretsPush(dir, io), 1);
  assert.equal(payloadPosts, 0);
  assert.match(err.join('\n'), /changed|symbolic link|secure secret read/i);
});

test('secrets push rejects a parent swapped to a symlink after discovery', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink fixture requires POSIX');
  const dir = makeProjectDir();
  await setupCreds(dir);
  const outside = mkd('agentbootup-secrets-push-outside-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'brain', 'config.secret.json'), '{"safe":1}\n');
  fs.writeFileSync(path.join(outside, 'config.secret.json'), '{"evil":1}\n');
  let payloadPosts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/capabilities')) {
      fs.renameSync(path.join(dir, 'brain'), path.join(dir, 'brain-original'));
      fs.symlinkSync(outside, path.join(dir, 'brain'));
      return capabilityResponse();
    }
    payloadPosts += 1;
    return new Response('{}', { status: 500 });
  };

  const { io, err } = makeIo();
  assert.equal(await runSecretsPush(dir, io), 1);
  assert.equal(payloadPosts, 0);
  assert.match(err.join('\n'), /changed|symbolic link|secure secret read/i);
});

test('secrets push retains and revalidates an opened parent descriptor through read', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink fixture requires POSIX');
  const dir = makeProjectDir();
  await setupCreds(dir);
  const outside = mkd('agentbootup-secrets-push-outside-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'brain', 'config.secret.json'), '{"safe":1}\n');
  fs.writeFileSync(path.join(outside, 'config.secret.json'), '{"evil":1}\n');
  let payloadPosts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/capabilities')) return capabilityResponse();
    payloadPosts += 1;
    return new Response('{}', { status: 500 });
  };

  const { io, err } = makeIo();
  const code = await runSecretsPush(dir, io, {
    readHooks: {
      beforeRead({ assetPath }) {
        if (assetPath !== 'brain/config.secret.json') return;
        fs.renameSync(path.join(dir, 'brain'), path.join(dir, 'brain-original'));
        fs.symlinkSync(outside, path.join(dir, 'brain'));
      },
    },
  });
  assert.equal(code, 1);
  assert.equal(payloadPosts, 0);
  assert.match(err.join('\n'), /changed|secure secret read/i);
});

test('secrets push treats malformed or per-file-error HTTP 200 responses as failure', async () => {
  for (const data of [
    { pushed: 1, updated: 0, errors: 0 },
    {
      pushed: 2,
      updated: 0,
      errors: 1,
      results: [
        { path: '.env', status: 'pushed' },
        { path: '.dev.vars', status: 'error', error: 'storage failed' },
        { path: 'brain/config.secret.json', status: 'pushed' },
      ],
    },
  ]) {
    const dir = makeProjectDir();
    await setupCreds(dir);
    fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
    for (const relPath of SECRET_REL_PATHS) {
      fs.writeFileSync(path.join(dir, relPath), 'fixture-only\n');
    }
    globalThis.fetch = async (url) => String(url).endsWith('/capabilities')
      ? capabilityResponse()
      : new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { io } = makeIo();
    assert.equal(await runSecretsPush(dir, io), 1);
  }
});

test('secrets pull rejects an existing symlink ancestor and writes nothing outside', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink fixture requires POSIX permissions');
  const dir = makeProjectDir();
  const outside = mkd('agentbootup-secrets-outside-');
  await setupCreds(dir);
  fs.symlinkSync(outside, path.join(dir, 'brain'));
  globalThis.fetch = async (url) => String(url).endsWith('/capabilities')
    ? capabilityResponse()
    : new Response(JSON.stringify({
      data: {
        files: [{
          path: 'brain/config.secret.json',
          content_base64: Buffer.from('fixture-only\n').toString('base64'),
          asset_type: 'secret',
          cli: 'shared',
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

  const { io } = makeIo();
  assert.equal(await runSecretsPull(dir, io, { force: true }), 1);
  assert.equal(fs.existsSync(path.join(outside, 'config.secret.json')), false);
});

test('secrets pull rejects an existing symlink target and does not alter its outside referent', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink fixture requires POSIX permissions');
  const dir = makeProjectDir();
  const outside = path.join(mkd('agentbootup-secrets-outside-'), 'referent');
  fs.writeFileSync(outside, 'outside-original\n');
  await setupCreds(dir);
  fs.symlinkSync(outside, path.join(dir, '.env'));
  globalThis.fetch = async (url) => String(url).endsWith('/capabilities')
    ? capabilityResponse()
    : new Response(JSON.stringify({
      data: {
        files: [{
          path: '.env',
          content_base64: Buffer.from('replacement\n').toString('base64'),
          asset_type: 'secret',
          cli: 'shared',
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

  const { io } = makeIo();
  assert.equal(await runSecretsPull(dir, io, { force: true }), 1);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-original\n');
});

test('secrets pull fails closed when the destination parent is swapped before publish', async (t) => {
  if (process.platform === 'win32') return t.skip('directory-descriptor fixture requires POSIX');
  const dir = makeProjectDir();
  const outside = mkd('agentbootup-secrets-swap-outside-');
  await setupCreds(dir);
  globalThis.fetch = async (url) => String(url).endsWith('/capabilities')
    ? capabilityResponse()
    : new Response(JSON.stringify({
      data: {
        files: [{
          path: 'brain/config.secret.json',
          content_base64: Buffer.from('replacement\n').toString('base64'),
          asset_type: 'secret',
          cli: 'shared',
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

  let swapped = false;
  const { io } = makeIo();
  const code = await runSecretsPull(dir, io, {
    force: true,
    restoreHooks: {
      beforePublish({ assetPath }) {
        if (assetPath !== 'brain/config.secret.json' || swapped) return;
        swapped = true;
        fs.renameSync(path.join(dir, 'brain'), path.join(dir, 'brain-original'));
        fs.symlinkSync(outside, path.join(dir, 'brain'));
      },
    },
  });

  assert.equal(code, 1);
  assert.equal(fs.existsSync(path.join(outside, 'config.secret.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'brain-original', 'config.secret.json')), false);
});

test('secrets pull fails closed when the destination is swapped to a symlink before publish', async (t) => {
  if (process.platform === 'win32') return t.skip('directory-descriptor fixture requires POSIX');
  const dir = makeProjectDir();
  const outside = path.join(mkd('agentbootup-secrets-swap-outside-'), 'referent');
  fs.writeFileSync(outside, 'outside-original\n');
  await setupCreds(dir);
  globalThis.fetch = async (url) => String(url).endsWith('/capabilities')
    ? capabilityResponse()
    : new Response(JSON.stringify({
      data: {
        files: [{
          path: '.env',
          content_base64: Buffer.from('replacement\n').toString('base64'),
          asset_type: 'secret',
          cli: 'shared',
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

  const { io } = makeIo();
  const code = await runSecretsPull(dir, io, {
    force: true,
    restoreHooks: {
      beforePublish({ assetPath }) {
        if (assetPath === '.env') fs.symlinkSync(outside, path.join(dir, '.env'));
      },
    },
  });

  assert.equal(code, 1);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-original\n');
});

test('secrets pull restores exact bytes for every source with mode 0600', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  const fixtures = new Map([
    ['.env', Buffer.from([0x00, 0x41, 0xff, 0x0a])],
    ['.dev.vars', Buffer.from([0x42, 0x3d, 0x31, 0x0d, 0x0a])],
    ['brain/config.secret.json', Buffer.from('{"fixture":true}\n', 'utf8')],
  ]);

  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/capabilities')) return capabilityResponse();
    assert.match(String(url), /\/v1\/brain-assets\/test-brain\?asset_type=secret$/);
    assert.equal(init.method, 'GET');
    return new Response(JSON.stringify({
      data: {
        files: [...fixtures].map(([relPath, bytes]) => ({
          path: relPath,
          content_base64: bytes.toString('base64'),
          asset_type: 'secret',
          cli: 'shared',
        })),
        total: fixtures.size,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const { io } = makeIo();
  const code = await runSecretsPull(dir, io, { force: true });

  assert.equal(code, 0);
  for (const [relPath, bytes] of fixtures) {
    const restoredPath = path.join(dir, relPath);
    assert.deepEqual(fs.readFileSync(restoredPath), bytes);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(restoredPath).mode & 0o777, 0o600);
    }
  }
});

test('secrets push 404 prints provisioning hint', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  fs.writeFileSync(path.join(dir, '.dev.vars'), 'WORKER_SECRET=value\n');

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/capabilities')) return capabilityResponse();
    return new Response('', { status: 404 });
  };

  const { io, err } = makeIo();
  const code = await runSecretsPush(dir, io);

  assert.equal(code, 1);
  const text = err.join('\n');
  assert.match(text, /not provisioned/);
  assert.match(text, /agentbootup provision --agent test-brain --type <type> --repo <path>/);
});

test('secrets push returns a command error for conflicting project identity', async () => {
  const dir = mkd('agentbootup-secrets-conflict-');
  fs.writeFileSync(
    path.join(dir, 'agentbootup.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
  );
  const { io, err } = makeIo();

  const code = await runSecretsPush(dir, io, { dryRun: true });

  assert.equal(code, 1);
  assert.match(err.join('\n'), /secrets push failed/);
  assert.match(err.join('\n'), /agent_id/);
  assert.match(err.join('\n'), /agentId/);
});

test('secrets cleanup rejects missing or conflicting project identity before network access', async () => {
  const missingDir = mkd('agentbootup-secrets-missing-identity-');
  const conflictingDir = mkd('agentbootup-secrets-cleanup-conflict-');
  fs.writeFileSync(
    path.join(conflictingDir, 'agentbootup.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
  );
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network must not be reached');
  };

  for (const [dir, expected] of [
    [missingDir, /agent_id/],
    [conflictingDir, /agentId/],
  ]) {
    const { io, err } = makeIo();
    assert.equal(await runSecretsCleanup(dir, io, { confirmBrainId: 'unused' }), 1);
    assert.match(err.join('\n'), /secrets cleanup failed/);
    assert.match(err.join('\n'), expected);
  }
  assert.equal(fetchCalls, 0);
});

test('secrets cleanup rejects a zero-deletion success response', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/capabilities')) return capabilityResponse();
    assert.match(
      String(url),
      /\/v1\/brain-assets\/test-brain\?asset_type=secret&confirm_brain_id=test-brain$/,
    );
    assert.equal(init.method, 'DELETE');
    return new Response(JSON.stringify({
      data: { deleted: 0, errors: 0, remaining: 0, verified_absent: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const { io, err } = makeIo();
  assert.equal(await runSecretsCleanup(dir, io, { confirmBrainId: 'test-brain' }), 1);
  assert.match(err.join('\n'), /invalid cleanup result/);
});

test('secrets cleanup rejects missing or mismatched brain confirmation before network access', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network must not be reached');
  };

  for (const confirmBrainId of [undefined, 'test-brian']) {
    const { io, err } = makeIo();
    const code = await runSecretsCleanup(dir, io, { confirmBrainId });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /exact brain confirmation/i);
  }
  assert.equal(fetchCalls, 0);
});

test('Node entrypoint fails closed before pull when the secure Bun helper is unavailable', () => {
  const moduleUrl = new URL('../lib/network/commands/secrets.js', import.meta.url).href;
  const nodeBinary = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(path.isAbsolute(nodeBinary));
  const invocation = `
    import { runSecretsPull } from ${JSON.stringify(moduleUrl)};
    const err = [];
    const code = await runSecretsPull(process.cwd(), {
      stdout() {},
      stderr(line) { err.push(line); },
    });
    console.log(JSON.stringify({ code, err }));
  `;
  const result = spawnSync(nodeBinary, ['--input-type=module', '--eval', invocation], {
    cwd: makeProjectDir(),
    env: { ...process.env, PATH: '/nonexistent' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.code, 1);
  assert.match(parsed.err.join('\n'), /secure restore requires Bun/);
});

test('Node entrypoint fails closed before push when the secure Bun helper is unavailable', () => {
  const moduleUrl = new URL('../lib/network/commands/secrets.js', import.meta.url).href;
  const nodeBinary = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(path.isAbsolute(nodeBinary));
  const invocation = `
    import { runSecretsPush } from ${JSON.stringify(moduleUrl)};
    const err = [];
    const code = await runSecretsPush(process.cwd(), {
      stdout() {},
      stderr(line) { err.push(line); },
    });
    console.log(JSON.stringify({ code, err }));
  `;
  const result = spawnSync(nodeBinary, ['--input-type=module', '--eval', invocation], {
    cwd: makeProjectDir(),
    env: { ...process.env, PATH: '/nonexistent' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.code, 1);
  assert.match(parsed.err.join('\n'), /secure read requires Bun/);
});

test('secrets push sends no payload when POSIX no-follow read primitives are unsupported', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  fs.writeFileSync(path.join(dir, '.env'), 'fixture-only\n');
  let payloadPosts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/capabilities')) return capabilityResponse();
    payloadPosts += 1;
    return new Response('{}', { status: 500 });
  };

  const { io, err } = makeIo();
  const code = await runSecretsPush(dir, io, {
    readHooks: { noFollowSupported: false },
  });
  assert.equal(code, 1);
  assert.equal(payloadPosts, 0);
  assert.match(err.join('\n'), /secure secret read unavailable|POSIX.*support/i);
});

test('secrets pull requests no payload when POSIX no-follow restore primitives are unsupported', async () => {
  const dir = makeProjectDir();
  await setupCreds(dir);
  let payloadGets = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/capabilities')) return capabilityResponse();
    payloadGets += 1;
    return new Response(JSON.stringify({ data: { files: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { io, err } = makeIo();
  const code = await runSecretsPull(dir, io, {
    restoreHooks: { noFollowSupported: false },
  });

  assert.equal(code, 1);
  assert.equal(payloadGets, 0);
  assert.match(err.join('\n'), /secure restore unavailable|POSIX.*support/i);
});
