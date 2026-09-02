import { expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';
import { RemoteLocalDeviceEnrollmentStore } from '../lib/remote-local-device-enrollment';
import { RemoteLocalDeviceReauthenticationStore } from '../lib/remote-local-device-reauthentication';
import { canonicalDeviceReauthProofPayload } from '../lib/remote-local-relay-protocol';
import { RemoteLocalSessionAdmission, inspectRemoteLocalDeviceAuthority } from '../lib/remote-local-session-admission';
import { MemoryAuthorityCas } from './helpers/memory-authority-cas';

const context = { kind: 'local_device_connector' as const, deviceId: 'device-a' };
function fixture(overrides: Partial<ConstructorParameters<typeof RemoteLocalSessionAdmission>[0]> = {}) {
  let enabled = true;
  let active = true;
  let fence = 'fence-a';
  let sessionSequence = 0;
  const calls: string[] = [];
  const dependencies = {
    reauthenticate: { authenticate: async (input: { proof: unknown }) => {
      if (input.proof === 'refresh') return { status: 'prepared' as const, fence, deviceId: 'device-a', connectorCredential: 'ldc1_secret', credentialId: 'credential-b', priorCredentialId: 'credential-a', expiresAt: '2026-08-22T12:01:00.000Z', rotationId: 'rotation-b' };
      if (input.proof === 'activate') return { status: 'refreshed' as const, fence, deviceId: 'device-a', credentialId: 'credential-b', priorCredentialId: 'credential-a', expiresAt: '2026-08-22T12:01:00.000Z', rotationId: 'rotation-b' };
      return { status: 'admitted' as const, fence, deviceId: 'device-a' };
    } },
    inspectAuthority: async () => ({ disposition: 'current' as const, fence, deviceId: 'device-a', active }),
    feature: { snapshot: async () => ({ enabled, revision: 'config-a' }) },
    mintSessionId: () => `rsh_${String(sessionSequence += 1).padStart(16, 'a')}`,
    ...overrides,
  };
  // Most seam tests do not care about credential lifetime. Keep their fixture
  // responses production-shaped while tests that exercise expiry can supply an
  // exact boundary themselves.
  const configuredReauthenticate = dependencies.reauthenticate;
  dependencies.reauthenticate = { authenticate: async (input: { proof: unknown }) => {
    const result = await configuredReauthenticate.authenticate(input as never) as Record<string, unknown>;
    return result.status === 'close' || typeof result.credentialExpiresAt === 'string'
      ? result : { ...result, credentialExpiresAt: '2099-01-01T00:00:00.000Z' };
  } } as never;
  const admission = new RemoteLocalSessionAdmission(dependencies);
  const transport = { close: async (reason: { code: string }) => { calls.push(reason.code); } };
  return { admission, transport, calls, setEnabled: (value: boolean) => { enabled = value; }, setActive: (value: boolean) => { active = value; }, setFence: (value: string) => { fence = value; } };
}

async function open(f: ReturnType<typeof fixture>) {
  const result = await f.admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: f.transport });
  if (result.status !== 'admitted') throw new Error(`open failed: ${result.code}`);
  return result.sessionId;
}

async function realDeviceFixture() {
  const cas = new MemoryAuthorityCas();
  const repository = new BrainAuthorizationAuthorityRepository(cas.client(), { now: () => new Date('2026-08-22T12:00:10.000Z') });
  const owner = { kind: 'authenticated_external_owner' as const, principalId: 'owner-a' };
  const boot = await repository.execute({ kind: 'bootstrap', commandId: 'real-boot', brainId: 'brain-a', context: owner,
    ownerPrincipalId: 'owner-a', targetId: 'target-a', hostId: 'host-a', deploymentGeneration: 1, adapterIdentity: 'adapter-a', adapterVersion: '1' });
  if (boot.status !== 'applied') throw new Error('real bootstrap failed');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const enrollment = new RemoteLocalDeviceEnrollmentStore(repository, { now: () => new Date('2026-08-22T12:00:00.000Z') });
  const started = await enrollment.start({ commandId: 'real-start', brainId: 'brain-a', context: owner,
    expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey, enrolledByCredentialId: 'owner-credential' });
  if (started.status !== 'pending') throw new Error('real enrollment start failed');
  const completed = await enrollment.complete({ commandId: 'real-complete', brainId: 'brain-a',
    context: { kind: 'local_device_enrollment_daemon', deviceId: started.deviceId }, enrollmentId: started.enrollmentId,
    enrollmentSecret: started.enrollmentSecret,
    signature: sign(null, Buffer.from(started.challenge), pair.privateKey).toString('base64url') });
  if (completed.status !== 'applied') throw new Error('real enrollment completion failed');
  const reauth = new RemoteLocalDeviceReauthenticationStore(repository, { now: () => new Date('2026-08-22T12:00:10.000Z') });
  const connector = { kind: 'local_device_connector' as const, deviceId: completed.record.deviceId };
  const signedProof = (challenge: Awaited<ReturnType<typeof reauth.issueChallenge>>) => {
    if (challenge.status !== 'issued') throw new Error('real challenge failed');
    const body = { fence: { brainId: challenge.brainId, deviceId: challenge.deviceId, authorityRevision: challenge.authorityRevision },
      credentialId: challenge.credentialId, proofChallengeId: challenge.proofChallengeId, purpose: challenge.purpose,
      expiresAt: challenge.expiresAt, rotationId: challenge.rotationId };
    return { ...body, signatureAlgorithm: 'ed25519' as const,
      signature: sign(null, Buffer.from(canonicalDeviceReauthProofPayload(body)), pair.privateKey).toString('base64url') };
  };
  return { repository, reauth, connector, credential: completed.connectorCredential, fence: completed.fence.capabilitiesRevision, signedProof };
}

test('session admission is default-deny before it creates registry state', async () => {
  let minted = 0;
  const admission = new RemoteLocalSessionAdmission({
    reauthenticate: { authenticate: async () => ({ status: 'admitted', fence: 'fence-a', deviceId: 'device-a' }) },
    inspectAuthority: async () => ({ disposition: 'current', fence: 'fence-a', deviceId: 'device-a' }),
    feature: { snapshot: async () => ({ enabled: false, revision: 'config-a' }) },
    mintSessionId: () => { minted += 1; return 'rsh_aaaaaaaaaaaaaaaa'; },
  });
  const closed: string[] = [];
  const result = await admission.open({ brainId: 'brain-a', context: { kind: 'local_device_connector', deviceId: 'device-a' }, credential: 'credential', proof: {} as never,
    transport: { close: async (reason) => { closed.push(reason.code); } } });
  expect(result).toEqual({ status: 'closed', code: 'feature_disabled' });
  expect(closed).toEqual(['feature_disabled']);
  expect(minted).toBe(0);
  expect(admission.size()).toBe(0);
});

