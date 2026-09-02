/**
 * Agentbootup Server — Error helpers
 * Pattern from mech-run.
 */

import type { ApiSuccessBody, ApiErrorBody } from './types';

export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function jsonSuccess<T>(status: number, data: T): Response {
  const body: ApiSuccessBody<T> = { data };
  return Response.json(body, { status });
}

export function jsonError(status: number, code: string, message: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return Response.json(body, { status });
}

export function methodNotAllowed(allowed: string[]): Response {
  // Build with headers at construction time — Response.headers is immutable after creation
  const body: ApiErrorBody = { error: { code: 'method_not_allowed', message: 'Method Not Allowed' } };
  return Response.json(body, {
    status: 405,
    headers: { allow: allowed.join(', ') },
  });
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB

function getContentLength(req: Request): number {
  const value = req.headers.get('content-length');
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(400, 'invalid_request', 'Content-Length header must be a non-negative number.');
  }
  return parsed;
}

export async function readJsonBody(req: Request): Promise<unknown> {
  const contentLength = getContentLength(req);
  if (contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', 'Request body exceeds 10MB limit.');
  }
  const raw = await req.text();
  if (!raw.trim()) {
    throw new HttpError(400, 'invalid_request', 'Request body is required.');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', 'Request body exceeds 10MB limit.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readOptionalJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const contentLength = getContentLength(req);
  if (contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', 'Request body exceeds 10MB limit.');
  }
  const raw = await req.text();
  if (!raw.trim()) return null;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', 'Request body exceeds 10MB limit.');
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainJsonObject(parsed)) {
      throw new HttpError(400, 'invalid_request', 'Body must be a JSON object.');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

export function ensureString(
  value: unknown,
  field: string,
  opts: { minLength?: number; maxLength?: number } = {},
): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be a string.`);
  }
  const trimmed = value.trim();
  const min = opts.minLength ?? 1;
  const max = opts.maxLength ?? 2000;
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(
      400,
      'invalid_request',
      `Field '${field}' must be between ${min} and ${max} characters.`,
    );
  }
  return trimmed;
}

export function ensureOptionalString(
  value: unknown,
  field: string,
  opts: { maxLength?: number } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return ensureString(value, field, { minLength: 1, maxLength: opts.maxLength ?? 1000 });
}

export function ensureIdentifier(value: string, field: string, maxLength = 200): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' contains unsupported characters.`);
  }
  if (value.length === 0 || value.length > maxLength) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be 1–${maxLength} characters.`);
  }
  return value;
}

/**
 * Validate a branch identifier for use in storage path segments.
 *
 * Stricter than ensureIdentifier: the charset excludes '.' and ':' so that a
 * branch_id can never produce a path-traversal-shaped snapshot key (e.g. '..'
 * yielding brain-snapshots/{brain}/branches/../{ts}). Length is pinned at 128
 * here so the store boundary stays bounded even if a caller forgets to pass a
 * maxLength. See Brain Branch Spec v1, code ledger items 1 and 2.
 */
export function ensureBranchId(value: string, field = 'branch_id'): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HttpError(
      400,
      'invalid_request',
      `Field '${field}' must match ^[A-Za-z0-9_-]{1,128}$ (no '.', ':' or path separators).`,
    );
  }
  return value;
}

export function ensureOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be a boolean.`);
  }
  return value;
}

export function ensureOptionalNumber(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be a number.`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be >= ${opts.min}.`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be <= ${opts.max}.`);
  }
  return value;
}
