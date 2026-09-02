import { describe, test, expect, beforeEach } from 'bun:test';
import { authorizeRequest } from '../lib/request-auth';
import { ExternalApiKeyStore } from '../lib/external-api-key-store';
import { ExternalRateLimiter } from '../lib/external-rate-limit';
import { isRouteAllowedForPrincipal, isExternalPublicRoute } from '../lib/public-route-policy';
import { MockMechClient } from './helpers/mock-mech-client';
import type { MechDocument } from '../types';
import {
  FIXTURE_ADMIN_API_KEY,
  FIXTURE_EXTERNAL_API_KEY_ID,
  FIXTURE_EXTERNAL_API_KEY_LABEL,
  FIXTURE_EXTERNAL_API_KEY_SECRET,
  FIXTURE_EXTERNAL_USER_ID,
} from './fixtures/external-auth';
import { EXTERNAL_API_KEY_PREFIX, EXTERNAL_RATE_LIMIT_PER_MINUTE } from '../config';
import { handleArchiveV2Route } from '../routes/transcript-archive';

class CountingMechClient extends MockMechClient {
  listCalls = 0;
  pageCalls = 0;

  async listDocuments(collection: string): Promise<MechDocument[]> {
    this.listCalls += 1;
    return super.listDocuments(collection);
  }

  async listDocumentsPage(collection: string, opts: { offset?: number; limit?: number } = {}) {
    this.pageCalls += 1;
    return super.listDocumentsPage(collection, opts);
  }
}

