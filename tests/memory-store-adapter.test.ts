import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMemorySnapshotManifest } from '../lib/bundle/installer.js';
import { publishMemoryToStore } from '../lib/memory/store.js';
import { getMemoryStoreAdapter, resolveMemoryStore } from '../lib/memory/store-adapter.js';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeCheckout(agentId, pages) {
  const root = tempDir('ab-store-adapter-');
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({ agent_id: agentId }, null, 2));
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: agentId,
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  for (const [rel, content] of Object.entries(pages)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function buildRemoteSnapshotFixture(agentId, pages, snapshotId = 'remote-1') {
  const root = makeCheckout(agentId, pages);
  const files = Object.keys(pages).sort();
  const manifest = createMemorySnapshotManifest({
    targetRoot: root,
    snapshotId,
    files,
    sourceRepo: 'remote-memory',
    agentId,
  });
  return {
    root,
    manifest,
    pages: new Map(files.map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')])),
  };
}

test('local-only adapter preserves existing no-store semantics', () => {
  const adapter = getMemoryStoreAdapter(resolveMemoryStore(undefined));
  const checkout = makeCheckout('bootup', {});

  expect(adapter.publish({ projectRoot: checkout, snapshotId: 's1' })).toEqual({ mode: 'local-only', published: false });
  expect(adapter.fetchLatest({ projectRoot: checkout })).toEqual({ mode: 'local-only', manifest: null });
  expect(adapter.fetchMerged({ projectRoot: checkout })).toEqual({ mode: 'local-only', pages: null });
  expect(adapter.localMatchesOwnHead({ projectRoot: checkout })).toEqual({ matches: true, reason: 'match' });
  expect(adapter.getPublisherHeadPageSet({ projectRoot: checkout, machineId: 'A' })).toEqual(new Set());
});

test('file adapter contract: publish, fetchLatest, and own-head comparison stay transport-agnostic', () => {
  const storeRoot = tempDir('ab-store-adapter-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const adapter = getMemoryStoreAdapter(store);
  const checkout = makeCheckout('bootup', {
    'memory/MEMORY.md': '# index\n',
    'memory/one.md': 'hello\n',
  });

  const pub = adapter.publish({ projectRoot: checkout, snapshotId: 's1', machineId: 'machine-a' });
  expect(pub.mode).toBe('store');
  expect(pub.published).toBe(true);
  expect(pub.pages).toBe(2);

  const fetched = adapter.fetchLatest({ projectRoot: checkout });
  expect(fetched.mode).toBe('store');
  expect(fetched.manifest?.bundle_type).toBe('memory_snapshot');
  expect(Array.isArray(fetched.manifest?.files)).toBe(true);
  expect(typeof fetched.payloadRoot).toBe('string');

  const ownHead = adapter.localMatchesOwnHead({ projectRoot: checkout });
  expect(ownHead).toEqual({ matches: true, reason: 'match' });
});

test('file adapter contract: merged reads union distinct pages across publisher heads', () => {
  const storeRoot = tempDir('ab-store-adapter-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const adapter = getMemoryStoreAdapter(store);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/a.md': 'from a\n' });
  const b = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/b.md': 'from b\n' });

  publishMemoryToStore({ projectRoot: a, store, snapshotId: 'sa', machineId: 'machine-a' });
  publishMemoryToStore({ projectRoot: b, store, snapshotId: 'sb', machineId: 'machine-b' });

  const merged = adapter.fetchMerged({ projectRoot: a });
  expect(merged.mode).toBe('store');
  expect(merged.pages.get('memory/a.md')?.srcFile).toBeTruthy();
  expect(merged.pages.get('memory/b.md')?.srcFile).toBeTruthy();
  expect(typeof merged.pages.get('memory/a.md')?.marker).toBe('number');
  expect(typeof merged.pages.get('memory/b.md')?.hash).toBe('string');
});

test('unsupported transport still parses but fails loud through the adapter seam', () => {
  const store = resolveMemoryStore('agentdrive://workspace/foo');
  const adapter = getMemoryStoreAdapter(store);
  const checkout = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n' });

  expect(adapter.scheme).toBe('agentdrive');
  expect(() => adapter.publish({ projectRoot: checkout, snapshotId: 's1' })).toThrow(/not yet supported|PR-3a ships the seam/i);
  expect(() => adapter.fetchLatest({ projectRoot: checkout })).toThrow(/not yet supported|PR-3a ships the seam/i);
  expect(() => adapter.fetchMerged({ projectRoot: checkout })).toThrow(/not yet supported|PR-3a ships the seam/i);
  expect(() => adapter.localMatchesOwnHead({ projectRoot: checkout })).toThrow(/not yet supported|PR-3a ships the seam/i);
  expect(() => adapter.getPublisherHeadPageSet({ projectRoot: checkout, machineId: 'A' })).toThrow(/not yet supported|PR-3a ships the seam/i);
});

test('server adapter exposes async remote methods and rejects sync-only usage', async () => {
  const checkout = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n' });
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://override-brain'));

  expect(adapter.scheme).toBe('server');
  expect(() => adapter.publish({ projectRoot: checkout, snapshotId: 's1' })).toThrow(/requires async adapter methods/i);
  await expect(adapter.publishAsync({ projectRoot: checkout, snapshotId: 's1' })).rejects.toThrow(/requires saved credentials/i);

  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      data: {
        files: [{
          path: 'memory-store/heads/pub-123.json',
          content_base64: Buffer.from(JSON.stringify({ bundle_hash: 'sha256:abc' }), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          hash: 'abc',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const readHead = await adapter.readHead({
    projectRoot: checkout,
    publisherId: 'pub-123',
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  });
  expect(readHead).toEqual({ bundle_hash: 'sha256:abc' });

  await adapter.writeLatest({
    projectRoot: checkout,
    latest: { bundle_hash: 'sha256:def' },
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: { pushed: 1, updated: 0, errors: 0, results: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  expect(calls[0].url).toContain('/v1/brain-assets/override-brain?');
  expect(calls[0].url).toContain('path=memory-store%2Fheads%2Fpub-123.json');
  expect(calls[1].url).toBe('https://agentbootup.fly.dev/v1/brain-assets/override-brain/push');
});

test('server adapter falls back to project agent_id when server:// omits one', async () => {
  const checkout = makeCheckout('project-brain', { 'memory/MEMORY.md': '# idx\n' });
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://'));

  const calls = [];
  await adapter.listHeads({
    projectRoot: checkout,
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: { files: [], total: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  expect(calls[0].url).toContain('/v1/brain-assets/project-brain/hashes?');
  expect(calls[0].url).toContain('path_prefix=memory-store%2Fheads%2F');
});

test('server adapter fetchLatestAsync materializes a remote snapshot payload locally', async () => {
  const checkout = makeCheckout('bootup', {});
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));
  const remoteSnapshot = buildRemoteSnapshotFixture('bootup', { 'memory/MEMORY.md': '# remote\n' });

  const fetchFn = async (url) => {
    const responseFor = (data) => new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    if (String(url).includes('path=memory-store%2Flatest.json')) {
      return responseFor({
        files: [{
          path: 'memory-store/latest.json',
          content_base64: Buffer.from(JSON.stringify({ bundle_hash: remoteSnapshot.manifest.bundle_hash }), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`,
          content_base64: Buffer.from(JSON.stringify(remoteSnapshot.manifest), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`,
          content_base64: Buffer.from(remoteSnapshot.pages.get('memory/MEMORY.md'), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 8,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await adapter.fetchLatestAsync({
    projectRoot: checkout,
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  });
  expect(result.mode).toBe('store');
  expect(result.manifest?.bundle_hash).toBe(remoteSnapshot.manifest.bundle_hash);
  expect(fs.readFileSync(path.join(result.payloadRoot, 'memory', 'MEMORY.md'), 'utf8')).toBe('# remote\n');
});

test('server adapter materializes remote payloads with bounded parallel reads', async () => {
  const checkout = makeCheckout('bootup', {});
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));
  const pages = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`memory/page-${i}.md`, `page ${i}\n`]));
  const remoteSnapshot = buildRemoteSnapshotFixture('bootup', pages);
  let activePayloadReads = 0;
  let maxActivePayloadReads = 0;

  const responseFor = (data) => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const jsonFile = (pathName, value) => ({
    path: pathName,
    content_base64: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
    asset_type: 'memory',
    cli: 'shared',
    size: 1,
    synced_at: '2026-07-19T00:00:00.000Z',
  });

  const fetchFn = async (url) => {
    const ref = String(url);
    if (ref.includes('path=memory-store%2Flatest.json')) {
      return responseFor({ files: [jsonFile('memory-store/latest.json', { bundle_hash: remoteSnapshot.manifest.bundle_hash })], total: 1 });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`)}`)) {
      return responseFor({ files: [jsonFile(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`, remoteSnapshot.manifest)], total: 1 });
    }
    const marker = '/payload/';
    const decoded = decodeURIComponent(ref.split('path=')[1] || '');
    const markerAt = decoded.indexOf(marker);
    if (markerAt >= 0) {
      const rel = decoded.slice(markerAt + marker.length);
      activePayloadReads += 1;
      maxActivePayloadReads = Math.max(maxActivePayloadReads, activePayloadReads);
      await Bun.sleep(10);
      activePayloadReads -= 1;
      return responseFor({
        files: [{
          path: decoded,
          content_base64: Buffer.from(remoteSnapshot.pages.get(rel), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: remoteSnapshot.pages.get(rel).length,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const previous = process.env.AGENTBOOTUP_MEMORY_REMOTE_READ_CONCURRENCY;
  process.env.AGENTBOOTUP_MEMORY_REMOTE_READ_CONCURRENCY = '3';
  try {
    const result = await adapter.fetchLatestAsync({
      projectRoot: checkout,
      credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
      fetchFn,
    });

    expect(maxActivePayloadReads).toBe(3);
    expect(fs.readFileSync(path.join(result.payloadRoot, 'memory', 'page-11.md'), 'utf8')).toBe('page 11\n');
  } finally {
    if (previous === undefined) delete process.env.AGENTBOOTUP_MEMORY_REMOTE_READ_CONCURRENCY;
    else process.env.AGENTBOOTUP_MEMORY_REMOTE_READ_CONCURRENCY = previous;
  }
});

test('server adapter fetchMergedAsync unions distinct pages and honors tombstones', async () => {
  const checkout = makeCheckout('bootup', {});
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));
  const tombstoneMs = Date.parse('2026-07-19T00:00:03.000Z');
  const snapshotA = buildRemoteSnapshotFixture('bootup', { 'memory/a.md': 'from a\n' }, 'remote-a');
  const snapshotB = buildRemoteSnapshotFixture('bootup', {
    'memory/b.md': 'from b\n',
    'memory/deleted.md': 'stale\n',
  }, 'remote-b');

  const jsonFile = (pathName, value, syncedAt = '2026-07-19T00:00:00.000Z') => ({
    path: pathName,
    content_base64: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
    asset_type: 'memory',
    cli: 'shared',
    size: 1,
    synced_at: syncedAt,
  });
  const textFile = (pathName, value, syncedAt = '2026-07-19T00:00:00.000Z') => ({
    path: pathName,
    content_base64: Buffer.from(value, 'utf8').toString('base64'),
    asset_type: 'memory',
    cli: 'shared',
    size: value.length,
    synced_at: syncedAt,
  });
  const responseFor = (data) => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const fetchFn = async (url) => {
    const ref = String(url);
    if (ref.includes('/hashes?') && ref.includes('path_prefix=memory-store%2Fheads%2F')) {
      return responseFor({
        files: [
          { path: 'memory-store/heads/pub-a.json', synced_at: '2026-07-19T00:00:01.000Z' },
          { path: 'memory-store/heads/pub-b.json', synced_at: '2026-07-19T00:00:02.000Z' },
        ],
        total: 2,
      });
    }
    if (ref.includes('/hashes?') && ref.includes('path_prefix=memory-store%2Flatest.json')) {
      return responseFor({ files: [], total: 0 });
    }
    if (ref.includes('path=memory-store%2Fheads%2Fpub-a.json')) {
      return responseFor({
        files: [jsonFile('memory-store/heads/pub-a.json', {
          bundle_hash: snapshotA.manifest.bundle_hash,
          markers: { 'memory/a.md': 10 },
          tombstones: { 'memory/deleted.md': tombstoneMs },
        })],
        total: 1,
      });
    }
    if (ref.includes('path=memory-store%2Fheads%2Fpub-b.json')) {
      return responseFor({
        files: [jsonFile('memory-store/heads/pub-b.json', {
          bundle_hash: snapshotB.manifest.bundle_hash,
          markers: { 'memory/b.md': 20, 'memory/deleted.md': 40 },
          tombstones: {},
        })],
        total: 1,
      });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${snapshotA.manifest.bundle_hash}/manifest.json`)}`)) {
      return responseFor({
        files: [jsonFile(`memory-store/snapshots/${snapshotA.manifest.bundle_hash}/manifest.json`, snapshotA.manifest)],
        total: 1,
      });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${snapshotB.manifest.bundle_hash}/manifest.json`)}`)) {
      return responseFor({
        files: [jsonFile(`memory-store/snapshots/${snapshotB.manifest.bundle_hash}/manifest.json`, snapshotB.manifest)],
        total: 1,
      });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${snapshotA.manifest.bundle_hash}/markers.json`)}`)) {
      return responseFor({ files: [jsonFile(`memory-store/snapshots/${snapshotA.manifest.bundle_hash}/markers.json`, { 'memory/a.md': 10 })], total: 1 });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${snapshotB.manifest.bundle_hash}/markers.json`)}`)) {
      return responseFor({ files: [jsonFile(`memory-store/snapshots/${snapshotB.manifest.bundle_hash}/markers.json`, { 'memory/b.md': 20, 'memory/deleted.md': 40 })], total: 1 });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${snapshotA.manifest.bundle_hash}/payload/memory/a.md`)}`)) {
      return responseFor({ files: [textFile(`memory-store/snapshots/${snapshotA.manifest.bundle_hash}/payload/memory/a.md`, snapshotA.pages.get('memory/a.md'))], total: 1 });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${snapshotB.manifest.bundle_hash}/payload/memory/b.md`)}`)) {
      return responseFor({ files: [textFile(`memory-store/snapshots/${snapshotB.manifest.bundle_hash}/payload/memory/b.md`, snapshotB.pages.get('memory/b.md'))], total: 1 });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${snapshotB.manifest.bundle_hash}/payload/memory/deleted.md`)}`)) {
      return responseFor({ files: [textFile(`memory-store/snapshots/${snapshotB.manifest.bundle_hash}/payload/memory/deleted.md`, snapshotB.pages.get('memory/deleted.md'))], total: 1 });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await adapter.fetchMergedAsync({
    projectRoot: checkout,
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  });

  expect(result.mode).toBe('store');
  expect([...result.pages.keys()].sort()).toEqual(['memory/a.md', 'memory/b.md']);
  expect(result.deleted).toEqual(new Map([['memory/deleted.md', tombstoneMs]]));
  expect(fs.readFileSync(result.pages.get('memory/a.md').srcFile, 'utf8')).toBe('from a\n');
  expect(fs.readFileSync(result.pages.get('memory/b.md').srcFile, 'utf8')).toBe('from b\n');
});

test('server adapter replay publishes exactly validated manifest targets including binary bytes', async () => {
  const checkout = makeCheckout('bootup', {
    'memory/MEMORY.md': '# idx\n',
    'memory/approved/audio.m4a': Buffer.from([0, 255, 1, 2]),
    'memory/injected.bin': Buffer.from([9, 8, 7]),
  });
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));

  const pushes = [];
  const pushedByPath = new Map();
  const responseFor = (data) => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const fetchFn = async (url, init = {}) => {
    const ref = String(url);
    if ((init.method || 'GET') === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      pushes.push({ url: ref, body });
      for (const file of body.files || []) pushedByPath.set(file.path, file);
      return responseFor({ pushed: pushes.at(-1).body.files.length, updated: 0, errors: 0, results: [] });
    }
    if (ref.includes('/hashes?') && ref.includes('path_prefix=memory-store%2Fheads%2F')) {
      return responseFor({ files: [], total: 0 });
    }
    if (ref.includes('/hashes?') && ref.includes('path_prefix=memory-store%2Flatest.json')) {
      return responseFor({ files: [], total: 0 });
    }
    if (ref.includes('path=memory-store%2Fsnapshots%2F')) {
      const assetPath = decodeURIComponent(ref.split('path=')[1]);
      const written = pushedByPath.get(assetPath);
      if (!written) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return responseFor({
        files: [{
          path: assetPath,
          content_base64: written.content_base64,
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (ref.includes('path=memory-store%2Fheads%2F')) {
      const headPath = decodeURIComponent(ref.split('path=')[1]);
      const written = pushedByPath.get(headPath);
      if (!written) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return responseFor({
        files: [{
          path: headPath,
          content_base64: written.content_base64,
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (ref.includes('path=memory-store%2Flatest.json')) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await adapter.publishAsync({
    projectRoot: checkout,
    snapshotId: 's1',
    machineId: 'machine-a',
    replayPayload: true,
    replayFiles: ['memory/MEMORY.md', 'memory/approved/audio.m4a'],
    replayMtimes: {
      'memory/MEMORY.md': fs.statSync(path.join(checkout, 'memory/MEMORY.md')).mtimeMs,
      'memory/approved/audio.m4a': fs.statSync(path.join(checkout, 'memory/approved/audio.m4a')).mtimeMs,
    },
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  });

  expect(result.mode).toBe('store');
  expect(result.published).toBe(true);
  expect(result.pages).toBe(2);
  expect(pushes).toHaveLength(4);
  expect(pushes[0].url).toBe('https://agentbootup.fly.dev/v1/brain-assets/bootup/push');
  const payloadPaths = pushes[0].body.files.map((file) => file.path).sort();
  const commitPaths = pushes[1].body.files.map((file) => file.path).sort();
  const manifestPath = commitPaths.find((filePath) => filePath.endsWith('/manifest.json'));
  expect(manifestPath).toBeTruthy();
  const bundleHash = manifestPath.match(/memory-store\/snapshots\/(.+)\/manifest\.json$/)?.[1];
  expect(bundleHash).toBeTruthy();
  expect(payloadPaths).toEqual([
    `memory-store/snapshots/${bundleHash}/payload/memory/MEMORY.md`,
    `memory-store/snapshots/${bundleHash}/payload/memory/approved/audio.m4a`,
  ]);
  expect(commitPaths).toEqual([
    `memory-store/snapshots/${bundleHash}/manifest.json`,
    `memory-store/snapshots/${bundleHash}/markers.json`,
  ]);
  expect(
    Buffer.from(
      pushes[0].body.files.find((file) => file.path.endsWith('/payload/memory/approved/audio.m4a')).content_base64,
      'base64',
    ),
  ).toEqual(Buffer.from([0, 255, 1, 2]));
  expect(payloadPaths.some((filePath) => filePath.includes('injected.bin'))).toBe(false);
  expect(pushes[2].body.files[0].path).toMatch(/^memory-store\/heads\/[0-9a-f]{24}\.json$/);
  expect(pushes[3].body.files[0].path).toBe('memory-store/latest.json');
});

test('server adapter never publishes snapshot commit metadata or heads after a payload chunk fails', async () => {
  const checkout = makeCheckout('bootup', {
    'memory/a.md': 'a'.repeat(80),
    'memory/b.md': 'b'.repeat(80),
  });
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));
  const postedPaths = [];

  const fetchFn = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      const paths = body.files.map((file) => file.path);
      postedPaths.push(...paths);
      return new Response('', { status: paths.some((filePath) => filePath.includes('/payload/')) ? 413 : 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  await expect(adapter.publishAsync({
    projectRoot: checkout,
    snapshotId: 'failed-payload',
    machineId: 'machine-a',
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  })).rejects.toThrow(/HTTP 413/);

  expect(postedPaths.some((filePath) => filePath.endsWith('/manifest.json'))).toBe(false);
  expect(postedPaths.some((filePath) => filePath.endsWith('/markers.json'))).toBe(false);
  expect(postedPaths.some((filePath) => filePath.includes('/heads/'))).toBe(false);
  expect(postedPaths.some((filePath) => filePath.endsWith('/latest.json'))).toBe(false);
});

test('server adapter replay refuses frozen paths excluded by the current policy', async () => {
  const checkout = makeCheckout('bootup', {
    'memory/approved.md': 'approved\n',
    'memory/frozen.md': 'frozen\n',
  });
  fs.writeFileSync(path.join(checkout, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [{ path: 'memory/approved.md', class: 'canonical' }],
  }));
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));

  await expect(adapter.publishAsync({
    projectRoot: checkout,
    sourceRoot: checkout,
    snapshotId: 'replay-policy',
    machineId: 'machine-a',
    replayPayload: true,
    replayFiles: ['memory/frozen.md'],
    replayMtimes: {
      'memory/frozen.md': fs.statSync(path.join(checkout, 'memory/frozen.md')).mtimeMs,
    },
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn: async () => { throw new Error('network must not be reached'); },
  })).rejects.toThrow(/frozen path\(s\) are not selected by the current policy: memory\/frozen\.md/);
});

test('server adapter publishAsync fails if head read-after-write does not reflect the new state', async () => {
  const checkout = makeCheckout('bootup', {
    'memory/MEMORY.md': '# idx\n',
  });
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));

  const pushedByPath = new Map();
  const responseFor = (data) => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const fetchFn = async (url, init = {}) => {
    const ref = String(url);
    if ((init.method || 'GET') === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      for (const file of body.files || []) pushedByPath.set(file.path, file);
      return responseFor({ pushed: (body.files || []).length, updated: 0, errors: 0, results: [] });
    }
    if (ref.includes('/hashes?') && ref.includes('path_prefix=memory-store%2Fheads%2F')) {
      return responseFor({ files: [], total: 0 });
    }
    if (ref.includes('path=memory-store%2Fsnapshots%2F')) {
      const assetPath = decodeURIComponent(ref.split('path=')[1]);
      const written = pushedByPath.get(assetPath);
      if (!written) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return responseFor({
        files: [{
          path: assetPath,
          content_base64: written.content_base64,
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (ref.includes('path=memory-store%2Fheads%2F')) {
      const headPath = decodeURIComponent(ref.split('path=')[1]);
      const written = pushedByPath.get(headPath);
      if (!written) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const corrupted = {
        ...JSON.parse(Buffer.from(written.content_base64, 'base64').toString('utf8')),
        bundle_hash: 'sha256:wrong',
      };
      return responseFor({
        files: [{
          path: headPath,
          content_base64: Buffer.from(JSON.stringify(corrupted), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (ref.includes('path=memory-store%2Flatest.json')) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  await expect(adapter.publishAsync({
    projectRoot: checkout,
    snapshotId: 's1',
    machineId: 'machine-a',
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  })).rejects.toThrow(/did not durably reflect the publisher head/i);
});

test('server adapter publishAsync rejects replay payload that would overwrite differing latest content', async () => {
  const checkout = makeCheckout('bootup', { 'memory/MEMORY.md': '# local\n' });
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));
  const remoteSnapshot = buildRemoteSnapshotFixture('bootup', { 'memory/MEMORY.md': '# remote\n' });

  const responseFor = (data) => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const fetchFn = async (url, init = {}) => {
    const ref = String(url);
    if ((init.method || 'GET') === 'POST') {
      return responseFor({ pushed: 1, updated: 0, errors: 0, results: [] });
    }
    if (ref.includes('/hashes?') && ref.includes('path_prefix=memory-store%2Fheads%2F')) {
      return responseFor({ files: [], total: 0 });
    }
    if (ref.includes('/hashes?') && ref.includes('path_prefix=memory-store%2Flatest.json')) {
      return responseFor({
        files: [{ path: 'memory-store/latest.json', synced_at: '2026-07-19T00:00:00.000Z' }],
        total: 1,
      });
    }
    if (ref.includes('path=memory-store%2Flatest.json')) {
      return responseFor({
        files: [{
          path: 'memory-store/latest.json',
          content_base64: Buffer.from(JSON.stringify({ bundle_hash: remoteSnapshot.manifest.bundle_hash }), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`,
          content_base64: Buffer.from(JSON.stringify(remoteSnapshot.manifest), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/markers.json`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/markers.json`,
          content_base64: Buffer.from(JSON.stringify({ 'memory/MEMORY.md': 1 }), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (ref.includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`,
          content_base64: Buffer.from(remoteSnapshot.pages.get('memory/MEMORY.md'), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 8,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (ref.includes('path=memory-store%2Fheads%2F')) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  let conflict: any;
  try {
    await adapter.publishAsync({
      projectRoot: checkout,
      snapshotId: 's1',
      machineId: 'machine-a',
      sourceRoot: checkout,
      replayPayload: true,
      replayFiles: ['memory/MEMORY.md'],
      replayMtimes: { 'memory/MEMORY.md': Date.now() },
      credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
      fetchFn,
    });
  } catch (error) {
    conflict = error;
  }
  expect(conflict?.message).toMatch(/frozen payload differs from shared page/i);
  expect(conflict?.conflict).toEqual({
    schema: 'memory-conflict/v1',
    conflicts: [{ path: 'memory/MEMORY.md', reason_code: 'shared_page_bytes_differ' }],
    omitted_count: 0,
  });
});

test('server adapter getPublisherHeadPageSetAsync unions markers and tombstones', async () => {
  const checkout = makeCheckout('bootup', {});
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));

  const result = await adapter.getPublisherHeadPageSetAsync({
    projectRoot: checkout,
    publisherId: 'pub-123',
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn: async () => new Response(JSON.stringify({
      data: {
        files: [{
          path: 'memory-store/heads/pub-123.json',
          content_base64: Buffer.from(JSON.stringify({
            markers: { 'memory/MEMORY.md': 1 },
            tombstones: { 'memory/deleted.md': 2 },
          }), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  expect(result).toEqual(new Set(['memory/MEMORY.md', 'memory/deleted.md']));
});

test('server adapter localMatchesOwnHeadAsync compares remote snapshot bytes against local memory', async () => {
  const checkout = makeCheckout('bootup', { 'memory/MEMORY.md': '# remote\n' });
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));
  const remoteSnapshot = buildRemoteSnapshotFixture('bootup', { 'memory/MEMORY.md': '# remote\n' });
  let payloadReads = 0;

  const fetchFn = async (url) => {
    const responseFor = (data) => new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    if (String(url).includes('path=memory-store%2Fheads%2Fpub-123.json')) {
      return responseFor({
        files: [{
          path: 'memory-store/heads/pub-123.json',
          content_base64: Buffer.from(JSON.stringify({ bundle_hash: remoteSnapshot.manifest.bundle_hash }), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`,
          content_base64: Buffer.from(JSON.stringify(remoteSnapshot.manifest), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`)}`)) {
      payloadReads += 1;
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`,
          content_base64: Buffer.from(remoteSnapshot.pages.get('memory/MEMORY.md'), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 8,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  expect(await adapter.localMatchesOwnHeadAsync({
    projectRoot: checkout,
    publisherId: 'pub-123',
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  })).toEqual({ matches: true, reason: 'match' });
  expect(payloadReads).toBe(1);

  fs.writeFileSync(path.join(checkout, 'memory', 'MEMORY.md'), '# local drift\n');
  expect((await adapter.localMatchesOwnHeadAsync({
    projectRoot: checkout,
    publisherId: 'pub-123',
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  })).reason).toBe('content_differs');
  expect(payloadReads).toBe(1);
});

test('server adapter localMatchesOwnHeadAsync resolves the pinned publisher identity when caller omits publisherId', async () => {
  const checkout = makeCheckout('bootup', { 'memory/MEMORY.md': '# remote\n' });
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));
  const pinnedMachineId = 'machine-a';
  publishMemoryToStore({
    projectRoot: checkout,
    store: resolveMemoryStore(`file://${tempDir('ab-unused-file-store-')}`),
    snapshotId: 'ignored',
    machineId: pinnedMachineId,
  });
  fs.rmSync(path.join(checkout, '.brain', 'memory-sync-baseline.json'), { force: true });
  const checkoutReal = fs.realpathSync(path.resolve(checkout));
  const derivedPublisherId = createHash('sha256').update(`${pinnedMachineId}\0${checkoutReal}`).digest('hex').slice(0, 24);
  const remoteSnapshot = buildRemoteSnapshotFixture('bootup', { 'memory/MEMORY.md': '# remote\n' });

  const fetchFn = async (url) => {
    const responseFor = (data) => new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/heads/${derivedPublisherId}.json`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/heads/${derivedPublisherId}.json`,
          content_base64: Buffer.from(JSON.stringify({ bundle_hash: remoteSnapshot.manifest.bundle_hash }), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`,
          content_base64: Buffer.from(JSON.stringify(remoteSnapshot.manifest), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`,
          content_base64: Buffer.from('# remote\n', 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 9,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  expect(await adapter.localMatchesOwnHeadAsync({
    projectRoot: checkout,
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  })).toEqual({ matches: true, reason: 'match' });
});

test('server adapter fetchLatestAsync rejects a hash-mismatched remote snapshot', async () => {
  const checkout = makeCheckout('bootup', {});
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));
  const remoteSnapshot = buildRemoteSnapshotFixture('bootup', { 'memory/MEMORY.md': '# remote\n' });

  const fetchFn = async (url) => {
    const responseFor = (data) => new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    if (String(url).includes('path=memory-store%2Flatest.json')) {
      return responseFor({
        files: [{
          path: 'memory-store/latest.json',
          content_base64: Buffer.from(JSON.stringify({ bundle_hash: remoteSnapshot.manifest.bundle_hash }), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`,
          content_base64: Buffer.from(JSON.stringify(remoteSnapshot.manifest), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`,
          content_base64: Buffer.from('# tampered\n', 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 10,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  await expect(adapter.fetchLatestAsync({
    projectRoot: checkout,
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  })).rejects.toThrow(/bundle integrity/i);
});

test('server adapter clears a corrupt cached snapshot so a later fetch can self-heal', async () => {
  const checkout = makeCheckout('bootup', {});
  const adapter = getMemoryStoreAdapter(resolveMemoryStore('server://bootup'));
  const remoteSnapshot = buildRemoteSnapshotFixture('bootup', { 'memory/MEMORY.md': '# remote\n' });
  let tamper = true;

  const fetchFn = async (url) => {
    const responseFor = (data) => new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    if (String(url).includes('path=memory-store%2Flatest.json')) {
      return responseFor({
        files: [{
          path: 'memory-store/latest.json',
          content_base64: Buffer.from(JSON.stringify({ bundle_hash: remoteSnapshot.manifest.bundle_hash }), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/manifest.json`,
          content_base64: Buffer.from(JSON.stringify(remoteSnapshot.manifest), 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 1,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    if (String(url).includes(`path=${encodeURIComponent(`memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`)}`)) {
      return responseFor({
        files: [{
          path: `memory-store/snapshots/${remoteSnapshot.manifest.bundle_hash}/payload/memory/MEMORY.md`,
          content_base64: Buffer.from(tamper ? '# tampered\n' : '# remote\n', 'utf8').toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
          size: 10,
          synced_at: '2026-07-19T00:00:00.000Z',
        }],
        total: 1,
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  await expect(adapter.fetchLatestAsync({
    projectRoot: checkout,
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  })).rejects.toThrow(/bundle integrity/i);

  tamper = false;
  const fetched = await adapter.fetchLatestAsync({
    projectRoot: checkout,
    credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://agentbootup.fly.dev' }),
    fetchFn,
  });
  expect(fs.readFileSync(path.join(fetched.payloadRoot, 'memory', 'MEMORY.md'), 'utf8')).toBe('# remote\n');
});
