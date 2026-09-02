/**
 * Shared request-body policy for every client of POST /v1/brain-assets/:id/push.
 * The server rejects bodies above 10 MiB; leave a full MiB of headroom for
 * proxy/server variation and default to an even more conservative 8 MiB.
 */
export const BRAIN_ASSET_BODY_SAFE_CEILING_BYTES = 9 * 1024 * 1024;
export const DEFAULT_BRAIN_ASSET_BODY_BUDGET_BYTES = 8 * 1024 * 1024;
export const BRAIN_ASSET_MAX_FILES = 500;
export const BRAIN_ASSET_BODY_BUDGET_ENV = 'AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES';

export function getBrainAssetBodyBudget(raw = process.env[BRAIN_ASSET_BODY_BUDGET_ENV]) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_BRAIN_ASSET_BODY_BUDGET_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${BRAIN_ASSET_BODY_BUDGET_ENV} must be a positive integer byte count`);
  }
  if (value > BRAIN_ASSET_BODY_SAFE_CEILING_BYTES) {
    throw new Error(
      `${BRAIN_ASSET_BODY_BUDGET_ENV}=${value} exceeds the compiled safe ceiling ` +
      `${BRAIN_ASSET_BODY_SAFE_CEILING_BYTES}`,
    );
  }
  return value;
}

function fileEntry(item) {
  return item?.entry ?? item;
}

export function serializeBrainAssetBatch(items, makePayload) {
  const body = JSON.stringify(makePayload(items));
  return { items, body, encodedBytes: Buffer.byteLength(body, 'utf8') };
}

/**
 * Greedily form ordered batches bounded by both serialized UTF-8 bytes and
 * file count. An untransportable singleton is isolated and does not prevent
 * later eligible entries from being planned.
 */
export function planBrainAssetPushBatches({
  items,
  maxFiles,
  makePayload,
  budget = getBrainAssetBodyBudget(),
}) {
  if (!Number.isInteger(maxFiles) || maxFiles <= 0 || maxFiles > BRAIN_ASSET_MAX_FILES) {
    throw new Error(`brain asset maxFiles must be an integer from 1 to ${BRAIN_ASSET_MAX_FILES}`);
  }
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > BRAIN_ASSET_BODY_SAFE_CEILING_BYTES) {
    throw new Error(`brain asset body budget must be between 1 and ${BRAIN_ASSET_BODY_SAFE_CEILING_BYTES} bytes`);
  }

  const batches = [];
  const oversized = [];
  let cursor = 0;
  while (cursor < items.length) {
    const item = items[cursor];
    const singleton = serializeBrainAssetBatch([item], makePayload);
    if (singleton.encodedBytes > budget) {
      oversized.push({
        item,
        path: String(fileEntry(item)?.path ?? '<unknown>'),
        encodedBytes: singleton.encodedBytes,
        budget,
      });
      cursor++;
      continue;
    }

    // Find the largest fitting ordered prefix. Binary search avoids repeatedly
    // serializing an ever-growing multi-megabyte body for every input file.
    let best = singleton;
    let low = 2;
    let high = Math.min(maxFiles, items.length - cursor);
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const candidate = serializeBrainAssetBatch(items.slice(cursor, cursor + count), makePayload);
      if (candidate.encodedBytes <= budget) {
        best = candidate;
        low = count + 1;
      } else {
        high = count - 1;
      }
    }
    batches.push(best);
    cursor += best.items.length;
  }
  return { batches, oversized, budget };
}

export function createBrainAssetSizeError({ path, encodedBytes, budget, status = null }) {
  const suffix = status === 413 ? ' HTTP 413' : '';
  const error = new Error(
    `brain asset request rejected: path=${path} encoded_request_bytes=${encodedBytes} ` +
    `client_body_budget_bytes=${budget}${suffix}`,
  );
  error.code = status === 413 ? 'BRAIN_ASSET_HTTP_413' : 'BRAIN_ASSET_BODY_BUDGET_EXCEEDED';
  error.status = status;
  // A server-side 413 may become transportable after server/proxy policy
  // changes. A locally over-budget singleton is deterministic until the file
  // or configured budget changes, so do not advertise it as transient.
  error.retryable = status === 413;
  error.path = path;
  error.encodedBytes = encodedBytes;
  return error;
}

/** Retry an unexpected multi-file 413 by ordered bisection. */
export async function sendBrainAssetBatchWith413Split(batch, { makePayload, send, onLeaf }) {
  const response = await send(batch);
  if (response?.status !== 413 || batch.items.length === 1) {
    const result = { batch, response };
    await onLeaf?.(result);
    return [result];
  }

  const midpoint = Math.floor(batch.items.length / 2);
  const left = serializeBrainAssetBatch(batch.items.slice(0, midpoint), makePayload);
  const right = serializeBrainAssetBatch(batch.items.slice(midpoint), makePayload);
  return [
    ...(await sendBrainAssetBatchWith413Split(left, { makePayload, send, onLeaf })),
    ...(await sendBrainAssetBatchWith413Split(right, { makePayload, send, onLeaf })),
  ];
}
