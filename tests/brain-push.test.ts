import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeCredentials } from '../lib/auth/credentials.js';
import { discoverAssets, runBrainCommand, runBrainPush, PUSH_BATCH_SIZE } from '../lib/network/commands/brain.js';

// ── Helpers ────────────────────────────────────────────────────────────────

// Save real fetch once so afterEach can always restore it, even if a test throws
// before it gets a chance to save __origFetch itself.
const REAL_FETCH = globalThis.fetch;

// Track temp dirs so afterEach can clean them up.
const tempDirs: string[] = [];

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
  };
}

function mkd(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); // nosemgrep: path-join-resolve-traversal -- test helper creates temp dirs under the OS temp root
  tempDirs.push(dir);
  return dir;
}

/** Create a temp project dir with agentbootup.json. */
function makeProjectDir(agentId: string = 'test-brain.gm'): string {
  const dir = mkd('brain-push-test-');
  fs.writeFileSync(
    path.join(dir, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: agentId }, null, 2)
  );
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: agentId,
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  return dir;
}

/** Write test credentials to a temp file and point AGENTBOOTUP_CREDS_FILE at it. */
async function setupTestCreds(dir: string, creds: { apiKey: string; serverUrl: string }) {
  const credsFile = path.join(dir, 'test-credentials'); // nosemgrep: path-join-resolve-traversal -- test helper writes credentials into its temp workspace only
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  process.env.AGENTBOOTUP_CONFIG_FILE = path.join(dir, 'test-config.json');
  // Most legacy push tests exercise the explicit rollback path. Dedicated
  // regressions below remove this override to prove default-on fail-closed.
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED = '1';
  await writeCredentials(creds);
}

// ── Restore env + fetch + temp dirs after each test ───────────────────────

afterEach(() => {
  delete process.env.AGENTBOOTUP_CREDS_FILE;
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_ENABLED;
  delete process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES;
  globalThis.fetch = REAL_FETCH;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────

test('discoverAssets publishes exactly the selected memory set, including binary files', () => {
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# selected\n');
  fs.writeFileSync(path.join(dir, 'memory', 'audio.m4a'), Buffer.from([0, 255, 1]));
  fs.writeFileSync(path.join(dir, 'memory', 'unselected-name.md'), 'do not leak\n');
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'test-brain.gm',
    include: [
      { path: 'memory/MEMORY.md', class: 'canonical' },
      { path: 'memory/audio.m4a', class: 'attachment' },
    ],
  }));

  const assets = discoverAssets(dir, new Set(['memory']));
  assert.deepEqual(assets.map((asset) => asset.relFromProject), [
    'memory/audio.m4a',
    'memory/MEMORY.md',
  ]);
});

test('discoverAssets fails closed for memory without policy but leaves filtered non-memory discovery unchanged', () => {
  const dir = makeProjectDir();
  fs.rmSync(path.join(dir, 'brain-backup.json'));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# memory\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# agents\n');

  assert.throws(() => discoverAssets(dir, new Set(['memory'])), /brain-backup\.json/i);
  assert.deepEqual(
    discoverAssets(dir, new Set(['config'])).map((asset) => asset.relFromProject),
    ['AGENTS.md'],
  );
});

test('discoverAssets includes portable backup policy files as config assets', () => {
  const dir = makeProjectDir();
  fs.writeFileSync(path.join(dir, '.brainignore'), 'memory/private/**\n');
  const paths = discoverAssets(dir, new Set(['config'])).map((asset) => asset.relFromProject);
  assert.equal(paths.includes('brain-backup.json'), true);
  assert.equal(paths.includes('.brainignore'), true);
});

test('missing credentials → error exit 1', async () => {
  const dir = makeProjectDir();
  // Do NOT set up credentials
  delete process.env.AGENTBOOTUP_CREDS_FILE;
  // Point to a nonexistent file
  process.env.AGENTBOOTUP_CREDS_FILE = path.join(dir, 'no-such-creds');

  const { io, err } = makeIo();
  const code = await runBrainPush(['--subset', 'memory'], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /no credentials/);
  assert.match(err.join('\n'), /agentbootup auth login/);
});

