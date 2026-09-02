import { describe, expect, test } from 'bun:test';
import { createBrainAuthorizationFence, FailClosedBrainAuthorizationDecisionAuthority, type AnyBrainAuthorizationDecision } from '../lib/brain-authorization-decision';
import { HostedBrainMessagingControlPlane } from '../lib/hosted-brain-messaging-control-plane';

const brain = { id: 'brain-a', metadata: {} } as never;
const principal = { kind: 'external' as const, user_id: 'tenant-a', key_id: 'key-a' };
const fence = createBrainAuthorizationFence({ brainId: 'brain-a', fencingEpoch: 4, ownerPrincipalId: 'tenant-a', credentialRevision: 2, hostId: 'host-a', deploymentGeneration: 7, adapterIdentityVersion: 'adapter-v1', capabilityPolicyRevision: 3 });
const target = { brainId: 'brain-a', hostId: 'host-a', deploymentGeneration: 7, isolationClass: 'managed-cloud-sandbox' as const, keyCustody: 'managed-service' as const, hostOwnership: 'managed-by-agentbootup' as const };

function authority(decision: unknown) {
  return { decide: async () => decision } as never;
}
function resolver(value: unknown) {
  return { resolveTarget: async (_brainId: string, _capabilitiesRevision: string) => value } as never;
}

describe('HostedBrainMessagingControlPlane', () => {
  test('returns only a matched explicit owner, opaque fence, and metadata-only hosted target', async () => {
    let requestedFence: string | null = null;
    const result = await new HostedBrainMessagingControlPlane(authority({ allowed: true, ownerPrincipalId: 'tenant-a', fence }), {
      resolveTarget: async (_brainId: string, capabilitiesRevision: string) => { requestedFence = capabilitiesRevision; return target; },
    }).resolve({ brain, principal });
    expect(result).toEqual({ permitted: true, fence, target });
    expect(requestedFence).toBe(fence.capabilitiesRevision);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/token|secret|password|db_url|endpoint|archive_tenant_id/i);
  });

  test('does not promote the existing fail-closed authority into a permit', async () => {
    const readModel = { inspect: async () => ({ disposition: 'unresolved' as const, record: { createdAt: '', brainId: 'brain-a', candidateFingerprint: '', candidateTenantId: null, candidateSources: [], disposition: 'unresolved' as const, schemaVersion: 1 } }) };
    const result = await new HostedBrainMessagingControlPlane(new FailClosedBrainAuthorizationDecisionAuthority(readModel), resolver(target)).resolve({ brain, principal });
    expect(result).toEqual({ permitted: false, reason: 'authorization_denied' });
  });

  test('denies cross-tenant, admin, and cross-brain access before a destination can be used', async () => {
    const control = new HostedBrainMessagingControlPlane(authority({ allowed: true, ownerPrincipalId: 'tenant-a', fence }), resolver(target));
    expect(await control.resolve({ brain, principal: { ...principal, user_id: 'tenant-b' } })).toEqual({ permitted: false, reason: 'principal_not_owner' });
    expect(await control.resolve({ brain, principal: { kind: 'admin', credential_id: 'admin-a' } })).toEqual({ permitted: false, reason: 'principal_not_owner' });
    expect(await control.resolve({ brain: { ...brain, id: 'brain-b' }, principal })).toEqual({ permitted: false, reason: 'authorization_invalid' });
  });

  test('denies absent, throwing, local, malformed, and stale targets', async () => {
    const decision = { allowed: true, ownerPrincipalId: 'tenant-a', fence } satisfies AnyBrainAuthorizationDecision;
    expect(await new HostedBrainMessagingControlPlane(authority(decision), resolver(null)).resolve({ brain, principal })).toEqual({ permitted: false, reason: 'target_unavailable' });
    expect(await new HostedBrainMessagingControlPlane(authority(decision), { resolveTarget: async () => { throw new Error('down'); } }).resolve({ brain, principal })).toEqual({ permitted: false, reason: 'target_unavailable' });
    expect(await new HostedBrainMessagingControlPlane(authority(decision), resolver({ ...target, isolationClass: 'user-owned-local-host', keyCustody: 'user-device', hostOwnership: 'owned-by-user' })).resolve({ brain, principal })).toEqual({ permitted: false, reason: 'target_invalid' });
    expect(await new HostedBrainMessagingControlPlane(authority(decision), resolver({ ...target, hostId: 'host-b' })).resolve({ brain, principal })).toEqual({ permitted: false, reason: 'target_stale' });
    expect(await new HostedBrainMessagingControlPlane(authority(decision), resolver({ ...target, endpoint: 'https://forbidden.example', db_token: 'forbidden' })).resolve({ brain, principal })).toEqual({ permitted: false, reason: 'target_invalid' });
  });

  test('denies throwing and malformed authority decisions and forged fence revisions', async () => {
    const control = new HostedBrainMessagingControlPlane({ decide: async () => { throw new Error('down'); } }, resolver(target));
    expect(await control.resolve({ brain, principal })).toEqual({ permitted: false, reason: 'authorization_denied' });
    expect(await new HostedBrainMessagingControlPlane(authority({ allowed: false, reason: 'authorization_not_cut_over', fence, shadow: { state: 'not_comparable' } }), resolver(target)).resolve({ brain, principal })).toEqual({ permitted: false, reason: 'authorization_denied' });
    expect(await new HostedBrainMessagingControlPlane(authority({ allowed: true, ownerPrincipalId: 'tenant-a', fence: { ...fence, capabilitiesRevision: 'forged' } }), resolver(target)).resolve({ brain, principal })).toEqual({ permitted: false, reason: 'authorization_invalid' });
    expect(await new HostedBrainMessagingControlPlane(authority({ allowed: true, ownerPrincipalId: 'tenant-a', fence: { ...fence, ownerPrincipalId: null } }), resolver(target)).resolve({ brain, principal })).toEqual({ permitted: false, reason: 'authorization_invalid' });
  });
});
