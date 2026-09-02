import { createHash, randomUUID } from 'crypto';

export const TRANSCRIPT_EXIT_CODES = Object.freeze({
  INTERNAL: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  UPSTREAM: 6,
  VERIFICATION: 7,
  TIMEOUT: 124,
});

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class ArchiveClientError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ArchiveClientError';
    this.code = options.code ?? 'UPSTREAM_ERROR';
    this.exitCode = options.exitCode ?? TRANSCRIPT_EXIT_CODES.UPSTREAM;
    this.retryable = options.retryable === true;
    this.status = options.status;
  }
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mapHttpFailure(status, body) {
  const serverCode = body && typeof body === 'object'
    ? (typeof body.error === 'string' ? body.error : typeof body.error?.code === 'string' ? body.error.code : '') : '';
  if (status === 401 || status === 403) return new ArchiveClientError('archive authorization failed', { code: 'AUTH_ERROR', exitCode: 3, status });
  if (status === 404) return new ArchiveClientError('archive object was not found', { code: 'NOT_FOUND', exitCode: 4, status });
  if (status === 409) return new ArchiveClientError('archive operation conflicted', { code: serverCode || 'CONFLICT', exitCode: 5, status, retryable: serverCode === 'archive_inventory_restart_required' });
  if (status === 408 || status === 504) return new ArchiveClientError('archive request timed out', { code: 'TIMEOUT', exitCode: 124, status, retryable: true });
  if (status === 422 || serverCode.includes('verification') || serverCode.includes('corrupt') || serverCode.includes('hash')) {
    return new ArchiveClientError('archive verification failed', { code: serverCode || 'VERIFICATION_FAILED', exitCode: 7, status });
  }
  return new ArchiveClientError(`archive service request failed with HTTP ${status}`, {
    code: serverCode || 'UPSTREAM_ERROR', exitCode: 6, status, retryable: RETRYABLE_STATUS.has(status),
  });
}

function idempotencyKey(operation, stableKey) {
  return `ab_${operation}_${sha(stableKey).slice(0, 48)}`;
}

async function readBoundedResponse(response, limit, { message, code, exitCode }) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ArchiveClientError(message, { code, exitCode });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let byteSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteSize += value.byteLength;
    if (byteSize > limit) {
      await reader.cancel().catch(() => {});
      throw new ArchiveClientError(message, { code, exitCode });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, byteSize);
}

async function streamBoundedResponse(response, limit, sink, { message, code, exitCode }) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new ArchiveClientError(message, { code, exitCode });
  if (!response.body) return { byteSize: 0 };
  const reader = response.body.getReader();
  let byteSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteSize += value.byteLength;
    if (byteSize > limit) {
      await reader.cancel().catch(() => {});
      throw new ArchiveClientError(message, { code, exitCode });
    }
    await sink(Buffer.from(value));
  }
  return { byteSize };
}

class LocalByteSinkError extends Error {
  constructor(cause) {
    super('local restore sink failed', { cause });
    this.name = 'LocalByteSinkError';
  }
}

