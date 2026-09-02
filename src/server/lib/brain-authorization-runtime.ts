import { AgentHostControlPlaneStore } from './agent-host-control-plane-store';
import {
  BrainAuthorizationAuthorityRepository,
  DurableBrainAuthorizationDecisionAuthority,
  type BrainAuthorizationAuthorityCasClient,
} from './brain-authorization-authority-repository';
import { FailClosedBrainAuthorizationDecisionAuthority, type BrainAuthorizationDecisionAuthority } from './brain-authorization-decision';
import { HostedBrainMessagingControlPlane } from './hosted-brain-messaging-control-plane';
import { BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX, BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH } from './brain-authorization-limits';

export { BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX, BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH } from './brain-authorization-limits';

export type BrainAuthorizationRuntimeMode = 'disabled' | 'durable';
export interface BrainAuthorizationBootstrapOwner { brainId: string; ownerPrincipalId: string }

interface RuntimeInput {
  mode: BrainAuthorizationRuntimeMode;
  documents: ConstructorParameters<typeof AgentHostControlPlaneStore>[0];
  cas?: BrainAuthorizationAuthorityCasClient;
  bootstrapCohort?: readonly BrainAuthorizationBootstrapOwner[];
  adapterIdentity?: string;
  adapterVersion?: string;
}

export interface BrainAuthorizationRuntime {
  authority: BrainAuthorizationDecisionAuthority;
  agentHosts: AgentHostControlPlaneStore;
  hostedMessaging: HostedBrainMessagingControlPlane;
  /** Private durable seam for local-device admission; absent in deny-only mode. */
  repository: BrainAuthorizationAuthorityRepository | null;
}

function validMemberId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validAdapterId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertCas(value: unknown): asserts value is BrainAuthorizationAuthorityCasClient {
  if (!value || typeof value !== 'object'
    || typeof (value as BrainAuthorizationAuthorityCasClient).getDocument !== 'function'
    || typeof (value as BrainAuthorizationAuthorityCasClient).createDocument !== 'function'
    || typeof (value as BrainAuthorizationAuthorityCasClient).updateDocument !== 'function') {
    throw new Error('Durable brain authority CAS client is incompatible.');
  }
}

function denyOnlyAuthority(): BrainAuthorizationDecisionAuthority {
  return new FailClosedBrainAuthorizationDecisionAuthority({ inspect: async () => ({ disposition: 'unavailable' }) });
}

/** Build and preflight the private cutover before the HTTP listener starts. */
export async function createBrainAuthorizationRuntime(input: RuntimeInput): Promise<BrainAuthorizationRuntime> {
  if (input.mode === 'disabled') {
    const authority = denyOnlyAuthority();
    const agentHosts = new AgentHostControlPlaneStore(input.documents);
    return { authority, agentHosts, hostedMessaging: new HostedBrainMessagingControlPlane(authority, agentHosts), repository: null };
  }

  assertCas(input.cas);
  if (!validAdapterId(input.adapterIdentity) || !validAdapterId(input.adapterVersion)) throw new Error('Durable brain authority adapter identity/version is invalid.');
  if (!Array.isArray(input.bootstrapCohort) || input.bootstrapCohort.length === 0 || input.bootstrapCohort.length > BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX) throw new Error('Durable brain authority requires a bounded explicit bootstrap cohort.');
  const owners = new Map<string, string>();
  for (const member of input.bootstrapCohort) {
    if (!member || typeof member !== 'object' || !validMemberId(member.brainId) || !validMemberId(member.ownerPrincipalId)) {
      throw new Error('Durable brain authority bootstrap cohort is invalid.');
    }
    if (owners.has(member.brainId)) throw new Error('Durable brain authority bootstrap cohort contains a duplicate or conflicting brain.');
    owners.set(member.brainId, member.ownerPrincipalId);
  }

  const repository = new BrainAuthorizationAuthorityRepository(input.cas);
  for (const [brainId, expectedOwner] of owners) {
    const inspected = await repository.inspect(brainId);
    if (inspected.disposition === 'unavailable') throw new Error('Durable brain authority startup preflight failed.');
    if (inspected.disposition === 'invalid') throw new Error('Durable brain authority startup preflight found invalid state.');
    if (inspected.disposition === 'current' && inspected.record.owner_principal_id !== expectedOwner) {
      throw new Error('Durable brain authority bootstrap cohort conflicts with current ownership.');
    }
    if (inspected.disposition === 'current'
      && (inspected.record.adapter_identity !== input.adapterIdentity || inspected.record.adapter_version !== input.adapterVersion)) {
      throw new Error('Durable brain authority current adapter identity/version conflicts with configured adapter.');
    }
  }

  const authority = new DurableBrainAuthorizationDecisionAuthority(repository);
  const agentHosts = new AgentHostControlPlaneStore(input.documents, {
    repository, bootstrapOwners: owners, adapterIdentity: input.adapterIdentity, adapterVersion: input.adapterVersion,
  });
  return { authority, agentHosts, hostedMessaging: new HostedBrainMessagingControlPlane(authority, agentHosts), repository };
}
