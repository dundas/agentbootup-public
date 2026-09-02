import { expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';
import { RemoteLocalDeviceEnrollmentStore } from '../lib/remote-local-device-enrollment';
import { MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS, MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS } from '../lib/remote-local-device-credential-policy';
import { MemoryAuthorityCas } from './helpers/memory-authority-cas';

const rawPublicKey = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const owner = { kind: 'authenticated_external_owner' as const, principalId: 'owner-a' };

async function bootstrap(repository: BrainAuthorizationAuthorityRepository) {
  const result = await repository.execute({ kind: 'bootstrap', commandId: 'boot', brainId: 'brain-a', context: owner,
    ownerPrincipalId: 'owner-a', targetId: 'target-a', hostId: 'host-a', deploymentGeneration: 1, adapterIdentity: 'adapter-a', adapterVersion: '1' });
  if (result.status !== 'applied') throw new Error('bootstrap failed');
  return result;
}

test('persists only hashed one-time enrollment material and activates after owner-bound Ed25519 proof', async () => {
  const cas = new MemoryAuthorityCas();
  const now = () => new Date('2026-08-21T12:00:00.000Z');
  const repository = new BrainAuthorizationAuthorityRepository(cas.client(), { now });
  const owner = { kind: 'authenticated_external_owner' as const, principalId: 'owner-a' };
  const boot = await repository.execute({ kind: 'bootstrap', commandId: 'boot', brainId: 'brain-a', context: owner,
    ownerPrincipalId: 'owner-a', targetId: 'target-a', hostId: 'host-a', deploymentGeneration: 1, adapterIdentity: 'adapter-a', adapterVersion: '1' });
  if (boot.status !== 'applied') throw new Error('bootstrap failed');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const store = new RemoteLocalDeviceEnrollmentStore(repository, { now });
  const started = await store.start({ commandId: 'enroll-a', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey, enrolledByCredentialId: 'cred-a' });
  expect(started.status).toBe('pending');
  expect(JSON.stringify([...cas.documents.values()])).not.toContain(started.enrollmentSecret);
  // A response can be lost after the authority CAS write. A retry must not
  // generate replacement one-time material.
  const replayedStart = await store.start({ commandId: 'enroll-a', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey, enrolledByCredentialId: 'cred-a' });
  expect(replayedStart).toMatchObject({ status: 'indeterminate', disposition: 'enrollment_start_recorded' });
  const intervening = await repository.execute({ kind: 'policy_change', commandId: 'policy-a', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: started.fence.capabilitiesRevision });
  expect(intervening.status).toBe('applied');
  const replayedAfterInterveningCommand = await store.start({ commandId: 'enroll-a', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey, enrolledByCredentialId: 'cred-a' });
  expect(replayedAfterInterveningCommand).toMatchObject({ status: 'indeterminate', disposition: 'enrollment_start_recorded' });
  const conflictingPair = generateKeyPairSync('ed25519');
  const conflictingKey = conflictingPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const conflictingReplay = await store.start({ commandId: 'enroll-a', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey: conflictingKey, enrolledByCredentialId: 'cred-a' });
  expect(conflictingReplay).toEqual({ status: 'conflict' });
  const pendingBeforeCompletion = await repository.inspect('brain-a');
  expect(pendingBeforeCompletion).toMatchObject({ disposition: 'current', record: { local_device_enrollment: { device_id: started.deviceId } } });
  const signature = sign(null, Buffer.from(started.challenge, 'utf8'), pair.privateKey).toString('base64url');
  const completed = await store.complete({ commandId: 'activate-a', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: started.deviceId },
    enrollmentId: started.enrollmentId, enrollmentSecret: started.enrollmentSecret, signature });
  expect(completed).toMatchObject({ status: 'applied' });
  expect(completed.connectorCredential).toMatch(/^ldc1_/);
  expect(JSON.stringify([...cas.documents.values()])).not.toContain(completed.connectorCredential);
  const completionDocument = [...cas.documents.values()][0];
  const completedRecord = structuredClone(completionDocument.data);
  completionDocument.data.local_device_credential = null;
  expect(await repository.inspect('brain-a')).toEqual({ disposition: 'invalid' });
  completionDocument.data = structuredClone(completedRecord);
  delete completionDocument.data.local_device_enrollment;
  expect(await repository.inspect('brain-a')).toEqual({ disposition: 'invalid' });
  completionDocument.data = structuredClone(completedRecord);
  if (completed.status !== 'applied') throw new Error('completion missing');
  const afterCompletionTransition = await repository.execute({ kind: 'policy_change', commandId: 'policy-b', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: completed.fence.capabilitiesRevision });
  expect(afterCompletionTransition.status).toBe('applied');

  // A completion response can also be lost. Its credential is one-time and
  // therefore cannot safely be returned on a later retry.
  const replayedCompletion = await store.complete({ commandId: 'activate-a', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: started.deviceId },
    enrollmentId: started.enrollmentId, enrollmentSecret: started.enrollmentSecret, signature });
  expect(replayedCompletion).toMatchObject({ status: 'indeterminate', disposition: 'enrollment_completion_recorded' });
  expect('connectorCredential' in replayedCompletion).toBe(false);

  const active = await repository.inspect('brain-a');
  expect(active.disposition).toBe('current');
  if (active.disposition !== 'current') throw new Error('authority missing after enrollment');
  expect(active.record.local_device_credential).toMatchObject({
    brain_id: 'brain-a', device_id: active.record.local_device?.device_id,
    owner_principal_id: 'owner-a', authority_capabilities_revision: completed.fence.capabilitiesRevision,
    expires_at: '2026-08-22T12:00:00.000Z',
  });

  // A second start must not mint a doomed one-time enrollment while an active
  // device still owns the authority. Replacement is only possible after revoke.
  expect(await store.start({ commandId: 'enroll-active-device', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: active.fence.capabilitiesRevision, publicKey: rawPublicKey(), enrolledByCredentialId: 'cred-b' })).toEqual({ status: 'denied' });

  const revoked = await repository.execute({
    kind: 'local_device_revoke', commandId: 'revoke-a', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: active.fence.capabilitiesRevision, revokedAt: '2026-08-21T12:01:00.000Z',
  });
  expect(revoked.status).toBe('applied');
  const afterRevoke = await repository.inspect('brain-a');
  expect(afterRevoke).toMatchObject({
    disposition: 'current',
    record: { local_device: { state: 'revoked', revoked_at: '2026-08-21T12:01:00.000Z' }, local_device_credential: null },
  });
  const revokeDocument = [...cas.documents.values()][0];
  const revokedRecord = structuredClone(revokeDocument.data);
  revokeDocument.data.local_device = null;
  expect(await repository.inspect('brain-a')).toEqual({ disposition: 'invalid' });
  revokeDocument.data = structuredClone(revokedRecord);
  delete revokeDocument.data.local_device_enrollment;
  expect(await repository.inspect('brain-a')).toEqual({ disposition: 'invalid' });
  revokeDocument.data = structuredClone(revokedRecord);
  delete revokeDocument.data.local_device_credential;
  expect(await repository.inspect('brain-a')).toEqual({ disposition: 'invalid' });
  revokeDocument.data = structuredClone(revokedRecord);

  const replacementPair = generateKeyPairSync('ed25519');
  const replacementKey = replacementPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const replacementStart = await store.start({ commandId: 'enroll-b', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: afterRevoke.fence.capabilitiesRevision, publicKey: replacementKey, enrolledByCredentialId: 'cred-b' });
  expect(replacementStart.status).toBe('pending');
  if (replacementStart.status !== 'pending') throw new Error('replacement enrollment missing');
  const replacementSignature = sign(null, Buffer.from(replacementStart.challenge, 'utf8'), replacementPair.privateKey).toString('base64url');
  const replacement = await store.complete({ commandId: 'activate-b', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: replacementStart.deviceId },
    enrollmentId: replacementStart.enrollmentId, enrollmentSecret: replacementStart.enrollmentSecret, signature: replacementSignature });
  expect(replacement).toMatchObject({ status: 'applied', record: { state: 'active', publicKey: replacementKey } });
});