test('missing project config → error exit 1', async () => {
  const dir = mkd('brain-push-no-config-');
  // No agentbootup.json created

  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  const { io, err } = makeIo();
  const code = await runBrainPush([], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /No non-empty project agent ID/);
  assert.match(err.join('\n'), /agentbootup\.json/);
  assert.match(err.join('\n'), /brain\/config\.json/);
});

test('malformed project config → error exit 1', async () => {
  const dir = mkd('brain-push-bad-config-');
  fs.writeFileSync(path.join(dir, 'agentbootup.json'), '{ not valid json ');

  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  const { io, err } = makeIo();
  const code = await runBrainPush([], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /invalid JSON/);
  assert.match(err.join('\n'), /agentbootup\.json/);
  assert.match(err.join('\n'), /brain\/config\.json/);
  assert.match(err.join('\n'), /agent_id/);
  assert.match(err.join('\n'), /agentId/);
});

test('agentbootup.json missing agent_id field → error exit 1', async () => {
  const dir = mkd('brain-push-no-agentid-');
  // File exists but has no agent_id field
  fs.writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ version: '2.0', role: 'project' }));

  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  const { io, err } = makeIo();
  const code = await runBrainPush([], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /agentbootup\.json/);
  assert.match(err.join('\n'), /brain\/config\.json/);
  assert.match(err.join('\n'), /agent_id/);
  assert.match(err.join('\n'), /agentId/);
});

test('brain push resolves deployed brain/config.json agentId compatibility spelling', async () => {
  const dir = mkd('brain-push-camel-config-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'brain', 'config.json'), JSON.stringify({ agentId: 'camel-brain.gm' }));
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'camel-brain.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  const { io, out, err } = makeIo();
  const code = await runBrainPush(['--dry-run'], io, dir);

  assert.equal(code, 0);
  assert.match(out.join('\n'), /Brain push \(dry-run\): camel-brain\.gm/);
  assert.doesNotMatch(err.join('\n'), /brain push failed/);
});

test('brain push fails closed on conflicting project identity keys', async () => {
  const dir = mkd('brain-push-conflicting-config-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'snake-brain.gm', agentId: 'camel-brain.gm' }),
  );
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  const { io, err } = makeIo();
  const code = await runBrainPush(['snake-brain.gm'], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /brain\/config\.json/);
  assert.match(err.join('\n'), /agent_id.*snake-brain\.gm/);
  assert.match(err.join('\n'), /agentId.*camel-brain\.gm/);
  assert.match(err.join('\n'), /refusing to choose/i);
});

test('--dry-run lists files without calling fetch', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  // Create a memory file
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  let fetchCalled = false;
  
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}), text: async () => '' };
  };

  const { io, out } = makeIo();
  const code = await runBrainPush(['--dry-run'], io, dir);

  assert.equal(code, 0);
  assert.equal(fetchCalled, false, 'fetch should not be called in dry-run');
  const text = out.join('\n');
  assert.match(text, /dry-run/);
  assert.match(text, /memory\/MEMORY\.md/);
  assert.match(text, /Files that would be pushed/);
});

test('--subset memory only discovers memory files', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  // Create files in multiple categories
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'my-skill', 'SKILL.md'), '# Skill\n');

  const capturedPayloads: any[] = [];
  
  globalThis.fetch = async (_url: string, init: any) => {
    capturedPayloads.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({ data: { results: [{ path: 'memory/MEMORY.md', status: 'pushed' }] } }),
      text: async () => '',
    };
  };

  const { io } = makeIo();
  const code = await runBrainPush(['--subset', 'memory'], io, dir);

  assert.equal(code, 0);
  assert.equal(capturedPayloads.length, 1, 'should have made exactly one fetch call');
  const files = capturedPayloads[0].files as any[];
  assert.equal(files.every((f: any) => f.asset_type === 'memory'), true, 'all files should be memory type');
  // Skills should not be included
  assert.equal(files.some((f: any) => f.asset_type === 'skill'), false, 'skills should be excluded');
});

