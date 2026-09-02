import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_MEMORY_FETCH_TIMEOUT_MS,
  REMOTE_MEMORY_PREFIX,
  createBoundedMemoryFetch,
  headAssetPath,
  headPathPrefix,
  latestAssetPath,
  listRemoteMemoryAssetHashes,
  pullRemoteMemoryAssets,
  pushRemoteMemoryAssets,
  resolveRemoteMemoryStoreConfig,
  snapshotManifestAssetPath,
  snapshotMarkersAssetPath,
  snapshotPayloadAssetPath,
} from '../lib/memory/remote-store.js';
import { resolveMemoryStore } from '../lib/memory/store.js';

const TEST_BUNDLE_HASH = `sha256:${'a'.repeat(64)}`;
const ORIGINAL_BODY_BUDGET = process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES;

test('bounded remote memory fetch applies the large-snapshot default timeout', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let scheduledMs = 0;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  globalThis.setTimeout = ((_: TimerHandler, ms?: number) => {
    scheduledMs = Number(ms);
    return 1;
  }) as typeof globalThis.setTimeout;
  try {
    await createBoundedMemoryFetch()('https://storage.invalid');
    expect(scheduledMs).toBe(DEFAULT_MEMORY_FETCH_TIMEOUT_MS);
    expect(scheduledMs).toBeGreaterThan(14_000);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('bounded remote memory fetch aborts at an explicit shorter timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
  try {
    await expect(createBoundedMemoryFetch(undefined, 5)('https://storage.invalid'))
      .rejects.toThrow('memory fetch timeout after 5ms');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

afterEach(() => {
  if (ORIGINAL_BODY_BUDGET === undefined) delete process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES;
  else process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = ORIGINAL_BODY_BUDGET;
});

function projectRoot(agentId = 'bootup') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-remote-store-'));
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({ agent_id: agentId }, null, 2));
  return root;
}

test('remote memory layout uses the brain-assets server-blob namespace', () => {
  expect(REMOTE_MEMORY_PREFIX).toBe('memory-store');
  expect(headPathPrefix()).toBe('memory-store/heads/');
  expect(headAssetPath('pub-123')).toBe('memory-store/heads/pub-123.json');
  expect(latestAssetPath()).toBe('memory-store/latest.json');
  expect(snapshotManifestAssetPath(TEST_BUNDLE_HASH)).toBe(`memory-store/snapshots/${TEST_BUNDLE_HASH}/manifest.json`);
  expect(snapshotMarkersAssetPath(TEST_BUNDLE_HASH)).toBe(`memory-store/snapshots/${TEST_BUNDLE_HASH}/markers.json`);
  expect(snapshotPayloadAssetPath(TEST_BUNDLE_HASH, 'memory/MEMORY.md')).toBe(`memory-store/snapshots/${TEST_BUNDLE_HASH}/payload/memory/MEMORY.md`);
});

test('remote snapshot payload paths reject traversal and non-memory targets', () => {
  expect(() => snapshotPayloadAssetPath(TEST_BUNDLE_HASH, '../escape')).toThrow(/remote snapshot payload path|traversal/i);
  expect(() => snapshotPayloadAssetPath(TEST_BUNDLE_HASH, 'brain/config.json')).toThrow(/must stay under memory/i);
  expect(() => snapshotManifestAssetPath('abc123')).toThrow(/bundle_hash/i);
});

test('remote memory config resolves brain id from the explicit server:// store', async () => {
  const root = projectRoot('project-brain');
  const config = await resolveRemoteMemoryStoreConfig({
    projectRoot: root,
    store: resolveMemoryStore('server://override-brain'),
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
  });
  expect(config).toEqual({
    scheme: 'server',
    brainId: 'override-brain',
    serverUrl: 'https://agentbootup.fly.dev',
    apiKey: 'k',
  });
});

test('remote memory config falls back to project agent_id when server:// omits one', async () => {
  const root = projectRoot('project-brain');
  const config = await resolveRemoteMemoryStoreConfig({
    projectRoot: root,
    store: resolveMemoryStore('server://'),
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
  });
  expect(config.brainId).toBe('project-brain');
});

test('remote memory config fails closed on missing credentials or invalid URLs', async () => {
  const root = projectRoot('project-brain');
  await expect(resolveRemoteMemoryStoreConfig({
    projectRoot: root,
    store: resolveMemoryStore('server://'),
    credentialsReader: async () => null,
  })).rejects.toThrow(/requires saved credentials/i);

  await expect(resolveRemoteMemoryStoreConfig({
    projectRoot: root,
    store: resolveMemoryStore('server://'),
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'file:///etc/passwd' }),
  })).rejects.toThrow(/valid http\(s\) server URL/i);
});

test('remote memory config fails closed when no brain id can be determined', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-remote-store-'));
  await expect(resolveRemoteMemoryStoreConfig({
    projectRoot: root,
    store: resolveMemoryStore('server://'),
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
  })).rejects.toThrow(/requires a brain id/i);
});

