import { describe, test, expect, beforeEach } from 'bun:test';
import { DeviceAuthStore } from '../lib/device-auth-store';
import { hashApiKeySecret } from '../lib/external-api-key-store';
import { MockMechClient } from './helpers/mock-mech-client';

/** MockMechClient stores all collections in one map; delivery docs are the only records with `secret`. */
function isDeliveryDoc(document: Record<string, unknown>): boolean {
  return typeof document.secret === 'string';
}

describe('DeviceAuthStore', () => {
  let store: DeviceAuthStore;
  let mech: MockMechClient;

  beforeEach(() => {
    mech = new MockMechClient();
    store = new DeviceAuthStore(mech);
  });

  test('approveGrant stores secret hash on grant, not plaintext', async () => {
    const grant = await store.createGrant(600);
    const secret = 'abu_live_test_secret_value_1234567890';
    await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: secret,
    });

    const updated = await store.getGrant(grant.device_code);
    expect(updated?.api_key_secret_hash).toBe(hashApiKeySecret(secret));

    const grantDocs = (await mech.listDocuments('agentbootup_device_auth_grants'))
      .map((d) => d.document)
      .filter((doc) => typeof doc.user_code === 'string');
    const grantPayload = JSON.stringify(grantDocs);
    expect(grantPayload).not.toContain(secret);
    expect(grantPayload).toContain(hashApiKeySecret(secret));
  });

  test('consumeApprovedSecret delivers secret once under concurrent polls', async () => {
    const grant = await store.createGrant(600);
    const secret = 'abu_live_concurrent_delivery_secret_123';
    await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: secret,
    });

    const [first, second] = await Promise.all([
      store.consumeApprovedSecret(grant.device_code),
      store.consumeApprovedSecret(grant.device_code),
    ]);

    const delivered = [first, second].filter((r) => r.outcome === 'delivered');
    const alreadyConsumed = [first, second].filter((r) => r.outcome === 'already_consumed');
    expect(delivered).toHaveLength(1);
    expect(alreadyConsumed).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      outcome: 'delivered',
      api_key: secret,
      user_id: 'user-1',
      key_id: 'key-1',
    });

    const finalGrant = await store.getGrant(grant.device_code);
    expect(finalGrant?.status).toBe('consumed');
    expect(finalGrant?.api_key_secret_hash).toBeNull();
  });

  test('consumeApprovedSecret returns delivery_expired when expired grant marker fails', async () => {
    const grant = await store.createGrant(600);
    await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: 'abu_live_expired_marker_fail_secret',
    });

    const deliveries = await mech.listDocuments('agentbootup_device_auth_deliveries');
    const deliveryDoc = deliveries.find((d) => typeof d.document.secret === 'string');
    await mech.updateDocument(deliveryDoc!.id, 'agentbootup_device_auth_deliveries', {
      ...deliveryDoc!.document,
      expires_at: '2000-01-01T00:00:00.000Z',
    });

    const originalUpdate = mech.updateDocument.bind(mech);
    try {
      mech.updateDocument = async (docId, collection, data) => {
        if ((data as { status?: string }).status === 'expired') {
          throw new Error('transient mech outage');
        }
        return originalUpdate(docId, collection, data);
      };

      const result = await store.consumeApprovedSecret(grant.device_code);
      expect(result.outcome).toBe('delivery_expired');
    } finally {
      mech.updateDocument = originalUpdate;
    }
  });

  test('consumeApprovedSecret rejects expired delivery doc', async () => {
    const grant = await store.createGrant(600);
    const secret = 'abu_live_expired_delivery_secret_1234';
    await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: secret,
    });

    const deliveries = await mech.listDocuments('agentbootup_device_auth_deliveries');
    const deliveryDoc = deliveries.find((d) => typeof d.document.secret === 'string');
    expect(deliveryDoc).toBeDefined();
    await mech.updateDocument(deliveryDoc!.id, 'agentbootup_device_auth_deliveries', {
      ...deliveryDoc!.document,
      expires_at: '2000-01-01T00:00:00.000Z',
    });

    const result = await store.consumeApprovedSecret(grant.device_code);
    expect(result.outcome).toBe('delivery_expired');
  });

  test('consumeApprovedSecret returns not_ready when delivery doc is gone but grant is still approved', async () => {
    const grant = await store.createGrant(600);
    await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: 'abu_live_missing_delivery_secret_12',
    });

    const deliveries = await mech.listDocuments('agentbootup_device_auth_deliveries');
    const deliveryDoc = deliveries.find((d) => typeof d.document.secret === 'string');
    await mech.deleteDocument(deliveryDoc!.id, 'agentbootup_device_auth_deliveries');

    const result = await store.consumeApprovedSecret(grant.device_code);
    expect(result.outcome).toBe('not_ready');
  });

  test('approveGrant rethrows delivery error when grant update fails after delivery create', async () => {
    const grant = await store.createGrant(600);
    const originalUpdate = mech.updateDocument.bind(mech);
    mech.updateDocument = async (docId, collection, data) => {
      if ((data as { status?: string }).status === 'approved') {
        throw new Error('grant update failed');
      }
      return originalUpdate(docId, collection, data);
    };
    try {
      await expect(store.approveGrant(grant.user_code, {
        user_id: 'user-1',
        key_id: 'key-1',
        api_key_secret: 'abu_live_grant_update_fail_secret',
      })).rejects.toThrow('grant update failed');
      const refreshed = await store.getGrant(grant.device_code);
      expect(refreshed?.status).toBe('pending');
      const deliveries = await mech.listDocuments('agentbootup_device_auth_deliveries');
      expect(
        deliveries
          .filter((d) => isDeliveryDoc(d.document))
          .some((d) => (d.document as { device_code?: string }).device_code === grant.device_code),
      ).toBe(false);
    } finally {
      mech.updateDocument = originalUpdate;
    }
  });

  test('getGrant expires approved grants past TTL on lookup', async () => {
    const grant = await store.createGrant(600);
    await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: 'abu_live_expired_approved_secret_12',
    });

    const grants = await mech.listDocuments('agentbootup_device_auth_grants');
    const grantDoc = grants.find((d) => (d.document as { device_code?: string }).device_code === grant.device_code);
    expect(grantDoc).toBeDefined();
    await mech.updateDocument(grantDoc!.id, 'agentbootup_device_auth_grants', {
      ...grantDoc!.document,
      expires_at: '2000-01-01T00:00:00.000Z',
    });

    const refreshed = await store.getGrant(grant.device_code);
    expect(refreshed?.status).toBe('expired');
    expect(refreshed?.api_key_secret_hash).toBeNull();

    const deliveries = await mech.listDocuments('agentbootup_device_auth_deliveries');
    expect(deliveries.filter((d) => isDeliveryDoc(d.document)).length).toBe(0);
  });

  test('approveGrant rethrows grant update error when delivery rollback also fails', async () => {
    const grant = await store.createGrant(600);
    const originalUpdate = mech.updateDocument.bind(mech);
    const originalDelete = mech.deleteDocument.bind(mech);
    try {
      mech.updateDocument = async (docId, collection, data) => {
        if ((data as { status?: string }).status === 'approved') {
          throw new Error('grant update failed');
        }
        return originalUpdate(docId, collection, data);
      };
      mech.deleteDocument = async () => {
        throw new Error('delivery rollback failed');
      };

      await expect(store.approveGrant(grant.user_code, {
        user_id: 'user-1',
        key_id: 'key-1',
        api_key_secret: 'abu_live_double_fail_secret_12345',
      })).rejects.toThrow('grant update failed');
    } finally {
      mech.updateDocument = originalUpdate;
      mech.deleteDocument = originalDelete;
    }
  });

  test('approveGrant clears orphan delivery doc left by a failed prior approval', async () => {
    const grant = await store.createGrant(600);
    await mech.createDocument('agentbootup_device_auth_deliveries', {
      device_code: grant.device_code,
      secret: 'abu_live_orphan_delivery_secret_1234',
      created_at: new Date().toISOString(),
      expires_at: grant.expires_at,
    });

    const approved = await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: 'abu_live_orphan_recovery_secret_12',
    });
    expect(approved.status).toBe('approved');

    const deliveries = await mech.listDocuments('agentbootup_device_auth_deliveries');
    expect(deliveries.filter((d) => isDeliveryDoc(d.document)).length).toBe(1);
  });

  test('approveGrant rejects sequential duplicate approval', async () => {
    const grant = await store.createGrant(600);
    await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: 'abu_live_duplicate_approve_secret_1',
    });

    await expect(store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-2',
      api_key_secret: 'abu_live_duplicate_approve_secret_2',
    })).rejects.toMatchObject({ status: 409 });
  });

  test('consumeApprovedSecret still delivers when grant consume marker fails', async () => {
    const grant = await store.createGrant(600);
    const secret = 'abu_live_marker_fail_secret_123456789';
    await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: secret,
    });

    const originalUpdate = mech.updateDocument.bind(mech);
    try {
      mech.updateDocument = async (docId, collection, data) => {
        if ((data as { status?: string }).status === 'consumed') {
          throw new Error('transient mech outage');
        }
        return originalUpdate(docId, collection, data);
      };

      const result = await store.consumeApprovedSecret(grant.device_code);
      expect(result).toMatchObject({
        outcome: 'delivered',
        api_key: secret,
        user_id: 'user-1',
        key_id: 'key-1',
      });
    } finally {
      mech.updateDocument = originalUpdate;
    }
  });

  test('consumeApprovedSecret returns already_consumed on second sequential poll', async () => {
    const grant = await store.createGrant(600);
    await store.approveGrant(grant.user_code, {
      user_id: 'user-1',
      key_id: 'key-1',
      api_key_secret: 'abu_live_second_poll_secret_123456',
    });

    const first = await store.consumeApprovedSecret(grant.device_code);
    expect(first.outcome).toBe('delivered');

    const second = await store.consumeApprovedSecret(grant.device_code);
    expect(second.outcome).toBe('already_consumed');
  });
});
