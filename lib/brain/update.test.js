import { test, expect } from 'bun:test';

import { runBrainUpdate } from './update.js';
import { CREDS_STATE_OK } from '../auth/credentials.js';

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

test('--help exits 0', async () => {
  const { io, out } = makeIo();
  const code = await runBrainUpdate(['--help'], io, {});
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('Usage');
});

test('missing brain-id exits 1', async () => {
  const { io, err } = makeIo();
  const code = await runBrainUpdate(['--repo', 'https://github.com/org/repo.git'], io, {});
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('brain-id');
});

test('no updatable fields exits 1', async () => {
  const { io, err } = makeIo();
  const code = await runBrainUpdate(['my-brain'], io, {});
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('nothing to update');
});

test('attach repo: PATCHes /v1/brains/:id with repo_url and exits 0', async () => {
  let method;
  let url;
  let sentPayload;
  const fetch = async (u, opts) => {
    url = u;
    method = opts.method;
    sentPayload = JSON.parse(opts.body);
    return { status: 200, json: async () => ({ data: { id: 'my-brain' } }) };
  };
  const { io, out } = makeIo();
  const code = await runBrainUpdate(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(method).toBe('PATCH');
  expect(url).toContain('/v1/brains/my-brain');
  expect(sentPayload.repo_url).toBe('https://github.com/org/repo.git');
  expect(out.join('\n')).toContain('Updated: my-brain');
});

test('--dry-run prints payload and does not call fetch', async () => {
  let called = false;
  const fetch = async () => { called = true; return { status: 200, json: async () => ({}) }; };
  const { io, out } = makeIo();
  const code = await runBrainUpdate(
    ['my-brain', '--repo', 'https://github.com/org/repo.git', '--repo-branch', 'develop', '--dry-run'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(0);
  expect(called).toBe(false);
  const payload = JSON.parse(out.find((l) => l.startsWith('{')));
  expect(payload.repo_url).toBe('https://github.com/org/repo.git');
  expect(payload.repo_branch).toBe('develop');
});

test('404 for unregistered brain exits 1 with helpful message', async () => {
  const fetch = async () => ({ status: 404, json: async () => ({ error: { code: 'not_found' } }) });
  const { io, err } = makeIo();
  const code = await runBrainUpdate(
    ['ghost-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('not registered');
});

test('--repo without value exits 1', async () => {
  const { io, err } = makeIo();
  const code = await runBrainUpdate(['my-brain', '--repo'], io, {});
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('--repo requires a value');
});

test('network error exits 1', async () => {
  const fetch = async () => { throw new Error('ENOTFOUND'); };
  const { io, err } = makeIo();
  const code = await runBrainUpdate(
    ['my-brain', '--repo', 'https://github.com/org/repo.git'],
    io,
    { inspectCredentials: okCreds(), fetch },
  );
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('network error');
});
