// PRD-0051 PR-1: CLI-layer coverage for the new `memory publish` / `memory refresh
// --from-store` subcommands (Claude review PR #299 gap #2). Authored as .ts so the blocking
// `tests/*.test.ts` CI job actually gates them.
import { afterEach, expect, test } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeCredentials } from '../lib/auth/credentials.js';
import { runMemoryCommand } from '../lib/memory/cli.js';
import { enqueueReplayItem, readReplayQueue } from '../lib/memory/replay-queue.js';
import { resolveMemoryStore } from '../lib/memory/store.js';

const tempRoots: string[] = [];
const liveServers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
const REAL_FETCH = globalThis.fetch;
const ORIGINAL_CREDS_FILE = process.env.AGENTBOOTUP_CREDS_FILE;
const ORIGINAL_MACHINE_ID_FILE = process.env.AGENTBOOTUP_MACHINE_ID_FILE;

afterEach(() => {
  delete process.env.AGENTBOOTUP_MEMORY_STORE;
  delete process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES;
  delete process.env.AGENTBOOTUP_MEMORY_CONFLICT_RECORD_LIMIT;
  if (ORIGINAL_CREDS_FILE === undefined) delete process.env.AGENTBOOTUP_CREDS_FILE;
  else process.env.AGENTBOOTUP_CREDS_FILE = ORIGINAL_CREDS_FILE;
  if (ORIGINAL_MACHINE_ID_FILE === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  else process.env.AGENTBOOTUP_MACHINE_ID_FILE = ORIGINAL_MACHINE_ID_FILE;
  globalThis.fetch = REAL_FETCH;
  for (const server of liveServers.splice(0)) server.stop(true);
  for (const r of tempRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(d);
  return d;
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  const conflicts: unknown[] = [];
  const failures: unknown[] = [];
  return {
    io: {
      stdout: (l: string) => out.push(l),
      stderr: (l: string) => err.push(l),
      conflict: (record: unknown) => conflicts.push(record),
      failure: (hint: unknown) => failures.push(hint),
    },
    out,
    err,
    conflicts,
    failures,
  };
}

function checkout(agentId: string, pages: Record<string, string>) {
  const root = tempDir('ab-cli-');
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({ agent_id: agentId }));
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

async function setupServerCreds() {
  const credsDir = tempDir('ab-cli-creds-');
  process.env.AGENTBOOTUP_CREDS_FILE = path.join(credsDir, 'credentials');
  await writeCredentials({ apiKey: 'test-key', serverUrl: 'https://agentbootup.fly.dev' });
}

function sha256Hex(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function installMockBrainAssetsFetch() {
  const docs = new Map<string, { content_base64: string; asset_type: string; cli: string; hash: string; size: number; synced_at: string }>();
  let tick = 0;
  let nextPushErrorCode: string | null = null;
  let nextPushFailure: Error | null = null;
  let rejectedPushPath: string | null = null;

  const putDoc = (brainId: string, pathName: string, contentBase64: string, assetType = 'memory', cli = 'shared') => {
    const content = Buffer.from(contentBase64, 'base64');
    docs.set(`${brainId}:${pathName}`, {
      content_base64: contentBase64,
      asset_type: assetType,
      cli,
      hash: sha256Hex(content.toString('binary')),
      size: content.length,
      synced_at: new Date(Date.UTC(2026, 6, 19, 0, 0, tick++)).toISOString(),
    });
  };

  const listDocs = (brainId: string, pathName?: string | null, pathPrefix?: string | null) => {
    const prefix = `${brainId}:`;
    const out: Array<Record<string, unknown>> = [];
    for (const [key, value] of docs.entries()) {
      if (!key.startsWith(prefix)) continue;
      const rel = key.slice(prefix.length);
      if (pathName && rel !== pathName) continue;
      if (pathPrefix && !rel.startsWith(pathPrefix)) continue;
      out.push({ path: rel, ...value });
    }
    out.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    return out;
  };

  globalThis.fetch = (async (url, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const match = parsed.pathname.match(/^\/v1\/brain-assets\/([^/]+?)(?:\/(push|hashes))?$/);
    if (!match) throw new Error(`unexpected fetch url ${url}`);
    const brainId = decodeURIComponent(match[1]);
    const action = match[2] || 'pull';

    if (action === 'push') {
      if (nextPushFailure) {
        const error = nextPushFailure;
        nextPushFailure = null;
        throw error;
      }
      if (nextPushErrorCode) {
        const error: NodeJS.ErrnoException = new Error(`mock remote failure: ${nextPushErrorCode}`);
        error.code = nextPushErrorCode;
        nextPushErrorCode = null;
        throw error;
      }
      const body = JSON.parse(String(init.body || '{}'));
      if (rejectedPushPath && (body.files || []).some((file) => String(file.path).includes(rejectedPushPath))) {
        return new Response(JSON.stringify({ error: { code: 'payload_too_large', message: 'fixture rejection' } }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        });
      }
      for (const file of body.files || []) {
        putDoc(brainId, file.path, file.content_base64, file.asset_type, file.cli);
      }
      return new Response(JSON.stringify({ data: { pushed: (body.files || []).length, updated: 0, errors: 0, results: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const pathName = parsed.searchParams.get('path');
    const pathPrefix = parsed.searchParams.get('path_prefix');
    const files = listDocs(brainId, pathName, pathPrefix);

    if (action === 'hashes') {
      return new Response(JSON.stringify({
        data: {
          files: files.map((file) => ({
            path: file.path,
            hash: file.hash,
            size: file.size,
            asset_type: file.asset_type,
            cli: file.cli,
            synced_at: file.synced_at,
          })),
          total: files.length,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (pathName && files.length === 0) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ data: { files, total: files.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  return {
    putDoc(brainId: string, pathName: string, value: unknown) {
      putDoc(brainId, pathName, Buffer.from(JSON.stringify(value), 'utf8').toString('base64'));
    },
    setNextPushError(code: string) {
      nextPushErrorCode = code;
    },
    setNextPushFailure(error: Error) {
      nextPushFailure = error;
    },
    setRejectedPushPath(pathFragment: string) {
      rejectedPushPath = pathFragment;
    },
    listPaths(brainId: string) {
      return listDocs(brainId).map((file) => String(file.path));
    },
  };
}

function startLiveBrainAssetsServer() {
  const docs = new Map<string, { content_base64: string; asset_type: string; cli: string; hash: string; size: number; synced_at: string }>();
  let tick = 0;

  const putDoc = (brainId: string, pathName: string, contentBase64: string, assetType = 'memory', cli = 'shared') => {
    const content = Buffer.from(contentBase64, 'base64');
    docs.set(`${brainId}:${pathName}`, {
      content_base64: contentBase64,
      asset_type: assetType,
      cli,
      hash: sha256Hex(content.toString('binary')),
      size: content.length,
      synced_at: new Date(Date.UTC(2026, 6, 19, 0, 0, tick++)).toISOString(),
    });
  };

  const listDocs = (brainId: string, pathName?: string | null, pathPrefix?: string | null) => {
    const prefix = `${brainId}:`;
    const out: Array<Record<string, unknown>> = [];
    for (const [key, value] of docs.entries()) {
      if (!key.startsWith(prefix)) continue;
      const rel = key.slice(prefix.length);
      if (pathName && rel !== pathName) continue;
      if (pathPrefix && !rel.startsWith(pathPrefix)) continue;
      out.push({ path: rel, ...value });
    }
    out.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    return out;
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const parsed = new URL(req.url);
      const match = parsed.pathname.match(/^\/v1\/brain-assets\/([^/]+?)(?:\/(push|hashes))?$/);
      if (!match) return new Response('not found', { status: 404 });
      const brainId = decodeURIComponent(match[1]);
      const action = match[2] || 'pull';

      if (action === 'push') {
        const body = await req.json();
        for (const file of body.files || []) {
          putDoc(brainId, file.path, file.content_base64, file.asset_type, file.cli);
        }
        return Response.json({ data: { pushed: (body.files || []).length, updated: 0, errors: 0, results: [] } });
      }

      const pathName = parsed.searchParams.get('path');
      const pathPrefix = parsed.searchParams.get('path_prefix');
      const files = listDocs(brainId, pathName, pathPrefix);

      if (action === 'hashes') {
        return Response.json({
          data: {
            files: files.map((file) => ({
              path: file.path,
              hash: file.hash,
              size: file.size,
              asset_type: file.asset_type,
              cli: file.cli,
              synced_at: file.synced_at,
            })),
            total: files.length,
          },
        });
      }

      if (pathName && files.length === 0) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }

      return Response.json({ data: { files, total: files.length } });
    },
  });
  liveServers.push(server);
  return {
    serverUrl: server.url.origin,
    listPaths(brainId: string) {
      return listDocs(brainId).map((file) => String(file.path));
    },
  };
}

test('publish then refresh --from-store round-trips across checkouts via the CLI', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'idx\n', 'memory/fb.md': 'A only\n' });
  const b = checkout('bootup', {});

  const pub = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], pub.io)).toBe(0);
  expect(pub.out.join('\n')).toMatch(/Published memory to shared store/);

  const ref = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', `file://${storeRoot}`], ref.io)).toBe(0);
  expect(fs.readFileSync(path.join(b, 'memory/fb.md'), 'utf8')).toBe('A only\n');
  expect(ref.out.join('\n')).toMatch(/restored:\s+2/);
});

test('server:// publish then refresh --from-store round-trips across checkouts via the CLI', async () => {
  await setupServerCreds();
  const remote = installMockBrainAssetsFetch();
  const a = checkout('bootup', { 'memory/MEMORY.md': 'idx\n', 'memory/fb.md': 'A only\n' });
  const b = checkout('bootup', {});

  const pub = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'server://bootup', '--snapshot-id', 's1'], pub.io)).toBe(0);
  expect(pub.out.join('\n')).toMatch(/Published memory to shared store/);
  expect(remote.listPaths('bootup')).toContain('memory-store/latest.json');
  expect(remote.listPaths('bootup').some((value) => value.startsWith('memory-store/heads/'))).toBe(true);

  const ref = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', 'server://bootup'], ref.io)).toBe(0);
  expect(fs.readFileSync(path.join(b, 'memory/fb.md'), 'utf8')).toBe('A only\n');
  expect(ref.out.join('\n')).toMatch(/restored:\s+2/);
});

test('server:// replay publishes the frozen payload after a transient remote failure', async () => {
  await setupServerCreds();
  const remote = installMockBrainAssetsFetch();
  const a = checkout('bootup', { 'memory/MEMORY.md': 'frozen queue bytes\n' });

  remote.setNextPushError('ETIMEDOUT');
  const first = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'server://bootup', '--snapshot-id', 's1'], first.io)).toBe(4);
  expect(first.err.join('\n')).toContain('memory publish deferred: ETIMEDOUT');
  expect(first.err.join('\n')).toContain('retry: agentbootup memory replay --cwd');
  expect(first.err.join('\n')).toContain('--store server://bootup');
  expect(readReplayQueue(a).items).toHaveLength(1);

  fs.writeFileSync(path.join(a, 'memory', 'MEMORY.md'), 'new local bytes\n');

  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', a, '--store', 'server://bootup', '--json'], replay.io)).toBe(0);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 0, replayed: 1 });
  expect(readReplayQueue(a).items).toHaveLength(0);

  const b = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', 'server://bootup'], captureIo().io)).toBe(0);
  expect(fs.readFileSync(path.join(b, 'memory', 'MEMORY.md'), 'utf8')).toBe('frozen queue bytes\n');
});

test('server:// replay retains its queue head and publishes no commit metadata when a later payload chunk gets 413', async () => {
  await setupServerCreds();
  process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = '650';
  const remote = installMockBrainAssetsFetch();
  const a = checkout('bootup', {
    'memory/a.md': 'a'.repeat(100),
    'memory/b.md': 'b'.repeat(100),
  });

  remote.setNextPushError('ETIMEDOUT');
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'server://bootup', '--snapshot-id', 's1'], captureIo().io)).toBe(4);
  expect(readReplayQueue(a).items).toHaveLength(1);

  remote.setRejectedPushPath('/payload/memory/b.md');
  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', a, '--store', 'server://bootup', '--json'], replay.io)).not.toBe(0);
  expect(readReplayQueue(a).items).toHaveLength(1);
  const paths = remote.listPaths('bootup');
  expect(paths.some((filePath) => filePath.endsWith('/payload/memory/a.md'))).toBe(true);
  expect(paths.some((filePath) => filePath.endsWith('/manifest.json'))).toBe(false);
  expect(paths.some((filePath) => filePath.endsWith('/markers.json'))).toBe(false);
  expect(paths.some((filePath) => filePath.startsWith('memory-store/heads/'))).toBe(false);
  expect(paths).not.toContain('memory-store/latest.json');
});

