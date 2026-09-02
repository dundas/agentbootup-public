import { test, expect, describe } from 'bun:test';
import { main } from '../../templates/brain/scripts/brain-message-inbox.ts';

const creds = { ADMP_AGENT_ID: 'brain-a', ADMP_API_KEY: 'sk-test' };

function mockFetch(handler) {
  return async (url, opts) => handler(url, opts);
}

describe('brain-message-inbox runtime', () => {
  test('--help exits 0', async () => {
    expect(await main(['--help'], {})).toBe(0);
  });

  test('empty env → exit 10 (credentials missing — provisioned != configured)', async () => {
    expect(await main(['--read-only'], {})).toBe(10);
  });

  test('partial creds (agent id only) → exit 10', async () => {
    expect(await main(['--read-only'], { ADMP_AGENT_ID: 'brain-a' })).toBe(10);
  });

  test('--read-only with creds fetches the inbox and exits 0', async () => {
    let calledUrl = null;
    let calledHeaders = null;
    const fetchImpl = mockFetch((url, opts) => {
      calledUrl = url;
      calledHeaders = opts.headers;
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1', type: 'work_order', subject: 'hi', from: 'decisive' }] }) };
    });
    const code = await main(['--read-only', '--json'], creds, fetchImpl);
    expect(code).toBe(0);
    expect(calledUrl).toBe('https://agentdispatch.fly.dev/api/agents/brain-a/inbox');
    expect(calledHeaders['X-Api-Key']).toBe('sk-test');
  });

  test('honors ADMP_BASE_URL override (no trailing slash issues)', async () => {
    let calledUrl = null;
    const fetchImpl = mockFetch((url) => { calledUrl = url; return { ok: true, status: 200, json: async () => [] }; });
    await main(['--read-only'], { ...creds, ADMP_BASE_URL: 'https://hub.example/' }, fetchImpl);
    expect(calledUrl).toBe('https://hub.example/api/agents/brain-a/inbox');
  });

  test('non-ok inbox response → exit 1 (transport error)', async () => {
    const fetchImpl = mockFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    expect(await main(['--read-only'], creds, fetchImpl)).toBe(1);
  });

  test('a bare array inbox body is handled', async () => {
    const fetchImpl = mockFetch(() => ({ ok: true, status: 200, json: async () => [{ id: 'm1' }] }));
    expect(await main(['--read-only'], creds, fetchImpl)).toBe(0);
  });

  test('--limit truncates the listed messages and forwards an AbortSignal', async () => {
    let out = '';
    let sawSignal = false;
    const orig = console.log;
    console.log = (s) => { out += String(s); };
    try {
      const fetchImpl = mockFetch((_url, opts) => {
        sawSignal = opts.signal instanceof AbortSignal;
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }) };
      });
      const code = await main(['--read-only', '--json', '--limit', '1'], creds, fetchImpl);
      expect(code).toBe(0);
      expect(JSON.parse(out)).toHaveLength(1);
      expect(sawSignal).toBe(true);
    } finally {
      console.log = orig;
    }
  });

  test('malformed 200 body (error envelope) → treated as empty + warns, still exits 0', async () => {
    let warned = '';
    const origErr = console.error;
    console.error = (s) => { warned += String(s); };
    try {
      const fetchImpl = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ error: 'unauthorized' }) }));
      const code = await main(['--read-only', '--json'], creds, fetchImpl);
      expect(code).toBe(0);
      expect(warned).toMatch(/no recognized "messages" array/);
    } finally {
      console.error = origErr;
    }
  });

  test('--limit with an invalid value is ignored (warns, no truncation)', async () => {
    const fetchImpl = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'a' }, { id: 'b' }] }) }));
    // Should not throw; invalid limit falls back to "no limit".
    expect(await main(['--read-only', '--limit', 'abc'], creds, fetchImpl)).toBe(0);
  });
});
