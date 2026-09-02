import path from 'node:path';

export const MEMORY_TRANSPORT_RECEIPT_SCHEMA = 'memory-transport-check/1';

function result(state, message) {
  return { state, severity: state === 'fail' ? 'error' : state === 'unknown' ? 'warning' : 'info', category: 'memory_transport', message };
}

/**
 * Convert the committed P3 receipt into a doctor result. A malformed receipt is
 * unknown, never pass: absence of trustworthy evidence is not evidence of transport.
 */
export function memoryTransportReceiptResult(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return result('unknown', 'memory transport receipt is malformed');
  }
  if (receipt.schema !== MEMORY_TRANSPORT_RECEIPT_SCHEMA) {
    return result('unknown', 'memory transport receipt has an unsupported schema');
  }
  if (receipt.outcome === 'pass') return result('pass', 'memory transport receipt: PASS');
  if (receipt.outcome === 'fail') return result('fail', 'memory transport receipt: FAIL');
  if (receipt.outcome === 'unknown') return result('unknown', 'memory transport receipt: UNKNOWN');
  return result('unknown', 'memory transport receipt has an invalid outcome');
}

/** Propose broad, reviewable selectors for categories P3 proved are unselected. */
export function proposedMemoryTransportSelectors(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.schema !== MEMORY_TRANSPORT_RECEIPT_SCHEMA) {
    return [];
  }
  return [...new Set((Array.isArray(receipt.findings) ? receipt.findings : [])
    .filter((finding) => finding?.assertion === 'A0' && finding.reason === 'store_unselected' && isSafeRelativePath(finding.path))
    .map((finding) => {
      const directory = path.posix.dirname(finding.path);
      return directory === '.' ? 'memory/*' : `memory/${directory}/**`;
    }))].sort();
}

function isSafeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.split('/').every((segment) =>
    segment.length > 0 && segment !== '.' && segment !== '..' && !/[\\\u0000-\u001f]/.test(segment));
}

/** Return a runner only when this project has produced a P3 receipt. */
export async function createMemoryTransportReceiptRunner({ cwd, readFile }) {
  const receiptPath = path.join(cwd, 'memory', '.receipts', 'coverage', 'latest.json');
  let raw;
  try {
    raw = await readFile(receiptPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    return async () => result('unknown', 'memory transport receipt could not be read');
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    return async () => result('unknown', 'memory transport receipt is malformed');
  }
  return async () => memoryTransportReceiptResult(receipt);
}

export async function discoverMemoryTransportSelectors({ cwd, readFile }) {
  const receiptPath = path.join(cwd, 'memory', '.receipts', 'coverage', 'latest.json');
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    return { available: true, selectors: proposedMemoryTransportSelectors(receipt) };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { available: false, selectors: [] };
    return { available: true, selectors: [] };
  }
}
