import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeCredentials } from '../lib/auth/credentials.js';
import { runBrainCommand, runBrainPush, runBrainVerify } from '../lib/network/commands/brain.js';

const REAL_FETCH = globalThis.fetch;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeProjectDir(agentId: string = 'verify-brain.gm'): string {
  const dir = mkd('brain-verify-cli-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'brain', 'config.json'),
    JSON.stringify({ agent_id: agentId, project_id: 'verify-brain', role: 'sdk_engineer' }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: agentId,
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  return dir;
}

async function setupTestCreds(dir: string, creds: { apiKey: string; serverUrl: string }) {
  const credsFile = path.join(dir, 'test-credentials');
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  process.env.AGENTBOOTUP_CONFIG_FILE = path.join(dir, 'test-config.json');
  // Push+verify round-trip fixtures exercise the documented converge-off
  // compatibility path for raw memory hashes.
  process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED = '1';
  await writeCredentials(creds);
}

function hashFromBase64(contentBase64: string): { hash: string; size: number } {
  const raw = Buffer.from(contentBase64, 'base64');
  return {
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    size: raw.byteLength,
  };
}

afterEach(() => {
  delete process.env.AGENTBOOTUP_CREDS_FILE;
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
  delete process.env.AGENTBOOTUP_MEMORY_CONVERGE_DISABLED;
  globalThis.fetch = REAL_FETCH;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runBrainVerify exits 0 when all local and remote hashes match', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  let remoteFiles: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url: string, init: RequestInit) => {
    if (url.includes('/push')) {
      const payload = JSON.parse(String(init.body)) as { files: Array<{ path: string; content_base64: string; asset_type: string; cli: string }> };
      remoteFiles = payload.files.map((f) => {
        const h = hashFromBase64(f.content_base64);
        return { path: f.path, hash: h.hash, size: h.size, asset_type: f.asset_type, cli: f.cli, synced_at: '2026-03-04T00:00:00Z' };
      });
      return new Response(JSON.stringify({ data: { results: payload.files.map((f) => ({ path: f.path, status: 'pushed' })) } }), { status: 200 });
    }
    if (url.includes('/hashes')) {
      return new Response(JSON.stringify({ data: { brain_id: 'verify-brain.gm', files: remoteFiles, total: remoteFiles.length } }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  await runBrainPush([], makeIo().io, dir);
  const { io } = makeIo();
  const code = await runBrainVerify([], io, dir);
  assert.equal(code, 0);
});

test('runBrainVerify exits 1 when a local file drifts', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  const memoryPath = path.join(dir, 'memory', 'MEMORY.md');
  fs.writeFileSync(memoryPath, '# Memory v1\n');

  let remoteFiles: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url: string, init: RequestInit) => {
    if (url.includes('/push')) {
      const payload = JSON.parse(String(init.body)) as { files: Array<{ path: string; content_base64: string; asset_type: string; cli: string }> };
      remoteFiles = payload.files.map((f) => {
        const h = hashFromBase64(f.content_base64);
        return { path: f.path, hash: h.hash, size: h.size, asset_type: f.asset_type, cli: f.cli, synced_at: '2026-03-04T00:00:00Z' };
      });
      return new Response(JSON.stringify({ data: { results: payload.files.map((f) => ({ path: f.path, status: 'pushed' })) } }), { status: 200 });
    }
    if (url.includes('/hashes')) {
      return new Response(JSON.stringify({ data: { brain_id: 'verify-brain.gm', files: remoteFiles, total: remoteFiles.length } }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  await runBrainPush([], makeIo().io, dir);
  fs.writeFileSync(memoryPath, '# Memory v2 drifted\n');

  const { io, out } = makeIo();
  const code = await runBrainVerify([], io, dir);
  assert.equal(code, 1);
  assert.match(out.join('\n'), /DRIFT DETECTED/);
});

test('runBrainVerify exits 2 on network failure', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED test verify endpoint');
  };

  const { io, err } = makeIo();
  const code = await runBrainVerify([], io, dir);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /ECONNREFUSED/);
});

test('runBrainVerify exits 3 when remote list is empty', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { brain_id: 'verify-brain.gm', files: [], total: 0 } }), { status: 200 });

  const { io, out } = makeIo();
  const code = await runBrainVerify([], io, dir);
  assert.equal(code, 3);
  assert.match(out.join('\n'), /NEVER SYNCED/);
});

test('--quiet suppresses verify output', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { brain_id: 'verify-brain.gm', files: [], total: 0 } }), { status: 200 });

  const { io, out, err } = makeIo();
  const code = await runBrainVerify(['--quiet'], io, dir);
  assert.equal(code, 3);
  assert.equal(out.length, 0);
  assert.equal(err.length, 0);
});

