/**
 * Sole pre-cutover brain-authorization decision interface (PRD-0052k 0A2).
 *
 * This module deliberately has no HTTP integration and cannot return an
 * allow decision.  It gives later consumers one hard boundary to depend on
 * while the serializable transactional authority, ownership semantics, and
 * cutover remain unapproved.  Archive metadata is read only to compare the
 * migration snapshot; it is never turned into a principal or a grant.
 */

import { createHash } from 'node:crypto';
import type { Brain } from '../types';
import {
  type BrainAuthorizationReadResult,
  legacyBrainOwnershipCandidateFingerprint,
} from './brain-authorization-read-model';

const FENCE_SCHEMA_VERSION = 1;

export interface BrainAuthorizationReadModelLookup {
  inspect(brainId: string): Promise<BrainAuthorizationReadResult>;
}

/** The exact fencing tuple required at permit and event-capability boundaries. */
export interface BrainAuthorizationFence {
  schemaVersion: 1;
  brainId: string;
  fencingEpoch: number;
  ownerPrincipalId: string | null;
  credentialRevision: number;
  hostId: string | null;
  deploymentGeneration: number;
  adapterIdentityVersion: string | null;
  capabilityPolicyRevision: number;
  /** Opaque representation of this exact tuple, not a mutable discovery version. */
  capabilitiesRevision: string;
}

export type LegacyOwnershipShadow =
  | { state: 'not_recorded' }
  | { state: 'match'; candidateFingerprint: string }
  | { state: 'mismatch'; recordedCandidateFingerprint: string; currentCandidateFingerprint: string }
  | { state: 'not_comparable' };

export type BrainAuthorizationDenyReason =
  | 'authorization_not_cut_over'
  | 'ownership_unresolved'
  | 'ownership_ambiguous'
  | 'authorization_record_invalid'
  | 'authorization_store_unavailable'
  | 'legacy_shadow_mismatch';

export interface BrainAuthorizationDecision {
  allowed: false;
  reason: BrainAuthorizationDenyReason;
  fence: BrainAuthorizationFence;
  shadow: LegacyOwnershipShadow;
}

/**
 * Reserved for the later, separately proven transactional authority.  The
 * pre-cutover implementation below never returns this shape.  Naming the
 * positive decision here prevents downstream consumers from inventing a
 * second owner lookup when cutover eventually occurs.
 */
export interface BrainAuthorizationAllowDecision {
  allowed: true;
  ownerPrincipalId: string;
  fence: BrainAuthorizationFence;
}

export type AnyBrainAuthorizationDecision = BrainAuthorizationDecision | BrainAuthorizationAllowDecision;

/**
 * Future owner/admin/principal lifecycle work must replace this deny-only
 * implementation behind this interface; callers may not create a parallel
 * ownership check or use legacy archive data directly.
 */
