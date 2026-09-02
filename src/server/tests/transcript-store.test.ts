import { describe, test, expect, beforeEach } from 'bun:test';
import { TranscriptStore } from '../lib/transcript-store';
import type { MechDocument } from '../types';

// ── Mock MechClient ──────────────────────────────────────────────────────────

class MockMechClient {
  public files: Map<string, { content: Buffer; mimeType: string; updatedAt: string }> = new Map();
  /** docs keyed by collection → docId → doc */
  public docsByCollection: Map<string, Map<string, { id: string; document: Record<string, unknown> }>> = new Map();
  private nextDocId = 1;

  // Files API
  async uploadFile(key: string, content: Buffer | string, mimeType = 'application/octet-stream', updatedAt?: string): Promise<{ key: string }> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    this.files.set(key, { content: buf, mimeType, updatedAt: updatedAt ?? new Date().toISOString() });
    return { key };
  }

  async downloadFile(key: string): Promise<Buffer> {
    const f = this.files.get(key);
    if (!f) throw new Error(`Mech Files GET ${key} not found (404)`);
    return f.content;
  }

  async listFiles(prefix: string): Promise<Array<{ key: string; size: number; updatedAt: string }>> {
    return Array.from(this.files.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({ key: k, size: v.content.byteLength, updatedAt: v.updatedAt }));
  }

  /** Seed a file with a specific updatedAt for deterministic since-filter tests */
  seedFile(key: string, content: Buffer | string, updatedAt: string): void {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    this.files.set(key, { content: buf, mimeType: 'application/octet-stream', updatedAt });
  }

  // NoSQL API — collection-scoped to match real MechClient behaviour
  async listDocuments(collection: string): Promise<MechDocument[]> {
    const coll = this.docsByCollection.get(collection);
    if (!coll) return [];
    return Array.from(coll.values()).map((d) => ({
      id: d.id,
      document_id: d.id,
      document: d.document,
    }));
  }

  async createDocument(collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextDocId++}`;
    if (!this.docsByCollection.has(collection)) {
      this.docsByCollection.set(collection, new Map());
    }
    this.docsByCollection.get(collection)!.set(id, { id, document: data });
    return id;
  }

  async deleteDocument(docId: string): Promise<void> {
    for (const coll of this.docsByCollection.values()) {
      coll.delete(docId);
    }
  }

  get totalDocCount(): number {
    let n = 0;
    for (const coll of this.docsByCollection.values()) n += coll.size;
    return n;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TranscriptStore', () => {
  let store: TranscriptStore;
  let client: MockMechClient;

  beforeEach(() => {
    client = new MockMechClient();
    store = new TranscriptStore(client as never);
  });

  // ── upload ─────────────────────────────────────────────────────────────

  describe('upload', () => {
    test('stores file at correct key path', async () => {
      const content = Buffer.from('{"event":"test"}\n', 'utf8');
      const result = await store.upload('decisive-gm', 'mac-mini', 'claude', 'session.jsonl', content);

      expect(result.key).toBe('transcripts/decisive-gm/mac-mini/claude/session.jsonl');
      expect(result.status).toBe('pushed');
      expect(client.files.has('transcripts/decisive-gm/mac-mini/claude/session.jsonl')).toBe(true);
    });

    test('stores correct content', async () => {
      const content = Buffer.from('hello world', 'utf8');
      await store.upload('b', 'm', 'claude', 'f.jsonl', content);
      const stored = client.files.get('transcripts/b/m/claude/f.jsonl');
      expect(stored?.content.toString('utf8')).toBe('hello world');
    });

    test('sets correct MIME type for claude (jsonl)', async () => {
      await store.upload('b', 'm', 'claude', 'f.jsonl', Buffer.from(''));
      expect(client.files.get('transcripts/b/m/claude/f.jsonl')?.mimeType).toBe('application/x-ndjson');
    });

    test('sets correct MIME type for cursor (txt)', async () => {
      await store.upload('b', 'm', 'cursor', 'f.txt', Buffer.from(''));
      expect(client.files.get('transcripts/b/m/cursor/f.txt')?.mimeType).toBe('text/plain');
    });

    test('sets correct MIME type for gemini (json)', async () => {
      await store.upload('b', 'm', 'gemini', 'f.json', Buffer.from(''));
      expect(client.files.get('transcripts/b/m/gemini/f.json')?.mimeType).toBe('application/json');
    });

    test('overwrites existing file', async () => {
      await store.upload('b', 'm', 'claude', 'f.jsonl', Buffer.from('v1'));
      await store.upload('b', 'm', 'claude', 'f.jsonl', Buffer.from('v2'));
      const stored = client.files.get('transcripts/b/m/claude/f.jsonl');
      expect(stored?.content.toString()).toBe('v2');
    });

    test('rejects brainId with path traversal', async () => {
      await expect(
        store.upload('../../bad', 'm', 'claude', 'f.jsonl', Buffer.from('')),
      ).rejects.toThrow('invalid characters');
    });

    test('accepts relative path with embedded slash (project subdirectory)', async () => {
      // Daemon sends relative_path like "projects/-Users-.../session.jsonl"
      const result = await store.upload('b', 'm', 'claude', 'projects/hash/session.jsonl', Buffer.from(''));
      expect(result.key).toBe('transcripts/b/m/claude/projects/hash/session.jsonl');
      expect(result.status).toBe('pushed');
    });

    test('rejects filename with path traversal (..) in path', async () => {
      await expect(
        store.upload('b', 'm', 'claude', '../../../etc/passwd', Buffer.from('')),
      ).rejects.toThrow('path traversal');
    });

    test('rejects filename with embedded .. segment', async () => {
      await expect(
        store.upload('b', 'm', 'claude', 'subdir/../../../etc/shadow', Buffer.from('')),
      ).rejects.toThrow('path traversal');
    });
  });

  // ── appendChunk ────────────────────────────────────────────────────────

  describe('appendChunk', () => {
    test('non-final chunk stores doc in NoSQL, does not upload to Files', async () => {
      const chunk = Buffer.from('part1');
      const result = await store.appendChunk('b', 'm', 'claude', 'f.jsonl', chunk, 0, false);

      expect(result.status).toBe('appended');
      expect(client.totalDocCount).toBe(1);
      expect(client.files.size).toBe(0);
    });

    test('final chunk assembles all chunks in byte-offset order and uploads', async () => {
      const part1 = Buffer.from('hello ');
      const part2 = Buffer.from('world');

      await store.appendChunk('b', 'm', 'claude', 'f.jsonl', part1, 0, false);
      const result = await store.appendChunk('b', 'm', 'claude', 'f.jsonl', part2, 6, true);

      expect(result.status).toBe('pushed');
      const stored = client.files.get('transcripts/b/m/claude/f.jsonl');
      expect(stored?.content.toString('utf8')).toBe('hello world');
    });

    test('final chunk cleans up NoSQL chunk docs after assembly', async () => {
      await store.appendChunk('b', 'm', 'claude', 'f.jsonl', Buffer.from('a'), 0, false);
      await store.appendChunk('b', 'm', 'claude', 'f.jsonl', Buffer.from('b'), 1, true);

      expect(client.totalDocCount).toBe(0);
    });

    test('single-chunk upload (isFinal=true, offset=0) works correctly', async () => {
      const content = Buffer.from('single chunk content');
      const result = await store.appendChunk('b', 'm', 'codex', 'sess.jsonl', content, 0, true);

      expect(result.status).toBe('pushed');
      const stored = client.files.get('transcripts/b/m/codex/sess.jsonl');
      expect(stored?.content.toString()).toBe('single chunk content');
    });

    test('out-of-order chunk submission assembles correctly', async () => {
      const part2 = Buffer.from('world');
      const part1 = Buffer.from('hello ');

      // Submit second chunk first
      await store.appendChunk('b', 'm', 'claude', 'f.jsonl', part2, 6, false);
      // Then first chunk as final
      const result = await store.appendChunk('b', 'm', 'claude', 'f.jsonl', part1, 0, true);

      expect(result.status).toBe('pushed');
      const stored = client.files.get('transcripts/b/m/claude/f.jsonl');
      expect(stored?.content.toString('utf8')).toBe('hello world');
    });

    test('chunks from file A do not interfere with file B assembly', async () => {
      // Start chunked upload for file A (not final)
      await store.appendChunk('b', 'm', 'claude', 'fileA.jsonl', Buffer.from('A-part1 '), 0, false);

      // Complete a separate upload for file B
      await store.appendChunk('b', 'm', 'claude', 'fileB.jsonl', Buffer.from('B-only'), 0, true);

      // File B should contain only B's content
      const fileB = client.files.get('transcripts/b/m/claude/fileB.jsonl');
      expect(fileB?.content.toString()).toBe('B-only');

      // File A should not exist yet (still has pending chunks)
      expect(client.files.has('transcripts/b/m/claude/fileA.jsonl')).toBe(false);
    });

    test('input validation rejects filename with path traversal', async () => {
      await expect(
        store.appendChunk('b', 'm', 'claude', '../../../etc/passwd', Buffer.from('x'), 0, true),
      ).rejects.toThrow('path traversal');
    });

    test('accepts relative path with subdir for appendChunk', async () => {
      const result = await store.appendChunk('b', 'm', 'claude', 'projects/hash/session.jsonl', Buffer.from('data'), 0, true);
      expect(result.key).toBe('transcripts/b/m/claude/projects/hash/session.jsonl');
    });

    test('duplicate chunk at same byteOffset is deduplicated — last write wins, no corruption', async () => {
      // First submission of offset 0
      await store.appendChunk('b', 'm', 'claude', 'f.jsonl', Buffer.from('WRONG'), 0, false);
      // Retry (corrected content) at the same offset
      await store.appendChunk('b', 'm', 'claude', 'f.jsonl', Buffer.from('hello '), 0, false);
      // Final chunk
      await store.appendChunk('b', 'm', 'claude', 'f.jsonl', Buffer.from('world'), 6, true);

      const stored = client.files.get('transcripts/b/m/claude/f.jsonl');
      // Should be 'hello world', not 'WRONGhello world'
      expect(stored?.content.toString('utf8')).toBe('hello world');
    });
  });

  // ── list ───────────────────────────────────────────────────────────────

  describe('list', () => {
    beforeEach(async () => {
      await store.upload('brain1', 'mac', 'claude', 'a.jsonl', Buffer.from('a'));
      await store.upload('brain1', 'mac', 'codex', 'b.jsonl', Buffer.from('b'));
      await store.upload('brain1', 'laptop', 'cursor', 'c.txt', Buffer.from('c'));
      await store.upload('brain2', 'mac', 'claude', 'd.jsonl', Buffer.from('d'));
    });

    test('lists only files for the given brainId', async () => {
      const results = await store.list('brain1');
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.brain_id === 'brain1')).toBe(true);
    });

    test('filters by machineId', async () => {
      const results = await store.list('brain1', { machineId: 'laptop' });
      expect(results).toHaveLength(1);
      expect(results[0].machine_id).toBe('laptop');
    });

    test('filters by cli', async () => {
      const results = await store.list('brain1', { cli: 'claude' });
      expect(results).toHaveLength(1);
      expect(results[0].cli).toBe('claude');
    });

    test('filters by since — excludes files updated at or before the boundary', async () => {
      const storeWithDates = new TranscriptStore(client as never);
      const boundary = new Date('2026-02-20T12:00:00Z');

      client.seedFile('transcripts/b/m/claude/old.jsonl', 'old', '2026-02-20T11:59:59Z');
      client.seedFile('transcripts/b/m/claude/exact.jsonl', 'exact', '2026-02-20T12:00:00Z');
      client.seedFile('transcripts/b/m/claude/new.jsonl', 'new', '2026-02-20T12:00:01Z');

      const results = await storeWithDates.list('b', { since: boundary });
      const filenames = results.map((r) => r.filename);

      expect(filenames).not.toContain('old.jsonl');
      expect(filenames).not.toContain('exact.jsonl'); // boundary is exclusive (<=)
      expect(filenames).toContain('new.jsonl');
    });

    test('returns correct metadata shape', async () => {
      const results = await store.list('brain1', { machineId: 'mac', cli: 'claude' });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        key: 'transcripts/brain1/mac/claude/a.jsonl',
        filename: 'a.jsonl',
        cli: 'claude',
        machine_id: 'mac',
        brain_id: 'brain1',
        verification_state: 'legacy_unverified',
        archive_authority: false,
        eviction_eligible: false,
      });
      expect(typeof results[0].size).toBe('number');
      expect(typeof results[0].updated_at).toBe('string');
    });
  });

  // ── download ───────────────────────────────────────────────────────────

  describe('download', () => {
    test('returns correct buffer for known key', async () => {
      const content = Buffer.from('transcript content here');
      await store.upload('b', 'm', 'claude', 'f.jsonl', content);
      const key = 'transcripts/b/m/claude/f.jsonl';
      const result = await store.download(key);
      expect(result.toString()).toBe('transcript content here');
    });

    test('throws for unknown key', async () => {
      await expect(store.download('transcripts/x/y/claude/missing.jsonl')).rejects.toThrow('404');
    });
  });

  // ── getStatus ──────────────────────────────────────────────────────────

  describe('getStatus', () => {
    test('groups files by machineId', async () => {
      await store.upload('b', 'mac', 'claude', 'a.jsonl', Buffer.from('aa'));
      await store.upload('b', 'laptop', 'codex', 'b.jsonl', Buffer.from('bbb'));

      const status = await store.getStatus('b');
      expect(Object.keys(status.machines)).toHaveLength(2);
      expect(status.machines['mac']).toHaveLength(1);
      expect(status.machines['laptop']).toHaveLength(1);
    });

    test('returns correct total_files and total_bytes', async () => {
      await store.upload('b', 'm', 'claude', 'a.jsonl', Buffer.from('hello'));
      await store.upload('b', 'm', 'codex', 'b.jsonl', Buffer.from('world!'));

      const status = await store.getStatus('b');
      expect(status.total_files).toBe(2);
      expect(status.total_bytes).toBe(5 + 6);
    });

    test('returns empty machines for brain with no transcripts', async () => {
      const status = await store.getStatus('no-such-brain');
      expect(status.total_files).toBe(0);
      expect(status.total_bytes).toBe(0);
      expect(Object.keys(status.machines)).toHaveLength(0);
    });
  });

  // ── inlineThreshold ────────────────────────────────────────────────────

  test('inlineThreshold is 100_000', () => {
    expect(TranscriptStore.inlineThreshold).toBe(100_000);
  });
});
