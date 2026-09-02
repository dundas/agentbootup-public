/**
 * tests/daemon/webhook-secret-registration.test.ts
 *
 * Unit tests for registerWebhookWithMechPlane
 * (tested via provisionWebhookSecret with a local mock server).
 *
 * Cases:
 *   - Brain ID found → registered: true, one PATCH sent
 *   - Brain ID not found (404) → registered: false
 *   - Server error (500) → registered: false
 *   - Auth failure (401) → registered: false
 *   - Network/connection error → registered: false
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';

// Capture the native fetch at module-load time — before any test file can
// replace globalThis.fetch with a mock. Used by verifyInboxPortAndReRegister
// tests that need real HTTP connections to locally-started Bun servers.
const _nativeFetch = globalThis.fetch;

// ── helpers ───────────────────────────────────────────────────────────────────

interface PatchRecord {
  id: string;
  body: unknown;
}

interface MockServer {
  url: string;
  patches: PatchRecord[];
  /** Configure which IDs return 200 (others return 404) */
  successIds: Set<string>;
  /** Configure which IDs return a non-404 error status */
  errorIds: Map<string, number>;
  stop: () => Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  // Use port: 0 so Bun picks a free port atomically — avoids TOCTOU race
  // from pre-binding a port, closing, then re-binding in Bun.serve.
  const state: MockServer = {
    url: '',
    patches: [],
    successIds: new Set(),
    errorIds: new Map(),
    stop: async () => {},
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'PATCH' && url.pathname.startsWith('/v1/brains/')) {
        const id = decodeURIComponent(url.pathname.slice('/v1/brains/'.length));
        return req.json().then((body: unknown) => {
          state.patches.push({ id, body });
          if (state.errorIds.has(id)) {
            return new Response('Error', { status: state.errorIds.get(id) });
          }
          if (state.successIds.has(id)) {
            return Response.json({ ok: true });
          }
          return new Response('Not Found', { status: 404 });
        });
      }
      return new Response('Not Found', { status: 404 });
    },
  });

  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = async () => server.stop(true);
  return state;
}

// ── test module ───────────────────────────────────────────────────────────────

let provisionWebhookSecret: (
  brainId: string,
  port: number,
  opts?: Record<string, unknown>
) => Promise<{ secret: string; webhookUrl: string; registered: boolean }>;

let configDir: string;

beforeAll(async () => {
  configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webhook-secret-test-'));
  process.env.AGENTBOOTUP_CONFIG_FILE = path.join(configDir, 'config.json');
  // @ts-ignore — .js module
  ({ provisionWebhookSecret } = await import('../../lib/brain/webhook-secret.js'));
});

afterAll(async () => {
  await fsp.rm(configDir, { recursive: true, force: true });
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
});

describe('registerWebhookWithMechPlane', () => {
  test('brain ID found → registered: true, one PATCH sent', async () => {
    const srv = await startMockServer();
    srv.successIds.add('myapp');
    try {
      const r = await provisionWebhookSecret('myapp', 9001, {
        mechPlaneUrl: srv.url,
        apiKey: 'tok',
        verbose: false,
      });
      expect(r.registered).toBe(true);
      expect(srv.patches.length).toBe(1);
      expect(srv.patches[0].id).toBe('myapp');
    } finally {
      await srv.stop();
    }
  });

  test('PATCH body contains webhookUrl and webhookSecret', async () => {
    const srv = await startMockServer();
    srv.successIds.add('myapp');
    try {
      const r = await provisionWebhookSecret('myapp', 9001, {
        mechPlaneUrl: srv.url,
        apiKey: 'tok',
        verbose: false,
      });
      expect(r.registered).toBe(true);
      const body = srv.patches[0].body as Record<string, unknown>;
      expect(typeof body.webhookUrl).toBe('string');
      expect(typeof body.webhookSecret).toBe('string');
      expect(body.webhookUrl).toBe('http://127.0.0.1:9001/webhook');
    } finally {
      await srv.stop();
    }
  });

  test('brain ID not found (404) → registered: false', async () => {
    const srv = await startMockServer();
    // successIds empty — returns 404
    try {
      const r = await provisionWebhookSecret('myapp', 9001, {
        mechPlaneUrl: srv.url,
        apiKey: 'tok',
        verbose: false,
      });
      expect(r.registered).toBe(false);
      expect(srv.patches.length).toBe(1);
    } finally {
      await srv.stop();
    }
  });

  test('server error (500) → registered: false', async () => {
    const srv = await startMockServer();
    srv.errorIds.set('myapp', 500);
    try {
      const r = await provisionWebhookSecret('myapp', 9001, {
        mechPlaneUrl: srv.url,
        apiKey: 'tok',
        verbose: false,
      });
      expect(r.registered).toBe(false);
      expect(srv.patches.length).toBe(1);
    } finally {
      await srv.stop();
    }
  });

  test('auth failure (401) → registered: false', async () => {
    const srv = await startMockServer();
    srv.errorIds.set('myapp', 401);
    try {
      const r = await provisionWebhookSecret('myapp', 9001, {
        mechPlaneUrl: srv.url,
        apiKey: 'tok',
        verbose: false,
      });
      expect(r.registered).toBe(false);
      expect(srv.patches.length).toBe(1);
    } finally {
      await srv.stop();
    }
  });

  test('network/connection error → registered: false', async () => {
    const r = await provisionWebhookSecret('myapp', 9001, {
      mechPlaneUrl: 'http://127.0.0.1:1',  // port 1 is always refused
      apiKey: 'tok',
      verbose: false,
    });
    expect(r.registered).toBe(false);
  });
});

