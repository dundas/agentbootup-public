/**
 * Integration tests for DaemonHttpServer
 * Run: bun test lib/daemon/http-server.test.js
 */

import { test, expect, describe, beforeEach, mock } from 'bun:test';
import http from 'http';

const mockEnumerateMounts = mock(() => []);
const mockPerformEnvMount = mock(() => ({ mountRoot: '/tmp/mounts/env/brain', noOp: false }));
const mockLoadNetworkConfig = mock(() => ({ config: { projects: [] }, configPath: '/fake/agentbootup.json' }));
const mockResolveProjectPath = mock(() => '/fake/brain/source');
const mockLoadEnvConfigFile = mock(() => ({ ok: true, config: {}, configDir: '/fake/env', configPath: '/fake/env/env.json' }));
const { DaemonHttpServer } = await import('./http-server.js');

// ---------------------------------------------------------------------------
// Reset all mocks to defaults before each test so a failing assertion
// in one test cannot leave stale mock state for the next test.
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockEnumerateMounts.mockImplementation(() => []);
  mockPerformEnvMount.mockImplementation(() => ({ mountRoot: '/tmp/mounts/env/brain', noOp: false }));
  mockLoadNetworkConfig.mockImplementation(() => ({ config: { projects: [] }, configPath: '/fake/agentbootup.json' }));
  mockResolveProjectPath.mockImplementation(() => '/fake/brain/source');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-token-abc123';
const BASE_PORT_START = 49200; // high ephemeral range, avoid conflicts
let portOffset = 0;

function nextPort() {
  return BASE_PORT_START + portOffset++;
}

function makeDaemon(basePath = '/fake/network') {
  return {
    basePath,
    getStatus: () => ({ running: true }),
    syncAll: async () => {},
    stop: async () => {},
  };
}

function makeServer(daemon, port) {
  return new DaemonHttpServer(daemon, {
    port,
    host: 'localhost',
    apiToken: TEST_TOKEN,
    requireAuth: true,
    mountEngine: {
      enumerateMounts: mockEnumerateMounts,
      performEnvMount: mockPerformEnvMount,
    },
    envConfig: {
      loadEnvConfigFile: mockLoadEnvConfigFile,
    },
    networkConfig: {
      loadNetworkConfig: mockLoadNetworkConfig,
      resolveProjectPath: mockResolveProjectPath,
    },
  });
}

