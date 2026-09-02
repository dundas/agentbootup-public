import { test, expect, describe } from 'bun:test';
import { checkIdentityMaterializes } from '../../lib/doctor/identity-check.js';
import { reduceHealthStatus } from '../../lib/brain/health-record.js';

const agentId = 'brain-a';
const local = { id: agentId, key_fingerprint: 'sha256:abc123' };

describe('checkIdentityMaterializes (FR-4)', () => {
  test('registry agrees + key fingerprint matches → pass', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => ({ id: agentId, key_fingerprint: 'sha256:abc123' }),
    });
    expect(r.state).toBe('pass');
    expect(r.category).toBe('identity');
  });

  test('agent not registered → fail (identity does not materialize)', async () => {
    const r = await checkIdentityMaterializes({ agentId, localIdentity: local, fetchRegistry: async () => null });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/not registered/);
  });

  test('key fingerprint mismatch → fail (registry disagrees)', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => ({ id: agentId, key_fingerprint: 'sha256:DIFFERENT' }),
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/key fingerprint mismatch/);
  });

  test('registry id mismatch → fail', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => ({ id: 'someone-else', key_fingerprint: 'sha256:abc123' }),
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/does not match/);
  });

  test('registry record without an id but matching fingerprint → pass (id is a secondary belt)', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => ({ key_fingerprint: 'sha256:abc123' }),
    });
    expect(r.state).toBe('pass');
  });

  test('registry record missing key_fingerprint → fail (cannot attest agreement)', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => ({ id: agentId }),
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/registry has no key_fingerprint/);
  });

  test('whitespace-only differences in fingerprint do NOT false-fail a legit agent', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: { id: agentId, key_fingerprint: 'sha256:abc123\n' },
      fetchRegistry: async () => ({ id: agentId, key_fingerprint: '  sha256:abc123  ' }),
    });
    expect(r.state).toBe('pass');
  });

  test('malformed (non-object) registry record → fail with a clear message', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => 'corrupt',
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/malformed registry record/);
  });

  test('array registry record → fail (malformed guard, typeof [] === object)', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => [{ id: agentId, key_fingerprint: 'sha256:abc123' }],
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/malformed registry record/);
  });

  test('array localIdentity → fail (malformed guard)', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: [local],
      fetchRegistry: async () => ({ id: agentId, key_fingerprint: 'sha256:abc123' }),
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/no local identity/);
  });

  test('registry UNREACHABLE → unknown (infra blip, not proven-bad)', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => { throw new Error('ETIMEDOUT'); },
    });
    expect(r.state).toBe('unknown');
    expect(r.message).toMatch(/registry unreachable/);
  });

  test('no registry accessor → unknown (cannot attest), not a false pass', async () => {
    const r = await checkIdentityMaterializes({ agentId, localIdentity: local });
    expect(r.state).toBe('unknown');
  });

  test('local identity id disagreeing with agentId → fail (self-inconsistent claim)', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: { id: 'impostor', key_fingerprint: 'sha256:abc123' },
      fetchRegistry: async () => ({ id: agentId, key_fingerprint: 'sha256:abc123' }),
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/local identity id 'impostor' does not match/);
  });

  test('local identity without key_fingerprint → fail (cannot prove key validity)', async () => {
    const r = await checkIdentityMaterializes({
      agentId,
      localIdentity: { id: agentId },
      fetchRegistry: async () => ({ id: agentId, key_fingerprint: 'sha256:abc123' }),
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/no key_fingerprint/);
  });

  test('missing agentId / localIdentity → fail', async () => {
    expect((await checkIdentityMaterializes({ localIdentity: local, fetchRegistry: async () => null })).state).toBe('fail');
    expect((await checkIdentityMaterializes({ agentId, fetchRegistry: async () => null })).state).toBe('fail');
  });
});

describe('integration with the reducer', () => {
  test('key mismatch → Stuck (identity is load-bearing)', async () => {
    const idCheck = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => ({ id: agentId, key_fingerprint: 'sha256:DIFFERENT' }),
    });
    const reduced = reduceHealthStatus({
      runtime_resolves: { state: 'pass' },
      identity_materializes: idCheck,
      credentials_authenticate: { state: 'pass' },
      messaging_round_trips: { state: 'pass' },
    });
    expect(reduced.status).toBe('stuck');
  });

  test('registry unreachable → Degraded, NOT Stuck (no false-Stuck on infra)', async () => {
    const idCheck = await checkIdentityMaterializes({
      agentId,
      localIdentity: local,
      fetchRegistry: async () => { throw new Error('ECONNREFUSED'); },
    });
    const reduced = reduceHealthStatus({
      runtime_resolves: { state: 'pass' },
      identity_materializes: idCheck,
      credentials_authenticate: { state: 'pass' },
      messaging_round_trips: { state: 'pass' },
    });
    expect(reduced.status).toBe('degraded');
  });
});
