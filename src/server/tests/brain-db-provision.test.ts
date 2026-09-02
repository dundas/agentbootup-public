/**
 * Tests for POST /v1/brain-db/provision
 * Tests the route handler directly (no HTTP server needed).
 */

import { test, expect, beforeAll, afterEach } from 'bun:test';
import { handleBrainDbProvision } from '../routes/brain-db';
import type { MechClient } from '../lib/mech-client';

// Generate a real Ed25519 keypair once for all tests
let privateKeyBase64: string;

beforeAll(async () => {
  const keypair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const privateDer = await crypto.subtle.exportKey('pkcs8', keypair.privateKey);
  privateKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(privateDer)));
});

afterEach(() => {
  delete process.env.SQLD_JWT_PRIVATE_KEY;
  delete process.env.SQLD_SERVER;
});

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/v1/brain-db/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── 501 when not configured ───────────────────────────────────────────────────

test('returns 501 when SQLD_JWT_PRIVATE_KEY not set', async () => {
  const req = makeRequest({ brain_id: 'decisive' });
  const res = await handleBrainDbProvision(req).catch((e) => e);
  // HttpError is thrown — check it
  expect(res.status).toBe(501);
  expect(res.code).toBe('brain_db_not_configured');
});

test('returns wrapper-backed db_url and db_token when mech libsql provision succeeds', async () => {
  const req = makeRequest({ brain_id: 'decisive' });
  const expectedUrl = 'https://storage.mechdna.net/api/apps/app/libsql/decisive';
  const mechClient = {
    libsql() {
      return {
        provision: async ({ namespace }: { namespace: string }) => ({
          syncUrl: `https://storage.mechdna.net/api/apps/app/libsql/${namespace}`,
          authToken: 'wrapper-token',
        }),
      };
    },
  };

  const res = await handleBrainDbProvision(req, { mechClient: mechClient as Pick<MechClient, 'libsql'> });
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { db_url: string; db_token: string } };
  expect(body.data.db_url).toBe(expectedUrl);
  expect(body.data.db_token).toBe('wrapper-token');
});

test('falls back to legacy JWT path when wrapper fails and SQLD_JWT_PRIVATE_KEY is set', async () => {
  process.env.SQLD_JWT_PRIVATE_KEY = privateKeyBase64;
  const req = makeRequest({ brain_id: 'decisive' });
  const mechClient = {
    libsql() {
      return {
        provision: async () => {
          throw new Error('wrapper unavailable');
        },
      };
    },
  };

  const res = await handleBrainDbProvision(req, { mechClient: mechClient as Pick<MechClient, 'libsql'> });
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { db_url: string; db_token: string } };
  expect(body.data.db_url).toContain('decisive');
  expect(typeof body.data.db_token).toBe('string');
});

test('returns 502 when wrapper fails and no legacy fallback is configured', async () => {
  const req = makeRequest({ brain_id: 'decisive' });
  const mechClient = {
    libsql() {
      return {
        provision: async () => {
          throw new Error('wrapper unavailable');
        },
      };
    },
  };

  const res = await handleBrainDbProvision(req, { mechClient: mechClient as Pick<MechClient, 'libsql'> }).catch((e) => e);
  expect(res.status).toBe(502);
  expect(res.code).toBe('brain_db_provision_failed');
});

// ── 400 for bad input ─────────────────────────────────────────────────────────

test('returns 400 for missing brain_id', async () => {
  process.env.SQLD_JWT_PRIVATE_KEY = privateKeyBase64;
  const req = makeRequest({});
  const res = await handleBrainDbProvision(req).catch((e) => e);
  expect(res.status).toBe(400);
});

test('returns 400 for invalid brain_id characters', async () => {
  process.env.SQLD_JWT_PRIVATE_KEY = privateKeyBase64;
  const req = makeRequest({ brain_id: 'has spaces!' });
  const res = await handleBrainDbProvision(req).catch((e) => e);
  expect(res.status).toBe(400);
});

// ── 200 success ───────────────────────────────────────────────────────────────

test('returns db_url and db_token on success', async () => {
  process.env.SQLD_JWT_PRIVATE_KEY = privateKeyBase64;
  const req = makeRequest({ brain_id: 'decisive' });
  const res = await handleBrainDbProvision(req);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { db_url: string; db_token: string } };
  expect(body.data.db_url).toContain('decisive');
  expect(typeof body.data.db_token).toBe('string');
  expect(body.data.db_token.split('.')).toHaveLength(3);
});

test('db_url contains brain_id as path segment', async () => {
  process.env.SQLD_JWT_PRIVATE_KEY = privateKeyBase64;
  const req = makeRequest({ brain_id: 'bootup' });
  const res = await handleBrainDbProvision(req);
  const body = await res.json() as { data: { db_url: string } };
  expect(body.data.db_url).toMatch(/\/bootup$/);
});

test('uses SQLD_SERVER env var when set', async () => {
  process.env.SQLD_JWT_PRIVATE_KEY = privateKeyBase64;
  process.env.SQLD_SERVER = 'https://my-custom-sqld.example.com';
  const req = makeRequest({ brain_id: 'mech-plane' });
  const res = await handleBrainDbProvision(req);
  const body = await res.json() as { data: { db_url: string } };
  expect(body.data.db_url).toMatch(/^https:\/\/my-custom-sqld\.example\.com\/mech-plane$/);
});

test('JWT payload contains a:rw claim', async () => {
  process.env.SQLD_JWT_PRIVATE_KEY = privateKeyBase64;
  const req = makeRequest({ brain_id: 'decisive' });
  const res = await handleBrainDbProvision(req);
  const body = await res.json() as { data: { db_token: string } };
  const [, payloadB64] = body.data.db_token.split('.');
  const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
  const payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  expect(payload.a).toBe('rw');
});

test('JWT exp is within 90 days', async () => {
  process.env.SQLD_JWT_PRIVATE_KEY = privateKeyBase64;
  const req = makeRequest({ brain_id: 'decisive' });
  const res = await handleBrainDbProvision(req);
  const body = await res.json() as { data: { db_token: string } };
  const [, payloadB64] = body.data.db_token.split('.');
  const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
  const payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  const now = Math.floor(Date.now() / 1000);
  const ninetyDays = 90 * 24 * 60 * 60;
  expect(payload.exp).toBeGreaterThan(now);
  expect(payload.exp).toBeLessThanOrEqual(now + ninetyDays + 5);
});