test('server:// publish defers on fetch-style remote outages, then replay preserves the frozen payload', async () => {
  await setupServerCreds();
  installMockBrainAssetsFetch().setNextPushFailure(new TypeError('fetch failed'));
  const a = checkout('bootup', { 'memory/MEMORY.md': 'frozen queue bytes\n' });

  const first = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'server://bootup', '--snapshot-id', 's1'], first.io)).toBe(4);
  expect(first.err.join('\n')).toContain('memory publish deferred');
  expect(first.err.join('\n')).toContain('retry: agentbootup memory replay --cwd');
  expect(readReplayQueue(a).items).toHaveLength(1);

  fs.writeFileSync(path.join(a, 'memory', 'MEMORY.md'), 'new local bytes\n');

  const replayRemote = installMockBrainAssetsFetch();
  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', a, '--store', 'server://bootup', '--json'], replay.io)).toBe(0);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 0, replayed: 1 });
  expect(readReplayQueue(a).items).toHaveLength(0);

  const b = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', 'server://bootup'], captureIo().io)).toBe(0);
  expect(fs.readFileSync(path.join(b, 'memory', 'MEMORY.md'), 'utf8')).toBe('frozen queue bytes\n');
  expect(replayRemote.listPaths('bootup')).toContain('memory-store/latest.json');
});

test('server:// live two-checkout acceptance over HTTP covers publish, tombstone propagation, and distinct-page convergence', async () => {
  const live = startLiveBrainAssetsServer();
  const credsDir = tempDir('ab-cli-live-creds-');
  process.env.AGENTBOOTUP_CREDS_FILE = path.join(credsDir, 'credentials');
  const bindCredsForCurrentMachine = async () => {
    await writeCredentials({ apiKey: 'test-key', serverUrl: live.serverUrl });
  };

  const a = checkout('bootup', {
    'memory/MEMORY.md': 'idx\n',
    'memory/shared.md': 'shared from A\n',
    'memory/only-a.md': 'A only\n',
  });
  const b = checkout('bootup', {});
  const machineA = path.join(tempDir('ab-live-machine-a-'), 'machine-id');
  const machineB = path.join(tempDir('ab-live-machine-b-'), 'machine-id');

  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineA;
  await bindCredsForCurrentMachine();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'server://bootup', '--snapshot-id', 'a1'], captureIo().io)).toBe(0);

  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineB;
  await bindCredsForCurrentMachine();
  const refB1 = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', 'server://bootup'], refB1.io)).toBe(0);
  expect(fs.readFileSync(path.join(b, 'memory', 'shared.md'), 'utf8')).toBe('shared from A\n');
  expect(fs.readFileSync(path.join(b, 'memory', 'only-a.md'), 'utf8')).toBe('A only\n');

  fs.rmSync(path.join(b, 'memory', 'shared.md'));
  fs.writeFileSync(path.join(b, 'memory', 'only-b.md'), 'B only\n');
  expect(await runMemoryCommand(['publish', '--cwd', b, '--store', 'server://bootup', '--snapshot-id', 'b1'], captureIo().io)).toBe(0);

  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineA;
  await bindCredsForCurrentMachine();
  const refA2 = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', a, '--from-store', '--store', 'server://bootup'], refA2.io)).toBe(0);
  expect(fs.existsSync(path.join(a, 'memory', 'shared.md'))).toBe(false);
  expect(fs.readFileSync(path.join(a, 'memory', 'only-a.md'), 'utf8')).toBe('A only\n');
  expect(fs.readFileSync(path.join(a, 'memory', 'only-b.md'), 'utf8')).toBe('B only\n');
  expect(live.listPaths('bootup').some((value) => value.startsWith('memory-store/heads/'))).toBe(true);
});

test('server:// publish fast-forwards a local-only same-checkout edit after the initial publish', async () => {
  await setupServerCreds();
  installMockBrainAssetsFetch();
  const a = checkout('bootup', { 'memory/MEMORY.md': 'v1\n' });

  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'server://bootup', '--snapshot-id', 's1'], captureIo().io)).toBe(0);

  fs.writeFileSync(path.join(a, 'memory', 'MEMORY.md'), 'v2\n');
  const republish = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'server://bootup', '--snapshot-id', 's2'], republish.io)).toBe(0);
  expect(republish.out.join('\n')).toContain('fast-forward publish: 1 locally-edited page(s)');
});

test('retire-head marks an existing publisher head retired and a later publish un-retires it loudly', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'v1\n' });

  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io)).toBe(0);

  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const [headFileName] = fs.readdirSync(headsDir).filter((name) => name.endsWith('.json'));
  expect(headFileName).toBeTruthy();
  const publisherId = headFileName.replace(/\.json$/, '');

  const retired = captureIo();
  expect(await runMemoryCommand(['retire-head', publisherId, '--cwd', a, '--store', `file://${storeRoot}`], retired.io)).toBe(0);
  expect(retired.out.join('\n')).toContain(`Retired publisher head: ${publisherId}`);
  const retiredHead = JSON.parse(fs.readFileSync(path.join(headsDir, headFileName), 'utf8'));
  expect(retiredHead.retired).toBe(true);
  expect(retiredHead.retirement.retired_at).toBeTruthy();

  fs.writeFileSync(path.join(a, 'memory', 'MEMORY.md'), 'v2\n');
  const republish = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], republish.io)).toBe(0);
  expect(republish.err.join('\n')).toContain('this publisher head had been retired and is now live again');
  const activeHead = JSON.parse(fs.readFileSync(path.join(headsDir, headFileName), 'utf8'));
  expect(activeHead.retired).toBeUndefined();
  expect(activeHead.retirement).toBeUndefined();
});

test('server:// retire-head marks an existing publisher head retired and a later publish un-retires it loudly', async () => {
  await setupServerCreds();
  const remote = installMockBrainAssetsFetch();
  const a = checkout('bootup', { 'memory/MEMORY.md': 'v1\n' });

  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'server://bootup', '--snapshot-id', 's1'], captureIo().io)).toBe(0);

  const headPath = remote.listPaths('bootup').find((value) => value.startsWith('memory-store/heads/'));
  expect(headPath).toBeTruthy();
  const publisherId = path.basename(String(headPath), '.json');

  const retired = captureIo();
  expect(await runMemoryCommand(['retire-head', publisherId, '--cwd', a, '--store', 'server://bootup'], retired.io)).toBe(0);
  expect(retired.out.join('\n')).toContain(`Retired publisher head: ${publisherId}`);

  fs.writeFileSync(path.join(a, 'memory', 'MEMORY.md'), 'v2\n');
  const republish = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'server://bootup', '--snapshot-id', 's2'], republish.io)).toBe(0);
  expect(republish.err.join('\n')).toContain('this publisher head had been retired and is now live again');
});

test('publish reconciles distinct remote pages before advancing the shared snapshot', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', {
    'memory/MEMORY.md': 'idx\n',
    'memory/from_A.md': 'A only\n',
  });
  const b = checkout('bootup', {
    'memory/MEMORY.md': 'idx\n',
    'memory/from_B.md': 'B only\n',
  });

  const pubA = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], pubA.io)).toBe(0);

  const pubB = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', b, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], pubB.io)).toBe(0);
  expect(pubB.out.join('\n')).toContain('Reconciled memory from shared store');
  expect(pubB.out.join('\n')).toContain('restored:        1');
  expect(fs.readFileSync(path.join(b, 'memory', 'from_A.md'), 'utf8')).toBe('A only\n');

  const refA = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', a, '--from-store', '--store', `file://${storeRoot}`], refA.io)).toBe(0);
  expect(fs.readFileSync(path.join(a, 'memory', 'from_B.md'), 'utf8')).toBe('B only\n');
  expect(refA.out.join('\n')).toMatch(/restored:\s+1/);
});

test('publish reports reconciled pages and refuses same-page drift without advancing the shared snapshot', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', {
    'memory/MEMORY.md': 'remote version\n',
    'memory/remote-only.md': 'remote only\n',
  });
  const b = checkout('bootup', { 'memory/MEMORY.md': 'local version\n' });

  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io)).toBe(0);

  const pubB = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', b, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], pubB.io)).toBe(3);
  expect(pubB.err.join('\n')).toContain('memory publish conflict');
  expect(pubB.err.join('\n')).toContain('memory conflict details: memory/MEMORY.md (baseline_reference_missing)');
  expect(pubB.err.filter((line) => line.startsWith('memory conflict details:'))).toHaveLength(1);
  expect(pubB.err.join('\n')).toContain('1 non-conflicting page(s) were written to memory/; review memory/ before retrying');
  expect(pubB.conflicts).toEqual([{
    schema: 'memory-conflict/v1',
    conflicts: [{ path: 'memory/MEMORY.md', reason_code: 'baseline_reference_missing' }],
    omitted_count: 0,
  }]);
  expect(fs.readFileSync(path.join(b, 'memory', 'MEMORY.md'), 'utf8')).toBe('local version\n');
  expect(fs.readFileSync(path.join(b, 'memory', 'remote-only.md'), 'utf8')).toBe('remote only\n');

  const c = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', c, '--from-store', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  expect(fs.readFileSync(path.join(c, 'memory', 'MEMORY.md'), 'utf8')).toBe('remote version\n');
});

test('publish reports every drifted page in a deterministic bounded conflict record', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/a.md': 'base a\n', 'memory/b.md': 'base b\n' });
  const b = checkout('bootup', { 'memory/a.md': 'base a\n', 'memory/b.md': 'base b\n' });
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'base'], captureIo().io)).toBe(0);
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);

  fs.writeFileSync(path.join(a, 'memory/a.md'), 'remote a\n');
  fs.writeFileSync(path.join(a, 'memory/b.md'), 'remote b\n');
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'remote'], captureIo().io)).toBe(0);
  fs.writeFileSync(path.join(b, 'memory/a.md'), 'local a\n');
  fs.writeFileSync(path.join(b, 'memory/b.md'), 'local b\n');

  process.env.AGENTBOOTUP_MEMORY_CONFLICT_RECORD_LIMIT = '1';
  const publish = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', b, '--store', `file://${storeRoot}`, '--snapshot-id', 'local'], publish.io)).toBe(3);
  expect(publish.conflicts).toEqual([{
    schema: 'memory-conflict/v1',
    conflicts: [
      { path: 'memory/a.md', reason_code: 'store_changed_since_baseline' },
    ],
    omitted_count: 1,
  }]);
  expect(publish.failures).toEqual([{
    category: 'conflict',
    conflict: publish.conflicts[0],
  }]);
  expect(publish.err).toContain('memory conflict details: memory/a.md (store_changed_since_baseline), +1 more');
});

test('publish without a configured store exits 1', async () => {
  const a = checkout('bootup', { 'memory/MEMORY.md': 'x\n' });
  const r = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a], r.io)).toBe(1);
  expect(r.failures).toEqual([{ category: 'local_precondition' }]);
  expect(r.err.join('\n')).toMatch(/no shared store configured/);
});

test('publish against an unreachable store exits 1 without faking success', async () => {
  const a = checkout('bootup', { 'memory/MEMORY.md': 'x\n' });
  const r = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'file:///no/such/store/xyz'], r.io)).toBe(1);
  expect(r.failures).toEqual([{ category: 'unreachable' }]);
  expect(r.err.join('\n')).toMatch(/shared store unreachable/);
});

test('publish queues a post-validation EIO with a distinct deferred exit', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'queue me\n' });
  const originalRealpath = fs.realpathSync;
  (fs as any).realpathSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === storeRoot) {
      const error: NodeJS.ErrnoException = new Error('network filesystem I/O failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRealpath(target);
  }) as typeof fs.realpathSync;
  try {
    const r = captureIo();
    expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], r.io)).toBe(4);
    expect(r.err.join('\n')).toContain('memory publish deferred: EIO');
    expect(readReplayQueue(a).items).toHaveLength(1);
  } finally {
    (fs as any).realpathSync = originalRealpath;
  }
});

for (const transientCode of ['ESTALE', 'ETIMEDOUT']) {
  test(`publish queues a post-validation ${transientCode} with deferred status`, async () => {
    const storeRoot = tempDir('ab-store-');
    const a = checkout('bootup', { 'memory/MEMORY.md': 'queue me\n' });
    const originalRealpath = fs.realpathSync;
    (fs as any).realpathSync = ((target: fs.PathLike) => {
      if (path.resolve(String(target)) === storeRoot) {
        const error: NodeJS.ErrnoException = new Error('network filesystem transient failure');
        error.code = transientCode;
        throw error;
      }
      return originalRealpath(target);
    }) as typeof fs.realpathSync;
    try {
      expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', transientCode], captureIo().io)).toBe(4);
      expect(readReplayQueue(a).items).toHaveLength(1);
    } finally {
      (fs as any).realpathSync = originalRealpath;
    }
  });
}

