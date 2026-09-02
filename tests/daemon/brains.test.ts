/**
 * Tests for lib/sync/brains.js — brain discovery.
 */

import { test, expect, afterEach } from 'bun:test';

const { listBrains, isBrainRegistered } = await import('../../lib/sync/brains.js');

const creds = { apiKey: 'test-key', serverUrl: 'http://localhost:0' };
const originalFetch = globalThis.fetch;

afterEach(() => {
  // @ts-ignore
  globalThis.fetch = originalFetch;
});

test('listBrains returns array from server response envelope { data: { brains } }', async () => {
  const mockBrains = [
    { id: 'brain-1', name: 'Work Brain' },
    { id: 'brain-2', name: 'Personal Brain' },
  ];
  // Server wraps responses in { data: payload } — e.g. { data: { brains: [...], total: 2 } }
  // @ts-ignore
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { brains: mockBrains, total: 2 } }) });

  const result = await listBrains(creds);
  expect(result).toEqual(mockBrains);
});

test('listBrains falls back to flat { brains } envelope', async () => {
  const mockBrains = [{ id: 'brain-1' }];
  // @ts-ignore
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ brains: mockBrains }) });

  const result = await listBrains(creds);
  expect(result).toEqual(mockBrains);
});

test('listBrains returns empty array when server returns no brains', async () => {
  // @ts-ignore
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { brains: [], total: 0 } }) });

  const result = await listBrains(creds);
  expect(result).toEqual([]);
});

test('listBrains throws on invalid serverUrl', async () => {
  const badCreds = { apiKey: 'k', serverUrl: 'file:///etc/passwd' };
  await expect(listBrains(badCreds)).rejects.toThrow('Invalid server URL');
});

test('listBrains throws on non-ok response', async () => {
  // @ts-ignore
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });

  await expect(listBrains(creds)).rejects.toThrow('401');
});

test('listBrains throws on network error', async () => {
  // @ts-ignore
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

  await expect(listBrains(creds)).rejects.toThrow('ECONNREFUSED');
});

test('listBrains includes Authorization header', async () => {
  let capturedHeaders: Headers | undefined;
  // @ts-ignore
  globalThis.fetch = async (_url: string, opts: RequestInit) => {
    capturedHeaders = new Headers(opts.headers as HeadersInit);
    return { ok: true, json: async () => ({ brains: [] }) };
  };

  await listBrains(creds);
  expect(capturedHeaders?.get('Authorization')).toBe('Bearer test-key');
});

test('isBrainRegistered uses direct GET /v1/brains/:id and returns true on 200', async () => {
  let capturedUrl = '';
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    capturedUrl = url;
    return { ok: true, status: 200, text: async () => '', json: async () => ({ data: { id: 'brain-1' } }) };
  };

  await expect(isBrainRegistered(creds, 'brain-1')).resolves.toBe(true);
  expect(capturedUrl).toContain('/v1/brains/brain-1');
});

test('isBrainRegistered returns false on 404', async () => {
  // @ts-ignore
  // status===404 is the branch under test; ok is irrelevant for this case.
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  await expect(isBrainRegistered(creds, 'missing-brain')).resolves.toBe(false);
});

test('isBrainRegistered throws on non-404 server error', async () => {
  // @ts-ignore
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'Internal Server Error' });
  await expect(isBrainRegistered(creds, 'brain-1')).rejects.toThrow('Server returned 500');
});

test('isBrainRegistered throws on invalid serverUrl', async () => {
  const badCreds = { apiKey: 'k', serverUrl: 'ftp://bad' };
  await expect(isBrainRegistered(badCreds, 'brain-1')).rejects.toThrow('Invalid server URL');
});
