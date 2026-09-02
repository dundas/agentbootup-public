import { expect, test } from 'bun:test';
import { createPublicKey, verify } from 'node:crypto';
import { enrollRemoteLocalDevice } from '../../lib/daemon/remote-local-enrollment.mjs';

const runtime = Object.freeze({
  approvalExpiresInMs: 60_000,
  daemon: { credential: 'loopback-credential', bindAddress: '127.0.0.1', runtime: {
    runtimeIdentity: 'runtime-a', provider: 'codex', workspace: '/private/tmp/agentbootup-runtime-test',
    capabilityPolicyId: 'policy-a', sessionDiscoveryMaxAgeMs: 60_000, sessionClockSkewToleranceMs: 5_000,
  } },
  planeAuthority: { mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', assurance: 'assurance-a' },
});

test('remote-local enrollment signs the server challenge and seals only complete v2 state', async () => {
  const calls = [];
  let state;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ data: { enrollment: {
        enrollmentId: 'lde_abcdefghijklmnop', deviceId: 'ldv_abcdefghijklmnop',
        enrollmentSecret: 's'.repeat(43), challenge: 'c'.repeat(43), authorityRevision: 'fence-a', authorityScope: { tenantId: 'owner-a', consumerId: 'owner-a' },
      } } }), { status: 201 });
    }
    const body = JSON.parse(init.body);
    const start = JSON.parse(calls[0].init.body);
    const publicKey = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(start.publicKey, 'base64url')]);
    expect(verify(null, Buffer.from('c'.repeat(43), 'utf8'), { key: publicKey, format: 'der', type: 'spki' }, Buffer.from(body.signature, 'base64url'))).toBe(true);
    return new Response(JSON.stringify({ data: { device: { deviceId: body.deviceId, authorityRevision: 'fence-b' }, connectorCredential: 'ldc1_testcredential' } }), { status: 201 });
  };
  const result = await enrollRemoteLocalDevice({
    brainId: 'brain-a', runtime, credentials: { apiKey: 'api-key', serverUrl: 'https://example.test' },
    fetchImpl, randomUUIDImpl: () => '12345678-1234-1234-1234-123456789abc',
    writeState: async (next) => { state = next; },
  });
  expect(result).toEqual({ brainId: 'brain-a', deviceId: 'ldv_abcdefghijklmnop' });
  expect(calls).toHaveLength(2);
  expect(calls[0].url).toBe('https://example.test/v1/remote-local/brains/brain-a/enrollments');
  expect(calls[0].init.headers.authorization).toBe('Bearer api-key');
  expect(JSON.parse(calls[0].init.body)).not.toHaveProperty('runtime');
  expect(JSON.parse(calls[1].init.body)).toMatchObject({ deviceId: 'ldv_abcdefghijklmnop', enrollmentSecret: 's'.repeat(43) });
  expect(state).toMatchObject({ version: 2, brainId: 'brain-a', deviceId: 'ldv_abcdefghijklmnop', credential: 'ldc1_testcredential', runtime: { ...runtime, authorityScope: { tenantId: 'owner-a', consumerId: 'owner-a' } } });
  expect(createPublicKey(state.privateKeyPem).asymmetricKeyType).toBe('ed25519');
});

test('remote-local enrollment never seals state on a failed ceremony', async () => {
  let writes = 0;
  await expect(enrollRemoteLocalDevice({
    brainId: 'brain-a', runtime, credentials: { apiKey: 'api-key', serverUrl: 'https://example.test' },
    fetchImpl: async () => new Response('{}', { status: 503 }),
    writeState: async () => { writes += 1; },
  })).rejects.toThrow('remote-local enrollment start failed (HTTP 503)');
  expect(writes).toBe(0);
});

test('remote-local enrollment reconciles only a stale completion denial with the same proof command', async () => {
  const calls = []; const delays = []; let state;
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) return new Response(JSON.stringify({ data: { enrollment: {
      enrollmentId: 'lde_abcdefghijklmnop', deviceId: 'ldv_abcdefghijklmnop',
      enrollmentSecret: 's'.repeat(43), challenge: 'c'.repeat(43), authorityScope: { tenantId: 'owner-a', consumerId: 'owner-a' },
    } } }), { status: 201 });
    if (calls.length === 2) return new Response('{}', { status: 403 });
    return new Response(JSON.stringify({ data: { device: { deviceId: 'ldv_abcdefghijklmnop' }, connectorCredential: 'ldc1_reconciledcredential' } }), { status: 201 });
  };
  const result = await enrollRemoteLocalDevice({
    brainId: 'brain-a', runtime, credentials: { apiKey: 'api-key', serverUrl: 'https://example.test' }, fetchImpl,
    completionRetryDelaysMs: [7], sleepImpl: async (delay) => { delays.push(delay); },
    writeState: async (next) => { state = next; },
  });
  expect(result).toEqual({ brainId: 'brain-a', deviceId: 'ldv_abcdefghijklmnop' });
  expect(delays).toEqual([7]);
  expect(calls).toHaveLength(3);
  expect(calls[2]).toEqual(calls[1]);
  expect(state.credential).toBe('ldc1_reconciledcredential');
});

test('remote-local enrollment does not retry a non-denial completion failure', async () => {
  let calls = 0; let sleeps = 0;
  await expect(enrollRemoteLocalDevice({
    brainId: 'brain-a', runtime, credentials: { apiKey: 'api-key', serverUrl: 'https://example.test' },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ data: { enrollment: {
        enrollmentId: 'lde_abcdefghijklmnop', deviceId: 'ldv_abcdefghijklmnop',
        enrollmentSecret: 's'.repeat(43), challenge: 'c'.repeat(43), authorityScope: { tenantId: 'owner-a', consumerId: 'owner-a' },
      } } }), { status: 201 });
      return new Response('{}', { status: 503 });
    },
    sleepImpl: async () => { sleeps += 1; }, writeState: async () => {},
  })).rejects.toThrow('remote-local enrollment completion failed (HTTP 503)');
  expect(calls).toBe(2);
  expect(sleeps).toBe(0);
});

test('remote-local enrollment rejects an unbounded injected completion retry schedule', async () => {
  let calls = 0;
  await expect(enrollRemoteLocalDevice({
    brainId: 'brain-a', runtime, credentials: { apiKey: 'api-key', serverUrl: 'https://example.test' },
    completionRetryDelaysMs: [1, 1, 1, 1, 1, 1],
    fetchImpl: async () => { calls += 1; return new Response('{}', { status: 503 }); },
    writeState: async () => {},
  })).rejects.toThrow('retry configuration is invalid');
  expect(calls).toBe(0);
});

test('remote-local enrollment rejects an unexpected connector credential format before sealing state', async () => {
  let calls = 0; let writes = 0;
  await expect(enrollRemoteLocalDevice({
    brainId: 'brain-a', runtime, credentials: { apiKey: 'api-key', serverUrl: 'https://example.test' },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ data: { enrollment: {
        enrollmentId: 'lde_abcdefghijklmnop', deviceId: 'ldv_abcdefghijklmnop',
        enrollmentSecret: 's'.repeat(43), challenge: 'c'.repeat(43), authorityScope: { tenantId: 'owner-a', consumerId: 'owner-a' },
      } } }), { status: 201 });
      return new Response(JSON.stringify({ data: { connectorCredential: 'unexpected_credential' } }), { status: 201 });
    },
    writeState: async () => { writes += 1; },
  })).rejects.toThrow('invalid connectorCredential');
  expect(writes).toBe(0);
});
