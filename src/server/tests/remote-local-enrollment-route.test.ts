import { expect, test } from 'bun:test';
import { handleRemoteLocalEnrollmentRoute, isRemoteLocalEnrollmentPath } from '../routes/remote-local-enrollment';

const principal = { kind: 'external' as const, user_id: 'owner-a', key_id: 'key-a' };
const publicKey = 'p'.repeat(43);
const repository = { inspect: async () => ({ disposition: 'current' as const, fence: { capabilitiesRevision: 'fence-a' } }) } as never;

test('remote-local enrollment is a fixed owner-only transport and exposes no runtime selection', async () => {
  const calls: unknown[] = [];
  const enrollment = {
    start: async (input: unknown) => {
      calls.push(input);
      return { status: 'pending' as const, enrollmentId: 'lde_abcdefghijklmnop', deviceId: 'ldv_abcdefghijklmnop', enrollmentSecret: 's'.repeat(43), challenge: 'c'.repeat(43), fence: { capabilitiesRevision: 'fence-a' } };
    },
    complete: async (input: unknown) => {
      calls.push(input);
      return { status: 'applied' as const, record: { deviceId: 'ldv_abcdefghijklmnop' }, fence: { capabilitiesRevision: 'fence-b' }, connectorCredential: 'ldc1_test' };
    },
  } as never;
  const start = await handleRemoteLocalEnrollmentRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/enrollments', { method: 'POST', body: JSON.stringify({ commandId: 'enroll-a', publicKey }) }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/enrollments', principal, enrollment, repository,
  });
  expect(start?.status).toBe(201);
  expect(await start?.json()).toEqual({ data: { enrollment: { enrollmentId: 'lde_abcdefghijklmnop', deviceId: 'ldv_abcdefghijklmnop', enrollmentSecret: 's'.repeat(43), challenge: 'c'.repeat(43), authorityRevision: 'fence-a', authorityScope: { tenantId: 'owner-a', consumerId: 'owner-a' } } } });
  expect(calls[0]).toMatchObject({ context: { kind: 'authenticated_external_owner', principalId: 'owner-a' }, enrolledByCredentialId: 'key-a', expectedCapabilitiesRevision: 'fence-a', publicKey });

  const complete = await handleRemoteLocalEnrollmentRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/enrollments/lde_abcdefghijklmnop/complete', { method: 'POST', body: JSON.stringify({ commandId: 'complete-a', deviceId: 'ldv_abcdefghijklmnop', enrollmentSecret: 's'.repeat(43), signature: 'z'.repeat(86) }) }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/enrollments/lde_abcdefghijklmnop/complete', principal, enrollment, repository,
  });
  expect(complete?.status).toBe(201);
  expect(await complete?.json()).toEqual({ data: { device: { deviceId: 'ldv_abcdefghijklmnop', authorityRevision: 'fence-b' }, connectorCredential: 'ldc1_test' } });
  expect(calls[1]).toMatchObject({ context: { kind: 'local_device_enrollment_daemon', deviceId: 'ldv_abcdefghijklmnop' } });
});

test('remote-local enrollment derives its durable fence and fails closed when it cannot', async () => {
  let startCalls = 0;
  const enrollment = {
    start: async () => { startCalls += 1; throw new Error('unexpected'); },
    complete: async () => { throw new Error('unexpected'); },
  } as never;
  const unavailable = { inspect: async () => ({ disposition: 'unavailable' as const }) } as never;
  await expect(handleRemoteLocalEnrollmentRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/enrollments', { method: 'POST', body: JSON.stringify({ commandId: 'enroll-a', publicKey }) }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/enrollments', principal, enrollment, repository: unavailable,
  })).rejects.toMatchObject({ status: 503, code: 'authority_unavailable' });
  const absent = { inspect: async () => ({ disposition: 'absent' as const }) } as never;
  await expect(handleRemoteLocalEnrollmentRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/enrollments', { method: 'POST', body: JSON.stringify({ commandId: 'enroll-a', publicKey }) }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/enrollments', principal, enrollment, repository: absent,
  })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  expect(startCalls).toBe(0);
});

