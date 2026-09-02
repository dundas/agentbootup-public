/**
 * AgentHost Protocol v1 control-plane state.
 *
 * This stores enrollment/credential evidence and grants only. Durable brain
 * authority is the sole writer of active target and generation state. It does not
 * open listeners, proxy bytes, mint environment grants, or store host private
 * keys. A future transport adapter consumes the resolved target only after the
 * separate PRD-0052 production gate passes.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MechDocument } from '../types';
import type { MechDocumentStore } from './mech-document-store';
import type {
  AgentHostDesiredState,
  AgentHostDisclosure,
  AgentHostEndpointTarget,
  AgentHostEnrollmentChallenge,
  AgentHostRecord,
  AgentHostSessionGrant,
  AgentHostSessionOperation,
} from '../types';
import { HttpError } from '../errors';
import type { AuthPrincipal } from '../types';
import {
  brainAuthorizationAuthorityCommandDigest,
  type AuthorityInspection,
  type BrainAuthorizationAuthorityCommand,
  type BrainAuthorizationAuthorityRepository,
} from './brain-authorization-authority-repository';
import type { BrainAuthorizationFence } from './brain-authorization-decision';

const HOSTS_COLLECTION = 'agentbootup_agent_host_records';
const ENROLLMENTS_COLLECTION = 'agentbootup_agent_host_enrollments';
const GRANTS_COLLECTION = 'agentbootup_agent_host_session_grants';

const ENROLLMENT_TTL_SECONDS = 10 * 60;
const MIN_GRANT_TTL_SECONDS = 30;
const MAX_GRANT_TTL_SECONDS = 10 * 60;
const VALID_OPERATIONS = new Set<AgentHostSessionOperation>(['turn.submit', 'event.stream', 'session.cancel']);
const ENROLLMENT_KEYS = [
  'brainId', 'consumedAt', 'consumedCommandDigest', 'consumedCommandId', 'createdAt', 'createdByCredentialId',
  'enrollmentId', 'expectedPreMutationCapabilitiesRevision', 'expiresAt', 'hostId', 'hostOwnership',
  'intendedCommandDigest', 'intendedCommandId', 'intendedCommandKind', 'intendedDeploymentGeneration',
  'isolationClass', 'keyCustody', 'ownerPrincipalId', 'publicKeyFingerprint', 'secretHash',
];
const GRANT_KEYS = [
  'audienceCredentialId', 'brainId', 'capabilitiesRevision', 'createdAt', 'deploymentGeneration', 'expiresAt',
  'grantId', 'hostId', 'operations', 'revokedAt', 'secretHash',
];

interface AgentHostControlPlaneDocumentStore extends MechDocumentStore {
  getDocument(id: string): Promise<MechDocument | null>;
  createDocumentWithId(collection: string, id: string, data: Record<string, unknown>): Promise<string>;
}

interface EnrollmentRecord extends AgentHostDisclosure {
  enrollmentId: string;
  secretHash: string;
  brainId: string;
  hostId: string;
  publicKeyFingerprint: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedCommandId: string | null;
  consumedCommandDigest: string | null;
  intendedCommandKind: 'bootstrap' | 'target_replace' | null;
  intendedCommandId: string | null;
  intendedCommandDigest: string | null;
  expectedPreMutationCapabilitiesRevision: string | null;
  intendedDeploymentGeneration: number | null;
  createdByCredentialId: string;
  ownerPrincipalId: string;
  createdAt: string;
}

interface HostEvidence extends AgentHostDisclosure {
  schemaVersion: 1;
  authorityCommandId: string;
  authorityCommandDigest: string;
  brainId: string;
  hostId: string;
  publicKeyFingerprint: string;
  enrolledByCredentialId: string;
  ownerPrincipalId: string;
  enrolledAt: string;
}

interface DurableAuthorityCutover {
  repository: BrainAuthorizationAuthorityRepository;
  bootstrapOwners: ReadonlyMap<string, string>;
  adapterIdentity: string;
  adapterVersion: string;
}

export interface AgentHostOwnershipSignal {
  /** Presence only. Legacy metadata is never interpreted as an owner identity. */
  legacyArchiveTenantIdPresent: boolean;
}

interface SessionGrantRecord {
  grantId: string;
  secretHash: string;
  brainId: string;
  hostId: string;
  deploymentGeneration: number;
  capabilitiesRevision: string;
  audienceCredentialId: string;
  operations: AgentHostSessionOperation[];
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
}