test('remote brain-assets helpers use authenticated REST endpoints and return the data envelope', async () => {
  const remote = {
    brainId: 'bootup',
    serverUrl: 'https://agentbootup.fly.dev',
    apiKey: 'secret-key',
  };
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { ok: true, url } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const pushed = await pushRemoteMemoryAssets({
    remote,
    files: [{ path: 'memory-store/latest.json', content_base64: 'e30=', asset_type: 'memory', cli: 'shared' }],
    fetchFn,
  });
  const pulled = await pullRemoteMemoryAssets({
    remote,
    pathPrefix: 'memory-store/heads/',
    fetchFn,
  });
  const hashed = await listRemoteMemoryAssetHashes({
    remote,
    pathPrefix: 'memory-store/heads/',
    fetchFn,
  });

  expect(pushed.ok).toBe(true);
  expect(pulled.ok).toBe(true);
  expect(hashed.ok).toBe(true);
  expect(calls).toHaveLength(3);
  expect(calls[0].url).toBe('https://agentbootup.fly.dev/v1/brain-assets/bootup/push');
  expect(calls[0].init.method).toBe('POST');
  expect(calls[0].init.headers.authorization).toBe('Bearer secret-key');
  expect(calls[1].url).toContain('/v1/brain-assets/bootup?');
  expect(calls[1].url).toContain('asset_type=memory');
  expect(calls[1].url).toContain('path_prefix=memory-store%2Fheads%2F');
  expect(calls[2].url).toContain('/v1/brain-assets/bootup/hashes?');
  expect(calls[2].url).toContain('asset_type=memory');
});

test('remote brain-assets helpers surface API error payloads', async () => {
  const remote = {
    brainId: 'bootup',
    serverUrl: 'https://agentbootup.fly.dev',
    apiKey: 'secret-key',
  };
  const fetchFn = async () => new Response(JSON.stringify({
    error: { code: 'not_found', message: 'missing head' },
  }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

  await expect(pullRemoteMemoryAssets({
    remote,
    path: 'memory-store/heads/missing.json',
    fetchFn,
  })).rejects.toThrow(/missing head/);
});

test('remote memory push byte-batches exact request bodies and preserves file order', async () => {
  const remote = { brainId: 'bootup', serverUrl: 'https://agentbootup.fly.dev', apiKey: 'secret-key' };
  const files = ['a', 'b', 'c'].map((name) => ({
    path: `memory-store/payload/${name}.md`,
    content_base64: Buffer.from(name.repeat(80)).toString('base64'),
    asset_type: 'memory',
    cli: 'shared',
  }));
  const singletonBytes = Buffer.byteLength(JSON.stringify({ files: [files[0]] }), 'utf8');
  process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = String(singletonBytes + 8);
  const calls: Array<{ bytes: number; paths: string[] }> = [];

  await pushRemoteMemoryAssets({
    remote,
    files,
    fetchFn: async (_url, init) => {
      const body = String(init.body);
      const payload = JSON.parse(body);
      calls.push({ bytes: Buffer.byteLength(body, 'utf8'), paths: payload.files.map((file) => file.path) });
      return new Response(JSON.stringify({ data: { results: payload.files.map((file) => ({ path: file.path, status: 'pushed' })) } }), { status: 200 });
    },
  });

  expect(calls.map((call) => call.paths[0])).toEqual(files.map((file) => file.path));
  expect(calls.every((call) => call.bytes <= singletonBytes + 8)).toBe(true);
});

test('remote memory push retries multi-file 413 but exposes a single-file 413 with path and encoded size', async () => {
  const remote = { brainId: 'bootup', serverUrl: 'https://agentbootup.fly.dev', apiKey: 'secret-key' };
  const files = ['a', 'b'].map((name) => ({ path: `memory-store/${name}.md`, content_base64: 'eA==', asset_type: 'memory', cli: 'shared' }));
  const calls: string[][] = [];
  await pushRemoteMemoryAssets({
    remote,
    files,
    fetchFn: async (_url, init) => {
      const payload = JSON.parse(String(init.body));
      calls.push(payload.files.map((file) => file.path));
      return new Response(JSON.stringify({ data: { results: payload.files.map((file) => ({ path: file.path, status: 'pushed' })) } }), {
        status: payload.files.length > 1 ? 413 : 200,
      });
    },
  });
  expect(calls).toEqual([[files[0].path, files[1].path], [files[0].path], [files[1].path]]);

  await expect(pushRemoteMemoryAssets({
    remote,
    files: [files[0]],
    fetchFn: async () => new Response('', { status: 413 }),
  })).rejects.toThrow(new RegExp(`${files[0].path}.*encoded_request_bytes=.*HTTP 413`));
});

test('remote memory push treats a 200 per-file rejection as a retryable failure', async () => {
  const remote = { brainId: 'bootup', serverUrl: 'https://agentbootup.fly.dev', apiKey: 'secret-key' };
  const file = { path: 'memory-store/rejected.md', content_base64: 'eA==', asset_type: 'memory', cli: 'shared' };
  await expect(pushRemoteMemoryAssets({
    remote,
    files: [file],
    fetchFn: async () => new Response(JSON.stringify({
      data: { errors: 1, results: [{ path: file.path, status: 'error', error: 'fixture rejection' }] },
    }), { status: 200 }),
  })).rejects.toThrow(/rejected\.md.*fixture rejection/);
});