test('--json emits parseable verify payload', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { brain_id: 'verify-brain.gm', files: [], total: 0 } }), { status: 200 });

  const { io, out } = makeIo();
  const code = await runBrainVerify(['--json'], io, dir);
  assert.equal(code, 3);
  const payload = JSON.parse(out[0]);
  assert.equal(payload.brain_id, 'verify-brain.gm');
  assert.ok(Array.isArray(payload.matched));
  assert.ok(Array.isArray(payload.remoteOnly));
});

test('--json drift output is emitted on stdout with exit 1', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Local\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      data: {
        brain_id: 'verify-brain.gm',
        files: [{
          path: 'memory/MEMORY.md',
          hash: crypto.createHash('sha256').update(Buffer.from('# Remote\n')).digest('hex'),
          size: Buffer.byteLength('# Remote\n'),
          asset_type: 'memory',
          cli: 'shared',
          synced_at: '2026-03-04T00:00:00Z',
        }],
        total: 1,
      },
    }), { status: 200 });

  const { io, out, err } = makeIo();
  const code = await runBrainVerify(['--json'], io, dir);
  assert.equal(code, 1);
  assert.equal(err.length, 0, 'json drift output should not go to stderr');
  const payload = JSON.parse(out[0]);
  assert.equal(payload.status, 'DRIFT DETECTED');
});

test('--subset memory only compares memory files', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'demo', 'SKILL.md'), '# Skill\n');

  globalThis.fetch = async (url: string) => {
    assert.match(url, /asset_type=memory/);
    return new Response(JSON.stringify({
      data: {
        brain_id: 'verify-brain.gm',
        files: [{
          path: 'memory/MEMORY.md',
          hash: crypto.createHash('sha256').update(Buffer.from('# Memory\n')).digest('hex'),
          size: Buffer.byteLength('# Memory\n'),
          asset_type: 'memory',
          cli: 'shared',
          synced_at: '2026-03-04T00:00:00Z',
        }],
        total: 1,
      },
    }), { status: 200 });
  };

  const { io } = makeIo();
  const code = await runBrainVerify(['--subset', 'memory'], io, dir);
  assert.equal(code, 0);
});

test('--asset-type memory only compares memory files', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'demo', 'SKILL.md'), '# Skill\n');

  globalThis.fetch = async (url: string) => {
    assert.match(url, /asset_type=memory/);
    return new Response(JSON.stringify({
      data: {
        brain_id: 'verify-brain.gm',
        files: [{
          path: 'memory/MEMORY.md',
          hash: crypto.createHash('sha256').update(Buffer.from('# Memory\n')).digest('hex'),
          size: Buffer.byteLength('# Memory\n'),
          asset_type: 'memory',
          cli: 'shared',
          synced_at: '2026-03-04T00:00:00Z',
        }],
        total: 1,
      },
    }), { status: 200 });
  };

  const { io } = makeIo();
  const code = await runBrainVerify(['--asset-type', 'memory'], io, dir);
  assert.equal(code, 0);
});

test('--subset invalid value returns exit 2', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  const { io, err } = makeIo();
  const code = await runBrainVerify(['--subset', 'bad-type'], io, dir);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /unknown --subset value/);
});

test('--asset-type invalid value returns exit 2', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  const { io, err } = makeIo();
  const code = await runBrainVerify(['--asset-type', 'bad-type'], io, dir);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /unknown --asset-type value/);
});

test('--asset-type missing value returns exit 2', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  const { io, err } = makeIo();
  const code = await runBrainVerify(['--asset-type'], io, dir);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /--asset-type requires a value/);
});

test('verify rejects using --subset with --asset-type together', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  const { io, err } = makeIo();
  const code = await runBrainVerify(['--subset', 'memory', '--asset-type', 'memory'], io, dir);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /either --subset or --asset-type/);
});

test('missing credentials returns exit 2', async () => {
  const dir = makeProjectDir();
  process.env.AGENTBOOTUP_CREDS_FILE = path.join(dir, 'missing-creds');
  const { io, err } = makeIo();
  const code = await runBrainVerify([], io, dir);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /no credentials/);
});

test('missing brain config returns exit 2', async () => {
  const dir = mkd('brain-verify-no-config-');
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  const { io, err } = makeIo();
  const code = await runBrainVerify([], io, dir);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /No non-empty project agent ID/);
  assert.match(err.join('\n'), /agentbootup\.json/);
  assert.match(err.join('\n'), /brain\/config\.json/);
  assert.match(err.join('\n'), /agent_id/);
  assert.match(err.join('\n'), /agentId/);
});