export class TranscriptArchiveClient {
  constructor(options) {
    if (!options?.serverUrl || !options?.apiKey) throw new TypeError('archive client requires serverUrl and apiKey');
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryLimit = options.retryLimit ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.requestByteLimit = options.requestByteLimit ?? 4 * 1024 * 1024;
    this.jsonResponseByteLimit = options.jsonResponseByteLimit ?? this.requestByteLimit;
    this.responseByteLimit = options.responseByteLimit ?? options.eligibilityByteLimit ?? 256 * 1024 * 1024;
    this.inventoryMaxPages = options.inventoryMaxPages ?? 1_000;
    this.inventoryMaxItems = options.inventoryMaxItems ?? 100_000;
    this.inventoryMaxEmptyPages = options.inventoryMaxEmptyPages ?? 100;
    if (!Number.isSafeInteger(this.inventoryMaxPages) || this.inventoryMaxPages < 1
      || !Number.isSafeInteger(this.inventoryMaxItems) || this.inventoryMaxItems < 1
      || !Number.isSafeInteger(this.inventoryMaxEmptyPages) || this.inventoryMaxEmptyPages < 1) {
      throw new TypeError('archive inventory limits must be positive safe integers');
    }
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async request(pathname, options = {}) {
    const attempts = options.retry === false ? 1 : this.retryLimit + 1;
    let last;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('archive request timeout')), this.timeoutMs);
      const headers = { Authorization: `Bearer ${this.apiKey}`, ...(options.headers ?? {}) };
      try {
        const response = await this.fetch(`${this.serverUrl}${pathname}`, {
          method: options.method ?? 'GET', headers, body: options.body, signal: controller.signal,
        });
        let body;
        const contentType = response.headers.get('content-type') ?? '';
        if (options.byteSink && response.ok) {
          try {
            await options.beforeByteAttempt?.();
          } catch (error) {
            throw new LocalByteSinkError(error);
          }
          const localSink = async (chunk) => {
            try {
              await options.byteSink(chunk);
            } catch (error) {
              throw new LocalByteSinkError(error);
            }
          };
          return await streamBoundedResponse(response, this.responseByteLimit, localSink, {
            message: 'archive response exceeds the configured verification byte limit',
            code: 'RESPONSE_TOO_LARGE', exitCode: TRANSCRIPT_EXIT_CODES.VERIFICATION,
          });
        }
        if (options.bytes === true && response.ok) {
          return await readBoundedResponse(response, this.responseByteLimit, {
            message: 'archive response exceeds the configured verification byte limit',
            code: 'RESPONSE_TOO_LARGE', exitCode: TRANSCRIPT_EXIT_CODES.VERIFICATION,
          });
        }
        if (contentType.includes('application/json')) {
          const encoded = await readBoundedResponse(response, this.jsonResponseByteLimit, {
            message: 'archive JSON response exceeds the configured byte limit',
            code: 'RESPONSE_TOO_LARGE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM,
          });
          try { body = JSON.parse(encoded.toString('utf8')); } catch { body = null; }
        }
        if (!response.ok) throw mapHttpFailure(response.status, body);
        if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'data')) {
          throw new ArchiveClientError('archive service returned an invalid response envelope', { code: 'INVALID_RESPONSE', exitCode: 6 });
        }
        return body.data;
      } catch (error) {
        if (error instanceof LocalByteSinkError) throw error.cause;
        const mapped = error instanceof ArchiveClientError
          ? error
          : new ArchiveClientError(error?.name === 'AbortError' || controller.signal.aborted ? 'archive request timed out' : 'archive service request failed', {
            cause: error, code: controller.signal.aborted ? 'TIMEOUT' : 'UPSTREAM_ERROR',
            exitCode: controller.signal.aborted ? 124 : 6, retryable: true,
          });
        last = mapped;
        if (!mapped.retryable || attempt + 1 >= attempts) throw mapped;
        const cap = this.retryBaseMs * (2 ** attempt);
        await this.sleep(Math.floor(cap / 2 + this.random() * cap / 2));
      } finally {
        clearTimeout(timer);
      }
    }
    throw last;
  }

  json(pathname, method, value, operation, stableKey) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > this.requestByteLimit) {
      throw new ArchiveClientError('archive request exceeds the configured request byte limit', {
        code: 'REQUEST_TOO_LARGE', exitCode: TRANSCRIPT_EXIT_CODES.USAGE,
      });
    }
    return this.request(pathname, {
      method,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey(operation, stableKey),
      },
      body,
    });
  }

  declare(manifest) {
    return this.json('/v1/archive-v2/manifests/declare', 'POST', { manifest }, 'declare', JSON.stringify(manifest));
  }

  uploadPart(brainId, uploadId, index, partHash, bytes) {
    return this.json(`/v1/archive-v2/uploads/${encodeURIComponent(uploadId)}/parts/${index}`, 'PUT', {
      brain_id: brainId, part_hash: partHash, content_base64: bytes.toString('base64'),
    }, 'part', `${uploadId}:${index}:${partHash}`);
  }

  commit(brainId, uploadId) {
    return this.json(`/v1/archive-v2/uploads/${encodeURIComponent(uploadId)}/commit`, 'POST', { brain_id: brainId }, 'commit', uploadId);
  }

  capabilities(brainId) {
    return this.request(`/v1/archive-v2/brains/${encodeURIComponent(brainId)}/capabilities`);
  }

  async listBrains() {
    const brains = [];
    let cursor;
    const visitedCursors = new Set();
    let pages = 0;
    let consecutiveEmptyPages = 0;
    while (true) {
      const cursorKey = cursor;
      if (cursorKey && visitedCursors.has(cursorKey)) {
        throw new ArchiveClientError('brain inventory pagination did not make progress', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
      }
      if (cursorKey) visitedCursors.add(cursorKey);
      if (++pages > this.inventoryMaxPages) {
        throw new ArchiveClientError('brain inventory exceeds the safe page limit', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
      }
      const query = new URLSearchParams({ limit: '100' });
      if (cursorKey) query.set('cursor', cursorKey);
      const data = await this.request(`/v1/archive-v2/brains?${query}`);
      if (!data || !Array.isArray(data.brains) || !Object.prototype.hasOwnProperty.call(data, 'nextCursor')
        || data.brains.some((brain) => !brain || typeof brain.id !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._:@+\-=]*$/.test(brain.id))
        || (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || data.nextCursor.length > 1024))) {
        throw new ArchiveClientError('brain inventory response is invalid', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
      }
      brains.push(...data.brains.map((brain) => brain.id));
      consecutiveEmptyPages = data.brains.length ? 0 : consecutiveEmptyPages + 1;
      if (consecutiveEmptyPages > this.inventoryMaxEmptyPages) {
        throw new ArchiveClientError('brain inventory pagination made no useful progress', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
      }
      if (brains.length > this.inventoryMaxItems) {
        throw new ArchiveClientError('brain inventory exceeds the safe item limit', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
      }
      cursor = data.nextCursor || undefined;
      if (!cursor) break;
    }
    return [...new Set(brains)];
  }

  inventoryPage(brainId, { cursor, limit = 100 } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/v1/archive-v2/brains/${encodeURIComponent(brainId)}/inventory?${query}`);
  }

  async inventory(brainId) {
    const items = [];
    let cursor;
    let restarts = 0;
    let pages = 0;
    let consecutiveEmptyPages = 0;
    const visitedCursors = new Set();
    while (true) {
      try {
        if (cursor && visitedCursors.has(cursor)) {
          throw new ArchiveClientError('archive inventory pagination did not make progress', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
        }
        if (cursor) visitedCursors.add(cursor);
        if (++pages > this.inventoryMaxPages) {
          throw new ArchiveClientError('archive inventory exceeds the safe page limit', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
        }
        const page = await this.inventoryPage(brainId, { cursor });
        if (!page || !Array.isArray(page.items) || !Object.prototype.hasOwnProperty.call(page, 'nextCursor')
          || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length > 1024))) {
          throw new ArchiveClientError('archive inventory response is invalid', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
        }
        items.push(...page.items);
        consecutiveEmptyPages = page.items.length ? 0 : consecutiveEmptyPages + 1;
        if (consecutiveEmptyPages > this.inventoryMaxEmptyPages) {
          throw new ArchiveClientError('archive inventory pagination made no useful progress', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
        }
        if (items.length > this.inventoryMaxItems) {
          throw new ArchiveClientError('archive inventory exceeds the safe item limit', { code: 'INVALID_RESPONSE', exitCode: TRANSCRIPT_EXIT_CODES.UPSTREAM });
        }
        cursor = page.nextCursor || undefined;
        if (!cursor) break;
      } catch (error) {
        if (error instanceof ArchiveClientError && error.code === 'archive_inventory_restart_required' && restarts++ < this.retryLimit) {
          items.length = 0;
          cursor = undefined;
          pages = 0;
          consecutiveEmptyPages = 0;
          visitedCursors.clear();
          continue;
        }
        throw error;
      }
    }
    return items;
  }

  readCommitted(brainId, archiveVersionId, committedReadId = `read_${randomUUID()}`) {
    return this.request(`/v1/archive-v2/brains/${encodeURIComponent(brainId)}/versions/${encodeURIComponent(archiveVersionId)}/content`, {
      bytes: true,
      headers: { 'idempotency-key': idempotencyKey('restore', `${archiveVersionId}:${committedReadId}`),
        'x-agentbootup-read-purpose': 'verification' },
    });
  }

  downloadCommitted(brainId, archiveVersionId, sink, committedReadId = `read_${randomUUID()}`) {
    return this.request(`/v1/archive-v2/brains/${encodeURIComponent(brainId)}/versions/${encodeURIComponent(archiveVersionId)}/content`, {
      byteSink: sink.write,
      beforeByteAttempt: sink.reset,
      headers: { 'idempotency-key': idempotencyKey('restore', `${archiveVersionId}:${committedReadId}`),
        'x-agentbootup-read-purpose': 'restore' },
    });
  }

  beginRestoreAttempt(brainId, archiveVersionId, restoreOperationId) {
    const body = '{}';
    return this.request(`/v1/archive-v2/brains/${encodeURIComponent(brainId)}/versions/${encodeURIComponent(archiveVersionId)}/restore-attempt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json',
        'idempotency-key': idempotencyKey('restore', `${archiveVersionId}:${restoreOperationId}`) },
      body,
    });
  }

  reportRestoreOutcome(brainId, archiveVersionId, restoreOperationId, outcome, reason = null) {
    const body = JSON.stringify({ outcome, reason });
    return this.request(`/v1/archive-v2/brains/${encodeURIComponent(brainId)}/versions/${encodeURIComponent(archiveVersionId)}/restore-outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json',
        'idempotency-key': idempotencyKey('restore', `${archiveVersionId}:${restoreOperationId}`) },
      body,
    });
  }

  verifyCommitted(brainId, archiveVersionId) {
    return this.json(`/v1/archive-v2/brains/${encodeURIComponent(brainId)}/versions/${encodeURIComponent(archiveVersionId)}/verify`, 'POST', {}, 'verify', archiveVersionId);
  }
}
