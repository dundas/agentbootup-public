import { describe, test, expect, beforeEach } from 'bun:test';
import { MemoryStore } from '../lib/memory-store';
import type { MechDocument } from '../types';

// ── Mock MechClient ──────────────────────────────────────────────────────────

class MockMechClient {
  public docs: Map<string, { id: string; document: Record<string, unknown> }> = new Map();
  private nextId = 1;

  async listDocuments(_collection: string): Promise<MechDocument[]> {
    return Array.from(this.docs.values()).map((d) => ({
      id: d.id,
      document_id: d.id,
      document: d.document,
    }));
  }

  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, document: data });
    return id;
  }

  async updateDocument(docId: string, _collection: string, data: Record<string, unknown>): Promise<void> {
    this.docs.set(docId, { id: docId, document: data });
  }

  async deleteDocument(docId: string): Promise<void> {
    this.docs.delete(docId);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MemoryStore', () => {
  let store: MemoryStore;
  let client: MockMechClient;
  const COLLECTION = 'agent_memory_decisive_gm';

  beforeEach(() => {
    client = new MockMechClient();
    store = new MemoryStore(client as never);
  });

  test('pull returns empty array for empty collection', async () => {
    const files = await store.pull(COLLECTION);
    expect(files).toEqual([]);
  });

  test('push creates new file and pull retrieves it', async () => {
    const result = await store.push(COLLECTION, [
      { path: 'memory/MEMORY.md', content: '# Memory\n\nContent.' },
    ]);

    expect(result.pushed).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.results[0].status).toBe('pushed');

    const files = await store.pull(COLLECTION);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('memory/MEMORY.md');
    expect(files[0].content).toBe('# Memory\n\nContent.');
  });

  test('push updates existing file (upsert by path)', async () => {
    await store.push(COLLECTION, [
      { path: 'memory/MEMORY.md', content: 'v1' },
    ]);

    const result = await store.push(COLLECTION, [
      { path: 'memory/MEMORY.md', content: 'v2' },
    ]);

    expect(result.pushed).toBe(0);
    expect(result.updated).toBe(1);

    const files = await store.pull(COLLECTION);
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe('v2');
  });

  test('push multiple files in one call', async () => {
    const result = await store.push(COLLECTION, [
      { path: 'memory/MEMORY.md', content: 'main memory' },
      { path: 'memory/daily/2026-02-22.md', content: 'daily log' },
      { path: 'memory/WORKQUEUE.md', content: 'work queue' },
    ]);

    expect(result.pushed).toBe(3);
    expect(result.updated).toBe(0);

    const files = await store.pull(COLLECTION);
    expect(files).toHaveLength(3);
  });

  test('push mix of new and existing files', async () => {
    await store.push(COLLECTION, [{ path: 'memory/MEMORY.md', content: 'v1' }]);

    const result = await store.push(COLLECTION, [
      { path: 'memory/MEMORY.md', content: 'v2' },      // existing → update
      { path: 'memory/daily/2026-02-22.md', content: 'new' }, // new → push
    ]);

    expect(result.pushed).toBe(1);
    expect(result.updated).toBe(1);

    const files = await store.pull(COLLECTION);
    expect(files).toHaveLength(2);
  });

  test('sets hash and size metadata on push', async () => {
    await store.push(COLLECTION, [{ path: 'test.md', content: 'hello' }]);
    const docs = Array.from(client.docs.values());
    expect(docs).toHaveLength(1);
    const doc = docs[0].document;
    expect(typeof doc.hash).toBe('string');
    expect((doc.hash as string).length).toBe(32); // MD5 hex
    expect(doc.size).toBeGreaterThan(0);
    expect(typeof doc.synced_at).toBe('string');
  });
});
