import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { ExternalApiKeyStore } from '../lib/external-api-key-store';
import { ExternalUserStore } from '../lib/external-user-store';
import { ExternalAuthAuditStore } from '../lib/external-auth-audit-store';
import { DeviceAuthStore } from '../lib/device-auth-store';
import { ExternalKeyService } from '../lib/external-key-service';
import { ConsoleEphemeralStore } from '../lib/console-ephemeral-store';
import { MockMechClient } from './helpers/mock-mech-client';
import { handleExternalApiKeysRoute } from '../routes/external-api-keys';
import { handleDeveloperConsoleRoute, translateDeveloperConsoleHttpError } from '../routes/developer-console';
import { HttpError } from '../errors';
import { handleDeviceAuthRoute } from '../routes/device-auth';
import { handleExternalAuthAuditRoute } from '../routes/external-auth-audit';
import {
  FIXTURE_ADMIN_API_KEY,
  FIXTURE_EXTERNAL_API_KEY_SECRET,
  FIXTURE_EXTERNAL_USER_ID,
} from './fixtures/external-auth';
import { EXTERNAL_MAX_ACTIVE_KEYS_PER_USER } from '../config';
import { authorizeRequest } from '../lib/request-auth';
import { ExternalRateLimiter } from '../lib/external-rate-limit';

let priorNodeEnv: string | undefined;
let priorAllowTestSession: string | undefined;

beforeAll(() => {
  priorNodeEnv = process.env.NODE_ENV;
  priorAllowTestSession = process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
  process.env.NODE_ENV = 'test';
  process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = '1';
});

afterAll(() => {
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorNodeEnv;

  if (priorAllowTestSession === undefined) delete process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
  else process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = priorAllowTestSession;
});

const TEST_SESSION = {
  id: 'clearauth-user-0041',
  email: 'dev@example.com',
  email_verified: true,
};

function buildDeps(mech: MockMechClient) {
  const externalKeyStore = new ExternalApiKeyStore(mech);
  const externalUserStore = new ExternalUserStore(mech);
  const auditStore = new ExternalAuthAuditStore(mech);
  const deviceAuthStore = new DeviceAuthStore(mech);
  const ephemeralStore = new ConsoleEphemeralStore(mech);
  const keyService = new ExternalKeyService(
    externalKeyStore,
    auditStore,
    EXTERNAL_MAX_ACTIVE_KEYS_PER_USER,
  );
  const sessionDeps = {
    clearAuth: {
      config: {} as never,
      handleRequest: async () => new Response('not used'),
      getSessionUser: async () => null,
    },
    externalUserStore,
    testSessionUser: TEST_SESSION,
  };
  return {
    mech,
    externalKeyStore,
    externalUserStore,
    auditStore,
    deviceAuthStore,
    ephemeralStore,
    keyService,
    sessionDeps,
  };
}

async function deviceApproveForm(deps: ReturnType<typeof buildDeps>, userCode: string): Promise<FormData> {
  const csrf = await deps.ephemeralStore.issueCsrfToken(`ext_${TEST_SESSION.id}`);
  const form = new FormData();
  form.set('csrf_token', csrf);
  form.set('user_code', userCode);
  return form;
}

async function keysCreateForm(deps: ReturnType<typeof buildDeps>, label: string): Promise<FormData> {
  await deps.externalUserStore.findOrCreate({
    clearauth_user_id: TEST_SESSION.id,
    email: TEST_SESSION.email,
  });
  const csrf = await deps.ephemeralStore.issueCsrfToken(`ext_${TEST_SESSION.id}`);
  const form = new FormData();
  form.set('csrf_token', csrf);
  form.set('label', label);
  return form;
}