test('default-on brain push omits raw memory while still publishing non-memory assets', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Must use snapshot convergence\n');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'safe-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'safe-skill', 'SKILL.md'), '# Safe skill\n');

  const payloads: any[] = [];
  globalThis.fetch = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    payloads.push(payload);
    return new Response(JSON.stringify({
      data: { results: payload.files.map((file: any) => ({ path: file.path, status: 'pushed' })) },
    }), { status: 200 });
  };

  const { io, err } = makeIo();
  const code = await runBrainPush([], io, dir);

  assert.equal(code, 0);
  const files = payloads.flatMap((payload) => payload.files);
  assert.equal(files.some((file: any) => file.asset_type === 'memory'), false);
  assert.equal(files.some((file: any) => file.asset_type === 'skill'), true);
  assert.match(err.join('\n'), /raw memory publication suppressed/i);
  assert.match(err.join('\n'), /agentbootup memory publish/);
});

test('persisted converge off restores raw memory publication for brain push', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;
  fs.writeFileSync(process.env.AGENTBOOTUP_CONFIG_FILE!, JSON.stringify({ memoryConvergeEnabled: false }));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Rollback path\n');

  const payloads: any[] = [];
  globalThis.fetch = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    payloads.push(payload);
    return new Response(JSON.stringify({
      data: { results: payload.files.map((file: any) => ({ path: file.path, status: 'pushed' })) },
    }), { status: 200 });
  };

  const { io, err } = makeIo();
  assert.equal(await runBrainPush(['--subset', 'memory'], io, dir), 0);
  assert.equal(payloads.flatMap((payload) => payload.files).some((file: any) => file.asset_type === 'memory'), true);
  assert.doesNotMatch(err.join('\n'), /raw memory publication suppressed/i);
});

test('successful push sends correct payload shape', async () => {
  const dir = makeProjectDir('mech-client.gm');
  await setupTestCreds(dir, { apiKey: 'my-api-key', serverUrl: 'https://server.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Test memory\n');

  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedPayload: any = null;

  
  globalThis.fetch = async (url: string, init: any) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedPayload = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        data: {
          results: capturedPayload.files.map((entry: any) => ({ path: entry.path, status: 'pushed' })),
        },
      }),
      text: async () => '',
    };
  };

  const { io, out } = makeIo();
  const code = await runBrainPush([], io, dir);

  assert.equal(code, 0);

  // URL shape
  assert.match(capturedUrl, /\/v1\/brain-assets\/mech-client\.gm\/push/);

  // Auth header
  assert.equal(capturedHeaders['Authorization'], 'Bearer my-api-key');
  assert.equal(capturedHeaders['Content-Type'], 'application/json');

  // Payload shape
  assert.ok(Array.isArray(capturedPayload.files), 'payload.files should be array');
  const file = capturedPayload.files.find((entry: any) => entry.path === 'memory/MEMORY.md');
  assert.equal(file.path, 'memory/MEMORY.md');
  assert.equal(file.asset_type, 'memory');
  assert.equal(file.cli, 'shared'); // 'shared' is the cli value for standard brain sources in getBrainAssetSources
  assert.ok(typeof file.content_base64 === 'string', 'content_base64 should be a string');
  // Verify base64 decodes correctly
  const decoded = Buffer.from(file.content_base64, 'base64').toString('utf-8');
  assert.equal(decoded, '# Test memory\n');

  // Output summary
  const text = out.join('\n');
  assert.match(text, /Brain push/);
  assert.match(text, /Pushed 2 files/);
  assert.match(text, /Done\./);
});

test('push rejects an explicit brain id that conflicts with local project identity', async () => {
  const dir = makeProjectDir('local-brain.gm');
  await setupTestCreds(dir, { apiKey: 'my-api-key', serverUrl: 'https://server.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Test memory\n');

  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('network must not be reached');
  };

  const { io, err } = makeIo();
  const code = await runBrainPush(['remote-brain.gm', '--branch', 'tenant-acme'], io, dir);

  assert.equal(code, 1);
  assert.equal(fetchCalled, false);
  assert.match(err.join('\n'), /remote-brain\.gm/);
  assert.match(err.join('\n'), /local-brain\.gm/);
  assert.match(err.join('\n'), /conflicts with local project identity/);
});

