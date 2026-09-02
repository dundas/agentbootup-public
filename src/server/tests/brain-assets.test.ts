import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  handleBrainAssetCapabilities,
  handleDeleteSecretAssets,
  handlePushBrainAssets,
  handlePullBrainAssets,
} from '../routes/brain-assets';
import { BrainAssetStore } from '../lib/brain-asset-store';
import {
  ASSET_CONTRACT_VERSION,
  ASSET_TYPES,
  SECRET_REL_PATHS,
} from '../../../lib/brain/asset-contract.js';
import { DEFAULT_BRAIN_BRANCH_ID } from '../lib/brain-branch-store';
import { HttpError, jsonError } from '../errors';
import type { Brain, BrainBranch } from '../types';

/**
 * Mirrors the server.ts try/catch: converts HttpError thrown by a handler
 * into the expected JSON error response, so tests can assert on res.status.
 */
async function call(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonError(err.status, err.code, err.message);
    }
    throw err;
  }
}

// ── Mock BrainStore ──────────────────────────────────────────────────────────

class MockBrainStore {
  private brains = new Map<string, Brain>();

  seed(brain: Brain): void {
    this.brains.set(brain.id, brain);
  }

  async get(id: string): Promise<Brain | null> {
    return this.brains.get(id) ?? null;
  }

  async updateSyncInfo(_id: string, _machineInfo: Record<string, unknown> | undefined, _machineId?: string): Promise<void> {
    // no-op in tests
  }
}

class MockBranchStore {
  branches = new Map<string, BrainBranch>();
  updates: Array<{ brainId: string; branchId: string; update: Record<string, unknown> }> = [];

  seed(branch: BrainBranch): void {
    this.branches.set(`${branch.brain_id}:${branch.branch_id}`, branch);
  }

  async get(brainId: string, branchId: string): Promise<BrainBranch | null> {
    return this.branches.get(`${brainId}:${branchId}`) ?? null;
  }

  async updateSnapshotMetadata(brainId: string, branchId: string, update: Record<string, unknown>): Promise<BrainBranch> {
    this.updates.push({ brainId, branchId, update });
    const branch = this.branches.get(`${brainId}:${branchId}`);
    if (!branch) {
      throw new Error(`missing branch seed for ${brainId}:${branchId}`);
    }
    return branch;
  }
}

// ── Mock MechClient ──────────────────────────────────────────────────────────

class MockMechClient {
  public docs: Map<string, { id: string; collection: string; document: Record<string, unknown> }> = new Map();
  public listCalls = 0;
  public getCalls = 0;
  public blobReadCalls = 0;
  public blobText = '';
  public getDocumentOverride: ((docId: string) => Record<string, unknown> | null) | null = null;
  private nextId = 1;

  async listDocuments(collection: string): Promise<Array<{ id: string; document_id: string; document: Record<string, unknown> }>> {
    this.listCalls += 1;
    return Array.from(this.docs.values()).filter((d) => d.collection === collection).map((d) => ({
      id: d.id,
      document_id: d.id,
      document: d.document,
    }));
  }

  async getDocument(docId: string): Promise<{ id: string; document_id: string; document: Record<string, unknown> } | null> {
    this.getCalls += 1;
    const entry = this.docs.get(docId);
    if (!entry) return null;
    const document = this.getDocumentOverride?.(docId) ?? entry.document;
    return { id: entry.id, document_id: entry.id, document };
  }

  async readBlobRefText(_value: unknown, _maxBytes: number): Promise<string> {
    this.blobReadCalls += 1;
    return this.blobText;
  }