test('publish does not queue a permission or unsupported-store failure', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'do not queue\n' });
  const originalRealpath = fs.realpathSync;
  (fs as any).realpathSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === storeRoot) {
      const error: NodeJS.ErrnoException = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return originalRealpath(target);
  }) as typeof fs.realpathSync;
  try {
    expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'no-permission'], captureIo().io)).toBe(1);
    expect(fs.existsSync(path.join(a, '.brain', 'memory-replay-queue.json'))).toBe(false);
  } finally {
    (fs as any).realpathSync = originalRealpath;
  }
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', 'agentdrive://unsupported'], captureIo().io)).toBe(1);
  expect(fs.existsSync(path.join(a, '.brain', 'memory-replay-queue.json'))).toBe(false);
});

test('replay publishes the frozen payload after restart, not later local memory bytes', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'frozen queue bytes\n' });
  const originalRealpath = fs.realpathSync;
  (fs as any).realpathSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === storeRoot) {
      const error: NodeJS.ErrnoException = new Error('network filesystem I/O failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRealpath(target);
  }) as typeof fs.realpathSync;
  try {
    expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'frozen'], captureIo().io)).toBe(4);
  } finally {
    (fs as any).realpathSync = originalRealpath;
  }
  const queued = readReplayQueue(a).items[0];
  const payloadDir = path.join(a, '.brain', 'memory-replay', queued.bundle_hash.replace('sha256:', ''));
  fs.writeFileSync(path.join(a, 'memory', 'MEMORY.md'), 'new local bytes\n');

  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(0);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 0, replayed: 1 });
  expect(readReplayQueue(a).items).toHaveLength(0);
  expect(fs.existsSync(payloadDir)).toBe(false);

  const b = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  expect(fs.readFileSync(path.join(b, 'memory', 'MEMORY.md'), 'utf8')).toBe('frozen queue bytes\n');
});

test('replay drains snapshots in FIFO order from their immutable payloads', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'first\n' });
  const store = resolveMemoryStore(`file://${storeRoot}`);
  enqueueReplayItem({ projectRoot: a, store, snapshotId: 'first' });
  fs.writeFileSync(path.join(a, 'memory', 'MEMORY.md'), 'second\n');
  enqueueReplayItem({ projectRoot: a, store, snapshotId: 'second' });

  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(0);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 0, replayed: 2 });
  expect(readReplayQueue(a).items).toHaveLength(0);

  const b = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--latest', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  expect(fs.readFileSync(path.join(b, 'memory', 'MEMORY.md'), 'utf8')).toBe('second\n');
});

test('replay retains a frozen same-page conflict as the FIFO head', async () => {
  const storeRoot = tempDir('ab-store-');
  const remote = checkout('bootup', { 'memory/MEMORY.md': 'remote\n' });
  const queued = checkout('bootup', { 'memory/MEMORY.md': 'frozen local\n' });
  expect(await runMemoryCommand(['publish', '--cwd', remote, '--store', `file://${storeRoot}`, '--snapshot-id', 'remote'], captureIo().io)).toBe(0);
  const queuedItem = enqueueReplayItem({ projectRoot: queued, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'frozen' });

  const humanReplay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', queued, '--store', `file://${storeRoot}`], humanReplay.io)).toBe(3);
  expect(humanReplay.err.join('\n')).toContain('memory conflict details: memory/MEMORY.md (shared_page_bytes_differ)');
  expect(humanReplay.err.filter((line) => line.startsWith('memory conflict details:'))).toHaveLength(1);
  expect(humanReplay.conflicts).toEqual([{
    schema: 'memory-conflict/v1',
    conflicts: [{ path: 'memory/MEMORY.md', reason_code: 'shared_page_bytes_differ' }],
    omitted_count: 0,
  }]);

  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', queued, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(3);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 1, blocked_conflict: 1 });
  expect(JSON.parse(replay.out[0])).toMatchObject({
    conflict: { conflicts: [{ path: 'memory/MEMORY.md', reason_code: 'shared_page_bytes_differ' }] },
  });
  expect(replay.err).toEqual([]);
  expect(readReplayQueue(queued).items[0]).toMatchObject({ id: queuedItem.item.id, last_outcome: { type: 'blocked_conflict' } });
});

test('replay retains a queued page that would resurrect a newer fleet tombstone', async () => {
  const storeRoot = tempDir('ab-store-');
  const remote = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/deleted.md': 'remove me\n' });
  const queued = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/deleted.md': 'remove me\n' });
  expect(await runMemoryCommand(['publish', '--cwd', remote, '--store', `file://${storeRoot}`, '--snapshot-id', 'before-delete'], captureIo().io)).toBe(0);
  const queuedItem = enqueueReplayItem({ projectRoot: queued, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'queued-before-delete' });
  fs.rmSync(path.join(remote, 'memory', 'deleted.md'));
  expect(await runMemoryCommand(['publish', '--cwd', remote, '--store', `file://${storeRoot}`, '--snapshot-id', 'delete'], captureIo().io)).toBe(0);

  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', queued, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(3);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 1, blocked_conflict: 1 });
  expect(JSON.parse(replay.out[0])).toMatchObject({
    conflict: { conflicts: [{ path: 'memory/deleted.md', reason_code: 'tombstone_resurrection' }] },
  });
  expect(replay.err).toEqual([]);
  expect(replay.conflicts).toEqual([{
    schema: 'memory-conflict/v1',
    conflicts: [{ path: 'memory/deleted.md', reason_code: 'tombstone_resurrection' }],
    omitted_count: 0,
  }]);
  expect(readReplayQueue(queued).items[0]).toMatchObject({ id: queuedItem.item.id, last_outcome: { type: 'blocked_conflict' } });
});

test('replay ignores a newer fleet tombstone for a page absent from the frozen payload', async () => {
  const storeRoot = tempDir('ab-store-');
  const remote = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/other.md': 'remove remotely\n' });
  const queued = checkout('bootup', { 'memory/MEMORY.md': 'shared\n' });
  expect(await runMemoryCommand(['publish', '--cwd', remote, '--store', `file://${storeRoot}`, '--snapshot-id', 'before-delete'], captureIo().io)).toBe(0);
  enqueueReplayItem({ projectRoot: queued, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'queued' });
  fs.rmSync(path.join(remote, 'memory', 'other.md'));
  expect(await runMemoryCommand(['publish', '--cwd', remote, '--store', `file://${storeRoot}`, '--snapshot-id', 'delete-other'], captureIo().io)).toBe(0);

  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', queued, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(0);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 0, replayed: 1, blocked_conflict: 0 });
});

test('replay blocks a stale page queued after the fleet has already deleted it', async () => {
  const storeRoot = tempDir('ab-store-');
  const remote = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/deleted.md': 'remove me\n' });
  const stale = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/deleted.md': 'remove me\n' });
  expect(await runMemoryCommand(['publish', '--cwd', remote, '--store', `file://${storeRoot}`, '--snapshot-id', 'before-delete'], captureIo().io)).toBe(0);
  fs.rmSync(path.join(remote, 'memory', 'deleted.md'));
  expect(await runMemoryCommand(['publish', '--cwd', remote, '--store', `file://${storeRoot}`, '--snapshot-id', 'delete'], captureIo().io)).toBe(0);
  const queuedItem = enqueueReplayItem({ projectRoot: stale, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'stale-after-delete' });

  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', stale, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(3);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 1, blocked_conflict: 1 });
  expect(readReplayQueue(stale).items[0]).toMatchObject({ id: queuedItem.item.id, last_outcome: { type: 'blocked_conflict' } });
});

test('same-content re-enqueue refreshes replay mtime for a genuine post-delete recreation', async () => {
  const storeRoot = tempDir('ab-store-');
  const remote = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/recreated.md': 'same bytes\n' });
  const local = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/recreated.md': 'same bytes\n' });
  expect(await runMemoryCommand(['publish', '--cwd', remote, '--store', `file://${storeRoot}`, '--snapshot-id', 'before-delete'], captureIo().io)).toBe(0);
  const first = enqueueReplayItem({ projectRoot: local, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'stale' });
  fs.rmSync(path.join(remote, 'memory', 'recreated.md'));
  expect(await runMemoryCommand(['publish', '--cwd', remote, '--store', `file://${storeRoot}`, '--snapshot-id', 'delete'], captureIo().io)).toBe(0);
  const recreated = path.join(local, 'memory', 'recreated.md');
  fs.utimesSync(recreated, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
  const second = enqueueReplayItem({ projectRoot: local, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'recreated' });
  expect(second.deduplicated).toBe(true);
  expect(second.item.id).toBe(first.item.id);

  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', local, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(0);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 0, replayed: 1 });
});

test('legacy queued payload without source mtime metadata fails closed before store mutation', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'legacy\n' });
  const queued = enqueueReplayItem({ projectRoot: a, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'legacy' });
  const queue = readReplayQueue(a);
  const legacy = { version: queue.version, items: queue.items.map(({ file_mtimes, ...item }) => item) };
  fs.writeFileSync(queued.queue.paths.queuePath, JSON.stringify(legacy));

  expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`], captureIo().io)).toBe(1);
  expect(fs.existsSync(path.join(storeRoot, 'bootup', 'latest.json'))).toBe(false);
  expect(await runMemoryCommand(['replay', '--cwd', a, '--inspect', queued.item.id], captureIo().io)).toBe(1);
  expect(await runMemoryCommand(['replay', '--cwd', a, '--discard', queued.item.id, '--confirm-loss'], captureIo().io)).toBe(0);
});

test('three reachable replay failures retain the head and mark it degraded', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'degrade me\n' });
  enqueueReplayItem({ projectRoot: a, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'degrade' });
  const originalCopy = fs.copyFileSync;
  (fs as any).copyFileSync = ((source: fs.PathLike, destination: fs.PathLike, ...rest: any[]) => {
    if (String(destination).includes(path.basename(storeRoot))) {
      throw new Error('reachable store write failed');
    }
    return originalCopy(source, destination, ...rest);
  }) as typeof fs.copyFileSync;
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const replay = captureIo();
      expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(1);
      const result = JSON.parse(replay.out[0]);
      expect(result.pending).toBe(1);
      expect(result.retrying).toBe(attempt < 3 ? 1 : 0);
      expect(result.degraded).toBe(attempt === 3 ? 1 : 0);
      expect(result.failed_invalid_queue).toBe(0);
    }
  } finally {
    (fs as any).copyFileSync = originalCopy;
  }
  expect(readReplayQueue(a).items[0]).toMatchObject({ attempt_count: 3, last_outcome: { type: 'degraded' } });
});

for (const permissionCode of ['EACCES', 'EPERM', 'EROFS']) {
  test(`replay store ${permissionCode} remains a local precondition through degradation`, async () => {
    const storeRoot = tempDir('ab-store-');
    const a = checkout('bootup', { 'memory/MEMORY.md': 'permission failure\n' });
    const queued = enqueueReplayItem({
      projectRoot: a,
      store: resolveMemoryStore(`file://${storeRoot}`),
      snapshotId: `permission-${permissionCode}`,
    });
    const originalCopy = fs.copyFileSync;
    (fs as any).copyFileSync = ((source: fs.PathLike, destination: fs.PathLike, ...rest: any[]) => {
      if (String(destination).includes(path.basename(storeRoot))) {
        const error: NodeJS.ErrnoException = new Error(`SENTINEL_REMOTE_${permissionCode} permission denied`);
        error.code = permissionCode;
        throw error;
      }
      return originalCopy(source, destination, ...rest);
    }) as typeof fs.copyFileSync;
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const replay = captureIo();
        expect(await runMemoryCommand([
          'replay', '--cwd', a, '--store', `file://${storeRoot}`, '--json',
        ], replay.io)).toBe(1);
        expect(JSON.parse(replay.out[0])).toMatchObject({
          pending: 1,
          retrying: attempt < 3 ? 1 : 0,
          degraded: attempt === 3 ? 1 : 0,
          deferred_unreachable: 0,
          failed_invalid_queue: 0,
        });
        expect(replay.failures).toEqual([{ category: 'local_precondition' }]);
        expect(JSON.stringify(replay)).not.toContain(`SENTINEL_REMOTE_${permissionCode}`);
      }
    } finally {
      (fs as any).copyFileSync = originalCopy;
    }
    expect(readReplayQueue(a).items).toHaveLength(1);
    expect(readReplayQueue(a).items[0]).toMatchObject({
      id: queued.item.id,
      attempt_count: 3,
      last_outcome: { type: 'degraded', detail: permissionCode },
    });
  });
}

