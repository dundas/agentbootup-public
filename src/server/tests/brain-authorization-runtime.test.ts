import { describe, expect, test } from 'bun:test';
import {
  BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX,
  BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH,
  createBrainAuthorizationRuntime,
} from '../lib/brain-authorization-runtime';
import { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';
import { MemoryAuthorityCas } from './helpers/memory-authority-cas';

const documents = { getDocument: async () => null, createDocumentWithId: async () => 'id', updateDocument: async () => undefined } as never;
const cohort = [{ brainId: 'brain-a', ownerPrincipalId: 'user-a' }] as const;

describe('brain authorization runtime composition', () => {
  test('default-off composition is deny-only', async () => {
    const runtime = await createBrainAuthorizationRuntime({ mode: 'disabled', documents });
    expect(await runtime.authority.decide({ brain: { id: 'brain-a', metadata: {} } as never })).toMatchObject({ allowed: false, reason: 'authorization_store_unavailable' });
    await expect(runtime.agentHosts.resolveTarget('brain-a', 'v1.disabled')).rejects.toMatchObject({ code: 'authority_not_enabled' });
  });

  test('durable composition preflights the cohort and selects one shared authority', async () => {
    const cas = new MemoryAuthorityCas();
    const runtime = await createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: cas.client(), bootstrapCohort: cohort, adapterIdentity: 'circle-agent', adapterVersion: '1' });
    expect(await runtime.authority.decide({ brain: { id: 'brain-a', metadata: {} } as never })).toMatchObject({ allowed: false, reason: 'ownership_unresolved' });
  });

  test('selected durable mode fails startup closed on incompatible, unavailable, duplicate, and conflicting state', async () => {
    await expect(createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: {} as never, bootstrapCohort: cohort, adapterIdentity: 'circle-agent', adapterVersion: '1' })).rejects.toThrow('incompatible');
    const unavailable = new MemoryAuthorityCas(); unavailable.available = false;
    await expect(createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: unavailable.client(), bootstrapCohort: cohort, adapterIdentity: 'circle-agent', adapterVersion: '1' })).rejects.toThrow('preflight failed');
    await expect(createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: new MemoryAuthorityCas().client(), bootstrapCohort: [...cohort, ...cohort], adapterIdentity: 'circle-agent', adapterVersion: '1' })).rejects.toThrow('duplicate or conflicting');

    const cas = new MemoryAuthorityCas();
    await new BrainAuthorizationAuthorityRepository(cas.client()).execute({ kind: 'bootstrap', commandId: 'bootstrap', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: 'user-b' }, ownerPrincipalId: 'user-b', targetId: 'host-a', hostId: 'host-a', deploymentGeneration: 1, adapterIdentity: 'circle-agent', adapterVersion: '1' });
    await expect(createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: cas.client(), bootstrapCohort: cohort, adapterIdentity: 'circle-agent', adapterVersion: '1' })).rejects.toThrow('conflicts with current ownership');
  });

  test('selected durable mode fails startup when current adapter identity or version differs', async () => {
    for (const [adapterIdentity, adapterVersion] of [['other-agent', '1'], ['circle-agent', '2']] as const) {
      const cas = new MemoryAuthorityCas();
      await new BrainAuthorizationAuthorityRepository(cas.client()).execute({ kind: 'bootstrap', commandId: 'bootstrap', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: 'user-a' }, ownerPrincipalId: 'user-a', targetId: 'host-a', hostId: 'host-a', deploymentGeneration: 1, adapterIdentity, adapterVersion });
      await expect(createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: cas.client(), bootstrapCohort: cohort, adapterIdentity: 'circle-agent', adapterVersion: '1' })).rejects.toThrow('adapter');
    }
  });

  test('bootstrap cohort accepts the explicit maximum and rejects max plus one and oversized member ids', async () => {
    const atMax = Array.from({ length: BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX }, (_, index) => ({ brainId: `brain-${index}`, ownerPrincipalId: `user-${index}` }));
    await expect(createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: new MemoryAuthorityCas().client(), bootstrapCohort: atMax, adapterIdentity: 'circle-agent', adapterVersion: '1' })).resolves.toBeDefined();
    await expect(createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: new MemoryAuthorityCas().client(), bootstrapCohort: [{ brainId: 'b'.repeat(BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH), ownerPrincipalId: 'user-a' }], adapterIdentity: 'circle-agent', adapterVersion: '1' })).resolves.toBeDefined();
    await expect(createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: new MemoryAuthorityCas().client(), bootstrapCohort: [...atMax, { brainId: 'one-too-many', ownerPrincipalId: 'user-over' }], adapterIdentity: 'circle-agent', adapterVersion: '1' })).rejects.toThrow('cohort');
    await expect(createBrainAuthorizationRuntime({ mode: 'durable', documents, cas: new MemoryAuthorityCas().client(), bootstrapCohort: [{ brainId: 'b'.repeat(BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH + 1), ownerPrincipalId: 'user-a' }], adapterIdentity: 'circle-agent', adapterVersion: '1' })).rejects.toThrow('cohort');
  });
});
