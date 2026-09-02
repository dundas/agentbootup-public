import { describe, test, expect } from 'bun:test';
import { isAuthorized, resolvePrincipal } from '../auth';
import { ExternalApiKeyStore } from '../lib/external-api-key-store';
import { MockMechClient } from './helpers/mock-mech-client';
import {
  FIXTURE_ADMIN_API_KEY,
  FIXTURE_EXTERNAL_API_KEY_ID,
  FIXTURE_EXTERNAL_API_KEY_LABEL,
  FIXTURE_EXTERNAL_API_KEY_SECRET,
  FIXTURE_EXTERNAL_USER_ID,
} from './fixtures/external-auth';
import { EXTERNAL_API_KEY_PREFIX } from '../config';
import { createHash } from 'node:crypto';
function makeRequest(authHeader?: string): Request {
  return new Request('http://localhost/v1/brains', {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe('isAuthorized', () => {
  const KEY = 'test-secret-key-abc123';

  test('returns true for correct Bearer token', () => {
    expect(isAuthorized(makeRequest(`Bearer ${KEY}`), KEY)).toBe(true);
  });

  test('returns false for wrong token', () => {
    expect(isAuthorized(makeRequest('Bearer wrong-key'), KEY)).toBe(false);
  });

  test('returns false for missing Authorization header', () => {
    expect(isAuthorized(makeRequest(), KEY)).toBe(false);
  });

  test('returns false for non-Bearer scheme', () => {
    expect(isAuthorized(makeRequest(`Basic ${KEY}`), KEY)).toBe(false);
  });

  test('returns false for empty token after Bearer', () => {
    expect(isAuthorized(makeRequest('Bearer   '), KEY)).toBe(false);
  });

  test('is case-insensitive on "bearer" prefix', () => {
    expect(isAuthorized(makeRequest(`BEARER ${KEY}`), KEY)).toBe(true);
  });
});

describe('resolvePrincipal', () => {
  test('resolves admin and external principals from bearer tokens', async () => {
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
    };

    const admin = await resolvePrincipal(makeRequest(`Bearer ${FIXTURE_ADMIN_API_KEY}`), deps);
    expect(admin).toEqual({ principal: {
      kind: 'admin',
      credential_id: `admin_${createHash('sha256').update(FIXTURE_ADMIN_API_KEY).digest('hex')}`,
    } });

    const external = await resolvePrincipal(makeRequest(`Bearer ${FIXTURE_EXTERNAL_API_KEY_SECRET}`), deps);
    expect(external?.principal).toEqual({
      kind: 'external',
      user_id: FIXTURE_EXTERNAL_USER_ID,
      key_id: FIXTURE_EXTERNAL_API_KEY_ID,
    });
    expect(external?.externalVerified?.key.id).toBe(FIXTURE_EXTERNAL_API_KEY_ID);
    expect(external?.externalVerified?.docId).toMatch(/^doc-\d+$/);

    expect(await resolvePrincipal(makeRequest('Bearer wrong'), deps)).toBeNull();
  });

  test('empty admin key does not match arbitrary bearer tokens', async () => {
    const store = new ExternalApiKeyStore(new MockMechClient());
    const deps = {
      adminApiKey: '',
      externalApiKeyPrefix: EXTERNAL_API_KEY_PREFIX,
      externalKeyStore: store,
    };
    expect(await resolvePrincipal(makeRequest('Bearer anything'), deps)).toBeNull();
  });
});