test('keeps the short enrollment secret lifetime independent from the configured credential lifetime', async () => {
  const now = new Date('2026-08-21T12:00:00.000Z');
  const cas = new MemoryAuthorityCas();
  const repository = new BrainAuthorizationAuthorityRepository(cas.client(), { now: () => now });
  const boot = await bootstrap(repository);
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const store = new RemoteLocalDeviceEnrollmentStore(repository, { now: () => now, initialCredentialTtlMs: MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS });
  const started = await store.start({ commandId: 'enroll-min', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey, enrolledByCredentialId: 'cred-a' });
  if (started.status !== 'pending') throw new Error('pending enrollment missing');
  expect((await repository.inspect('brain-a'))).toMatchObject({ disposition: 'current', record: { local_device_enrollment: { expires_at: '2026-08-21T12:05:00.000Z' } } });
  const signature = sign(null, Buffer.from(started.challenge, 'utf8'), pair.privateKey).toString('base64url');
  expect(await store.complete({ commandId: 'activate-min', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: started.deviceId }, enrollmentId: started.enrollmentId, enrollmentSecret: started.enrollmentSecret, signature })).toMatchObject({ status: 'applied' });
  expect(await repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: { local_device_credential: { expires_at: '2026-08-21T13:00:00.000Z' } } });
  expect(() => new RemoteLocalDeviceEnrollmentStore(repository, { initialCredentialTtlMs: MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS - 1 })).toThrow('MVP bound');
  expect(() => new RemoteLocalDeviceEnrollmentStore(repository, { initialCredentialTtlMs: MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS + 1 })).toThrow('MVP bound');
});

