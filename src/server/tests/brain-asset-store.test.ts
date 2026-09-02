import { describe, test, expect, beforeEach } from 'bun:test';
import { BrainAssetStore } from '../lib/brain-asset-store';
import { BrainAssetMetadataSnapshotOverflowError } from '../lib/mech-client';
import type { MechDocument } from '../types';
import type { BrainAssetFile } from '../lib/brain-asset-store';

// ── Mock MechClient ──────────────────────────────────────────────────────────

class MockMechClient {
  public docs: Map<string, { id: string; document: Record<string, unknown> }> = new Map();
  public failCreateForPath: string | null = null;
  public beforeCreate: ((data: Record<string, unknown>) => Promise<void>) | null = null;
  public afterCreate: ((id: string, data: Record<string, unknown>) => Promise<void>) | null = null;
  public deletedIds: string[] = [];
  public failDeleteForId: string | null = null;
  private nextId = 1;

  async listDocuments(_collection: string): Promise<MechDocument[]> {
    return Array.from(this.docs.values()).map((d) => ({
      id: d.id,
      document_id: d.id,
      document: d.document,
    }));
  }

  async getDocument(id: string): Promise<MechDocument | null> {
    const found = this.docs.get(id);
    return found ? { id: found.id, document_id: found.id, document: found.document } : null;
  }

  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> {
    if (data.path === this.failCreateForPath) {
      throw new Error('injected secret generation failure');
    }
    await this.beforeCreate?.(data);
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, document: data });
    await this.afterCreate?.(id, data);
    return id;
  }

  async updateDocument(docId: string, _collection: string, data: Record<string, unknown>): Promise<void> {
    this.docs.set(docId, { id: docId, document: data });
  }

  async deleteDocument(docId: string): Promise<void> {
    this.deletedIds.push(docId);
    if (docId === this.failDeleteForId) {
      throw new Error('injected delete failure');
    }
    this.docs.delete(docId);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFile(overrides: Partial<BrainAssetFile> = {}): BrainAssetFile {
  return {
    path: '.claude/skills/my-skill/SKILL.md',
    content: '# My Skill',
    asset_type: 'skill',
    cli: 'claude',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BrainAssetStore', () => {
  let store: BrainAssetStore;
  let client: MockMechClient;
  const BRAIN_ID = 'decisive-gm';

  beforeEach(() => {
    client = new MockMechClient();
    store = new BrainAssetStore(client as never);
  });

  test('pull returns empty array for empty collection', async () => {
    const assets = await store.pull(BRAIN_ID);
    expect(assets).toEqual([]);
  });

  test('listHashes uses the bounded metadata snapshot without loading asset bodies', async () => {
    let requested: [string, number] | null = null;
    (client as unknown as { readBrainAssetMetadataSnapshot: (collection: string, limit: number) => Promise<unknown> }).readBrainAssetMetadataSnapshot = async (collection, limit) => {
      requested = [collection, limit];
      return {
        complete: true,
        records: [{
          id: '00000000-0000-4000-8000-000000000001', document_id: 'brain/a.md', _collection: collection,
          path: 'brain/a.md', hash: 'a'.repeat(64), size: 3, asset_type: 'memory', cli: 'shared',
          synced_at: '2026-08-13T00:00:00.000Z', _record_kind: null,
          content_representation: 'inline', declared_encoded_size: 4,
        }],
      };
    };

    await expect(store.listHashes(BRAIN_ID)).resolves.toEqual([{
      path: 'brain/a.md', hash: 'a'.repeat(64), size: 3, asset_type: 'memory', cli: 'shared',
      synced_at: '2026-08-13T00:00:00.000Z',
    }]);
    expect(requested).toEqual(['brain_assets_decisive-gm', 500]);
  });

  test('listHashes supports documented dot-separated brain IDs through the bounded snapshot', async () => {
    let requested: string | null = null;
    (client as unknown as { readBrainAssetMetadataSnapshot: (collection: string) => Promise<unknown> }).readBrainAssetMetadataSnapshot = async (collection) => {
      requested = collection;
      return {
        complete: true,
        records: [{
          id: '00000000-0000-4000-8000-000000000001', document_id: 'brain/a.md', _collection: collection,
          path: 'brain/a.md', hash: 'a'.repeat(64), size: 3, asset_type: 'memory', cli: 'shared',
          synced_at: '2026-08-13T00:00:00.000Z', _record_kind: null,
        }],
      };
    };

    await expect(store.listHashes('decisive.gm')).resolves.toEqual([expect.objectContaining({ path: 'brain/a.md' })]);
    expect(requested).toBe('brain_assets_decisive.gm');
  });

  test('listHashes fails closed on malformed ordinary metadata from a snapshot', async () => {
    (client as unknown as { readBrainAssetMetadataSnapshot: () => Promise<unknown> }).readBrainAssetMetadataSnapshot = async () => ({
      complete: true,
      records: [{
        id: '00000000-0000-4000-8000-000000000001', document_id: 'brain/a.md', _collection: 'brain_assets_decisive-gm',
        path: 'brain/config.secret.json', hash: 'a'.repeat(64), size: 3, asset_type: 'memory', cli: 'shared',
        synced_at: '2026-08-13T00:00:00.000Z', _record_kind: null,
      }],
    });
    await expect(store.listHashes(BRAIN_ID)).rejects.toThrow('malformed ordinary metadata');
  });

  test('listHashes preserves its complete-list contract when the bounded snapshot overflows', async () => {
    await store.push(BRAIN_ID, [makeFile({ path: 'brain/a.md', content: 'body', asset_type: 'memory', cli: 'shared' })]);
    (client as unknown as { readBrainAssetMetadataSnapshot: () => Promise<unknown> }).readBrainAssetMetadataSnapshot = async () => {
      throw new BrainAssetMetadataSnapshotOverflowError();
    };
    await expect(store.listHashes(BRAIN_ID)).resolves.toEqual([expect.objectContaining({ path: 'brain/a.md' })]);
  });

  test('listHashes fails closed on malformed ordinary metadata in its overflow fallback', async () => {
    await store.push(BRAIN_ID, [makeFile({ path: 'brain/a.md', content: 'body', asset_type: 'memory', cli: 'shared' })]);
    const stored = [...client.docs.values()][0]!.document;
    stored.hash = 'not-a-hash';
    (client as unknown as { readBrainAssetMetadataSnapshot: () => Promise<unknown> }).readBrainAssetMetadataSnapshot = async () => {
      throw new BrainAssetMetadataSnapshotOverflowError();
    };

    await expect(store.listHashes(BRAIN_ID)).rejects.toThrow('malformed ordinary metadata');
  });

  test('push creates new file and pull retrieves it', async () => {
    const result = await store.push(BRAIN_ID, [
      makeFile({ path: '.claude/skills/my-skill/SKILL.md', content: '# My Skill' }),
    ]);

    expect(result.pushed).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.results[0].status).toBe('pushed');

    const assets = await store.pull(BRAIN_ID);
    expect(assets).toHaveLength(1);
    expect(assets[0].path).toBe('.claude/skills/my-skill/SKILL.md');
    expect(assets[0].content).toBe('# My Skill');
  });

  test('push updates existing file (upsert by path)', async () => {
    await store.push(BRAIN_ID, [
      makeFile({ path: '.claude/agents/my-agent.md', content: 'v1' }),
    ]);

    const result = await store.push(BRAIN_ID, [
      makeFile({ path: '.claude/agents/my-agent.md', content: 'v2' }),
    ]);

    expect(result.pushed).toBe(0);
    expect(result.updated).toBe(1);

    const assets = await store.pull(BRAIN_ID);
    expect(assets).toHaveLength(1);
    expect(assets[0].content).toBe('v2');
  });

  test('stores large base64 assets in chunks and reassembles them on pull', async () => {
    const content = 'Y'.repeat(20 * 1024);
    await store.push(BRAIN_ID, [makeFile({ path: 'memory/large.md', content, asset_type: 'memory', cli: 'shared' })]);

    const stored = [...client.docs.values()][0].document;
    expect(stored.content).toBe('');
    expect(stored.content_chunks).toEqual([content.slice(0, 16 * 1024), content.slice(16 * 1024)]);
    expect(stored.content_encoding).toBe('base64-chunked-v1');
    expect(stored.content_chunk_count).toBe(2);

    const assets = await store.pull(BRAIN_ID);
    expect(assets[0].content).toBe(content);
  });

  test('rejects a chunked exact read when its declared chunk count is malformed', async () => {
    const content = 'Y'.repeat(20 * 1024);
    await store.push(BRAIN_ID, [makeFile({ path: 'memory/large.md', content, asset_type: 'memory', cli: 'shared' })]);
    const stored = [...client.docs.values()][0];
    stored.document.content_chunk_count = 3;

    await expect(store.pullExact(BRAIN_ID, 'memory/large.md')).rejects.toThrow('invalid content chunk count');
  });

  test('push multiple files in one call', async () => {
    const result = await store.push(BRAIN_ID, [
      makeFile({ path: '.claude/skills/a/SKILL.md', content: 'skill a' }),
      makeFile({ path: '.claude/agents/b.md', content: 'agent b', asset_type: 'agent' }),
      makeFile({ path: 'memory/MEMORY.md', content: 'memory', asset_type: 'memory', cli: 'shared' }),
    ]);

    expect(result.pushed).toBe(3);
    expect(result.updated).toBe(0);

    const assets = await store.pull(BRAIN_ID);
    expect(assets).toHaveLength(3);
  });

  test('pull filtered by asset_type returns only matching files', async () => {
    await store.push(BRAIN_ID, [
      makeFile({ path: '.claude/skills/a/SKILL.md', asset_type: 'skill' }),
      makeFile({ path: '.claude/agents/b.md', asset_type: 'agent' }),
      makeFile({ path: 'memory/MEMORY.md', asset_type: 'memory', cli: 'shared' }),
    ]);

    const skills = await store.pull(BRAIN_ID, { assetType: 'skill' });
    expect(skills).toHaveLength(1);
    expect(skills[0].asset_type).toBe('skill');

    const agents = await store.pull(BRAIN_ID, { assetType: 'agent' });
    expect(agents).toHaveLength(1);
    expect(agents[0].asset_type).toBe('agent');
  });

  test('pull filtered by asset_type returns empty array when no match', async () => {
    await store.push(BRAIN_ID, [
      makeFile({ path: '.claude/skills/a/SKILL.md', asset_type: 'skill' }),
    ]);

    const protocols = await store.pull(BRAIN_ID, { assetType: 'protocol' });
    expect(protocols).toEqual([]);
  });

  test('push mix of new and existing files', async () => {
    await store.push(BRAIN_ID, [
      makeFile({ path: '.claude/skills/a/SKILL.md', content: 'v1' }),
    ]);

    const result = await store.push(BRAIN_ID, [
      makeFile({ path: '.claude/skills/a/SKILL.md', content: 'v2' }),    // existing → update
      makeFile({ path: '.claude/agents/new.md', asset_type: 'agent' }),  // new → push
    ]);

    expect(result.pushed).toBe(1);
    expect(result.updated).toBe(1);

    const assets = await store.pull(BRAIN_ID);
    expect(assets).toHaveLength(2);
  });

  test('pull supports pathPrefix filtering', async () => {
    await store.push(BRAIN_ID, [
      makeFile({ path: 'memory-store/heads/a.json', content: 'a', asset_type: 'memory', cli: 'shared' }),
      makeFile({ path: 'memory-store/heads/b.json', content: 'b', asset_type: 'memory', cli: 'shared' }),
      makeFile({ path: 'memory-store/latest.json', content: 'latest', asset_type: 'memory', cli: 'shared' }),
    ]);

    const heads = await store.pull(BRAIN_ID, { assetType: 'memory', pathPrefix: 'memory-store/heads/' });
    expect(heads.map((asset) => asset.path)).toEqual([
      'memory-store/heads/a.json',
      'memory-store/heads/b.json',
    ]);
  });

  test('sets hash, size, and synced_at metadata on push', async () => {
    await store.push(BRAIN_ID, [
      makeFile({ path: '.claude/skills/test/SKILL.md', content: 'hello' }),
    ]);
    const docs = Array.from(client.docs.values());
    expect(docs).toHaveLength(1);
    const doc = docs[0].document;
    expect(typeof doc.hash).toBe('string');
    expect((doc.hash as string).length).toBe(64); // SHA-256 hex
    expect(doc.size).toBeGreaterThan(0);
    expect(typeof doc.synced_at).toBe('string');
  });

  test('hash changes when content is updated', async () => {
    await store.push(BRAIN_ID, [makeFile({ path: 'test.md', content: 'v1' })]);
    const hashBefore = (Array.from(client.docs.values())[0].document as Record<string, unknown>).hash;

    await store.push(BRAIN_ID, [makeFile({ path: 'test.md', content: 'v2 — different content' })]);
    const hashAfter = (Array.from(client.docs.values())[0].document as Record<string, unknown>).hash;

    expect(hashBefore).not.toBe(hashAfter);
  });

  test('synced_at is updated on subsequent push', async () => {
    await store.push(BRAIN_ID, [makeFile({ path: 'test.md', content: 'v1' })]);
    const syncedAtBefore = (Array.from(client.docs.values())[0].document as Record<string, unknown>).synced_at as string;

    // Small delay to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 10));

    await store.push(BRAIN_ID, [makeFile({ path: 'test.md', content: 'v2' })]);
    const syncedAtAfter = (Array.from(client.docs.values())[0].document as Record<string, unknown>).synced_at as string;

    expect(typeof syncedAtAfter).toBe('string');
    expect(syncedAtAfter).not.toBe(syncedAtBefore);
  });

  test('stores asset_type and cli fields', async () => {
    await store.push(BRAIN_ID, [
      makeFile({ path: 'memory/MEMORY.md', asset_type: 'memory', cli: 'shared' }),
    ]);
    const doc = Array.from(client.docs.values())[0].document as Record<string, unknown>;
    expect(doc.asset_type).toBe('memory');
    expect(doc.cli).toBe('shared');
  });

  test('store error is captured in results, does not abort request', async () => {
    const failClient = {
      listDocuments: async () => [],
      createDocument: async () => { throw new Error('Mech storage unavailable'); },
      updateDocument: async () => { throw new Error('Mech storage unavailable'); },
    };
    const failStore = new BrainAssetStore(failClient as never);

    const result = await failStore.push(BRAIN_ID, [
      makeFile({ path: 'a.md' }),
      makeFile({ path: 'b.md' }),
    ]);

    expect(result.errors).toBe(2);
    expect(result.results[0].status).toBe('error');
    expect(result.results[0].error).toContain('unavailable');
  });

  test('deduplicates paths within a batch — last occurrence wins, no duplicate docs', async () => {
    const result = await store.push(BRAIN_ID, [
      makeFile({ path: 'memory/MEMORY.md', content: 'v1' }),
      makeFile({ path: 'memory/MEMORY.md', content: 'v2' }),  // duplicate path
    ]);

    // Only one document should exist despite two entries with same path
    const docs = Array.from(client.docs.values());
    expect(docs).toHaveLength(1);
    // Last occurrence wins — content is stored as raw base64 as passed in
    expect((docs[0].document as Record<string, unknown>).content).toBe('v2');
    // Result counts: 1 pushed (first) or 1 updated (if dedup treated as update)
    expect(result.pushed + result.updated).toBe(1);
    expect(result.errors).toBe(0);
  });

  test('push writes multiple assets concurrently while preserving per-file results', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const delayedClient = {
      listDocuments: async () => [],
      createDocument: async (_collection: string, data: Record<string, unknown>) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return String(data.path);
      },
      updateDocument: async () => {
        throw new Error('unexpected update');
      },
    };
    const delayedStore = new BrainAssetStore(delayedClient as never);

    const result = await delayedStore.push(BRAIN_ID, [
      makeFile({ path: 'memory/a.md', asset_type: 'memory', cli: 'shared' }),
      makeFile({ path: 'memory/b.md', asset_type: 'memory', cli: 'shared' }),
      makeFile({ path: 'memory/c.md', asset_type: 'memory', cli: 'shared' }),
      makeFile({ path: 'memory/d.md', asset_type: 'memory', cli: 'shared' }),
    ]);

    expect(result.errors).toBe(0);
    expect(result.pushed).toBe(4);
    expect(result.results.map((entry) => entry.path)).toEqual([
      'memory/a.md',
      'memory/b.md',
      'memory/c.md',
      'memory/d.md',
    ]);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test('secret batch is fail-closed and preserves the previous committed generation', async () => {
    const secret = (path: string, content: string): BrainAssetFile =>
      makeFile({ path, content, asset_type: 'secret', cli: 'shared' });
    const first = await store.push(BRAIN_ID, [
      secret('.env', 'old-env'),
      secret('.dev.vars', 'old-dev-vars'),
      secret('brain/config.secret.json', 'old-config'),
    ], undefined, { expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(first.errors).toBe(0);

    client.failCreateForPath = '.dev.vars';
    const failed = await store.push(BRAIN_ID, [
      secret('.env', 'new-env'),
      secret('.dev.vars', 'new-dev-vars'),
      secret('brain/config.secret.json', 'new-config'),
    ], undefined, { expiresAt: '2099-01-02T00:00:00.000Z' });
    expect(failed.errors).toBeGreaterThan(0);

    const visible = await store.pull(BRAIN_ID, { assetType: 'secret' });
    expect(visible.map((asset) => [asset.path, asset.content])).toEqual([
      ['.env', 'old-env'],
      ['.dev.vars', 'old-dev-vars'],
      ['brain/config.secret.json', 'old-config'],
    ]);
    expect(visible.every((asset) => asset.expires_at === '2099-01-01T00:00:00.000Z')).toBe(true);
  });

  test('concurrent secret pushes never delete a newer writer staged before its commit', async () => {
    const secret = (content: string): BrainAssetFile =>
      makeFile({ path: '.env', content, asset_type: 'secret', cli: 'shared' });
    let commitReached!: () => void;
    const reached = new Promise<void>((resolve) => { commitReached = resolve; });
    let releaseCommit!: () => void;
    const release = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let held = false;
    client.beforeCreate = async (data) => {
      if (data._record_kind !== 'secret_generation_commit_v1' || held) return;
      held = true;
      data.committed_at = '2099-01-01T00:00:00.000Z';
      commitReached();
      await release;
    };

    const newerWriter = store.push(BRAIN_ID, [secret('newer')]);
    await reached;
    client.beforeCreate = null;

    const competingStore = new BrainAssetStore(client as never);
    const competing = await competingStore.push(BRAIN_ID, [secret('competing')]);
    expect(competing.errors).toBe(0);

    releaseCommit();
    expect((await newerWriter).errors).toBe(0);
    const visible = await store.pull(BRAIN_ID, { assetType: 'secret' });
    expect(visible.map((asset) => asset.content)).toEqual(['newer']);
  });

  test('a losing concurrent secret writer rolls back only its own generation', async () => {
    const secret = (content: string): BrainAssetFile =>
      makeFile({ path: '.env', content, asset_type: 'secret', cli: 'shared' });
    let commitStored!: () => void;
    const stored = new Promise<void>((resolve) => { commitStored = resolve; });
    let releaseCommit!: () => void;
    const release = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let held = false;
    client.afterCreate = async (_id, data) => {
      if (data._record_kind !== 'secret_generation_commit_v1' || held) return;
      held = true;
      data.committed_at = '2020-01-01T00:00:00.000Z';
      commitStored();
      await release;
    };

    const losingStore = new BrainAssetStore(client as never);
    const losingWriter = losingStore.push(BRAIN_ID, [secret('losing')]);
    await stored;
    const losingGenerationIds = new Set(
      [...client.docs.values()]
        .filter((entry) => entry.document.secret_generation_id !== undefined
          || entry.document._record_kind === 'secret_generation_commit_v1')
        .map((entry) => entry.id),
    );
    client.afterCreate = null;

    const winner = await store.push(BRAIN_ID, [secret('winner')]);
    expect(winner.errors).toBe(0);
    client.deletedIds = [];

    releaseCommit();
    const losing = await losingWriter;
    expect(losing.errors).toBe(1);
    expect(client.deletedIds.every((id) => losingGenerationIds.has(id))).toBe(true);
    expect((await store.pull(BRAIN_ID, { assetType: 'secret' }))
      .map((asset) => asset.content)).toEqual(['winner']);
  });

  test('stale cleanup never partially deletes a generation whose commit marker remains', async () => {
    const secret = (path: string, content: string): BrainAssetFile =>
      makeFile({ path, content, asset_type: 'secret', cli: 'shared' });
    expect((await store.push(BRAIN_ID, [
      secret('.env', 'old-env'),
      secret('.dev.vars', 'old-vars'),
    ])).errors).toBe(0);
    const oldCommit = [...client.docs.values()].find(
      (entry) => entry.document._record_kind === 'secret_generation_commit_v1',
    );
    expect(oldCommit).toBeDefined();
    oldCommit!.document.committed_at = '2020-01-01T00:00:00.000Z';
    const oldGenerationId = oldCommit!.document.generation_id;
    const oldFileIds = [...client.docs.values()]
      .filter((entry) => entry.document.secret_generation_id === oldGenerationId)
      .map((entry) => entry.id);
    client.failDeleteForId = oldCommit!.id;

    expect((await store.push(BRAIN_ID, [secret('.env', 'new-env')])).errors).toBe(0);
    expect(client.docs.has(oldCommit!.id)).toBe(true);
    expect(oldFileIds.every((id) => client.docs.has(id))).toBe(true);
    expect((await store.pull(BRAIN_ID, { assetType: 'secret' }))
      .map((asset) => asset.content)).toEqual(['new-env']);
  });

  test('secret pull rejects noncanonical and nonfuture expiry metadata', async () => {
    const secret = makeFile({
      path: '.env',
      content: 'secret',
      asset_type: 'secret',
      cli: 'shared',
    });
    await store.push(BRAIN_ID, [secret], undefined, {
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(await store.pull(BRAIN_ID, { assetType: 'secret' })).toHaveLength(1);

    const secretDoc = [...client.docs.values()].find((doc) => doc.document.path === '.env');
    expect(secretDoc).toBeDefined();
    for (const expiry of [
      '2099-01-01T00:00:00Z',
      '2098-12-31T19:00:00.000-05:00',
      new Date(Date.now() - 1_000).toISOString(),
    ]) {
      secretDoc!.document.expires_at = expiry;
      expect(await store.pull(BRAIN_ID, { assetType: 'secret' })).toEqual([]);
    }
  });

  test('secret push rejects malformed, noncanonical, and expired expiry options', async () => {
    const secret = makeFile({
      path: '.env',
      content: 'secret',
      asset_type: 'secret',
      cli: 'shared',
    });
    for (const expiresAt of [
      'not-a-date',
      '2099-01-01T00:00:00Z',
      new Date(Date.now() - 1_000).toISOString(),
    ]) {
      const result = await store.push(BRAIN_ID, [secret], 'default', { expiresAt });
      expect(result.errors).toBe(1);
      expect(client.docs.size).toBe(0);
    }
  });

  test('unfiltered store pull excludes a committed secret generation', async () => {
    await store.push(BRAIN_ID, [
      makeFile({ path: 'brain/config.json', asset_type: 'config', cli: 'shared' }),
    ]);
    await store.push(BRAIN_ID, [
      makeFile({ path: '.env', content: 'fixture-secret', asset_type: 'secret', cli: 'shared' }),
    ]);

    expect((await store.pull(BRAIN_ID)).map((asset) => asset.path)).toEqual(['brain/config.json']);
    expect((await store.pull(BRAIN_ID, { assetType: 'secret' })).map((asset) => asset.path)).toEqual(['.env']);
  });

  test('secret cleanup deletes and verifies more than the former enumeration cap', async () => {
    const total = 5_125;
    for (let index = 0; index < total; index += 1) {
      const id = `secret-${index}`;
      client.docs.set(id, {
        id,
        document: {
          path: `.staged-secret-${index}`,
          asset_type: 'secret',
          cli: 'shared',
          _collection: `brain_assets_${BRAIN_ID}`,
        },
      });
    }

    expect(await store.deleteSecretAssets(BRAIN_ID)).toEqual({
      deleted: total,
      errors: 0,
      remaining: 0,
      verified_absent: true,
    });
    expect(client.docs.size).toBe(0);
  });
});