describe('external auth routes (Parent 2.0)', () => {
  let mech: MockMechClient;
  let deps: ReturnType<typeof buildDeps>;

  beforeEach(() => {
    mech = new MockMechClient();
    deps = buildDeps(mech);
  });

  test('sign-in resolves hosted external user on first key create', async () => {
    const req = new Request('http://localhost/v1/developer/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Laptop' }),
    });
    const res = await handleExternalApiKeysRoute(req, 'POST', '/v1/developer/api-keys', {
      ...deps.sessionDeps,
      keyService: deps.keyService,
    });
    expect(res?.status).toBe(201);
    const body = await res?.json() as { data: { secret: string; key: { id: string; user_id: string } } };
    expect(body.data.secret.startsWith('abu_live_')).toBe(true);
    expect(body.data.key.user_id).toBe(`ext_${TEST_SESSION.id}`);
    const verified = await deps.externalKeyStore.verifyBearerToken(body.data.secret);
    expect(verified?.key.id).toBe(body.data.key.id);
    expect(verified?.key.user_id).toBe(body.data.key.user_id);

    const user = await deps.externalUserStore.getByClearAuthUserId(TEST_SESSION.id);
    expect(user?.email).toBe('dev@example.com');
  });

  test('developer login and registration pages use ClearAuth JSON endpoints', async () => {
    const login = await handleDeveloperConsoleRoute(
      new Request('http://localhost/developer/login?return=%2Fdeveloper%2Fkeys'),
      'GET',
      '/developer/login',
      { ...deps.sessionDeps, keyService: deps.keyService, deviceAuthStore: deps.deviceAuthStore, ephemeralStore: deps.ephemeralStore, publicBaseUrl: 'http://localhost:3000', maxActiveKeys: EXTERNAL_MAX_ACTIVE_KEYS_PER_USER },
    );
    expect(login?.status).toBe(200);
    const loginHtml = await login!.text();
    expect(loginHtml).toContain('data-auth-endpoint="/auth/login"');
    expect(loginHtml).toContain('content-type\': \'application/json\'');
    const loginNonce = loginHtml.match(/<script nonce="([A-Za-z0-9_-]+)">/);
    expect(loginNonce?.[1]).toBeDefined();
    expect(login?.headers.get('content-security-policy')).toContain(`script-src 'nonce-${loginNonce?.[1]}'`);
    expect(login?.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(loginHtml).toContain('data-return-path="/developer/keys"');
    expect(loginHtml).toContain('/developer/register?return=%2Fdeveloper%2Fkeys');

    const registration = await handleDeveloperConsoleRoute(
      new Request('http://localhost/developer/register?return=%2Fdeveloper%2Fkeys'),
      'GET',
      '/developer/register',
      { ...deps.sessionDeps, keyService: deps.keyService, deviceAuthStore: deps.deviceAuthStore, ephemeralStore: deps.ephemeralStore, publicBaseUrl: 'http://localhost:3000', maxActiveKeys: EXTERNAL_MAX_ACTIVE_KEYS_PER_USER },
    );
    expect(registration?.status).toBe(200);
    const registrationHtml = await registration!.text();
    expect(registrationHtml).toContain('data-auth-endpoint="/auth/register"');
    expect(registrationHtml).toContain('autocomplete="new-password"');
    expect(registrationHtml).toContain('data-return-path="/developer/keys"');
    expect(registrationHtml).toContain('/developer/login?return=%2Fdeveloper%2Fkeys');
    const registrationNonce = registrationHtml.match(/<script nonce="([A-Za-z0-9_-]+)">/);
    expect(registrationNonce?.[1]).toBeDefined();
    expect(registration?.headers.get('content-security-policy')).toContain(`script-src 'nonce-${registrationNonce?.[1]}'`);
  });

  test('console POST /developer/keys rejects empty label', async () => {
    const form = await keysCreateForm(deps, '');
    const res = await handleDeveloperConsoleRoute(
      new Request('http://localhost/developer/keys', { method: 'POST', body: form }),
      'POST',
      '/developer/keys',
      { ...deps.sessionDeps, keyService: deps.keyService, deviceAuthStore: deps.deviceAuthStore, ephemeralStore: deps.ephemeralStore, publicBaseUrl: 'http://localhost:3000' },
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get('location')).toBe('http://localhost:3000/developer/keys');
    const keys = await deps.keyService.listForUser(`ext_${TEST_SESSION.id}`);
    expect(keys).toHaveLength(0);
  });

  test('console POST /developer/keys rejects label longer than 120 characters', async () => {
    const form = await keysCreateForm(deps, 'x'.repeat(121));
    const res = await handleDeveloperConsoleRoute(
      new Request('http://localhost/developer/keys', { method: 'POST', body: form }),
      'POST',
      '/developer/keys',
      { ...deps.sessionDeps, keyService: deps.keyService, deviceAuthStore: deps.deviceAuthStore, ephemeralStore: deps.ephemeralStore, publicBaseUrl: 'http://localhost:3000' },
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get('location')).toBe('http://localhost:3000/developer/keys');
    const keys = await deps.keyService.listForUser(`ext_${TEST_SESSION.id}`);
    expect(keys).toHaveLength(0);
  });

  test('key creation returns one-time secret; list shows metadata only', async () => {
    const createReq = new Request('http://localhost/v1/developer/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Primary' }),
    });
    const createRes = await handleExternalApiKeysRoute(createReq, 'POST', '/v1/developer/api-keys', {
      ...deps.sessionDeps,
      keyService: deps.keyService,
    });
    const created = await createRes?.json() as { data: { secret: string } };
    expect(created.data.secret.length).toBeGreaterThan(20);

    const listReq = new Request('http://localhost/v1/developer/api-keys');
    const listRes = await handleExternalApiKeysRoute(listReq, 'GET', '/v1/developer/api-keys', {
      ...deps.sessionDeps,
      keyService: deps.keyService,
    });
    const listed = await listRes?.json() as { data: { keys: Array<Record<string, unknown>> } };
    expect(listed.data.keys).toHaveLength(1);
    expect(listed.data.keys[0]).not.toHaveProperty('secret');
    expect(listed.data.keys[0]).not.toHaveProperty('secret_hash');
  });

  test('keys page purges expired ephemeral docs once per render', async () => {
    const userId = `ext_${TEST_SESSION.id}`;
    await deps.externalUserStore.findOrCreate({
      clearauth_user_id: TEST_SESSION.id,
      email: TEST_SESSION.email,
    });
    await deps.keyService.createForUser(userId, 'Laptop');
    await deps.keyService.createForUser(userId, 'Server');

    let purgeCalls = 0;
    const originalPurge = deps.ephemeralStore.purgeExpiredNow.bind(deps.ephemeralStore);
    deps.ephemeralStore.purgeExpiredNow = async () => {
      purgeCalls += 1;
      return originalPurge();
    };

    const res = await handleDeveloperConsoleRoute(
      new Request('http://localhost/developer/keys'),
      'GET',
      '/developer/keys',
      {
        ...deps.sessionDeps,
        keyService: deps.keyService,
        deviceAuthStore: deps.deviceAuthStore,
        ephemeralStore: deps.ephemeralStore,
        publicBaseUrl: 'http://localhost:3000',
        maxActiveKeys: EXTERNAL_MAX_ACTIVE_KEYS_PER_USER,
      },
    );
    expect(res?.status).toBe(200);
    expect(purgeCalls).toBe(1);
  });

  test('keys page with flash param still purges expired ephemeral docs once', async () => {
    const userId = `ext_${TEST_SESSION.id}`;
    await deps.externalUserStore.findOrCreate({
      clearauth_user_id: TEST_SESSION.id,
      email: TEST_SESSION.email,
    });
    const flashId = await deps.ephemeralStore.createFlashSecret(userId, 'flash-secret-once', 'flash');

    let purgeCalls = 0;
    const originalPurge = deps.ephemeralStore.purgeExpiredNow.bind(deps.ephemeralStore);
    deps.ephemeralStore.purgeExpiredNow = async () => {
      purgeCalls += 1;
      return originalPurge();
    };

    const res = await handleDeveloperConsoleRoute(
      new Request(`http://localhost/developer/keys?flash=${encodeURIComponent(flashId)}`),
      'GET',
      '/developer/keys',
      {
        ...deps.sessionDeps,
        keyService: deps.keyService,
        deviceAuthStore: deps.deviceAuthStore,
        ephemeralStore: deps.ephemeralStore,
        publicBaseUrl: 'http://localhost:3000',
        maxActiveKeys: EXTERNAL_MAX_ACTIVE_KEYS_PER_USER,
      },
    );
    expect(res?.status).toBe(200);
    expect(purgeCalls).toBe(1);
    const html = await res!.text();
    expect(html).toContain('flash-secret-once');
  });

  test('sixth active key create is rejected', async () => {
    const userId = `ext_${TEST_SESSION.id}`;
    for (let i = 0; i < EXTERNAL_MAX_ACTIVE_KEYS_PER_USER; i++) {
      await deps.keyService.createForUser(userId, `key-${i}`);
    }
    const req = new Request('http://localhost/v1/developer/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'one-too-many' }),
    });
    await expect(handleExternalApiKeysRoute(req, 'POST', '/v1/developer/api-keys', {
      ...deps.sessionDeps,
      keyService: deps.keyService,
    })).rejects.toMatchObject({ status: 409 });
  });

  test('console POST /developer/keys throws limit_exceeded when at cap', async () => {
    const userId = `ext_${TEST_SESSION.id}`;
    for (let i = 0; i < EXTERNAL_MAX_ACTIVE_KEYS_PER_USER; i++) {
      await deps.keyService.createForUser(userId, `key-${i}`);
    }
    const form = await keysCreateForm(deps, 'one-too-many');
    await expect(handleDeveloperConsoleRoute(
      new Request('http://localhost/developer/keys', { method: 'POST', body: form }),
      'POST',
      '/developer/keys',
      {
        ...deps.sessionDeps,
        keyService: deps.keyService,
        deviceAuthStore: deps.deviceAuthStore,
        ephemeralStore: deps.ephemeralStore,
        publicBaseUrl: 'http://localhost:3000',
        maxActiveKeys: EXTERNAL_MAX_ACTIVE_KEYS_PER_USER,
      },
    )).rejects.toMatchObject({ code: 'limit_exceeded', status: 409 });
  });

  test('translateDeveloperConsoleHttpError redirects limit_exceeded to keys banner', async () => {
    const res = translateDeveloperConsoleHttpError(
      new HttpError(409, 'limit_exceeded', 'User already has 5 active API keys.'),
      'http://localhost:3000',
      '/developer/keys',
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get('location')).toBe('http://localhost:3000/developer/keys?error=limit_exceeded');
  });

  test('console GET /developer/keys renders limit_exceeded banner', async () => {
    await deps.externalUserStore.findOrCreate({
      clearauth_user_id: TEST_SESSION.id,
      email: TEST_SESSION.email,
    });
    const res = await handleDeveloperConsoleRoute(
      new Request('http://localhost/developer/keys?error=limit_exceeded'),
      'GET',
      '/developer/keys',
      {
        ...deps.sessionDeps,
        keyService: deps.keyService,
        deviceAuthStore: deps.deviceAuthStore,
        ephemeralStore: deps.ephemeralStore,
        publicBaseUrl: 'http://localhost:3000',
        maxActiveKeys: EXTERNAL_MAX_ACTIVE_KEYS_PER_USER,
      },
    );
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain('maximum number of active API keys');
  });

  test('revoke disables subsequent bearer auth and writes audit events', async () => {
    const createReq = new Request('http://localhost/v1/developer/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Revoke me' }),
    });
    const createRes = await handleExternalApiKeysRoute(createReq, 'POST', '/v1/developer/api-keys', {
      ...deps.sessionDeps,
      keyService: deps.keyService,
    });
    const created = await createRes?.json() as { data: { secret: string; key: { id: string } } };

    const revokeReq = new Request(`http://localhost/v1/developer/api-keys/${created.data.key.id}`, {
      method: 'DELETE',
    });
    const revokeRes = await handleExternalApiKeysRoute(
      revokeReq,
      'DELETE',
      `/v1/developer/api-keys/${created.data.key.id}`,
      { ...deps.sessionDeps, keyService: deps.keyService },
    );
    expect(revokeRes?.status).toBe(200);

    expect(await deps.externalKeyStore.verifyBearerToken(created.data.secret)).toBeNull();

    const events = await deps.auditStore.list();
    expect(events.some((e) => e.event_type === 'key_create')).toBe(true);
    expect(events.some((e) => e.event_type === 'key_revoke')).toBe(true);
  });

  test('admin audit query returns events; external bearer cannot access audit route', async () => {
    await deps.keyService.createForUser(`ext_${TEST_SESSION.id}`, 'audit-me');
    const adminRes = await handleExternalAuthAuditRoute(
      'GET',
      '/v1/internal/external-auth/audit',
      { kind: 'admin', credential_id: 'admin_test' },
      { auditStore: deps.auditStore },
    );
    const adminBody = await adminRes?.json() as { data: { events: unknown[] } };
    expect(adminRes?.status).toBe(200);
    expect(adminBody.data.events.length).toBeGreaterThan(0);

    const externalRes = await handleExternalAuthAuditRoute(
      'GET',
      '/v1/internal/external-auth/audit',
      { kind: 'external', user_id: FIXTURE_EXTERNAL_USER_ID, key_id: 'key_x' },
      { auditStore: deps.auditStore },
    );
    expect(externalRes?.status).toBe(403);
  });

  test('device-auth start returns 429 when rate limit exceeded', async () => {
    const limiter = new ExternalRateLimiter({ limit: 1, windowMs: 60_000 });
    const depsPayload = {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: limiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
    };
    await handleDeviceAuthRoute(
      new Request('http://localhost/v1/device-auth/start', { method: 'POST' }),
      'POST',
      '/v1/device-auth/start',
      depsPayload,
    );
    const blocked = await handleDeviceAuthRoute(
      new Request('http://localhost/v1/device-auth/start', { method: 'POST' }),
      'POST',
      '/v1/device-auth/start',
      depsPayload,
    );
    expect(blocked?.status).toBe(429);
  });

  test('device-auth ignores spoofed cf-connecting-ip when only FLY_APP_NAME is set', async () => {
    const limiter = new ExternalRateLimiter({ limit: 1, windowMs: 60_000 });
    const baseDeps = {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: limiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
    };
    const priorFly = process.env.FLY_APP_NAME;
    const priorTrust = process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP;
    process.env.FLY_APP_NAME = 'agentbootup';
    delete process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP;
    try {
      const reqA = new Request('http://localhost/v1/device-auth/start', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      });
      const reqB = new Request('http://localhost/v1/device-auth/start', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '5.6.7.8' },
      });
      await handleDeviceAuthRoute(reqA, 'POST', '/v1/device-auth/start', baseDeps);
      const blocked = await handleDeviceAuthRoute(reqB, 'POST', '/v1/device-auth/start', baseDeps);
      expect(blocked?.status).toBe(429);
    } finally {
      if (priorFly === undefined) delete process.env.FLY_APP_NAME;
      else process.env.FLY_APP_NAME = priorFly;
      if (priorTrust === undefined) delete process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP;
      else process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP = priorTrust;
    }
  });

  test('device-auth ignores spoofed cf-connecting-ip without trusted proxy env', async () => {
    const limiter = new ExternalRateLimiter({ limit: 1, windowMs: 60_000 });
    const baseDeps = {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: limiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
      clientIp: '10.9.8.7',
    };
    const priorFly = process.env.FLY_APP_NAME;
    const priorTrust = process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP;
    delete process.env.FLY_APP_NAME;
    delete process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP;
    try {
      const makeReq = () => new Request('http://localhost/v1/device-auth/start', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      });
      await handleDeviceAuthRoute(makeReq(), 'POST', '/v1/device-auth/start', baseDeps);
      const blocked = await handleDeviceAuthRoute(makeReq(), 'POST', '/v1/device-auth/start', baseDeps);
      expect(blocked?.status).toBe(429);
    } finally {
      if (priorFly === undefined) delete process.env.FLY_APP_NAME;
      else process.env.FLY_APP_NAME = priorFly;
      if (priorTrust === undefined) delete process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP;
      else process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP = priorTrust;
    }
  });

  test('device-auth rate limits are isolated per client IP', async () => {
    const limiter = new ExternalRateLimiter({ limit: 1, windowMs: 60_000 });
    const baseDeps = {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: limiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
    };
    const priorTrust = process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP;
    process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP = '1';
    try {
      const reqA = new Request('http://localhost/v1/device-auth/start', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      });
      await handleDeviceAuthRoute(reqA, 'POST', '/v1/device-auth/start', baseDeps);
      const blockedA = await handleDeviceAuthRoute(reqA, 'POST', '/v1/device-auth/start', baseDeps);
      expect(blockedA?.status).toBe(429);

      const reqB = new Request('http://localhost/v1/device-auth/start', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '5.6.7.8' },
      });
      const allowedB = await handleDeviceAuthRoute(reqB, 'POST', '/v1/device-auth/start', baseDeps);
      expect(allowedB?.status).toBe(201);
    } finally {
      if (priorTrust === undefined) delete process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP;
      else process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP = priorTrust;
    }
  });

  test('device-auth rate limits are isolated per peer IP fallback', async () => {
    const limiter = new ExternalRateLimiter({ limit: 1, windowMs: 60_000 });
    const baseDeps = {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: limiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
    };
    const makeReq = () => new Request('http://localhost/v1/device-auth/start', { method: 'POST' });
    await handleDeviceAuthRoute(makeReq(), 'POST', '/v1/device-auth/start', { ...baseDeps, clientIp: '10.0.0.1' });
    const blockedA = await handleDeviceAuthRoute(makeReq(), 'POST', '/v1/device-auth/start', { ...baseDeps, clientIp: '10.0.0.1' });
    expect(blockedA?.status).toBe(429);
    const allowedB = await handleDeviceAuthRoute(makeReq(), 'POST', '/v1/device-auth/start', { ...baseDeps, clientIp: '10.0.0.2' });
    expect(allowedB?.status).toBe(201);
  });

  test('device-auth start and poll share a combined per-IP rate limit bucket', async () => {
    const limiter = new ExternalRateLimiter({ limit: 2, windowMs: 60_000 });
    const depsPayload = {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: limiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
      clientIp: '203.0.113.9',
    };
    const startRes = await handleDeviceAuthRoute(
      new Request('http://localhost/v1/device-auth/start', { method: 'POST' }),
      'POST',
      '/v1/device-auth/start',
      depsPayload,
    );
    expect(startRes?.status).toBe(201);
    const startBody = await startRes!.json() as { data: { device_code: string } };
    const pollReq = new Request('http://localhost/v1/device-auth/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: startBody.data.device_code }),
    });
    const pollRes = await handleDeviceAuthRoute(pollReq, 'POST', '/v1/device-auth/poll', depsPayload);
    expect(pollRes?.status).toBe(200);
    const blocked = await handleDeviceAuthRoute(
      new Request('http://localhost/v1/device-auth/start', { method: 'POST' }),
      'POST',
      '/v1/device-auth/start',
      depsPayload,
    );
    expect(blocked?.status).toBe(429);
  });

  test('device-auth poll returns 429 when rate limit exceeded', async () => {
    const limiter = new ExternalRateLimiter({ limit: 1, windowMs: 60_000 });
    const depsPayload = {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: limiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
    };
    await handleDeviceAuthRoute(
      new Request('http://localhost/v1/device-auth/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: 'missing' }),
      }),
      'POST',
      '/v1/device-auth/poll',
      depsPayload,
    );
    const blocked = await handleDeviceAuthRoute(
      new Request('http://localhost/v1/device-auth/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: 'missing' }),
      }),
      'POST',
      '/v1/device-auth/poll',
      depsPayload,
    );
    expect(blocked?.status).toBe(429);
  });

  test('device-auth start + approve + poll returns API key once', async () => {
    const startReq = new Request('http://localhost/v1/device-auth/start', { method: 'POST' });
    const deviceRateLimiter = new ExternalRateLimiter({ limit: 60, windowMs: 60_000 });
    const startRes = await handleDeviceAuthRoute(startReq, 'POST', '/v1/device-auth/start', {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: deviceRateLimiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
    });
    const started = await startRes?.json() as {
      data: { device_code: string; user_code: string; verification_uri: string };
    };
    expect(started.data.verification_uri).toContain('/developer/device?code=');

    const approveReq = new Request('http://localhost/developer/device/approve', {
      method: 'POST',
      body: await deviceApproveForm(deps, started.data.user_code),
    });
    const approveRes = await handleDeveloperConsoleRoute(approveReq, 'POST', '/developer/device/approve', {
      ...deps.sessionDeps,
      keyService: deps.keyService,
      deviceAuthStore: deps.deviceAuthStore,
      ephemeralStore: deps.ephemeralStore,
      publicBaseUrl: 'http://localhost:3000',
      maxActiveKeys: EXTERNAL_MAX_ACTIVE_KEYS_PER_USER,
    });
    expect(approveRes?.status).toBe(200);

    const pollReq = new Request('http://localhost/v1/device-auth/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: started.data.device_code }),
    });
    const pollRes = await handleDeviceAuthRoute(pollReq, 'POST', '/v1/device-auth/poll', {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: deviceRateLimiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
    });
    const polled = await pollRes?.json() as { data: { status: string; api_key?: string } };
    expect(polled.data.status).toBe('approved');
    expect(polled.data.api_key?.startsWith('abu_live_')).toBe(true);

    const secondPollReq = new Request('http://localhost/v1/device-auth/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: started.data.device_code }),
    });
    const secondPoll = await handleDeviceAuthRoute(secondPollReq, 'POST', '/v1/device-auth/poll', {
      deviceAuthStore: deps.deviceAuthStore,
      rateLimiter: deviceRateLimiter,
      publicBaseUrl: 'http://localhost:3000',
      grantTtlSeconds: 600,
    });
    expect(secondPoll?.status).toBe(409);
  });

  test('revoked external key fails on external-allowed route while admin still works', async () => {
    const externalKeyStore = new ExternalApiKeyStore(mech);
    await externalKeyStore.ensureFixture({
      id: 'key_route_boundary',
      user_id: FIXTURE_EXTERNAL_USER_ID,
      label: 'boundary',
      secret: FIXTURE_EXTERNAL_API_KEY_SECRET,
    });
    const rateLimiter = new ExternalRateLimiter({ limit: 60, windowMs: 60_000 });
    const authDeps = {
      adminApiKey: FIXTURE_ADMIN_API_KEY,
      externalApiKeyPrefix: 'abu_live_',
      externalKeyStore,
      rateLimiter,
    };

    const externalReq = new Request('http://localhost/v1/auth/status', {
      headers: { authorization: `Bearer ${FIXTURE_EXTERNAL_API_KEY_SECRET}` },
    });
    const activeResult = await authorizeRequest(externalReq, 'GET', '/v1/auth/status', authDeps);
    expect(activeResult.ok).toBe(true);

    await externalKeyStore.revoke('key_route_boundary');

    const revokedResult = await authorizeRequest(externalReq, 'GET', '/v1/auth/status', authDeps);
    expect(revokedResult.ok).toBe(false);
    if (revokedResult.ok) return;
    expect(revokedResult.response.status).toBe(401);

    const adminReq = new Request('http://localhost/v1/auth/status', {
      headers: { authorization: `Bearer ${FIXTURE_ADMIN_API_KEY}` },
    });
    const adminResult = await authorizeRequest(adminReq, 'GET', '/v1/auth/status', authDeps);
    expect(adminResult.ok).toBe(true);
  });
});