test('open snapshots the exact admission context and proof before feature awaits', async () => {
  let releaseFeature!: () => void;
  const featureGate = new Promise<void>((resolve) => { releaseFeature = resolve; });
  let seen: { deviceId: string; proof: unknown } | undefined;
  const admission = new RemoteLocalSessionAdmission({
    feature: { snapshot: async () => { await featureGate; return { enabled: true, revision: 'config-a' }; } },
    reauthenticate: { authenticate: async (input) => {
      seen = { deviceId: input.context.deviceId, proof: input.proof };
      return { status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a', credentialExpiresAt: '2099-01-01T00:00:00.000Z' };
    } },
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
  });
  const mutableContext = { kind: 'local_device_connector' as const, deviceId: 'device-a' };
  const input = { brainId: 'brain-a', context: mutableContext, credential: 'credential-a', proof: 'proof-a', transport: { close: async () => {} } };
  const opened = admission.open(input);
  await Promise.resolve();
  mutableContext.deviceId = 'device-b';
  input.proof = 'proof-b';
  releaseFeature();
  expect(await opened).toMatchObject({ status: 'admitted' });
  expect(seen).toEqual({ deviceId: 'device-a', proof: 'proof-a' });
});

test('aggregate proof budgets fail closed before feature, limiter, or PoP work', async () => {
  // Every leaf is individually valid, but together they exceed the 16KiB
  // snapshot budget that protects the pre-throttle transport boundary.
  const oversizedProof = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`leaf${index}`, 'x'.repeat(4_096)]));
  let features = 0;
  let proofs = 0;
  const f = fixture({
    feature: { snapshot: async () => { features += 1; return { enabled: true, revision: 'config-a' }; } },
    reauthenticate: { authenticate: async () => { proofs += 1; return { status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a', credentialExpiresAt: '2099-01-01T00:00:00.000Z' }; } },
  });
  expect(await f.admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: oversizedProof, transport: f.transport } as never))
    .toEqual({ status: 'closed', code: 'fence_changed' });
  expect({ features, proofs }).toEqual({ features: 0, proofs: 0 });
  expect(f.admission.size()).toBe(0);

  const live = fixture();
  const id = await open(live);
  expect(await live.admission.refresh(id, { credential: 'credential-a', proof: oversizedProof } as never))
    .toEqual({ status: 'closed', code: 'invalid_proof' });
  expect(live.calls).toEqual(['invalid_proof']);
  expect(live.admission.size()).toBe(0);
});

test('open rejects malformed or accessor-hostile minted session handles before dependencies or registry mutation', async () => {
  const hostile = Object.create(null, {
    toString: { enumerable: true, get() { throw new Error('must not coerce minted handle'); } },
    valueOf: { enumerable: true, get() { throw new Error('must not coerce minted handle'); } },
  });
  const invalid = [
    undefined,
    1,
    'rsh_too-short',
    `rsh_${'a'.repeat(129)}`,
    'rsh_aaaaaaaaaaaaaaaa\n',
    'opaque-session-a',
    hostile,
  ];

  for (let minted of invalid) {
    let features = 0;
    let proofs = 0;
    let inspections = 0;
    const f = fixture({
      mintSessionId: () => minted as never,
      feature: { snapshot: async () => { features += 1; return { enabled: true, revision: 'config-a' }; } },
      reauthenticate: { authenticate: async () => { proofs += 1; return { status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a' }; } },
      inspectAuthority: async () => { inspections += 1; return { disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }; },
      attemptLimit: { maxAttempts: 1, windowMs: 1_000, maxKeys: 1 },
    });
    const result = await f.admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: f.transport });
    expect(result).toEqual({ status: 'closed', code: 'unavailable' });
    expect(f.calls).toEqual(['unavailable']);
    expect(f.admission.size()).toBe(0);
    // Feature/default-off is sampled before minting; invalid handles then stop
    // before limiter, PoP, authority inspection, or registry mutation.
    expect({ features, proofs, inspections }).toEqual({ features: 1, proofs: 0, inspections: 0 });
    expect(JSON.stringify(result)).not.toContain('credential-a');
    // Invalid minting does not spend the bounded admission attempt either.
    minted = 'rsh_bbbbbbbbbbbbbbbb';
    expect((await f.admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: { close: async () => {} } })).status).toBe('admitted');
  }
});

test('open rejects a duplicate minted handle before dependencies and does not affect its existing session', async () => {
  let features = 0;
  let proofs = 0;
  let inspections = 0;
  const admission = new RemoteLocalSessionAdmission({
    mintSessionId: () => 'rsh_aaaaaaaaaaaaaaaa',
    feature: { snapshot: async () => { features += 1; return { enabled: true, revision: 'config-a' }; } },
    reauthenticate: { authenticate: async () => { proofs += 1; return { status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a', credentialExpiresAt: '2099-01-01T00:00:00.000Z' }; } },
    inspectAuthority: async () => { inspections += 1; return { disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }; },
  });
  const firstClosed: string[] = [];
  const first = await admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: { close: async ({ code }) => { firstClosed.push(code); } } });
  if (first.status !== 'admitted') throw new Error('first session did not admit');
  const before = { features, proofs, inspections };
  const duplicateClosed: string[] = [];
  await expect(admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: { close: async ({ code }) => { duplicateClosed.push(code); } } }))
    .resolves.toEqual({ status: 'closed', code: 'unavailable' });
  expect({ features, proofs, inspections }).toEqual({ ...before, features: before.features + 1 });
  expect(admission.size()).toBe(1);
  expect(firstClosed).toEqual([]);
  expect(duplicateClosed).toEqual(['unavailable']);
  expect(await admission.heartbeat(first.sessionId)).toEqual({ status: 'live' });
});