function docId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function sameSecret(expectedHash: string, value: string): boolean {
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(secretHash(value), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isPast(value: string, now: Date): boolean {
  const parsed = Date.parse(value);
  return !Number.isFinite(parsed) || parsed <= now.getTime();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validStoredIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validGeneratedId(value: unknown, prefix: 'ahe' | 'ahg'): value is string {
  if (typeof value !== 'string') return false;
  return prefix === 'ahe'
    ? /^ahe_[A-Za-z0-9_-]{24}$/.test(value)
    : /^ahg_[A-Za-z0-9_-]{24}$/.test(value);
}

function validSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validOpaqueDigest(value: unknown): value is string {
  return typeof value === 'string' && /^v1\.[A-Za-z0-9_-]{43}$/.test(value);
}

function validCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactFence(left: BrainAuthorizationFence, right: BrainAuthorizationFence): boolean {
  return left.schemaVersion === right.schemaVersion && left.brainId === right.brainId
    && left.fencingEpoch === right.fencingEpoch && left.ownerPrincipalId === right.ownerPrincipalId
    && left.credentialRevision === right.credentialRevision && left.hostId === right.hostId
    && left.deploymentGeneration === right.deploymentGeneration
    && left.adapterIdentityVersion === right.adapterIdentityVersion
    && left.capabilityPolicyRevision === right.capabilityPolicyRevision
    && left.capabilitiesRevision === right.capabilitiesRevision;
}

function target(host: HostEvidence, deploymentGeneration: number): AgentHostEndpointTarget {
  return {
    brainId: host.brainId,
    hostId: host.hostId,
    deploymentGeneration,
    isolationClass: host.isolationClass,
    keyCustody: host.keyCustody,
    hostOwnership: host.hostOwnership,
  };
}

function hostEvidenceDocumentId(brainId: string, hostId: string, capabilitiesRevision: string): string {
  return docId('agent_host', [brainId, hostId, capabilitiesRevision]);
}

function evidenceMatchesAuthority(
  evidence: HostEvidence,
  authority: Extract<AuthorityInspection, { disposition: 'current' }>,
): boolean {
  return evidence.brainId === authority.fence.brainId
    && evidence.hostId === authority.fence.hostId
    && evidence.ownerPrincipalId === authority.fence.ownerPrincipalId
    && evidence.authorityCommandId === authority.record.last_command_id
    && evidence.authorityCommandDigest === authority.record.last_command_digest;
}

function sameHostEvidence(left: HostEvidence, right: HostEvidence): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.authorityCommandId === right.authorityCommandId
    && left.authorityCommandDigest === right.authorityCommandDigest
    && left.brainId === right.brainId && left.hostId === right.hostId
    && left.publicKeyFingerprint === right.publicKeyFingerprint
    && left.isolationClass === right.isolationClass && left.keyCustody === right.keyCustody
    && left.hostOwnership === right.hostOwnership
    && left.enrolledByCredentialId === right.enrolledByCredentialId
    && left.ownerPrincipalId === right.ownerPrincipalId && left.enrolledAt === right.enrolledAt;
}

function parseHostEvidence(value: unknown): HostEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'authorityCommandDigest,authorityCommandId,brainId,enrolledAt,enrolledByCredentialId,hostId,hostOwnership,isolationClass,keyCustody,ownerPrincipalId,publicKeyFingerprint,schemaVersion'
    || v.schemaVersion !== 1
    || !validStoredIdentifier(v.authorityCommandId) || !validOpaqueDigest(v.authorityCommandDigest)
    || !validStoredIdentifier(v.brainId) || !validStoredIdentifier(v.hostId)
    || !validSha256Hex(v.publicKeyFingerprint) || !isDisclosure(v)
    || !validStoredIdentifier(v.enrolledByCredentialId) || !validStoredIdentifier(v.ownerPrincipalId)
    || !validCanonicalTimestamp(v.enrolledAt)
  ) return null;
  return v as unknown as HostEvidence;
}

function isSupportedDisclosure(value: AgentHostDisclosure): boolean {
  return value.isolationClass === 'managed-cloud-sandbox'
    && value.keyCustody === 'managed-service'
    && value.hostOwnership === 'managed-by-agentbootup';
}

function isDisclosure(v: Record<string, unknown>): boolean {
  return isSupportedDisclosure(v as AgentHostDisclosure);
}