test('missing replay store roots defer the FIFO head without allowing discard', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'missing store\n' });
  const queued = enqueueReplayItem({ projectRoot: a, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'missing-store' });
  const originalExists = fs.existsSync;
  let storeRootChecks = 0;
  (fs as any).existsSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === storeRoot) {
      storeRootChecks += 1;
      return storeRootChecks === 1;
    }
    return originalExists(target);
  }) as typeof fs.existsSync;
  try {
    const replay = captureIo();
    expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(4);
    expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 1, deferred_unreachable: 1 });
  } finally {
    (fs as any).existsSync = originalExists;
  }
  expect(readReplayQueue(a).items[0]).toMatchObject({ id: queued.item.id, last_outcome: { type: 'deferred_unreachable' } });
  expect(await runMemoryCommand(['replay', '--cwd', a, '--discard', queued.item.id, '--confirm-loss'], captureIo().io)).toBe(1);
});

test('replay refuses to mint a fallback publisher identity when machine id is unavailable', async () => {
  const storeRoot = tempDir('ab-replay-machine-id-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'queued identity\n' });
  enqueueReplayItem({ projectRoot: a, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'queued' });
  const idHome = tempDir('ab-replay-machine-id-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const previousMachineIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  try {
    const replay = captureIo();
    expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`], replay.io)).toBe(1);
    expect(replay.err.join('\n')).toMatch(/no pinned publisher identity/i);
    expect(fs.existsSync(path.join(a, '.brain', 'publisher-id.json'))).toBe(false);
  } finally {
    if (previousMachineIdFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = previousMachineIdFile;
  }
});

test('replay surfaces a corrupt publisher pin when machine id is unavailable', async () => {
  const storeRoot = tempDir('ab-replay-corrupt-pin-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'queued identity\n' });
  enqueueReplayItem({ projectRoot: a, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'queued' });
  fs.mkdirSync(path.join(a, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(a, '.brain', 'publisher-id.json'), '{ corrupt');
  const idHome = tempDir('ab-replay-corrupt-pin-id-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const previousMachineIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  try {
    const replay = captureIo();
    expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`], replay.io)).toBe(1);
    expect(replay.err.join('\n')).toMatch(/pinned publisher id is unreadable\/corrupt/i);
  } finally {
    if (previousMachineIdFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = previousMachineIdFile;
  }
});

test('invalid replay payload is retained, inspectable, and requires explicit loss confirmation to discard', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'frozen\n' });
  const queued = enqueueReplayItem({ projectRoot: a, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'bad' });
  fs.writeFileSync(path.join(queued.payload.payloadDir, 'payload', 'memory', 'MEMORY.md'), 'tampered\n');

  const replay = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(1);
  expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 1, failed_invalid_queue: 1 });
  expect(readReplayQueue(a).items[0].last_outcome.type).toBe('failed_invalid_payload');

  const inspected = captureIo();
  expect(await runMemoryCommand(['replay', '--cwd', a, '--inspect', queued.item.id, '--json'], inspected.io)).toBe(1);
  expect(JSON.parse(inspected.out[0])).toMatchObject({ item: { id: queued.item.id }, payload: { valid: false } });
  expect(await runMemoryCommand(['replay', '--cwd', a, '--discard', queued.item.id], captureIo().io)).toBe(1);
  expect(await runMemoryCommand(['replay', '--cwd', a, '--discard', queued.item.id, '--confirm-loss'], captureIo().io)).toBe(0);
  expect(readReplayQueue(a).items).toHaveLength(0);
});

test('replay inspect leaves an invalid payload queue byte-for-byte unchanged', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'frozen\n' });
  const queued = enqueueReplayItem({ projectRoot: a, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'inspect-only' });
  fs.writeFileSync(path.join(queued.payload.payloadDir, 'payload', 'memory', 'MEMORY.md'), 'tampered\n');
  const before = fs.readFileSync(queued.queue.paths.queuePath, 'utf8');

  expect(await runMemoryCommand(['replay', '--cwd', a, '--inspect', queued.item.id, '--json'], captureIo().io)).toBe(1);

  expect(fs.readFileSync(queued.queue.paths.queuePath, 'utf8')).toBe(before);
  expect(readReplayQueue(a).items[0].last_outcome).toBeNull();
});

test('memory diagnose is read-only when no replay queue or remote store exists', async () => {
  const a = checkout('bootup', { 'memory/MEMORY.md': 'idx\n' });
  const result = captureIo();
  expect(await runMemoryCommand(['diagnose', '--cwd', a], result.io)).toBe(1);
  expect(JSON.parse(result.out[0])).toMatchObject({
    schema: 'memory-diagnose/v1',
    read_only: true,
    replay: { present: false, queue_valid: true, items: [] },
    store: { scheme: 'none', reachable: false, error: 'not_configured' },
  });
  expect(fs.existsSync(path.join(a, '.brain'))).toBe(false);
});

test('memory diagnose reads remote pointer and snapshot metadata without materializing cache state', async () => {
  await setupServerCreds();
  const remote = installMockBrainAssetsFetch();
  const a = checkout('bootup', { 'memory/MEMORY.md': 'idx\n' });
  const bundleHash = `sha256:${'a'.repeat(64)}`;
  remote.putDoc('bootup', 'memory-store/heads/publisher-a.json', { bundle_hash: bundleHash });
  remote.putDoc('bootup', 'memory-store/latest.json', { bundle_hash: bundleHash });
  remote.putDoc('bootup', `memory-store/snapshots/${bundleHash}/manifest.json`, { bundle_hash: bundleHash, files: [] });
  remote.putDoc('bootup', `memory-store/snapshots/${bundleHash}/markers.json`, { version: 1, pages: {} });
  remote.putDoc('bootup', `memory-store/snapshots/${bundleHash}/payload/memory/MEMORY.md`, 'payload is not emitted');
  const result = captureIo();
  expect(await runMemoryCommand(['diagnose', '--cwd', a, '--store', 'server://bootup', '--json'], result.io)).toBe(0);
  expect(JSON.parse(result.out[0])).toMatchObject({
    schema: 'memory-diagnose/v1',
    store: {
      scheme: 'server', reachable: true,
      heads: { listed: 1, readable: 1, unreadable: [] },
      latest: { present: true, readable: true, bundle_hash: bundleHash },
      snapshots: [{ bundle_hash: bundleHash, manifest: 'readable', markers: 'readable', payload_assets: 1 }],
    },
  });
  expect(fs.existsSync(path.join(a, '.brain'))).toBe(false);
  expect(fs.existsSync(path.join(a, '.brain', 'remote-memory-cache'))).toBe(false);
});

test('structured memory CLI envelopes ignore inherited JSON hooks and setters', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'safe json\n' });
  const replayCheckout = checkout('bootup', { 'memory/MEMORY.md': 'empty replay queue\n' });
  const queued = enqueueReplayItem({
    projectRoot: a, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'safe-json',
  });
  const objectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const schema = Object.getOwnPropertyDescriptor(Object.prototype, 'schema');
  const numeric = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  const wires: string[] = [];
  try {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value: () => ({ leak: 'SENTINEL_OBJECT_JSON' }) });
    Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value: () => ['SENTINEL_ARRAY_JSON'] });
    Object.defineProperty(Object.prototype, 'schema', {
      configurable: true,
      set() { Object.defineProperty(this, 'schema', { configurable: true, enumerable: true, writable: true, value: 'SENTINEL_SCHEMA_SETTER' }); },
    });
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set(value) {
        const schema = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'schema') : null;
        Object.defineProperty(this, '0', { configurable: true, enumerable: true, writable: true,
          value: schema ? 'SENTINEL_NUMERIC_SETTER' : value });
      },
    });
    const readOnlyCommands: Array<[string[], number]> = [
      [['replay', '--cwd', a, '--inspect', queued.item.id, '--json'], 0],
      [['diagnose', '--cwd', a, '--store', `file://${storeRoot}`], 0],
    ];
    for (const [argv, expectedExit] of readOnlyCommands) {
      const result = captureIo();
      expect(await runMemoryCommand(argv, result.io)).toBe(expectedExit);
      expect(result.out).toHaveLength(1);
      wires.push(result.out[0]);
    }
    // Bun's asynchronous lock machinery itself uses inherited array writes;
    // the two read-only real commands above cover the numeric setter boundary.
    // Keep inherited JSON/object setters active for the asynchronous replay.
    if (numeric) Object.defineProperty(Array.prototype, '0', numeric);
    else delete (Array.prototype as any)['0'];
    const replay = captureIo();
    expect(await runMemoryCommand(['replay', '--cwd', replayCheckout, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(0);
    expect(replay.out).toHaveLength(1);
    wires.push(replay.out[0]);
  } finally {
    if (objectToJSON) Object.defineProperty(Object.prototype, 'toJSON', objectToJSON); else delete (Object.prototype as any).toJSON;
    if (arrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', arrayToJSON); else delete (Array.prototype as any).toJSON;
    if (schema) Object.defineProperty(Object.prototype, 'schema', schema); else delete (Object.prototype as any).schema;
    if (numeric) Object.defineProperty(Array.prototype, '0', numeric); else delete (Array.prototype as any)['0'];
  }
  expect(wires).toHaveLength(3);
  expect(JSON.parse(wires[0])).toMatchObject({ item: { id: queued.item.id }, payload: { valid: true } });
  expect(JSON.parse(wires[1])).toMatchObject({ schema: 'memory-diagnose/v1' });
  expect(JSON.parse(wires[2])).toMatchObject({ pending: 0, replayed: 0 });
  for (const wire of wires) {
    expect(() => JSON.parse(wire)).not.toThrow();
    expect(wire).not.toContain('SENTINEL');
  }
});

test('transient replay payload reads defer without terminalizing the queue item', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'transient\n' });
  const queued = enqueueReplayItem({ projectRoot: a, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 'transient' });
  const originalRead = fs.readFileSync;
  (fs as any).readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: any[]) => {
    if (String(target) === path.join(queued.payload.payloadDir, 'manifest.json')) {
      const error: NodeJS.ErrnoException = new Error('temporary I/O failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRead(target, ...rest);
  }) as typeof fs.readFileSync;
  try {
    const replay = captureIo();
    expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`, '--json'], replay.io)).toBe(4);
    expect(JSON.parse(replay.out[0])).toMatchObject({ pending: 1, deferred_unreachable: 1 });

    const inspect = captureIo();
    expect(await runMemoryCommand(['replay', '--cwd', a, '--inspect', queued.item.id, '--json'], inspect.io)).toBe(1);
    expect(JSON.parse(inspect.out[0])).toMatchObject({ item: { id: queued.item.id }, payload: { valid: false, terminal: false } });
  } finally {
    (fs as any).readFileSync = originalRead;
  }
  expect(readReplayQueue(a).items[0].last_outcome.type).toBe('deferred_unreachable');
});

for (const permissionCode of ['EACCES', 'EPERM', 'EROFS']) {
  test(`replay payload ${permissionCode} remains locally retryable and inspectable`, async () => {
    const storeRoot = tempDir('ab-store-');
    const a = checkout('bootup', { 'memory/MEMORY.md': 'permission blocked\n' });
    const queued = enqueueReplayItem({
      projectRoot: a,
      store: resolveMemoryStore(`file://${storeRoot}`),
      snapshotId: `payload-permission-${permissionCode}`,
    });
    const originalRead = fs.readFileSync;
    (fs as any).readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: any[]) => {
      if (String(target) === path.join(queued.payload.payloadDir, 'manifest.json')) {
        const error: NodeJS.ErrnoException = new Error(`SENTINEL_LOCAL_${permissionCode} permission denied`);
        error.code = permissionCode;
        throw error;
      }
      return originalRead(target, ...rest);
    }) as typeof fs.readFileSync;
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const replay = captureIo();
        expect(await runMemoryCommand([
          'replay', '--cwd', a, '--store', `file://${storeRoot}`, '--json',
        ], replay.io)).toBe(1);
        expect(JSON.parse(replay.out[0])).toMatchObject({
          pending: 1,
          retrying: attempt < 3 ? 1 : 0,
          degraded: attempt === 3 ? 1 : 0,
          deferred_unreachable: 0,
          failed_invalid_queue: 0,
        });
        expect(replay.failures).toEqual([{ category: 'local_precondition' }]);
        expect(JSON.stringify(replay)).not.toContain(`SENTINEL_LOCAL_${permissionCode}`);
      }
      const inspect = captureIo();
      expect(await runMemoryCommand([
        'replay', '--cwd', a, '--inspect', queued.item.id, '--json',
      ], inspect.io)).toBe(1);
      expect(JSON.parse(inspect.out[0])).toMatchObject({
        item: { id: queued.item.id },
        payload: { valid: false, terminal: false, error: permissionCode },
      });
      expect(JSON.stringify(inspect)).not.toContain(`SENTINEL_LOCAL_${permissionCode}`);
    } finally {
      (fs as any).readFileSync = originalRead;
    }

    expect(readReplayQueue(a).items).toHaveLength(1);
    expect(readReplayQueue(a).items[0]).toMatchObject({
      id: queued.item.id,
      attempt_count: 3,
      last_outcome: { type: 'degraded', detail: permissionCode },
    });
  });
}

