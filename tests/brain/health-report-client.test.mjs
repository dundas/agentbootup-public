import { test, expect, describe } from 'bun:test';
import { postHealthReport } from '../../lib/brain/health-report-client.js';

const record = {
  agent_id: 'brain-a', machine_id: 'm1', environment: null,
  ts: '2026-06-04T12:00:00Z', status: 'degraded', checks: {}, reason: null,
};

describe('postHealthReport', () => {
  test('POSTs JSON to /v1/health/report with Bearer auth and resolves on 202', async () => {
    let sawMethod, sawUrl, sawBody, sawAuth;
    const fetch = async (url, opts) => {
      sawMethod = opts.method; sawUrl = url;
      sawBody = JSON.parse(opts.body); sawAuth = opts.headers.Authorization;
      return { ok: true, status: 202 };
    };
    await postHealthReport({ serverUrl: 'https://srv.example', apiKey: 'k1', record, fetch });
    expect(sawMethod).toBe('POST');
    expect(sawUrl).toBe('https://srv.example/v1/health/report');
    expect(sawBody.agent_id).toBe('brain-a');
    expect(sawAuth).toBe('Bearer k1');
  });

  test('trailing slash on serverUrl is trimmed', async () => {
    let sawUrl;
    const fetch = async (url) => { sawUrl = url; return { ok: true, status: 202 }; };
    await postHealthReport({ serverUrl: 'https://srv.example/', apiKey: 'k', record, fetch });
    expect(sawUrl).toBe('https://srv.example/v1/health/report');
  });

  test('non-2xx HTTP response → throws with the status', async () => {
    const fetch = async () => ({ ok: false, status: 500, text: async () => 'internal error' });
    await expect(postHealthReport({ serverUrl: 'https://s', apiKey: 'k', record, fetch }))
      .rejects.toThrow(/HTTP 500/);
  });

  test('network error (fetch throws) → throws with a clear message', async () => {
    const fetch = async () => { throw new Error('ECONNREFUSED'); };
    await expect(postHealthReport({ serverUrl: 'https://s', apiKey: 'k', record, fetch }))
      .rejects.toThrow(/network.*ECONNREFUSED/i);
  });
});
