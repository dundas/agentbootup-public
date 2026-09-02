/**
 * Tests for fetchNetworkConfig() and pushNetworkConfig() client helpers
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

const originalFetch = globalThis.fetch;
let mockResponses: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [];
let capturedRequests: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];

// Mock fetch
beforeEach(() => {
  mockResponses = [];
  capturedRequests = [];
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method || 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    let body: unknown;
    if (init?.body) {
      try { body = JSON.parse(init.body as string); } catch { body = init.body; }
    }
    capturedRequests.push({ url, method, headers, body });

    const mock = mockResponses.shift();
    if (!mock) throw new Error('No mock response configured');
    return new Response(JSON.stringify(mock.body), {
      status: mock.status,
      headers: { 'Content-Type': 'application/json', ...mock.headers },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { fetchNetworkConfig, pushNetworkConfig } = await import('../../lib/sync/brains.js');

const CREDS = { apiKey: 'test-key', serverUrl: 'https://example.com' };

// ── fetchNetworkConfig ───────────────────────────────────────────────────────

describe('fetchNetworkConfig', () => {
  test('returns config on 200', async () => {
    mockResponses.push({
      status: 200,
      body: {
        data: {
          version: '2.0',
          role: 'network',
          hub: 'https://hub.example.com',
          projects: [{ id: 'p1', agent_id: 'a1.gm' }],
        },
      },
    });

    const result = await fetchNetworkConfig(CREDS);
    expect(result).not.toBeNull();
    expect(result.version).toBe('2.0');
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].agent_id).toBe('a1.gm');

    expect(capturedRequests[0].headers.Authorization).toBe('Bearer test-key');
    expect(capturedRequests[0].url).toBe('https://example.com/v1/network-config');
  });

  test('returns null on 404', async () => {
    mockResponses.push({
      status: 404,
      body: { error: { code: 'not_found', message: 'No config' } },
    });

    const result = await fetchNetworkConfig(CREDS);
    expect(result).toBeNull();
  });

  test('throws on 500', async () => {
    mockResponses.push({
      status: 500,
      body: { error: 'Internal server error' },
    });

    await expect(fetchNetworkConfig(CREDS)).rejects.toThrow('Server returned 500');
  });

  test('throws on invalid server URL', async () => {
    await expect(fetchNetworkConfig({ apiKey: 'k', serverUrl: 'ftp://bad' })).rejects.toThrow('Invalid server URL');
  });
});

// ── pushNetworkConfig ────────────────────────────────────────────────────────

describe('pushNetworkConfig', () => {
  test('sends PUT and returns project count', async () => {
    mockResponses.push({
      status: 200,
      body: { data: { projectCount: 3 } },
    });

    const config = {
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'p1', agent_id: 'a1.gm', path: '~/dev_env/p1' },
        { id: 'p2', agent_id: 'a2.gm', path: '/opt/p2' },
        { id: 'p3', agent_id: 'a3.gm' },
      ],
    };

    const result = await pushNetworkConfig(CREDS, config);
    expect(result.projectCount).toBe(3);
    expect(capturedRequests[0].method).toBe('PUT');
    expect(capturedRequests[0].headers['Content-Type']).toBe('application/json');
  });

  test('strips path fields from projects before sending', async () => {
    mockResponses.push({
      status: 200,
      body: { data: { projectCount: 2 } },
    });

    const config = {
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'p1', agent_id: 'a1.gm', path: '~/dev_env/p1', type: 'service' },
        { id: 'p2', agent_id: 'a2.gm', path: '/opt/p2' },
      ],
    };

    await pushNetworkConfig(CREDS, config);
    const sentBody = capturedRequests[0].body as Record<string, unknown>;
    const sentProjects = sentBody.projects as Array<Record<string, unknown>>;

    // path should be stripped
    expect(sentProjects[0].path).toBeUndefined();
    expect(sentProjects[1].path).toBeUndefined();

    // other fields preserved
    expect(sentProjects[0].agent_id).toBe('a1.gm');
    expect(sentProjects[0].type).toBe('service');
  });

  test('throws on server error', async () => {
    mockResponses.push({ status: 400, body: { error: 'bad request' } });
    await expect(pushNetworkConfig(CREDS, { version: '2.0', role: 'network', projects: [] })).rejects.toThrow('Server returned 400');
  });

  test('throws on invalid server URL', async () => {
    await expect(pushNetworkConfig({ apiKey: 'k', serverUrl: 'file:///etc' }, {})).rejects.toThrow('Invalid server URL');
  });
});