export interface BrainAuthorizationDecisionAuthority {
  decide(input: { brain: Pick<Brain, 'id' | 'metadata'> }): Promise<AnyBrainAuthorizationDecision>;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function tupleForRevision(fence: Omit<BrainAuthorizationFence, 'schemaVersion' | 'capabilitiesRevision'>): Record<string, unknown> {
  return {
    brainId: fence.brainId,
    fencingEpoch: fence.fencingEpoch,
    ownerPrincipalId: fence.ownerPrincipalId,
    credentialRevision: fence.credentialRevision,
    hostId: fence.hostId,
    deploymentGeneration: fence.deploymentGeneration,
    adapterIdentityVersion: fence.adapterIdentityVersion,
    capabilityPolicyRevision: fence.capabilityPolicyRevision,
  };
}

/**
 * Builds the canonical immutable comparison tuple.  Only the later selected
 * authorization store may advance any of its execution-affecting revisions.
 */
export function createBrainAuthorizationFence(input: Omit<BrainAuthorizationFence, 'schemaVersion' | 'capabilitiesRevision'>): BrainAuthorizationFence {
  if (!validIdentifier(input.brainId)
    || !validRevision(input.fencingEpoch)
    || (input.ownerPrincipalId !== null && !validIdentifier(input.ownerPrincipalId))
    || !validRevision(input.credentialRevision)
    || (input.hostId !== null && !validIdentifier(input.hostId))
    || !validRevision(input.deploymentGeneration)
    || (input.adapterIdentityVersion !== null && !validIdentifier(input.adapterIdentityVersion))
    || !validRevision(input.capabilityPolicyRevision)) {
    throw new Error('Brain authorization fence is invalid.');
  }
  const digest = createHash('sha256').update(JSON.stringify(tupleForRevision(input))).digest('base64url');
  return {
    schemaVersion: FENCE_SCHEMA_VERSION,
    ...input,
    capabilitiesRevision: `v1.${digest}`,
  };
}

/** The inert pre-cutover tuple contains no inferred owner, host, or adapter. */
export function preCutoverBrainAuthorizationFence(brainId: string): BrainAuthorizationFence {
  return createBrainAuthorizationFence({
    brainId,
    fencingEpoch: 0,
    ownerPrincipalId: null,
    credentialRevision: 0,
    hostId: null,
    deploymentGeneration: 0,
    adapterIdentityVersion: null,
    capabilityPolicyRevision: 0,
  });
}

export class FailClosedBrainAuthorizationDecisionAuthority implements BrainAuthorizationDecisionAuthority {
  constructor(private readonly readModel: BrainAuthorizationReadModelLookup) {}

  async decide(input: { brain: Pick<Brain, 'id' | 'metadata'> }): Promise<BrainAuthorizationDecision> {
    if (!validIdentifier(input.brain.id)) throw new Error('Brain identifier is invalid.');
    const fence = preCutoverBrainAuthorizationFence(input.brain.id);
    let inspected: BrainAuthorizationReadResult;
    try {
      inspected = await this.readModel.inspect(input.brain.id);
    } catch {
      // Implementations of this dependency must normally return unavailable,
      // but the decision boundary itself must never widen a thrown read error
      // into an implicit authorization path.
      return { allowed: false, reason: 'authorization_store_unavailable', fence, shadow: { state: 'not_comparable' } };
    }
    if (inspected.disposition === 'unavailable') {
      return { allowed: false, reason: 'authorization_store_unavailable', fence, shadow: { state: 'not_comparable' } };
    }
    if (inspected.disposition === 'invalid') {
      return { allowed: false, reason: 'authorization_record_invalid', fence, shadow: { state: 'not_comparable' } };
    }
    if (!inspected.record.createdAt) {
      return { allowed: false, reason: 'ownership_unresolved', fence, shadow: { state: 'not_recorded' } };
    }

    let currentCandidateFingerprint: string;
    try {
      currentCandidateFingerprint = legacyBrainOwnershipCandidateFingerprint(input.brain);
    } catch {
      // Legacy metadata is untrusted migration evidence. A malformed value
      // cannot turn this decision boundary into an exception-or-allow path.
      return { allowed: false, reason: 'authorization_record_invalid', fence, shadow: { state: 'not_comparable' } };
    }
    const shadow: LegacyOwnershipShadow = currentCandidateFingerprint === inspected.record.candidateFingerprint
      ? { state: 'match', candidateFingerprint: currentCandidateFingerprint }
      : {
        state: 'mismatch',
        recordedCandidateFingerprint: inspected.record.candidateFingerprint,
        currentCandidateFingerprint,
      };
    if (shadow.state === 'mismatch') {
      return { allowed: false, reason: 'legacy_shadow_mismatch', fence, shadow };
    }
    if (inspected.disposition === 'ambiguous') {
      return { allowed: false, reason: 'ownership_ambiguous', fence, shadow };
    }
    return { allowed: false, reason: 'authorization_not_cut_over', fence, shadow };
  }
}
