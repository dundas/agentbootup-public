import { describe, expect, test } from 'bun:test';
import { ArchiveClientError, TranscriptArchiveClient } from '../../lib/transcript-archive/client.js';

function json(data: unknown, status = 200) {
  return Response.json(status >= 400 ? data : { data }, { status });
}

describe('TranscriptArchiveClient', () => {
  test('uses stable idempotency keys and retries transient timeouts', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new TranscriptArchiveClient({
      serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 2, retryBaseMs: 10,
      sleep: async () => {}, random: () => 0,
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (calls.length === 1) return json({ error: { code: 'unavailable', message: 'try later' } }, 503);
        return json({ uploadId: `up_${'a'.repeat(64)}`, totalParts: 1, receivedParts: [] }, 201);
      },
    });
    const manifest = { logicalIdentity: { brainId: 'brain', provider: 'codex', sessionId: 'one' } };
    await expect(client.declare(manifest)).resolves.toHaveProperty('totalParts', 1);
    expect(calls).toHaveLength(2);
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key'])
      .toBe((calls[1]!.init.headers as Record<string, string>)['idempotency-key']);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  test('maps auth and verification failures without exposing response bodies', async () => {
    const auth = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => json({ error: { code: 'forbidden', message: 'denied' } }, 403) });
    await expect(auth.capabilities('brain')).rejects.toMatchObject({ code: 'AUTH_ERROR', exitCode: 3 });

    const verify = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => json({ error: { code: 'archive_content_hash_mismatch', message: 'bad bytes' } }, 422) });
    await expect(verify.verifyCommitted('brain', `av_${'a'.repeat(64)}`))
      .rejects.toMatchObject({ exitCode: 7 });
  });

  test('rejects successful non-envelope JSON', async () => {
    const client = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => Response.json({ items: [] }) });
    await expect(client.capabilities('brain')).rejects.toBeInstanceOf(ArchiveClientError);
  });

  test('streams committed restore bytes through the bounded authenticated content route', async () => {
    const chunks: Buffer[] = [];
    let observedHeaders: Record<string, string> | undefined;
    const client = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 3,
      responseByteLimit: 6, fetch: async (_url, init) => {
        observedHeaders = init?.headers as Record<string, string>;
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(Buffer.from('abc')); controller.enqueue(Buffer.from('def')); controller.close();
        } }), { headers: { 'content-type': 'application/octet-stream' } });
      } });
    await expect(client.downloadCommitted('brain-a', `av_${'a'.repeat(64)}`, { write: async (chunk: Buffer) => chunks.push(chunk) }))
      .resolves.toEqual({ byteSize: 6 });
    expect(Buffer.concat(chunks).toString()).toBe('abcdef');
    expect(observedHeaders?.Authorization).toBe('Bearer secret');
    expect(observedHeaders?.['idempotency-key']).toMatch(/^ab_restore_/);
  });

  test('restore content and terminal outcome share one idempotent operation binding', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const versionId = `av_${'a'.repeat(64)}`;
    const client = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return String(url).endsWith('/content') ? new Response('body') : json({ archiveVersionId: versionId, outcome: 'restored' });
      } });
    await client.beginRestoreAttempt('brain-a', versionId, 'operation-one');
    await client.downloadCommitted('brain-a', versionId, { write: async () => {} }, 'operation-one');
    await client.reportRestoreOutcome('brain-a', versionId, 'operation-one', 'restored', null);
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key'])
      .toBe((calls[1]!.init.headers as Record<string, string>)['idempotency-key']);
    expect((calls[1]!.init.headers as Record<string, string>)['idempotency-key'])
      .toBe((calls[2]!.init.headers as Record<string, string>)['idempotency-key']);
    expect((calls[1]!.init.headers as Record<string, string>)['x-agentbootup-read-purpose']).toBe('restore');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ outcome: 'restored', reason: null });
    expect(calls[0]!.url).toEndWith('/restore-attempt');
    expect(calls[2]!.url).toEndWith('/restore-outcome');
  });

  test('awaits streamed bodies inside timeout and retry scope and resets partial attempts', async () => {
    const chunks: Buffer[] = [];
    let calls = 0;
    const client = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 1,
      retryBaseMs: 0, sleep: async () => {}, responseByteLimit: 20, fetch: async () => {
        calls++;
        return new Response(new ReadableStream({ async pull(controller) {
          controller.enqueue(Buffer.from(calls === 1 ? 'bad' : 'good'));
          if (calls === 1) controller.error(new Error('interrupted body'));
          else controller.close();
        } }));
      } });
    await client.downloadCommitted('brain-a', `av_${'b'.repeat(64)}`, {
      reset: async () => { chunks.length = 0; }, write: async (chunk: Buffer) => chunks.push(chunk),
    });
    expect(calls).toBe(2);
    expect(Buffer.concat(chunks).toString()).toBe('good');
  });

  test('does not retry or reclassify local restore sink failures', async () => {
    let calls = 0;
    const diskError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const client = new TranscriptArchiveClient({
      serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 3,
      retryBaseMs: 0, sleep: async () => {},
      fetch: async () => { calls++; return new Response('content'); },
    });
    await expect(client.downloadCommitted('brain-a', `av_${'c'.repeat(64)}`, {
      reset: async () => {}, write: async () => { throw diskError; },
    })).rejects.toBe(diskError);
    expect(calls).toBe(1);
  });

  test('validates authorized brain discovery and request/restore byte ceilings', async () => {
    let brainPage = 0;
    const brains = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => brainPage++ === 0
        ? json({ brains: [{ id: 'brain-a' }, { id: 'brain-a' }], nextCursor: 'page-2' })
        : json({ brains: [{ id: 'brain-b' }], nextCursor: null }) });
    await expect(brains.listBrains()).resolves.toEqual(['brain-a', 'brain-b']);

    const requestBound = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret',
      requestByteLimit: 64, retryLimit: 0, fetch: async () => { throw new Error('must not fetch'); } });
    expect(() => requestBound.declare({ value: 'x'.repeat(100) })).toThrow(/request byte limit/i);

    const responseBound = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret',
      responseByteLimit: 4, retryLimit: 0, fetch: async () => new Response('12345', {
        headers: { 'content-type': 'application/octet-stream', 'content-length': '5' },
      }) });
    await expect(responseBound.readCommitted('brain-a', `av_${'a'.repeat(64)}`)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE', exitCode: 7,
    });

    const jsonBound = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret',
      jsonResponseByteLimit: 16, retryLimit: 0, fetch: async () => json({ value: 'x'.repeat(100) }) });
    await expect(jsonBound.capabilities('brain-a')).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE', exitCode: 6,
    });

    const cycling = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => json({ brains: [], nextCursor: 'same-page' }) });
    await expect(cycling.listBrains()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', exitCode: 6 });

    let invalidBrainCursorCalls = 0;
    const invalidBrainCursor = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => { invalidBrainCursorCalls++; return json({ brains: [], nextCursor: { page: 2 } }); } });
    await expect(invalidBrainCursor.listBrains()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', exitCode: 6 });
    expect(invalidBrainCursorCalls).toBe(1);

    const oversizedBrainCursor = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => json({ brains: [], nextCursor: 'x'.repeat(1025) }) });
    await expect(oversizedBrainCursor.listBrains()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', exitCode: 6 });

    let emptyPage = 0;
    const emptyProgress = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      inventoryMaxEmptyPages: 2, fetch: async () => json({ brains: [], nextCursor: `page-${++emptyPage}` }) });
    await expect(emptyProgress.listBrains()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', exitCode: 6 });
    expect(emptyPage).toBe(3);
  });

  test('bounds archive inventory pagination and rejects invalid cursors', async () => {
    const cycling = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => json({ items: [], nextCursor: 'same-page' }) });
    await expect(cycling.inventory('brain-a')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', exitCode: 6 });

    let itemPage = 0;
    const itemBound = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      inventoryMaxItems: 2, fetch: async () => json({ items: [itemPage++], nextCursor: `page-${itemPage}` }) });
    await expect(itemBound.inventory('brain-a')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', exitCode: 6 });
    expect(itemPage).toBe(3);

    const invalidCursor = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => json({ items: [], nextCursor: 42 }) });
    await expect(invalidCursor.inventory('brain-a')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', exitCode: 6 });

    const oversizedCursor = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      fetch: async () => json({ items: [], nextCursor: 'x'.repeat(1025) }) });
    await expect(oversizedCursor.inventory('brain-a')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', exitCode: 6 });

    const restarting = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 1,
      fetch: async () => json({}) });
    let restartCalls = 0;
    (restarting as any).inventoryPage = async () => {
      restartCalls++;
      if (restartCalls === 1) return { items: ['stale'], nextCursor: 'page-2' };
      if (restartCalls === 2) throw new ArchiveClientError('restart', { code: 'archive_inventory_restart_required', exitCode: 5 });
      return { items: ['fresh'], nextCursor: null };
    };
    await expect(restarting.inventory('brain-a')).resolves.toEqual(['fresh']);
    expect(restartCalls).toBe(3);

    let pageCalls = 0;
    const pageBound = new TranscriptArchiveClient({ serverUrl: 'https://archive.example', apiKey: 'secret', retryLimit: 0,
      inventoryMaxPages: 2, fetch: async () => json({ items: [], nextCursor: `page-${++pageCalls}` }) });
    await expect(pageBound.inventory('brain-a')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', exitCode: 6 });
    expect(pageCalls).toBe(2);
  });
});
