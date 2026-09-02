/**
 * Tests for runBrainPull in lib/brain/pull.js (FR-6 steps 1–7)
 *
 * Run with: bun test lib/brain/pull.test.js
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';

// ── pull internals under test ─────────────────────────────────────────────────
import {
  parsePullArgs,
  fetchHashIndex,
  downloadAsset,
  computeLocalHash,
  atomicWrite,
  runBrainPull,
  registerWithAdmp,
  startDaemon,
} from './pull.js';

import { CREDS_STATE_OK } from '../auth/credentials.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpId() {
  return crypto.randomBytes(8).toString('hex');
}

let tmpDir;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `pull-test-${tmpId()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** Write a file, creating parent dirs. Returns absolute path. */
async function write(relPath, content = 'placeholder') {
  const abs = path.join(tmpDir, relPath); // nosemgrep: path-join-resolve-traversal — test helper
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf-8');
  return abs;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Collect io output into arrays. */
function makeIo() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    },
    out,
    err,
  };
}

/**
 * Build injectable deps for runBrainPull.
 * All dependencies are mocked so tests are hermetic (no real credentials, no daemon, no ADMP).
 */
function makeTestDeps(overrides = {}) {
  return {
    inspectCredentials: async () => ({
      state: CREDS_STATE_OK,
      creds: { apiKey: 'test-api-key', serverUrl: 'https://agentbootup.fly.dev' },
    }),
    provisionRegistryAccess: async () => ({ ok: true, status: 'configured', secretChanged: false }),
    registerWithAdmp: () => true,
    startDaemon: () => ({ ok: true, alreadyRunning: false }),
    ...overrides,
  };
}

