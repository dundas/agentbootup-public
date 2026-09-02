import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';
import { RemoteLocalDeviceEnrollmentStore } from '../lib/remote-local-device-enrollment';
import { RemoteLocalDeviceReauthenticationStore } from '../lib/remote-local-device-reauthentication';
import { canonicalDeviceReauthProofPayload } from '../lib/remote-local-relay-protocol';
import { MemoryAuthorityCas } from './helpers/memory-authority-cas';

const owner = { kind: 'authenticated_external_owner' as const, principalId: 'owner-a' };
const at = (text: string) => new Date(text);

async function enrolled(cas = new MemoryAuthorityCas()) {
  let now = at('2026-08-21T12:00:00.000Z');
  const repository = new BrainAuthorizationAuthorityRepository(cas.client(), { now: () => now });
  const boot = await repository.execute({ kind: 'bootstrap', commandId: 'boot', brainId: 'brain-a', context: owner,
    ownerPrincipalId: 'owner-a', targetId: 'target-a', hostId: 'host-a', deploymentGeneration: 1, adapterIdentity: 'adapter-a', adapterVersion: '1' });
  if (boot.status !== 'applied') throw new Error('bootstrap failed');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const enrollment = new RemoteLocalDeviceEnrollmentStore(repository, { now: () => now });
  const started = await enrollment.start({ commandId: 'enroll', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey, enrolledByCredentialId: 'owner-credential-a' });
  if (started.status !== 'pending') throw new Error('enrollment failed');
  const signature = sign(null, Buffer.from(started.challenge), pair.privateKey).toString('base64url');
  const completed = await enrollment.complete({ commandId: 'complete', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: started.deviceId }, enrollmentId: started.enrollmentId, enrollmentSecret: started.enrollmentSecret, signature });
  if (completed.status !== 'applied') throw new Error('completion failed');
  return { cas, repository, pair, deviceId: completed.record.deviceId, fence: completed.fence.capabilitiesRevision,
    credential: completed.connectorCredential, setNow: (value: string) => { now = at(value); } };
}

function proof(challenge: Awaited<ReturnType<RemoteLocalDeviceReauthenticationStore['issueChallenge']>>, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  if (challenge.status !== 'issued') throw new Error('challenge not issued');
  const frame = { fence: { brainId: challenge.brainId, deviceId: challenge.deviceId, authorityRevision: challenge.authorityRevision }, credentialId: challenge.credentialId,
    proofChallengeId: challenge.proofChallengeId, purpose: challenge.purpose, expiresAt: challenge.expiresAt, rotationId: challenge.rotationId };
  return { ...frame, signatureAlgorithm: 'ed25519' as const, signature: sign(null, Buffer.from(canonicalDeviceReauthProofPayload(frame)), privateKey).toString('base64url') };
}

async function activatePrepared(
  auth: RemoteLocalDeviceReauthenticationStore,
  fixture: Awaited<ReturnType<typeof enrolled>>,
  prepared: Extract<Awaited<ReturnType<RemoteLocalDeviceReauthenticationStore['authenticate']>>, { status: 'prepared' }>,
  commandId = 'activate-challenge',
) {
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await auth.issueChallenge({ commandId, brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_activate' });
  if (challenge.status !== 'issued') throw new Error('activation challenge missing');
  const result = await auth.authenticate({ brainId: 'brain-a', context, credential: prepared.connectorCredential,
    proof: proof(challenge, fixture.pair.privateKey) });
  return { challenge, result };
}

test('credential alone never admits; a fresh canonical device proof is single-use and socket_open returns no socket or route', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  expect(await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential } as never)).toEqual({ status: 'close', reason: 'invalid_proof' });
  const challenge = await auth.issueChallenge({ commandId: 'challenge-open', brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  expect(challenge).toMatchObject({ status: 'issued', purpose: 'socket_open', brainId: 'brain-a', deviceId: fixture.deviceId, authorityRevision: fixture.fence });
  if (challenge.status !== 'issued') throw new Error('missing challenge');
  expect(new Date(challenge.expiresAt).getTime()).toBe(at('2026-08-21T12:00:40.000Z').getTime());
  const admitted = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(challenge, fixture.pair.privateKey) });
  expect(admitted).toEqual({ status: 'admitted', disposition: 'socket_open', fence: fixture.fence, deviceId: fixture.deviceId,
    credentialExpiresAt: '2026-08-22T12:00:00.000Z' });
  expect(admitted).not.toHaveProperty('socket');
  expect(admitted).not.toHaveProperty('route');
  expect(await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(challenge, fixture.pair.privateKey) }))
    .toEqual({ status: 'close', reason: 'invalid_proof' });
});

