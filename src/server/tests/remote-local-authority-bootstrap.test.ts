import { expect, test } from 'bun:test';
import { handleRemoteLocalAuthorityBootstrapRoute, isRemoteLocalAuthorityBootstrapPath } from '../routes/remote-local-authority-bootstrap';
import { isRouteAllowedForPrincipal } from '../lib/public-route-policy';

const owners = new Map([['brain-a', 'owner-a']]);
const principal = { kind: 'external' as const, user_id: 'owner-a', key_id: 'key-a' };

test('remote-local authority bootstrap is fixed, owner-bound, and discloses only a fence revision', async () => {
  const calls: unknown[] = [];
  const repository = {
    inspect: async () => ({ disposition: 'missing' as const }),
    execute: async (input: unknown) => { calls.push(input); return { status: 'applied' as const, fence: { capabilitiesRevision: 'fence-a' } }; },
  } as never;
  const response = await handleRemoteLocalAuthorityBootstrapRoute({
    req: new Request('https://example.test/v1/remote-local/brains/brain-a/authority-bootstrap', { method: 'POST', body: JSON.stringify({ commandId: 'bootstrap-a' }) }),
    method: 'POST', path: '/v1/remote-local/brains/brain-a/authority-bootstrap', principal, repository, bootstrapOwners: owners,
    adapterIdentity: 'mech-plane', adapterVersion: '3.2.7',
  });
  expect(response?.status).toBe(201);
  expect(await response?.json()).toEqual({ data: { authorityRevision: 'fence-a' } });
  expect(calls[0]).toEqual({ kind: 'local_device_bootstrap', commandId: 'bootstrap-a', brainId: 'brain-a',
    context: { kind: 'authenticated_external_owner', principalId: 'owner-a' }, ownerPrincipalId: 'owner-a',
    adapterIdentity: 'mech-plane', adapterVersion: '3.2.7' });
  expect(isRemoteLocalAuthorityBootstrapPath('/v1/remote-local/brains/brain-a/authority-bootstrap')).toBe(true);
  expect(isRouteAllowedForPrincipal(principal, 'POST', '/v1/remote-local/brains/brain-a/authority-bootstrap')).toBe(true);
  expect(isRouteAllowedForPrincipal(principal, 'GET', '/v1/remote-local/brains/brain-a/authority-bootstrap')).toBe(false);
});

test('bootstrap is default-deny for non-owners, malformed input, and conflicting state', async () => {
  const repository = { inspect: async () => ({ disposition: 'missing' as const }), execute: async () => { throw new Error('must not execute'); } } as never;
  await expect(handleRemoteLocalAuthorityBootstrapRoute({ req: new Request('https://example.test/v1/remote-local/brains/brain-a/authority-bootstrap', { method: 'POST', body: JSON.stringify({ commandId: 'a', runtime: 'forbidden' }) }), method: 'POST', path: '/v1/remote-local/brains/brain-a/authority-bootstrap', principal, repository, bootstrapOwners: owners, adapterIdentity: 'plane', adapterVersion: '1' })).rejects.toMatchObject({ status: 400 });
  await expect(handleRemoteLocalAuthorityBootstrapRoute({ req: new Request('https://example.test/v1/remote-local/brains/brain-a/authority-bootstrap', { method: 'POST', body: JSON.stringify({ commandId: 'a' }) }), method: 'POST', path: '/v1/remote-local/brains/brain-a/authority-bootstrap', principal: { ...principal, user_id: 'other' }, repository, bootstrapOwners: owners, adapterIdentity: 'plane', adapterVersion: '1' })).rejects.toMatchObject({ status: 403 });
});