test('push --branch sends branch_id when explicit brain id matches local identity', async () => {
  const dir = makeProjectDir('local-brain.gm');
  await setupTestCreds(dir, { apiKey: 'my-api-key', serverUrl: 'https://server.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Test memory\n');

  let capturedUrl = '';
  let capturedPayload: any = null;
  globalThis.fetch = async (url: string, init: any) => {
    capturedUrl = url;
    capturedPayload = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        data: {
          results: capturedPayload.files.map((entry: any) => ({ path: entry.path, status: 'pushed' })),
        },
      }),
      text: async () => '',
    };
  };

  const { io, out } = makeIo();
  const code = await runBrainPush(['local-brain.gm', '--branch', 'tenant-acme'], io, dir);

  assert.equal(code, 0);
  assert.match(capturedUrl, /\/v1\/brain-assets\/local-brain\.gm\/push/);
  assert.equal(capturedPayload.branch_id, 'tenant-acme');
  assert.match(out.join('\n'), /\[branch: tenant-acme\]/);
});

test('push rejects --branch without a value', async () => {
  const dir = makeProjectDir('local-brain.gm');
  await setupTestCreds(dir, { apiKey: 'my-api-key', serverUrl: 'https://server.example.com' });

  const { io, err } = makeIo();
  const code = await runBrainPush(['remote-brain.gm', '--branch'], io, dir);

  assert.notEqual(code, 0);
  assert.match(err.join('\n'), /--branch requires a value/);
});

test('empty project (no assets) prints warning and exits 0', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  // No assets created beyond brain/config.json

  let fetchCalled = false;
  
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}), text: async () => '' };
  };

  const { io, out: _out, err } = makeIo();
  const code = await runBrainPush(['--subset', 'memory'], io, dir);

  assert.equal(code, 0);
  assert.equal(fetchCalled, false, 'fetch should not be called when no assets found');
  // Warning goes to stderr (error-like diagnostic)
  const text = err.join('\n');
  assert.match(text, /no brain assets found/);
  assert.match(text, /Expected/);
});

test('HTTP error response → errors reported, exit 1', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  
  globalThis.fetch = async () => {
    return {
      ok: false,
      status: 413,
      json: async () => { throw new Error('not json'); },
      text: async () => 'file too large',
    };
  };

  const { io, out: _out, err } = makeIo();
  const code = await runBrainPush(['--subset', 'memory'], io, dir);

  assert.equal(code, 1);
  // Error summary, per-file details, and Done. all go to stderr when there are errors
  const errText = err.join('\n');
  assert.match(errText, /error/i);
  assert.match(errText, /HTTP 413/);
  assert.match(errText, /Done\./);
});

test('brain push splits exact serialized request bodies before exceeding the configured byte budget', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, 'memory', `${name}.md`), '🧠'.repeat(30));
  process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = '360';
  const bodies: string[] = [];

  globalThis.fetch = async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    bodies.push(body);
    const payload = JSON.parse(body);
    return new Response(JSON.stringify({ data: { results: payload.files.map((file) => ({ path: file.path, status: 'pushed' })) } }), { status: 200 });
  };

  const { io } = makeIo();
  assert.equal(await runBrainPush(['--subset', 'memory'], io, dir), 0);
  assert.ok(bodies.length > 1);
  assert.equal(bodies.every((body) => Buffer.byteLength(body, 'utf8') <= 360), true);
  assert.deepEqual(bodies.flatMap((body) => JSON.parse(body).files.map((file) => file.path)), [
    'memory/a.md', 'memory/b.md', 'memory/c.md',
  ]);
});

