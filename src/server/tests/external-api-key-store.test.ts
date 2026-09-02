import { describe, test, expect, beforeEach } from 'bun:test';
import {
  ExternalApiKeyStore,
  hashApiKeySecret,
  generateExternalApiKeySecret,
  validateExternalKeySecret,
} from '../lib/external-api-key-store';
import { MockMechClient } from './helpers/mock-mech-client';
import {
  FIXTURE_EXTERNAL_API_KEY_ID,
  FIXTURE_EXTERNAL_API_KEY_LABEL,
  FIXTURE_EXTERNAL_API_KEY_SECRET,
  FIXTURE_EXTERNAL_USER_ID,
} from './fixtures/external-auth';
import { EXTERNAL_API_KEY_PREFIX } from '../config';

describe('ExternalApiKeyStore', () => {
  let store: ExternalApiKeyStore;
  let mech: MockMechClient;

  beforeEach(() => {
    mech = new MockMechClient();
    store = new ExternalApiKeyStore(mech);
  });

  test('hashApiKeySecret is deterministic', () => {
    expect(hashApiKeySecret('abc')).toBe(hashApiKeySecret('abc'));
    expect(hashApiKeySecret('abc')).not.toBe(hashApiKeySecret('def'));
  });

  test('generateExternalApiKeySecret uses abu_live_ prefix', () => {
    expect(generateExternalApiKeySecret().startsWith('abu_live_')).toBe(true);
  });

  test('verifyBearerToken returns null for malformed stored hash without throwing', async () => {
    const brokenStore = new ExternalApiKeyStore(mech);
    await brokenStore.ensureFixture({
      id: 'key_bad_hash',
      user_id: FIXTURE_EXTERNAL_USER_ID,
      label: 'bad-hash',
      secret: FIXTURE_EXTERNAL_API_KEY_SECRET,
    });
    const found = await brokenStore.get('key_bad_hash');
    expect(found).not.toBeNull();
    if (!found) return;
    const docs = await mech.listDocuments('agentbootup_external_api_keys');
    const doc = docs.find((entry) => (entry.document as { id?: string }).id === 'key_bad_hash');
    expect(doc).toBeDefined();
    if (!doc) return;
    await mech.updateDocument(doc.id, 'agentbootup_external_api_keys', {
      ...found,
      secret_hash: 'not-hex',
    });
    expect(await brokenStore.verifyBearerToken(FIXTURE_EXTERNAL_API_KEY_SECRET)).toBeNull();
  });

  test('verifyBearerToken rejects distinct token without matching', async () => {
    await store.ensureFixture({
      id: 'key_near_miss',
      user_id: FIXTURE_EXTERNAL_USER_ID,
      label: 'near-miss',
      secret: FIXTURE_EXTERNAL_API_KEY_SECRET,
    });
    const almost = `${FIXTURE_EXTERNAL_API_KEY_SECRET}x`;
    expect(await store.verifyBearerToken(almost)).toBeNull();
  });

  test('verifyBearerToken resolves active key and rejects revoked key', async () => {
    await store.ensureFixture({
      id: FIXTURE_EXTERNAL_API_KEY_ID,
      user_id: FIXTURE_EXTERNAL_USER_ID,
      label: FIXTURE_EXTERNAL_API_KEY_LABEL,
      secret: FIXTURE_EXTERNAL_API_KEY_SECRET,
    });

    const resolved = await store.verifyBearerToken(FIXTURE_EXTERNAL_API_KEY_SECRET);
    expect(resolved?.key.id).toBe(FIXTURE_EXTERNAL_API_KEY_ID);
    expect(resolved?.docId).toMatch(/^doc-\d+$/);

    await store.revoke(FIXTURE_EXTERNAL_API_KEY_ID);
    expect(await store.verifyBearerToken(FIXTURE_EXTERNAL_API_KEY_SECRET)).toBeNull();
  });

  test('verifyBearerToken paginates beyond 5000 stored key rows', async () => {
    for (let index = 0; index < 5_001; index++) {
      await mech.createDocument('agentbootup_external_api_keys', { invalid: index });
    }
    await store.ensureFixture({
      id: FIXTURE_EXTERNAL_API_KEY_ID,
      user_id: FIXTURE_EXTERNAL_USER_ID,
      label: FIXTURE_EXTERNAL_API_KEY_LABEL,
      secret: FIXTURE_EXTERNAL_API_KEY_SECRET,
    });
    mech.listDocuments = async () => { throw new Error('generic scanner cap reached'); };

    expect((await store.verifyBearerToken(FIXTURE_EXTERNAL_API_KEY_SECRET))?.key.id)
      .toBe(FIXTURE_EXTERNAL_API_KEY_ID);
  });

  test('validateExternalKeySecret rejects weak suffix length', () => {
    expect(() => validateExternalKeySecret(`${EXTERNAL_API_KEY_PREFIX}weak`, EXTERNAL_API_KEY_PREFIX))
      .toThrow();
  });

  test('create validates against configured key prefix and min suffix length', async () => {
    const customStore = new ExternalApiKeyStore(new MockMechClient(), { keyPrefix: 'abu_test_' });
    await expect(customStore.create({
      user_id: 'user-b',
      label: 'wrong-prefix',
      secret: `${EXTERNAL_API_KEY_PREFIX}${'a'.repeat(32)}`,
    }, 5)).rejects.toMatchObject({ status: 400 });

    const created = await customStore.create({
      user_id: 'user-b',
      label: 'ok-prefix',
      secret: `abu_test_${'a'.repeat(32)}`,
    }, 5);
    expect(created.secret.startsWith('abu_test_')).toBe(true);
  });

  test('create generates a secret when omitted', async () => {
    const created = await store.create({
      user_id: 'user-generated',
      label: 'generated',
    }, 5);
    expect(created.secret.startsWith(EXTERNAL_API_KEY_PREFIX)).toBe(true);
    expect(created.secret.length - EXTERNAL_API_KEY_PREFIX.length).toBeGreaterThanOrEqual(32);
  });

  test('create enforces max active keys per user', async () => {
    for (let i = 0; i < 5; i++) {
      await store.create({
        user_id: 'user-a',
        label: `key-${i}`,
        secret: generateExternalApiKeySecret(),
      }, 5);
    }

    await expect(store.create({
      user_id: 'user-a',
      label: 'one-too-many',
      secret: generateExternalApiKeySecret(),
    }, 5)).rejects.toMatchObject({ status: 409 });
  });
});
