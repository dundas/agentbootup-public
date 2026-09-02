import { describe, expect, test } from 'bun:test';
import { ExternalKeyService } from '../lib/external-key-service';
import type { ExternalApiKey } from '../types';
import type { ExternalApiKeyStore } from '../lib/external-api-key-store';
import type { ExternalAuthAuditStore } from '../lib/external-auth-audit-store';

const createdKey: ExternalApiKey = {
  id: 'key_created',
  user_id: 'ext_owner',
  label: 'Laptop',
  secret_hash: 'a'.repeat(64),
  status: 'active',
  created_at: '2026-09-01T00:00:00.000Z',
  last_used_at: null,
  revoked_at: null,
};

function buildService(
  verified: { key: ExternalApiKey; docId: string } | null,
  options: { verifyThrows?: boolean; revokeThrows?: boolean } = {},
) {
  const issuedSecret = 'abu_live_test-secret';
  const calls = { verify: [] as string[], revoke: [] as string[], audit: 0 };
  const keyStore = {
    create: async () => ({ key: createdKey, secret: issuedSecret }),
    verifyBearerToken: async (secret: string) => {
      calls.verify.push(secret);
      if (options.verifyThrows) throw new Error('storage temporarily unavailable');
      return verified;
    },
    revoke: async (id: string) => {
      calls.revoke.push(id);
      if (options.revokeThrows) throw new Error('storage cleanup unavailable');
      return { ...createdKey, status: 'revoked' as const, revoked_at: '2026-09-01T00:00:01.000Z' };
    },
  } as unknown as ExternalApiKeyStore;
  const auditStore = {
    record: async () => {
      calls.audit += 1;
      return {};
    },
  } as unknown as ExternalAuthAuditStore;
  return { service: new ExternalKeyService(keyStore, auditStore, 5), calls, issuedSecret };
}

describe('ExternalKeyService.createForUser', () => {
  test('only records issuance after exact bearer readback succeeds', async () => {
    const { service, calls, issuedSecret } = buildService({ key: createdKey, docId: 'doc-1' });

    const created = await service.createForUser('ext_owner', 'Laptop');

    expect(created.key.id).toBe(createdKey.id);
    expect(calls.verify).toEqual([issuedSecret]);
    expect(calls.revoke).toEqual([]);
    expect(calls.audit).toBe(1);
  });

  test('fails closed, revokes, and does not audit when bearer readback is missing', async () => {
    const { service, calls } = buildService(null);

    await expect(service.createForUser('ext_owner', 'Laptop')).rejects.toMatchObject({
      status: 503,
      code: 'key_issuance_verification_failed',
    });

    expect(calls.revoke).toEqual([createdKey.id]);
    expect(calls.audit).toBe(0);
  });

  test('fails closed when bearer readback resolves a different owner', async () => {
    const { service, calls } = buildService({
      key: { ...createdKey, user_id: 'ext_other' },
      docId: 'doc-1',
    });

    await expect(service.createForUser('ext_owner', 'Laptop')).rejects.toMatchObject({ status: 503 });

    expect(calls.revoke).toEqual([createdKey.id]);
    expect(calls.audit).toBe(0);
  });

  test('fails closed when bearer readback errors', async () => {
    const { service, calls } = buildService(null, { verifyThrows: true });

    await expect(service.createForUser('ext_owner', 'Laptop')).rejects.toMatchObject({ status: 503 });

    expect(calls.revoke).toEqual([createdKey.id]);
    expect(calls.audit).toBe(0);
  });

  test('reports cleanup failure distinctly without returning or auditing the secret', async () => {
    const { service, calls, issuedSecret } = buildService(null, { revokeThrows: true });

    await expect(service.createForUser('ext_owner', 'Laptop')).rejects.toMatchObject({
      status: 503,
      code: 'key_issuance_cleanup_failed',
    });

    expect(calls.verify).toEqual([issuedSecret]);
    expect(calls.revoke).toEqual([createdKey.id]);
    expect(calls.audit).toBe(0);
  });
});