test('flush captures then queues delivery before a transient store failure', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'flush me\n' });
  const originalRealpath = fs.realpathSync;
  (fs as any).realpathSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === storeRoot) {
      const error: NodeJS.ErrnoException = new Error('network filesystem I/O failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRealpath(target);
  }) as typeof fs.realpathSync;
  try {
    const flush = captureIo();
    expect(await runMemoryCommand(['flush', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'flush-1'], flush.io)).toBe(4);
    expect(flush.out.join('\n')).toContain('Queued memory flush');
    expect(readReplayQueue(a).items).toHaveLength(1);
  } finally {
    (fs as any).realpathSync = originalRealpath;
  }
});

test('flush retains its frozen snapshot when the store is unreachable before publish', async () => {
  const root = tempDir('ab-flush-missing-store-');
  const storeRoot = path.join(root, 'missing-store');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'retain before preflight\n' });
  expect(await runMemoryCommand(['flush', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'flush-missing'], captureIo().io)).toBe(1);
  expect(readReplayQueue(a).items).toHaveLength(1);
  expect(readReplayQueue(a).items[0].snapshot_id).toBe('flush-missing');
});

test('flush publishes an empty memory tree as a tombstone-only update', async () => {
  const storeRoot = tempDir('ab-flush-empty-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'remove me\n' });
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'before-delete'], captureIo().io)).toBe(0);
  fs.rmSync(path.join(a, 'memory', 'MEMORY.md'));
  expect(await runMemoryCommand(['flush', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'empty-flush'], captureIo().io)).toBe(0);
  const b = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  expect(fs.existsSync(path.join(b, 'memory', 'MEMORY.md'))).toBe(false);
});

test('flush tombstones a page deleted after refresh before this checkout has a head', async () => {
  const storeRoot = tempDir('ab-flush-delete-store-');
  const source = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/deleted.md': 'remove me\n' });
  const fresh = checkout('bootup', {});
  expect(await runMemoryCommand(['publish', '--cwd', source, '--store', `file://${storeRoot}`, '--snapshot-id', 'source'], captureIo().io)).toBe(0);
  expect(await runMemoryCommand(['refresh', '--cwd', fresh, '--from-store', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  fs.rmSync(path.join(fresh, 'memory', 'deleted.md'));
  expect(await runMemoryCommand(['flush', '--cwd', fresh, '--store', `file://${storeRoot}`, '--snapshot-id', 'flush-delete'], captureIo().io)).toBe(0);
  const verify = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', verify, '--from-store', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  expect(fs.existsSync(path.join(verify, 'memory', 'deleted.md'))).toBe(false);
});

test('deferred publish retains deleted pages for replay tombstones', async () => {
  const storeRoot = tempDir('ab-publish-delete-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/deleted.md': 'remove me\n' });
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'before-delete'], captureIo().io)).toBe(0);
  fs.rmSync(path.join(a, 'memory', 'deleted.md'));
  const originalCopy = fs.copyFileSync;
  (fs as any).copyFileSync = ((source: fs.PathLike, destination: fs.PathLike, ...rest: any[]) => {
    if (String(destination).includes(path.basename(storeRoot))) {
      const error: NodeJS.ErrnoException = new Error('transient store I/O failure');
      error.code = 'EIO';
      throw error;
    }
    return originalCopy(source, destination, ...rest);
  }) as typeof fs.copyFileSync;
  try {
    expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'deferred-delete'], captureIo().io)).toBe(4);
  } finally {
    (fs as any).copyFileSync = originalCopy;
  }
  expect(readReplayQueue(a).items[0].deleted_pages).toContain('memory/deleted.md');
  expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  const verify = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', verify, '--from-store', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  expect(fs.existsSync(path.join(verify, 'memory', 'deleted.md'))).toBe(false);
});

test('replayed deferred deletion does not override a later recreation', async () => {
  const storeRoot = tempDir('ab-replay-delete-order-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'shared\n', 'memory/page.md': 'original\n' });
  const b = checkout('bootup', {});
  const previousMachineIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const machineA = path.join(tempDir('ab-machine-a-'), 'machine-id');
  const machineB = path.join(tempDir('ab-machine-b-'), 'machine-id');
  try {
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineA;
    fs.writeFileSync(machineA, '11111111-1111-4111-8111-111111111111\n');
    expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'initial'], captureIo().io)).toBe(0);
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineB;
    fs.writeFileSync(machineB, '22222222-2222-4222-8222-222222222222\n');
    expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineA;
    fs.rmSync(path.join(a, 'memory', 'page.md'));
    const originalCopy = fs.copyFileSync;
    const originalLstat = fs.lstatSync;
    let hideQueueFromPrePublishGate = false;
    (fs as any).copyFileSync = ((source: fs.PathLike, destination: fs.PathLike, ...rest: any[]) => {
      if (String(destination).includes(path.basename(storeRoot))) {
        const error: NodeJS.ErrnoException = new Error('transient store I/O failure');
        error.code = 'EIO';
        throw error;
      }
      return originalCopy(source, destination, ...rest);
    }) as typeof fs.copyFileSync;
    try {
      expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'queued-delete'], captureIo().io)).toBe(4);
      const firstDeletionTime = readReplayQueue(a).items[0].deleted_page_times?.['memory/page.md'];
      // A concurrent deferral can create the queue after this publish's preflight probe.
      hideQueueFromPrePublishGate = true;
      (fs as any).lstatSync = ((target: fs.PathLike, ...rest: any[]) => {
        if (hideQueueFromPrePublishGate && path.basename(String(target)) === 'memory-replay-queue.json') {
          hideQueueFromPrePublishGate = false;
          const error: NodeJS.ErrnoException = new Error('queue not visible during preflight');
          error.code = 'ENOENT';
          throw error;
        }
        return originalLstat(target, ...rest);
      }) as typeof fs.lstatSync;
      const retry = captureIo();
      expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 'queued-delete-retry'], retry.io)).toBe(4);
      expect(hideQueueFromPrePublishGate).toBe(false);
      expect(retry.err.join('\n')).toContain('memory publish deferred');
      expect(readReplayQueue(a).items[0].deleted_page_times?.['memory/page.md']).toBe(firstDeletionTime);
    } finally {
      (fs as any).copyFileSync = originalCopy;
      (fs as any).lstatSync = originalLstat;
    }
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineB;
    const recreated = path.join(b, 'memory', 'page.md');
    fs.writeFileSync(recreated, 'original\n');
    fs.utimesSync(recreated, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(await runMemoryCommand(['publish', '--cwd', b, '--store', `file://${storeRoot}`, '--snapshot-id', 'recreated'], captureIo().io)).toBe(0);
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineA;
    expect(await runMemoryCommand(['replay', '--cwd', a, '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  } finally {
    if (previousMachineIdFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = previousMachineIdFile;
  }
  const verify = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', verify, '--from-store', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  expect(fs.readFileSync(path.join(verify, 'memory', 'page.md'), 'utf8')).toBe('original\n');
});

test('refresh --from-store against an unreachable store exits 1 (never faked success)', async () => {
  const b = checkout('bootup', {});
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', 'file:///no/such/store/xyz'], r.io)).toBe(1);
  expect(r.err.join('\n')).toMatch(/unreachable/);
});

test('refresh --from-store with no store configured is a local-only no-op (exit 0)', async () => {
  const b = checkout('bootup', {});
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store'], r.io)).toBe(0);
  expect(r.out.join('\n')).toMatch(/local-only/);
});

test('refresh --from-store with no store configured stays local-only even if brain-map.json is invalid', async () => {
  const b = checkout('bootup', {});
  fs.writeFileSync(path.join(b, 'brain-map.json'), '{not json\n', 'utf8');
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store'], r.io)).toBe(0);
  expect(r.out.join('\n')).toMatch(/local-only/);
  expect(r.err.join('\n')).not.toContain('brain-map present but invalid');
});

test('refresh --from-store returns 3 when the store is empty but the committed brain-map expects pages', async () => {
  const storeRoot = tempDir('ab-store-');
  const b = checkout('bootup', {});
  fs.writeFileSync(
    path.join(b, 'brain-map.json'),
    JSON.stringify(
      {
        schema: 'brain-map/1',
        brain: 'bootup',
        page_count: 1,
        pages: [{ path: 'MEMORY.md', type: 'index' }],
      },
      null,
      2,
    ) + '\n',
  );

  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', `file://${storeRoot}`], r.io)).toBe(3);
  expect(r.out.join('\n')).toContain('available_pages: 0');
  expect(r.err.join('\n')).toContain('gap not covered by the store');
});

test('memory map writes a committed brain-map and memory verify returns 0 when memory matches it', async () => {
  const root = checkout('bootup', {
    'memory/MEMORY.md': 'idx\n',
    'memory/daily/2026-07-12.md': 'entry\n',
  });

  const map = captureIo();
  expect(await runMemoryCommand(['map', '--cwd', root], map.io)).toBe(0);
  expect(map.out.join('\n')).toMatch(/Wrote .*brain-map\.json/);
  expect(map.out.join('\n')).toMatch(/page_count: 2/);

  const verify = captureIo();
  expect(await runMemoryCommand(['verify', '--cwd', root], verify.io)).toBe(0);
  expect(verify.out.join('\n')).toContain('brain-map: 2/2 expected pages present');
  expect(verify.out.join('\n')).toContain('missing:   0');
  expect(verify.out.join('\n')).toContain('extra:     0');
});

test('memory map + verify round-trip reports a page deleted after map generation', async () => {
  const root = checkout('bootup', {
    'memory/MEMORY.md': 'idx\n',
    'memory/feedback_x.md': 'x\n',
  });

  expect(await runMemoryCommand(['map', '--cwd', root], captureIo().io)).toBe(0);
  fs.rmSync(path.join(root, 'memory', 'feedback_x.md'));

  const verify = captureIo();
  expect(await runMemoryCommand(['verify', '--cwd', root], verify.io)).toBe(3);
  expect(verify.err.join('\n')).toContain('MISSING feedback_x.md');
});

test('memory verify returns 3 when committed brain-map pages are still missing', async () => {
  const root = checkout('bootup', {
    'memory/MEMORY.md': 'idx\n',
  });
  fs.writeFileSync(
    path.join(root, 'brain-map.json'),
    JSON.stringify(
      {
        schema: 'brain-map/1',
        brain: 'bootup',
        page_count: 2,
        pages: [
          { path: 'MEMORY.md', type: 'index' },
          { path: 'daily/2026-07-12.md', type: 'daily' },
        ],
      },
      null,
      2,
    ) + '\n',
  );

  const verify = captureIo();
  expect(await runMemoryCommand(['verify', '--cwd', root], verify.io)).toBe(3);
  expect(verify.out.join('\n')).toContain('brain-map: 1/2 expected pages present');
  expect(verify.err.join('\n')).toContain('MISSING daily/2026-07-12.md');
});

test('refresh --from-store returns 3 when the committed brain-map still has unresolved gaps after fetch', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'idx\n' });
  const b = checkout('bootup', {});
  fs.writeFileSync(
    path.join(b, 'brain-map.json'),
    JSON.stringify(
      {
        schema: 'brain-map/1',
        brain: 'bootup',
        page_count: 2,
        pages: [
          { path: 'MEMORY.md', type: 'index' },
          { path: 'daily/2026-07-12.md', type: 'daily' },
        ],
      },
      null,
      2,
    ) + '\n',
  );

  const pub = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], pub.io)).toBe(0);

  const ref = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', `file://${storeRoot}`], ref.io)).toBe(3);
  expect(fs.readFileSync(path.join(b, 'memory', 'MEMORY.md'), 'utf8')).toBe('idx\n');
  expect(ref.out.join('\n')).toContain('brain-map:       1/2 expected pages present');
  expect(ref.err.join('\n')).toContain('gap not covered by the store');
});