// ── verifyInboxPortAndReRegister ──────────────────────────────────────────────

let verifyInboxPortAndReRegister: (
  brainId: string,
  expectedPort: number,
  opts?: Record<string, unknown>
) => Promise<{ drifted: boolean; verified: boolean; actualPort?: number; registered?: boolean }>;

/**
 * Start a minimal /health mock server that returns { status: "ok", brainId, port }.
 * Returns { url, port, stop }.
 */
async function startHealthServer(brainId: string, reportedPort: number): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok', brainId, port: reportedPort });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  return {
    port: server.port,
    stop: async () => server.stop(true),
  };
}

describe('verifyInboxPortAndReRegister', () => {
  beforeAll(async () => {
    // @ts-ignore — .js module
    ({ verifyInboxPortAndReRegister } = await import('../../lib/brain/webhook-secret.js'));
  });

  beforeEach(() => {
    // Restore native fetch so each test makes real HTTP connections to local servers.
    // _nativeFetch was captured at module-load time, before any test mock can replace it.
    globalThis.fetch = _nativeFetch;
  });

  test('returns verified=true when port matches', async () => {
    const srv = await startHealthServer('brain-A', 0); // reportedPort will be replaced below
    // We need the server's actual port as the reported port too.
    await srv.stop();

    // Re-create with matching reported port.
    const srv2 = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/health') {
          // Report the same port the server is bound to.
          return Response.json({ status: 'ok', brainId: 'brain-A', port: (srv2 as any).port });
        }
        return new Response('Not Found', { status: 404 });
      },
    });
    const actualPort = (srv2 as any).port;
    try {
      const result = await verifyInboxPortAndReRegister('brain-A', actualPort, { verbose: false });
      expect(result.verified).toBe(true);
      expect(result.drifted).toBe(false);
    } finally {
      srv2.stop(true);
    }
  });

  test('returns drifted=true when port mismatches', async () => {
    // Server bound on one port but /health reports a DIFFERENT port.
    const differentPort = 19999;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/health') {
          return Response.json({ status: 'ok', brainId: 'brain-B', port: differentPort });
        }
        return new Response('Not Found', { status: 404 });
      },
    });
    const boundPort = (server as any).port;
    try {
      const result = await verifyInboxPortAndReRegister('brain-B', boundPort, { verbose: false });
      expect(result.drifted).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.actualPort).toBe(differentPort);
    } finally {
      server.stop(true);
    }
  });

  test('re-patches mech-plane on drift', async () => {
    const driftedPort = 29999;
    const patchedUrls: string[] = [];

    // Mock /health server that reports a drifted port.
    const inboxServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/health') {
          return Response.json({ status: 'ok', brainId: 'brain-C', port: driftedPort });
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    // Mock mech-plane server that captures PATCH body.
    const mechServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'PATCH' && url.pathname.startsWith('/v1/brains/')) {
          return req.json().then((body: any) => {
            patchedUrls.push(body.webhookUrl);
            return Response.json({ ok: true });
          });
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    // Provision a secret for brain-C first (so getWebhookSecret returns non-null).
    await provisionWebhookSecret('brain-C', (inboxServer as any).port, { verbose: false });

    const boundPort = (inboxServer as any).port;
    const mechUrl = `http://127.0.0.1:${(mechServer as any).port}`;
    try {
      const result = await verifyInboxPortAndReRegister('brain-C', boundPort, {
        mechPlaneUrl: mechUrl,
        apiKey: 'test-key',
        verbose: false,
      });
      expect(result.drifted).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.registered).toBe(true);
      expect(patchedUrls.length).toBe(1);
      expect(patchedUrls[0]).toBe(`http://127.0.0.1:${driftedPort}/webhook`);
    } finally {
      inboxServer.stop(true);
      mechServer.stop(true);
    }
  });

  test('returns verified=false on connection failure', async () => {
    // Port 2 is not listening.
    const result = await verifyInboxPortAndReRegister('brain-D', 2, { verbose: false });
    expect(result.verified).toBe(false);
    expect(result.drifted).toBe(false);
  });
});