function makeRequest(path: string, token?: string, method = 'GET'): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${path}`, { method, headers });
}

describe('public-route-policy', () => {
  test('allowlists the v1 external bootstrap and registry read routes', () => {
    expect(isExternalPublicRoute('GET', '/v1/auth/status')).toBe(true);
    expect(isExternalPublicRoute('GET', '/v1/registry/search')).toBe(true);
    expect(isExternalPublicRoute('GET', '/v1/registry/services')).toBe(true);
    expect(isExternalPublicRoute('GET', '/v1/registry/skills')).toBe(true);
    expect(isExternalPublicRoute('GET', '/v1/registry/search?q=health')).toBe(true);
    expect(isExternalPublicRoute('GET', '/v1/brains')).toBe(false);
    expect(isExternalPublicRoute('POST', '/v1/registry/publish')).toBe(false);
  });

  test('allows only method-shaped archive-v2 routes for tenant authorization downstream', () => {
    const upload = `up_${'a'.repeat(64)}`;
    const version = `av_${'b'.repeat(64)}`;
    expect(isExternalPublicRoute('POST', '/v1/archive-v2/manifests/declare')).toBe(true);
    expect(isExternalPublicRoute('PUT', `/v1/archive-v2/uploads/${upload}/parts/0`)).toBe(true);
    expect(isExternalPublicRoute('POST', `/v1/archive-v2/uploads/${upload}/commit`)).toBe(true);
    expect(isExternalPublicRoute('GET', '/v1/archive-v2/brains/brain-a/inventory')).toBe(true);
    expect(isExternalPublicRoute('GET', '/v1/archive-v2/brains/brain-a/capabilities')).toBe(true);
    expect(isExternalPublicRoute('GET', `/v1/archive-v2/brains/brain-a/versions/${version}/content`)).toBe(true);
    expect(isExternalPublicRoute('POST', `/v1/archive-v2/brains/brain-a/versions/${version}/verify`)).toBe(true);
    expect(isExternalPublicRoute('DELETE', `/v1/archive-v2/uploads/${upload}/commit`)).toBe(false);
    expect(isExternalPublicRoute('GET', '/v1/archive-v2/brains/brain-a/delete')).toBe(false);
  });

  test('admin principal can access internal routes', () => {
    expect(isRouteAllowedForPrincipal({ kind: 'admin', credential_id: 'admin_test' }, 'GET', '/v1/brains')).toBe(true);
  });

  test('external principal is default-deny outside allowlist', () => {
    const external = { kind: 'external' as const, user_id: 'u1', key_id: 'k1' };
    expect(isRouteAllowedForPrincipal(external, 'GET', '/v1/auth/status')).toBe(true);
    expect(isRouteAllowedForPrincipal(external, 'GET', '/v1/brains')).toBe(false);
    expect(isRouteAllowedForPrincipal(
      external,
      'GET',
      '/v1/brain-assets/test-brain/capabilities',
    )).toBe(false);
    expect(isRouteAllowedForPrincipal(
      external,
      'GET',
      '/v1/brain-assets/test-brain',
    )).toBe(false);
    expect(isRouteAllowedForPrincipal(
      external,
      'POST',
      '/v1/brain-assets/test-brain/push',
    )).toBe(false);
  });

  test('external owner can reach only the fixed AgentHost ceremony shapes', () => {
    const allowed = [
      ['POST', '/v1/brains/brain-a/agent-hosts/enrollment-challenges'],
      ['POST', '/v1/brains/brain-a/agent-hosts/enrollments/ahe_123/redeem'],
      ['DELETE', '/v1/brains/brain-a/agent-hosts/host-a'],
      ['GET', '/v1/brains/brain-a/agent-host-target'],
      ['POST', '/v1/brains/brain-a/agent-host-session-grants'],
    ] as const;
    for (const [method, path] of allowed) expect(isExternalPublicRoute(method, path)).toBe(true);
    expect(isExternalPublicRoute('GET', '/v1/brains/brain-a/agent-hosts/enrollment-challenges')).toBe(false);
    expect(isExternalPublicRoute('POST', '/v1/brains/brain-a/agent-hosts/host-a')).toBe(false);
    expect(isExternalPublicRoute('GET', '/v1/brains/brain-a/agent-hosts')).toBe(false);
  });

  test('external owner can reach only the fixed remote-local operation shapes', () => {
    const base = '/v1/remote-local/brains/brain-a';
    for (const [method, path] of [
      ['GET', `${base}/sessions`],
      ['POST', `${base}/sessions/rsh_abcdefghijklmnop/turns`],
      ['POST', `${base}/sessions/rsh_abcdefghijklmnop/approvals`],
      ['GET', `${base}/commands/rlc_abcdefghijklmnop`],
      ['GET', `${base}/commands/rlc_abcdefghijklmnop/events`],
      ['POST', `${base}/enrollments`],
      ['POST', `${base}/enrollments/lde_abcdefghijklmnop/complete`],
    ] as const) expect(isExternalPublicRoute(method, path)).toBe(true);
    expect(isExternalPublicRoute('POST', `${base}/sessions/rsh_abcdefghijklmnop/events`)).toBe(false);
    expect(isExternalPublicRoute('GET', `${base}/commands/rlc_abcdefghijklmnop/secret`)).toBe(false);
    expect(isExternalPublicRoute('GET', `${base}/enrollments`)).toBe(false);
    expect(isExternalPublicRoute('POST', `${base}/enrollments/lde_abcdefghijklmnop`)).toBe(false);
  });
});

describe('authorizeRequest', () => {
  let store: ExternalApiKeyStore;
  let rateLimiter: ExternalRateLimiter;
  let mech: CountingMechClient;

  beforeEach(async () => {
    mech = new CountingMechClient();
    store = new ExternalApiKeyStore(mech);
    rateLimiter = new ExternalRateLimiter({ limit: EXTERNAL_RATE_LIMIT_PER_MINUTE, windowMs: 60_000 });
    await store.ensureFixture({
      id: FIXTURE_EXTERNAL_API_KEY_ID,
      user_id: FIXTURE_EXTERNAL_USER_ID,
      label: FIXTURE_EXTERNAL_API_KEY_LABEL,
      secret: FIXTURE_EXTERNAL_API_KEY_SECRET,
    });
    mech.listCalls = 0;
    mech.pageCalls = 0;
  });

  const makeDeps = () => ({
    adminApiKey: FIXTURE_ADMIN_API_KEY,
    externalApiKeyPrefix: EXTERNAL_API_KEY_PREFIX,
    externalKeyStore: store,
    rateLimiter,
  });

  test('admin key reaches internal routes', async () => {
    const result = await authorizeRequest(
      makeRequest('/v1/brains', FIXTURE_ADMIN_API_KEY),
      'GET',
      '/v1/brains',
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.kind).toBe('admin');
  });

  test('external key succeeds on allowlisted route', async () => {
    const result = await authorizeRequest(
      makeRequest('/v1/auth/status', FIXTURE_EXTERNAL_API_KEY_SECRET),
      'GET',
      '/v1/auth/status',
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.kind).toBe('external');
      expect(result.principal.key_id).toBe(FIXTURE_EXTERNAL_API_KEY_ID);
    }
  });

  test('external bearer authenticates through policy into the tenant-bound archive handler', async () => {
    const path = '/v1/archive-v2/brains/brain-owned/inventory';
    const request = makeRequest(path, FIXTURE_EXTERNAL_API_KEY_SECRET);
    const auth = await authorizeRequest(request, 'GET', path, makeDeps());
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    const archiveStore = {
      listInventory: async (tenantId: string, brainId: string) => ({ items: [{ tenantId, brainId }], nextCursor: null }),
    };
    const brainStore = {
      get: async () => ({ id: 'brain-owned', metadata: { archive_tenant_id: FIXTURE_EXTERNAL_USER_ID } }),
    };
    const response = await handleArchiveV2Route(
      request, new URL(request.url), auth.principal, brainStore as never, archiveStore as never,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ data: { items: [{ tenantId: FIXTURE_EXTERNAL_USER_ID, brainId: 'brain-owned' }], nextCursor: null } });
  });

  test('external auth uses one explicit page scan including touchLastUsed', async () => {
    const result = await authorizeRequest(
      makeRequest('/v1/auth/status', FIXTURE_EXTERNAL_API_KEY_SECRET),
      'GET',
      '/v1/auth/status',
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    // touchLastUsed is fire-and-forget; flush async work so a regressed second scan would show up.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // externalVerified skips getWithDocId — no second paginated scan.
    expect(mech.pageCalls).toBe(1);
    expect(mech.listCalls).toBe(0);
  });

  test('external key is forbidden on internal route', async () => {
    const result = await authorizeRequest(
      makeRequest('/v1/brains', FIXTURE_EXTERNAL_API_KEY_SECRET),
      'GET',
      '/v1/brains',
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  test('missing bearer returns unauthorized', async () => {
    const result = await authorizeRequest(makeRequest('/v1/auth/status'), 'GET', '/v1/auth/status', makeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  test('external key returns 429 when rate limit exceeded', async () => {
    const limited = new ExternalRateLimiter({ limit: 2, windowMs: 60_000 });
    const limitedDeps = { ...makeDeps(), rateLimiter: limited };

    const first = await authorizeRequest(
      makeRequest('/v1/auth/status', FIXTURE_EXTERNAL_API_KEY_SECRET),
      'GET',
      '/v1/auth/status',
      limitedDeps,
    );
    const second = await authorizeRequest(
      makeRequest('/v1/auth/status', FIXTURE_EXTERNAL_API_KEY_SECRET),
      'GET',
      '/v1/auth/status',
      limitedDeps,
    );
    const third = await authorizeRequest(
      makeRequest('/v1/auth/status', FIXTURE_EXTERNAL_API_KEY_SECRET),
      'GET',
      '/v1/auth/status',
      limitedDeps,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.response.status).toBe(429);
  });
});