test('refresh --from-store fails when a committed brain-map is invalid', async () => {
  const storeRoot = tempDir('ab-store-');
  const a = checkout('bootup', { 'memory/MEMORY.md': 'idx\n' });
  const b = checkout('bootup', {});
  fs.writeFileSync(path.join(b, 'brain-map.json'), '{not json\n', 'utf8');

  const pub = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], pub.io)).toBe(0);

  const ref = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store', '--store', `file://${storeRoot}`], ref.io)).toBe(1);
  expect(ref.err.join('\n')).toContain('brain-map present but invalid');
  expect(fs.existsSync(path.join(b, 'memory', 'MEMORY.md'))).toBe(false);
});

test('refresh --from-store with NO store is local-only (exit 0) even if the committed map is invalid', async () => {
  // Regression (roborev 11623): a store-less machine must not fail on an invalid local map
  // when nothing is being fetched — map validation happens only after the local-only return.
  const b = checkout('bootup', {});
  fs.writeFileSync(path.join(b, 'brain-map.json'), '{not json\n', 'utf8');
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', b, '--from-store'], r.io)).toBe(0);
  expect(r.out.join('\n')).toMatch(/local-only/);
});

test('refresh --from-store defaults to per-page merge; --latest opts to single snapshot', async () => {
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': 'idx\n', 'memory/from_a.md': 'A\n' });
  const B = checkout('bootup', { 'memory/MEMORY.md': 'idx\n', 'memory/from_b.md': 'B\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 'sa'], captureIo().io);
  await runMemoryCommand(['publish', '--cwd', B, '--store', `file://${storeRoot}`, '--snapshot-id', 'sb'], captureIo().io);

  // DEFAULT = merge: unions across all heads -> both distinct pages present, merge-mode output.
  const d = checkout('bootup', {});
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', d, '--from-store', '--store', `file://${storeRoot}`], r.io)).toBe(0);
  expect(fs.existsSync(path.join(d, 'memory/from_a.md'))).toBe(true);
  expect(fs.existsSync(path.join(d, 'memory/from_b.md'))).toBe(true);
  expect(r.out.join('\n')).toMatch(/per-page merge/);

  // --latest opts to the single latest-snapshot view.
  const e = checkout('bootup', {});
  const r2 = captureIo();
  await runMemoryCommand(['refresh', '--cwd', e, '--from-store', '--latest', '--store', `file://${storeRoot}`], r2.io);
  expect(r2.out.join('\n')).toMatch(/latest snapshot/);
});

test('publish then refresh converges a DELETION across checkouts (tombstone, default merge)', async () => {
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/temp.md': 'x\n' });
  const B = checkout('bootup', {});
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/temp.md'))).toBe(true);

  // A deletes temp.md and re-publishes (reconcile must NOT re-add it -> tombstone recorded).
  fs.rmSync(path.join(A, 'memory/temp.md'));
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);

  const r = captureIo();
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], r.io);
  expect(fs.existsSync(path.join(B, 'memory/temp.md'))).toBe(false); // deletion converged
  expect(r.out.join('\n')).toMatch(/removed:\s+1/);
});

test('a FRESH checkout publishing after a fleet-wide delete does NOT resurrect the deleted page', async () => {
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/temp.md': 't\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  // A deletes temp.md and republishes -> tombstone. latest.json still points at the pre-delete snapshot.
  fs.rmSync(path.join(A, 'memory/temp.md'));
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);

  // A FRESH checkout C (no prior head) publishes: reconcile pulls the stale latest (with temp.md),
  // but the fleet tombstone must prevent C from resurrecting it.
  const C = checkout('bootup', { 'memory/MEMORY.md': '#\n' });
  await runMemoryCommand(['publish', '--cwd', C, '--store', `file://${storeRoot}`, '--snapshot-id', 's3'], captureIo().io);
  expect(fs.existsSync(path.join(C, 'memory/temp.md'))).toBe(false); // not resurrected locally

  // And a later refresh anywhere keeps temp.md deleted (converged).
  const D = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', D, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(D, 'memory/temp.md'))).toBe(false);
});

test('a FRESH checkout can delete a shared page: refresh -> delete -> publish converges the deletion', async () => {
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/foo.md': 'foo\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);

  // Fresh checkout C (never published): refresh -> has foo.md, then deletes it, then publishes.
  const C = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', C, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(C, 'memory/foo.md'))).toBe(true);
  fs.rmSync(path.join(C, 'memory/foo.md'));
  await runMemoryCommand(['publish', '--cwd', C, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);
  expect(fs.existsSync(path.join(C, 'memory/foo.md'))).toBe(false); // not resurrected on publish

  // Another checkout refreshes -> foo.md is gone (the fresh-checkout deletion converged).
  const D = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', D, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(D, 'memory/foo.md'))).toBe(false);
});

test('a FRESH checkout that refreshes then deletes ALL pages converges the empty state', async () => {
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/only.md': 'x\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);

  // Fresh C: refresh -> has both, delete EVERYTHING, publish (empty tombstone-only, via baseline).
  const C = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', C, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  fs.rmSync(path.join(C, 'memory/MEMORY.md'));
  fs.rmSync(path.join(C, 'memory/only.md'));
  const pub = captureIo();
  await runMemoryCommand(['publish', '--cwd', C, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], pub.io);
  expect(pub.out.join('\n')).toMatch(/tombstone-only/);

  const D = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', D, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(D, 'memory'))).toBe(false); // nothing materialized — all converged deleted
});

// Every tombstone page-key recorded across all publisher heads in the store.
function storeTombstonePages(storeRoot: string, agentId = 'bootup'): Set<string> {
  const headsDir = path.join(storeRoot, agentId, 'heads');
  const pages = new Set<string>();
  if (!fs.existsSync(headsDir)) return pages;
  for (const name of fs.readdirSync(headsDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const h = JSON.parse(fs.readFileSync(path.join(headsDir, name), 'utf8'));
      for (const p of Object.keys(h?.tombstones || {})) pages.add(p);
    } catch {
      /* skip unreadable head */
    }
  }
  return pages;
}

test('deleting a LOCAL-ONLY page (never in the store) does NOT create a fleet tombstone', async () => {
  // roborev: refresh must baseline only STORE-BACKED pages, not all local files. Otherwise a
  // local-only page present at refresh time, then deleted+published, is wrongly tombstoned fleet-wide.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/shared.md': 's\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);

  // B starts WITH a local-only page that was never published, then refreshes (baseline = store pages).
  const B = checkout('bootup', { 'memory/localonly.md': 'local\n' });
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/shared.md'))).toBe(true); // gap-filled from store
  expect(fs.existsSync(path.join(B, 'memory/localonly.md'))).toBe(true); // local drift preserved

  // B deletes its local-only page and publishes. It must NOT be tombstoned (was never shared).
  fs.rmSync(path.join(B, 'memory/localonly.md'));
  await runMemoryCommand(['publish', '--cwd', B, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);
  expect(storeTombstonePages(storeRoot).has('memory/localonly.md')).toBe(false);

  // Proof it stays revivable: a checkout that legitimately creates localonly.md keeps it after refresh.
  const C = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', C, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  fs.writeFileSync(path.join(C, 'memory/localonly.md'), 'legit\n');
  await runMemoryCommand(['publish', '--cwd', C, '--store', `file://${storeRoot}`, '--snapshot-id', 's3'], captureIo().io);
  const D = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', D, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(D, 'memory/localonly.md'))).toBe(true); // no phantom tombstone suppressed it
});

test('a malformed tombstone key in a head does NOT abort refresh (skipped; legit deletion converges)', async () => {
  // roborev: an untrusted head carrying a traversal key like "../../x" must be filtered when read,
  // not survive the merge and throw in applyMergedSnapshot, which would fail the whole refresh.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/temp.md': 't\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  fs.rmSync(path.join(A, 'memory/temp.md')); // legit deletion -> real tombstone
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);

  // Inject a poisoned tombstone key into a head file.
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const headName = fs.readdirSync(headsDir).find((n) => n.endsWith('.json') && !n.startsWith('_latest_'))!;
  const hp = path.join(headsDir, headName);
  const h = JSON.parse(fs.readFileSync(hp, 'utf8'));
  h.tombstones = { ...(h.tombstones || {}), '../../escape.md': 9_999_999_999_999 };
  fs.writeFileSync(hp, JSON.stringify(h));

  const B = checkout('bootup', {});
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], r.io)).toBe(0);
  expect(fs.existsSync(path.join(B, 'memory/temp.md'))).toBe(false); // legit deletion still converged
  expect(fs.existsSync(path.join(B, 'memory/MEMORY.md'))).toBe(true);
});

test('migration edge: a pre-upgrade checkout (no pin, machine-id down) is REFUSED, not silently mis-tombstoned', async () => {
  // roborev HIGH: a pre-upgrade checkout has a REAL old head but no pin; if machine-id is down, the
  // fallback id looks at the wrong head and a possibly-stale baseline can miss pages that lived only in
  // the old head — publishing would drop a deletion without a tombstone. So it must be REFUSED (not
  // allowed via the baseline). Recovery: restore machine id.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/temp.md': 't\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  // Simulate the pre-upgrade state: no pin file existed under the old code (but a baseline may exist).
  fs.rmSync(path.join(A, '.brain', 'publisher-id.json'), { force: true });
  expect(storeHeadFiles(storeRoot).length).toBe(1);

  const idHome = tempDir('ab-mid-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const prevMidFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  try {
    fs.rmSync(path.join(A, 'memory/temp.md'));
    const r = captureIo();
    expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], r.io)).toBe(1);
    expect(r.err.join('\n')).toMatch(/refused/i);
    expect(storeHeadFiles(storeRoot).length).toBe(1); // no second (orphan) head minted
  } finally {
    if (prevMidFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMidFile;
  }
  // Recovery: with machine id restored, the same publish succeeds and converges the deletion.
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's3'], captureIo().io);
  const B = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/temp.md'))).toBe(false); // deletion converged after recovery
});

test('a marker under a WRONG-IDENTITY manifest (bundle_type/agent) cannot suppress a real tombstone', async () => {
  // roborev HIGH: the cheap uncapped marker check must apply the SAME identity/shape gates as the full
  // load. A crafted manifest with a valid-looking bundle_hash but wrong bundle_type must be rejected so
  // its future marker cannot suppress a deletion (the full load would reject it too).
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/secret.md': 's\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  const B = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  fs.rmSync(path.join(A, 'memory/secret.md'));
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);

  // Craft a malicious snapshot dir with a self-consistent hash but WRONG bundle_type, plus a markers
  // sidecar advertising a far-future recency for secret.md.
  const fakeHex = 'a'.repeat(64);
  const dir = path.join(storeRoot, 'bootup', fakeHex);
  fs.mkdirSync(path.join(dir, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    bundle_type: 'evil', bundle_name: 'bootup', source: { agent_id: 'bootup' }, bundle_hash: `sha256:${fakeHex}`,
    files: [{ source: 'memory/secret.md', target: 'memory/secret.md' }],
  }));
  fs.writeFileSync(path.join(dir, 'markers.json'), JSON.stringify({ 'memory/secret.md': 9_999_999_999_999 }));
  fs.writeFileSync(path.join(storeRoot, 'bootup', 'heads', 'evil.json'), JSON.stringify({
    version_id: 'evil', bundle_hash: `sha256:${fakeHex}`, machine_id: 'evil',
    markers: { 'memory/secret.md': 9_999_999_999_999 }, tombstones: {}, updated_at: '2099-01-01T00:00:00.000Z',
  }));

  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/secret.md'))).toBe(false); // wrong-identity manifest rejected; tombstone won
});

test('a malicious head marker with NO valid backing snapshot cannot suppress a real tombstone', async () => {
  // roborev HIGH: content markers that suppress a tombstone must come only from an integrity-validated
  // snapshot. A head advertising a far-future marker for a page whose snapshot fails to load must NOT
  // resurrect a legitimately deleted page.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/page.md': 'p\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  const B = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/page.md'))).toBe(true);

  // A deletes page.md and publishes -> real tombstone.
  fs.rmSync(path.join(A, 'memory/page.md'));
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);

  // Inject a malicious head: a far-future marker for page.md, but bundle_hash points at a snapshot
  // dir that does not exist (integrity load will fail). Without the fix its marker would win the
  // tombstone comparison and resurrect secret.md.
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  fs.writeFileSync(
    path.join(headsDir, 'evil.json'),
    JSON.stringify({
      version_id: 'evil',
      bundle_hash: 'sha256:' + '0'.repeat(64),
      machine_id: 'evil',
      markers: { 'memory/page.md': 9_999_999_999_999 },
      tombstones: {},
      updated_at: '2099-01-01T00:00:00.000Z',
    }),
  );

  // B refreshes: page.md must CONVERGE to deleted — the unvalidated marker is dropped, tombstone wins.
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/page.md'))).toBe(false);
});