function parseEnrollment(value: unknown): EnrollmentRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    !exactKeys(v, ENROLLMENT_KEYS)
    || !validGeneratedId(v.enrollmentId, 'ahe') || !validSha256Hex(v.secretHash)
    || !validStoredIdentifier(v.brainId) || !validStoredIdentifier(v.hostId)
    || !validSha256Hex(v.publicKeyFingerprint) || !validCanonicalTimestamp(v.createdAt)
    || !validCanonicalTimestamp(v.expiresAt) || Date.parse(v.expiresAt) <= Date.parse(v.createdAt)
    || (v.consumedAt !== null && (!validCanonicalTimestamp(v.consumedAt)
      || Date.parse(v.consumedAt) < Date.parse(v.createdAt) || Date.parse(v.consumedAt) > Date.parse(v.expiresAt)))
    || (v.consumedCommandId !== null && typeof v.consumedCommandId !== 'string')
    || (v.consumedCommandDigest !== null && !validOpaqueDigest(v.consumedCommandDigest))
    || !['bootstrap', 'target_replace', null].includes(v.intendedCommandKind as never)
    || (v.intendedCommandId !== null && typeof v.intendedCommandId !== 'string')
    || (v.intendedCommandDigest !== null && !validOpaqueDigest(v.intendedCommandDigest))
    || (v.expectedPreMutationCapabilitiesRevision !== null && v.expectedPreMutationCapabilitiesRevision !== 'missing'
      && !validOpaqueDigest(v.expectedPreMutationCapabilitiesRevision))
    || (v.intendedDeploymentGeneration !== null && (!Number.isSafeInteger(v.intendedDeploymentGeneration) || (v.intendedDeploymentGeneration as number) < 1))
    || ((v.intendedCommandKind === null) !== (v.intendedCommandId === null && v.intendedCommandDigest === null
      && v.expectedPreMutationCapabilitiesRevision === null && v.intendedDeploymentGeneration === null))
    || (v.intendedCommandKind === 'bootstrap' && v.expectedPreMutationCapabilitiesRevision !== 'missing')
    || (v.intendedCommandKind === 'target_replace' && (v.expectedPreMutationCapabilitiesRevision === 'missing' || v.expectedPreMutationCapabilitiesRevision === null))
    || (v.consumedAt === null ? v.consumedCommandId !== null || v.consumedCommandDigest !== null
      : v.consumedCommandId !== v.intendedCommandId || v.consumedCommandDigest !== v.intendedCommandDigest)
    || (v.intendedCommandId !== null && v.intendedCommandId !== `agent-host-enrollment:${v.enrollmentId}`)
    || !validStoredIdentifier(v.createdByCredentialId) || !validStoredIdentifier(v.ownerPrincipalId)
    || !isDisclosure(v)
  ) return null;
  return v as unknown as EnrollmentRecord;
}

function parseGrant(value: unknown): SessionGrantRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    !exactKeys(v, GRANT_KEYS)
    || !validGeneratedId(v.grantId, 'ahg') || !validSha256Hex(v.secretHash)
    || !validStoredIdentifier(v.brainId) || !validStoredIdentifier(v.hostId)
    || typeof v.deploymentGeneration !== 'number' || !Number.isSafeInteger(v.deploymentGeneration) || v.deploymentGeneration < 1
    || !validOpaqueDigest(v.capabilitiesRevision)
    || !validStoredIdentifier(v.audienceCredentialId) || !Array.isArray(v.operations) || v.operations.length === 0
    || !v.operations.every((op) => VALID_OPERATIONS.has(op as AgentHostSessionOperation))
    || new Set(v.operations).size !== v.operations.length
    || !validCanonicalTimestamp(v.createdAt) || !validCanonicalTimestamp(v.expiresAt)
    || Date.parse(v.expiresAt) <= Date.parse(v.createdAt)
    || (v.revokedAt !== null && (!validCanonicalTimestamp(v.revokedAt) || Date.parse(v.revokedAt) < Date.parse(v.createdAt)))
  ) return null;
  return v as unknown as SessionGrantRecord;
}

/**
 * A process-local lock closes same-instance enrollment-evidence races only.
 * Cross-instance execution authority is fenced by Mech Storage single-document
 * CAS in BrainAuthorizationAuthorityRepository.
 */
export class AgentHostControlPlaneStore {
  private locks = new Map<string, Promise<void>>();

  constructor(
    private mech: AgentHostControlPlaneDocumentStore,
    private readonly cutover?: DurableAuthorityCutover,
  ) {}

