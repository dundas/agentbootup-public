import { describe, expect, test, mock } from 'bun:test';
import { MechClient } from '../lib/mech-client';
import { BrainAssetStore } from '../lib/brain-asset-store';

/**
 * Test that listDocuments paginates through all results
 * when the Mech API returns more docs than a single page.
 */

function makeMechDoc(id: string, path: string, collection: string) {
  return {
    id,
    document: { path, _collection: collection },
  };
}

describe('MechClient.listDocuments pagination', () => {
  test('fetches all documents across multiple pages', async () => {
    const collection = 'brain_assets_test';
    // Generate 250 docs — should require 3 pages at PAGE_SIZE=100
    const allDocs = Array.from({ length: 250 }, (_, i) =>
      makeMechDoc(`doc-${i}`, `file-${i}.md`, collection),
    );

    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/nosql/documents')) {
        fetchCallCount++;
        const parsed = new URL(urlStr);
        const limit = parseInt(parsed.searchParams.get('limit') || '100', 10);
        const offset = parseInt(parsed.searchParams.get('offset') || '0', 10);

        const page = allDocs.slice(offset, offset + limit);
        return new Response(JSON.stringify({ success: true, data: page }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return originalFetch(url as any);
    }) as typeof fetch;

    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com',
        appId: 'test-app',
        apiKey: 'key',
        apiSecret: 'secret',
      });

      const result = await client.listDocuments(collection);

      expect(result.length).toBe(250);
      expect(fetchCallCount).toBe(3); // 100 + 100 + 50
      expect(result[0].id).toBe('doc-0');
      expect(result[249].id).toBe('doc-249');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns empty array for empty collection', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com',
        appId: 'test-app',
        apiKey: 'key',
        apiSecret: 'secret',
      });

      const result = await client.listDocuments('empty_collection');
      expect(result.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('filters out docs from other collections', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        success: true,
        data: [
          makeMechDoc('doc-1', 'a.md', 'target_collection'),
          makeMechDoc('doc-2', 'b.md', 'other_collection'),
          makeMechDoc('doc-3', 'c.md', 'target_collection'),
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com',
        appId: 'test-app',
        apiKey: 'key',
        apiSecret: 'secret',
      });

      const result = await client.listDocuments('target_collection');
      expect(result.length).toBe(2);
      expect(result[0].id).toBe('doc-1');
      expect(result[1].id).toBe('doc-3');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('generic enumeration is complete beyond the former 5,000-record cap', async () => {
    const collection = 'huge_collection';
    const originalFetch = globalThis.fetch;
    const total = 5_125;

    // Always return full pages (PAGE_SIZE=100) so the loop never breaks early
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const parsed = new URL(urlStr);
      const limit = parseInt(parsed.searchParams.get('limit') || '100', 10);
      const offset = parseInt(parsed.searchParams.get('offset') || '0', 10);

      const page = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
        makeMechDoc(`doc-${offset + i}`, `file-${offset + i}.md`, collection),
      );
      return new Response(JSON.stringify({ success: true, data: page }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com',
        appId: 'test-app',
        apiKey: 'key',
        apiSecret: 'secret',
      });

      expect(await client.listDocuments(collection)).toHaveLength(total);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('generic enumeration fails explicitly when the configured record budget is exceeded', async () => {
    const collection = 'budgeted_collection';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const parsed = new URL(typeof url === 'string' ? url : url instanceof URL ? url : url.url);
      const limit = Number(parsed.searchParams.get('limit'));
      const offset = Number(parsed.searchParams.get('offset'));
      const total = 251;
      const page = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
        makeMechDoc(`doc-${offset + i}`, `file-${offset + i}`, collection));
      return new Response(JSON.stringify({ success: true, data: page }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const exactClient = new MechClient({
        baseUrl: 'https://storage.example.com',
        appId: 'test-app',
        apiKey: 'key',
        apiSecret: 'secret',
        maxEnumerationRecords: 251,
      });
      expect(await exactClient.listDocuments(collection)).toHaveLength(251);

      const client = new MechClient({
        baseUrl: 'https://storage.example.com',
        appId: 'test-app',
        apiKey: 'key',
        apiSecret: 'secret',
        maxEnumerationRecords: 250,
      });
      await expect(client.listDocuments(collection)).rejects.toThrow(
        /enumeration record budget.*250.*budgeted_collection/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('secret cleanup performs no deletion when complete enumeration exceeds its budget', async () => {
    const brainId = 'budgeted-brain';
    const collection = `brain_assets_${brainId}`;
    const originalFetch = globalThis.fetch;
    let deleteCalls = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (init?.method === 'DELETE') {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      const limit = Number(parsed.searchParams.get('limit'));
      const offset = Number(parsed.searchParams.get('offset'));
      const total = 201;
      const page = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
        id: `secret-${offset + i}`,
        document: {
          path: `.staged-secret-${offset + i}`,
          asset_type: 'secret',
          cli: 'shared',
          _collection: collection,
        },
      }));
      return new Response(JSON.stringify({ success: true, data: page }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com',
        appId: 'test-app',
        apiKey: 'key',
        apiSecret: 'secret',
        maxEnumerationRecords: 200,
      });
      const store = new BrainAssetStore(client);
      await expect(store.deleteSecretAssets(brainId)).rejects.toThrow(
        /enumeration record budget/i,
      );
      expect(deleteCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('secret cleanup performs no deletion when a terminal page overlaps prior identities', async () => {
    const brainId = 'overlap-brain';
    const collection = `brain_assets_${brainId}`;
    const originalFetch = globalThis.fetch;
    let deleteCalls = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (init?.method === 'DELETE') {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      const offset = Number(parsed.searchParams.get('offset'));
      const indexes = offset === 0
        ? Array.from({ length: 100 }, (_, i) => i)
        : Array.from({ length: 50 }, (_, i) => i);
      const page = indexes.map((index) => ({
        id: `secret-${index}`,
        document: {
          path: `.staged-secret-${index}`,
          asset_type: 'secret',
          cli: 'shared',
          _collection: collection,
        },
      }));
      return new Response(JSON.stringify({ success: true, data: page }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com',
        appId: 'test-app',
        apiKey: 'key',
        apiSecret: 'secret',
      });
      const store = new BrainAssetStore(client);
      await expect(store.deleteSecretAssets(brainId)).rejects.toThrow(
        /repeated record identity/i,
      );
      expect(deleteCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('generic enumeration still fails closed on repeated pages', async () => {
    const collection = 'repeated_collection';
    const originalFetch = globalThis.fetch;
    const repeatedPage = Array.from({ length: 100 }, (_, i) =>
      makeMechDoc(`doc-${i}`, `file-${i}`, collection));
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ success: true, data: repeatedPage }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com',
        appId: 'test-app',
        apiKey: 'key',
        apiSecret: 'secret',
      });
      await expect(client.listDocuments(collection)).rejects.toThrow(/repeated a page/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('generic enumeration still fails closed when pagination makes no progress', async () => {
    const client = new MechClient({
      baseUrl: 'https://storage.example.com',
      appId: 'test-app',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    client.listDocumentsPage = mock(async () => ({
      documents: [],
      nextOffset: 0,
      exhausted: false,
      rawCount: 100,
      rawOrderKeys: Array.from({ length: 100 }, (_, i) => `doc-${i}`),
    }));
    await expect(client.listDocuments('stalled_collection')).rejects.toThrow(/made no progress/i);
  });

  test('exposes one explicit storage page and an opaque continuation offset', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const parsed = new URL(typeof url === 'string' ? url : url instanceof URL ? url : url.url);
      expect(parsed.searchParams.get('limit')).toBe('2');
      expect(parsed.searchParams.get('offset')).toBe('7');
      return new Response(JSON.stringify({ success: true, data: [
        makeMechDoc('doc-7', 'seven', 'target'),
        makeMechDoc('noise', 'noise', 'other'),
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const client = new MechClient({ baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret' });
      expect(await client.listDocumentsPage('target', { offset: 7, limit: 2 })).toEqual({
        documents: [makeMechDoc('doc-7', 'seven', 'target')],
        nextOffset: 9,
        exhausted: false,
        rawCount: 2,
        rawOrderKeys: ['doc-7', 'noise'],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('legacy transcript upload, list, and download use keyed or filtered index requests instead of a full scan', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ method: string; pathname: string; query: string; body?: unknown }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const value = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(value);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method: init?.method ?? 'GET', pathname: url.pathname, query: url.search, body });
      if (url.pathname.endsWith('/nosql/documents/transcript-file-index-v1-e2107e552fc2ead737b05c1987c28581df898cbaf17fca940b4f1b485174e8ef')) {
        return new Response(JSON.stringify({ success: true, data: {
          id: 'server-id',
          document_id: 'transcript-file-index-v1-e2107e552fc2ead737b05c1987c28581df898cbaf17fca940b4f1b485174e8ef',
          document: {
            storageKey: 'transcripts/brain/file-5000', objectId: 'object-5000', size: 5000,
            updatedAt: '2026-01-01T00:00:00.000Z', _collection: 'transcript_file_index',
          },
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/nosql/query')) {
        return new Response(JSON.stringify({ success: true, data: [{
          id: 'server-id',
          document_id: 'transcript-file-index-v1-e2107e552fc2ead737b05c1987c28581df898cbaf17fca940b4f1b485174e8ef',
          document: {
            storageKey: 'transcripts/brain/file-5000', objectId: 'object-5000', size: 5000,
            updatedAt: '2026-01-01T00:00:00.000Z', _collection: 'transcript_file_index',
          },
        }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/storage/objects') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true, data: { id: 'new-generation' } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/nosql/documents') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true, data: {
          id: 'server-id', document_id: body.document_id,
        } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.includes('/nosql/documents/transcript-file-index-v1-') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ success: true, data: null }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/storage/objects/object-5000/download')) {
        return new Response('restored transcript', { status: 200 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${value}`);
    }) as typeof fetch;
    try {
      const client = new MechClient({ baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret' });
      expect(await client.listFiles('transcripts/brain/')).toEqual([{
        key: 'transcripts/brain/file-5000', size: 5000, updatedAt: '2026-01-01T00:00:00.000Z',
      }]);
      expect((await client.downloadFile('transcripts/brain/file-5000')).toString()).toBe('restored transcript');
      expect(await client.uploadFile('transcripts/brain/file-5000', Buffer.from('replacement')))
        .toEqual({ key: 'transcripts/brain/file-5000', generation: 'new-generation' });
      expect(requests.some((request) => request.pathname.endsWith('/nosql/documents') && request.query.includes('limit=100'))).toBe(false);
      const indexQueries = requests.filter((request) => request.pathname.endsWith('/nosql/query'));
      expect(indexQueries).toHaveLength(2);
      expect(indexQueries[0]?.body).toEqual({
        collection_name: 'transcript_file_index',
        query: { storageKey: { $regex: '^transcripts/brain/' } },
        limit: 1000,
        offset: 0,
      });
      expect(indexQueries[1]?.body).toEqual({
        collection_name: 'transcript_file_index', query: { storageKey: 'transcripts/brain/file-5000' }, limit: 2, offset: 0,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('download selects the newest mapping when legacy and deterministic index rows coexist', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/nosql/query')) {
        return new Response(JSON.stringify({ success: true, data: [
          { id: 'legacy-id', document: { storageKey: 'transcripts/brain/session.jsonl', objectId: 'old', updatedAt: '2026-01-01T00:00:00.000Z', _collection: 'transcript_file_index' } },
          { id: 'deterministic-id', document: { storageKey: 'transcripts/brain/session.jsonl', objectId: 'new', updatedAt: '2026-01-02T00:00:00.000Z', _collection: 'transcript_file_index' } },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/storage/objects/new/download')) return new Response('new transcript', { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      const client = new MechClient({ baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret' });
      expect((await client.downloadFile('transcripts/brain/session.jsonl')).toString()).toBe('new transcript');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('immutable generation upload does not scan or mutate the logical-key index', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const value = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      calls++;
      expect(value).toEndWith('/storage/objects');
      return new Response(JSON.stringify({ success: true, data: { id: 'object-generation-1' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const client = new MechClient({ baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret' });
      expect(await client.uploadImmutableFile('archive/key', Buffer.from('bytes'))).toEqual({
        key: 'archive/key', generation: 'object-generation-1',
      });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('transcript index create conflicts use the deterministic update path without scanning', async () => {
    const originalFetch = globalThis.fetch;
    let updated = false;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/storage/objects')) {
        return new Response(JSON.stringify({ success: true, data: { id: 'new-generation' } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/nosql/documents') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: false, message: 'already exists' }), {
          status: 409, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.includes('/nosql/documents/transcript-file-index-v1-') && init?.method === 'PUT') {
        updated = true;
        return new Response(JSON.stringify({ success: true, data: null }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    }) as typeof fetch;
    try {
      const client = new MechClient({ baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret' });
      await expect(client.uploadFile('transcripts/brain/conflict.jsonl', Buffer.from('replacement'))).resolves.toEqual({
        key: 'transcripts/brain/conflict.jsonl', generation: 'new-generation',
      });
      expect(updated).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