test('refresh through a symlinked memory root fails closed without writing a false baseline', async () => {
  // roborev: a store page left in `drifted` (e.g. a refused write through a symlinked memory/) is NOT
  // present locally; it must NOT enter the sync baseline, or the next publish reads its absence as an
  // intentional deletion and tombstones shared content the user never received.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/keep.md': 'k\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);

  // B's memory/ is a symlink to an empty dir -> writes are refused, so keep.md ends up drifted/absent.
  const B = tempDir('ab-symlink-');
  fs.writeFileSync(path.join(B, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  fs.writeFileSync(path.join(B, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  const empty = tempDir('ab-empty-');
  fs.symlinkSync(empty, path.join(B, 'memory'));
  const result = await runMemoryCommand(
    ['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`],
    captureIo().io,
  );
  expect(result).toBe(1);
  expect(fs.existsSync(path.join(empty, 'keep.md'))).toBe(false); // write refused (symlink containment)
  expect(fs.existsSync(path.join(B, '.brain', 'memory-sync-baseline.json'))).toBe(false);
});

test('a STALE pre-delete local copy is re-removed on publish (one stale checkout cannot undo a fleet delete)', async () => {
  // roborev HIGH: mere local presence is not proof of re-creation. A checkout holding a pre-delete copy
  // it never touched after the tombstone must NOT republish it as a "re-creation" on unrelated work.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/gone.md': 'g\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  const B = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/gone.md'))).toBe(true); // B has a stale copy

  // A deletes gone.md and publishes a tombstone (later than B's copy mtime).
  fs.rmSync(path.join(A, 'memory/gone.md'));
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);

  // B does UNRELATED work and publishes. gone.md is still present locally but was NEVER touched after
  // the tombstone → it must be re-removed, not republished.
  fs.writeFileSync(path.join(B, 'memory/other.md'), 'new\n');
  await runMemoryCommand(['publish', '--cwd', B, '--store', `file://${storeRoot}`, '--snapshot-id', 's3'], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/gone.md'))).toBe(false); // stale copy stripped locally

  // A fresh checkout confirms the deletion held fleet-wide.
  const C = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', C, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(C, 'memory/gone.md'))).toBe(false);
});

test('a genuinely RE-CREATED page (newer than the tombstone) survives publish', async () => {
  // The other side of the rule: a local copy strictly newer than the tombstone IS a real re-creation
  // and must be preserved + republished.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/gone.md': 'g\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  const B = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  fs.rmSync(path.join(A, 'memory/gone.md'));
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);

  // B re-creates gone.md with a clearly-later mtime, then publishes.
  fs.writeFileSync(path.join(B, 'memory/gone.md'), 'RECREATED\n');
  fs.utimesSync(path.join(B, 'memory/gone.md'), 4_000_000_000, 4_000_000_000); // far-future mtime
  await runMemoryCommand(['publish', '--cwd', B, '--store', `file://${storeRoot}`, '--snapshot-id', 's3'], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/gone.md'))).toBe(true); // genuine re-creation preserved

  const C = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', C, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.readFileSync(path.join(C, 'memory/gone.md'), 'utf8')).toBe('RECREATED\n'); // re-creation propagated
});

test('refresh --latest honors fleet deletions and does NOT resurrect a tombstoned page', async () => {
  // roborev Medium: --latest takes content from the single latest snapshot but must still strip
  // fleet-tombstoned pages, or it resurrects a deleted page and a later publish republishes it.
  const storeRoot = tempDir('ab-store-');
  // Single page so deleting it makes memory/ EMPTY -> a TOMBSTONE-ONLY publish that does NOT advance
  // latest.json. latest.json therefore still points at s1 (with gone.md), the exact case where a
  // deletion-naive --latest would resurrect it.
  const A = checkout('bootup', { 'memory/gone.md': 'g\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  fs.rmSync(path.join(A, 'memory/gone.md'));
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);

  // A fresh checkout refreshes with --latest: gone.md must NOT be materialized (deletion honored)
  // even though latest.json still lists it.
  const B = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--latest', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/gone.md'))).toBe(false); // not resurrected by --latest

  // And a subsequent publish from B does not republish gone.md.
  await runMemoryCommand(['publish', '--cwd', B, '--store', `file://${storeRoot}`, '--snapshot-id', 's3'], captureIo().io);
  const C = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', C, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(C, 'memory/gone.md'))).toBe(false); // stayed deleted fleet-wide
});

function storeHeadFiles(storeRoot: string, agentId = 'bootup'): string[] {
  const headsDir = path.join(storeRoot, agentId, 'heads');
  if (!fs.existsSync(headsDir)) return [];
  return fs.readdirSync(headsDir).filter((n) => n.endsWith('.json') && !n.startsWith('_latest_'));
}

test('machine-id flip (available -> unavailable) reuses ONE pinned head, no orphan tombstone', async () => {
  // roborev: a checkout must keep ONE publisher identity for life. If publishing with a real machine
  // id then later without one minted a SECOND (fallback) head, its orphaned tombstone would keep
  // winning the merge and a re-created page could stay falsely deleted. Pinning => exactly one head.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/temp.md': 't\n' });
  // First publish WITH a real machine id (pins the real id).
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io)).toBe(0);
  const headsAfterFirst = storeHeadFiles(storeRoot);
  expect(headsAfterFirst.length).toBe(1);

  // Now make getMachineId() fail and delete temp.md, then publish again.
  const idHome = tempDir('ab-mid-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const prevMidFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  try {
    fs.rmSync(path.join(A, 'memory/temp.md'));
    await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);
  } finally {
    if (prevMidFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMidFile;
  }

  // Still exactly ONE head (the pinned id was reused), and it carries the tombstone.
  const headsAfterFlip = storeHeadFiles(storeRoot);
  expect(headsAfterFlip.length).toBe(1);
  expect(headsAfterFlip[0]).toBe(headsAfterFirst[0]); // same head file — identity was pinned
  expect(storeTombstonePages(storeRoot).has('memory/temp.md')).toBe(true);
});

test('publish converges a deletion when the machine id goes down AFTER identity is pinned', async () => {
  // Once merge is the default, a publish MUST record a head or deletions never converge. A checkout
  // whose identity was already pinned (first publish with machine id available) keeps converging
  // deletions even after machine id later goes down — the pin holds its identity.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/temp.md': 't\n' });
  // First publish WITH machine id available → pins the identity.
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io)).toBe(0);
  const B = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/temp.md'))).toBe(true);

  // Now machine id goes DOWN. A deletes temp.md and re-publishes — the PIN keeps its identity, so the
  // deletion still records a tombstone against the same head and converges.
  const idHome = tempDir('ab-mid-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const prevMidFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  try {
    fs.rmSync(path.join(A, 'memory/temp.md'));
    await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io);
    expect(storeTombstonePages(storeRoot).has('memory/temp.md')).toBe(true);
    const r = captureIo();
    await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], r.io);
    expect(fs.existsSync(path.join(B, 'memory/temp.md'))).toBe(false); // deletion converged after machine-id outage
  } finally {
    if (prevMidFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMidFile;
  }
});

test('refresh --latest applies deletions even when the latest snapshot is manifest-less (storeReal preserved)', async () => {
  // roborev: a deletion-only --latest pass (empty latest.json + fleet tombstones) must not call
  // applyMergedSnapshot with an undefined store root and throw.
  const storeRoot = tempDir('ab-store-');
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  fs.mkdirSync(headsDir, { recursive: true });
  fs.writeFileSync(path.join(headsDir, 'tomb.json'), JSON.stringify({ version_id: 't', bundle_hash: null, machine_id: 'T', markers: {}, tombstones: { 'memory/p.md': 2_000_000_000_000 }, updated_at: '2033-01-01T00:00:00.000Z' }));
  const B = checkout('bootup', { 'memory/p.md': 'stale\n' });
  fs.utimesSync(path.join(B, 'memory/p.md'), 1000, 1000); // mtime well before the tombstone → stale

  const code = await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--latest', '--store', `file://${storeRoot}`], captureIo().io);
  expect(code).toBe(0); // did not throw on an undefined storeReal
  expect(fs.existsSync(path.join(B, 'memory/p.md'))).toBe(false); // deletion applied
});

test('normal refresh FAILS (not false-success) if the baseline cannot be persisted after materializing', async () => {
  // roborev: the regular refresh path must also surface a failed baseline write, like the bootstrap path.
  const storeRoot = tempDir('ab-store-');
  const X = checkout('bootup', { 'memory/shared.md': 'v1\n' });
  await runMemoryCommand(['publish', '--cwd', X, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  const B = checkout('bootup', {});
  fs.writeFileSync(path.join(B, '.brain'), 'x'); // .brain is a FILE → baseline write fails
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], r.io)).toBe(1);
  expect(r.err.join('\n')).toMatch(/could not be persisted|writability/i);
  expect(fs.existsSync(path.join(B, 'memory/shared.md'))).toBe(true); // page WAS materialized before the failure
});

test('refresh --latest tolerates a corrupt head when latest.json is VALID (escape hatch stays usable)', async () => {
  // roborev: --latest is the escape hatch for one coherent snapshot when per-head state is unhealthy.
  // With a valid latest.json, an unrelated corrupt head must NOT make it fail — it returns the latest
  // content. (The merge does not throw here since a valid content pointer exists, so no degrade.)
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/keep.md': 'k\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  fs.writeFileSync(path.join(storeRoot, 'bootup', 'heads', 'corrupt.json'), '{ corrupt head'); // unrelated bad head
  const B = checkout('bootup', {});
  expect(await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--latest', '--store', `file://${storeRoot}`], captureIo().io)).toBe(0);
  expect(fs.existsSync(path.join(B, 'memory/keep.md'))).toBe(true); // latest content materialized despite the bad head
});

test('refresh --latest FAILS (not false-empty) when heads are corrupt AND latest.json is absent', async () => {
  // roborev: a DEGRADED --latest that also has no latest.json has NOT proven the store empty — it must
  // not bootstrap an empty baseline (poisoning delete detection) or claim success.
  const storeRoot = tempDir('ab-store-');
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  fs.mkdirSync(headsDir, { recursive: true });
  fs.writeFileSync(path.join(headsDir, 'corrupt.json'), '{ corrupt head');
  const B = checkout('bootup', {});
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--latest', '--store', `file://${storeRoot}`], r.io)).toBe(1);
  expect(fs.existsSync(path.join(B, '.brain', 'memory-sync-baseline.json'))).toBe(false); // no empty baseline written
});

test('refresh --from-store surfaces corruption in a legacy latest.json-only store (exit != 0)', async () => {
  // roborev: the default merge path must not turn a corrupt latest.json-only store into a false-success
  // empty refresh.
  const storeRoot = tempDir('ab-store-');
  fs.mkdirSync(path.join(storeRoot, 'bootup'), { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'bootup', 'latest.json'), JSON.stringify({ bundle_hash: 'sha256:' + 'a'.repeat(64) }));
  const B = checkout('bootup', {});
  const r = captureIo();
  const code = await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], r.io);
  expect(code).not.toBe(0); // corruption surfaced, not "nothing published yet"
  expect(r.err.join('\n')).toMatch(/corrupt|not valid|failed/i);
});

test('a baseline from store A does not tombstone pages when publishing to a different store B', async () => {
  // roborev: the sync baseline is scoped to (store, agent). A page present only in store A must not be
  // read as a deletion when publishing to store B (which never had it).
  const storeA = tempDir('ab-storeA-');
  const storeB = tempDir('ab-storeB-');
  const X = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/onlyA.md': 'a\n' });
  await runMemoryCommand(['publish', '--cwd', X, '--store', `file://${storeA}`, '--snapshot-id', 's1'], captureIo().io);

  const B = checkout('bootup', {});
  await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeA}`], captureIo().io);
  expect(fs.existsSync(path.join(B, 'memory/onlyA.md'))).toBe(true); // baseline records onlyA.md for storeA

  // B deletes onlyA.md and publishes to a DIFFERENT store B. The storeA baseline must NOT tombstone it.
  fs.rmSync(path.join(B, 'memory/onlyA.md'));
  await runMemoryCommand(['publish', '--cwd', B, '--store', `file://${storeB}`, '--snapshot-id', 's2'], captureIo().io);
  expect(storeTombstonePages(storeB).has('memory/onlyA.md')).toBe(false); // storeA baseline ignored for storeB
});

