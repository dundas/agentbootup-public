import { test, expect, describe } from 'bun:test';
import { checkCredentialsAuthenticate } from '../../lib/doctor/credentials-check.js';
import { VaultUnreachableError } from '../../lib/brain/vault-redeem.js';
import { reduceHealthStatus } from '../../lib/brain/health-record.js';

const ref = 'vault://brain-a/agentdrive';
const goodTransport = async () => ({ AGENTDRIVE_KEY: 'sk-live' });

describe('checkCredentialsAuthenticate (FR-2 keystone)', () => {
  test('redeem + round-trip success → pass', async () => {
    const r = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: goodTransport,
      authenticate: async () => true,
    });
    expect(r.state).toBe('pass');
    expect(r.category).toBe('credentials');
  });

  test('AC-1: redeemed but revoked credential → fail (the dead-key class)', async () => {
    const r = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: goodTransport,
      authenticate: async () => false, // service rejects the (revoked) key
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/did NOT authenticate/);
  });

  test('truthy-non-true auth return → fail (strict === true enforced)', async () => {
    for (const truthy of [1, 'ok', {}, []]) {
      const r = await checkCredentialsAuthenticate({ ingressKeyRef: ref, transport: goodTransport, authenticate: async () => truthy });
      expect(r.state).toBe('fail');
    }
  });

  test('non-skippable: missing round-trip authenticator → fail, never skip/pass', async () => {
    const r = await checkCredentialsAuthenticate({ ingressKeyRef: ref, transport: goodTransport });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/no round-trip authenticator/);
  });

  test('missing ingressKeyRef → fail', async () => {
    const r = await checkCredentialsAuthenticate({ transport: goodTransport, authenticate: async () => true });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/ingressKeyRef/);
  });

  test('redeem error → fail (fail-closed)', async () => {
    const r = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: async () => { throw new Error('vault 503'); },
      authenticate: async () => true,
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/redemption failed.*vault 503/);
  });

  test('empty redeem result → fail before round-trip (adversarial false-green guard)', async () => {
    let authCalled = false;
    const r = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: async () => ({}), // vault returns nothing
      authenticate: async () => { authCalled = true; return true; },
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/redemption failed.*no usable secret material/);
    expect(authCalled).toBe(false); // never reaches the (lenient) authenticator
  });

  test('non-Error thrown value coerces in the message (not a crash)', async () => {
    const r = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: async () => { throw 'oops-string'; },
      authenticate: async () => true,
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/redemption failed.*oops-string/);
  });

  test('round-trip that throws a generic error → fail (fail-closed by default)', async () => {
    const r = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: goodTransport,
      authenticate: async () => { throw new Error('network'); },
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/round-trip threw.*network/);
  });

  // PRD-0039 FR-3: only a TYPED VaultUnreachableError degrades to unknown; every other
  // redeem failure (invalid ref, empty material, 4xx, generic throw) stays fail-closed.
  test('redeem throws VaultUnreachableError (vault down) → unknown, NOT fail', async () => {
    const r = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: async () => { throw new VaultUnreachableError('vault redeem unreachable: HTTP 503'); },
      authenticate: async () => true,
    });
    expect(r.state).toBe('unknown');
    expect(r.severity).toBe('warning');
    expect(r.message).toMatch(/redemption unreachable.*503/);
  });

  test('auth round-trip throws VaultUnreachableError → unknown, NOT fail', async () => {
    const r = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: goodTransport,
      authenticate: async () => { throw new VaultUnreachableError('auth service unreachable'); },
    });
    expect(r.state).toBe('unknown');
    expect(r.message).toMatch(/round-trip unreachable/);
  });

  // AC-2 regression: a vault OUTAGE must Degrade the fleet, not Stuck it — but a REVOKED
  // key (vault reachable, auth=false) must still Stuck (the dead-key signal is preserved).
  test('AC-2 regression: vault unreachable → Degraded; revoked key → Stuck (both preserved)', async () => {
    const unreachable = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: async () => { throw new VaultUnreachableError('HTTP 503'); },
      authenticate: async () => true,
    });
    const degraded = reduceHealthStatus({
      runtime_resolves: { state: 'pass' }, identity_materializes: { state: 'pass' },
      credentials_authenticate: unreachable, messaging_round_trips: { state: 'pass' },
    });
    expect(degraded.status).toBe('degraded'); // was 'stuck' before FR-3

    const revoked = await checkCredentialsAuthenticate({ ingressKeyRef: ref, transport: goodTransport, authenticate: async () => false });
    const stuck = reduceHealthStatus({
      runtime_resolves: { state: 'pass' }, identity_materializes: { state: 'pass' },
      credentials_authenticate: revoked, messaging_round_trips: { state: 'pass' },
    });
    expect(stuck.status).toBe('stuck'); // dead-key detection still works
  });

  test('invalid ref → fail (no traversal-shaped redeem)', async () => {
    const r = await checkCredentialsAuthenticate({
      ingressKeyRef: 'vault://../escape',
      transport: goodTransport,
      authenticate: async () => true,
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/redemption failed/);
  });
});

describe('integration with the health-record reducer (AC-1 end-to-end)', () => {
  test('revoked credential check → Stuck overall', async () => {
    const credCheck = await checkCredentialsAuthenticate({
      ingressKeyRef: ref,
      transport: goodTransport,
      authenticate: async () => false,
    });
    const reduced = reduceHealthStatus({
      runtime_resolves: { state: 'pass' },
      identity_materializes: { state: 'pass' },
      credentials_authenticate: credCheck,
      messaging_round_trips: { state: 'pass' },
    });
    expect(reduced.status).toBe('stuck');
    expect(reduced.reason).toMatch(/credentials_authenticate fail/);
  });
});