  private requireOwner(brainId: string, principal: AuthPrincipal, ownershipSignal: AgentHostOwnershipSignal): Extract<AuthPrincipal, { kind: 'external' }> {
    if (!this.cutover) throw new HttpError(503, 'authority_not_enabled', 'Durable brain authority is not enabled.');
    if (!ownershipSignal || ownershipSignal.legacyArchiveTenantIdPresent !== false) throw new HttpError(409, 'legacy_ownership_conflict', 'Legacy ownership metadata is present; durable AgentHost operations are denied.');
    if (principal.kind !== 'external') throw new HttpError(403, 'forbidden', 'Only the external brain owner may manage a host.');
    const expectedOwner = this.cutover.bootstrapOwners.get(brainId);
    if (!expectedOwner) throw new HttpError(403, 'authority_owner_unresolved', 'Brain ownership is not in the bounded bootstrap cohort.');
    if (expectedOwner !== principal.user_id) throw new HttpError(403, 'forbidden', 'Only the external brain owner may manage a host.');
    return principal;
  }

  private async currentAuthority(brainId: string) {
    if (!this.cutover) throw new HttpError(503, 'authority_not_enabled', 'Durable brain authority is not enabled.');
    const inspected = await this.cutover.repository.inspect(brainId);
    if (inspected.disposition === 'unavailable') throw new HttpError(503, 'authority_unavailable', 'Durable brain authority is unavailable.');
    if (inspected.disposition === 'invalid') throw new HttpError(503, 'authority_invalid', 'Durable brain authority is invalid.');
    return inspected;
  }

  private authorityFailure(status: 'conflict' | 'denied' | 'unavailable'): never {
    if (status === 'conflict') throw new HttpError(409, 'authority_conflict', 'Durable brain authority changed; retry from current state.');
    if (status === 'unavailable') throw new HttpError(503, 'authority_unavailable', 'Durable brain authority is unavailable.');
    throw new HttpError(403, 'forbidden', 'Durable brain authority denied the command.');
  }

  private authorityIsExecutable(
    inspected: AuthorityInspection,
    ownerPrincipalId: string,
    hostId?: string,
  ): inspected is Extract<AuthorityInspection, { disposition: 'current' }> {
    return inspected.disposition === 'current'
      && inspected.record.owner_status === 'active'
      && inspected.record.owner_principal_id === ownerPrincipalId
      && inspected.record.target_disposition === 'active'
      && inspected.record.target_id === inspected.record.host_id
      && (hostId === undefined || inspected.record.host_id === hostId)
      && inspected.record.adapter_disposition === 'selected'
      && inspected.record.adapter_identity === this.cutover!.adapterIdentity
      && inspected.record.adapter_version === this.cutover!.adapterVersion;
  }

  private async withBrainLock<T>(brainId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(brainId) ?? Promise.resolve();
    let value: T | undefined;
    let thrown: unknown;
    const current = previous.catch(() => undefined).then(async () => {
      try { value = await task(); } catch (error) { thrown = error; }
    });
    this.locks.set(brainId, current);
    await current;
    if (this.locks.get(brainId) === current) this.locks.delete(brainId);
    if (thrown !== undefined) throw thrown;
    return value as T;
  }

  private async read<T>(collection: string, id: string, parser: (value: unknown) => T | null): Promise<{ value: T; docId: string } | null> {
    const doc = await this.mech.getDocument(id);
    if (!doc) return null;
    const value = parser(doc.document);
    if (!value) throw new HttpError(503, 'control_plane_state_invalid', 'Control-plane state is invalid; refusing to authorize work.');
    return { value, docId: doc.document_id };
  }

  private async persistHostEvidence(evidence: HostEvidence, capabilitiesRevision: string): Promise<void> {
    const id = hostEvidenceDocumentId(evidence.brainId, evidence.hostId, capabilitiesRevision);
    const existing = await this.read(HOSTS_COLLECTION, id, parseHostEvidence);
    if (existing) {
      if (sameHostEvidence(existing.value, evidence)) return;
      throw new HttpError(503, 'control_plane_state_invalid', 'Authority-bound host evidence conflicts; refusing to authorize work.');
    }
    try {
      await this.mech.createDocumentWithId(HOSTS_COLLECTION, id, evidence as unknown as Record<string, unknown>);
    } catch (error) {
      const raced = await this.read(HOSTS_COLLECTION, id, parseHostEvidence);
      if (raced && sameHostEvidence(raced.value, evidence)) return;
      if (raced) throw new HttpError(503, 'control_plane_state_invalid', 'Authority-bound host evidence conflicts; refusing to authorize work.');
      throw error;
    }
  }

