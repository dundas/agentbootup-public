import { describe, expect, test } from 'bun:test';
import { StorageSdkError } from '@mech/storage-sdk';
import { retryStorageRead, withStorageCasReadRetries } from '../lib/storage-read-retry';

describe('storage read retry', () => {
  test('retries a typed 429 read after its declared delay and never retries writes', async () => {
    let reads = 0;
    const delays: number[] = [];
    await expect(retryStorageRead(async () => {
      reads += 1;
      if (reads === 1) throw new StorageSdkError('rate limited', { status: 429, retryable: true, retryAfterMs: 12 });
      return 'current';
    }, { attempts: 1, maxDelayMs: 100, random: () => 0, sleep: async (delayMs) => { delays.push(delayMs); } })).resolves.toBe('current');
    expect(delays).toEqual([12]);

    let creates = 0;
    const cas = withStorageCasReadRetries({
      getDocument: async () => ({ ok: false as const, code: 'DOCUMENT_NOT_FOUND' as const }),
      createDocument: async () => { creates += 1; throw new StorageSdkError('rate limited', { status: 429, retryable: true, retryAfterMs: 0 }); },
      updateDocument: async () => ({ ok: false as const, code: 'DOCUMENT_NOT_FOUND' as const }),
    }, { attempts: 3, maxDelayMs: 100, sleep: async () => { throw new Error('writes must not sleep'); } });
    await expect(cas.createDocument({ collection: 'c', document_key: 'k', data: {}, metadata: {} })).rejects.toMatchObject({ status: 429 });
    expect(creates).toBe(1);
  });

  test('does not retry a delay above cap and passes abort signal to backoff', async () => {
    await expect(retryStorageRead(async () => {
      throw new StorageSdkError('rate limited', { status: 429, retryable: true, retryAfterMs: 101 });
    }, { attempts: 1, maxDelayMs: 100 })).rejects.toMatchObject({ retryAfterMs: 101 });

    const controller = new AbortController();
    await expect(retryStorageRead(async () => {
      throw new StorageSdkError('rate limited', { status: 429, retryable: true, retryAfterMs: 1 });
    }, { attempts: 1, maxDelayMs: 100, sleep: async (_delay, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('caller canceled'));
      throw controller.signal.reason;
    } }, controller.signal)).rejects.toThrow('caller canceled');
  });
});
