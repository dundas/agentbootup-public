import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';
import { mintLocalDeviceId, RemoteLocalDeviceAuthority } from '../lib/remote-local-device-authority';
import { MemoryAuthorityCas } from './helpers/memory-authority-cas';

const owner = { kind: 'authenticated_external_owner' as const, principalId: 'owner-a' };

async function authority() {
  const cas = new MemoryAuthorityCas();
  const repository = new BrainAuthorizationAuthorityRepository(cas.client());
  const boot = await repository.execute({
    kind: 'bootstrap', commandId: 'bootstrap', brainId: 'brain-a', context: owner,
    ownerPrincipalId: owner.principalId, targetId: 'target-a', hostId: 'host-a', deploymentGeneration: 1,
    adapterIdentity: 'adapter-a', adapterVersion: '1',
  });
  if (boot.status !== 'applied') throw new Error('bootstrap failed');
  return { cas, repository, fence: boot.fence };
}

function publicKey() {
  const pair = generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ format: 'der', type: 'spki' });
  return der.subarray(-32).toString('base64url');
}

describe('RemoteLocalDeviceAuthority', () => {
  test('dedicated local-device bootstrap creates no AgentHost target and supports the later fenced bind', async () => {
    const cas = new MemoryAuthorityCas();
    const repository = new BrainAuthorizationAuthorityRepository(cas.client());
    const boot = await repository.execute({ kind: 'local_device_bootstrap', commandId: 'local-bootstrap', brainId: 'brain-a',
      context: owner, ownerPrincipalId: owner.principalId, adapterIdentity: 'mech-plane', adapterVersion: '3.2.7' });
    expect(boot.status).toBe('applied');
    if (boot.status !== 'applied') throw new Error('bootstrap failed');
    const current = await repository.inspect('brain-a');
    expect(current).toMatchObject({ disposition: 'current', record: { owner_principal_id: 'owner-a', target_id: null,
      host_id: null, target_disposition: 'revoked', deployment_generation: 0, local_device: null,
      adapter_identity: 'mech-plane', adapter_version: '3.2.7' } });
    const bound = await new RemoteLocalDeviceAuthority(repository).bind({ commandId: 'bind-after-local-bootstrap', brainId: 'brain-a',
      context: owner, expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, deviceId: mintLocalDeviceId(),
      publicKey: publicKey(), enrolledByCredentialId: 'cred-a', enrolledAt: '2026-08-26T20:30:00.000Z' });
    expect(bound.status).toBe('applied');
  });

  test('server mints opaque unpredictable-format device identifiers', () => {
    const first = mintLocalDeviceId();
    const second = mintLocalDeviceId();
    expect(first).toMatch(/^ldv_[A-Za-z0-9_-]{24}$/);
    expect(second).toMatch(/^ldv_[A-Za-z0-9_-]{24}$/);
    expect(second).not.toBe(first);
  });

  test('mints and persists only the bounded active local-device evidence on the sole authority record', async () => {
    const { repository, fence } = await authority();
    const devices = new RemoteLocalDeviceAuthority(repository);
    const deviceId = mintLocalDeviceId();

    const result = await devices.bind({
      commandId: 'bind-a', brainId: 'brain-a', context: owner, expectedCapabilitiesRevision: fence.capabilitiesRevision,
      deviceId, publicKey: publicKey(), enrolledByCredentialId: 'cred-a', enrolledAt: '2026-08-21T12:00:00.000Z',
    });

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('bind failed');
    expect(result.record).toMatchObject({
      schemaVersion: 1, brainId: 'brain-a', ownerPrincipalId: 'owner-a',
      publicKeyAlgorithm: 'ed25519', state: 'active', authorityCapabilitiesRevision: result.fence.capabilitiesRevision,
      enrolledByCredentialId: 'cred-a', enrolledAt: '2026-08-21T12:00:00.000Z', revokedAt: null, lastSeenAt: null,
    });
    expect(result.record.deviceId).toBe(deviceId);
    expect(result.record.publicKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const stored = await devices.inspect('brain-a');
    expect(stored).toEqual({ disposition: 'current', record: result.record, fence: result.fence });
    const wire = JSON.stringify((await repository.inspect('brain-a')));
    for (const forbidden of ['url', 'endpoint', 'token', 'private', 'secret', 'plaintext', 'connector']) {
      expect(wire.toLowerCase()).not.toContain(forbidden);
    }
  });

  test('reads legacy schema-v1 authority records and upgrades only through a fenced local-device bind', async () => {
    const { cas, repository, fence } = await authority();
    const stored = [...cas.documents.values()][0]!;
    delete (stored.data as Record<string, unknown>).local_device;
    delete (stored.data as Record<string, unknown>).local_device_enrollment;
    delete (stored.data as Record<string, unknown>).local_device_credential;

    expect(await repository.inspect('brain-a')).toMatchObject({ disposition: 'current', fence });
    const afterPolicy = await repository.execute({
      kind: 'policy_change', commandId: 'legacy-policy', brainId: 'brain-a', context: owner,
      expectedCapabilitiesRevision: fence.capabilitiesRevision,
    });
    expect(afterPolicy.status).toBe('applied');
    expect(Object.hasOwn([...cas.documents.values()][0]!.data, 'local_device')).toBe(false);
    if (afterPolicy.status !== 'applied') throw new Error('policy failed');

    const devices = new RemoteLocalDeviceAuthority(repository);
    const deviceId = mintLocalDeviceId();
    const bound = await devices.bind({
      commandId: 'legacy-bind', brainId: 'brain-a', context: owner,
      expectedCapabilitiesRevision: afterPolicy.fence.capabilitiesRevision,
      deviceId, publicKey: publicKey(), enrolledByCredentialId: 'cred-a', enrolledAt: '2026-08-21T12:01:00.000Z',
    });
    expect(bound.status).toBe('applied');
    expect(Object.hasOwn([...cas.documents.values()][0]!.data, 'local_device')).toBe(true);
    if (bound.status === 'applied') expect(bound.record.authorityCapabilitiesRevision).toBe(bound.fence.capabilitiesRevision);

    // A torn post-bind document must not be mistaken for an idempotent bind.
    delete ([...cas.documents.values()][0]!.data as Record<string, unknown>).local_device;
    expect(await repository.inspect('brain-a')).toEqual({ disposition: 'invalid' });
  });

  test('reconciles one uncertain bind without a second authority write and rejects malformed key material', async () => {
    const cas = new MemoryAuthorityCas();
    const base = cas.client();
    let updateAttempts = 0;
    let loseNextUpdate = true;
    const repository = new BrainAuthorizationAuthorityRepository({
      ...base,
      updateDocument: async (collection, key, body) => {
        updateAttempts += 1;
        const result = await base.updateDocument(collection, key, body);
        if (loseNextUpdate) { loseNextUpdate = false; throw new Error('transport lost'); }
        return result;
      },
    });
    const boot = await repository.execute({
      kind: 'bootstrap', commandId: 'bootstrap', brainId: 'brain-a', context: owner,
      ownerPrincipalId: owner.principalId, targetId: 'target-a', hostId: 'host-a', deploymentGeneration: 1,
      adapterIdentity: 'adapter-a', adapterVersion: '1',
    });
    if (boot.status !== 'applied') throw new Error('bootstrap failed');
    const fence = boot.fence;
    const devices = new RemoteLocalDeviceAuthority(repository);
    const deviceId = mintLocalDeviceId();
    const invalid = await devices.bind({
      commandId: 'bad-key', brainId: 'brain-a', context: owner, expectedCapabilitiesRevision: fence.capabilitiesRevision,
      deviceId, publicKey: 'not-a-canonical-ed25519-key', enrolledByCredentialId: 'cred-a', enrolledAt: '2026-08-21T12:02:00.000Z',
    });
    expect(invalid).toEqual({ status: 'denied' });
    expect(updateAttempts).toBe(0);

    const bind = {
      commandId: 'bind-reconcile', brainId: 'brain-a', context: owner, expectedCapabilitiesRevision: fence.capabilitiesRevision,
      deviceId, publicKey: publicKey(), enrolledByCredentialId: 'cred-a', enrolledAt: '2026-08-21T12:02:00.000Z',
    };
    const result = await devices.bind(bind);
    const replay = await devices.bind(bind);
    expect(result.status).toBe('idempotent');
    expect(replay.status).toBe('idempotent');
    expect(updateAttempts).toBe(1);
    if (result.status === 'idempotent' && replay.status === 'idempotent') {
      expect(replay.record.deviceId).toBe(result.record.deviceId);
    }
  });
});