test('local hash read failure returns exit 2', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  const memoryPath = path.join(dir, 'memory', 'MEMORY.md');
  fs.writeFileSync(memoryPath, '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { brain_id: 'verify-brain.gm', files: [], total: 0 } }), { status: 200 });

  const originalRead = fs.readFileSync;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: never) => {
    if (String(target).endsWith('memory/MEMORY.md')) {
      throw new Error('EACCES: permission denied, open memory/MEMORY.md');
    }
    return originalRead(target as never, options as never);
  }) as typeof fs.readFileSync;

  try {
    const { io, err } = makeIo();
    const code = await runBrainVerify([], io, dir);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /permission denied/);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('runBrainCommand dispatches verify subcommand', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { brain_id: 'verify-brain.gm', files: [], total: 0 } }), { status: 200 });

  const { io } = makeIo();
  const code = await runBrainCommand(['verify', '--cwd', dir], io);
  assert.equal(code, 3);
});

test('malformed server response returns exit 2', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { brain_id: 'verify-brain.gm', files: { not: 'array' } } }), { status: 200 });

  const { io, err } = makeIo();
  const code = await runBrainVerify([], io, dir);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /invalid server response/);
});

test('malformed hash record returns exit 2', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# Memory\n');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      data: {
        brain_id: 'verify-brain.gm',
        files: [{ path: 'memory/MEMORY.md', hash: 123, size: 'bad' }],
        total: 1,
      },
    }), { status: 200 });

  const { io, err } = makeIo();
  const code = await runBrainVerify([], io, dir);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /invalid hash record/);
});

// A verifiable project always has at least one local asset: brain/config.json is
// required (absent it, verify exits 2), and it is itself counted by computeLocalHashes.
// So "local empty" is unreachable, and a bare brain against an empty remote is
// NEVER SYNCED — not IN SYNC. This pins the localTotal > 0 boundary.
test('bare brain (only brain/config.json) against empty remote returns exit 3, not 0', async () => {
  const dir = makeProjectDir();
  await setupTestCreds(dir, { apiKey: 'test-key', serverUrl: 'https://test.example.com' });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { brain_id: 'verify-brain.gm', files: [], total: 0 } }), { status: 200 });

  const { io, out } = makeIo();
  const code = await runBrainVerify([], io, dir);
  assert.equal(code, 3);
  assert.match(out.join('\n'), /NEVER SYNCED/);
  assert.doesNotMatch(out.join('\n'), /IN SYNC/);
});

test('verify --full accepts camelCase project identity', async () => {
  const dir = mkd('brain-verify-full-camel-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'brain', 'config.json'),
    JSON.stringify({ agentId: 'camel-brain.gm' }),
  );
  fs.writeFileSync(
    path.join(dir, 'brain', 'config.secret.json'),
    JSON.stringify({ admp_agent_id: 'camel-brain.gm' }),
  );

  const { io, out, err } = makeIo();
  const code = await runBrainVerify(['--full'], io, dir);

  assert.equal(code, 0, `${out.join('\n')}\n${err.join('\n')}`);
  assert.match(out.join('\n'), /all checks passed/);
});

test('verify --full --online pings the resolved camelCase identity', async () => {
  const dir = mkd('brain-verify-full-online-camel-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'brain', 'config.json'),
    JSON.stringify({ agentId: 'camel-online.gm' }),
  );
  fs.writeFileSync(
    path.join(dir, 'brain', 'config.secret.json'),
    JSON.stringify({ admp_agent_id: 'camel-online.gm' }),
  );
  let requestedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response('', { status: 200 });
  };

  const { io, out, err } = makeIo();
  const code = await runBrainVerify(
    ['--full', '--online', '--admp-url', 'https://admp.example'],
    io,
    dir,
  );

  assert.equal(code, 0, `${out.join('\n')}\n${err.join('\n')}`);
  assert.equal(requestedUrl, 'https://admp.example/v1/agents/camel-online.gm/ping');
});

test('verify --full fails closed on conflicting identity and preserves JSON output', async () => {
  const dir = mkd('brain-verify-full-conflict-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
  );
  fs.writeFileSync(
    path.join(dir, 'brain', 'config.secret.json'),
    JSON.stringify({ admp_agent_id: 'snake.gm' }),
  );
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('', { status: 200 });
  };

  const { io, out, err } = makeIo();
  const code = await runBrainVerify(['--full', '--online', '--json'], io, dir);

  assert.equal(code, 1);
  assert.equal(err.length, 0);
  assert.equal(fetchCalled, false);
  const payload = JSON.parse(out.join('\n'));
  assert.equal(payload.ok, false);
  assert.ok(Array.isArray(payload.failures));
  const message = JSON.stringify(payload.failures);
  assert.match(message, /agent_id/);
  assert.match(message, /agentId/);
  assert.match(message, /refusing to choose a brain/);
});