  async createEnrollment(input: {
    brainId: string; hostId: string; publicKeyFingerprint: string;
    disclosure: AgentHostDisclosure; principal: AuthPrincipal; ownershipSignal: AgentHostOwnershipSignal; now?: Date;
  }): Promise<AgentHostEnrollmentChallenge> {
    const owner = this.requireOwner(input.brainId, input.principal, input.ownershipSignal);
    if (!isSupportedDisclosure(input.disclosure)) throw new HttpError(400, 'invalid_request', 'Host disclosure is not one supported isolation/custody/ownership tuple.');
    if (!validSha256Hex(input.publicKeyFingerprint)) throw new HttpError(400, 'invalid_request', 'Host public-key fingerprint must be canonical SHA-256 hex.');
    const authority = await this.currentAuthority(input.brainId);
    if (authority.disposition !== 'missing' && !this.authorityIsExecutable(authority, owner.user_id)) {
      throw new HttpError(403, 'forbidden', 'Current durable brain authority is not executable by this owner and adapter.');
    }
    const now = input.now ?? new Date();
    const enrollmentId = `ahe_${randomBytes(18).toString('base64url')}`;
    const enrollmentSecret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_SECONDS * 1000).toISOString();
    const record: EnrollmentRecord = {
      enrollmentId, secretHash: secretHash(enrollmentSecret), brainId: input.brainId, hostId: input.hostId,
      publicKeyFingerprint: input.publicKeyFingerprint, ...input.disclosure, expiresAt, consumedAt: null,
      consumedCommandId: null, consumedCommandDigest: null, intendedCommandKind: null, intendedCommandId: null,
      intendedCommandDigest: null, expectedPreMutationCapabilitiesRevision: null, intendedDeploymentGeneration: null,
      createdByCredentialId: owner.key_id, ownerPrincipalId: owner.user_id, createdAt: now.toISOString(),
    };
    await this.mech.createDocumentWithId(ENROLLMENTS_COLLECTION, docId('agent_host_enrollment', [enrollmentId]), record as unknown as Record<string, unknown>);
    return { enrollmentId, enrollmentSecret, brainId: record.brainId, hostId: record.hostId,
      publicKeyFingerprint: record.publicKeyFingerprint, isolationClass: record.isolationClass,
      keyCustody: record.keyCustody, hostOwnership: record.hostOwnership, expiresAt };
  }

  async redeemEnrollment(input: { brainId: string; enrollmentId: string; enrollmentSecret: string; principal: AuthPrincipal; ownershipSignal: AgentHostOwnershipSignal; now?: Date }): Promise<AgentHostRecord> {
    return this.withBrainLock(input.brainId, async () => {
      const owner = this.requireOwner(input.brainId, input.principal, input.ownershipSignal);
      const now = input.now ?? new Date();
      const enrollmentId = docId('agent_host_enrollment', [input.enrollmentId]);
      const found = await this.read(ENROLLMENTS_COLLECTION, enrollmentId, parseEnrollment);
      if (!found || found.value.enrollmentId !== input.enrollmentId || found.value.brainId !== input.brainId) throw new HttpError(403, 'enrollment_invalid', 'Enrollment challenge is invalid.');
      const challenge = found.value;
      if (!sameSecret(challenge.secretHash, input.enrollmentSecret)) throw new HttpError(403, 'enrollment_invalid', 'Enrollment challenge is invalid.');
      if (challenge.createdByCredentialId !== owner.key_id || challenge.ownerPrincipalId !== owner.user_id) throw new HttpError(403, 'enrollment_invalid', 'Enrollment challenge is invalid.');

      const commandId = `agent-host-enrollment:${challenge.enrollmentId}`;
      if (challenge.consumedAt !== null) {
      const current = await this.currentAuthority(input.brainId);
      const host = current.disposition === 'current'
          ? await this.read(HOSTS_COLLECTION, hostEvidenceDocumentId(input.brainId, challenge.hostId, current.fence.capabilitiesRevision), parseHostEvidence)
          : null;
        const exactEvidence = host?.value;
        if (current.disposition === 'current' && current.record.last_command_id === commandId
          && current.record.last_command_id === challenge.consumedCommandId
          && current.record.last_command_digest === challenge.consumedCommandDigest
          && current.fence.deploymentGeneration === challenge.intendedDeploymentGeneration
          && current.record.owner_principal_id === owner.user_id && current.record.host_id === challenge.hostId
          && current.record.target_id === challenge.hostId && current.record.target_disposition === 'active'
          && current.record.adapter_identity === this.cutover!.adapterIdentity && current.record.adapter_version === this.cutover!.adapterVersion
          && exactEvidence !== undefined && evidenceMatchesAuthority(exactEvidence, current)
          && exactEvidence?.brainId === challenge.brainId && exactEvidence.hostId === challenge.hostId
          && exactEvidence.publicKeyFingerprint === challenge.publicKeyFingerprint
          && exactEvidence.isolationClass === challenge.isolationClass && exactEvidence.keyCustody === challenge.keyCustody
          && exactEvidence.hostOwnership === challenge.hostOwnership && exactEvidence.ownerPrincipalId === challenge.ownerPrincipalId
          && exactEvidence.enrolledByCredentialId === challenge.createdByCredentialId && exactEvidence.enrolledAt === challenge.consumedAt) {
          return { ...exactEvidence, deploymentGeneration: current.fence.deploymentGeneration, status: 'active', revokedAt: null };
        }
        throw new HttpError(409, 'enrollment_consumed', 'Enrollment challenge was already consumed.');
      }
      if (isPast(challenge.expiresAt, now)) throw new HttpError(410, 'enrollment_expired', 'Enrollment challenge has expired.');

      let intended = challenge;
      if (intended.intendedCommandKind === null) {
        const current = await this.currentAuthority(input.brainId);
        if (current.disposition !== 'missing' && !this.authorityIsExecutable(current, owner.user_id)) {
          throw new HttpError(403, 'forbidden', 'Current durable brain authority is not executable by this owner and adapter.');
        }
        const command: BrainAuthorizationAuthorityCommand = current.disposition === 'missing'
          ? { kind: 'bootstrap', commandId, brainId: input.brainId,
            context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, ownerPrincipalId: owner.user_id,
            targetId: challenge.hostId, hostId: challenge.hostId, deploymentGeneration: 1,
            adapterIdentity: this.cutover!.adapterIdentity, adapterVersion: this.cutover!.adapterVersion }
          : { kind: 'target_replace', commandId, brainId: input.brainId,
            context: { kind: 'authenticated_external_owner', principalId: owner.user_id },
            expectedCapabilitiesRevision: current.fence.capabilitiesRevision, targetId: challenge.hostId,
            hostId: challenge.hostId, deploymentGeneration: current.fence.deploymentGeneration + 1 };
        intended = { ...challenge, intendedCommandKind: command.kind, intendedCommandId: commandId,
          intendedCommandDigest: brainAuthorizationAuthorityCommandDigest(command),
          expectedPreMutationCapabilitiesRevision: command.kind === 'bootstrap' ? 'missing' : command.expectedCapabilitiesRevision,
          intendedDeploymentGeneration: command.deploymentGeneration };
        await this.mech.updateDocument(found.docId, ENROLLMENTS_COLLECTION, intended as unknown as Record<string, unknown>);
      }
      const frozenCommand: BrainAuthorizationAuthorityCommand = intended.intendedCommandKind === 'bootstrap'
        ? { kind: 'bootstrap', commandId: intended.intendedCommandId!, brainId: input.brainId,
          context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, ownerPrincipalId: owner.user_id,
          targetId: intended.hostId, hostId: intended.hostId, deploymentGeneration: intended.intendedDeploymentGeneration!,
          adapterIdentity: this.cutover!.adapterIdentity, adapterVersion: this.cutover!.adapterVersion }
        : { kind: 'target_replace', commandId: intended.intendedCommandId!, brainId: input.brainId,
          context: { kind: 'authenticated_external_owner', principalId: owner.user_id },
          expectedCapabilitiesRevision: intended.expectedPreMutationCapabilitiesRevision!, targetId: intended.hostId,
          hostId: intended.hostId, deploymentGeneration: intended.intendedDeploymentGeneration! };
      if (brainAuthorizationAuthorityCommandDigest(frozenCommand) !== intended.intendedCommandDigest) {
        throw new HttpError(503, 'control_plane_state_invalid', 'Enrollment intent is invalid; refusing authority mutation.');
      }
      const result = await this.cutover!.repository.execute(frozenCommand);
      if (result.status !== 'applied' && result.status !== 'idempotent') this.authorityFailure(result.status);

      const evidence: HostEvidence = {
        schemaVersion: 1, authorityCommandId: commandId, authorityCommandDigest: intended.intendedCommandDigest!,
        brainId: input.brainId, hostId: challenge.hostId, publicKeyFingerprint: challenge.publicKeyFingerprint,
        isolationClass: challenge.isolationClass, keyCustody: challenge.keyCustody, hostOwnership: challenge.hostOwnership,
        enrolledByCredentialId: owner.key_id, ownerPrincipalId: owner.user_id, enrolledAt: challenge.createdAt,
      };
      await this.persistHostEvidence(evidence, result.fence.capabilitiesRevision);
      // Keep only the one-way hash after consumption so repeated redemption can
      // return the explicit consumed outcome without retaining any secret.
      const committed = await this.currentAuthority(input.brainId);
      if (!this.authorityIsExecutable(committed, owner.user_id, challenge.hostId)
        || committed.record.last_command_id !== commandId || committed.record.last_command_digest !== evidence.authorityCommandDigest
        || !exactFence(committed.fence, result.fence) || !evidenceMatchesAuthority(evidence, committed)) {
        throw new HttpError(503, 'authority_invalid', 'Durable brain authority changed before enrollment evidence commit.');
      }
      await this.mech.updateDocument(found.docId, ENROLLMENTS_COLLECTION, { ...intended, consumedAt: challenge.createdAt,
        consumedCommandId: commandId, consumedCommandDigest: committed.record.last_command_digest });
      const final = await this.currentAuthority(input.brainId);
      if (!this.authorityIsExecutable(final, owner.user_id, challenge.hostId)
        || final.record.last_command_id !== commandId || !exactFence(final.fence, result.fence)) {
        throw new HttpError(503, 'authority_invalid', 'Durable brain authority changed before enrollment completion.');
      }
      return { ...evidence, deploymentGeneration: result.fence.deploymentGeneration, status: 'active', revokedAt: null };
    });
  }

  async revokeHost(input: { brainId: string; hostId: string; principal: AuthPrincipal; ownershipSignal: AgentHostOwnershipSignal; now?: Date }): Promise<AgentHostDesiredState> {
    return this.withBrainLock(input.brainId, async () => {
      const owner = this.requireOwner(input.brainId, input.principal, input.ownershipSignal);
      const now = input.now ?? new Date();
      const current = await this.currentAuthority(input.brainId);
      if (current.disposition !== 'current' || current.fence.hostId !== input.hostId) throw new HttpError(409, 'host_not_active', 'Host is not the active deployment.');
      const result = await this.cutover!.repository.execute({ kind: 'target_revoke', commandId: docId('agent_host_revoke', [input.brainId, input.hostId, current.fence.capabilitiesRevision]),
        brainId: input.brainId, context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, expectedCapabilitiesRevision: current.fence.capabilitiesRevision });
      if (result.status !== 'applied' && result.status !== 'idempotent') this.authorityFailure(result.status);
      return { brainId: input.brainId, deploymentGeneration: result.fence.deploymentGeneration, activeHostId: null, updatedAt: now.toISOString() };
    });
  }

  async resolveTarget(brainId: string, expectedCapabilitiesRevision: string): Promise<AgentHostEndpointTarget | null> {
    const current = await this.currentAuthority(brainId);
    if (current.disposition === 'missing' || current.fence.hostId === null) return null;
    if (current.fence.capabilitiesRevision !== expectedCapabilitiesRevision
      || current.record.owner_status !== 'active' || current.record.target_disposition !== 'active'
      || current.record.target_id !== current.record.host_id
      || current.record.adapter_disposition !== 'selected'
      || current.record.adapter_identity !== this.cutover!.adapterIdentity
      || current.record.adapter_version !== this.cutover!.adapterVersion) {
      throw new HttpError(503, 'control_plane_state_invalid', 'Active authority fence changed or is not executable; refusing endpoint resolution.');
    }
    const host = await this.read(HOSTS_COLLECTION, hostEvidenceDocumentId(brainId, current.fence.hostId, current.fence.capabilitiesRevision), parseHostEvidence);
    if (!host || host.value.brainId !== brainId || host.value.hostId !== current.fence.hostId
      || host.value.ownerPrincipalId !== current.fence.ownerPrincipalId || !evidenceMatchesAuthority(host.value, current)) {
      throw new HttpError(503, 'control_plane_state_invalid', 'Active host state is inconsistent; refusing endpoint resolution.');
    }
    const final = await this.currentAuthority(brainId);
    if (!this.authorityIsExecutable(final, current.record.owner_principal_id, current.fence.hostId ?? undefined)
      || final.fence.capabilitiesRevision !== expectedCapabilitiesRevision || !exactFence(final.fence, current.fence)) {
      throw new HttpError(503, 'control_plane_state_invalid', 'Active authority fence changed or is not executable; refusing endpoint resolution.');
    }
    return target(host.value, final.fence.deploymentGeneration);
  }

  async resolveOwnerTarget(brainId: string, principal: AuthPrincipal, ownershipSignal: AgentHostOwnershipSignal): Promise<AgentHostEndpointTarget | null> {
    this.requireOwner(brainId, principal, ownershipSignal);
    const current = await this.currentAuthority(brainId);
    if (current.disposition !== 'current') return null;
    return this.resolveTarget(brainId, current.fence.capabilitiesRevision);
  }

  async issueSessionGrant(input: { brainId: string; hostId: string; deploymentGeneration: number; operations: AgentHostSessionOperation[]; audienceCredentialId: string; principal: AuthPrincipal; ownershipSignal: AgentHostOwnershipSignal; ttlSeconds: number; now?: Date }): Promise<AgentHostSessionGrant> {
    const owner = this.requireOwner(input.brainId, input.principal, input.ownershipSignal);
    if (owner.key_id !== input.audienceCredentialId) throw new HttpError(403, 'forbidden', 'Session grant audience must be the owner credential.');
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < MIN_GRANT_TTL_SECONDS || input.ttlSeconds > MAX_GRANT_TTL_SECONDS) throw new HttpError(400, 'invalid_request', `ttlSeconds must be ${MIN_GRANT_TTL_SECONDS}-${MAX_GRANT_TTL_SECONDS}.`);
    if (input.operations.length === 0 || input.operations.some((op) => !VALID_OPERATIONS.has(op))) throw new HttpError(400, 'invalid_request', 'Requested operations are invalid.');
    if (new Set(input.operations).size !== input.operations.length) throw new HttpError(400, 'invalid_request', 'Requested operations must be unique.');
    const current = await this.currentAuthority(input.brainId);
    if (current.disposition !== 'current') throw new HttpError(409, 'generation_stale', 'Requested host generation is not active.');
    const resolved = await this.resolveTarget(input.brainId, current.fence.capabilitiesRevision);
    if (!resolved || resolved.hostId !== input.hostId || resolved.deploymentGeneration !== input.deploymentGeneration) throw new HttpError(409, 'generation_stale', 'Requested host generation is not active.');
    const now = input.now ?? new Date();
    const grantId = `ahg_${randomBytes(18).toString('base64url')}`;
    const grant = `ahg1_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
    const record: SessionGrantRecord = { grantId, secretHash: secretHash(grant), brainId: input.brainId, hostId: input.hostId, deploymentGeneration: input.deploymentGeneration, capabilitiesRevision: current.fence.capabilitiesRevision, audienceCredentialId: input.audienceCredentialId, operations: [...input.operations], expiresAt, createdAt: now.toISOString(), revokedAt: null };
    await this.mech.createDocumentWithId(GRANTS_COLLECTION, docId('agent_host_grant', [grantId]), record as unknown as Record<string, unknown>);
    await this.resolveTarget(input.brainId, record.capabilitiesRevision);
    return { grantId, grant, expiresAt, target: resolved, operations: [...record.operations] };
  }

  async verifySessionGrant(input: { grantId: string; grant: string; audienceCredentialId: string; target: { brainId: string; hostId: string; deploymentGeneration: number }; requiredOperation: AgentHostSessionOperation; now?: Date }): Promise<void> {
    const found = await this.read(GRANTS_COLLECTION, docId('agent_host_grant', [input.grantId]), parseGrant);
    if (!found || found.value.grantId !== input.grantId) throw new HttpError(403, 'grant_invalid', 'Session grant is invalid.');
    const record = found.value;
    const now = input.now ?? new Date();
    if (!sameSecret(record.secretHash, input.grant) || record.revokedAt || isPast(record.expiresAt, now)) throw new HttpError(403, 'grant_invalid', 'Session grant is invalid.');
    if (record.audienceCredentialId !== input.audienceCredentialId || record.brainId !== input.target.brainId || record.hostId !== input.target.hostId || record.deploymentGeneration !== input.target.deploymentGeneration || !record.operations.includes(input.requiredOperation)) throw new HttpError(403, 'grant_invalid', 'Session grant is invalid.');
    const resolved = await this.resolveTarget(record.brainId, record.capabilitiesRevision);
    if (!resolved || resolved.hostId !== record.hostId || resolved.deploymentGeneration !== record.deploymentGeneration) throw new HttpError(403, 'generation_stale', 'Session grant target is stale.');
  }
}
