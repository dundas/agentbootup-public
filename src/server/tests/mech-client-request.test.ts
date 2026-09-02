import { describe, expect, mock, test } from 'bun:test';
import { brainAssetMetadataSnapshotRecordLimit, MechClient, MechStorageError } from '../lib/mech-client';

function makeClient() {
  return new MechClient({
    baseUrl: 'https://storage.example.com',
    appId: 'test-app',
    apiKey: 'key',
    apiSecret: 'secret',
  });
}

describe('MechClient request body handling', () => {
  test('uses a bounded configurable metadata snapshot record limit', () => {
    const previous = process.env.AGENTBOOTUP_BRAIN_ASSET_METADATA_SNAPSHOT_MAX_RECORDS;
    try {
      process.env.AGENTBOOTUP_BRAIN_ASSET_METADATA_SNAPSHOT_MAX_RECORDS = '17';
      expect(brainAssetMetadataSnapshotRecordLimit()).toBe(17);
      process.env.AGENTBOOTUP_BRAIN_ASSET_METADATA_SNAPSHOT_MAX_RECORDS = '1001';
      expect(brainAssetMetadataSnapshotRecordLimit()).toBe(500);
    } finally {
      if (previous === undefined) delete process.env.AGENTBOOTUP_BRAIN_ASSET_METADATA_SNAPSHOT_MAX_RECORDS;
      else process.env.AGENTBOOTUP_BRAIN_ASSET_METADATA_SNAPSHOT_MAX_RECORDS = previous;
    }
  });

  test('uses the existing app-scoped SQL primitive for a fixed, metadata-only brain asset snapshot', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = mock(async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        success: true,
        rows: [{ snapshot_status: 'ok', records: [{
          id: '00000000-0000-4000-8000-000000000001', document_id: 'brain/a.md',
          _collection: 'brain_assets_decisive.gm', path: 'brain/a.md', hash: 'a'.repeat(64), size: 3,
          asset_type: 'memory', cli: 'codex', synced_at: '2026-08-13T00:00:00.000Z',
          _record_kind: null, content_representation: 'inline', declared_encoded_size: 4,
        }] }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.readBrainAssetMetadataSnapshot('brain_assets_decisive.gm', 100)).resolves.toEqual({
        complete: true,
        records: [expect.objectContaining({ path: 'brain/a.md', content_representation: 'inline' })],
      });
      expect(requestUrl).toBe('https://storage.example.com/api/apps/test-app/postgresql/query');
      expect(requestBody).toMatchObject({ params: ['brain_assets_decisive.gm', 100] });
      expect((requestBody?.sql as string)).toContain('FROM documents');
      expect((requestBody?.sql as string)).not.toContain("document->>'content',");
      expect((requestBody?.sql as string)).not.toContain("'content_chunks' AS");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails closed for overflow and before parsing an oversized metadata snapshot response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      success: true, rows: [{ snapshot_status: 'snapshot_overflow', records: [] }],
    }), { status: 200 })) as typeof fetch;
    try {
      await expect(makeClient().readBrainAssetMetadataSnapshot('brain_assets_brain-a', 2)).rejects.toThrow('snapshot overflowed');
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = mock(async () => new Response('x'.repeat(1_048_577), {
      status: 200, headers: { 'content-length': '1048577' },
    })) as typeof fetch;
    try {
      await expect(makeClient().readBrainAssetMetadataSnapshot('brain_assets_brain-a', 2)).rejects.toThrow('exceeded its byte limit');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('downloads a bounded trusted text blob without forwarding storage credentials', async () => {
    const originalFetch = globalThis.fetch;
    const text = Buffer.from('brain bytes').toString('base64');
    let requestInit: RequestInit | undefined;
    globalThis.fetch = mock(async (_url, init) => {
      requestInit = init;
      return new Response(text, {
        status: 200,
        headers: { 'content-length': String(Buffer.byteLength(text)) },
      });
    }) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.readBlobRefText({
        __type: 'blob_ref',
        provider: 'r2',
        contentType: 'text/plain',
        key: 'document-blobs/test-app/brain_assets/doc/content',
        size: Buffer.byteLength(text),
        url: 'https://account.r2.cloudflarestorage.com/object?signature=redacted',
      }, 1024)).resolves.toBe(text);
      expect(requestInit?.redirect).toBe('error');
      expect(requestInit?.headers).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('retries bounded 429s for raw blob and immutable-generation reads', async () => {
    const originalFetch = globalThis.fetch;
    const delays: number[] = [];
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1 || calls === 3) {
        return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
      }
      return new Response(calls === 2 ? 'blob' : 'archive');
    }) as typeof fetch;

    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret',
        readRetryAttempts: 1, readRetryMaxDelayMs: 100, random: () => 0,
        sleep: async (delayMs) => { delays.push(delayMs); },
      });
      await expect(client.readBlobRefText({
        __type: 'blob_ref', provider: 'r2', contentType: 'text/plain',
        key: 'document-blobs/test-app/brain_assets/doc/content', size: 4,
        url: 'https://account.r2.cloudflarestorage.com/object',
      }, 10)).resolves.toBe('blob');
      await expect(client.downloadFileGeneration('immutable-generation')).resolves.toEqual(Buffer.from('archive'));
      expect(calls).toBe(4);
      expect(delays).toEqual([0, 0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects untrusted or cross-app text blob references before fetching', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response('unexpected');
    }) as typeof fetch;
    const baseRef = {
      __type: 'blob_ref', provider: 'r2', contentType: 'text/plain',
      key: 'document-blobs/test-app/brain_assets/doc/content', size: 4,
    };

    try {
      const client = makeClient();
      await expect(client.readBlobRefText({
        ...baseRef, url: 'http://account.r2.cloudflarestorage.com/object',
      }, 10)).rejects.toThrow('untrusted text blob URL');
      await expect(client.readBlobRefText({
        ...baseRef, url: 'https://r2.cloudflarestorage.com.evil.example/object',
      }, 10)).rejects.toThrow('untrusted text blob URL');
      await expect(client.readBlobRefText({
        ...baseRef,
        key: 'document-blobs/another-app/brain_assets/doc/content',
        url: 'https://account.r2.cloudflarestorage.com/object',
      }, 10)).rejects.toThrow('invalid text blob reference');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects text blob bodies that exceed or disagree with the declared size', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response('12345', { status: 200 })) as typeof fetch;
    try {
      const client = makeClient();
      await expect(client.readBlobRefText({
        __type: 'blob_ref', provider: 'r2', contentType: 'text/plain',
        key: 'document-blobs/test-app/brain_assets/doc/content', size: 4,
        url: 'https://account.r2.cloudflarestorage.com/object',
      }, 10)).rejects.toThrow('exceeded its declared length');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reports plain-text error responses without crashing on json.message', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response('upstream unavailable', {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      })) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.listDocuments('brain_assets')).rejects.toThrow(
        'Mech Storage GET /nosql/documents?collection_name=brain_assets&limit=100&offset=0 failed (502): (empty or non-JSON response body)',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reports empty error responses without crashing on json.message', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response('', {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.listDocuments('brain_assets')).rejects.toThrow(
        'Mech Storage GET /nosql/documents?collection_name=brain_assets&limit=100&offset=0 failed (500): (empty or non-JSON response body)',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('propagates HTTP status on storage errors', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ success: false, error: 'duplicate' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.createDocumentWithId('agentbootup_runtime_leases', 'runtime_lease_decisive-gm', {
        agentId: 'decisive-gm',
      })).rejects.toMatchObject({
        name: 'MechStorageError',
        status: 409,
        method: 'POST',
        path: '/nosql/documents',
      } satisfies Partial<MechStorageError>);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('retries only a bounded read 429 after the typed service delay', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const delays: number[] = [];
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED', retryAfterMs: 12 } }), {
          status: 429, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret',
        readRetryAttempts: 1, readRetryMaxDelayMs: 100, random: () => 0, sleep: async (delayMs) => { delays.push(delayMs); },
      });
      await expect(client.listDocuments('brain_assets')).resolves.toEqual([]);
      expect(calls).toBe(2);
      expect(delays).toEqual([12]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('honors standard HTTP-date Retry-After values and aborts a pending backoff', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const delays: number[] = [];
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ success: false }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': 'Thu, 01 Jan 1970 00:00:02 GMT' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret',
        readRetryAttempts: 1, readRetryMaxDelayMs: 2_000, random: () => 0, now: () => 1_000,
        sleep: async (delayMs) => { delays.push(delayMs); },
      });
      await expect(client.listDocuments('brain_assets')).resolves.toEqual([]);
      expect(delays).toEqual([1_000]);

      const controller = new AbortController();
      globalThis.fetch = mock(async () => new Response(JSON.stringify({ success: false, error: { retryAfterMs: 1 } }), {
        status: 429, headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
      const abortingClient = new MechClient({
        baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret',
        readRetryAttempts: 1, readRetryMaxDelayMs: 100,
        sleep: async (_delayMs, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort(new Error('caller canceled'));
          throw controller.signal.reason;
        },
      });
      await expect(abortingClient.listDocumentsPage('brain_assets', { signal: controller.signal })).rejects.toThrow('caller canceled');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('never retries a write or a service delay above the configured read cap', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response(JSON.stringify({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED', retryAfterMs: 101 } }), {
        status: 429, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const client = new MechClient({
        baseUrl: 'https://storage.example.com', appId: 'test-app', apiKey: 'key', apiSecret: 'secret',
        readRetryAttempts: 1, readRetryMaxDelayMs: 100, sleep: async () => { throw new Error('must not sleep'); },
      });
      await expect(client.createDocument('brain_assets', { id: 'a' })).rejects.toMatchObject({
        status: 429, retryAfterMs: 101,
      } satisfies Partial<MechStorageError>);
      expect(calls).toBe(1);
      await expect(client.listDocuments('brain_assets')).rejects.toMatchObject({
        status: 429, retryAfterMs: 101,
      } satisfies Partial<MechStorageError>);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws an explicit error for non-JSON success responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response('ok', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.listDocuments('brain_assets')).rejects.toThrow(
        'Mech Storage GET /nosql/documents?collection_name=brain_assets&limit=100&offset=0 returned status 200 but body was not valid JSON',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not swallow non-SyntaxError response parsing failures', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      status: 500,
      ok: false,
      json: async () => {
        throw new TypeError('stream interrupted');
      },
    })) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.listDocuments('brain_assets')).rejects.toThrow('stream interrupted');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('libsql.provision throws when wrapper returns incomplete credentials', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.libsql().provision({ namespace: 'decisive' })).rejects.toThrow(
        'Mech Storage POST /libsql/provision returned incomplete credentials',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('libsql.provision accepts legacy snake_case wrapper fields', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        success: true,
        data: {
          db_url: 'https://storage.example.com/api/apps/test-app/libsql/decisive',
          db_token: 'wrapper-token',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.libsql().provision({ namespace: 'decisive' })).resolves.toEqual({
        syncUrl: 'https://storage.example.com/api/apps/test-app/libsql/decisive',
        authToken: 'wrapper-token',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('createDocumentWithId sends deterministic key as document_id and returns the echoed key', async () => {
    // Contract (verified against live mech-storage 2026-07-05): the caller-supplied
    // deterministic key travels in the `document_id` field — NOT `id`, which the
    // server ignores on write and always replaces with a fresh UUID.
    const originalFetch = globalThis.fetch;
    let sentBody: Record<string, unknown> | null = null;
    globalThis.fetch = mock(async (_url, init) => {
      sentBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          success: true,
          data: { id: 'server-assigned-uuid', document_id: 'runtime_lease_decisive-gm' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.createDocumentWithId('agentbootup_runtime_leases', 'runtime_lease_decisive-gm', {
        agentId: 'decisive-gm',
        _collection: 'wrong_collection',
      })).resolves.toBe('runtime_lease_decisive-gm');
      expect(sentBody?.collection_name).toBe('agentbootup_runtime_leases');
      expect(sentBody?.document_id).toBe('runtime_lease_decisive-gm');
      expect(sentBody?.id).toBeUndefined();
      expect((sentBody?.data as Record<string, unknown>)._collection).toBe('agentbootup_runtime_leases');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('createDocumentWithId rejects a mismatched stored document_id', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ success: true, data: { id: 'uuid', document_id: 'different-id' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.createDocumentWithId('agentbootup_runtime_leases', 'runtime_lease_decisive-gm', {
        agentId: 'decisive-gm',
      })).rejects.toThrow("stored document_id 'different-id' for requested deterministic id 'runtime_lease_decisive-gm'");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('createDocumentWithId rejects a missing document_id', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ success: true, data: { id: 'uuid-only' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const client = makeClient();
      await expect(client.createDocumentWithId('agentbootup_runtime_leases', 'runtime_lease_decisive-gm', {
        agentId: 'decisive-gm',
      })).rejects.toThrow("did not return a document_id for requested deterministic id 'runtime_lease_decisive-gm'");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('getDocument unwraps the GET-by-id blob-metadata envelope to the flat payload', async () => {
    // GET-by-id wraps the payload as { data, wasDowngraded, blobCount, ... };
    // LIST returns it flat. Consumers expect the flat payload from both.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'server-uuid',
            document_id: 'runtime_lease_decisive-gm',
            document: {
              data: { agentId: 'decisive-gm', status: 'active', _collection: 'agentbootup_runtime_leases' },
              wasDowngraded: false,
              blobCount: 0,
              totalSizeBytes: 0,
              failedBlobCount: 0,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    try {
      const client = makeClient();
      const doc = await client.getDocument('runtime_lease_decisive-gm');
      expect(doc?.id).toBe('server-uuid');
      expect(doc?.document_id).toBe('runtime_lease_decisive-gm');
      expect(doc?.document).toEqual({
        agentId: 'decisive-gm',
        status: 'active',
        _collection: 'agentbootup_runtime_leases',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('updateDocument and deleteDocument forward the given key as the path segment', async () => {
    // The path accepts either the server id or the document_id (verified live
    // 2026-07-05), so brain-branch-store can pass document_id for both keyed and
    // auto-created rows. Assert the client forwards whatever key it is given.
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    globalThis.fetch = mock(async (url, init) => {
      paths.push(new URL(url as string).pathname);
      void init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      const client = makeClient();
      await client.updateDocument('03082ad7-random-document-id', 'agentbootup_brain_branches', { v: 2 });
      await client.deleteDocument('brain_branch_deterministic');
      expect(paths).toEqual([
        '/api/apps/test-app/nosql/documents/03082ad7-random-document-id',
        '/api/apps/test-app/nosql/documents/brain_branch_deterministic',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('getDocument leaves a flat (already-unwrapped) document untouched', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'server-uuid',
            document_id: 'runtime_lease_decisive-gm',
            document: { agentId: 'decisive-gm', status: 'active' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    try {
      const client = makeClient();
      const doc = await client.getDocument('runtime_lease_decisive-gm');
      expect(doc?.document).toEqual({ agentId: 'decisive-gm', status: 'active' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
