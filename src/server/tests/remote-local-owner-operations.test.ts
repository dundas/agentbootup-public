import { describe, expect, test } from 'bun:test';
import { createBrainAuthorizationFence } from '../lib/brain-authorization-decision';
import { authorizeRemoteLocalOwnerOperation } from '../lib/remote-local-owner-operations';

const fence = createBrainAuthorizationFence({
  brainId: 'brain-a', fencingEpoch: 3, ownerPrincipalId: 'owner-a', credentialRevision: 2,
  hostId: 'device-a', deploymentGeneration: 1, adapterIdentityVersion: 'adapter-v1', capabilityPolicyRevision: 4,
});

function repository(result: unknown) {
  return { inspect: async () => result } as never;
}

const current = {
  disposition: 'current' as const,
  fence,
  record: {
    owner_principal_id: 'owner-a', owner_status: 'active' as const,
    local_device: { device_id: 'device-a', brain_id: 'brain-a', owner_principal_id: 'owner-a', state: 'active' as const, authority_capabilities_revision: fence.capabilitiesRevision },
  },
};

describe('remote-local owner operation authorization', () => {
  test('derives the complete owner, consumer, brain, device, and fence scope only from durable authority', async () => {
    await expect(authorizeRemoteLocalOwnerOperation({
      principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' }, brainId: 'brain-a', repository: repository(current),
    })).resolves.toEqual({
      status: 'authorized',
      scope: { tenantId: 'owner-a', ownerPrincipalId: 'owner-a', consumerId: 'owner-a', credentialId: 'key-a', brainId: 'brain-a', deviceId: 'device-a', fence },
    });
  });

  test('denies an admin, another owner, a revoked owner/device, an absent device, and a fence/device mismatch', async () => {
    await expect(authorizeRemoteLocalOwnerOperation({ principal: { kind: 'admin', credential_id: 'admin-a' }, brainId: 'brain-a', repository: repository(current) })).resolves.toEqual({ status: 'denied' });
    await expect(authorizeRemoteLocalOwnerOperation({ principal: { kind: 'external', user_id: 'other-owner', key_id: 'key-a' }, brainId: 'brain-a', repository: repository(current) })).resolves.toEqual({ status: 'denied' });
    await expect(authorizeRemoteLocalOwnerOperation({ principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' }, brainId: 'brain-a', repository: repository({ ...current, record: { ...current.record, owner_status: 'revoked' } }) })).resolves.toEqual({ status: 'denied' });
    await expect(authorizeRemoteLocalOwnerOperation({ principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' }, brainId: 'brain-a', repository: repository({ ...current, record: { ...current.record, local_device: null } }) })).resolves.toEqual({ status: 'denied' });
    await expect(authorizeRemoteLocalOwnerOperation({ principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' }, brainId: 'brain-a', repository: repository({ ...current, record: { ...current.record, local_device: { ...current.record.local_device, authority_capabilities_revision: 'v1.stale' } } }) })).resolves.toEqual({ status: 'denied' });
  });

  test('fails closed as unavailable when durable authority cannot prove current state', async () => {
    await expect(authorizeRemoteLocalOwnerOperation({ principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' }, brainId: 'brain-a', repository: repository({ disposition: 'unavailable' }) })).resolves.toEqual({ status: 'unavailable' });
    await expect(authorizeRemoteLocalOwnerOperation({ principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' }, brainId: 'brain-a', repository: repository({ disposition: 'invalid' }) })).resolves.toEqual({ status: 'unavailable' });
  });
});