async function request(port, method, pathname, { token = TEST_TOKEN, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost',
      port,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Shared server lifecycle helper
// ---------------------------------------------------------------------------

async function withServer(fn) {
  const port = nextPort();
  const server = makeServer(makeDaemon(), port);
  await server.start();
  try {
    await fn(port, server);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// Tests: Authentication
// ---------------------------------------------------------------------------

describe('auth', () => {
  test('GET /v1/mounts without token returns 401', async () => {
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts', { token: null });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });
  });

  test('GET /v1/mounts with wrong token returns 401', async () => {
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts', { token: 'wrong-token' });
      expect(res.status).toBe(401);
    });
  });

  test('/health endpoint is public (no auth required)', async () => {
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/health', { token: null });
      expect(res.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /v1/mounts
// ---------------------------------------------------------------------------

describe('GET /v1/mounts', () => {
  test('returns 200 with mounts array when empty', async () => {
    mockEnumerateMounts.mockImplementation(() => []);
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mounts: [] });
    });
  });

  test('returns 200 with mounts array containing mount records', async () => {
    const fakeMounts = [
      {
        envName: 'staging',
        brainKey: 'brain-001',
        mountRoot: '/tmp/mounts/staging/brain-001',
        record: {
          brain_id: 'brain-001',
          cwd: '/tmp/mounts/staging/brain-001',
          mounted_at: '2026-04-15T10:00:00.000Z',
        },
      },
    ];
    mockEnumerateMounts.mockImplementation(() => fakeMounts);
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.mounts)).toBe(true);
      expect(res.body.mounts).toHaveLength(1);
      expect(res.body.mounts[0].record.brain_id).toBe('brain-001');
    });
  });

  test('returns 405 for non-GET method', async () => {
    await withServer(async (port) => {
      const res = await request(port, 'POST', '/v1/mounts');
      expect(res.status).toBe(405);
    });
  });

  test('returns 500 with err.message when enumerateMounts throws in handleListMounts', async () => {
    mockEnumerateMounts.mockImplementation(() => {
      throw new Error('list-mounts-exploded');
    });
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('list-mounts-exploded');
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /v1/mounts/:brainId
// ---------------------------------------------------------------------------

describe('GET /v1/mounts/:brainId', () => {
  test('returns 404 for unknown brainId', async () => {
    mockEnumerateMounts.mockImplementation(() => []);
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts/unknown-brain');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Mount not found');
    });
  });

  test('returns 200 with mount record when brainId matches record.brain_id', async () => {
    const fakeMounts = [
      {
        envName: 'prod',
        brainKey: 'some-key',
        mountRoot: '/tmp/mounts/prod/some-key',
        record: {
          brain_id: 'my-brain',
          cwd: '/tmp/mounts/prod/some-key',
          mounted_at: '2026-04-15T10:00:00.000Z',
        },
      },
    ];
    mockEnumerateMounts.mockImplementation(() => fakeMounts);
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts/my-brain');
      expect(res.status).toBe(200);
      expect(res.body.record.brain_id).toBe('my-brain');
      expect(res.body.record.cwd).toBe('/tmp/mounts/prod/some-key');
    });
  });

  test('returns 200 when brainId matches brainKey (fallback)', async () => {
    const fakeMounts = [
      {
        envName: 'dev',
        brainKey: 'direct-key-match',
        mountRoot: '/tmp/mounts/dev/direct-key-match',
        record: {
          brain_id: 'something-else',
          cwd: '/tmp/mounts/dev/direct-key-match',
          mounted_at: '2026-04-15T10:00:00.000Z',
        },
      },
    ];
    mockEnumerateMounts.mockImplementation(() => fakeMounts);
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts/direct-key-match');
      expect(res.status).toBe(200);
      expect(res.body.brainKey).toBe('direct-key-match');
    });
  });

  test('cwd field is present in returned record', async () => {
    const mountRoot = '/tmp/mounts/staging/cwd-brain';
    const fakeMounts = [
      {
        envName: 'staging',
        brainKey: 'cwd-brain',
        mountRoot,
        record: {
          brain_id: 'cwd-brain',
          cwd: mountRoot,
          mounted_at: '2026-04-15T10:00:00.000Z',
        },
      },
    ];
    mockEnumerateMounts.mockImplementation(() => fakeMounts);
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts/cwd-brain');
      expect(res.status).toBe(200);
      expect(res.body.record.cwd).toBe(mountRoot);
    });
  });

  test('returns 500 with err.message when enumerateMounts throws in handleGetMount', async () => {
    mockEnumerateMounts.mockImplementation(() => {
      throw new Error('get-mount-exploded');
    });
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mounts/any-brain');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('get-mount-exploded');
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /v1/mount → GET /v1/mounts/:brainId round-trip
// ---------------------------------------------------------------------------

describe('POST /v1/mount then GET /v1/mounts/:brainId round-trip', () => {
  test('record.cwd from GET matches mountRoot returned by POST', async () => {
    const fakeMountRoot = '/fake/.brain/mounts/decisive/bootup';

    // Step 1: POST /v1/mount returns a mountRoot
    mockPerformEnvMount.mockImplementation(() => ({
      mountRoot: fakeMountRoot,
      noOp: false,
    }));

    // Step 2: subsequent GET /v1/mounts/bootup returns the record reflecting the same mountRoot
    mockEnumerateMounts.mockImplementation(() => [
      {
        envName: 'decisive',
        brainKey: 'bootup',
        mountRoot: fakeMountRoot,
        record: {
          brain_id: 'bootup',
          cwd: fakeMountRoot,
          environment: { name: 'decisive' },
        },
      },
    ]);

    mockLoadNetworkConfig.mockImplementation(() => ({
      config: {
        projects: [{ id: 'bootup', agent_id: 'bootup', path: '/fake/path' }],
      },
      configPath: '/fake/agentbootup.json',
    }));
    mockResolveProjectPath.mockImplementation(() => '/fake/brain/source');
    mockLoadEnvConfigFile.mockImplementation(() => ({
      ok: true,
      config: { environment: { name: 'decisive' } },
      configDir: '/fake',
      configPath: `${process.env.HOME}/decisive-env.json`,
    }));

    await withServer(async (port) => {
      // POST to mount the brain
      const postRes = await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'bootup', envConfig: `${process.env.HOME}/decisive-env.json` },
      });
      expect(postRes.status).toBe(200);
      expect(postRes.body.ok).toBe(true);
      expect(postRes.body.mountRoot).toBe(fakeMountRoot);

      // GET to retrieve the mounted brain record
      const getRes = await request(port, 'GET', '/v1/mounts/bootup');
      expect(getRes.status).toBe(200);
      expect(getRes.body.record.cwd).toBe(fakeMountRoot);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /v1/mount
// ---------------------------------------------------------------------------

describe('POST /v1/mount', () => {
  test('returns 400 when brainId is missing', async () => {
    await withServer(async (port) => {
      const res = await request(port, 'POST', '/v1/mount', {
        body: { envConfig: '/fake/env.json' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/brainId.*envConfig|brainId and envConfig/i);
    });
  });

  test('returns 400 when envConfig is missing', async () => {
    await withServer(async (port) => {
      const res = await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'brain-001' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/brainId.*envConfig|brainId and envConfig/i);
    });
  });

  test('returns 404 when brain not found in network config', async () => {
    mockLoadNetworkConfig.mockImplementation(() => ({
      config: { projects: [] },
      configPath: '/fake/agentbootup.json',
    }));
    await withServer(async (port) => {
      const res = await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'nonexistent', envConfig: `${process.env.HOME}/fake-env.json` },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('nonexistent');
    });
  });

  test('returns 400 when envConfig file is invalid', async () => {
    mockLoadNetworkConfig.mockImplementation(() => ({
      config: {
        projects: [{ id: 'brain-001', agent_id: 'brain-001', path: '/fake/path' }],
      },
      configPath: '/fake/agentbootup.json',
    }));
    mockResolveProjectPath.mockImplementation(() => '/fake/brain/source');
    mockLoadEnvConfigFile.mockImplementation(() => ({
      ok: false,
      error: 'env config not found: /fake/env.json',
    }));
    await withServer(async (port) => {
      const res = await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'brain-001', envConfig: `${process.env.HOME}/env.json` },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('env config not found');
    });
  });

  test('returns 200 with mountRoot and noOp on success', async () => {
    const expectedMountRoot = '/tmp/mounts/staging/brain-001';
    mockLoadNetworkConfig.mockImplementation(() => ({
      config: {
        projects: [{ id: 'brain-001', agent_id: 'brain-001', path: '/fake/path' }],
      },
      configPath: '/fake/agentbootup.json',
    }));
    mockResolveProjectPath.mockImplementation(() => '/fake/brain/source');
    mockLoadEnvConfigFile.mockImplementation(() => ({
      ok: true,
      config: { approval_flow: { mechanism: 'mech-plane' }, environment_skills: { optional: true } },
      configDir: '/fake/env',
      configPath: `${process.env.HOME}/env.json`,
    }));
    mockPerformEnvMount.mockImplementation(() => ({ mountRoot: expectedMountRoot, noOp: false }));
    await withServer(async (port) => {
      const res = await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'brain-001', envConfig: `${process.env.HOME}/env.json` },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.mountRoot).toBe(expectedMountRoot);
      expect(res.body.noOp).toBe(false);
    });
  });

  test('bypassApprovals defaults to false when not provided', async () => {
    mockLoadNetworkConfig.mockImplementation(() => ({
      config: {
        projects: [{ id: 'brain-001', agent_id: 'brain-001', path: '/fake/path' }],
      },
      configPath: '/fake/agentbootup.json',
    }));
    mockResolveProjectPath.mockImplementation(() => '/fake/brain/source');
    mockLoadEnvConfigFile.mockImplementation(() => ({
      ok: true,
      config: {},
      configDir: '/fake/env',
      configPath: `${process.env.HOME}/env.json`,
    }));
    const capturedOpts = {};
    mockPerformEnvMount.mockImplementation((opts) => {
      Object.assign(capturedOpts, opts);
      return { mountRoot: '/tmp/mounts/env/brain', noOp: false };
    });
    await withServer(async (port) => {
      await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'brain-001', envConfig: `${process.env.HOME}/env.json` },
      });
      expect(capturedOpts.bypassApprovals).toBe(false);
    });
  });

  test('bypassApprovals can be set to true via request body', async () => {
    mockLoadNetworkConfig.mockImplementation(() => ({
      config: {
        projects: [{ id: 'brain-001', agent_id: 'brain-001', path: '/fake/path' }],
      },
      configPath: '/fake/agentbootup.json',
    }));
    mockResolveProjectPath.mockImplementation(() => '/fake/brain/source');
    mockLoadEnvConfigFile.mockImplementation(() => ({
      ok: true,
      config: {},
      configDir: '/fake/env',
      configPath: `${process.env.HOME}/env.json`,
    }));
    const capturedOpts = {};
    mockPerformEnvMount.mockImplementation((opts) => {
      Object.assign(capturedOpts, opts);
      return { mountRoot: '/tmp/mounts/env/brain', noOp: false };
    });
    await withServer(async (port) => {
      await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'brain-001', envConfig: `${process.env.HOME}/env.json`, bypassApprovals: true },
      });
      expect(capturedOpts.bypassApprovals).toBe(true);
    });
  });

  test('surfaces err.message in 500 response when performEnvMount throws', async () => {
    mockLoadNetworkConfig.mockImplementation(() => ({
      config: {
        projects: [{ id: 'brain-001', agent_id: 'brain-001', path: '/fake/path' }],
      },
      configPath: '/fake/agentbootup.json',
    }));
    mockResolveProjectPath.mockImplementation(() => '/fake/brain/source');
    mockLoadEnvConfigFile.mockImplementation(() => ({
      ok: true,
      config: {},
      configDir: '/fake/env',
      configPath: `${process.env.HOME}/env.json`,
    }));
    mockPerformEnvMount.mockImplementation(() => {
      throw new Error('brain not in brain_allowlist for environment "staging"');
    });
    await withServer(async (port) => {
      const res = await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'brain-001', envConfig: `${process.env.HOME}/env.json` },
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain('brain not in brain_allowlist');
    });
  });

  test('returns 405 for non-POST method', async () => {
    await withServer(async (port) => {
      const res = await request(port, 'GET', '/v1/mount');
      expect(res.status).toBe(405);
    });
  });

  test('returns 400 when envConfig absolute path is outside home directory', async () => {
    mockLoadNetworkConfig.mockImplementation(() => ({
      config: {
        projects: [{ id: 'brain-001', agent_id: 'brain-001', path: '/fake/path' }],
      },
      configPath: '/fake/agentbootup.json',
    }));
    await withServer(async (port) => {
      const res = await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'brain-001', envConfig: '/etc/passwd' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('home directory');
    });
  });

  test('returns 400 when envConfig relative path resolves outside home directory', async () => {
    // Covers the relative-path branch (else clause) which also applies the home-dir bound.
    // A traversal like ../../etc/passwd from CWD can resolve outside $HOME.
    mockLoadNetworkConfig.mockImplementation(() => ({
      config: {
        projects: [{ id: 'brain-001', agent_id: 'brain-001', path: '/fake/path' }],
      },
      configPath: '/fake/agentbootup.json',
    }));
    await withServer(async (port) => {
      const res = await request(port, 'POST', '/v1/mount', {
        body: { brainId: 'brain-001', envConfig: '../../../../../../etc/passwd' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('home directory');
    });
  });

  test('returns 400 with Invalid JSON error when request body is malformed', async () => {
    // Exercises the parseBody error path: JSON.parse throws → parseBody rejects →
    // handleCreateMount pre-catch returns 400 (client error, not 500)
    await withServer(async (port) => {
      const malformedBody = 'not-valid-json{{{';
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port,
            path: '/v1/mount',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${TEST_TOKEN}`,
              'Content-Length': Buffer.byteLength(malformedBody),
            },
          },
          (res2) => {
            let data = '';
            res2.on('data', (c) => { data += c; });
            res2.on('end', () => {
              let parsed;
              try { parsed = JSON.parse(data); } catch { parsed = data; }
              resolve({ status: res2.statusCode, body: parsed });
            });
          }
        );
        req.on('error', reject);
        req.write(malformedBody);
        req.end();
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid JSON');
    });
  });
});