test('authority completion rejects an enrollment secret that expires after the store pre-check', async () => {
  const cas = new MemoryAuthorityCas();
  const repositoryNow = () => new Date('2026-08-21T12:05:00.000Z');
  const repository = new BrainAuthorizationAuthorityRepository(cas.client(), { now: repositoryNow });
  const boot = await bootstrap(repository);
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const store = new RemoteLocalDeviceEnrollmentStore(repository, { now: () => new Date('2026-08-21T12:00:00.000Z') });
  const started = await store.start({ commandId: 'enroll-race', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey, enrolledByCredentialId: 'cred-a' });
  if (started.status !== 'pending') throw new Error('pending enrollment missing');
  const signature = sign(null, Buffer.from(started.challenge, 'utf8'), pair.privateKey).toString('base64url');
  expect(await store.complete({ commandId: 'activate-race', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: started.deviceId }, enrollmentId: started.enrollmentId, enrollmentSecret: started.enrollmentSecret, signature })).toEqual({ status: 'denied' });
  expect(await repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: { local_device_enrollment: { enrollment_id: started.enrollmentId }, local_device: null } });
});

test('atomically replaces only an expired pending enrollment under the current owner and fence', async () => {
  let now = new Date('2026-08-21T12:00:00.000Z');
  const cas = new MemoryAuthorityCas();
  const repository = new BrainAuthorizationAuthorityRepository(cas.client(), { now: () => now });
  const boot = await bootstrap(repository);
  const storeA = new RemoteLocalDeviceEnrollmentStore(repository, { now: () => now });
  const storeB = new RemoteLocalDeviceEnrollmentStore(new BrainAuthorizationAuthorityRepository(cas.client(), { now: () => now }), { now: () => now });
  const first = await storeA.start({ commandId: 'enroll-expiring', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey: rawPublicKey(), enrolledByCredentialId: 'cred-a' });
  if (first.status !== 'pending') throw new Error('initial enrollment missing');

  now = new Date('2026-08-21T12:04:59.999Z');
  expect(await storeA.start({ commandId: 'too-early', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: first.fence.capabilitiesRevision, publicKey: rawPublicKey(), enrolledByCredentialId: 'cred-a' }))
    .toEqual({ status: 'denied' });

  now = new Date('2026-08-21T12:05:00.000Z');
  expect(await storeA.start({ commandId: 'stale-fence', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey: rawPublicKey(), enrolledByCredentialId: 'cred-a' }))
    .toEqual({ status: 'conflict' });
  expect(await storeA.start({ commandId: 'wrong-owner', brainId: 'brain-a',
    context: { kind: 'authenticated_external_owner', principalId: 'owner-b' }, expectedCapabilitiesRevision: first.fence.capabilitiesRevision,
    publicKey: rawPublicKey(), enrolledByCredentialId: 'cred-b' })).toEqual({ status: 'denied' });

  const replacements = await Promise.all([
    storeA.start({ commandId: 'replace-a', brainId: 'brain-a', context: owner,
      expectedCapabilitiesRevision: first.fence.capabilitiesRevision, publicKey: rawPublicKey(), enrolledByCredentialId: 'cred-a' }),
    storeB.start({ commandId: 'replace-b', brainId: 'brain-a', context: owner,
      expectedCapabilitiesRevision: first.fence.capabilitiesRevision, publicKey: rawPublicKey(), enrolledByCredentialId: 'cred-a' }),
  ]);
  expect(replacements.filter((result) => result.status === 'pending')).toHaveLength(1);
  expect(replacements.filter((result) => result.status === 'conflict')).toHaveLength(1);
  const winner = replacements.find((result) => result.status === 'pending');
  if (!winner || winner.status !== 'pending') throw new Error('replacement winner missing');
  expect(winner.enrollmentId).not.toBe(first.enrollmentId);
  expect(winner.deviceId).not.toBe(first.deviceId);
  expect(winner.enrollmentSecret).not.toBe(first.enrollmentSecret);
  expect(winner.challenge).not.toBe(first.challenge);
  const durable = JSON.stringify([...cas.documents.values()]);
  expect(durable).not.toContain(first.enrollmentSecret);
  expect(durable).not.toContain(winner.enrollmentSecret);
  expect(await repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: { local_device_enrollment: {
    enrollment_id: winner.enrollmentId, device_id: winner.deviceId, challenge: winner.challenge,
  } } });
});

