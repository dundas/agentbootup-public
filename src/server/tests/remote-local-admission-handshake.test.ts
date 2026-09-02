import { expect, test } from 'bun:test';
import { RemoteLocalAdmissionHandshake } from '../lib/remote-local-admission-handshake';

const open = { type: 'device.admission.open', protocolVersion: 1, brainId: 'brain-a', deviceId: 'device-a', credential: 'ldc1_test' };
const proof = { type: 'device.reauth.proof', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, credentialId: 'credential-a', proofChallengeId: 'pop-a', purpose: 'socket_open', expiresAt: '2026-08-23T12:00:30.000Z', rotationId: 'rot-a', signatureAlgorithm: 'ed25519', signature: 'A'.repeat(86) };
const wire = (frame: unknown) => JSON.stringify(frame);

function fixture(overrides: Record<string, unknown> = {}) {
  return new RemoteLocalAdmissionHandshake({
    feature: { snapshot: async () => ({ enabled: true, revision: 'config-a' }) },
    inspectAuthority: async () => ({ disposition: 'current' as const, fence: 'fence-a', deviceId: 'device-a', active: true }),
    reauthenticate: { issueChallenge: async () => ({ status: 'issued' as const, brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a', credentialId: 'credential-a', proofChallengeId: 'pop-a', purpose: 'socket_open' as const, expiresAt: '2026-08-23T12:00:30.000Z', rotationId: 'rot-a' }) },
    admission: { open: async () => ({ status: 'admitted' as const, sessionId: 'rsh_0123456789abcdef', fence: 'fence-a' }), receive: async () => ({ status: 'live' as const }), revoke: async () => ({ status: 'closed' as const, code: 'fence_changed' as const }) },
    ...overrides,
  } as never);
}

test('issues one durable challenge before it creates an admitted session', async () => {
  const handshake = fixture();
  const transport = { close: () => undefined };
  expect(await handshake.receive(wire(open), transport)).toMatchObject({ status: 'send', frame: { type: 'device.reauth.challenge', fence: proof.fence } });
  expect(await handshake.receive(wire(proof), transport)).toEqual({ status: 'admitted', sessionId: 'rsh_0123456789abcdef', fence: 'fence-a', projection: proof.fence });
});

test('rejects commands and disabled admission before challenge or session work', async () => {
  let challengeCalls = 0;
  const handshake = fixture({ reauthenticate: { issueChallenge: async () => { challengeCalls += 1; return { status: 'denied' }; } } });
  expect(await handshake.receive(wire({ type: 'availability', protocolVersion: 1, fence: proof.fence, state: 'online' }), { close: () => undefined })).toEqual({ status: 'closed', code: 'invalid_frame' });
  expect(challengeCalls).toBe(0);
  const disabled = fixture({ feature: { snapshot: async () => ({ enabled: false, revision: 'config-a' }) } });
  expect(await disabled.receive(wire(open), { close: () => undefined })).toEqual({ status: 'closed', code: 'feature_disabled' });
});

test('fails closed when command minting or issued challenge structure is invalid', async () => {
  let issued = 0;
  const mintFailure = fixture({ mintCommandId: () => 'not valid\n' });
  expect(await mintFailure.receive(wire(open), { close: () => undefined })).toEqual({ status: 'closed', code: 'unavailable' });
  const malformed = fixture({ reauthenticate: { issueChallenge: async () => { issued += 1; return { status: 'issued' as const, brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a', credentialId: 'credential-a', proofChallengeId: 'pop-a', purpose: 'socket_open' as const, expiresAt: 'bad', rotationId: 'rot-a' }; } } });
  expect(await malformed.receive(wire(open), { close: () => undefined })).toEqual({ status: 'closed', code: 'invalid_proof' });
  expect(issued).toBe(1);
});

test('permits exactly open then its matching proof and no post-admission relay frame', async () => {
  const handshake = fixture();
  const transport = { close: () => undefined };
  expect((await handshake.receive(wire(open), transport)).status).toBe('send');
  expect(await handshake.receive(wire(open), transport)).toEqual({ status: 'closed', code: 'invalid_frame' });
  const replay = fixture();
  expect((await replay.receive(wire(open), transport)).status).toBe('send');
  expect((await replay.receive(wire(proof), transport)).status).toBe('admitted');
  expect(await replay.receive(wire(proof), transport)).toEqual({ status: 'closed', code: 'invalid_frame' });
});
