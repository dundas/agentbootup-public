import { describe, test, expect } from 'bun:test';
import {
  HttpError,
  jsonSuccess,
  jsonError,
  ensureString,
  ensureIdentifier,
  ensureBranchId,
  readJsonBody,
  readOptionalJsonBody,
} from '../errors';

describe('HttpError', () => {
  test('has status and code', () => {
    const e = new HttpError(404, 'not_found', 'Not found');
    expect(e.status).toBe(404);
    expect(e.code).toBe('not_found');
    expect(e.message).toBe('Not found');
  });
});

describe('jsonSuccess', () => {
  test('wraps data in { data }', async () => {
    const res = jsonSuccess(200, { id: 'decisive-gm' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown };
    expect(body.data).toEqual({ id: 'decisive-gm' });
  });
});

describe('jsonError', () => {
  test('wraps in { error: { code, message } }', async () => {
    const res = jsonError(400, 'invalid_request', 'Bad field');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toBe('Bad field');
  });
});

describe('ensureString', () => {
  test('returns trimmed string', () => {
    expect(ensureString('  hello  ', 'field')).toBe('hello');
  });

  test('throws for non-string', () => {
    expect(() => ensureString(123, 'field')).toThrow(HttpError);
  });

  test('throws for empty after trim', () => {
    expect(() => ensureString('   ', 'field')).toThrow(HttpError);
  });

  test('throws for exceeding maxLength', () => {
    expect(() => ensureString('abc', 'field', { maxLength: 2 })).toThrow(HttpError);
  });
});

describe('ensureIdentifier', () => {
  test('accepts valid brain IDs', () => {
    expect(ensureIdentifier('decisive-gm', 'id')).toBe('decisive-gm');
    expect(ensureIdentifier('mech-browse-001', 'id')).toBe('mech-browse-001');
    expect(ensureIdentifier('brain.v2:prod', 'id')).toBe('brain.v2:prod');
  });

  test('rejects spaces and special chars', () => {
    expect(() => ensureIdentifier('has space', 'id')).toThrow(HttpError);
    expect(() => ensureIdentifier('has/slash', 'id')).toThrow(HttpError);
    expect(() => ensureIdentifier('has@at', 'id')).toThrow(HttpError);
  });
});

describe('ensureBranchId', () => {
  test('accepts narrow-charset branch ids', () => {
    expect(ensureBranchId('default')).toBe('default');
    expect(ensureBranchId('tenant-acme')).toBe('tenant-acme');
    expect(ensureBranchId('feature_42-rc1')).toBe('feature_42-rc1');
    expect(ensureBranchId('A'.repeat(128))).toBe('A'.repeat(128));
  });

  test('rejects path-traversal-shaped ids that ensureIdentifier would accept', () => {
    // These all pass ensureIdentifier's charset (^[A-Za-z0-9._:-]+$) but must not
    // reach a snapshot path segment. This is the keystone fix (ledger item 1).
    expect(() => ensureBranchId('..')).toThrow(HttpError);
    expect(() => ensureBranchId('.')).toThrow(HttpError);
    expect(() => ensureBranchId('brain.v2:prod')).toThrow(HttpError);
  });

  test('rejects empty, over-long, and separator-bearing ids', () => {
    expect(() => ensureBranchId('')).toThrow(HttpError);
    expect(() => ensureBranchId('A'.repeat(129))).toThrow(HttpError);
    expect(() => ensureBranchId('../escape')).toThrow(HttpError);
    expect(() => ensureBranchId('has space')).toThrow(HttpError);
  });
});

describe('readJsonBody', () => {
  test('parses valid JSON', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: JSON.stringify({ id: 'test' }),
      headers: { 'content-type': 'application/json' },
    });
    const body = await readJsonBody(req);
    expect(body).toEqual({ id: 'test' });
  });

  test('throws on empty body', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: '   ',
      headers: { 'content-type': 'application/json' },
    });
    await expect(readJsonBody(req)).rejects.toThrow(HttpError);
  });

  test('throws on invalid JSON', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    await expect(readJsonBody(req)).rejects.toThrow(HttpError);
  });

  test('throws on malformed content-length', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: JSON.stringify({ id: 'test' }),
      headers: { 'content-type': 'application/json', 'content-length': 'not-a-number' },
    });
    await expect(readOptionalJsonBody(req)).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('optional body rejects non-object JSON', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: JSON.stringify([1, 2]),
      headers: { 'content-type': 'application/json' },
    });
    await expect(readOptionalJsonBody(req)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: 'Body must be a JSON object.',
    });
  });
});