test('reconciles an uncertain expired replacement without disclosing or minting retry material', async () => {
  let now = new Date('2026-08-21T12:00:00.000Z');
  const cas = new MemoryAuthorityCas();
  const repository = new BrainAuthorizationAuthorityRepository(cas.client(), { now: () => now });
  const boot = await bootstrap(repository);
  const store = new RemoteLocalDeviceEnrollmentStore(repository, { now: () => now });
  const first = await store.start({ commandId: 'enroll-expiring', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey: rawPublicKey(), enrolledByCredentialId: 'cred-a' });
  if (first.status !== 'pending') throw new Error('initial enrollment missing');

  now = new Date('2026-08-21T12:06:00.000Z');
  const attemptsBeforeReplacement = cas.updateAttempts;
  cas.loseNextUpdate = true;
  const replacement = await store.start({ commandId: 'replace-uncertain', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: first.fence.capabilitiesRevision, publicKey: rawPublicKey(), enrolledByCredentialId: 'cred-a' });
  expect(replacement).toMatchObject({ status: 'indeterminate', disposition: 'enrollment_start_recorded' });
  expect('enrollmentSecret' in replacement).toBe(false);
  expect('challenge' in replacement).toBe(false);
  expect(cas.updateAttempts).toBe(attemptsBeforeReplacement + 1);
  const inspected = await repository.inspect('brain-a');
  expect(inspected).toMatchObject({ disposition: 'current', record: { local_device_enrollment: { start_command_id: 'replace-uncertain' } } });
  expect(JSON.stringify([...cas.documents.values()])).not.toContain(first.enrollmentSecret);
});

test('keeps revoke receipts across later transitions and concurrent retries', async () => {
  const cas = new MemoryAuthorityCas();
  const repository = new BrainAuthorizationAuthorityRepository(cas.client(), { now: () => new Date('2026-08-28T12:00:00.000Z') });
  const boot = await bootstrap(repository);
  const store = new RemoteLocalDeviceEnrollmentStore(repository, { now: () => new Date('2026-08-28T12:00:00.000Z') });
  const firstPair = generateKeyPairSync('ed25519');
  const first = await store.start({ commandId: 'receipt-enroll-a', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey: firstPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), enrolledByCredentialId: 'cred-a' });
  if (first.status !== 'pending') throw new Error('initial enrollment missing');
  const firstCompleted = await store.complete({ commandId: 'receipt-activate-a', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: first.deviceId }, enrollmentId: first.enrollmentId, enrollmentSecret: first.enrollmentSecret, signature: sign(null, Buffer.from(first.challenge), firstPair.privateKey).toString('base64url') });
  if (firstCompleted.status !== 'applied') throw new Error('initial device activation missing');
  const revoked = await repository.revokeLocalDevice({ commandId: 'receipt-revoke-a', brainId: 'brain-a', context: owner });
  expect(revoked.status).toBe('applied');
  if (revoked.status !== 'applied') throw new Error('revoke missing');
  const policy = await repository.execute({ kind: 'policy_change', commandId: 'receipt-policy', brainId: 'brain-a', context: owner, expectedCapabilitiesRevision: revoked.fence.capabilitiesRevision });
  expect(policy.status).toBe('applied');
  const replayAfterTransition = await repository.revokeLocalDevice({ commandId: 'receipt-revoke-a', brainId: 'brain-a', context: owner });
  expect(replayAfterTransition).toMatchObject({ status: 'idempotent' });
  const afterPolicy = await repository.inspect('brain-a');
  if (afterPolicy.disposition !== 'current') throw new Error('authority missing after policy');
  const secondPair = generateKeyPairSync('ed25519');
  const second = await store.start({ commandId: 'receipt-enroll-b', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: afterPolicy.fence.capabilitiesRevision, publicKey: secondPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), enrolledByCredentialId: 'cred-b' });
  if (second.status !== 'pending') throw new Error('replacement enrollment missing');
  const secondCompleted = await store.complete({ commandId: 'receipt-activate-b', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: second.deviceId }, enrollmentId: second.enrollmentId, enrollmentSecret: second.enrollmentSecret, signature: sign(null, Buffer.from(second.challenge), secondPair.privateKey).toString('base64url') });
  if (secondCompleted.status !== 'applied') throw new Error('replacement activation missing');
  expect(await repository.revokeLocalDevice({ commandId: 'receipt-revoke-a', brainId: 'brain-a', context: owner })).toMatchObject({ status: 'idempotent' });
  expect(await repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: { local_device: { state: 'active', device_id: second.deviceId } } });
  const concurrent = await Promise.all([
    repository.revokeLocalDevice({ commandId: 'receipt-revoke-b', brainId: 'brain-a', context: owner }),
    new BrainAuthorizationAuthorityRepository(cas.client(), { now: () => new Date('2026-08-28T12:00:00.000Z') }).revokeLocalDevice({ commandId: 'receipt-revoke-b', brainId: 'brain-a', context: owner }),
  ]);
  expect(concurrent.map((result) => result.status).sort()).toEqual(['applied', 'idempotent']);
  const afterConcurrent = await repository.inspect('brain-a');
  if (afterConcurrent.disposition !== 'current') throw new Error('authority missing after concurrent revoke');
  expect(await repository.execute({ kind: 'owner_revoke', commandId: 'receipt-owner-revoke', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: afterConcurrent.fence.capabilitiesRevision })).toMatchObject({ status: 'applied' });
  // A response may be retried after a later authority transition, including a
  // revocation of the owner.  The receipt is not a new privileged operation.
  expect(await repository.revokeLocalDevice({ commandId: 'receipt-revoke-a', brainId: 'brain-a', context: owner })).toMatchObject({ status: 'idempotent' });
  const malformed = [...cas.documents.values()][0];
  malformed.data.local_device_revoke_receipts = [{ malformed: true }];
  expect(await repository.revokeLocalDevice({ commandId: 'new-revoke', brainId: 'brain-a', context: owner })).toEqual({ status: 'unavailable' });
  expect(JSON.stringify([...cas.documents.values()])).not.toContain('secret=');
});

