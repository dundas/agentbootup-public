/**
 * Smoke: self-serve auth lifecycle (Parent 2.0) using in-memory mocks — no live ClearAuth required.
 *
 * Run: NODE_ENV=test AGENTBOOTUP_ALLOW_TEST_SESSION=1 AGENTBOOTUP_API_KEY=smoke-admin bun scripts/smoke-self-serve-auth.ts
 */

import { ExternalApiKeyStore } from '../src/server/lib/external-api-key-store';
import { ExternalUserStore } from '../src/server/lib/external-user-store';
import { ExternalAuthAuditStore } from '../src/server/lib/external-auth-audit-store';
import { DeviceAuthStore } from '../src/server/lib/device-auth-store';
import { ConsoleEphemeralStore } from '../src/server/lib/console-ephemeral-store';
import { ExternalKeyService } from '../src/server/lib/external-key-service';
import { MockMechClient } from '../src/server/tests/helpers/mock-mech-client';
import { handleExternalApiKeysRoute } from '../src/server/routes/external-api-keys';
import { handleDeviceAuthRoute } from '../src/server/routes/device-auth';
import { handleDeveloperConsoleRoute } from '../src/server/routes/developer-console';
import { handleExternalAuthAuditRoute } from '../src/server/routes/external-auth-audit';
import { authorizeRequest } from '../src/server/lib/request-auth';
import { ExternalRateLimiter } from '../src/server/lib/external-rate-limit';
import { EXTERNAL_MAX_ACTIVE_KEYS_PER_USER } from '../src/server/config';
import { createHash } from 'node:crypto';

const ADMIN_KEY = process.env.AGENTBOOTUP_API_KEY ?? 'smoke-admin';
const ADMIN_CREDENTIAL_ID = `admin_${createHash('sha256').update(ADMIN_KEY).digest('hex')}`;
const sessionUser = { id: 'smoke-clearauth-user', email: 'smoke-dev@example.com', email_verified: true };

function ok(label: string): void {
  console.log(`OK  ${label}`);
}

async function main(): Promise<void> {
  const mech = new MockMechClient();
  const keyStore = new ExternalApiKeyStore(mech);
  const userStore = new ExternalUserStore(mech);
  const auditStore = new ExternalAuthAuditStore(mech);
  const deviceStore = new DeviceAuthStore(mech);
  const ephemeralStore = new ConsoleEphemeralStore(mech);
  const keyService = new ExternalKeyService(keyStore, auditStore, EXTERNAL_MAX_ACTIVE_KEYS_PER_USER);
  const sessionDeps = {
    clearAuth: {
      config: {} as never,
      handleRequest: async () => new Response('unused'),
      getSessionUser: async () => null,
    },
    externalUserStore: userStore,
    testSessionUser: sessionUser,
  };

  const createRes = await handleExternalApiKeysRoute(
    new Request('http://localhost/v1/developer/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'smoke-key' }),
    }),
    'POST',
    '/v1/developer/api-keys',
    { ...sessionDeps, keyService },
  );
  if (createRes?.status !== 201) throw new Error(`create key failed: ${createRes?.status}`);
  const created = await createRes.json() as { data: { secret: string; key: { id: string } } };
  ok('session key create returns one-time secret');

  const authStatus = await authorizeRequest(
    new Request('http://localhost/v1/auth/status', {
      headers: { authorization: `Bearer ${created.data.secret}` },
    }),
    'GET',
    '/v1/auth/status',
    {
      adminApiKey: ADMIN_KEY,
      externalApiKeyPrefix: 'abu_live_',
      externalKeyStore: keyStore,
      rateLimiter: new ExternalRateLimiter({ limit: 60, windowMs: 60_000 }),
    },
  );
  if (!authStatus.ok) throw new Error('external key auth/status failed');
  ok('created key works on /v1/auth/status');

  const revokeRes = await handleExternalApiKeysRoute(
    new Request(`http://localhost/v1/developer/api-keys/${created.data.key.id}`, { method: 'DELETE' }),
    'DELETE',
    `/v1/developer/api-keys/${created.data.key.id}`,
    { ...sessionDeps, keyService },
  );
  if (revokeRes?.status !== 200) throw new Error(`revoke failed: ${revokeRes?.status}`);
  if (await keyStore.verifyBearerToken(created.data.secret)) throw new Error('revoked key still verifies');
  ok('revoked key rejected on bearer verify');

  const auditRes = await handleExternalAuthAuditRoute(
    'GET',
    '/v1/internal/external-auth/audit',
    { kind: 'admin', credential_id: ADMIN_CREDENTIAL_ID },
    { auditStore },
  );
  const auditBody = await auditRes?.json() as { data: { events: Array<{ event_type: string }> } };
  const types = new Set(auditBody.data.events.map((e) => e.event_type));
  if (!types.has('key_create') || !types.has('key_revoke')) {
    throw new Error('audit missing create/revoke events');
  }
  ok('admin audit query includes create + revoke events');

  const deviceRateLimiter = new ExternalRateLimiter({ limit: 60, windowMs: 60_000 });
  const startRes = await handleDeviceAuthRoute(
    new Request('http://localhost/v1/device-auth/start', { method: 'POST' }),
    'POST',
    '/v1/device-auth/start',
    { deviceAuthStore: deviceStore, rateLimiter: deviceRateLimiter, publicBaseUrl: 'http://localhost:3000', grantTtlSeconds: 600 },
  );
  const started = await startRes?.json() as { data: { device_code: string; user_code: string } };

  const csrf = await ephemeralStore.issueCsrfToken(`ext_${sessionUser.id}`);
  const approveForm = new FormData();
  approveForm.set('csrf_token', csrf);
  approveForm.set('user_code', started.data.user_code);
  await handleDeveloperConsoleRoute(
    new Request('http://localhost/developer/device/approve', {
      method: 'POST',
      body: approveForm,
    }),
    'POST',
    '/developer/device/approve',
    {
      ...sessionDeps,
      keyService,
      deviceAuthStore: deviceStore,
      ephemeralStore,
      publicBaseUrl: 'http://localhost:3000',
      maxActiveKeys: EXTERNAL_MAX_ACTIVE_KEYS_PER_USER,
    },
  );

  const pollRes = await handleDeviceAuthRoute(
    new Request('http://localhost/v1/device-auth/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: started.data.device_code }),
    }),
    'POST',
    '/v1/device-auth/poll',
    { deviceAuthStore: deviceStore, rateLimiter: deviceRateLimiter, publicBaseUrl: 'http://localhost:3000', grantTtlSeconds: 600 },
  );
  const polled = await pollRes?.json() as { data: { api_key?: string } };
  if (!polled.data.api_key?.startsWith('abu_live_')) throw new Error('device poll missing api_key');
  ok('device-auth bridge delivers API key to CLI poll');

  console.log('\nSmoke passed: self-serve auth lifecycle');
}

main().catch((err) => {
  console.error('Smoke failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