test('brain push isolates an untransportable file, progresses eligible files, and exits non-green', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'a-small.md'), 'ok');
  fs.writeFileSync(path.join(dir, 'memory', 'z-huge.md'), 'x'.repeat(500));
  process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = '240';
  const pushedPaths: string[] = [];

  globalThis.fetch = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    pushedPaths.push(...payload.files.map((file) => file.path));
    return new Response(JSON.stringify({ data: { results: payload.files.map((file) => ({ path: file.path, status: 'pushed' })) } }), { status: 200 });
  };

  const { io, err } = makeIo();
  assert.equal(await runBrainPush(['--subset', 'memory'], io, dir), 1);
  assert.deepEqual(pushedPaths, ['memory/a-small.md']);
  assert.match(err.join('\n'), /memory\/z-huge\.md.*encoded_request_bytes=.*client_body_budget_bytes=240/);
});

test('brain push splits an unexpected multi-file 413 and preserves ordered per-file success', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, 'memory', `${name}.md`), name);
  const calls: string[][] = [];

  globalThis.fetch = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    calls.push(payload.files.map((file) => file.path));
    return new Response(JSON.stringify({ data: { results: payload.files.map((file) => ({ path: file.path, status: 'pushed' })) } }), {
      status: payload.files.length > 1 ? 413 : 200,
    });
  };

  assert.equal(await runBrainPush(['--subset', 'memory'], makeIo().io, dir), 0);
  assert.deepEqual(calls, [
    ['memory/a.md', 'memory/b.md', 'memory/c.md'],
    ['memory/a.md'],
    ['memory/b.md', 'memory/c.md'],
    ['memory/b.md'],
    ['memory/c.md'],
  ]);
});

test('batching: >500 files triggers multiple fetch calls', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  // Create PUSH_BATCH_SIZE + 100 memory files to trigger 2 batches
  const fileCount = PUSH_BATCH_SIZE + 100;
  const memDir = path.join(dir, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(memDir, `daily-${String(i).padStart(4, '0')}.md`), `# Day ${i}\n`);
  }

  let fetchCallCount = 0;
  const batchSizes: number[] = [];

  globalThis.fetch = async (_url: string, init: RequestInit) => {
    fetchCallCount++;
    const payload = JSON.parse(init.body as string) as { files: Array<{ path: string }> };
    batchSizes.push(payload.files.length);
    const results = payload.files.map((f) => ({ path: f.path, status: 'pushed' }));
    return new Response(JSON.stringify({ data: { results } }), { status: 200 });
  };

  const { io } = makeIo();
  const code = await runBrainPush(['--subset', 'memory'], io, dir);

  assert.equal(code, 0);
  assert.equal(fetchCallCount, 2, `should have made 2 fetch calls for ${fileCount} files at batch size ${PUSH_BATCH_SIZE}`);
  assert.equal(batchSizes[0], PUSH_BATCH_SIZE, 'first batch should be full batch size');
  assert.equal(batchSizes[1], 100, 'second batch should have remaining 100 files');
}, { timeout: 30000 });

test('runBrainCommand dispatches push subcommand', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  
  globalThis.fetch = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string) as { files: Array<{ path: string }> };
    return {
      ok: true,
      json: async () => ({ data: { results: payload.files.map((entry) => ({ path: entry.path, status: 'pushed' })) } }),
      text: async () => '',
    };
  };

  const { io, out } = makeIo();
  const code = await runBrainCommand(['push', '--cwd', dir], io);

  assert.equal(code, 0);
  assert.match(out.join('\n'), /Brain push/);
  assert.match(out.join('\n'), /Done\./);
});

test('runBrainCommand dispatches branch list subcommand', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  globalThis.fetch = async () => {
    return {
      ok: true,
      json: async () => ({ data: { brain_id: 'test-brain.gm', branches: [{ branch_id: 'default', tenant_ref: null, status: 'active' }], total: 1 } }),
      text: async () => '',
    };
  };

  const { io, out } = makeIo();
  const code = await runBrainCommand(['branch', 'list', 'test-brain.gm'], io);

  assert.equal(code, 0);
  assert.match(out.join('\n'), /Brain branches: test-brain\.gm/);
  assert.match(out.join('\n'), /default/);
});

