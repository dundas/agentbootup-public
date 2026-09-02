/**
 * Private composition boundary for the hosted-brain messaging pilot.
 *
 * This owns neither the authorization record nor host enrollment.  It only
 * joins the sole authorization-decision interface to a resolved, credential-
 * free hosted target and denies on every malformed or stale state.  It is not
 * an HTTP handler and deliberately has no URL, token, provisioning, or Vault
 * input surface.
 */

import type { AgentHostEndpointTarget, AuthPrincipal, Brain } from '../types';
import {
  createBrainAuthorizationFence,
  type AnyBrainAuthorizationDecision,
  type BrainAuthorizationDecisionAuthority,
  type BrainAuthorizationFence,
} from './brain-authorization-decision';

export interface ActiveHostedBrainTargetResolver {
  resolveTarget(brainId: string, expectedCapabilitiesRevision: string): Promise<AgentHostEndpointTarget | null>;
}

export type HostedBrainMessagingDenyReason =
  | 'principal_not_owner'
  | 'authorization_denied'
  | 'authorization_invalid'
  | 'target_unavailable'
  | 'target_invalid'
  | 'target_stale';

export type HostedBrainMessagingResolution =
  | { permitted: true; fence: BrainAuthorizationFence; target: AgentHostEndpointTarget }
  | { permitted: false; reason: HostedBrainMessagingDenyReason };

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validFence(value: unknown): value is BrainAuthorizationFence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fence = value as Record<string, unknown>;
  if (fence.schemaVersion !== 1
    || !validIdentifier(fence.brainId)
    || !validRevision(fence.fencingEpoch)
    || !validIdentifier(fence.ownerPrincipalId)
    || !validRevision(fence.credentialRevision)
    || !validIdentifier(fence.hostId)
    || !validRevision(fence.deploymentGeneration)
    || !validIdentifier(fence.adapterIdentityVersion)
    || !validRevision(fence.capabilityPolicyRevision)
    || typeof fence.capabilitiesRevision !== 'string') return false;
  try {
    return createBrainAuthorizationFence({
      brainId: fence.brainId,
      fencingEpoch: fence.fencingEpoch,
      ownerPrincipalId: fence.ownerPrincipalId,
      credentialRevision: fence.credentialRevision,
      hostId: fence.hostId,
      deploymentGeneration: fence.deploymentGeneration,
      adapterIdentityVersion: fence.adapterIdentityVersion,
      capabilityPolicyRevision: fence.capabilityPolicyRevision,
    }).capabilitiesRevision === fence.capabilitiesRevision;
  } catch { return false; }
}

function validHostedTarget(value: unknown, brainId: string): value is AgentHostEndpointTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  const keys = Object.keys(target).sort();
  return keys.length === 6
    && keys.every((key, index) => key === ['brainId', 'deploymentGeneration', 'hostId', 'hostOwnership', 'isolationClass', 'keyCustody'][index])
    && target.brainId === brainId
    && validIdentifier(target.hostId)
    && Number.isSafeInteger(target.deploymentGeneration) && (target.deploymentGeneration as number) > 0
    && target.isolationClass === 'managed-cloud-sandbox'
    && target.keyCustody === 'managed-service'
    && target.hostOwnership === 'managed-by-agentbootup';
}

function allowedDecision(value: AnyBrainAuthorizationDecision): value is Extract<AnyBrainAuthorizationDecision, { allowed: true }> {
  return value.allowed === true
    && validIdentifier((value as { ownerPrincipalId?: unknown }).ownerPrincipalId)
    && validFence((value as { fence?: unknown }).fence)
    && value.ownerPrincipalId === value.fence.ownerPrincipalId;
}

/**
 * Resolve one external request to its fenced hosted destination.  A caller
 * cannot supply a destination, database, transport URL, or credential; the
 * returned target is metadata-only and is not executable by this module.
 */
export class HostedBrainMessagingControlPlane {
  constructor(
    private readonly authority: BrainAuthorizationDecisionAuthority,
    private readonly targets: ActiveHostedBrainTargetResolver,
  ) {}

  async resolve(input: { brain: Pick<Brain, 'id' | 'metadata'>; principal: AuthPrincipal }): Promise<HostedBrainMessagingResolution> {
    if (input.principal.kind !== 'external') return { permitted: false, reason: 'principal_not_owner' };
    let decision: AnyBrainAuthorizationDecision;
    try { decision = await this.authority.decide({ brain: input.brain }); }
    catch { return { permitted: false, reason: 'authorization_denied' }; }
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return { permitted: false, reason: 'authorization_invalid' };
    if (decision.allowed !== true) return { permitted: false, reason: 'authorization_denied' };
    if (!allowedDecision(decision) || decision.fence.brainId !== input.brain.id) return { permitted: false, reason: 'authorization_invalid' };
    if (decision.ownerPrincipalId !== input.principal.user_id) return { permitted: false, reason: 'principal_not_owner' };
    let target: AgentHostEndpointTarget | null;
    try { target = await this.targets.resolveTarget(input.brain.id, decision.fence.capabilitiesRevision); }
    catch { return { permitted: false, reason: 'target_unavailable' }; }
    if (!target) return { permitted: false, reason: 'target_unavailable' };
    if (!validHostedTarget(target, input.brain.id)) return { permitted: false, reason: 'target_invalid' };
    if (target.hostId !== decision.fence.hostId || target.deploymentGeneration !== decision.fence.deploymentGeneration) {
      return { permitted: false, reason: 'target_stale' };
    }
    return { permitted: true, fence: decision.fence, target };
  }
}