test('same minted handle reserves one asynchronous admission and retires permanently on close', async () => {
  let releaseAuthentication!: () => void;
  const authentication = new Promise<void>((resolve) => { releaseAuthentication = resolve; });
  let proofs = 0;
  const closed: string[] = [];
  const admission = new RemoteLocalSessionAdmission({
    mintSessionId: () => 'rsh_aaaaaaaaaaaaaaaa',
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
    reauthenticate: { authenticate: async () => {
      proofs += 1;
      await authentication;
      return { status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a', credentialExpiresAt: '2099-01-01T00:00:00.000Z' };
    } },
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
  });
  const input = (transport: { close(reason: { code: string }): void | Promise<void> }) => ({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport });
  const first = admission.open(input({ close: async () => {} }));
  await Promise.resolve();
  const second = await admission.open(input({ close: async ({ code }) => { closed.push(code); } }));
  expect(second).toEqual({ status: 'closed', code: 'unavailable' });
  expect(closed).toEqual(['unavailable']);
  expect(proofs).toBe(1);
  releaseAuthentication();
  const admitted = await first;
  if (admitted.status !== 'admitted') throw new Error('reserved admission did not complete');
  expect(admission.size()).toBe(1);
  await admission.revoke(admitted.sessionId);
  expect(await admission.open(input({ close: async ({ code }) => { closed.push(code); } }))).toEqual({ status: 'closed', code: 'unavailable' });
  expect(proofs).toBe(1);
  expect(admission.size()).toBe(0);
});

test('every live action rechecks feature, durable device state, and exact fence; command claiming never dispatches', async () => {
  const f = fixture();
  const sessionId = await open(f);
  expect(await f.admission.heartbeat(sessionId)).toEqual({ status: 'live' });
  f.setEnabled(false);
  expect(await f.admission.claimCommand(sessionId)).toEqual({ status: 'closed', code: 'feature_disabled' });
  expect(f.calls).toEqual(['feature_disabled']);
  expect(f.admission.size()).toBe(0);

  const revoked = fixture();
  const revokedId = await open(revoked);
  revoked.setActive(false);
  expect(await revoked.admission.heartbeat(revokedId)).toEqual({ status: 'closed', code: 'revoked' });

  const stale = fixture();
  const staleId = await open(stale);
  stale.setFence('fence-b');
  expect(await stale.admission.claimCommand(staleId)).toEqual({ status: 'closed', code: 'fence_changed' });

  let malformedInspection = false;
  const malformed = fixture({ inspectAuthority: async () => malformedInspection
    ? ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a' } as never)
    : ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }) });
  const malformedId = await open(malformed);
  malformedInspection = true;
  expect(await malformed.admission.claimCommand(malformedId)).toEqual({ status: 'closed', code: 'fence_changed' });
  expect(malformed.admission.size()).toBe(0);
});

test('refresh prepares then activates through typed outcomes and never retains raw successor material', async () => {
  const f = fixture();
  const sessionId = await open(f);
  const refreshed = await f.admission.refresh(sessionId, { credential: 'credential-a', proof: 'refresh' });
  expect(refreshed).toMatchObject({ status: 'prepared', credentialId: 'credential-b', priorCredentialId: 'credential-a', connectorCredential: 'ldc1_secret' });
  expect(JSON.stringify(f.admission)).not.toContain('ldc1_secret');
  expect(await f.admission.refresh(sessionId, { credential: 'ldc1_secret', proof: 'activate' })).toEqual({
    status: 'refreshed', credentialId: 'credential-b', priorCredentialId: 'credential-a',
    expiresAt: '2026-08-22T12:01:00.000Z', rotationId: 'rotation-b', fence: 'fence-a',
  });

  const raced = fixture();
  const racedId = await open(raced);
  raced.setActive(false);
  expect(await raced.admission.refresh(racedId, { credential: 'credential-a', proof: 'refresh' })).toEqual({ status: 'closed', code: 'revoked' });
  expect(raced.admission.size()).toBe(0);
});

test('refresh does not disclose a rotated credential if configuration changes during the durable recheck', async () => {
  let changed = false;
  let armInspection = false;
  const f = fixture({
    // A revision change that is re-enabled must not pass an ABA-style check.
    feature: { snapshot: async () => ({ enabled: true, revision: changed ? 'config-b' : 'config-a' }) },
    inspectAuthority: async () => {
      if (armInspection) changed = true;
      return { disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true };
    },
  });
  const sessionId = await open(f);
  armInspection = true;
  const result = await f.admission.refresh(sessionId, { credential: 'credential-a', proof: 'refresh' });
  expect(result).toEqual({ status: 'closed', code: 'feature_disabled' });
  expect(JSON.stringify(result)).not.toContain('ldc1_secret');
  expect(f.admission.size()).toBe(0);
});

test('rate limits before PoP work, parser rejects malformed transport input, and close is at most once under racing revocation', async () => {
  let proofs = 0;
  const f = fixture({ attemptLimit: { maxAttempts: 2, windowMs: 1_000, maxKeys: 1 }, reauthenticate: { authenticate: async () => { proofs += 1; return { status: 'admitted', fence: 'fence-a', deviceId: 'device-a' }; } } });
  // Fill the sole bounded key slot without giving proof work to the denied key.
  await f.admission.open({ brainId: 'brain-b', context: { ...context, deviceId: 'device-b' }, credential: 'credential-b', proof: 'open', transport: { close: async () => {} } });
  expect(await f.admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: f.transport })).toEqual({ status: 'closed', code: 'rate_limited' });
  expect(proofs).toBe(1); // only the capacity-filling attempt reached PoP.

  const malformed = fixture();
  const malformedId = await open(malformed);
  expect(await malformed.admission.receive(malformedId, '{')).toEqual({ status: 'closed', code: 'invalid_frame' });
  expect(malformed.calls).toEqual(['invalid_frame']);

  const invalidObject = fixture();
  const invalidObjectId = await open(invalidObject);
  expect(await invalidObject.admission.receive(invalidObjectId, null as never)).toEqual({ status: 'closed', code: 'invalid_frame' });
  expect(invalidObject.admission.size()).toBe(0);

  const invalidRuntimeObject = fixture();
  const invalidRuntimeObjectId = await open(invalidRuntimeObject);
  expect(await invalidRuntimeObject.admission.receive(invalidRuntimeObjectId, {} as never)).toEqual({ status: 'closed', code: 'invalid_frame' });
  expect(invalidRuntimeObject.admission.size()).toBe(0);

  const staleFence = fixture();
  const staleFenceId = await open(staleFence);
  const heartbeat = JSON.stringify({ type: 'heartbeat', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-b' }, sequence: 1 });
  expect(await staleFence.admission.receive(staleFenceId, heartbeat)).toEqual({ status: 'closed', code: 'fence_changed' });
  expect(staleFence.admission.size()).toBe(0);

  const race = fixture();
  const raceId = await open(race);
  await Promise.all([race.admission.revoke(raceId), race.admission.revoke(raceId)]);
  expect(race.calls).toHaveLength(1);
  expect(race.admission.size()).toBe(0);

  const throwing = fixture();
  const throwingId = await throwing.admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: { close: () => { throw new Error('close failed'); } } });
  if (throwingId.status !== 'admitted') throw new Error('throwing transport failed to open');
  await expect(throwing.admission.revoke(throwingId.sessionId)).resolves.toEqual({ status: 'closed', code: 'revoked' });
  expect(throwing.admission.size()).toBe(0);
});

test('bounded heartbeat expiry and missing authority fail closed with registry cleanup', async () => {
  let now = new Date('2026-08-22T12:00:00.000Z');
  const f = fixture({ now: () => now, maxHeartbeatAgeMs: 1_000 });
  const sessionId = await open(f);
  now = new Date('2026-08-22T12:00:00.500Z');
  const heartbeat = JSON.stringify({ type: 'heartbeat', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sequence: 1 });
  expect(await f.admission.receive(sessionId, heartbeat)).toEqual({ status: 'live' });
  now = new Date('2026-08-22T12:00:01.400Z');
  expect(await f.admission.claimCommand(sessionId)).toEqual({ status: 'admitted', fence: 'fence-a' });
  now = new Date('2026-08-22T12:00:01.501Z');
  expect(await f.admission.claimCommand(sessionId)).toEqual({ status: 'closed', code: 'heartbeat_expired' });
  expect(f.admission.size()).toBe(0);
});

