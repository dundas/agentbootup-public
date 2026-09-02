import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';

import { runBrainRegister } from './register.js';
import { CREDS_STATE_OK } from '../auth/credentials.js';

function tmpId() {
  return crypto.randomBytes(8).toString('hex');
}

let tmpDir;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `register-test-${tmpId()}`);
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

function okCreds(serverUrl = 'https://agentbootup.fly.dev') {
  return async () => ({ state: CREDS_STATE_OK, creds: { apiKey: 'test-key', serverUrl } });
}

function mockFetch(status, body) {
  let called = false;
  const fn = async () => {
    called = true;
    return {
      status,
      json: async () => body,
    };
  };
  fn.wasCalled = () => called;
  return fn;
}

async function writeProjectConfig(dir, config) {
  await fsp.writeFile(path.join(dir, 'agentbootup.json'), JSON.stringify(config, null, 2));
}

test('--help exits 0', async () => {
  const { io, out } = makeIo();
  const code = await runBrainRegister(['--help'], io, {});
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('Usage');
});

test('-h exits 0', async () => {
  const { io, out } = makeIo();
  const code = await runBrainRegister(['-h'], io, {});
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('Usage');
});

test('success path — HTTP 201 exits 0 and prints Registered', async () => {
  const fetch = mockFetch(201, { data: { id: 'my-brain' } });
  const { io, out } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('Registered: my-brain');
  expect(out.join('\n')).toContain('Next: agentbootup brain push');
});

test('success path — HTTP 200 exits 0', async () => {
  const fetch = mockFetch(200, { data: { id: 'my-brain' } });
  const { io, out } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('Registered: my-brain');
});

test('HTTP 409 exits 0 with already-registered message', async () => {
  const fetch = mockFetch(409, {});
  const { io, out, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('already registered');
  expect(err).toHaveLength(0);
});

test('body.error.code === already_registered exits 0', async () => {
  const fetch = mockFetch(400, { error: { code: 'already_registered' } });
  const { io, out, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('already registered');
  expect(err).toHaveLength(0);
});

test('missing --repo with no agentbootup.json registers a repo-less brain (exits 0)', async () => {
  let sentPayload;
  const fetch = async (_url, opts) => {
    sentPayload = JSON.parse(opts.body);
    return { status: 201, json: async () => ({}) };
  };
  const { io, out } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--cwd', tmpDir],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('Registered: my-brain');
  // Repo-less registration omits repo_url entirely rather than sending null/empty.
  expect('repo_url' in sentPayload).toBe(false);
});

test('missing --repo falls back to agentbootup.json repo_url', async () => {
  await writeProjectConfig(tmpDir, { repo_url: 'https://github.com/org/fallback.git' });
  const fetch = mockFetch(201, {});
  const { io, out } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--cwd', tmpDir],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('Registered: my-brain');
});

test('malformed agentbootup.json exits 1 with parse error message', async () => {
  await fsp.writeFile(path.join(tmpDir, 'agentbootup.json'), '{ invalid json }');
  const { io, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--cwd', tmpDir],
    io,
    { inspectCredentials: okCreds() },
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('invalid JSON');
});

test('credentials missing exits 1 with recovery message', async () => {
  const { io, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: async () => ({ state: 'missing' }) },
  );
  expect(code).toBe(1);
  expect(err.join('\n').length).toBeGreaterThan(0);
});

test('network error exits 1 with error message', async () => {
  const fetch = async () => { throw new Error('getaddrinfo ENOTFOUND agentbootup.fly.dev'); };
  const { io, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('network error');
});

test('server 422 with error.message exits 1 and prints message', async () => {
  const fetch = mockFetch(422, { error: { message: 'missing required field: id' } });
  const { io, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('missing required field: id');
});

test('server 500 exits 1', async () => {
  const fetch = mockFetch(500, {});
  const { io } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(1);
});

test('--dry-run exits 0, prints payload as JSON, does not call fetch', async () => {
  const fetch = mockFetch(201, {});
  const { io, out } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git', '--dry-run'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(fetch.wasCalled()).toBe(false);
  const payload = JSON.parse(out.find(l => l.startsWith('{')));
  expect(payload.id).toBe('my-brain');
  expect(payload.repo_url).toBe('https://github.com/org/repo.git');
});

test('--vault-namespace defaults to brain-id in payload', async () => {
  let sentPayload;
  const fetch = async (_url, opts) => {
    sentPayload = JSON.parse(opts.body);
    return { status: 201, json: async () => ({}) };
  };
  const { io } = makeIo();
  await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(sentPayload.vault_namespace).toBe('my-brain');
});

test('--type default is project_gm in payload', async () => {
  let sentPayload;
  const fetch = async (_url, opts) => {
    sentPayload = JSON.parse(opts.body);
    return { status: 201, json: async () => ({}) };
  };
  const { io } = makeIo();
  await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(sentPayload.type).toBe('project_gm');
});

test('custom --type and --vault-namespace are passed through', async () => {
  let sentPayload;
  const fetch = async (_url, opts) => {
    sentPayload = JSON.parse(opts.body);
    return { status: 201, json: async () => ({}) };
  };
  const { io } = makeIo();
  await runBrainRegister(
    [
      'my-brain',
      '--repo', 'https://github.com/org/repo.git',
      '--type', 'custom_type',
      '--vault-namespace', 'custom-ns',
    ],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(sentPayload.type).toBe('custom_type');
  expect(sentPayload.vault_namespace).toBe('custom-ns');
});

test('missing brain-id exits 1', async () => {
  const { io, err } = makeIo();
  const code = await runBrainRegister(
    ['--repo', 'https://github.com/org/repo.git'],
    io,
    {},
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('brain-id');
});

test('--path accepted as alias for --cwd (agentbootup.json fallback uses --path dir)', async () => {
  await writeProjectConfig(tmpDir, { repo_url: 'https://github.com/org/fallback.git' });
  const fetch = mockFetch(201, {});
  const { io, out } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--path', tmpDir],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('Registered: my-brain');
});

test('value-taking flag with missing operand exits 1 with clear error', async () => {
  const { io, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo'],
    io,
    {},
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('--repo requires a value');
});

test('unknown flag exits 1 with clear error', async () => {
  const { io, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git', '--verbose'],
    io,
    {},
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('unknown flag: --verbose');
});

test('extra positional arg after brain-id exits 1', async () => {
  const { io, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', 'unexpected-extra', '--repo', 'https://github.com/org/repo.git'],
    io,
    {},
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('unexpected argument');
});

test('server 401/403 exits 1 and prints error message', async () => {
  const fetch = mockFetch(403, { error: { message: 'Forbidden' } });
  const { io, err } = makeIo();
  const code = await runBrainRegister(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('Forbidden');
});