test('remote-local enrollment rejects unsupported input and non-external callers before the authority store', async () => {
  const enrollment = { start: async () => { throw new Error('must not call'); }, complete: async () => { throw new Error('must not call'); } } as never;
  await expect(handleRemoteLocalEnrollmentRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/enrollments', { method: 'POST', body: JSON.stringify({ commandId: 'enroll-a', expectedCapabilitiesRevision: 'caller-chosen', publicKey }) }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/enrollments', principal, enrollment, repository,
  })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  await expect(handleRemoteLocalEnrollmentRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/enrollments', { method: 'POST', body: '{}' }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/enrollments', principal: { kind: 'admin', key_id: 'admin' }, enrollment, repository,
  })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  expect(isRemoteLocalEnrollmentPath('/v1/remote-local/brains/brain-a/enrollments')).toBe(true);
  expect(isRemoteLocalEnrollmentPath('/v1/remote-local/brains/brain-a/enrollments/lde_abcdefghijklmnop/complete')).toBe(true);
  expect(isRemoteLocalEnrollmentPath('/v1/remote-local/brains/brain-a/device/revoke')).toBe(true);
  expect(isRemoteLocalEnrollmentPath('/v1/remote-local/brains/brain-a/sessions')).toBe(false);
});

test('remote-local device revoke is owner-bound, fenced server-side, and has no caller fence', async () => {
  const calls: unknown[] = [];
  const ownerRepository = {
    inspect: async () => ({ disposition: 'current' as const, fence: { capabilitiesRevision: 'fence-current' } }),
    revokeLocalDevice: async (input: unknown) => { calls.push(input); return { status: 'applied' as const, fence: { capabilitiesRevision: 'fence-next' } }; },
  } as never;
  const response = await handleRemoteLocalEnrollmentRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/device/revoke', { method: 'POST', body: JSON.stringify({ commandId: 'revoke-a' }) }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/device/revoke', principal, enrollment: {} as never, repository: ownerRepository,
  });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ data: { revoked: true, authorityRevision: 'fence-next' } });
  expect(calls[0]).toEqual({ commandId: 'revoke-a', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: 'owner-a' } });
  await expect(handleRemoteLocalEnrollmentRoute({ req: new Request('https://example.test/v1/remote-local/brains/brain-a/device/revoke', { method: 'POST', body: JSON.stringify({ commandId: 'revoke-a', fence: 'forged' }) }), method: 'POST', path: '/v1/remote-local/brains/brain-a/device/revoke', principal, enrollment: {} as never, repository: ownerRepository })).rejects.toMatchObject({ status: 400 });
});

test('remote-local device revoke returns the durable receipt on a lost-response retry', async () => {
  let revokeCalls = 0;
  const repository = {
    inspect: async () => ({ disposition: 'current' as const, fence: { capabilitiesRevision: 'fence-after-revoke' } }),
    revokeLocalDevice: async () => { revokeCalls += 1; return { status: 'idempotent' as const, fence: { capabilitiesRevision: 'fence-after-revoke' } }; },
  } as never;
  const response = await handleRemoteLocalEnrollmentRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/device/revoke', { method: 'POST', body: JSON.stringify({ commandId: 'revoke-a' }) }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/device/revoke', principal, enrollment: {} as never, repository,
  });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ data: { revoked: true, authorityRevision: 'fence-after-revoke' } });
  expect(revokeCalls).toBe(1);
});

test('remote-local device revoke reports unavailable authority without attempting mutation', async () => {
  let revokeCalls = 0;
  const repository = {
    inspect: async () => ({ disposition: 'unavailable' as const }),
    revokeLocalDevice: async () => { revokeCalls += 1; return { status: 'unavailable' as const }; },
  } as never;
  await expect(handleRemoteLocalEnrollmentRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/device/revoke', { method: 'POST', body: JSON.stringify({ commandId: 'revoke-a' }) }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/device/revoke', principal, enrollment: {} as never, repository,
  })).rejects.toMatchObject({ status: 503, code: 'authority_unavailable' });
  expect(revokeCalls).toBe(1);
});