  async createDocument(collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, collection, document: data });
    return id;
  }

  async updateDocument(docId: string, collection: string, data: Record<string, unknown>): Promise<void> {
    this.docs.set(docId, { id: docId, collection, document: data });
  }

  async deleteDocument(docId: string): Promise<void> {
    this.docs.delete(docId);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SAMPLE_BRAIN: Brain = {
  id: 'test-brain',
  repo_url: 'https://github.com/dundas/test.git',
  repo_branch: 'main',
  vault_namespace: '',
  skills: [],
  memory_collection: 'agent_memory_test_brain',
  parent_brain: null,
  trust_level: 'full',
  metadata: {},
  registered_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function makeFileEntry(overrides: Partial<{
  path: string;
  content_base64: string;
  asset_type: string;
  cli: string;
}> = {}): Record<string, unknown> {
  return {
    path: '.claude/skills/my-skill/SKILL.md',
    content_base64: b64('# My Skill'),
    asset_type: 'skill',
    cli: 'claude',
    ...overrides,
  };
}

function postRequest(brainId: string, body: unknown): Request {
  return new Request(`http://localhost/v1/brain-assets/${brainId}/push`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function getRequest(brainId: string, params: string = ''): Request {
  return new Request(`http://localhost/v1/brain-assets/${brainId}${params ? `?${params}` : ''}`, {
    method: 'GET',
  });
}

async function parseBody<T>(res: Response): Promise<{ data: T }> {
  return res.json() as Promise<{ data: T }>;
}

// ── Tests: handlePushBrainAssets ─────────────────────────────────────────────

describe('handlePushBrainAssets', () => {
  let brainStore: MockBrainStore;
  let assetStore: BrainAssetStore;
  let mechClient: MockMechClient;

  beforeEach(() => {
    brainStore = new MockBrainStore();
    mechClient = new MockMechClient();
    assetStore = new BrainAssetStore(mechClient as never);
    brainStore.seed(SAMPLE_BRAIN);
  });

  test('push single file returns 200 with pushed=1', async () => {
    const req = postRequest('test-brain', { files: [makeFileEntry()] });
    const res = await handlePushBrainAssets('test-brain', req, brainStore as never, assetStore);
    expect(res.status).toBe(200);
    const body = await parseBody<{ pushed: number; updated: number; errors: number; results: unknown[] }>(res);
    expect(body.data.pushed).toBe(1);
    expect(body.data.updated).toBe(0);
    expect(body.data.errors).toBe(0);
    expect(body.data.results).toHaveLength(1);
  });

  test('push multiple files returns all results', async () => {
    const req = postRequest('test-brain', {
      files: [
        makeFileEntry({ path: '.claude/skills/a/SKILL.md', asset_type: 'skill' }),
        makeFileEntry({ path: '.claude/agents/b.md', asset_type: 'agent' }),
        makeFileEntry({ path: 'memory/MEMORY.md', asset_type: 'memory', cli: 'shared' }),
      ],
    });
    const res = await handlePushBrainAssets('test-brain', req, brainStore as never, assetStore);
    expect(res.status).toBe(200);
    const body = await parseBody<{ pushed: number }>(res);
    expect(body.data.pushed).toBe(3);
  });

  test('exact pulls reuse the path-to-document-id index instead of rescanning the collection', async () => {
    const push = await assetStore.push('test-brain', [
      { path: 'memory/a.md', content: b64('a'), asset_type: 'memory', cli: 'shared' },
      { path: 'memory/b.md', content: b64('b'), asset_type: 'memory', cli: 'shared' },
    ]);
    expect(push.errors).toBe(0);
    expect(mechClient.docs.size).toBe(2);
    expect(mechClient.listCalls).toBe(1);
    expect(await assetStore.pullExact('test-brain', 'memory/a.md')).not.toBeNull();

    const first = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain', `path=${encodeURIComponent('memory/a.md')}`),
      brainStore as never,
      assetStore,
    );
    const second = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain', `path=${encodeURIComponent('memory/b.md')}`),
      brainStore as never,
      assetStore,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mechClient.listCalls).toBe(1);
    expect(mechClient.getCalls).toBe(3);
  });

  test('concurrent cold exact pulls coalesce the one index-building collection scan', async () => {
    await assetStore.push('test-brain', [
      { path: 'memory/a.md', content: b64('a'), asset_type: 'memory', cli: 'shared' },
      { path: 'memory/b.md', content: b64('b'), asset_type: 'memory', cli: 'shared' },
    ]);
    assetStore = new BrainAssetStore(mechClient as never);
    mechClient.listCalls = 0;
    mechClient.getCalls = 0;

    const [first, second] = await Promise.all([
      assetStore.pullExact('test-brain', 'memory/a.md'),
      assetStore.pullExact('test-brain', 'memory/b.md'),
    ]);

    expect(first?.path).toBe('memory/a.md');
    expect(second?.path).toBe('memory/b.md');
    expect(mechClient.listCalls).toBe(1);
    expect(mechClient.getCalls).toBe(0);
    expect((await assetStore.pullExact('test-brain', 'memory/a.md'))?.path).toBe('memory/a.md');
    expect(mechClient.listCalls).toBe(1);
    expect(mechClient.getCalls).toBe(1);
  });

  test('exact pulls hydrate and verify non-inline GET-by-id content without rescanning', async () => {
    await assetStore.push('test-brain', [
      { path: 'memory/large.md', content: b64('large'), asset_type: 'memory', cli: 'shared' },
    ]);
    mechClient.listCalls = 0;
    mechClient.getCalls = 0;
    mechClient.blobText = b64('large');
    mechClient.getDocumentOverride = () => ({
      ...mechClient.docs.values().next().value?.document,
      content: { __type: 'blob_ref' },
    });

    const pulled = await assetStore.pullExact('test-brain', 'memory/large.md');

    expect(pulled?.content).toBe(b64('large'));
    expect(mechClient.getCalls).toBe(1);
    expect(mechClient.blobReadCalls).toBe(1);
    expect(mechClient.listCalls).toBe(0);
  });

  test('exact pulls reject hydrated content that does not match stored integrity metadata', async () => {
    await assetStore.push('test-brain', [
      { path: 'memory/large.md', content: b64('large'), asset_type: 'memory', cli: 'shared' },
    ]);
    mechClient.blobText = b64('tampered');
    mechClient.getDocumentOverride = () => ({
      ...mechClient.docs.values().next().value?.document,
      content: { __type: 'blob_ref' },
    });

    await expect(assetStore.pullExact('test-brain', 'memory/large.md')).rejects.toThrow(
      'brain asset storage integrity check failed for exact path memory/large.md',
    );
  });

  test('large assets use self-describing chunks and round-trip through exact pull', async () => {
    const content = b64('x'.repeat(13 * 1024)); // exceeds the 16 KiB base64 chunk threshold
    await assetStore.push('test-brain', [
      { path: 'memory/large.md', content, asset_type: 'memory', cli: 'shared' },
    ]);
    const stored = mechClient.docs.values().next().value?.document as Record<string, unknown>;
    expect(stored.content).toBe('');
    expect(stored.content_encoding).toBe('base64-chunked-v1');
    expect(Array.isArray(stored.content_chunks)).toBe(true);
    expect(stored.content_chunk_count).toBe((stored.content_chunks as unknown[]).length);
    expect((await assetStore.pullExact('test-brain', 'memory/large.md'))?.content).toBe(content);
  });

  test('exact pulls fail closed when a self-describing chunk count is malformed', async () => {
    const content = b64('x'.repeat(13 * 1024));
    await assetStore.push('test-brain', [
      { path: 'memory/large.md', content, asset_type: 'memory', cli: 'shared' },
    ]);
    mechClient.getDocumentOverride = () => ({
      ...mechClient.docs.values().next().value?.document,
      content_chunk_count: 999,
    });
    await expect(assetStore.pullExact('test-brain', 'memory/large.md')).rejects.toThrow(
      'brain asset storage returned invalid content chunk count for exact path memory/large.md',
    );
  });

  test('path indexes evict least-recently-used collections at the configured bound', async () => {
    const envName = 'AGENTBOOTUP_BRAIN_ASSET_PATH_INDEX_MAX_COLLECTIONS';
    const saved = process.env[envName];
    process.env[envName] = '1';
    try {
      await assetStore.push('brain-a', [
        { path: 'memory/a.md', content: b64('a'), asset_type: 'memory', cli: 'shared' },
      ]);
      await assetStore.push('brain-b', [
        { path: 'memory/b.md', content: b64('b'), asset_type: 'memory', cli: 'shared' },
      ]);
      expect(mechClient.listCalls).toBe(2);

      expect((await assetStore.pullExact('brain-a', 'memory/a.md'))?.path).toBe('memory/a.md');
      expect(mechClient.listCalls).toBe(3);
    } finally {
      if (saved === undefined) delete process.env[envName];
      else process.env[envName] = saved;
    }
  });

  test('missing brain returns 404', async () => {
    const req = postRequest('no-such-brain', { files: [makeFileEntry()] });
    const res = await call(() => handlePushBrainAssets('no-such-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(404);
  });

  test('missing files field returns 400', async () => {
    const req = postRequest('test-brain', {});
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('empty files array returns 400', async () => {
    const req = postRequest('test-brain', { files: [] });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('rejects path traversal (../) in file path', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ path: '../evil/path.md' })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('rejects path traversal with Windows separators (..\\)', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ path: '..\\evil\\path.md' })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('normalizes Windows separators to forward slashes on storage', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ path: 'memory\\daily\\note.md' })],
    });
    const res = await handlePushBrainAssets('test-brain', req, brainStore as never, assetStore);
    expect(res.status).toBe(200);

    const pullRes = await handlePullBrainAssets('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    const body = await parseBody<{ files: Array<{ path: string }> }>(pullRes);
    expect(body.data.files[0].path).toBe('memory/daily/note.md');
  });

  test('rejects absolute path (leading /) in file path', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ path: '/etc/passwd' })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('rejects path exceeding 500 chars', async () => {
    const longPath = 'a'.repeat(501);
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ path: longPath })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('rejects oversized content (> 4MB decoded)', async () => {
    const bigBuf = Buffer.alloc(4 * 1024 * 1024 + 1, 0);
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ content_base64: bigBuf.toString('base64') })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('rejects invalid asset_type', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ asset_type: 'invalid-type' })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('rejects invalid cli', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ cli: 'neovim' })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('accepts all valid asset_types', async () => {
    const validTypes = ASSET_TYPES;
    for (const assetType of validTypes) {
      const assetPath = assetType === 'secret' ? '.env' : `test/${assetType}.md`;
      const req = postRequest('test-brain', {
        files: [makeFileEntry({
          path: assetPath,
          asset_type: assetType,
          ...(assetType === 'secret' && { cli: 'shared' }),
        })],
      });
      const res = await handlePushBrainAssets('test-brain', req, brainStore as never, assetStore);
      expect(res.status).toBe(200);
    }
  });

  test('rejects secret assets on non-default branches', async () => {
    const req = postRequest('test-brain', {
      branch_id: 'tenant-acme',
      files: [makeFileEntry({ path: '.env', asset_type: 'secret', cli: 'shared' })],
      ttl_seconds: 300,
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
    expect(mechClient.docs.size).toBe(0);
  });

  test('accepts all valid clis', async () => {
    const validClis = ['claude', 'gemini', 'codex', 'cursor', 'shared'];
    for (const cli of validClis) {
      const req = postRequest('test-brain', {
        files: [makeFileEntry({ path: `test/${cli}.md`, cli })],
      });
      const res = await handlePushBrainAssets('test-brain', req, brainStore as never, assetStore);
      expect(res.status).toBe(200);
    }
  });

  test('text content round-trips correctly via base64', async () => {
    const originalContent = '# Hello World\n\nContent here.';
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ content_base64: b64(originalContent) })],
    });
    await handlePushBrainAssets('test-brain', req, brainStore as never, assetStore);

    // Pull back and verify content_base64 round-trips correctly
    const pullRes = await handlePullBrainAssets('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    const body = await parseBody<{ files: Array<{ content_base64: string }> }>(pullRes);
    const decoded = Buffer.from(body.data.files[0].content_base64, 'base64').toString('utf8');
    expect(decoded).toBe(originalContent);
  });

  test('binary content round-trips without corruption', async () => {
    // Buffer with non-UTF-8 byte sequences that would be corrupted by UTF-8 decode/re-encode
    const binaryContent = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x82, 0x00, 0x01]);
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ content_base64: binaryContent.toString('base64') })],
    });
    await handlePushBrainAssets('test-brain', req, brainStore as never, assetStore);

    const pullRes = await handlePullBrainAssets('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    const body = await parseBody<{ files: Array<{ content_base64: string; size: number }> }>(pullRes);
    const roundTripped = Buffer.from(body.data.files[0].content_base64, 'base64');
    expect(roundTripped).toEqual(binaryContent);
    expect(body.data.files[0].size).toBe(binaryContent.byteLength);
  });

  test('all three secret sources round-trip exact bytes', async () => {
    const fixtures = new Map([
      ['.env', Buffer.from([0x41, 0x3d, 0x00, 0xff, 0x0a])],
      ['.dev.vars', Buffer.from([0xef, 0xbb, 0xbf, 0x42, 0x3d, 0x31, 0x0d, 0x0a])],
      ['brain/config.secret.json', Buffer.from('{"fixture":"value"}\r\n', 'utf8')],
    ]);
    const req = postRequest('test-brain', {
      files: [...fixtures].map(([path, bytes]) => makeFileEntry({
        path,
        content_base64: bytes.toString('base64'),
        asset_type: 'secret',
        cli: 'shared',
      })),
      ttl_seconds: 300,
    });

    const pushed = await handlePushBrainAssets('test-brain', req, brainStore as never, assetStore);
    expect(pushed.status).toBe(200);
    const pulled = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain', 'asset_type=secret'),
      brainStore as never,
      assetStore,
    );
    const body = await parseBody<{
      files: Array<{ path: string; content_base64: string; asset_type: string }>;
    }>(pulled);
    expect(body.data.files).toHaveLength(3);
    for (const file of body.data.files) {
      expect(file.asset_type).toBe('secret');
      expect(Buffer.from(file.content_base64, 'base64')).toEqual(fixtures.get(file.path));
    }
  });

  test('generic pull never returns secret payloads', async () => {
    await handlePushBrainAssets(
      'test-brain',
      postRequest('test-brain', {
        files: [makeFileEntry({
          path: 'brain/config.json',
          asset_type: 'config',
          cli: 'shared',
        })],
      }),
      brainStore as never,
      assetStore,
    );
    await handlePushBrainAssets(
      'test-brain',
      postRequest('test-brain', {
        files: [makeFileEntry({
          path: '.env',
          content_base64: b64('fixture-secret'),
          asset_type: 'secret',
          cli: 'shared',
        })],
      }),
      brainStore as never,
      assetStore,
    );

    const response = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain'),
      brainStore as never,
      assetStore,
    );
    const body = await parseBody<{
      files: Array<{ path: string; asset_type: string; content_base64: string }>;
    }>(response);
    expect(body.data.files.map((file) => file.path)).toEqual(['brain/config.json']);
    expect(JSON.stringify(body)).not.toContain(b64('fixture-secret'));
  });

  test('rejects a secret path disguised as config', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ path: '.env', asset_type: 'config', cli: 'shared' })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('rejects host/device credential paths before any brain-asset write', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ path: '.agenthost/host.key', asset_type: 'config', cli: 'shared' })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('host_credential_not_portable');
    expect(mechClient.docs.size).toBe(0);
  });

  test('rejects secret assets outside the explicit allowlist', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ path: 'config/private.txt', asset_type: 'secret', cli: 'shared' })],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('rejects mixed secret and non-secret batches', async () => {
    const req = postRequest('test-brain', {
      files: [
        makeFileEntry({ path: '.env', asset_type: 'secret', cli: 'shared' }),
        makeFileEntry({ path: 'brain/config.json', asset_type: 'config', cli: 'shared' }),
      ],
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('rejects duplicate secret paths before storage mutation', async () => {
    const req = postRequest('test-brain', {
      files: [
        makeFileEntry({ path: '.env', asset_type: 'secret', cli: 'shared' }),
        makeFileEntry({ path: '.env', asset_type: 'secret', cli: 'shared' }),
      ],
    });
    const res = await call(() => handlePushBrainAssets(
      'test-brain',
      req,
      brainStore as never,
      assetStore,
    ));
    expect(res.status).toBe(400);
    expect(mechClient.docs.size).toBe(0);
  });

  test('validates secret TTL and stores an expiry without exposing content', async () => {
    const before = Date.now();
    const req = postRequest('test-brain', {
      files: [makeFileEntry({ path: '.env', asset_type: 'secret', cli: 'shared' })],
      ttl_seconds: 300,
    });
    const res = await handlePushBrainAssets('test-brain', req, brainStore as never, assetStore);
    expect(res.status).toBe(200);
    const [stored] = [...mechClient.docs.values()];
    const expiresAt = stored.document.expires_at;
    expect(typeof expiresAt).toBe('string');
    expect(Date.parse(expiresAt as string)).toBeGreaterThanOrEqual(before + 299_000);
    expect(JSON.stringify(await parseBody(res))).not.toContain(b64('# My Skill'));

    for (const ttl of [null, 59, 2_592_001, 3.5, '300']) {
      const rejected = await call(() => handlePushBrainAssets(
        'test-brain',
        postRequest('test-brain', {
          files: [makeFileEntry({ path: '.env', asset_type: 'secret', cli: 'shared' })],
          ttl_seconds: ttl,
        }),
        brainStore as never,
        assetStore,
      ));
      expect(rejected.status).toBe(400);
    }
  });

  test('rejects ttl_seconds for non-secret assets', async () => {
    const req = postRequest('test-brain', {
      files: [makeFileEntry()],
      ttl_seconds: 300,
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });

  test('expired, malformed, or noncanonical-expiry secrets fail closed on pull', async () => {
    const push = postRequest('test-brain', {
      files: [makeFileEntry({ path: '.env', asset_type: 'secret', cli: 'shared' })],
      ttl_seconds: 300,
    });
    await handlePushBrainAssets('test-brain', push, brainStore as never, assetStore);
    const [stored] = [...mechClient.docs.values()];

    stored.document.expires_at = new Date(Date.now() - 1_000).toISOString();
    let response = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain', 'asset_type=secret'),
      brainStore as never,
      assetStore,
    );
    let body = await parseBody<{ files: unknown[] }>(response);
    expect(body.data.files).toEqual([]);

    stored.document.expires_at = 'not-an-iso-date';
    response = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain', 'asset_type=secret'),
      brainStore as never,
      assetStore,
    );
    body = await parseBody<{ files: unknown[] }>(response);
    expect(body.data.files).toEqual([]);

    stored.document.expires_at = '2099-01-01T00:00:00Z';
    response = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain', 'asset_type=secret'),
      brainStore as never,
      assetStore,
    );
    body = await parseBody<{ files: unknown[] }>(response);
    expect(body.data.files).toEqual([]);
  });

  test('rejects more than 500 files per push', async () => {
    const files = Array.from({ length: 501 }, (_, i) =>
      makeFileEntry({ path: `.claude/skills/skill-${i}/SKILL.md` }),
    );
    const req = postRequest('test-brain', { files });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
    const body = await parseBody<{ error: { message: string } }>(res);
    expect(body.error.message).toContain('500');
  });

  test('missing body returns 400', async () => {
    const req = new Request('http://localhost/v1/brain-assets/test-brain/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const res = await call(() => handlePushBrainAssets('test-brain', req, brainStore as never, assetStore));
    expect(res.status).toBe(400);
  });
});

describe('handleBrainAssetCapabilities', () => {
  test('advertises the shared secret contract without reading or writing assets', async () => {
    const brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    const response = await handleBrainAssetCapabilities('test-brain', brainStore as never);
    const body = await parseBody<{
      contract_version: number;
      asset_types: readonly string[];
      secret: {
        supported: boolean;
        paths: readonly string[];
        manual_only: boolean;
        retention: { without_ttl: string };
        authorization: { principal: string };
        logging: { payload_logged: boolean };
        restore: { explicit_pull_only: boolean };
      };
    }>(response);

    expect(body.data.contract_version).toBe(ASSET_CONTRACT_VERSION);
    expect(body.data.asset_types).toEqual(ASSET_TYPES);
    expect(body.data.secret.supported).toBe(true);
    expect(body.data.secret.paths).toEqual(SECRET_REL_PATHS);
    expect(body.data.secret.manual_only).toBe(true);
    expect(body.data.secret.retention.without_ttl).toBe('until_overwritten');
    expect(body.data.secret.authorization.principal).toBe('admin');
    expect(body.data.secret.logging.payload_logged).toBe(false);
    expect(body.data.secret.restore.explicit_pull_only).toBe(true);
  });

  test('fails closed for an unknown brain', async () => {
    const response = await call(() => handleBrainAssetCapabilities(
      'missing-brain',
      new MockBrainStore() as never,
    ));
    expect(response.status).toBe(404);
  });
});

describe('handleDeleteSecretAssets', () => {
  test('removes every committed and staged secret record for a disposable brain', async () => {
    const brainStore = new MockBrainStore();
    const mechClient = new MockMechClient();
    const assetStore = new BrainAssetStore(mechClient as never);
    brainStore.seed(SAMPLE_BRAIN);
    await handlePushBrainAssets(
      'test-brain',
      postRequest('test-brain', {
        files: SECRET_REL_PATHS.map((secretPath) => makeFileEntry({
          path: secretPath,
          asset_type: 'secret',
          cli: 'shared',
        })),
        ttl_seconds: 60,
      }),
      brainStore as never,
      assetStore,
    );
    const response = await handleDeleteSecretAssets(
      'test-brain',
      new Request('http://localhost/v1/brain-assets/test-brain?asset_type=secret&confirm_brain_id=test-brain', {
        method: 'DELETE',
      }),
      brainStore as never,
      assetStore,
    );
    expect(response.status).toBe(200);
    expect(mechClient.docs.size).toBe(0);
  });

  test('requires the exact secret cleanup query', async () => {
    const brainStore = new MockBrainStore();
    const assetStore = new BrainAssetStore(new MockMechClient() as never);
    brainStore.seed(SAMPLE_BRAIN);
    const response = await call(() => handleDeleteSecretAssets(
      'test-brain',
      new Request('http://localhost/v1/brain-assets/test-brain', { method: 'DELETE' }),
      brainStore as never,
      assetStore,
    ));
    expect(response.status).toBe(400);
  });

  test.each([
    ['missing', 'asset_type=secret'],
    ['mismatched typo', 'asset_type=secret&confirm_brain_id=test-brian'],
  ])('rejects %s brain confirmation before storage cleanup', async (_case, query) => {
    const brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    let cleanupCalls = 0;
    const assetStore = {
      async deleteSecretAssets() {
        cleanupCalls += 1;
        return { deleted: 1, errors: 0, remaining: 0, verified_absent: true };
      },
    };

    const response = await call(() => handleDeleteSecretAssets(
      'test-brain',
      new Request(`http://localhost/v1/brain-assets/test-brain?${query}`, {
        method: 'DELETE',
      }),
      brainStore as never,
      assetStore as never,
    ));

    expect(response.status).toBe(400);
    expect(cleanupCalls).toBe(0);
  });

  test('fails when cleanup finds no secret records to delete', async () => {
    const brainStore = new MockBrainStore();
    const assetStore = new BrainAssetStore(new MockMechClient() as never);
    brainStore.seed(SAMPLE_BRAIN);
    const response = await call(() => handleDeleteSecretAssets(
      'test-brain',
      new Request('http://localhost/v1/brain-assets/test-brain?asset_type=secret&confirm_brain_id=test-brain', {
        method: 'DELETE',
      }),
      brainStore as never,
      assetStore,
    ));
    expect(response.status).toBe(503);
  });

  test('fails when storage reports deletion but the secret record remains', async () => {
    const brainStore = new MockBrainStore();
    const mechClient = new MockMechClient();
    const assetStore = new BrainAssetStore(mechClient as never);
    brainStore.seed(SAMPLE_BRAIN);
    await handlePushBrainAssets(
      'test-brain',
      postRequest('test-brain', {
        files: [makeFileEntry({ path: '.env', asset_type: 'secret', cli: 'shared' })],
      }),
      brainStore as never,
      assetStore,
    );
    mechClient.deleteDocument = async () => {};

    const response = await call(() => handleDeleteSecretAssets(
      'test-brain',
      new Request('http://localhost/v1/brain-assets/test-brain?asset_type=secret&confirm_brain_id=test-brain', {
        method: 'DELETE',
      }),
      brainStore as never,
      assetStore,
    ));
    expect(response.status).toBe(503);
  });
});

// ── Tests: handlePullBrainAssets ─────────────────────────────────────────────

describe('handlePullBrainAssets', () => {
  let brainStore: MockBrainStore;
  let assetStore: BrainAssetStore;
  let mechClient: MockMechClient;

  beforeEach(() => {
    brainStore = new MockBrainStore();
    mechClient = new MockMechClient();
    assetStore = new BrainAssetStore(mechClient as never);
    brainStore.seed(SAMPLE_BRAIN);
  });

  test('pull returns all files when no filter', async () => {
    // Push some files first
    const pushReq = postRequest('test-brain', {
      files: [
        makeFileEntry({ path: '.claude/skills/a/SKILL.md', asset_type: 'skill' }),
        makeFileEntry({ path: '.claude/agents/b.md', asset_type: 'agent' }),
      ],
    });
    await handlePushBrainAssets('test-brain', pushReq, brainStore as never, assetStore);

    const res = await handlePullBrainAssets('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: unknown[]; total: number }>(res);
    expect(body.data.files).toHaveLength(2);
    expect(body.data.total).toBe(2);
  });

  test('pull filters excluded recovery archives from the live asset surface', async () => {
    const mech = {
      async listDocuments() {
        return [{
          id: 'backup-doc',
          document_id: 'backup-doc',
          document: {
            path: 'brain-db-backup/test-brain/backup.db',
            content: { __type: 'blob_ref', key: 'document-blobs/backup' },
            size: 151552,
            hash: 'backup',
            synced_at: '2026-01-01T00:00:00Z',
            asset_type: 'config',
            cli: 'shared',
            _collection: 'brain_assets_test-brain',
          },
        }];
      },
    };
    const filteredStore = new BrainAssetStore(mech as never);

    const docs = await filteredStore.pull('test-brain', {
      excludePathPrefixes: ['brain-db-backup/'],
    });

    expect(docs).toEqual([]);
  });

  test('pull filtered by asset_type returns only matching files', async () => {
    const pushReq = postRequest('test-brain', {
      files: [
        makeFileEntry({ path: '.claude/skills/a/SKILL.md', asset_type: 'skill' }),
        makeFileEntry({ path: '.claude/agents/b.md', asset_type: 'agent' }),
        makeFileEntry({ path: 'memory/MEMORY.md', asset_type: 'memory', cli: 'shared' }),
      ],
    });
    await handlePushBrainAssets('test-brain', pushReq, brainStore as never, assetStore);

    const res = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain', 'asset_type=skill'),
      brainStore as never,
      assetStore,
    );
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: Array<{ asset_type: string }>; total: number }>(res);
    expect(body.data.files).toHaveLength(1);
    expect(body.data.files[0].asset_type).toBe('skill');
    expect(body.data.total).toBe(1);
  });

  test('pull empty brain returns { files: [], total: 0 }', async () => {
    const res = await handlePullBrainAssets('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: unknown[]; total: number }>(res);
    expect(body.data.files).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  test('pull unknown brain returns 404', async () => {
    const res = await call(() =>
      handlePullBrainAssets('no-such-brain', getRequest('no-such-brain'), brainStore as never, assetStore),
    );
    expect(res.status).toBe(404);
  });

  test('pull returns content as base64', async () => {
    const content = '# Skill\n\nThis is the skill content.';
    const pushReq = postRequest('test-brain', {
      files: [makeFileEntry({ content_base64: b64(content) })],
    });
    await handlePushBrainAssets('test-brain', pushReq, brainStore as never, assetStore);

    const res = await handlePullBrainAssets('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    const body = await parseBody<{ files: Array<{ content_base64: string }> }>(res);
    const decoded = Buffer.from(body.data.files[0].content_base64, 'base64').toString('utf8');
    expect(decoded).toBe(content);
  });

  test('pull response shape includes required fields', async () => {
    const pushReq = postRequest('test-brain', {
      files: [makeFileEntry()],
    });
    await handlePushBrainAssets('test-brain', pushReq, brainStore as never, assetStore);

    const res = await handlePullBrainAssets('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    const body = await parseBody<{ files: Array<Record<string, unknown>>; total: number }>(res);
    const file = body.data.files[0];
    expect(typeof file.path).toBe('string');
    expect(typeof file.content_base64).toBe('string');
    expect(typeof file.asset_type).toBe('string');
    expect(typeof file.cli).toBe('string');
    expect(typeof file.size).toBe('number');
    expect(typeof file.synced_at).toBe('string');
  });

  test('invalid asset_type filter param returns 400', async () => {
    const res = await call(() =>
      handlePullBrainAssets(
        'test-brain',
        getRequest('test-brain', 'asset_type=invalid'),
        brainStore as never,
        assetStore,
      ),
    );
    expect(res.status).toBe(400);
  });

  test('pull filtered by exact path returns one file', async () => {
    const pushReq = postRequest('test-brain', {
      files: [
        makeFileEntry({
          path: 'skills/x/bundle-2026-01-01-120000.tar.gz',
          content_base64: b64('gz'),
          asset_type: 'config',
          cli: 'shared',
        }),
        makeFileEntry({
          path: 'other.cfg',
          content_base64: b64('x'),
          asset_type: 'config',
          cli: 'shared',
        }),
      ],
    });
    await handlePushBrainAssets('test-brain', pushReq, brainStore as never, assetStore);

    const res = await handlePullBrainAssets(
      'test-brain',
      getRequest(
        'test-brain',
        `asset_type=config&path=${encodeURIComponent('skills/x/bundle-2026-01-01-120000.tar.gz')}`,
      ),
      brainStore as never,
      assetStore,
    );
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: Array<{ path: string }>; total: number }>(res);
    expect(body.data.files).toHaveLength(1);
    expect(body.data.files[0].path).toBe('skills/x/bundle-2026-01-01-120000.tar.gz');
    expect(body.data.total).toBe(1);
  });

  test('pull supports path_prefix filtering', async () => {
    const pushReq = postRequest('test-brain', {
      files: [
        makeFileEntry({
          path: 'memory-store/heads/a.json',
          content_base64: b64('a'),
          asset_type: 'memory',
          cli: 'shared',
        }),
        makeFileEntry({
          path: 'memory-store/heads/b.json',
          content_base64: b64('b'),
          asset_type: 'memory',
          cli: 'shared',
        }),
        makeFileEntry({
          path: 'memory-store/latest.json',
          content_base64: b64('latest'),
          asset_type: 'memory',
          cli: 'shared',
        }),
      ],
    });
    await handlePushBrainAssets('test-brain', pushReq, brainStore as never, assetStore);

    const res = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain', `asset_type=memory&path_prefix=${encodeURIComponent('memory-store/heads/')}`),
      brainStore as never,
      assetStore,
    );
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: Array<{ path: string }>; total: number }>(res);
    expect(body.data.files.map((file) => file.path)).toEqual([
      'memory-store/heads/a.json',
      'memory-store/heads/b.json',
    ]);
    expect(body.data.total).toBe(2);
  });

  test('pull with path filter and no match returns 404', async () => {
    const res = await call(() =>
      handlePullBrainAssets(
        'test-brain',
        getRequest('test-brain', 'path=missing.tar.gz'),
        brainStore as never,
        assetStore,
      ),
    );
    expect(res.status).toBe(404);
  });

  test('pull rejects invalid path_prefix traversal', async () => {
    const res = await call(() =>
      handlePullBrainAssets(
        'test-brain',
        getRequest('test-brain', `path_prefix=${encodeURIComponent('../escape')}`),
        brainStore as never,
        assetStore,
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('brain asset branch isolation', () => {
  test('default branch remains usable when no persisted default row exists', async () => {
    const brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    const branchStore = new MockBranchStore();
    branchStore.seed({
      brain_id: 'test-brain',
      branch_id: 'tenant-acme',
      tenant_ref: 'acme',
      base_image_sha: null,
      bundle_version: null,
      volume_uri: null,
      status: 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    const mechClient = new MockMechClient();
    const assetStore = new BrainAssetStore(mechClient as never);

    const pushRes = await handlePushBrainAssets(
      'test-brain',
      postRequest('test-brain', {
        files: [makeFileEntry({ path: 'memory/default.md', asset_type: 'memory', cli: 'shared' })],
      }),
      brainStore as never,
      assetStore,
      branchStore as never,
    );
    expect(pushRes.status).toBe(200);

    const pullRes = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain'),
      brainStore as never,
      assetStore,
      branchStore as never,
    );
    expect(pullRes.status).toBe(200);
    const body = await parseBody<{ files: Array<{ path: string }> }>(pullRes);
    expect(body.data.files.map((file) => file.path)).toEqual(['memory/default.md']);
    expect(branchStore.updates).toHaveLength(0);
  });

  test('push stores non-default branches separately and updates branch metadata', async () => {
    const brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    const branchStore = new MockBranchStore();
    const mechClient = new MockMechClient();
    const assetStore = new BrainAssetStore(mechClient as never);

    for (const branchId of [DEFAULT_BRAIN_BRANCH_ID, 'tenant-acme']) {
      branchStore.seed({
        brain_id: 'test-brain',
        branch_id: branchId,
        tenant_ref: branchId === DEFAULT_BRAIN_BRANCH_ID ? null : 'acme',
        base_image_sha: null,
        bundle_version: null,
        volume_uri: null,
        status: 'active',
        last_seen_at: null,
        last_platform_snapshot_ts: null,
        last_agentbootup_snapshot_ts: null,
        last_agentbootup_snapshot_key: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
    }

    const defaultReq = postRequest('test-brain', { files: [makeFileEntry({ path: 'memory/default.md', asset_type: 'memory', cli: 'shared' })] });
    const tenantReq = postRequest('test-brain', {
      branch_id: 'tenant-acme',
      files: [makeFileEntry({ path: 'memory/tenant.md', asset_type: 'memory', cli: 'shared' })],
    });

    await handlePushBrainAssets('test-brain', defaultReq, brainStore as never, assetStore, branchStore as never);
    await handlePushBrainAssets('test-brain', tenantReq, brainStore as never, assetStore, branchStore as never);

    const defaultPull = await handlePullBrainAssets('test-brain', getRequest('test-brain'), brainStore as never, assetStore, branchStore as never);
    const tenantPull = await handlePullBrainAssets(
      'test-brain',
      getRequest('test-brain', 'branch_id=tenant-acme'),
      brainStore as never,
      assetStore,
      branchStore as never,
    );

    const defaultBody = await parseBody<{ files: Array<{ path: string }> }>(defaultPull);
    const tenantBody = await parseBody<{ files: Array<{ path: string }> }>(tenantPull);

    expect(defaultBody.data.files.map((file) => file.path)).toEqual(['memory/default.md']);
    expect(tenantBody.data.files.map((file) => file.path)).toEqual(['memory/tenant.md']);
    expect(branchStore.updates.some((row) => row.branchId === 'tenant-acme')).toBe(true);
  });

  test('push rejects unknown branch ids', async () => {
    const brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    const branchStore = new MockBranchStore();
    branchStore.seed({
      brain_id: 'test-brain',
      branch_id: DEFAULT_BRAIN_BRANCH_ID,
      tenant_ref: null,
      base_image_sha: null,
      bundle_version: null,
      volume_uri: null,
      status: 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const req = postRequest('test-brain', {
      branch_id: 'missing-branch',
      files: [makeFileEntry()],
    });
    const res = await call(() =>
      handlePushBrainAssets('test-brain', req, brainStore as never, new BrainAssetStore(new MockMechClient() as never), branchStore as never),
    );
    expect(res.status).toBe(404);
  });

  test('push rejects soft-deleted branch ids', async () => {
    const brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    const branchStore = new MockBranchStore();
    branchStore.seed({
      brain_id: 'test-brain',
      branch_id: 'tenant-acme',
      tenant_ref: 'acme',
      base_image_sha: null,
      bundle_version: null,
      volume_uri: null,
      status: 'deleted',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const req = postRequest('test-brain', {
      branch_id: 'tenant-acme',
      files: [makeFileEntry()],
    });
    const res = await call(() =>
      handlePushBrainAssets('test-brain', req, brainStore as never, new BrainAssetStore(new MockMechClient() as never), branchStore as never),
    );
    expect(res.status).toBe(404);
  });
});

// ── Integration: PR-5/B-8 demotion-floor wiring (handlePushBrainAssets) ──────
// Proves the guard short-circuits BEFORE assetStore.push (not just that the pure
// function returns a Response). mechClient.docs records createDocument side
// effects; a 426 must leave it empty, a 200 must populate it.

describe('handlePushBrainAssets — PR-5/B-8 demotion-floor wiring', () => {
  let brainStore: MockBrainStore;
  let assetStore: BrainAssetStore;
  let mechClient: MockMechClient;
  const ENV_FLAG = 'AGENTBOOTUP_MEMORY_DEMOTION_ENABLED';
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[ENV_FLAG];
    process.env[ENV_FLAG] = '1';
    brainStore = new MockBrainStore();
    mechClient = new MockMechClient();
    assetStore = new BrainAssetStore(mechClient as never);
    brainStore.seed({ ...SAMPLE_BRAIN, id: 'demoted-brain', metadata: { memory_demotion_enabled: true } });
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = savedFlag;
  });

  function postWithVersion(brainId: string, version: string | null, files: unknown[]): Request {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (version) headers['x-agentbootup-version'] = version;
    return new Request(`http://localhost/v1/brain-assets/${brainId}/push`, {
      method: 'POST',
      body: JSON.stringify({ files }),
      headers,
    });
  }

  test('below-floor client + raw memory/** → 426 AND assetStore.push short-circuited (no docs written)', async () => {
    const req = postWithVersion('demoted-brain', '0.8.10', [
      makeFileEntry({ path: 'memory/MEMORY.md', asset_type: 'memory' }),
    ]);
    const res = await handlePushBrainAssets('demoted-brain', req, brainStore as never, assetStore);
    expect(res.status).toBe(426);
    expect(mechClient.docs.size).toBe(0); // push never ran
  });

  test('at-floor client + raw memory/** → 200 AND push ran (doc written)', async () => {
    const req = postWithVersion('demoted-brain', '0.8.26', [
      makeFileEntry({ path: 'memory/MEMORY.md', asset_type: 'memory' }),
    ]);
    const res = await handlePushBrainAssets('demoted-brain', req, brainStore as never, assetStore);
    expect(res.status).toBe(200);
    expect(mechClient.docs.size).toBe(1); // push ran
  });

  test('demotion OFF → raw memory/** pushes normally regardless of client version (kill switch)', async () => {
    delete process.env[ENV_FLAG];
    const req = postWithVersion('demoted-brain', '0.8.10', [
      makeFileEntry({ path: 'memory/MEMORY.md', asset_type: 'memory' }),
    ]);
    const res = await handlePushBrainAssets('demoted-brain', req, brainStore as never, assetStore);
    expect(res.status).toBe(200);
    expect(mechClient.docs.size).toBe(1);
  });

  test('non-opted-in brain → raw memory/** pushes normally even with demotion on', async () => {
    brainStore.seed({ ...SAMPLE_BRAIN, id: 'plain-brain', metadata: {} });
    const req = postWithVersion('plain-brain', '0.8.10', [
      makeFileEntry({ path: 'memory/MEMORY.md', asset_type: 'memory' }),
    ]);
    const res = await handlePushBrainAssets('plain-brain', req, brainStore as never, assetStore);
    expect(res.status).toBe(200);
    expect(mechClient.docs.size).toBe(1);
  });
});