test('runBrainCommand dispatches branch create subcommand', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  let capturedBody: any = null;
  globalThis.fetch = async (_url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ data: { brain_id: 'test-brain.gm', branch_id: 'tenant-acme', tenant_ref: 'Acme Co' } }),
      text: async () => '',
    };
  };

  const { io, out } = makeIo();
  const code = await runBrainCommand(['branch', 'create', 'test-brain.gm', '--tenant', 'Acme Co'], io);

  assert.equal(code, 0);
  assert.equal(capturedBody.branch_id, 'acme-co');
  assert.equal(capturedBody.tenant_ref, 'Acme Co');
  assert.match(out.join('\n'), /Created branch acme-co/);
});

test('runBrainCommand dispatches branch delete subcommand', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  globalThis.fetch = async () => {
    return {
      ok: true,
      json: async () => ({ data: { deleted: 'tenant-acme', brain_id: 'test-brain.gm' } }),
      text: async () => '',
    };
  };

  const { io, out } = makeIo();
  const code = await runBrainCommand(['branch', 'delete', 'test-brain.gm', '--branch', 'tenant-acme'], io);

  assert.equal(code, 0);
  assert.match(out.join('\n'), /Deleted branch tenant-acme/);
});

test('runBrainCommand unknown subcommand → error exit 1', async () => {
  const { io, err } = makeIo();
  const code = await runBrainCommand(['unknown-subcommand'], io);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /Unknown brain subcommand/);
});

test('runBrainCommand --help prints usage and exits 0', async () => {
  const { io, out } = makeIo();
  const code = await runBrainCommand(['--help'], io);

  assert.equal(code, 0);
  assert.match(out.join('\n'), /Subcommands:/);
  assert.match(out.join('\n'), /verify/);
  assert.match(out.join('\n'), /restore/);
});

test('runBrainPush --help prints usage and exits 0 without credentials', async () => {
  const dir = mkd('brain-push-help-');
  delete process.env.AGENTBOOTUP_CREDS_FILE;
  process.env.AGENTBOOTUP_CREDS_FILE = path.join(dir, 'no-such-creds');

  const { io, out, err } = makeIo();
  const code = await runBrainPush(['--help'], io, dir);

  assert.equal(code, 0);
  assert.match(out.join('\n'), /Subcommands:/);
  assert.match(out.join('\n'), /push/);
  assert.equal(err.length, 0, 'help should not emit errors');
});

test('--subset with invalid value → error exit 1', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  const { io, err } = makeIo();
  const code = await runBrainPush(['--subset', 'invalid-type'], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /unknown --subset value/);
});

test('--subset with no value → explicit requires-value error', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  const { io, err } = makeIo();
  const code = await runBrainPush(['--subset'], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /--subset requires a value/);
});

test('timeout (AbortError) → reported as timeout after 30s, exit 1', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () => {
    // Simulate AbortController firing
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    throw err;
  };

  const { io, err } = makeIo();
  const code = await runBrainPush(['--subset', 'memory'], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /timeout after 30s/);
});

test('network failure (non-AbortError) → reported with original message, exit 1', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED test endpoint');
  };

  const { io, err } = makeIo();
  const code = await runBrainPush(['--subset', 'memory'], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /ECONNREFUSED test endpoint/);
});

test('--subset with comma-separated values includes both types', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'my-skill', 'SKILL.md'), '# Skill\n');
  // Protocol file that should be excluded
  fs.mkdirSync(path.join(dir, '.ai', 'protocols'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai', 'protocols', 'PROTOCOL.md'), '# Protocol\n');

  const capturedPayloads: Array<{ files: Array<{ asset_type: string }> }> = [];
  globalThis.fetch = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string) as { files: Array<{ path: string; asset_type: string }> };
    capturedPayloads.push(payload);
    const results = payload.files.map((f) => ({ path: f.path, status: 'pushed' }));
    return new Response(JSON.stringify({ data: { results } }), { status: 200 });
  };

  const { io } = makeIo();
  const code = await runBrainPush(['--subset', 'memory,skills'], io, dir);

  assert.equal(code, 0);
  const allFiles = capturedPayloads.flatMap((p) => p.files);
  const types = new Set(allFiles.map((f) => f.asset_type));
  assert.ok(types.has('memory'), 'memory files should be included');
  assert.ok(types.has('skill'), 'skill files should be included');
  assert.ok(!types.has('protocol'), 'protocol files should be excluded');
});