test('a losing duplicate revoke replays its receipt when owner revocation wins before reread', async () => {
  const cas = new MemoryAuthorityCas();
  const now = () => new Date('2026-08-28T12:00:00.000Z');
  const winner = new BrainAuthorizationAuthorityRepository(cas.client(), { now });
  const boot = await bootstrap(winner);
  const store = new RemoteLocalDeviceEnrollmentStore(winner, { now });
  const pair = generateKeyPairSync('ed25519');
  const enrollment = await store.start({ commandId: 'interleave-enroll', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), enrolledByCredentialId: 'cred-a' });
  if (enrollment.status !== 'pending') throw new Error('enrollment missing');
  expect(await store.complete({ commandId: 'interleave-activate', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: enrollment.deviceId }, enrollmentId: enrollment.enrollmentId, enrollmentSecret: enrollment.enrollmentSecret, signature: sign(null, Buffer.from(enrollment.challenge), pair.privateKey).toString('base64url') })).toMatchObject({ status: 'applied' });
  const base = cas.client();
  let reads = 0;
  let signalLoserUpdate!: () => void;
  const loserAtUpdate = new Promise<void>((resolve) => { signalLoserUpdate = resolve; });
  let releaseLoserUpdate!: () => void;
  const loserUpdate = new Promise<void>((resolve) => { releaseLoserUpdate = resolve; });
  const stale = structuredClone([...cas.documents.values()][0]);
  const loser = new BrainAuthorizationAuthorityRepository({
    ...base,
    getDocument: async (collection, key) => {
      reads += 1;
      if (reads === 2) return { ok: true as const, document: structuredClone(stale) };
      return base.getDocument(collection, key);
    },
    updateDocument: async (collection, key, body) => {
      signalLoserUpdate();
      await loserUpdate;
      const result = await base.updateDocument(collection, key, body);
      if (!result.ok && result.code === 'REVISION_CONFLICT') {
        const current = await winner.inspect('brain-a');
        if (current.disposition !== 'current') throw new Error('winner authority missing');
        expect(await winner.execute({ kind: 'owner_revoke', commandId: 'interleave-owner-revoke', brainId: 'brain-a', context: owner, expectedCapabilitiesRevision: current.fence.capabilitiesRevision })).toMatchObject({ status: 'applied' });
      }
      return result;
    },
  }, { now });
  const losing = loser.revokeLocalDevice({ commandId: 'interleave-revoke', brainId: 'brain-a', context: owner });
  await loserAtUpdate;
  expect(await winner.revokeLocalDevice({ commandId: 'interleave-revoke', brainId: 'brain-a', context: owner })).toMatchObject({ status: 'applied' });
  releaseLoserUpdate();
  expect(await losing).toMatchObject({ status: 'idempotent' });
});