test('a bearer cannot replace a live challenge and the original proof remains usable', async () => {
  const fixture = await enrolled();
  const now = () => at('2026-08-21T12:00:10.000Z');
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const first = await auth.issueChallenge({ commandId: 'challenge-live-first', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  if (first.status !== 'issued') throw new Error('first challenge missing');
  const attempts = fixture.cas.updateAttempts;
  expect(await auth.issueChallenge({ commandId: 'challenge-live-replacement', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' }))
    .toEqual({ status: 'denied' });
  expect(fixture.cas.updateAttempts).toBe(attempts);
  expect(await fixture.repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: {
    local_device_reauth_sequence: 1,
    local_device_reauth: { proof_challenge_id: first.proofChallengeId, rotation_id: first.rotationId },
  } });
  expect(await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(first, fixture.pair.privateKey) })).toEqual({
    status: 'admitted', disposition: 'socket_open', fence: fixture.fence, deviceId: fixture.deviceId,
    credentialExpiresAt: '2026-08-22T12:00:00.000Z',
  });
});

test('an expired challenge may be replaced at the exact expiry boundary without reusing its sequence', async () => {
  const fixture = await enrolled();
  let now = at('2026-08-21T12:00:10.000Z');
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => now });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const first = await auth.issueChallenge({ commandId: 'challenge-expiring-first', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  if (first.status !== 'issued') throw new Error('first challenge missing');
  now = at(first.expiresAt);
  fixture.setNow(first.expiresAt);
  const second = await auth.issueChallenge({ commandId: 'challenge-expired-replacement', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  expect(second).toMatchObject({ status: 'issued', reauthSequence: 2, purpose: 'credential_refresh' });
  if (second.status !== 'issued') throw new Error('replacement challenge missing');
  expect(second.proofChallengeId).not.toBe(first.proofChallengeId);
  expect(second.rotationId).not.toBe(first.rotationId);
  expect(await fixture.repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: {
    local_device_reauth_sequence: 2,
    local_device_reauth: { proof_challenge_id: second.proofChallengeId, rotation_id: second.rotationId },
  } });
});

test('denies stale, expired, forged, cross-brain, cross-device, wrong-purpose, wrong-fence, and wrong credential proofs', async () => {
  const fixture = await enrolled();
  let now = at('2026-08-21T12:00:10.000Z');
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => now });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const make = async (id: string) => auth.issueChallenge({ commandId: id, brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' as const });
  for (const mutate of [
    (p: ReturnType<typeof proof>) => ({ ...p, credentialId: 'ldc_wrong' }),
    (p: ReturnType<typeof proof>) => ({ ...p, fence: { ...p.fence, brainId: 'brain-b' } }),
    (p: ReturnType<typeof proof>) => ({ ...p, fence: { ...p.fence, deviceId: 'ldv_ABCDEFGHIJKLMNOPQRSTUVWX' } }),
    (p: ReturnType<typeof proof>) => ({ ...p, fence: { ...p.fence, authorityRevision: 'stale-fence' } }),
    (p: ReturnType<typeof proof>) => ({ ...p, purpose: 'credential_refresh' as const }),
    (p: ReturnType<typeof proof>) => ({ ...p, signature: 'A'.repeat(86) }),
  ]) {
    const challenge = await make(`negative-${Math.random()}`);
    const result = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: mutate(proof(challenge, fixture.pair.privateKey)) });
    expect(result).toEqual({ status: 'close', reason: 'invalid_proof' });
    expect((await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
      proof: proof(challenge, fixture.pair.privateKey) })).status).toBe('admitted');
  }
  const challenge = await make('expired');
  now = at('2026-08-21T12:00:40.000Z');
  expect(await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(challenge, fixture.pair.privateKey) }))
    .toEqual({ status: 'close', reason: 'expired' });
  expect(await auth.issueChallenge({ commandId: 'wrong-device', brainId: 'brain-a', context: { kind: 'local_device_connector', deviceId: 'ldv_ABCDEFGHIJKLMNOPQRSTUVWX' }, credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' })).toEqual({ status: 'denied' });
  expect(await auth.issueChallenge({ commandId: 'wrong-secret', brainId: 'brain-a', context, credential: 'ldc1_wrong', expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' })).toEqual({ status: 'denied' });
});

test('two instances have one prepare winner and disclose successor plaintext only for the known first apply', async () => {
  const fixture = await enrolled();
  const options = { now: () => at('2026-08-21T12:00:10.000Z'), challengeTtlMs: 20_000, credentialTtlMs: 120_000 };
  const authA = new RemoteLocalDeviceReauthenticationStore(fixture.repository, options);
  const authB = new RemoteLocalDeviceReauthenticationStore(
    new BrainAuthorizationAuthorityRepository(fixture.cas.client(), { now: options.now }),
    options,
  );
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await authA.issueChallenge({ commandId: 'challenge-refresh', brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  const signed = proof(challenge, fixture.pair.privateKey);
  const results = await Promise.all([
    authA.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: signed }),
    authB.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: signed }),
  ]);
  expect(results.filter((result) => result.status === 'prepared')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'close')).toHaveLength(1);
  const winner = results.find((result) => result.status === 'prepared');
  if (!winner || winner.status !== 'prepared') throw new Error('winner missing');
  expect(winner.connectorCredential).toMatch(/^ldc1_/);
  expect(winner.rotationId).toBe(challenge.status === 'issued' ? challenge.rotationId : 'missing');
  expect(JSON.stringify([...fixture.cas.documents.values()])).not.toContain(winner.connectorCredential);
  expect(await authA.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: signed })).toEqual({ status: 'close', reason: 'invalid_proof' });
});

test('two instances consuming one socket proof admit at most one', async () => {
  const fixture = await enrolled();
  const options = { now: () => at('2026-08-21T12:00:10.000Z') };
  const authA = new RemoteLocalDeviceReauthenticationStore(fixture.repository, options);
  const authB = new RemoteLocalDeviceReauthenticationStore(
    new BrainAuthorizationAuthorityRepository(fixture.cas.client(), { now: options.now }),
    options,
  );
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await authA.issueChallenge({ commandId: 'challenge-open-race', brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  const signed = proof(challenge, fixture.pair.privateKey);
  const results = await Promise.all([
    authA.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: signed }),
    authB.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: signed }),
  ]);
  expect(results.filter((result) => result.status === 'admitted')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'close')).toHaveLength(1);
});

test('repository rejects successor credential identity and verifier reuse before CAS', async () => {
  for (const reuse of ['credential_id', 'verifier_hash'] as const) {
    const fixture = await enrolled();
    const now = at('2026-08-21T12:00:10.000Z');
    const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => now });
    const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
    const challenge = await auth.issueChallenge({ commandId: `challenge-reuse-${reuse}`, brainId: 'brain-a', context,
      credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
    if (challenge.status !== 'issued') throw new Error('challenge missing');
    const signed = proof(challenge, fixture.pair.privateKey);
    const inspected = await fixture.repository.inspect('brain-a');
    if (inspected.disposition !== 'current' || !inspected.record.local_device_credential) throw new Error('credential missing');
    const attempts = fixture.cas.updateAttempts;
    const result = await fixture.repository.execute({ kind: 'local_device_credential_prepare', commandId: `reuse-${reuse}`,
      brainId: 'brain-a', context, expectedCapabilitiesRevision: fixture.fence, credential: fixture.credential,
      credentialId: signed.credentialId, proofChallengeId: signed.proofChallengeId, purpose: 'credential_refresh',
      expiresAt: signed.expiresAt, rotationId: signed.rotationId, reauthSequence: challenge.reauthSequence, signature: signed.signature,
      successorCredentialId: reuse === 'credential_id' ? signed.credentialId : 'ldc_successor_distinct',
      successorVerifierHash: reuse === 'verifier_hash' ? inspected.record.local_device_credential.verifier_hash : 'a'.repeat(64),
      successorExpiresAt: new Date(now.getTime() + 120_000).toISOString(), rotationRequestDigest: `v1.reuse-${reuse}`,
    } as never);
    expect(result).toEqual({ status: 'denied' });
    expect(result).not.toHaveProperty('connectorCredential');
    expect(fixture.cas.updateAttempts).toBe(attempts);
  }
});