test('--dry-run + --subset only lists files of that type without fetching', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'my-skill', 'SKILL.md'), '# Skill\n');

  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };

  const { io, out } = makeIo();
  const code = await runBrainPush(['--dry-run', '--subset', 'memory'], io, dir);

  assert.equal(code, 0);
  assert.equal(fetchCalled, false, 'dry-run should not call fetch');
  const text = out.join('\n');
  assert.match(text, /memory\/MEMORY\.md/);
  // Skill should not appear in the listing
  assert.ok(!text.includes('SKILL.md'), 'subset should exclude skill files from dry-run listing');
});

test('partial batch: some files succeed, some fail per-file results', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'good.md'), '# Good\n');
  fs.writeFileSync(path.join(dir, 'memory', 'bad.md'), '# Bad\n');

  globalThis.fetch = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string) as { files: Array<{ path: string }> };
    // Server says good.md pushed, bad.md errored
    const results = payload.files.map((f) =>
      f.path.includes('good')
        ? { path: f.path, status: 'pushed' }
        : { path: f.path, status: 'error', error: 'server rejected this file' }
    );
    return new Response(JSON.stringify({ data: { results } }), { status: 200 });
  };

  const { io, out, err } = makeIo();
  const code = await runBrainPush(['--subset', 'memory'], io, dir);

  assert.equal(code, 1, 'exit 1 when any file errors');
  assert.match(err.join('\n'), /server rejected this file/);
  assert.match(err.join('\n'), /bad\.md/);
  assert.match(out.join('\n'), /Discovered 2 files/);
});

test('oversized file is never sent and makes brain push non-green', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  const largeFilePath = path.join(dir, 'memory', 'too-large.md');
  // 10 MB + 1 byte to trigger MAX_FILE_SIZE guard.
  fs.writeFileSync(largeFilePath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));

  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  };

  const { io, out, err } = makeIo();
  const code = await runBrainPush(['--subset', 'memory'], io, dir);

  assert.equal(code, 1, 'untransportable files must make the operation non-green');
  assert.equal(fetchCalled, false, 'an individually oversized request must never be sent');
  assert.match(err.join('\n'), /memory\/too-large\.md.*encoded_request_bytes=/);
  assert.equal(out.some((line) => /Skipped.*oversized/.test(line)), false);
});

test('empty --subset value → requires-value error exit 1', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  const { io, err } = makeIo();
  const code = await runBrainPush(['--subset', ''], io, dir);

  assert.equal(code, 1);
  assert.match(err.join('\n'), /--subset requires a value/);
});

test('--initial emits gitignore-bypass warning to stderr', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: {} }), { status: 200 });

  const { io, err } = makeIo();
  const code = await runBrainPush(['--initial'], io, dir);

  assert.equal(code, 0);
  assert.match(err.join('\n'), /gitignore bypass is active \(--initial \/ --no-gitignore\)/);
});

test('--no-gitignore alias also emits gitignore-bypass warning', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: {} }), { status: 200 });

  const { io, err } = makeIo();
  const code = await runBrainPush(['--no-gitignore'], io, dir);

  assert.equal(code, 0);
  assert.match(err.join('\n'), /gitignore bypass is active \(--initial \/ --no-gitignore\)/);
});

test('default push does NOT emit --initial warning', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: {} }), { status: 200 });

  const { io, err } = makeIo();
  const code = await runBrainPush([], io, dir);

  assert.equal(code, 0);
  assert.ok(!err.join('\n').includes('gitignore bypass is active'), 'no gitignore-bypass warning on default push');
});
