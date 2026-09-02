import { describe, expect, test } from 'bun:test';
import {
  applyBrainAuthorizationLifecycleEvent,
  canAdministerBrainAuthorizationRecord,
  createBrainAuthorizationLifecycleRecord,
  mayAccessBrainMessaging,
} from '../lib/brain-authorization-lifecycle';

describe('brain authorization lifecycle semantics', () => {
  test('creates an owner/admin record but never grants messaging access', () => {
    const administrator = { principalId: 'admin-a', status: 'active' as const };
    const record = createBrainAuthorizationLifecycleRecord({
      brainId: 'brain-a',
      ownerPrincipalId: 'owner-a',
      administrators: [administrator],
    });
    expect(record).toMatchObject({ ownerPrincipalId: 'owner-a', ownerStatus: 'active', fencingEpoch: 0, credentialRevision: 0 });
    expect(canAdministerBrainAuthorizationRecord(record, 'admin-a')).toBe(true);
    expect(canAdministerBrainAuthorizationRecord(record, 'owner-a')).toBe(false);
    expect(mayAccessBrainMessaging()).toBe(false);
    (administrator as { status: 'active' | 'revoked' }).status = 'revoked';
    expect(canAdministerBrainAuthorizationRecord(record, 'admin-a')).toBe(true);
  });

  test('admin lifecycle is record-only and does not advance the execution fence', () => {
    const record = createBrainAuthorizationLifecycleRecord({ brainId: 'brain-a' });
    const added = applyBrainAuthorizationLifecycleEvent(record, { kind: 'administrator_added', principalId: 'admin-a' });
    const removed = applyBrainAuthorizationLifecycleEvent(added, { kind: 'administrator_removed', principalId: 'admin-a' });
    expect(added.fencingEpoch).toBe(0);
    expect(removed.fencingEpoch).toBe(0);
    expect(canAdministerBrainAuthorizationRecord(removed, 'admin-a')).toBe(false);
    expect(applyBrainAuthorizationLifecycleEvent(removed, { kind: 'administrator_removed', principalId: 'admin-a' })).toEqual(removed);
    expect(applyBrainAuthorizationLifecycleEvent(removed, { kind: 'administrator_added', principalId: 'admin-a' })).toEqual(removed);
  });

  test('generic non-local principal registration has no host/device fields and revocation is monotonic', () => {
    const record = createBrainAuthorizationLifecycleRecord({ brainId: 'brain-a' });
    const active = applyBrainAuthorizationLifecycleEvent(record, { kind: 'principal_registered', principalId: 'principal-a', tenantId: 'tenant-a' });
    const revoked = applyBrainAuthorizationLifecycleEvent(active, { kind: 'principal_revoked', principalId: 'principal-a' });
    expect(revoked).toMatchObject({ fencingEpoch: 1, credentialRevision: 1, principals: [{ principalId: 'principal-a', tenantId: 'tenant-a', status: 'revoked', credentialRevision: 1 }] });
    expect(applyBrainAuthorizationLifecycleEvent(revoked, { kind: 'principal_revoked', principalId: 'principal-a' })).toEqual(revoked);
    expect(applyBrainAuthorizationLifecycleEvent(revoked, { kind: 'principal_registered', principalId: 'principal-a', tenantId: 'tenant-a' })).toEqual(revoked);
    const fields = [
      ...Object.keys(revoked),
      ...revoked.principals.flatMap((principal) => Object.keys(principal)),
      ...revoked.administrators.flatMap((administrator) => Object.keys(administrator)),
    ];
    expect(fields.some((field) => ['hostId', 'deviceId', 'endpoint', 'key', 'grant'].includes(field))).toBe(false);
    expect(() => applyBrainAuthorizationLifecycleEvent(active, { kind: 'principal_registered', principalId: 'principal-a', tenantId: 'tenant-b' })).toThrow('immutable');
  });

  test('owner revocation advances the composite revisions once and never transfers ownership', () => {
    const record = createBrainAuthorizationLifecycleRecord({
      brainId: 'brain-a', ownerPrincipalId: 'owner-a',
      principals: [{ principalId: 'owner-a', tenantId: 'tenant-a', status: 'active', credentialRevision: 0 }],
    });
    const revoked = applyBrainAuthorizationLifecycleEvent(record, { kind: 'owner_revoked' });
    expect(revoked).toMatchObject({ ownerPrincipalId: 'owner-a', ownerStatus: 'revoked', fencingEpoch: 1, credentialRevision: 1, principals: [{ principalId: 'owner-a', status: 'revoked', credentialRevision: 1 }] });
    expect(applyBrainAuthorizationLifecycleEvent(revoked, { kind: 'owner_revoked' })).toEqual(revoked);
  });

  test('owner revocation invalidates the fence even when the owner is not a generic principal', () => {
    const record = createBrainAuthorizationLifecycleRecord({ brainId: 'brain-a', ownerPrincipalId: 'owner-a' });
    const revoked = applyBrainAuthorizationLifecycleEvent(record, { kind: 'owner_revoked' });
    expect(revoked).toMatchObject({ ownerStatus: 'revoked', fencingEpoch: 1, credentialRevision: 1, principals: [] });
  });

  test('rejects invalid lifecycle identifiers and inconsistent owner records', () => {
    expect(() => createBrainAuthorizationLifecycleRecord({ brainId: '', ownerPrincipalId: 'owner-a' })).toThrow('invalid');
    expect(() => createBrainAuthorizationLifecycleRecord({ brainId: 'brain-a', administrators: [{ principalId: '', status: 'active' }] })).toThrow('invalid');
    const record = createBrainAuthorizationLifecycleRecord({ brainId: 'brain-a' });
    expect(() => canAdministerBrainAuthorizationRecord({ ...record, schemaVersion: 2 as never }, 'admin-a')).toThrow('invalid');
  });
});