/** Build a fake fetch that returns the given hash list from the /hashes endpoint. */
function makeFetchHashes(files) {
  return async () =>
    new Response(JSON.stringify({ data: { files } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

/** Build a fake fetch that returns a file's content for the download endpoint. */
function makeFetchDownload(contentByPath) {
  return async (url) => {
    const u = new URL(url);
    const p = u.searchParams.get('path');
    const content = contentByPath[p];
    if (content === undefined) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    const b64 = Buffer.from(content).toString('base64');
    return new Response(
      JSON.stringify({ data: { files: [{ path: p, content_base64: b64 }] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

/** Build a fake fetch that handles both /hashes and download based on URL pattern. */
function makeFetchBoth(remoteFiles, contentByPath) {
  return async (url) => {
    if (url.includes('/hashes')) {
      return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    }
    const u = new URL(url);
    const p = u.searchParams.get('path');
    const content = contentByPath[p];
    if (content === undefined) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    const b64 = Buffer.from(content).toString('base64');
    return new Response(
      JSON.stringify({ data: { files: [{ path: p, content_base64: b64 }] } }),
      { status: 200 },
    );
  };
}

// ── parsePullArgs ─────────────────────────────────────────────────────────────

test('parsePullArgs: positional brain-id and --path', () => {
  const args = parsePullArgs(['my-brain', '--path', '/tmp/target', '--dry-run']);
  expect(args.brainIdArg).toBe('my-brain');
  expect(args.target).toBe('/tmp/target');
  expect(args.dryRun).toBe(true);
  expect(args.force).toBe(false);
});

test('parsePullArgs: --force and --verbose', () => {
  const args = parsePullArgs(['--force', '--verbose']);
  expect(args.force).toBe(true);
  expect(args.verbose).toBe(true);
  expect(args.brainIdArg).toBeNull();
});

test('parsePullArgs: --rotate-identity --yes --no-daemon', () => {
  const args = parsePullArgs(['brain-1', '--rotate-identity', '--yes', '--no-daemon']);
  expect(args.rotateIdentity).toBe(true);
  expect(args.yes).toBe(true);
  expect(args.noDaemon).toBe(true);
});

// ── computeLocalHash ──────────────────────────────────────────────────────────

test('computeLocalHash: returns sha256 for existing file', async () => {
  const content = 'hello-world-content';
  const filePath = await write('test.md', content);
  const hash = computeLocalHash(filePath);
  expect(hash).toBe(sha256(content));
});

test('computeLocalHash: returns null for missing file', () => {
  const hash = computeLocalHash(path.join(tmpDir, 'nonexistent.md'));
  expect(hash).toBeNull();
});

// ── atomicWrite ───────────────────────────────────────────────────────────────

test('atomicWrite: writes file and returns ok', () => {
  const dest = path.join(tmpDir, 'subdir', 'file.md');
  const result = atomicWrite(dest, Buffer.from('content'));
  expect(result.ok).toBe(true);
  expect(fs.readFileSync(dest, 'utf-8')).toBe('content');
});

test('atomicWrite: no temp file left on success', () => {
  const dest = path.join(tmpDir, 'file.md');
  atomicWrite(dest, Buffer.from('data'));
  const remaining = fs.readdirSync(tmpDir).filter((f) => f.startsWith('.pull-tmp-'));
  expect(remaining).toHaveLength(0);
});

// ── fetchHashIndex ────────────────────────────────────────────────────────────

test('fetchHashIndex: returns parsed files from /hashes endpoint', async () => {
  const files = [
    { path: '.claude/agents/a.md', hash: 'abc123', size: 10, asset_type: 'agent' },
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = makeFetchHashes(files);
  try {
    const result = await fetchHashIndex('https://agentbootup.fly.dev', 'key', 'brain-1');
    expect(result.ok).toBe(true);
    expect(result.files).toEqual(files);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchHashIndex: returns error on non-2xx', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });
  try {
    const result = await fetchHashIndex('https://agentbootup.fly.dev', 'key', 'b');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── downloadAsset ─────────────────────────────────────────────────────────────

test('downloadAsset: returns buffer for valid response', async () => {
  const content = 'skill content';
  const origFetch = globalThis.fetch;
  globalThis.fetch = makeFetchDownload({ '.claude/skills/foo/SKILL.md': content });
  try {
    const result = await downloadAsset(
      'https://agentbootup.fly.dev', 'key', 'brain-1',
      '.claude/skills/foo/SKILL.md', 'skill',
    );
    expect(result.ok).toBe(true);
    expect(result.buffer.toString('utf-8')).toBe(content);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('downloadAsset: returns error on 404', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  try {
    const result = await downloadAsset('https://agentbootup.fly.dev', 'key', 'b', 'x.md');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('404');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — hash-match skip (3a) ──────────────────────────────────────

test('(3a) hash-match skip: file with matching hash is not re-downloaded', async () => {
  const content = 'agent content';
  await write('.claude/agents/agent.md', content);
  const hash = sha256(content);

  const remoteFiles = [{ path: '.claude/agents/agent.md', hash, size: content.length, asset_type: 'agent' }];

  let downloadCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    downloadCalled = true;
    return new Response('{}', { status: 500 });
  };

  try {
    const { io, out } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir, '--verbose'], io, makeTestDeps());
    expect(code).toBe(0);
    expect(downloadCalled).toBe(false);
    expect(out.some((l) => l.includes('skip (match)'))).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — hash-mismatch update (3b) ─────────────────────────────────

test('(3b) hash-mismatch: file is updated via temp+rename', async () => {
  const oldContent = 'old content';
  const newContent = 'new content from server';
  await write('.claude/agents/agent.md', oldContent);
  const remoteHash = sha256(newContent);

  const remoteFiles = [{ path: '.claude/agents/agent.md', hash: remoteHash, size: newContent.length, asset_type: 'agent' }];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    const b64 = Buffer.from(newContent).toString('base64');
    return new Response(
      JSON.stringify({ data: { files: [{ content_base64: b64 }] } }),
      { status: 200 },
    );
  };

  try {
    const { io } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir], io, makeTestDeps());
    expect(code).toBe(0);
    const written = fs.readFileSync(path.join(tmpDir, '.claude/agents/agent.md'), 'utf-8');
    expect(written).toBe(newContent);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — new file created (3c) ─────────────────────────────────────

test('(3c) new file: created at correct relative path', async () => {
  const content = 'new skill content';
  const remoteFiles = [
    { path: '.claude/skills/my-skill/SKILL.md', hash: sha256(content), size: content.length, asset_type: 'skill' },
  ];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    const b64 = Buffer.from(content).toString('base64');
    return new Response(JSON.stringify({ data: { files: [{ content_base64: b64 }] } }), { status: 200 });
  };

  try {
    const { io } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir], io, makeTestDeps());
    expect(code).toBe(0);
    const dest = path.join(tmpDir, '.claude/skills/my-skill/SKILL.md');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe(content);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — partial failure: temp cleanup (3d) ────────────────────────

test('(3d) partial failure: temp files from current run are cleaned up', async () => {
  const content1 = 'file 1 content';
  const content2 = 'file 2 content';
  const remoteFiles = [
    { path: '.claude/agents/a.md', hash: sha256(content1), size: content1.length, asset_type: 'agent' },
    { path: '.claude/agents/b.md', hash: sha256(content2), size: content2.length, asset_type: 'agent' },
  ];

  let callCount = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    callCount++;
    if (callCount === 1) {
      const b64 = Buffer.from(content1).toString('base64');
      return new Response(JSON.stringify({ data: { files: [{ content_base64: b64 }] } }), { status: 200 });
    }
    return new Response('Server error', { status: 500 });
  };

  try {
    const { io } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir], io, makeTestDeps());
    const remaining = fs.readdirSync(path.join(tmpDir, '.claude/agents')).filter((f) => f.startsWith('.pull-tmp-'));
    expect(remaining).toHaveLength(0);
    expect(code).toBe(1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — dry-run (3e) ───────────────────────────────────────────────

test('(3e) dry-run: nothing written; output shows file list', async () => {
  const remoteFiles = [
    { path: '.claude/agents/a.md', hash: 'newhash', size: 10, asset_type: 'agent' },
  ];
  let downloadCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    downloadCalled = true;
    return new Response('{}', { status: 500 });
  };

  try {
    const { io, out } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir, '--dry-run'], io, makeTestDeps());
    expect(code).toBe(0);
    expect(downloadCalled).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude/agents/a.md'))).toBe(false);
    expect(out.some((l) => l.includes('[dry-run]'))).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — --path creates directory (3f) ─────────────────────────────

test('(3f) --path creates directory if absent', async () => {
  const newDir = path.join(tmpDir, 'brand-new-dir');
  const remoteFiles = [{ path: '.claude/agents/a.md', hash: 'h', size: 5, asset_type: 'agent' }];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    const b64 = Buffer.from('hello').toString('base64');
    return new Response(JSON.stringify({ data: { files: [{ content_base64: b64 }] } }), { status: 200 });
  };

  try {
    expect(fs.existsSync(newDir)).toBe(false);
    const { io } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', newDir], io, makeTestDeps());
    expect(code).toBe(0);
    expect(fs.existsSync(newDir)).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
    await fsp.rm(newDir, { recursive: true, force: true });
  }
});

// ── runBrainPull — --force overwrites brain/config.json (3g) ─────────────────

test('(3g) --force overwrites brain/config.json', async () => {
  await write('brain/config.json', JSON.stringify({ agent_id: 'brain-1', marker: 'old' }));
  const newConfig = JSON.stringify({ agent_id: 'brain-1', marker: 'new' });
  const remoteFiles = [
    { path: 'brain/config.json', hash: sha256(newConfig), size: newConfig.length, asset_type: 'config' },
  ];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    const b64 = Buffer.from(newConfig).toString('base64');
    return new Response(JSON.stringify({ data: { files: [{ content_base64: b64 }] } }), { status: 200 });
  };

  try {
    const { io } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir, '--force'], io, makeTestDeps());
    expect(code).toBe(0);
    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'brain/config.json'), 'utf-8'));
    expect(written.agent_id).toBe('brain-1');
    expect(written.marker).toBe('new');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — config.json skip without --force ───────────────────────────

test('brain/config.json is skipped if it exists and --force is not set', async () => {
  await write('brain/config.json', JSON.stringify({ agent_id: 'brain-1' }));
  const remoteFiles = [
    { path: 'brain/config.json', hash: 'remote-hash', size: 10, asset_type: 'config' },
  ];

  let downloadCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    downloadCalled = true;
    return new Response('{}', { status: 500 });
  };

  try {
    const { io } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir], io, makeTestDeps());
    expect(code).toBe(0);
    expect(downloadCalled).toBe(false);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'brain/config.json'), 'utf-8'));
    expect(cfg.agent_id).toBe('brain-1');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — --help flag ────────────────────────────────────────────────

test('--help flag exits 0 and prints usage', async () => {
  const { io, out } = makeIo();
  const code = await runBrainPull(['--help'], io);
  expect(code).toBe(0);
  expect(out.some((l) => l.includes('Usage:'))).toBe(true);
});

// ── runBrainPull — credential injection (replaces placeholder) ────────────────

test('exits 1 with clear message when credentials are missing', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 }); // shouldn't be reached
  try {
    const { io, err } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir],
      io,
      makeTestDeps({
        inspectCredentials: async () => ({ state: 'missing', creds: null }),
      }),
    );
    expect(code).toBe(1);
    expect(err.length).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — path traversal guard ──────────────────────────────────────

test('path traversal in remote path is skipped with warning', async () => {
  const remoteFiles = [
    { path: '../../../etc/passwd', hash: 'h', size: 5, asset_type: 'config' },
  ];

  let downloadCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    downloadCalled = true;
    return new Response('{}', { status: 500 });
  };

  try {
    const { io, err } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir], io, makeTestDeps());
    expect(downloadCalled).toBe(false);
    expect(err.some((l) => l.includes('path traversal'))).toBe(true);
    expect(code).toBe(0); // traversal is skipped with warning, not a fatal error
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — download failure exits 1 ──────────────────────────────────

test('download failure: exits 1 with errors count in summary', async () => {
  const remoteFiles = [
    { path: '.claude/agents/a.md', hash: 'newhash', size: 5, asset_type: 'agent' },
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    return new Response('Internal Server Error', { status: 500 });
  };

  try {
    const { io, out } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir], io, makeTestDeps());
    expect(code).toBe(1);
    expect(out.some((l) => l.includes('errors:'))).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('config.json download failure: exits 1 with errors count', async () => {
  const remoteFiles = [
    { path: 'brain/config.json', hash: 'remotehash', size: 5, asset_type: 'config' },
  ];
  // No local config.json — will attempt to download
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    return new Response('Server Error', { status: 503 });
  };

  try {
    const { io, err, out } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir, '--force'], io, makeTestDeps());
    expect(code).toBe(1);
    expect(err.some((l) => l.includes('brain/config.json'))).toBe(true);
    expect(out.some((l) => l.includes('errors:'))).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── runBrainPull — empty remote: no-op ───────────────────────────────────────

test('empty remote asset list: exits 0 with no-assets message', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { files: [] } }), { status: 200 });

  try {
    const { io, out } = makeIo();
    const code = await runBrainPull(['brain-1', '--path', tmpDir], io, makeTestDeps());
    expect(code).toBe(0);
    expect(out.some((l) => l.includes('brain push'))).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── Slice 4: Step 5 keypair tests ─────────────────────────────────────────────

/**
 * Helper: fake fetch that returns one remote file so steps 1-4 succeed quickly.
 * The file hash matches nothing locally, so it will be downloaded.
 */
function makeSingleFileFetch(content = 'x') {
  const remoteFiles = [{ path: '.claude/agents/a.md', hash: sha256(content), size: content.length, asset_type: 'agent' }];
  const b64 = Buffer.from(content).toString('base64');
  return async (url) => {
    if (url.includes('/hashes')) return new Response(JSON.stringify({ data: { files: remoteFiles } }), { status: 200 });
    return new Response(JSON.stringify({ data: { files: [{ content_base64: b64 }] } }), { status: 200 });
  };
}

test('(4.6a) no config.secret.json: keypair generated and provisionRegistryAccess called', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();
  let provisionCalled = false;

  try {
    const { io } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir, '--no-daemon'],
      io,
      makeTestDeps({
        provisionRegistryAccess: async ({ projectPath, project }) => {
          provisionCalled = true;
          expect(projectPath).toBe(tmpDir);
          expect(project.agent_id).toBe('brain-1');
          return { ok: true, status: 'configured', secretChanged: true };
        },
        registerWithAdmp: () => true,
      }),
    );
    expect(code).toBe(0);
    expect(provisionCalled).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('(4.6b) config.secret.json present, no --rotate-identity: keypair skipped', async () => {
  // Write a fake secret file so secretExists is true
  await write('brain/config.secret.json', JSON.stringify({ registry_private_key: 'fake-pem-key' }));

  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();
  let provisionCalled = false;

  try {
    const { io } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir, '--no-daemon'],
      io,
      makeTestDeps({
        provisionRegistryAccess: async () => {
          provisionCalled = true;
          return { ok: true, status: 'configured', secretChanged: false };
        },
        registerWithAdmp: () => true,
      }),
    );
    expect(code).toBe(0);
    expect(provisionCalled).toBe(false);
    // Secret file must be untouched
    const secret = JSON.parse(fs.readFileSync(path.join(tmpDir, 'brain/config.secret.json'), 'utf-8'));
    expect(secret.registry_private_key).toBe('fake-pem-key');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('(4.6c) --rotate-identity: new keypair generated; ADMP re-registration called', async () => {
  await write('brain/config.secret.json', JSON.stringify({ registry_private_key: 'old-pem-key' }));
  await write('brain/config.json', JSON.stringify({ agent_id: 'brain-1', registry: { identity: { did: 'did:old', public_key: 'old-pub' } } }));

  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();
  let provisionCalled = false;
  let admpCalled = false;

  try {
    const { io } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir, '--rotate-identity', '--yes', '--no-daemon'],
      io,
      makeTestDeps({
        provisionRegistryAccess: async () => {
          provisionCalled = true;
          return { ok: true, status: 'configured', secretChanged: true };
        },
        registerWithAdmp: (brainId, target) => {
          admpCalled = true;
          expect(brainId).toBe('brain-1');
          return true;
        },
      }),
    );
    expect(code).toBe(0);
    expect(provisionCalled).toBe(true);
    expect(admpCalled).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('(4.6d) --rotate-identity without --yes always exits 1 (no interactive prompt)', async () => {
  // --yes is now required unconditionally for --rotate-identity
  const { io, err } = makeIo();
  const code = await runBrainPull(
    ['brain-1', '--path', tmpDir, '--rotate-identity'],
    io,
    makeTestDeps(),
  );
  expect(code).toBe(1);
  expect(err.some((l) => l.includes('--yes'))).toBe(true);
});

test('(4.6e) ADMP failure: keys kept, recovery command printed, exits 1', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();

  try {
    const { io, err } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir, '--no-daemon'],
      io,
      makeTestDeps({
        provisionRegistryAccess: async () => ({ ok: true, status: 'configured', secretChanged: true }),
        registerWithAdmp: () => false, // ADMP fails
      }),
    );
    expect(code).toBe(1);
    // Recovery command should be mentioned
    expect(err.some((l) => l.includes('brain-msg.ts'))).toBe(true);
    // No files deleted — test just verifies exit code and message
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('(4.6f) daemon already running: prints warning, does not start second daemon', async () => {
  // Write a fake secret so step 5 is skipped
  await write('brain/config.secret.json', JSON.stringify({ registry_private_key: 'key' }));

  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();
  let daemonStartCalled = false;

  try {
    const { io, out } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir],
      io,
      makeTestDeps({
        startDaemon: () => {
          daemonStartCalled = true;
          return { ok: true, alreadyRunning: true };
        },
      }),
    );
    expect(code).toBe(0);
    expect(daemonStartCalled).toBe(true);
    expect(out.some((l) => l.includes('daemon already running'))).toBe(true);
    expect(out.some((l) => l.includes('daemon start'))).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('(4.6g) daemon start failure: files and keys intact; recovery command; exits 1', async () => {
  await write('brain/config.secret.json', JSON.stringify({ registry_private_key: 'key' }));

  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();

  try {
    const { io, err } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir],
      io,
      makeTestDeps({
        startDaemon: () => ({ ok: false, alreadyRunning: false, error: 'launchd rejected' }),
      }),
    );
    expect(code).toBe(1);
    expect(err.some((l) => l.includes('daemon start failed'))).toBe(true);
    expect(err.some((l) => l.includes('agentbootup daemon start'))).toBe(true);
    // Secret file must still exist (keys kept)
    expect(fs.existsSync(path.join(tmpDir, 'brain/config.secret.json'))).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('(4.6h) portfolio key is NOT present in config.secret.json', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();

  let writtenSecret = null;
  try {
    const { io } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir, '--no-daemon'],
      io,
      makeTestDeps({
        provisionRegistryAccess: async ({ projectPath }) => {
          // Write a mock secret file the way registry-provisioning.js would
          const secretPath = path.join(projectPath, 'brain', 'config.secret.json'); // nosemgrep: path-join-resolve-traversal — test helper; projectPath is controlled tmpDir
          fs.mkdirSync(path.dirname(secretPath), { recursive: true });
          writtenSecret = { registry_private_key: 'ed25519-pem-key-only' };
          fs.writeFileSync(secretPath, JSON.stringify(writtenSecret, null, 2) + '\n', { mode: 0o600 });
          return { ok: true, status: 'configured', secretChanged: true };
        },
        registerWithAdmp: () => true,
      }),
    );
    expect(code).toBe(0);
    // Portfolio key (api_key) must NOT appear in config.secret.json
    const secret = JSON.parse(fs.readFileSync(path.join(tmpDir, 'brain/config.secret.json'), 'utf-8'));
    expect(secret.api_key).toBeUndefined();
    expect(secret.apiKey).toBeUndefined();
    expect(secret.portfolio_key).toBeUndefined();
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── Slice 4: Step 5 provisionRegistryAccess ok=false → exit 1 ────────────────

test('provisionRegistryAccess ok=false: exits 1 with recovery message (partial rotation guard)', async () => {
  await write('brain/config.secret.json', JSON.stringify({ registry_private_key: 'old-key' }));
  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();

  try {
    const { io, err } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir, '--rotate-identity', '--yes', '--no-daemon'],
      io,
      makeTestDeps({
        provisionRegistryAccess: async () => ({
          ok: false,
          status: 'mcp_only',
          reason: 'missing_identity',
          secretChanged: false,
        }),
      }),
    );
    expect(code).toBe(1);
    expect(err.some((l) => l.includes('missing_identity'))).toBe(true);
    expect(err.some((l) => l.includes('rotate-keys') || l.includes('provisioning incomplete'))).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── Slice 4: Step 7 no-daemon flag ───────────────────────────────────────────

test('--no-daemon skips daemon step entirely', async () => {
  await write('brain/config.secret.json', JSON.stringify({ registry_private_key: 'key' }));

  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();
  let daemonCalled = false;

  try {
    const { io } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir, '--no-daemon'],
      io,
      makeTestDeps({
        startDaemon: () => {
          daemonCalled = true;
          return { ok: true, alreadyRunning: false };
        },
      }),
    );
    expect(code).toBe(0);
    expect(daemonCalled).toBe(false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── Slice 4: rotation no-op detection ────────────────────────────────────────

test('--rotate-identity: exits 1 if provisionRegistryAccess did not regenerate key (secretChanged: false)', async () => {
  await write('brain/config.secret.json', JSON.stringify({ registry_private_key: 'old-key' }));
  const origFetch = globalThis.fetch;
  globalThis.fetch = makeSingleFileFetch();

  try {
    const { io, err } = makeIo();
    const code = await runBrainPull(
      ['brain-1', '--path', tmpDir, '--rotate-identity', '--yes', '--no-daemon'],
      io,
      makeTestDeps({
        provisionRegistryAccess: async () => ({ ok: true, status: 'configured', secretChanged: false }),
      }),
    );
    expect(code).toBe(1);
    expect(err.some((l) => l.includes('rotation failed'))).toBe(true);
    expect(err.some((l) => l.includes('config.secret.json'))).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── Slice 4: registerWithAdmp spawnSync branches ──────────────────────────────

test('registerWithAdmp: success path — spawnSync exits 0', () => {
  const brainMsgPath = path.join(tmpDir, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts');
  fs.mkdirSync(path.dirname(brainMsgPath), { recursive: true });
  fs.writeFileSync(brainMsgPath, '');

  const { io } = makeIo();
  const fakeSpawnSync = () => ({ status: 0, stdout: 'registered\n', stderr: '', error: null });
  const ok = registerWithAdmp('brain-1', tmpDir, io, fakeSpawnSync);
  expect(ok).toBe(true);
});

test('registerWithAdmp: non-zero exit — returns false and logs stderr', () => {
  const brainMsgPath = path.join(tmpDir, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts');
  fs.mkdirSync(path.dirname(brainMsgPath), { recursive: true });
  fs.writeFileSync(brainMsgPath, '');

  const { io, err } = makeIo();
  const fakeSpawnSync = () => ({ status: 1, stdout: '', stderr: 'connect refused', error: null });
  const ok = registerWithAdmp('brain-1', tmpDir, io, fakeSpawnSync);
  expect(ok).toBe(false);
  expect(err.some((l) => l.includes('connect refused'))).toBe(true);
});

test('registerWithAdmp: spawnSync error — returns false and logs message', () => {
  const brainMsgPath = path.join(tmpDir, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts');
  fs.mkdirSync(path.dirname(brainMsgPath), { recursive: true });
  fs.writeFileSync(brainMsgPath, '');

  const { io, err } = makeIo();
  const fakeSpawnSync = () => ({ status: null, stdout: null, stderr: null, error: new Error('ETIMEDOUT') });
  const ok = registerWithAdmp('brain-1', tmpDir, io, fakeSpawnSync);
  expect(ok).toBe(false);
  expect(err.some((l) => l.includes('ETIMEDOUT'))).toBe(true);
});

test('registerWithAdmp: brain-msg.ts not found — returns true (non-fatal)', () => {
  const { io, out } = makeIo();
  const fakeSpawnSync = () => { throw new Error('should not be called'); };
  const ok = registerWithAdmp('brain-1', tmpDir, io, fakeSpawnSync);
  expect(ok).toBe(true);
  expect(out.some((l) => l.includes('skipped'))).toBe(true);
});

test('registerWithAdmp: prefers brain/brain-msg.ts over skill shim', () => {
  const canonical = path.join(tmpDir, 'brain', 'brain-msg.ts');
  const skill = path.join(tmpDir, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts');
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(canonical, '');
  fs.writeFileSync(skill, '');

  const { io } = makeIo();
  let invokedScript = '';
  const fakeSpawnSync = (_cmd, args) => {
    invokedScript = args[0];
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  const ok = registerWithAdmp('brain-1', tmpDir, io, fakeSpawnSync);
  expect(ok).toBe(true);
  expect(invokedScript).toBe(canonical);
});

// ── Slice 4: startDaemon spawnSync branches ───────────────────────────────────

test('startDaemon: success — exits 0 → ok: true, alreadyRunning: false', () => {
  const { io } = makeIo();
  const fakeSpawnSync = () => ({ status: 0, stdout: 'started PID 1234\n', stderr: '', error: null });
  const result = startDaemon('brain-1', tmpDir, io, fakeSpawnSync);
  expect(result.ok).toBe(true);
  expect(result.alreadyRunning).toBe(false);
});

test('startDaemon: passes target as cwd so single-brain daemon starts in correct directory', () => {
  const { io } = makeIo();
  let capturedOpts;
  const fakeSpawnSync = (_cmd, _args, opts) => {
    capturedOpts = opts;
    return { status: 0, stdout: 'started\n', stderr: '', error: null };
  };
  startDaemon('brain-1', tmpDir, io, fakeSpawnSync);
  expect(capturedOpts.cwd).toBe(tmpDir);
});

test('startDaemon: already running — exits 0 with "already running" → alreadyRunning: true', () => {
  const { io } = makeIo();
  const fakeSpawnSync = () => ({ status: 0, stdout: 'brain-1 already running (PID 5678)\n', stderr: '', error: null });
  const result = startDaemon('brain-1', tmpDir, io, fakeSpawnSync);
  expect(result.ok).toBe(true);
  expect(result.alreadyRunning).toBe(true);
});

test('startDaemon: non-zero exit without "already running" → ok: false', () => {
  const { io } = makeIo();
  const fakeSpawnSync = () => ({ status: 1, stdout: '', stderr: 'launchctl error', error: null });
  const result = startDaemon('brain-1', tmpDir, io, fakeSpawnSync);
  expect(result.ok).toBe(false);
  expect(result.alreadyRunning).toBe(false);
  expect(result.error).toContain('launchctl error');
});

test('startDaemon: spawnSync error field → ok: false with error message', () => {
  const { io } = makeIo();
  const fakeSpawnSync = () => ({ status: null, stdout: null, stderr: null, error: new Error('ENOENT') });
  const result = startDaemon('brain-1', tmpDir, io, fakeSpawnSync);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('ENOENT');
});
