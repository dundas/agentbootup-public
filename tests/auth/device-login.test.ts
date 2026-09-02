import { describe, test, expect } from 'bun:test';
import { startDeviceAuth, pollDeviceAuth, tryOpenBrowser } from '../../lib/auth/device-login.js';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('device-login helpers', () => {
  test('startDeviceAuth parses start payload', async () => {
    const fetchImpl = async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://agentbootup.fly.dev/v1/device-auth/start');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('{}');
      return jsonResponse(201, {
        data: {
          device_code: 'device-code-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://agentbootup.fly.dev/developer/device?code=ABCD-1234',
          expires_in: 600,
          interval: 2,
        },
      });
    };

    const started = await startDeviceAuth('https://agentbootup.fly.dev/', fetchImpl);
    expect(started.deviceCode).toBe('device-code-1');
    expect(started.userCode).toBe('ABCD-1234');
    expect(started.intervalSeconds).toBe(2);
  });

  test('pollDeviceAuth returns api_key after pending', async () => {
    let calls = 0;
    const fetchImpl = async (url: string) => {
      expect(url).toBe('https://agentbootup.fly.dev/v1/device-auth/poll');
      calls += 1;
      if (calls === 1) {
        return jsonResponse(200, { data: { status: 'pending' } });
      }
      return jsonResponse(200, {
        data: {
          status: 'approved',
          api_key: 'abu_live_test_secret',
          key_id: 'key_1',
          user_id: 'ext_user',
        },
      });
    };

    const approved = await pollDeviceAuth('https://agentbootup.fly.dev', 'device-code-1', {
      fetchImpl,
      intervalSeconds: 0.001,
      minPollIntervalMs: 1,
      expiresAtMs: Date.now() + 5000,
    });
    expect(approved.apiKey).toBe('abu_live_test_secret');
    expect(approved.keyId).toBe('key_1');
    expect(calls).toBe(2);
  });

  test('pollDeviceAuth surfaces expired responses', async () => {
    const fetchImpl = async () => jsonResponse(410, {
      error: { code: 'expired', message: 'Device authorization request has expired.' },
      data: { status: 'expired' },
    });

    await expect(pollDeviceAuth('https://agentbootup.fly.dev', 'device-code-1', {
      fetchImpl,
      intervalSeconds: 0.001,
      minPollIntervalMs: 1,
      expiresAtMs: Date.now() + 1000,
    })).rejects.toThrow('expired');
  });

  test('startDeviceAuth surfaces HTTP error responses', async () => {
    const fetchImpl = async () => jsonResponse(503, {
      error: { message: 'Self-serve auth is not configured.' },
    });

    await expect(startDeviceAuth('https://agentbootup.fly.dev', fetchImpl))
      .rejects.toThrow('Self-serve auth is not configured.');
  });

  test('pollDeviceAuth uses onAwaitingKey for 202 approved state', async () => {
    let calls = 0;
    const pendingCalls: string[] = [];
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(202, { data: { status: 'approved' } });
      }
      return jsonResponse(200, {
        data: { status: 'approved', api_key: 'abu_live_after_202' },
      });
    };

    const approved = await pollDeviceAuth('https://agentbootup.fly.dev', 'device-code-1', {
      fetchImpl,
      intervalSeconds: 0.001,
      minPollIntervalMs: 1,
      expiresAtMs: Date.now() + 5000,
      onPending: () => pendingCalls.push('pending'),
      onAwaitingKey: () => pendingCalls.push('awaiting-key'),
    });
    expect(approved.apiKey).toBe('abu_live_after_202');
    expect(pendingCalls).toEqual(['awaiting-key']);
  });

  test('pollDeviceAuth loops on 200 approved without api_key', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(200, { data: { status: 'approved' } });
      }
      return jsonResponse(200, {
        data: { status: 'approved', api_key: 'abu_live_delayed' },
      });
    };

    const approved = await pollDeviceAuth('https://agentbootup.fly.dev', 'device-code-1', {
      fetchImpl,
      intervalSeconds: 0.001,
      minPollIntervalMs: 1,
      expiresAtMs: Date.now() + 5000,
    });
    expect(approved.apiKey).toBe('abu_live_delayed');
    expect(calls).toBe(2);
  });

  test('startDeviceAuth rejects non-http verification_uri from server', async () => {
    const fetchImpl = async () => jsonResponse(201, {
      data: {
        device_code: 'device-code-1',
        user_code: 'ABCD-1234',
        verification_uri: 'javascript:alert(1)',
        expires_in: 600,
        interval: 2,
      },
    });

    await expect(startDeviceAuth('https://agentbootup.fly.dev', fetchImpl))
      .rejects.toThrow('Invalid verification URL');
  });

  test('startDeviceAuth caps interval and expires_in from server', async () => {
    const fetchImpl = async () => jsonResponse(201, {
      data: {
        device_code: 'device-code-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://agentbootup.fly.dev/developer/device?code=ABCD-1234',
        expires_in: 999999,
        interval: 999999,
      },
    });

    const started = await startDeviceAuth('https://agentbootup.fly.dev', fetchImpl);
    expect(started.expiresIn).toBe(3600);
    expect(started.intervalSeconds).toBe(60);
  });

  test('startDeviceAuth rejects invalid polling metadata', async () => {
    const fetchImpl = async () => jsonResponse(201, {
      data: {
        device_code: 'device-code-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://agentbootup.fly.dev/developer/device?code=ABCD-1234',
        expires_in: 'bad',
        interval: 2,
      },
    });

    await expect(startDeviceAuth('https://agentbootup.fly.dev', fetchImpl))
      .rejects.toThrow('invalid polling metadata');
  });

  test('tryOpenBrowser allows ampersand in query strings', () => {
    let openedUrl = '';
    const opened = tryOpenBrowser('https://agentbootup.fly.dev/developer/device?code=X&session=Y', {
      openBrowser: (url) => { openedUrl = url; },
    });
    expect(opened).toBe(true);
    expect(openedUrl).toContain('&');
  });

  test('tryOpenBrowser rejects javascript URLs', () => {
    const opened = tryOpenBrowser('javascript:alert(1)', {
      openBrowser: () => { throw new Error('should not open'); },
    });
    expect(opened).toBe(false);
  });

  test('pollDeviceAuth accepts 202 approved response with api_key', async () => {
    const fetchImpl = async () => jsonResponse(202, {
      data: { status: 'approved', api_key: 'abu_live_202_with_key' },
    });

    const approved = await pollDeviceAuth('https://agentbootup.fly.dev', 'device-code-1', {
      fetchImpl,
      intervalSeconds: 0.001,
      minPollIntervalMs: 1,
      expiresAtMs: Date.now() + 5000,
    });
    expect(approved.apiKey).toBe('abu_live_202_with_key');
  });

  test('pollDeviceAuth calls onAwaitingKey only once across repeated approved polls', async () => {
    let calls = 0;
    let awaitingKeyCalls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) {
        return jsonResponse(202, { data: { status: 'approved' } });
      }
      return jsonResponse(200, {
        data: { status: 'approved', api_key: 'abu_live_once' },
      });
    };

    const approved = await pollDeviceAuth('https://agentbootup.fly.dev', 'device-code-1', {
      fetchImpl,
      intervalSeconds: 0.001,
      minPollIntervalMs: 1,
      expiresAtMs: Date.now() + 5000,
      onAwaitingKey: () => { awaitingKeyCalls += 1; },
    });
    expect(approved.apiKey).toBe('abu_live_once');
    expect(awaitingKeyCalls).toBe(1);
  });

  test('pollDeviceAuth retries after fetch timeout until expiry', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    await expect(pollDeviceAuth('https://agentbootup.fly.dev', 'device-code-1', {
      fetchImpl,
      intervalSeconds: 0.001,
      minPollIntervalMs: 1,
      expiresAtMs: Date.now() + 50,
    })).rejects.toThrow('Timed out waiting for browser approval');
    expect(calls).toBeGreaterThan(0);
  });

  test('pollDeviceAuth calls onPending only once across repeated pending polls', async () => {
    let calls = 0;
    let pendingCalls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) {
        return jsonResponse(200, { data: { status: 'pending' } });
      }
      return jsonResponse(200, {
        data: { status: 'approved', api_key: 'abu_live_after_pending' },
      });
    };

    const approved = await pollDeviceAuth('https://agentbootup.fly.dev', 'device-code-1', {
      fetchImpl,
      intervalSeconds: 0.001,
      minPollIntervalMs: 1,
      expiresAtMs: Date.now() + 5000,
      onPending: () => { pendingCalls += 1; },
    });
    expect(approved.apiKey).toBe('abu_live_after_pending');
    expect(pendingCalls).toBe(1);
  });
});