test('consumed challenge cannot be resurrected after later challenge traffic', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const first = await auth.issueChallenge({ commandId: 'challenge-first', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  expect((await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(first, fixture.pair.privateKey) })).status).toBe('admitted');
  const second = await auth.issueChallenge({ commandId: 'challenge-second', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  expect((await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(second, fixture.pair.privateKey) })).status).toBe('admitted');
  if (first.status !== 'issued') throw new Error('first challenge missing');
  const attempts = fixture.cas.updateAttempts;
  const replay = await fixture.repository.execute({ kind: 'local_device_reauth_issue', commandId: 'challenge-first',
    brainId: 'brain-a', context, expectedCapabilitiesRevision: fixture.fence, credential: fixture.credential,
    credentialId: first.credentialId, proofChallengeId: first.proofChallengeId, purpose: first.purpose,
    expiresAt: first.expiresAt, rotationId: first.rotationId,
    ...('reauthSequence' in first ? { reauthSequence: first.reauthSequence } : {}),
  } as never);
  expect(replay).toEqual({ status: 'denied' });
  expect(fixture.cas.updateAttempts).toBe(attempts);
  expect(await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(first, fixture.pair.privateKey) })).toEqual({ status: 'close', reason: 'invalid_proof' });
  const current = await fixture.repository.inspect('brain-a');
  expect(current).toMatchObject({ disposition: 'current', record: { local_device_reauth: null, local_device_reauth_sequence: 2 } });
});

