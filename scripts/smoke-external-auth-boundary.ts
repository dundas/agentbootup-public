/**
 * Smoke: PRD-0041 Parent 1.0 external auth boundary.
 *
 * Runs in-process against the same auth modules the server uses.
 * Usage: bun scripts/smoke-external-auth-boundary.ts
 */

import { authorizeRequest } from '../src/server/lib/request-auth';
import { ExternalApiKeyStore } from '../src/server/lib/external-api-key-store';
import { ExternalRateLimiter } from '../src/server/lib/external-rate-limit';
import { EXTERNAL_API_KEY_PREFIX, EXTERNAL_RATE_LIMIT_PER_MINUTE } from '../src/server/config';
import { MockMechClient } from '../src/server/tests/helpers/mock-mech-client';
import {
  FIXTURE_ADMIN_API_KEY,
  FIXTURE_EXTERNAL_API_KEY_ID,
  FIXTURE_EXTERNAL_API_KEY_LABEL,
  FIXTURE_EXTERNAL_API_KEY_SECRET,
  FIXTURE_EXTERNAL_USER_ID,
} from '../src/server/tests/fixtures/external-auth';

function request(path: string, token: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function main(): Promise<void> {
  const store = new ExternalApiKeyStore(new MockMechClient());
  await store.ensureFixture({
    id: FIXTURE_EXTERNAL_API_KEY_ID,
    user_id: FIXTURE_EXTERNAL_USER_ID,
    label: FIXTURE_EXTERNAL_API_KEY_LABEL,
    secret: FIXTURE_EXTERNAL_API_KEY_SECRET,
  });

  const deps = {
    adminApiKey: FIXTURE_ADMIN_API_KEY,
    externalApiKeyPrefix: EXTERNAL_API_KEY_PREFIX,
    externalKeyStore: store,
    rateLimiter: new ExternalRateLimiter({ limit: EXTERNAL_RATE_LIMIT_PER_MINUTE, windowMs: 60_000 }),
  };

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const externalStatus = await authorizeRequest(
    request('/v1/auth/status', FIXTURE_EXTERNAL_API_KEY_SECRET),
    'GET',
    '/v1/auth/status',
    deps,
  );
  checks.push({
    name: 'external key on /v1/auth/status',
    ok: externalStatus.ok,
    detail: externalStatus.ok ? 'authorized' : `status ${externalStatus.response.status}`,
  });

  const externalRegistry = await authorizeRequest(
    request('/v1/registry/search?q=health', FIXTURE_EXTERNAL_API_KEY_SECRET),
    'GET',
    '/v1/registry/search',
    deps,
  );
  checks.push({
    name: 'external key on /v1/registry/search',
    ok: externalRegistry.ok,
    detail: externalRegistry.ok ? 'authorized' : `status ${externalRegistry.response.status}`,
  });

  const externalBrains = await authorizeRequest(
    request('/v1/brains', FIXTURE_EXTERNAL_API_KEY_SECRET),
    'GET',
    '/v1/brains',
    deps,
  );
  checks.push({
    name: 'external key rejected on /v1/brains',
    ok: !externalBrains.ok && externalBrains.response.status === 403,
    detail: externalBrains.ok ? 'unexpectedly authorized' : `status ${externalBrains.response.status}`,
  });

  const adminBrains = await authorizeRequest(
    request('/v1/brains', FIXTURE_ADMIN_API_KEY),
    'GET',
    '/v1/brains',
    deps,
  );
  checks.push({
    name: 'admin key on /v1/brains',
    ok: adminBrains.ok,
    detail: adminBrains.ok ? 'authorized' : `status ${adminBrains.response.status}`,
  });

  const limited = new ExternalRateLimiter({ limit: 1, windowMs: 60_000 });
  const limitedDeps = { ...deps, rateLimiter: limited };
  await authorizeRequest(request('/v1/auth/status', FIXTURE_EXTERNAL_API_KEY_SECRET), 'GET', '/v1/auth/status', limitedDeps);
  const rateLimited = await authorizeRequest(
    request('/v1/auth/status', FIXTURE_EXTERNAL_API_KEY_SECRET),
    'GET',
    '/v1/auth/status',
    limitedDeps,
  );
  let rateLimitBodyOk = false;
  if (!rateLimited.ok) {
    const body = await rateLimited.response.json() as { error?: { code?: string } };
    rateLimitBodyOk = rateLimited.response.status === 429 && body.error?.code === 'rate_limited';
  }
  checks.push({
    name: 'external key rate limited with error body',
    ok: rateLimitBodyOk,
    detail: rateLimitBodyOk ? 'status 429 + rate_limited code' : 'missing 429 body contract',
  });

  let failed = 0;
  for (const check of checks) {
    const mark = check.ok ? 'OK' : 'FAIL';
    console.log(`${mark}  ${check.name} (${check.detail})`);
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\nSmoke failed: ${failed} check(s)`);
    process.exit(1);
  }

  console.log('\nSmoke passed: external auth boundary');
}

main().catch((err) => {
  console.error('Smoke error:', err);
  process.exit(1);
});