test('a CORRUPT sync baseline does not bypass the fail-closed publish guard', async () => {
  // roborev: hasSyncBaseline must validate contents, not just existence — a truncated/garbage baseline
  // must not let a machine-id-down publish proceed with no usable prior state (stale-head resurrection).
  const storeRoot = tempDir('ab-store-');
  const idHome = tempDir('ab-mid-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const prevMidFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  try {
    const A = checkout('bootup', { 'memory/p.md': 'x\n' });
    fs.mkdirSync(path.join(A, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(A, '.brain', 'memory-sync-baseline.json'), '{ truncated garbage'); // corrupt
    const r = captureIo();
    expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], r.io)).toBe(1);
    expect(r.err.join('\n')).toMatch(/refused/i); // corrupt baseline did not satisfy the guard
  } finally {
    if (prevMidFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMidFile;
  }
});

test('publish with an EXISTING pin does not require .brain writability (pre-flight skipped)', async () => {
  // roborev: the pin pre-flight should only gate when a pin must be CREATED. With a pin already present,
  // commitPublisherPin is a no-op, so a read-only .brain/ must not block an otherwise-safe publish.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/p.md': 'v1\n' });
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io)).toBe(0);
  const brainDir = path.join(A, '.brain');
  fs.chmodSync(brainDir, 0o500); // read-only dir
  let brainWritable = true;
  try { fs.writeFileSync(path.join(brainDir, '.probe'), 'x'); fs.rmSync(path.join(brainDir, '.probe')); } catch { brainWritable = false; }
  try {
    if (!brainWritable) {
      // env where chmod actually blocks writes (non-root): publish must still succeed with a pin present.
      // Add a NEW page (no drift on the existing one) so reconcile does not conflict.
      fs.writeFileSync(path.join(A, 'memory/q.md'), 'new\n');
      expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io)).toBe(0);
    }
  } finally {
    fs.chmodSync(brainDir, 0o700);
  }
});

test('publish ABORTS if a fleet-deleted page cannot be removed locally (would resurrect it)', async () => {
  // roborev: removeLocalMemoryPages reports failures; publish must abort if a page that must stay
  // deleted is still on disk, or publishMemoryToStore re-includes it and its tombstone is suppressed.
  const storeRoot = tempDir('ab-store-');
  fs.mkdirSync(path.join(storeRoot, 'bootup', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'bootup', 'heads', 'tomb.json'), JSON.stringify({ version_id: 't', bundle_hash: null, machine_id: 'T', markers: {}, tombstones: { 'memory/gone.md': 2_000_000_000_000 }, updated_at: '2033-01-01T00:00:00.000Z' }));
  // B's memory/ is a symlink to an external dir holding a stale copy of gone.md — removal is refused.
  const external = tempDir('ab-ext-');
  fs.writeFileSync(path.join(external, 'gone.md'), 'stale\n');
  fs.utimesSync(path.join(external, 'gone.md'), 1000, 1000);
  const B = tempDir('ab-symB-');
  fs.writeFileSync(path.join(B, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  fs.writeFileSync(path.join(B, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  fs.symlinkSync(external, path.join(B, 'memory'));

  const r = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', B, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], r.io)).toBe(1);
  expect(r.err.join('\n')).toMatch(/memory root is a symlink|could not remove page/i);
  expect(fs.existsSync(path.join(external, 'gone.md'))).toBe(true); // not deleted through the symlink
});

test('a corrupt publisher head fails publish BEFORE reconcile mutates memory/', async () => {
  // roborev HIGH: getPublisherHeadPageSet and writePublisherHead must agree. A corrupt head must fail
  // publish up front, not be silently read as empty (letting reconcile restore a deleted page and
  // mis-detect deletions) only to hard-fail later with memory/ already mutated.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/keep.md': 'k\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  // Corrupt A's own publisher head, and remove the baseline so the head is the ONLY prior-state source
  // (otherwise the baseline detects the deletion independently and masks the corrupt-head bug).
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const headName = fs.readdirSync(headsDir).find((n) => n.endsWith('.json') && !n.startsWith('_latest_'))!;
  fs.writeFileSync(path.join(headsDir, headName), '{ corrupt head');
  fs.rmSync(path.join(A, '.brain', 'memory-sync-baseline.json'), { force: true });

  // A deletes keep.md and publishes — must FAIL before reconcile restores it.
  fs.rmSync(path.join(A, 'memory/keep.md'));
  const r = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], r.io)).toBe(1);
  expect(r.err.join('\n')).toMatch(/corrupt|unreadable/i);
  expect(fs.existsSync(path.join(A, 'memory/keep.md'))).toBe(false); // reconcile did NOT run/mutate memory/
});

test('publish refuses BEFORE mutating the store when the pin cannot be persisted (.brain not writable)', async () => {
  // roborev: pre-flight the pin so a publish either writes BOTH the store head and the local pin, or
  // neither. .brain/ unwritable => refuse before any store mutation (no orphaned head).
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/p.md': 'x\n' });
  fs.writeFileSync(path.join(A, '.brain'), 'x'); // .brain is a FILE → pin cannot be persisted
  const r = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], r.io)).toBe(1);
  expect(r.err.join('\n')).toMatch(/not writable|persist|pin/i);
  expect(fs.existsSync(path.join(storeRoot, 'bootup', 'latest.json'))).toBe(false); // store NOT mutated
  expect(fs.existsSync(path.join(storeRoot, 'bootup', 'heads'))).toBe(false);
});

test('a publish that fails the pin pre-flight does NOT mutate local memory/ (reconcile deferred)', async () => {
  // roborev: the destructive reconcile/removeLocalMemoryPages must run only after the fail-fast
  // preconditions pass. A pin-writability failure must leave the local checkout untouched.
  const storeRoot = tempDir('ab-store-');
  const X = checkout('bootup', { 'memory/shared.md': 'v1\n' });
  await runMemoryCommand(['publish', '--cwd', X, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);

  const A = checkout('bootup', { 'memory/local.md': 'a\n' }); // A is missing shared.md; reconcile WOULD gap-fill it
  fs.writeFileSync(path.join(A, '.brain'), 'x'); // .brain is a FILE → pin pre-flight fails
  const r = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], r.io)).toBe(1);
  expect(fs.existsSync(path.join(A, 'memory/shared.md'))).toBe(false); // reconcile did NOT run — no local mutation
});

test('empty-store bootstrap refresh FAILS (not false-success) if the baseline cannot be persisted', async () => {
  // roborev: the bootstrap depends on the baseline persisting to unblock a later publish. A swallowed
  // write error must not let refresh claim success while the next publish is silently refused.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', {});
  fs.writeFileSync(path.join(A, '.brain'), 'x'); // .brain is a FILE → baseline write fails
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', A, '--from-store', '--store', `file://${storeRoot}`], r.io)).toBe(1);
  expect(r.err.join('\n')).toMatch(/could not persist the sync baseline|writability/i);
});

test('a publish that exits on reconcile drift does NOT create a pin (no later orphan)', async () => {
  // roborev: the pin is committed only when the publish completes (inside publishMemoryToStore, after
  // the store write). A drift exit (return 3) happens BEFORE that, so no pin is created.
  const storeRoot = tempDir('ab-store-');
  const X = checkout('bootup', { 'memory/shared.md': 'v1\n' });
  await runMemoryCommand(['publish', '--cwd', X, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);

  // A is a FRESH checkout (machine-id available → passes the guard) with a LOCAL shared.md that conflicts
  // with the store copy — reconcile detects drift and publish exits 3 before publishMemoryToStore.
  const A = checkout('bootup', { 'memory/shared.md': 'LOCAL DRIFT\n' });
  const r = captureIo();
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], r.io)).toBe(3);
  expect(fs.existsSync(path.join(A, '.brain', 'publisher-id.json'))).toBe(false); // no pin created on abort
});

test('a store outage refuses without pinning; guard fires before any pin (no later orphan)', async () => {
  // roborev: neither a transient store outage nor a machine-id outage may persist a pin for a checkout
  // with no prior identity. With machine-id down and no pin, the fail-closed guard refuses up front —
  // before the reachability check — and nothing is pinned.
  const unreachableParent = tempDir('ab-nostore-');
  const unreachable = path.join(unreachableParent, 'gone'); // nonexistent store root
  const idHome = tempDir('ab-mid-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const prevMidFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  try {
    const A = checkout('bootup', { 'memory/p.md': 'x\n' });
    const r = captureIo();
    expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${unreachable}`, '--snapshot-id', 's1'], r.io)).toBe(1);
    expect(r.err.join('\n')).toMatch(/refused/i);
    expect(fs.existsSync(path.join(A, '.brain', 'publisher-id.json'))).toBe(false); // nothing pinned
  } finally {
    if (prevMidFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMidFile;
  }
});

test('refresh does NOT abort on a corrupt publisher-id pin (backfill is best-effort; refresh is recovery)', async () => {
  // roborev: refresh is the recovery step run before retrying publish and does not need a valid pin.
  // A corrupt .brain/publisher-id.json must not block refresh — the pin backfill is caught and logged.
  const storeRoot = tempDir('ab-store-');
  const A = checkout('bootup', { 'memory/p.md': 'v1\n' });
  await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io);
  const B = checkout('bootup', {});
  fs.mkdirSync(path.join(B, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(B, '.brain', 'publisher-id.json'), '{ corrupt'); // corrupt pin
  const r = captureIo();
  expect(await runMemoryCommand(['refresh', '--cwd', B, '--from-store', '--store', `file://${storeRoot}`], r.io)).toBe(0);
  expect(fs.existsSync(path.join(B, 'memory/p.md'))).toBe(true); // refresh succeeded despite the corrupt pin
  expect(r.err.join('\n')).toMatch(/pin backfill skipped/i); // failure surfaced, not silently swallowed
});

test('an empty store can be bootstrapped during a machine-id outage (refresh writes baseline, then publish)', async () => {
  // roborev: the fail-closed guard must not block bootstrapping a brand-new store during a machine-id
  // outage — an empty store has no prior state to protect. An empty-store refresh writes an (empty)
  // baseline, which unblocks the first publish.
  const storeRoot = tempDir('ab-store-');
  const idHome = tempDir('ab-mid-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const prevMidFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  try {
    const A = checkout('bootup', { 'memory/p.md': 'x\n' });
    await runMemoryCommand(['refresh', '--cwd', A, '--from-store', '--store', `file://${storeRoot}`], captureIo().io);
    expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], captureIo().io)).toBe(0);
  } finally {
    if (prevMidFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMidFile;
  }
});

test('publish fails closed when machine id is unavailable AND there is no pin or baseline', async () => {
  // roborev HIGH: a pre-upgrade checkout publishing while machine-id is down would look at the wrong
  // (fallback) head, miss a deletion, and let a stale head resurrect the page. Since a fresh vs
  // pre-upgrade checkout is indistinguishable without the real id, refuse rather than silently miss.
  const storeRoot = tempDir('ab-store-');
  const idHome = tempDir('ab-mid-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const prevMidFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  const A = checkout('bootup', { 'memory/p.md': 'x\n' });
  try {
    const r = captureIo();
    expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], r.io)).toBe(1);
    expect(r.err.join('\n')).toMatch(/refused/i);
  } finally {
    if (prevMidFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMidFile;
  }
  // Recovery: with machine id restored, the same publish now succeeds (identity is available).
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', `file://${storeRoot}`, '--snapshot-id', 's2'], captureIo().io)).toBe(0);
});

test('publish surfaces a corrupt publisher pin when machine id is unavailable', async () => {
  const storeRoot = tempDir('ab-publish-corrupt-pin-store-');
  const a = checkout('bootup', { 'memory/p.md': 'x\n' });
  fs.mkdirSync(path.join(a, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(a, '.brain', 'publisher-id.json'), '{ corrupt');
  const idHome = tempDir('ab-publish-corrupt-pin-id-');
  const blocker = path.join(idHome, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const previousMachineIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(blocker, 'machine-id');
  try {
    const publish = captureIo();
    expect(await runMemoryCommand(['publish', '--cwd', a, '--store', `file://${storeRoot}`, '--snapshot-id', 's1'], publish.io)).toBe(1);
    expect(publish.err.join('\n')).toMatch(/pinned publisher id is unreadable\/corrupt/i);
  } finally {
    if (previousMachineIdFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = previousMachineIdFile;
  }
});