test('a live session closes when its admitted connector credential expires', async () => {
  let now = new Date('2026-08-22T12:00:00.000Z');
  const f = fixture({
    now: () => now,
    reauthenticate: { authenticate: async () => ({
      status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a',
      credentialExpiresAt: '2026-08-22T12:00:01.000Z',
    }) },
  });
  const sessionId = await open(f);
  now = new Date('2026-08-22T12:00:01.000Z');
  expect(await f.admission.heartbeat(sessionId)).toEqual({ status: 'closed', code: 'expired' });
  expect(f.calls).toEqual(['expired']);
  expect(f.admission.size()).toBe(0);
});

test('credential expiry closes claimed work at the exact expiration boundary', async () => {
  let now = new Date('2026-08-22T12:00:00.000Z');
  const f = fixture({
    now: () => now,
    reauthenticate: { authenticate: async () => ({
      status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a',
      credentialExpiresAt: '2026-08-22T12:00:01.000Z',
    }) },
  });
  const sessionId = await open(f);
  now = new Date('2026-08-22T12:00:01.000Z');
  expect(await f.admission.claimCommand(sessionId)).toEqual({ status: 'closed', code: 'expired' });
  expect(f.calls).toEqual(['expired']);
});

test('rejects noncanonical or accessor-backed facade expiries before state or successor disclosure', async () => {
  let credentialExpiryReads = 0;
  let publicExpiryReads = 0;
  const facade = {
    authenticate: async (input: { proof: unknown }) => {
      if (input.proof === 'open') return Object.create(Object.prototype, {
        status: { enumerable: true, value: 'admitted' }, fence: { enumerable: true, value: 'fence-a' }, deviceId: { enumerable: true, value: 'device-a' },
        credentialExpiresAt: { enumerable: true, get() { credentialExpiryReads += 1; return '2026-08-22T12:01:00.000Z'; } },
      });
      return Object.create(Object.prototype, {
        status: { enumerable: true, value: 'prepared' }, fence: { enumerable: true, value: 'fence-a' }, deviceId: { enumerable: true, value: 'device-a' },
        connectorCredential: { enumerable: true, value: 'ldc1_never-disclose' }, credentialId: { enumerable: true, value: 'credential-b' },
        priorCredentialId: { enumerable: true, value: 'credential-a' }, rotationId: { enumerable: true, value: 'rotation-b' },
        credentialExpiresAt: { enumerable: true, value: '2026-08-22T12:01:00.000Z' },
        expiresAt: { enumerable: true, get() { publicExpiryReads += 1; return '2026-08-22T12:01:00Z'; } },
      });
    },
  };
  const admission = new RemoteLocalSessionAdmission({
    reauthenticate: facade as never,
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
    now: () => new Date('2026-08-22T12:00:00.000Z'),
  });
  const first = await admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: { close: async () => {} } });
  expect(first).toEqual({ status: 'closed', code: 'unavailable' });
  expect(credentialExpiryReads).toBe(0);

  const live = new RemoteLocalSessionAdmission({
    reauthenticate: { authenticate: async (input: { proof: unknown }) => input.proof === 'open'
      ? ({ status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a', credentialExpiresAt: '2026-08-22T12:01:00.000Z' })
      : await facade.authenticate(input) } as never,
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
    now: () => new Date('2026-08-22T12:00:00.000Z'),
  });
  const opened = await live.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: { close: async () => {} } });
  if (opened.status !== 'admitted') throw new Error('live session did not admit');
  expect(await live.refresh(opened.sessionId, { credential: 'credential-a', proof: 'refresh' })).toEqual({ status: 'closed', code: 'unavailable' });
  expect(publicExpiryReads).toBe(0);
  expect(live.size()).toBe(0);
});