test('credential prepare and activation preserve the monotonic challenge sequence and cannot reopen the prior refresh proof', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const first = await auth.issueChallenge({ commandId: 'refresh-first', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  if (first.status !== 'issued') throw new Error('first refresh challenge missing');
  const prepared = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(first, fixture.pair.privateKey) });
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  const attempts = fixture.cas.updateAttempts;
  expect(await fixture.repository.execute({ kind: 'local_device_reauth_issue', commandId: 'refresh-first',
    brainId: 'brain-a', context, expectedCapabilitiesRevision: fixture.fence, credential: fixture.credential,
    credentialId: first.credentialId, proofChallengeId: first.proofChallengeId, purpose: first.purpose,
    expiresAt: first.expiresAt, rotationId: first.rotationId, reauthSequence: first.reauthSequence,
  } as never)).toEqual({ status: 'denied' });
  expect(fixture.cas.updateAttempts).toBe(attempts);
  expect(await auth.issueChallenge({ commandId: 'pending-cannot-open', brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' })).toEqual({ status: 'denied' });
  const priorStillCurrent = await auth.issueChallenge({ commandId: 'prior-still-current', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  expect((await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(priorStillCurrent, fixture.pair.privateKey) })).status).toBe('admitted');
  const activated = await activatePrepared(auth, fixture, prepared, 'activate-successor');
  expect(activated.challenge).toMatchObject({ reauthSequence: 3, credentialId: prepared.credentialId, rotationId: prepared.rotationId });
  expect(activated.result).toMatchObject({ status: 'refreshed', credentialId: prepared.credentialId });
  const second = await auth.issueChallenge({ commandId: 'refresh-successor', brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  expect(second).toMatchObject({ status: 'issued', reauthSequence: 4, credentialId: prepared.credentialId });
  expect((await auth.authenticate({ brainId: 'brain-a', context, credential: prepared.connectorCredential,
    proof: proof(second, fixture.pair.privateKey) })).status).toBe('admitted');
  expect(await auth.issueChallenge({ commandId: 'stale-prior', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' })).toEqual({ status: 'denied' });
});

test('two activation instances have one winner; replay and the stale prior credential deny', async () => {
  const fixture = await enrolled();
  const options = { now: () => at('2026-08-21T12:00:10.000Z') };
  const authA = new RemoteLocalDeviceReauthenticationStore(fixture.repository, options);
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const refresh = await authA.issueChallenge({ commandId: 'activation-race-prepare', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  const prepared = await authA.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(refresh, fixture.pair.privateKey) });
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  const activation = await authA.issueChallenge({ commandId: 'activation-race-proof', brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_activate' });
  const signed = proof(activation, fixture.pair.privateKey);
  const authB = new RemoteLocalDeviceReauthenticationStore(new BrainAuthorizationAuthorityRepository(fixture.cas.client(), { now: options.now }), options);
  const results = await Promise.all([
    authA.authenticate({ brainId: 'brain-a', context, credential: prepared.connectorCredential, proof: signed }),
    authB.authenticate({ brainId: 'brain-a', context, credential: prepared.connectorCredential, proof: signed }),
  ]);
  expect(results.filter((result) => result.status === 'refreshed')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'close')).toHaveLength(1);
  expect((await authA.authenticate({ brainId: 'brain-a', context, credential: prepared.connectorCredential, proof: signed })).status)
    .toBe('close');
  expect(await authA.issueChallenge({ commandId: 'activation-race-stale', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' })).toEqual({ status: 'denied' });
});

test('expired pending successor is replaceable by the still-current prior credential and plaintext is never durable', async () => {
  const fixture = await enrolled();
  let now = at('2026-08-21T12:00:10.000Z');
  fixture.setNow('2026-08-21T12:00:10.000Z');
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => now, credentialTtlMs: 60_000 });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const first = await auth.issueChallenge({ commandId: 'expiring-prepare', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  const prepared = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(first, fixture.pair.privateKey) });
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  expect(JSON.stringify([...fixture.cas.documents.values()])).not.toContain(prepared.connectorCredential);
  now = at('2026-08-21T12:01:10.000Z');
  fixture.setNow('2026-08-21T12:01:10.000Z');
  const attempts = fixture.cas.updateAttempts;
  expect(await auth.issueChallenge({ commandId: 'expired-activation', brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_activate' }))
    .toEqual({ status: 'denied' });
  expect(fixture.cas.updateAttempts).toBe(attempts);
  const replacement = await auth.issueChallenge({ commandId: 'replacement-prepare', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  expect(replacement).toMatchObject({ status: 'issued', purpose: 'credential_refresh' });
  expect(await fixture.repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: {
    local_device_credential_pending: null,
  } });
});

test('revocation clears a prepared successor and its verifier cannot activate', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const refresh = await auth.issueChallenge({ commandId: 'prepare-before-revoke', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  const prepared = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(refresh, fixture.pair.privateKey) });
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  const revoked = await fixture.repository.execute({ kind: 'local_device_revoke', commandId: 'revoke-pending', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: fixture.fence, revokedAt: '2026-08-21T12:00:11.000Z' });
  expect(revoked.status).toBe('applied');
  expect(await fixture.repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: {
    local_device_credential: null, local_device_credential_pending: null, local_device_reauth: null,
  } });
  expect(await auth.issueChallenge({ commandId: 'activate-revoked', brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_activate' }))
    .toEqual({ status: 'denied' });
});

test('uncertain refresh commit is indeterminate, never retries or discloses the successor', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await auth.issueChallenge({ commandId: 'challenge-uncertain', brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  fixture.cas.loseNextUpdate = true;
  const attempts = fixture.cas.updateAttempts;
  const result = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(challenge, fixture.pair.privateKey) });
  expect(result).toEqual({ status: 'close', reason: 'indeterminate' });
  expect(result).not.toHaveProperty('connectorCredential');
  expect(fixture.cas.updateAttempts).toBe(attempts + 1);
  expect(await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(challenge, fixture.pair.privateKey) })).toEqual({ status: 'close', reason: 'invalid_proof' });
  expect(fixture.cas.updateAttempts).toBe(attempts + 1);
});

test('revocation clears credential and challenge; fence changes, revoked owners, malformed and unavailable authority close', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await auth.issueChallenge({ commandId: 'challenge-revoke', brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  const current = await fixture.repository.inspect('brain-a');
  if (current.disposition !== 'current') throw new Error('authority missing');
  const revoked = await fixture.repository.execute({ kind: 'local_device_revoke', commandId: 'revoke', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: current.fence.capabilitiesRevision, revokedAt: '2026-08-21T12:00:11.000Z' });
  expect(revoked.status).toBe('applied');
  expect(await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(challenge, fixture.pair.privateKey) })).toEqual({ status: 'close', reason: 'revoked' });
  expect(await fixture.repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: {
    local_device_credential: null, local_device_reauth: null, local_device_reauth_sequence: 1,
  } });

  const malformed = [...fixture.cas.documents.values()][0]!;
  malformed.data.local_device_reauth = { leaked: 'credential=do-not-log' };
  expect(await auth.issueChallenge({ commandId: 'malformed', brainId: 'brain-a', context, credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' })).toEqual({ status: 'denied' });
  fixture.cas.available = false;
  expect(await auth.issueChallenge({ commandId: 'unavailable', brainId: 'brain-a', context, credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' })).toEqual({ status: 'denied' });
});

test('a fence change invalidates a pending proof and owner credential revocation clears all device authentication state', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await auth.issueChallenge({ commandId: 'challenge-before-fence', brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  const policy = await fixture.repository.execute({ kind: 'policy_change', commandId: 'policy-change', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: fixture.fence });
  expect(policy.status).toBe('applied');
  expect(await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(challenge, fixture.pair.privateKey) }))
    .toEqual({ status: 'close', reason: 'fence_changed' });
  if (policy.status !== 'applied') throw new Error('policy transition failed');
  const revoked = await fixture.repository.execute({ kind: 'credential_revoke', commandId: 'credential-revoke', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: policy.fence.capabilitiesRevision });
  expect(revoked.status).toBe('applied');
  expect(await fixture.repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: { local_device_credential: null, local_device_reauth: null } });
});

test('rechecks revocation during activation and never restores the prior credential', async () => {
  const fixture = await enrolled();
  const initial = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const refresh = await initial.issueChallenge({ commandId: 'challenge-racing-revoke', brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  const prepared = await initial.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(refresh, fixture.pair.privateKey) });
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  const base = fixture.cas.client();
  const racingRepository = new BrainAuthorizationAuthorityRepository({
    ...base,
    updateDocument: async (collection, documentKey, body) => {
      const result = await base.updateDocument(collection, documentKey, body);
      if (result.ok && (body.data as Record<string, unknown>).last_command_kind === 'local_device_credential_activate') {
        const revoker = new BrainAuthorizationAuthorityRepository(base);
        await revoker.execute({ kind: 'local_device_revoke', commandId: 'racing-revoke', brainId: 'brain-a', context: owner,
          expectedCapabilitiesRevision: (result.document.data as Record<string, string>).capabilities_revision,
          revokedAt: '2026-08-21T12:00:11.000Z' });
      }
      return result;
    },
  }, { now: () => at('2026-08-21T12:00:10.000Z') });
  const auth = new RemoteLocalDeviceReauthenticationStore(racingRepository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const activation = await auth.issueChallenge({ commandId: 'activate-racing-revoke', brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_activate' });
  const result = await auth.authenticate({ brainId: 'brain-a', context, credential: prepared.connectorCredential, proof: proof(activation, fixture.pair.privateKey) });
  expect(result.status).toBe('close');
  expect(result).not.toHaveProperty('connectorCredential');
  expect(await fixture.repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: { local_device: { state: 'revoked' }, local_device_credential: null, local_device_credential_pending: null, local_device_reauth: null } });
});

test('an expiry crossing while the authority CAS is paused cannot prepare a successor credential', async () => {
  const fixture = await enrolled();
  const beforeExpiry = '2026-08-22T11:59:59.999Z';
  let now = at('2026-08-22T11:59:30.000Z');
  fixture.setNow(now.toISOString());
  const base = fixture.cas.client();
  let entered!: () => void;
  let release!: () => void;
  const enteredPrepare = new Promise<void>((resolve) => { entered = resolve; });
  const releasePrepare = new Promise<void>((resolve) => { release = resolve; });
  let observedDeadline: string | undefined;
  const racingRepository = new BrainAuthorizationAuthorityRepository({
    ...base,
    updateDocument: async (collection, documentKey, body) => {
      if ((body.data as Record<string, unknown>).last_command_kind !== 'local_device_credential_prepare') {
        return base.updateDocument(collection, documentKey, body);
      }
      observedDeadline = body.precondition?.server_time_before;
      entered();
      await releasePrepare;
      // This is the production server's atomic predicate result after its own
      // clock has passed the credential deadline. Do not call the memory CAS:
      // the assertion below proves no authority write occurred.
      return { ok: false as const, code: 'SERVER_TIME_PRECONDITION_FAILED' as const };
    },
  }, { now: () => now });
  const auth = new RemoteLocalDeviceReauthenticationStore(racingRepository, { now: () => now });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await auth.issueChallenge({ commandId: 'deadline-race', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  if (challenge.status !== 'issued') throw new Error('challenge missing');
  now = at(beforeExpiry);
  fixture.setNow(beforeExpiry);
  const before = await fixture.repository.inspect('brain-a');
  const pending = auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(challenge, fixture.pair.privateKey) });
  await enteredPrepare;
  release();
  expect(await pending).toEqual({ status: 'close', reason: 'invalid_proof' });
  expect(observedDeadline).toBe('2026-08-22T12:00:00.000Z');
  expect(await fixture.repository.inspect('brain-a')).toEqual(before);
});

test('converts a valid legacy durable credential expiry to the canonical server-time predicate', async () => {
  const fixture = await enrolled();
  const stored = [...fixture.cas.documents.values()][0]!;
  ((stored.data.local_device_credential as Record<string, unknown>).expires_at) = '2026-08-21T07:05:00-05:00';
  const base = fixture.cas.client();
  let observedDeadline: string | undefined;
  const repository = new BrainAuthorizationAuthorityRepository({
    ...base,
    updateDocument: async (collection, documentKey, body) => {
      observedDeadline = body.precondition?.server_time_before;
      return base.updateDocument(collection, documentKey, body);
    },
  }, { now: () => at('2026-08-21T12:00:10.000Z') });
  const auth = new RemoteLocalDeviceReauthenticationStore(repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const issued = await auth.issueChallenge({ commandId: 'legacy-deadline', brainId: 'brain-a',
    context: { kind: 'local_device_connector', deviceId: fixture.deviceId }, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  expect(issued.status).toBe('issued');
  expect(observedDeadline).toBe('2026-08-21T12:05:00.000Z');
});

test('activation uses the pending credential deadline after the prior credential expires', async () => {
  const fixture = await enrolled();
  let now = at('2026-08-21T12:00:10.000Z');
  fixture.setNow(now.toISOString());
  const initial = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => now, credentialTtlMs: 60 * 60_000 });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const refresh = await initial.issueChallenge({ commandId: 'prepare-before-prior-expiry', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  if (refresh.status !== 'issued') throw new Error('refresh challenge missing');
  const prepared = await initial.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(refresh, fixture.pair.privateKey) });
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  now = at('2026-08-21T12:05:00.000Z');
  fixture.setNow(now.toISOString());
  const base = fixture.cas.client();
  const observedDeadlines: string[] = [];
  const repository = new BrainAuthorizationAuthorityRepository({
    ...base,
    updateDocument: async (collection, documentKey, body) => {
      if ((body.data as Record<string, unknown>).last_command_kind === 'local_device_reauth_issue'
        || (body.data as Record<string, unknown>).last_command_kind === 'local_device_credential_activate') {
        observedDeadlines.push(body.precondition?.server_time_before ?? 'missing');
      }
      return base.updateDocument(collection, documentKey, body);
    },
  }, { now: () => now });
  const activation = new RemoteLocalDeviceReauthenticationStore(repository, { now: () => now });
  const challenge = await activation.issueChallenge({ commandId: 'activate-after-prior-expiry', brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_activate' });
  if (challenge.status !== 'issued') throw new Error('activation challenge missing');
  expect((await activation.authenticate({ brainId: 'brain-a', context, credential: prepared.connectorCredential,
    proof: proof(challenge, fixture.pair.privateKey) })).status).toBe('refreshed');
  expect(observedDeadlines).toEqual([prepared.expiresAt, prepared.expiresAt]);
});

test('an expiry crossing while activation CAS is paused cannot install the pending credential', async () => {
  const fixture = await enrolled();
  let now = at('2026-08-21T12:00:10.000Z');
  fixture.setNow(now.toISOString());
  const initial = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => now, credentialTtlMs: 60 * 60_000 });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const refresh = await initial.issueChallenge({ commandId: 'prepare-before-pending-expiry', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  if (refresh.status !== 'issued') throw new Error('refresh challenge missing');
  const prepared = await initial.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(refresh, fixture.pair.privateKey) });
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  now = new Date(Date.parse(prepared.expiresAt) - 1_000);
  fixture.setNow(now.toISOString());
  const base = fixture.cas.client();
  let storageNow = now.getTime();
  let entered!: () => void;
  let release!: () => void;
  const enteredActivation = new Promise<void>((resolve) => { entered = resolve; });
  const releaseActivation = new Promise<void>((resolve) => { release = resolve; });
  let observedDeadline: string | undefined;
  const repository = new BrainAuthorizationAuthorityRepository({
    ...base,
    updateDocument: async (collection, documentKey, body) => {
      if ((body.data as Record<string, unknown>).last_command_kind !== 'local_device_credential_activate') {
        return base.updateDocument(collection, documentKey, body);
      }
      observedDeadline = body.precondition?.server_time_before;
      entered();
      await releaseActivation;
      return Date.parse(body.precondition?.server_time_before ?? '') <= storageNow
        ? { ok: false as const, code: 'SERVER_TIME_PRECONDITION_FAILED' as const }
        : base.updateDocument(collection, documentKey, body);
    },
  }, { now: () => now });
  const activation = new RemoteLocalDeviceReauthenticationStore(repository, { now: () => now, challengeTtlMs: 1_000 });
  const challenge = await activation.issueChallenge({ commandId: 'activate-pending-deadline-race', brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_activate' });
  if (challenge.status !== 'issued') throw new Error('activation challenge missing');
  const before = await fixture.repository.inspect('brain-a');
  const pending = activation.authenticate({ brainId: 'brain-a', context, credential: prepared.connectorCredential,
    proof: proof(challenge, fixture.pair.privateKey) });
  await enteredActivation;
  storageNow = Date.parse(prepared.expiresAt);
  release();
  expect(await pending).toEqual({ status: 'close', reason: 'invalid_proof' });
  expect(observedDeadline).toBe(prepared.expiresAt);
  expect(await fixture.repository.inspect('brain-a')).toEqual(before);
});

test('TTL configuration is bounded and durable/result state excludes plaintext, signatures, URLs, and topology', async () => {
  const fixture = await enrolled();
  expect(() => new RemoteLocalDeviceReauthenticationStore(fixture.repository, { challengeTtlMs: 999_999_999 })).toThrow();
  expect(() => new RemoteLocalDeviceReauthenticationStore(fixture.repository, { credentialTtlMs: 999_999_999 })).toThrow();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const issued = await auth.issueChallenge({ commandId: 'privacy', brainId: 'brain-a', context, credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  const serialized = JSON.stringify([...fixture.cas.documents.values()]);
  expect(serialized).not.toContain(fixture.credential);
  for (const forbidden of ['signature', 'private_key', 'connectorcredential', 'url', 'endpoint', 'host_name', 'port']) expect(serialized.toLowerCase()).not.toContain(forbidden);
  expect(JSON.stringify(issued)).not.toContain(fixture.credential);
});

test('connector context cannot act as owner, owner context cannot forge a device command, and rotated shapes are exact', async () => {
  const fixture = await enrolled();
  const inspected = await fixture.repository.inspect('brain-a');
  if (inspected.disposition !== 'current' || !inspected.record.local_device_credential) throw new Error('credential missing');
  const credentialId = inspected.record.local_device_credential.credential_id;
  expect(await fixture.repository.execute({ kind: 'policy_change', commandId: 'device-as-owner', brainId: 'brain-a',
    context: { kind: 'local_device_connector', deviceId: fixture.deviceId }, expectedCapabilitiesRevision: fixture.fence } as never)).toEqual({ status: 'denied' });
  expect(await fixture.repository.execute({ kind: 'local_device_reauth_issue', commandId: 'owner-as-device', brainId: 'brain-a',
    context: owner, expectedCapabilitiesRevision: fixture.fence, credentialId, proofChallengeId: 'pop_ABCDEFGHIJKLMNOPQRSTUVWX',
    purpose: 'socket_open', expiresAt: '2026-08-21T12:00:30.000Z', rotationId: 'rot_ABCDEFGHIJKLMNOPQRSTUVWX' } as never)).toEqual({ status: 'denied' });

  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await auth.issueChallenge({ commandId: 'exact-shape', brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  const prepared = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: proof(challenge, fixture.pair.privateKey) });
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  expect((await activatePrepared(auth, fixture, prepared, 'exact-shape-activate')).result.status).toBe('refreshed');
  const document = [...fixture.cas.documents.values()][0]!;
  const original = structuredClone(document.data.local_device_credential);
  document.data.local_device_credential.unexpected = null;
  expect(await fixture.repository.inspect('brain-a')).toEqual({ disposition: 'invalid' });
  document.data.local_device_credential = original;
  delete document.data.local_device_credential.rotation_id;
  expect(await fixture.repository.inspect('brain-a')).toEqual({ disposition: 'invalid' });
});

test('the exported repository has no runtime raw-transition hook and generic execute denies authority-owned commands', async () => {
  const fixture = await enrolled();
  const exposed = fixture.repository as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(fixture.repository) as Record<string, unknown>;
  expect(exposed.executeCommand).toBeUndefined();
  expect(Reflect.get(exposed, 'executeCommand')).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(prototype, 'executeCommand')).toBeFalse();
  expect(Reflect.ownKeys(exposed)).not.toContain('executeCommand');
  expect(Reflect.ownKeys(prototype)).not.toContain('executeCommand');
  for (const forbidden of ['prepareLocalDeviceCredential', 'activateLocalDeviceCredential']) {
    expect(Reflect.get(exposed, forbidden)).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(prototype, forbidden)).toBeFalse();
    expect(Reflect.ownKeys(exposed)).not.toContain(forbidden);
    expect(Reflect.ownKeys(prototype)).not.toContain(forbidden);
  }
  const inspected = await fixture.repository.inspect('brain-a');
  if (inspected.disposition !== 'current' || !inspected.record.local_device_credential) throw new Error('credential missing');
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const rawIssue = {
    kind: 'local_device_reauth_issue', commandId: 'raw-issue', brainId: 'brain-a', context,
    expectedCapabilitiesRevision: fixture.fence, credentialId: inspected.record.local_device_credential.credential_id,
    credential: fixture.credential, reauthSequence: 1,
    proofChallengeId: 'pop_1_AttackerSelectedNonce1234', purpose: 'credential_refresh',
    expiresAt: '2026-08-21T12:00:30.000Z', rotationId: 'rot_1_AttackerSelectedNonce1234',
  } as const;
  const attempts = fixture.cas.updateAttempts;
  expect(await fixture.repository.execute(rawIssue as never)).toEqual({ status: 'denied' });
  expect(await fixture.repository.execute({ ...rawIssue, kind: 'local_device_credential_prepare', commandId: 'raw-prepare',
    signature: 'A'.repeat(86),
    successorCredentialId: 'ldc_ABCDEFGHIJKLMNOPQRSTUVWX', successorVerifierHash: 'a'.repeat(64),
    successorExpiresAt: '2026-08-21T12:02:00.000Z', rotationRequestDigest: 'v1.attacker-selected',
  } as never)).toEqual({ status: 'denied' });
  expect(fixture.cas.updateAttempts).toBe(attempts);

  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const issued = await auth.issueChallenge({ commandId: 'repository-minted', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  expect(issued).toMatchObject({ status: 'issued', reauthSequence: 1 });
  if (issued.status !== 'issued') throw new Error('repository challenge missing');
  expect(issued.proofChallengeId).toMatch(/^pop_1_[A-Za-z0-9_-]{24}$/);
  expect(issued.rotationId).toMatch(/^rot_1_[A-Za-z0-9_-]{24}$/);
  expect(issued.proofChallengeId).not.toBe(rawIssue.proofChallengeId);
  expect(issued.rotationId).not.toBe(rawIssue.rotationId);
  expect(await fixture.repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: {
    local_device_reauth: { proof_challenge_id: issued.proofChallengeId, rotation_id: issued.rotationId },
  } });
});

test('fully shaped generic prepare and activation attacks perform no CAS and cannot disclose a successor', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const refresh = await auth.issueChallenge({ commandId: 'generic-prepare-proof', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  if (refresh.status !== 'issued') throw new Error('refresh challenge missing');
  const signedRefresh = proof(refresh, fixture.pair.privateKey);
  const attackerCredential = `ldc1_${'A'.repeat(43)}`;
  const prepareAttempts = fixture.cas.updateAttempts;
  const prepareAttack = await fixture.repository.execute({ kind: 'local_device_credential_prepare', commandId: `prepare:${refresh.rotationId}`,
    brainId: 'brain-a', context, expectedCapabilitiesRevision: fixture.fence, credential: fixture.credential,
    credentialId: signedRefresh.credentialId, proofChallengeId: signedRefresh.proofChallengeId, purpose: 'credential_refresh',
    expiresAt: signedRefresh.expiresAt, rotationId: signedRefresh.rotationId, reauthSequence: refresh.reauthSequence,
    signature: signedRefresh.signature, successorCredentialId: 'ldc_AttackerChosenSuccessor1234',
    successorVerifierHash: createHash('sha256').update(attackerCredential).digest('hex'),
    successorExpiresAt: '2026-08-21T12:02:10.000Z', rotationRequestDigest: 'v1.attacker-chosen-successor',
  } as never);
  expect(prepareAttack).toEqual({ status: 'denied' });
  expect(prepareAttack).not.toHaveProperty('connectorCredential');
  expect(fixture.cas.updateAttempts).toBe(prepareAttempts);

  const prepared = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: signedRefresh });
  if (prepared.status !== 'prepared') throw new Error('trusted prepare failed');
  const activation = await auth.issueChallenge({ commandId: 'generic-activation-proof', brainId: 'brain-a', context,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_activate' });
  if (activation.status !== 'issued') throw new Error('activation challenge missing');
  const signedActivation = proof(activation, fixture.pair.privateKey);
  const activateAttempts = fixture.cas.updateAttempts;
  const activateAttack = await fixture.repository.execute({ kind: 'local_device_credential_activate', commandId: `activate:${activation.rotationId}`,
    brainId: 'brain-a', context, expectedCapabilitiesRevision: fixture.fence, credential: prepared.connectorCredential,
    credentialId: signedActivation.credentialId, proofChallengeId: signedActivation.proofChallengeId, purpose: 'credential_activate',
    expiresAt: signedActivation.expiresAt, rotationId: signedActivation.rotationId, reauthSequence: activation.reauthSequence,
    signature: signedActivation.signature,
  } as never);
  expect(activateAttack).toEqual({ status: 'denied' });
  expect(activateAttack).not.toHaveProperty('connectorCredential');
  expect(fixture.cas.updateAttempts).toBe(activateAttempts);
  expect((await auth.authenticate({ brainId: 'brain-a', context, credential: prepared.connectorCredential,
    proof: signedActivation })).status).toBe('refreshed');
});

test('repository-minted issuance reconciles one lost response but never remints or rediscloses on retry', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const input = { commandId: 'lost-issue-response', brainId: 'brain-a', context, credential: fixture.credential,
    expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' as const };
  fixture.cas.loseNextUpdate = true;
  const attempts = fixture.cas.updateAttempts;
  const first = await auth.issueChallenge(input);
  expect(first).toMatchObject({ status: 'issued', reauthSequence: 1 });
  if (first.status !== 'issued') throw new Error('reconciled challenge missing');
  expect(fixture.cas.updateAttempts).toBe(attempts + 1);
  const durableBeforeRetry = structuredClone([...fixture.cas.documents.values()]);
  expect(await auth.issueChallenge(input)).toEqual({ status: 'denied' });
  expect(fixture.cas.updateAttempts).toBe(attempts + 1);
  expect([...fixture.cas.documents.values()]).toEqual(durableBeforeRetry);
  expect(await fixture.repository.inspect('brain-a')).toMatchObject({ disposition: 'current', record: {
    local_device_reauth: { proof_challenge_id: first.proofChallengeId, rotation_id: first.rotationId },
  } });
});

test('repository transition clock denies a proof that expires after facade precheck but before durable consume', async () => {
  const fixture = await enrolled();
  let now = at('2026-08-21T12:00:10.000Z');
  const base = fixture.cas.client();
  let reads = 0;
  let delayTransition = false;
  const repository = new BrainAuthorizationAuthorityRepository({
    ...base,
    getDocument: async (collection, key) => {
      const result = await base.getDocument(collection, key);
      reads += 1;
      if (delayTransition && reads === 2) now = at('2026-08-21T12:00:40.000Z');
      return result;
    },
  }, { now: () => now });
  const auth = new RemoteLocalDeviceReauthenticationStore(repository, { now: () => now });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await auth.issueChallenge({ commandId: 'delayed-consume', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  if (challenge.status !== 'issued') throw new Error('challenge missing');
  delayTransition = true;
  reads = 0;
  const attempts = fixture.cas.updateAttempts;
  const result = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
    proof: proof(challenge, fixture.pair.privateKey) });
  expect(result).toEqual({ status: 'close', reason: 'invalid_proof' });
  expect(fixture.cas.updateAttempts).toBe(attempts);
});

test('repository transition clock also denies refresh at the exact credential and challenge expiry boundaries', async () => {
  for (const boundary of ['credential', 'challenge'] as const) {
    const fixture = await enrolled();
    let repositoryNow = at('2026-08-21T12:00:09.000Z');
    const facadeNow = () => at('2026-08-21T12:00:09.000Z');
    const base = fixture.cas.client();
    let reads = 0;
    let delayTransition = false;
    const repository = new BrainAuthorizationAuthorityRepository({
      ...base,
      getDocument: async (collection, key) => {
        const result = await base.getDocument(collection, key);
        reads += 1;
        if (delayTransition && reads === 2) repositoryNow = boundary === 'challenge'
          ? at('2026-08-21T12:00:39.000Z') : at('2026-08-21T12:00:10.000Z');
        return result;
      },
    }, { now: () => repositoryNow });
    const auth = new RemoteLocalDeviceReauthenticationStore(repository, { now: facadeNow });
    const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
    const challenge = await auth.issueChallenge({ commandId: `delayed-refresh-${boundary}`, brainId: 'brain-a', context,
      credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
    if (challenge.status !== 'issued') throw new Error('challenge missing');
    if (boundary === 'credential') {
      const document = [...fixture.cas.documents.values()][0]!;
      document.data.local_device_credential.expires_at = '2026-08-21T12:00:10.000Z';
    }
    delayTransition = true;
    reads = 0;
    const attempts = fixture.cas.updateAttempts;
    expect((await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential,
      proof: proof(challenge, fixture.pair.privateKey) })).status).toBe('close');
    expect(fixture.cas.updateAttempts).toBe(attempts);
  }
});

test('repository enforces successor TTL maximum and permits the exact configured maximum', async () => {
  const fixture = await enrolled();
  const now = at('2026-08-21T12:00:10.000Z');
  fixture.setNow('2026-08-21T12:00:10.000Z');
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => now, credentialTtlMs: 60 * 60_000 });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await auth.issueChallenge({ commandId: 'successor-bound', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'credential_refresh' });
  if (challenge.status !== 'issued') throw new Error('challenge missing');
  const signed = proof(challenge, fixture.pair.privateKey);
  const attempts = fixture.cas.updateAttempts;
  expect(await fixture.repository.advanceLocalDeviceCredentialRotation({ phase: 'prepare', commandId: 'oversized-successor',
    brainId: 'brain-a', context, expectedCapabilitiesRevision: fixture.fence, credential: fixture.credential,
    credentialId: signed.credentialId, proofChallengeId: signed.proofChallengeId, purpose: 'credential_refresh',
    expiresAt: signed.expiresAt, rotationId: signed.rotationId, reauthSequence: challenge.reauthSequence, signature: signed.signature,
    successorExpiresAt: new Date(now.getTime() + 60 * 60_000 + 1).toISOString(),
  })).toEqual({ status: 'denied' });
  expect(fixture.cas.updateAttempts).toBe(attempts);
  const prepared = await auth.authenticate({ brainId: 'brain-a', context, credential: fixture.credential, proof: signed });
  expect(prepared).toMatchObject({ status: 'prepared', expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString() });
});

test('repository clock and expiry bounds fail closed at exact boundaries and on invalid clocks', async () => {
  const fixture = await enrolled();
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  for (const now of [() => new Date(Number.NaN), () => { throw new Error('clock failed'); }]) {
    const repository = new BrainAuthorizationAuthorityRepository(fixture.cas.client(), { now });
    const auth = new RemoteLocalDeviceReauthenticationStore(repository, { now: () => at('2026-08-21T12:00:10.000Z') });
    const attempts = fixture.cas.updateAttempts;
    expect(await auth.issueChallenge({ commandId: `bad-clock-${attempts}`, brainId: 'brain-a', context,
      credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' })).toEqual({ status: 'denied' });
    expect(fixture.cas.updateAttempts).toBe(attempts);
  }
});

test('authenticate rejects credentials over 256 UTF-8 bytes before any durable proof consumption', async () => {
  const fixture = await enrolled();
  const auth = new RemoteLocalDeviceReauthenticationStore(fixture.repository, { now: () => at('2026-08-21T12:00:10.000Z') });
  const context = { kind: 'local_device_connector' as const, deviceId: fixture.deviceId };
  const challenge = await auth.issueChallenge({ commandId: 'oversized-proof', brainId: 'brain-a', context,
    credential: fixture.credential, expectedCapabilitiesRevision: fixture.fence, purpose: 'socket_open' });
  if (challenge.status !== 'issued') throw new Error('challenge missing');
  const oversized = '🪐'.repeat(100);
  expect(oversized.length).toBeLessThanOrEqual(256);
  expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(256);
  const document = [...fixture.cas.documents.values()][0]!;
  document.data.local_device_credential.verifier_hash = createHash('sha256').update(oversized).digest('hex');
  const attempts = fixture.cas.updateAttempts;
  expect(await auth.authenticate({ brainId: 'brain-a', context, credential: oversized,
    proof: proof(challenge, fixture.pair.privateKey) })).toEqual({ status: 'close', reason: 'invalid_proof' });
  expect(fixture.cas.updateAttempts).toBe(attempts);
});
