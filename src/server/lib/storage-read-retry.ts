import { StorageSdkError, type CasCreateBody, type CasCreateResult, type CasGetResult, type CasUpdateBody, type CasUpdateResult } from '@mech/storage-sdk';

export interface StorageReadRetryPolicy {
  attempts: number;
  maxDelayMs: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface StorageCasReadClient {
  getDocument(collection: string, documentKey: string): Promise<CasGetResult>;
  createDocument(body: CasCreateBody): Promise<CasCreateResult>;
  updateDocument(collection: string, documentKey: string, body: CasUpdateBody): Promise<CasUpdateResult>;
}

function sleepAbortably(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Mech Storage read retry aborted', 'AbortError'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Mech Storage read retry aborted', 'AbortError'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function boundedStorageReadDelay(error: unknown, policy: StorageReadRetryPolicy): number | null {
  if (!(error instanceof StorageSdkError) || error.status !== 429 || !Number.isSafeInteger(error.retryAfterMs)
    || error.retryAfterMs === undefined || error.retryAfterMs < 0 || error.retryAfterMs > policy.maxDelayMs) return null;
  const headroom = policy.maxDelayMs - error.retryAfterMs;
  const jitterCeiling = Math.min(headroom, 1_000, Math.ceil(error.retryAfterMs / 10));
  return error.retryAfterMs + Math.floor((policy.random ?? Math.random)() * Math.max(1, jitterCeiling));
}

/** Retry only a known-uncommitted, idempotent storage read. Never use for mutations. */
export async function retryStorageRead<T>(read: () => Promise<T>, policy: StorageReadRetryPolicy, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      const delayMs = attempt < policy.attempts ? boundedStorageReadDelay(error, policy) : null;
      if (delayMs === null) throw error;
      await (policy.sleep ?? sleepAbortably)(delayMs, signal);
    }
  }
}

/** Preserve one-shot create/update semantics while retrying only CAS GET reads. */
export function withStorageCasReadRetries(cas: StorageCasReadClient, policy: StorageReadRetryPolicy): StorageCasReadClient {
  return {
    getDocument: (collection, documentKey) => retryStorageRead(() => cas.getDocument(collection, documentKey), policy),
    createDocument: (body) => cas.createDocument(body),
    updateDocument: (collection, documentKey, body) => cas.updateDocument(collection, documentKey, body),
  };
}