test('admission fails closed if the private PoP facade omits credential expiry', async () => {
  const closed: string[] = [];
  const admission = new RemoteLocalSessionAdmission({
    reauthenticate: { authenticate: async () => ({ status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a' } as never) },
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
  });
  expect(await admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open',
    transport: { close: async ({ code }) => { closed.push(code); } } })).toEqual({ status: 'closed', code: 'unavailable' });
  expect(closed).toEqual(['unavailable']);
  expect(admission.size()).toBe(0);
});

test('concurrent revoke wins over suspended claim or refresh and never releases a successor', async () => {
  let releaseInspection!: () => void;
  let waitInspection = false;
  const claim = fixture({ inspectAuthority: async () => {
    if (waitInspection) await new Promise<void>((resolve) => { releaseInspection = resolve; });
    return { disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true };
  } });
  const claimId = await open(claim);
  waitInspection = true;
  const pendingClaim = claim.admission.claimCommand(claimId);
  while (!releaseInspection) await Promise.resolve();
  await claim.admission.revoke(claimId);
  releaseInspection();
  expect(await pendingClaim).toEqual({ status: 'closed', code: 'fence_changed' });
  expect(claim.calls).toEqual(['revoked']);

  let releaseAuth!: () => void;
  let waitAuth = false;
  const refreshed = fixture({ reauthenticate: { authenticate: async (input: { proof: unknown }) => {
    if (input.proof === 'refresh') {
      if (waitAuth) await new Promise<void>((resolve) => { releaseAuth = resolve; });
      return { status: 'prepared' as const, fence: 'fence-a', deviceId: 'device-a', connectorCredential: 'ldc1_never-release', credentialId: 'credential-b', priorCredentialId: 'credential-a', expiresAt: '2026-08-22T12:01:00.000Z', rotationId: 'rotation-b' };
    }
    return { status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a' };
  } } });
  const refreshId = await open(refreshed);
  waitAuth = true;
  const pendingRefresh = refreshed.admission.refresh(refreshId, { credential: 'credential-a', proof: 'refresh' });
  while (!releaseAuth) await Promise.resolve();
  await refreshed.admission.revoke(refreshId);
  releaseAuth();
  const result = await pendingRefresh;
  expect(result).toEqual({ status: 'closed', code: 'fence_changed' });
  expect(JSON.stringify(result)).not.toContain('ldc1_never-release');
  expect(refreshed.calls).toEqual(['revoked']);
});

test('a loser that already holds a session returns the winning close disposition', async () => {
  let releaseFeature!: () => void;
  let suspendFeature = false;
  const featureGate = new Promise<void>((resolve) => { releaseFeature = resolve; });
  const f = fixture({ feature: { snapshot: async () => {
    if (suspendFeature) await featureGate;
    return { enabled: !suspendFeature, revision: 'config-a' };
  } } });
  const id = await open(f);
  suspendFeature = true;
  const losingRefresh = f.admission.refresh(id, { credential: 'credential-a', proof: 'refresh' });
  await Promise.resolve();
  const winningRevoke = f.admission.revoke(id, 'revoked');
  releaseFeature();
  expect(await winningRevoke).toEqual({ status: 'closed', code: 'revoked' });
  expect(await losingRefresh).toEqual({ status: 'closed', code: 'revoked' });
  expect(f.calls).toEqual(['revoked']);
});

test('facade identity mismatches close rather than bind a device-B authority to device-A', async () => {
  const openMismatch = fixture({ reauthenticate: { authenticate: async () => ({ status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-b' }) } });
  expect(await openMismatch.admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: openMismatch.transport })).toEqual({ status: 'closed', code: 'fence_changed' });
  expect(openMismatch.admission.size()).toBe(0);

  const refreshMismatch = fixture({ reauthenticate: { authenticate: async (input: { proof: unknown }) => input.proof === 'refresh'
    ? ({ status: 'prepared' as const, fence: 'fence-a', deviceId: 'device-b', connectorCredential: 'ldc1_wrong-device', credentialId: 'credential-b', priorCredentialId: 'credential-a', expiresAt: '2026-08-22T12:01:00.000Z', rotationId: 'rotation-b' })
    : ({ status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a' }) } });
  const id = await open(refreshMismatch);
  const result = await refreshMismatch.admission.refresh(id, { credential: 'credential-a', proof: 'refresh' });
  expect(result).toEqual({ status: 'closed', code: 'fence_changed' });
  expect(JSON.stringify(result)).not.toContain('ldc1_wrong-device');
});

test('malformed runtime open input is rejected before feature, limiter, or PoP work', async () => {
  let features = 0;
  let proofs = 0;
  const closed: string[] = [];
  const admission = new RemoteLocalSessionAdmission({
    reauthenticate: { authenticate: async () => { proofs += 1; return { status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a' }; } },
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
    feature: { snapshot: async () => { features += 1; return { enabled: true, revision: 'config-a' }; } },
  });
  const transport = { close: async ({ code }: { code: string }) => { closed.push(code); } };
  expect(await admission.open(null as never)).toEqual({ status: 'closed', code: 'fence_changed' });
  expect(await admission.open({} as never)).toEqual({ status: 'closed', code: 'fence_changed' });
  expect(await admission.open({ brainId: `b${'x'.repeat(256)}`, context, credential: 'credential-a', proof: 'open', transport } as never)).toEqual({ status: 'closed', code: 'fence_changed' });
  expect(closed).toEqual(['fence_changed']);
  expect(features).toBe(0);
  expect(proofs).toBe(0);
  expect(admission.size()).toBe(0);
});

test('Task 2.3 invalid_authority is normalized to a frozen typed close without registry state', async () => {
  const repository = new BrainAuthorizationAuthorityRepository(new MemoryAuthorityCas().client());
  const admission = new RemoteLocalSessionAdmission({
    reauthenticate: new RemoteLocalDeviceReauthenticationStore(repository),
    inspectAuthority: inspectRemoteLocalDeviceAuthority(repository),
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
  });
  const closed: string[] = [];
  await expect(admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: { close: async ({ code }) => { closed.push(code); } } }))
    .resolves.toEqual({ status: 'closed', code: 'fence_changed' });
  expect(closed).toEqual(['fence_changed']);
  expect(admission.size()).toBe(0);
});

test('attempt budget survives session and reentrant transport closure until its natural window expiry', async () => {
  let now = new Date('2026-08-22T12:00:00.000Z');
  let proofs = 0;
  let sequence = 0;
  const admission = new RemoteLocalSessionAdmission({
    reauthenticate: { authenticate: async (input: { context: { deviceId: string } }) => { proofs += 1; return { status: 'admitted' as const, fence: 'fence-a', deviceId: input.context.deviceId, credentialExpiresAt: '2099-01-01T00:00:00.000Z' }; } },
    inspectAuthority: async (brainId: string) => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: brainId === 'brain-b' ? 'device-b' : 'device-a', active: true }),
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
    now: () => now,
    mintSessionId: () => `rsh_${String(sequence += 1).padStart(16, 'a')}`,
    attemptLimit: { maxAttempts: 2, windowMs: 1_000, maxKeys: 2 },
  });
  const input = (brainId = 'brain-a', deviceId = 'device-a', transport = { close: async () => {} }) => ({ brainId, context: { kind: 'local_device_connector' as const, deviceId }, credential: 'credential-a', proof: 'open', transport });
  const first = await admission.open(input());
  if (first.status !== 'admitted') throw new Error('first attempt did not admit');
  await admission.revoke(first.sessionId);
  const second = await admission.open(input());
  if (second.status !== 'admitted') throw new Error('second attempt did not admit');
  await admission.revoke(second.sessionId);
  expect(await admission.open(input())).toEqual({ status: 'closed', code: 'rate_limited' });
  expect(proofs).toBe(2);
  // The counter is scoped to one brain/device; a second key has its own budget.
  expect((await admission.open(input('brain-b', 'device-b'))).status).toBe('admitted');
  expect(proofs).toBe(3);

  now = new Date('2026-08-22T12:00:01.001Z');
  const afterExpiry = await admission.open(input());
  expect(afterExpiry.status).toBe('admitted');
  expect(proofs).toBe(4);
  if (afterExpiry.status !== 'admitted') throw new Error('expiry did not reset budget');
  await admission.revoke(afterExpiry.sessionId);

  let reentrant: Promise<unknown> | undefined;
  const reentrantTransport = { close: async () => { reentrant = admission.open(input()); } };
  const reentrantFirst = await admission.open(input('brain-a', 'device-a', reentrantTransport));
  if (reentrantFirst.status !== 'admitted') throw new Error('reentrant first attempt did not admit');
  await admission.revoke(reentrantFirst.sessionId);
  await reentrant;
  // The reentrant close spent the second budget entry; it cannot clear it.
  expect(await admission.open(input())).toEqual({ status: 'closed', code: 'rate_limited' });
});

test('server-owned bounded attempt limiter isolates devices, expires windows, and fails closed on clock regression', async () => {
  let now = new Date('2026-08-22T12:00:00.000Z');
  let proofs = 0;
  const f = fixture({ now: () => now, attemptLimit: { maxAttempts: 2, windowMs: 1_000, maxKeys: 2 }, reauthenticate: { authenticate: async (input: { context: { deviceId: string } }) => { proofs += 1; return { status: 'admitted' as const, fence: 'fence-a', deviceId: input.context.deviceId }; } }, inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }) });
  // A disabled feature is rejected before the limiter mutates its state.
  f.setEnabled(false);
  await f.admission.open({ brainId: 'brain-a', context, credential: 'x', proof: 'x', transport: f.transport });
  f.setEnabled(true);
  await f.admission.open({ brainId: 'brain-a', context, credential: 'x', proof: 'x', transport: f.transport });
  await f.admission.open({ brainId: 'brain-a', context, credential: 'x', proof: 'x', transport: f.transport });
  expect(await f.admission.open({ brainId: 'brain-a', context, credential: 'x', proof: 'x', transport: f.transport })).toEqual({ status: 'closed', code: 'rate_limited' });
  // A distinct brain/device key is not charged by device-a's window.
  expect((await f.admission.open({ brainId: 'brain-b', context: { ...context, deviceId: 'device-b' }, credential: 'x', proof: 'x', transport: { close: async () => {} } })).status).toBe('closed'); // authority mismatch, not budget denial
  expect(proofs).toBe(3);
  now = new Date('2026-08-22T12:00:01.001Z');
  // A fresh server-issued handle permits the expired window to admit again.
  expect((await f.admission.open({ brainId: 'brain-a', context, credential: 'x', proof: 'x', transport: { close: async () => {} } })).status).toBe('admitted');
  now = new Date('2026-08-22T11:59:59.999Z');
  expect(await f.admission.open({ brainId: 'brain-a', context, credential: 'x', proof: 'x', transport: f.transport })).toEqual({ status: 'closed', code: 'rate_limited' });
});

test('heartbeat closes on a backwards clock rather than extending session liveness', async () => {
  let now = new Date('2026-08-22T12:00:00.000Z');
  const f = fixture({ now: () => now });
  const id = await open(f);
  now = new Date('2026-08-22T11:59:59.999Z');
  expect(await f.admission.heartbeat(id)).toEqual({ status: 'closed', code: 'unavailable' });
  expect(f.admission.size()).toBe(0);
});

test('refresh snapshots hostile runtime input before any admission dependency and closes a live session once', async () => {
  let authentications = 0;
  let features = 0;
  const f = fixture({
    reauthenticate: { authenticate: async (input: { proof: unknown }) => {
      authentications += 1;
      return input.proof === 'refresh'
        ? { status: 'prepared' as const, fence: 'fence-a', deviceId: 'device-a', connectorCredential: 'ldc1_secret', credentialId: 'credential-b', priorCredentialId: 'credential-a', expiresAt: '2026-08-22T12:01:00.000Z', rotationId: 'rotation-b' }
        : { status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a' };
    } },
    feature: { snapshot: async () => { features += 1; return { enabled: true, revision: 'config-a' }; } },
  });
  const id = await open(f);
  const before = features;
  const getter = Object.create(null, { credential: { enumerable: true, get() { throw new Error('must not read'); } }, proof: { enumerable: true, value: 'refresh' } });
  await expect(f.admission.refresh(id, getter)).resolves.toEqual({ status: 'closed', code: 'invalid_proof' });
  expect(f.calls).toEqual(['invalid_proof']);
  expect(authentications).toBe(1); // opening only
  expect(features).toBe(before);
  expect(f.admission.size()).toBe(0);

  const oversized = fixture();
  const oversizedId = await open(oversized);
  await expect(oversized.admission.refresh(oversizedId, { credential: 'x'.repeat(4_097), proof: 'refresh' } as never)).resolves.toEqual({ status: 'closed', code: 'invalid_proof' });
  expect(oversized.calls).toEqual(['invalid_proof']);

  const nullInput = fixture();
  const nullId = await open(nullInput);
  await expect(nullInput.admission.refresh(nullId, null as never)).resolves.toEqual({ status: 'closed', code: 'invalid_proof' });
  expect(nullInput.calls).toEqual(['invalid_proof']);

  const legitimate = fixture();
  const legitimateId = await open(legitimate);
  expect((await legitimate.admission.refresh(legitimateId, { credential: 'credential-a', proof: 'refresh' })).status).toBe('prepared');
  await expect(legitimate.admission.refresh({ bad: 'id' } as never, { credential: 'credential-a', proof: 'refresh' })).resolves.toEqual({ status: 'closed', code: 'fence_changed' });
});

test('revoke normalizes runtime codes and closes a valid session once', async () => {
  const arbitrary = fixture();
  const arbitraryId = await open(arbitrary);
  await expect(arbitrary.admission.revoke(arbitraryId, 'attacker-code' as never)).resolves.toEqual({ status: 'closed', code: 'fence_changed' });
  expect(arbitrary.calls).toEqual(['fence_changed']);

  const getter = fixture();
  const getterId = await open(getter);
  const code = Object.create(null, { value: { enumerable: true, get() { throw new Error('must not read'); } } });
  await expect(getter.admission.revoke(getterId, code as never)).resolves.toEqual({ status: 'closed', code: 'fence_changed' });
  expect(getter.calls).toEqual(['fence_changed']);

  const normal = fixture();
  const normalId = await open(normal);
  await expect(normal.admission.revoke(normalId, 'revoked')).resolves.toEqual({ status: 'closed', code: 'revoked' });
  expect(normal.calls).toEqual(['revoked']);
  await expect(normal.admission.revoke(null as never, 'not-a-code' as never)).resolves.toEqual({ status: 'closed', code: 'fence_changed' });
});

test('an expired live session cannot activate a prepared successor or mutate durable credential state', async () => {
  const real = await realDeviceFixture();
  let now = new Date('2026-08-22T12:00:10.000Z');
  const admission = new RemoteLocalSessionAdmission({
    reauthenticate: real.reauth,
    inspectAuthority: inspectRemoteLocalDeviceAuthority(real.repository),
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-1' }) },
    now: () => now,
  });
  const socket = await real.reauth.issueChallenge({ commandId: 'expiry-rotation-open', brainId: 'brain-a', context: real.connector,
    credential: real.credential, expectedCapabilitiesRevision: real.fence, purpose: 'socket_open' });
  const opened = await admission.open({ brainId: 'brain-a', context: real.connector, credential: real.credential,
    proof: real.signedProof(socket), transport: { close: async () => {} } });
  if (opened.status !== 'admitted') throw new Error('initial socket admission failed');
  const refresh = await real.reauth.issueChallenge({ commandId: 'expiry-rotation-prepare', brainId: 'brain-a', context: real.connector,
    credential: real.credential, expectedCapabilitiesRevision: opened.fence, purpose: 'credential_refresh' });
  const prepared = await admission.refresh(opened.sessionId, { credential: real.credential, proof: real.signedProof(refresh) });
  if (prepared.status !== 'prepared') throw new Error('credential preparation failed');
  const activation = await real.reauth.issueChallenge({ commandId: 'expiry-rotation-activate', brainId: 'brain-a', context: real.connector,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: prepared.fence, purpose: 'credential_activate' });
  const before = await real.repository.inspect('brain-a');
  now = new Date('2026-08-23T12:00:10.000Z');
  expect(await admission.refresh(opened.sessionId, { credential: prepared.connectorCredential, proof: real.signedProof(activation) }))
    .toEqual({ status: 'closed', code: 'expired' });
  const after = await real.repository.inspect('brain-a');
  expect(after).toEqual(before);
  expect(admission.size()).toBe(0);
});

test('expiry during awaited activation closes the original session without installing successor lifetime', async () => {
  let now = new Date('2026-08-22T12:00:00.000Z');
  let releaseAuthentication!: () => void;
  let suspendAuthentication = false;
  let authenticationStarted = false;
  const authenticationGate = new Promise<void>((resolve) => { releaseAuthentication = resolve; });
  const closed: string[] = [];
  const admission = new RemoteLocalSessionAdmission({
    reauthenticate: { authenticate: async (input: { proof: unknown }) => {
      if (input.proof === 'open') return { status: 'admitted' as const, fence: 'fence-a', deviceId: 'device-a', credentialExpiresAt: '2026-08-22T12:00:01.000Z' };
      if (suspendAuthentication) { authenticationStarted = true; await authenticationGate; }
      return { status: 'refreshed' as const, fence: 'fence-a', deviceId: 'device-a', credentialId: 'credential-b', priorCredentialId: 'credential-a',
        expiresAt: '2026-08-22T12:10:00.000Z', credentialExpiresAt: '2026-08-22T12:10:00.000Z', rotationId: 'rotation-b' };
    } },
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
    now: () => now,
  });
  const opened = await admission.open({ brainId: 'brain-a', context, credential: 'credential-a', proof: 'open', transport: { close: async ({ code }) => { closed.push(code); } } });
  if (opened.status !== 'admitted') throw new Error('initial session admission failed');
  suspendAuthentication = true;
  const pending = admission.refresh(opened.sessionId, { credential: 'credential-b', proof: 'activate' });
  while (!authenticationStarted) await Promise.resolve();
  now = new Date('2026-08-22T12:00:01.000Z');
  releaseAuthentication();
  expect(await pending).toEqual({ status: 'closed', code: 'expired' });
  expect(closed).toEqual(['expired']);
  expect(admission.size()).toBe(0);
});

test('a final feature close after durable prepare suppresses the successor while the prior credential remains usable', async () => {
  const real = await realDeviceFixture();
  const inspectAuthority = inspectRemoteLocalDeviceAuthority(real.repository);
  let closeOnPending = false;
  const admission = new RemoteLocalSessionAdmission({ reauthenticate: real.reauth, inspectAuthority,
    feature: { snapshot: async () => {
      const inspected = await real.repository.inspect('brain-a');
      const pending = inspected.disposition === 'current' && inspected.record.local_device_credential_pending !== null;
      return { enabled: !(closeOnPending && pending), revision: 'config-1' };
    } }, now: () => new Date('2026-08-22T12:00:10.000Z') });
  const socket = await real.reauth.issueChallenge({ commandId: 'prepare-close-open', brainId: 'brain-a', context: real.connector,
    credential: real.credential, expectedCapabilitiesRevision: real.fence, purpose: 'socket_open' });
  const opened = await admission.open({ brainId: 'brain-a', context: real.connector, credential: real.credential,
    proof: real.signedProof(socket), transport: { close: async () => {} } });
  if (opened.status !== 'admitted') throw new Error('initial socket admission failed');
  const refresh = await real.reauth.issueChallenge({ commandId: 'prepare-close-refresh', brainId: 'brain-a', context: real.connector,
    credential: real.credential, expectedCapabilitiesRevision: opened.fence, purpose: 'credential_refresh' });
  closeOnPending = true;
  const result = await admission.refresh(opened.sessionId, { credential: real.credential, proof: real.signedProof(refresh) });
  expect(result).toEqual({ status: 'closed', code: 'feature_disabled' });
  expect(result).not.toHaveProperty('connectorCredential');
  const afterPrepare = await real.repository.inspect('brain-a');
  expect(afterPrepare).toMatchObject({ disposition: 'current', record: {
    local_device_credential: { credential_id: refresh.status === 'issued' ? refresh.credentialId : 'missing' },
    local_device_credential_pending: expect.objectContaining({ prior_credential_id: refresh.status === 'issued' ? refresh.credentialId : 'missing' }),
  } });

  closeOnPending = false;
  const retry = await real.reauth.issueChallenge({ commandId: 'prepare-close-prior-retry', brainId: 'brain-a', context: real.connector,
    credential: real.credential, expectedCapabilitiesRevision: real.fence, purpose: 'socket_open' });
  expect(retry.status).toBe('issued');
  expect((await admission.open({ brainId: 'brain-a', context: real.connector, credential: real.credential,
    proof: real.signedProof(retry), transport: { close: async () => {} } })).status).toBe('admitted');
  expect(JSON.stringify(admission)).not.toContain(real.credential);
});

test('a final feature close after activation cannot strand the connector that already learned the successor', async () => {
  const real = await realDeviceFixture();
  const inspectAuthority = inspectRemoteLocalDeviceAuthority(real.repository);
  let closeAfterActivationCredentialId: string | null = null;
  const admission = new RemoteLocalSessionAdmission({ reauthenticate: real.reauth, inspectAuthority,
    feature: { snapshot: async () => {
      const inspected = await real.repository.inspect('brain-a');
      const activated = inspected.disposition === 'current'
        && inspected.record.local_device_credential?.credential_id === closeAfterActivationCredentialId
        && inspected.record.local_device_credential_pending === null;
      return { enabled: !activated, revision: 'config-1' };
    } }, now: () => new Date('2026-08-22T12:00:10.000Z') });
  const socket = await real.reauth.issueChallenge({ commandId: 'activation-close-open', brainId: 'brain-a', context: real.connector,
    credential: real.credential, expectedCapabilitiesRevision: real.fence, purpose: 'socket_open' });
  const opened = await admission.open({ brainId: 'brain-a', context: real.connector, credential: real.credential,
    proof: real.signedProof(socket), transport: { close: async () => {} } });
  if (opened.status !== 'admitted') throw new Error('initial socket admission failed');
  const refresh = await real.reauth.issueChallenge({ commandId: 'activation-close-prepare', brainId: 'brain-a', context: real.connector,
    credential: real.credential, expectedCapabilitiesRevision: opened.fence, purpose: 'credential_refresh' });
  const prepared = await admission.refresh(opened.sessionId, { credential: real.credential, proof: real.signedProof(refresh) });
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  expect(JSON.stringify(admission)).not.toContain(prepared.connectorCredential);
  const activation = await real.reauth.issueChallenge({ commandId: 'activation-close-proof', brainId: 'brain-a', context: real.connector,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: prepared.fence, purpose: 'credential_activate' });
  closeAfterActivationCredentialId = prepared.credentialId;
  const result = await admission.refresh(opened.sessionId, { credential: prepared.connectorCredential, proof: real.signedProof(activation) });
  expect(result).toEqual({ status: 'closed', code: 'feature_disabled' });
  expect(result).not.toHaveProperty('connectorCredential');

  closeAfterActivationCredentialId = null;
  expect((await real.reauth.issueChallenge({ commandId: 'activation-close-old-denied', brainId: 'brain-a', context: real.connector,
    credential: real.credential, expectedCapabilitiesRevision: real.fence, purpose: 'socket_open' })).status).toBe('denied');
  const successor = await real.reauth.issueChallenge({ commandId: 'activation-close-successor-open', brainId: 'brain-a', context: real.connector,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: prepared.fence, purpose: 'socket_open' });
  expect(successor.status).toBe('issued');
  expect((await admission.open({ brainId: 'brain-a', context: real.connector, credential: prepared.connectorCredential,
    proof: real.signedProof(successor), transport: { close: async () => {} } })).status).toBe('admitted');
});

test('the production inspector and Task 2.3 PoP store admit a real fresh socket proof only', async () => {
  const cas = new MemoryAuthorityCas();
  const repository = new BrainAuthorizationAuthorityRepository(cas.client(), { now: () => new Date('2026-08-22T12:00:00.000Z') });
  const owner = { kind: 'authenticated_external_owner' as const, principalId: 'owner-a' };
  const boot = await repository.execute({ kind: 'bootstrap', commandId: 'boot', brainId: 'brain-a', context: owner, ownerPrincipalId: 'owner-a', targetId: 'target-a', hostId: 'host-a', deploymentGeneration: 1, adapterIdentity: 'adapter-a', adapterVersion: '1' });
  if (boot.status !== 'applied') throw new Error('bootstrap failed');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const enrollment = new RemoteLocalDeviceEnrollmentStore(repository, { now: () => new Date('2026-08-22T12:00:00.000Z') });
  const started = await enrollment.start({ commandId: 'start', brainId: 'brain-a', context: owner, expectedCapabilitiesRevision: boot.fence.capabilitiesRevision, publicKey, enrolledByCredentialId: 'owner-credential' });
  if (started.status !== 'pending') throw new Error('start failed');
  const completed = await enrollment.complete({ commandId: 'complete', brainId: 'brain-a', context: { kind: 'local_device_enrollment_daemon', deviceId: started.deviceId }, enrollmentId: started.enrollmentId, enrollmentSecret: started.enrollmentSecret, signature: sign(null, Buffer.from(started.challenge), pair.privateKey).toString('base64url') });
  if (completed.status !== 'applied') throw new Error('completion failed');
  const reauth = new RemoteLocalDeviceReauthenticationStore(repository, { now: () => new Date('2026-08-22T12:00:10.000Z') });
  const connector = { kind: 'local_device_connector' as const, deviceId: completed.record.deviceId };
  const challenge = await reauth.issueChallenge({ commandId: 'challenge', brainId: 'brain-a', context: connector, credential: completed.connectorCredential, expectedCapabilitiesRevision: completed.fence.capabilitiesRevision, purpose: 'socket_open' });
  if (challenge.status !== 'issued') throw new Error('challenge failed');
  const proofBody = { fence: { brainId: challenge.brainId, deviceId: challenge.deviceId, authorityRevision: challenge.authorityRevision }, credentialId: challenge.credentialId, proofChallengeId: challenge.proofChallengeId, purpose: challenge.purpose, expiresAt: challenge.expiresAt, rotationId: challenge.rotationId };
  const proof = { ...proofBody, signatureAlgorithm: 'ed25519' as const, signature: sign(null, Buffer.from(canonicalDeviceReauthProofPayload(proofBody)), pair.privateKey).toString('base64url') };
  const admission = new RemoteLocalSessionAdmission({ reauthenticate: reauth, inspectAuthority: inspectRemoteLocalDeviceAuthority(repository), feature: { snapshot: async () => ({ enabled: true, revision: 'config-1' }) }, now: () => new Date('2026-08-22T12:00:10.000Z') });
  const closed: string[] = [];
  const transport = { close: async ({ code }: { code: string }) => { closed.push(code); } };
  const opened = await admission.open({ brainId: 'brain-a', context: connector, credential: completed.connectorCredential, proof, transport });
  if (opened.status !== 'admitted') throw new Error('real socket admission failed');
  expect((await admission.open({ brainId: 'brain-a', context: connector, credential: completed.connectorCredential, proof, transport: { close: async ({ code }) => { closed.push(code); } } })).status).toBe('closed');
  expect(closed).toEqual(['invalid_proof']);

  const refreshChallenge = await reauth.issueChallenge({ commandId: 'refresh-challenge', brainId: 'brain-a', context: connector, credential: completed.connectorCredential, expectedCapabilitiesRevision: opened.fence, purpose: 'credential_refresh' });
  if (refreshChallenge.status !== 'issued') throw new Error('refresh challenge failed');
  const refreshBody = { fence: { brainId: refreshChallenge.brainId, deviceId: refreshChallenge.deviceId, authorityRevision: refreshChallenge.authorityRevision }, credentialId: refreshChallenge.credentialId, proofChallengeId: refreshChallenge.proofChallengeId, purpose: refreshChallenge.purpose, expiresAt: refreshChallenge.expiresAt, rotationId: refreshChallenge.rotationId };
  const refreshProof = { ...refreshBody, signatureAlgorithm: 'ed25519' as const, signature: sign(null, Buffer.from(canonicalDeviceReauthProofPayload(refreshBody)), pair.privateKey).toString('base64url') };
  const prepared = await admission.refresh(opened.sessionId, { credential: completed.connectorCredential, proof: refreshProof });
  if (prepared.status !== 'prepared') throw new Error(`real prepare failed: ${prepared.code}`);
  expect(prepared.credentialId).not.toBe(prepared.priorCredentialId);
  expect(JSON.stringify(admission)).not.toContain(prepared.connectorCredential);

  const activationChallenge = await reauth.issueChallenge({ commandId: 'activation-challenge', brainId: 'brain-a', context: connector,
    credential: prepared.connectorCredential, expectedCapabilitiesRevision: prepared.fence, purpose: 'credential_activate' });
  if (activationChallenge.status !== 'issued') throw new Error('activation challenge failed');
  const activationBody = { fence: { brainId: activationChallenge.brainId, deviceId: activationChallenge.deviceId, authorityRevision: activationChallenge.authorityRevision },
    credentialId: activationChallenge.credentialId, proofChallengeId: activationChallenge.proofChallengeId, purpose: activationChallenge.purpose,
    expiresAt: activationChallenge.expiresAt, rotationId: activationChallenge.rotationId };
  const activationProof = { ...activationBody, signatureAlgorithm: 'ed25519' as const,
    signature: sign(null, Buffer.from(canonicalDeviceReauthProofPayload(activationBody)), pair.privateKey).toString('base64url') };
  const refreshed = await admission.refresh(opened.sessionId, { credential: prepared.connectorCredential, proof: activationProof });
  if (refreshed.status !== 'refreshed') throw new Error(`real activation failed: ${refreshed.code}`);
  expect(refreshed).not.toHaveProperty('connectorCredential');
  expect(refreshed.credentialId).toBe(prepared.credentialId);

  const revoked = await repository.execute({ kind: 'local_device_revoke', commandId: 'owner-revokes-device', brainId: 'brain-a', context: owner, expectedCapabilitiesRevision: refreshed.fence, revokedAt: '2026-08-22T12:00:11.000Z' });
  expect(revoked.status).toBe('applied');
  expect(await admission.claimCommand(opened.sessionId)).toEqual({ status: 'closed', code: 'revoked' });
  expect(admission.size()).toBe(0);
});
