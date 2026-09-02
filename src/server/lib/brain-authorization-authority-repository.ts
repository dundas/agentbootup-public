import { createHash, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { CasCreateBody, CasCreateResult, CasDocument, CasGetResult, CasUpdateBody, CasUpdateResult } from '@mech/storage-sdk';
import type { Brain } from '../types';
import {
  createBrainAuthorizationFence,
  preCutoverBrainAuthorizationFence,
  type AnyBrainAuthorizationDecision,
  type BrainAuthorizationDecisionAuthority,
  type BrainAuthorizationFence,
} from './brain-authorization-decision';
import { legacyBrainOwnershipCandidateFingerprint } from './brain-authorization-read-model';
import { canonicalDeviceReauthProofPayload } from './remote-local-relay-protocol';
import {
  MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
  MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
} from './remote-local-device-credential-policy';

const COLLECTION = 'agentbootup-brain-authorization-authority';
const SCHEMA_VERSION = 1;
const PROVIDER_KEYS = ['_rev', 'collection', 'created_at', 'data', 'document_key', 'id', 'metadata', 'updated_at'];
const RECORD_KEYS = [
  'adapter_disposition', 'adapter_identity', 'adapter_version', 'brain_id', 'capabilities_revision',
  'capability_policy_revision', 'credential_revision', 'deployment_generation', 'fencing_epoch', 'host_id',
  'last_command_digest', 'last_command_id', 'last_command_kind', 'local_device', 'local_device_credential', 'local_device_credential_pending', 'local_device_enrollment', 'local_device_reauth', 'local_device_reauth_sequence', 'local_device_revoke_receipts', 'owner_principal_id', 'owner_status',
  'schema_version', 'target_disposition', 'target_id',
];
// `local_device` was added after schema-v1 records had already been stored.
// Read both exact shapes; only local_device_bind upgrades the legacy shape.
const OPTIONAL_LOCAL_DEVICE_KEYS = ['local_device', 'local_device_enrollment', 'local_device_credential', 'local_device_credential_pending', 'local_device_reauth', 'local_device_reauth_sequence', 'local_device_revoke_receipts'];
const LEGACY_RECORD_KEYS = RECORD_KEYS.filter((key) => !OPTIONAL_LOCAL_DEVICE_KEYS.includes(key));
const METADATA: Record<string, never> = {};
const MIN_DEVICE_TTL_MS = 1_000;
const MAX_REAUTH_CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_DEVICE_CREDENTIAL_TTL_MS = 60 * 60_000;
// The receipt log is intentionally bounded and fail-closed.  It preserves
// replay semantics rather than silently allowing an old command ID to act on
// a replacement device after its outcome has been discarded.
const MAX_LOCAL_DEVICE_REVOKE_RECEIPTS = 128;

type CommandKind = 'bootstrap' | 'local_device_bootstrap' | 'target_replace' | 'target_revoke' | 'owner_revoke' | 'credential_revoke'
  | 'adapter_select' | 'adapter_disable' | 'policy_change' | 'local_device_bind' | 'local_device_revoke' | 'local_device_enrollment_start' | 'local_device_enrollment_complete'
  | 'local_device_reauth_issue' | 'local_device_reauth_consume' | 'local_device_credential_prepare' | 'local_device_credential_activate';
type AuthenticatedOwnerContext = { kind: 'authenticated_external_owner'; principalId: string };
type LocalDeviceConnectorContext = { kind: 'local_device_connector'; deviceId: string };
type BaseCommand = { commandId: string; brainId: string; context: AuthenticatedOwnerContext };
type ExpectedCommand = BaseCommand & { expectedCapabilitiesRevision: string };
type DeviceCommand = { commandId: string; brainId: string; context: LocalDeviceConnectorContext; expectedCapabilitiesRevision: string };
export type BrainAuthorizationAuthorityCommand =
  | (BaseCommand & { kind: 'bootstrap'; ownerPrincipalId: string; targetId: string; hostId: string; deploymentGeneration: number; adapterIdentity: string; adapterVersion: string })
  | (BaseCommand & { kind: 'local_device_bootstrap'; ownerPrincipalId: string; adapterIdentity: string; adapterVersion: string })
  | (ExpectedCommand & { kind: 'target_replace'; targetId: string; hostId: string; deploymentGeneration: number })
  | (ExpectedCommand & { kind: 'target_revoke' | 'owner_revoke' | 'credential_revoke' | 'adapter_disable' | 'policy_change' })
  | (ExpectedCommand & { kind: 'adapter_select'; adapterIdentity: string; adapterVersion: string })
  | (ExpectedCommand & { kind: 'local_device_bind'; deviceId: string; publicKey: string; enrolledByCredentialId: string; enrolledAt: string })
  | (ExpectedCommand & { kind: 'local_device_revoke'; revokedAt: string })
  | (ExpectedCommand & { kind: 'local_device_enrollment_start'; enrollmentId: string; deviceId: string; secretHash: string; challenge: string; expiresAt: string; enrolledByCredentialId: string; enrolledAt: string; publicKey: string; startRequestDigest: string })
  | (DeviceCommand & { kind: 'local_device_reauth_consume'; credential: string; credentialId: string; proofChallengeId: string; purpose: 'socket_open'; expiresAt: string; rotationId: string; reauthSequence: number; signature: string });
type LocalDeviceEnrollmentCompleteCommand = ExpectedCommand & {
  kind: 'local_device_enrollment_complete'; enrollmentId: string; credentialId: string;
  credentialVerifierHash: string; credentialExpiresAt: string; completionRequestDigest: string;
};
type LocalDeviceCredentialPrepareCommand = DeviceCommand & {
  kind: 'local_device_credential_prepare'; credential: string; credentialId: string; proofChallengeId: string;
  purpose: 'credential_refresh'; expiresAt: string; rotationId: string; reauthSequence: number; signature: string;
  successorCredentialId: string; successorVerifierHash: string; successorExpiresAt: string; rotationRequestDigest: string;
};
type LocalDeviceCredentialActivateCommand = DeviceCommand & {
  kind: 'local_device_credential_activate'; credential: string; credentialId: string; proofChallengeId: string;
  purpose: 'credential_activate'; expiresAt: string; rotationId: string; reauthSequence: number; signature: string;
};
type LocalDeviceReauthIssueCommand = DeviceCommand & {
  kind: 'local_device_reauth_issue'; credential: string; credentialId: string; proofChallengeId: string;
  purpose: 'socket_open' | 'credential_refresh' | 'credential_activate'; expiresAt: string; rotationId: string; reauthSequence: number;
};
type InternalAuthorityCommand = BrainAuthorizationAuthorityCommand | LocalDeviceEnrollmentCompleteCommand | LocalDeviceReauthIssueCommand
  | LocalDeviceCredentialPrepareCommand | LocalDeviceCredentialActivateCommand;

interface LocalDeviceEnrollmentRecord { enrollment_id: string; device_id: string; public_key: string; secret_hash: string; challenge: string; expires_at: string; enrolled_by_credential_id: string; enrolled_at: string; start_command_id: string; start_request_digest: string; }
interface LocalDeviceCredentialVerifier {
  credential_id: string;
  verifier_hash: string;
  expires_at: string;
  brain_id: string;
  device_id: string;
  owner_principal_id: string;
  authority_capabilities_revision: string;
  completion_command_id?: string;
  completion_request_digest?: string;
  prior_credential_id?: string;
  rotation_id?: string;
  rotation_command_id?: string;
  rotation_request_digest?: string;
}
interface LocalDeviceReauthChallenge {
  proof_challenge_id: string; credential_id: string; purpose: 'socket_open' | 'credential_refresh' | 'credential_activate'; expires_at: string;
  rotation_id: string; reauth_sequence: number; brain_id: string; device_id: string; authority_capabilities_revision: string;
}
interface LocalDevicePendingCredential {
  credential_id: string; verifier_hash: string; expires_at: string; brain_id: string; device_id: string;
  owner_principal_id: string; authority_capabilities_revision: string; prior_credential_id: string;
  rotation_id: string; prepare_command_id: string; prepare_request_digest: string;
}

export interface LocalDeviceAuthorityRecord {
  schema_version: 1;
  device_id: string;
  brain_id: string;
  owner_principal_id: string;
  public_key_algorithm: 'ed25519';
  public_key: string;
  public_key_fingerprint: string;
  state: 'active' | 'revoked';
  authority_capabilities_revision: string;
  enrolled_by_credential_id: string;
  enrolled_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
}
interface LocalDeviceRevokeReceipt {
  schema_version: 1;
  command_id: string;
  command_digest: string;
  owner_principal_id: string;
  device_id: string;
  revoked_at: string;
  authority_capabilities_revision: string;
}

interface AuthorityRecord {
  schema_version: 1;
  brain_id: string;
  owner_principal_id: string;
  owner_status: 'active' | 'revoked';
  target_id: string | null;
  target_disposition: 'active' | 'revoked';
  host_id: string | null;
  deployment_generation: number;
  adapter_identity: string | null;
  adapter_version: string | null;
  adapter_disposition: 'selected' | 'disabled';
  fencing_epoch: number;
  credential_revision: number;
  capability_policy_revision: number;
  capabilities_revision: string;
  local_device?: LocalDeviceAuthorityRecord | null;
  local_device_enrollment?: LocalDeviceEnrollmentRecord | null;
  local_device_credential?: LocalDeviceCredentialVerifier | null;
  local_device_credential_pending?: LocalDevicePendingCredential | null;
  local_device_reauth?: LocalDeviceReauthChallenge | null;
  local_device_reauth_sequence?: number;
  local_device_revoke_receipts?: LocalDeviceRevokeReceipt[];
  last_command_digest: string;
  last_command_id: string;
  last_command_kind: CommandKind;
}

interface CurrentAuthority { record: AuthorityRecord; revision: string; document: CasDocument }
export type AuthorityInspection =
  | { disposition: 'missing' | 'invalid' | 'unavailable' }
  | { disposition: 'current'; record: Readonly<AuthorityRecord>; fence: BrainAuthorizationFence };
export type AuthorityCommandResult =
  | { status: 'applied' | 'idempotent'; fence: BrainAuthorizationFence }
  | { status: 'conflict' | 'denied' | 'unavailable' };
export type LocalDeviceReauthChallengeIssueResult =
  | { status: 'issued'; brainId: string; deviceId: string; authorityRevision: string; credentialId: string;
      proofChallengeId: string; purpose: 'socket_open' | 'credential_refresh' | 'credential_activate'; expiresAt: string; rotationId: string; reauthSequence: number }
  | { status: 'conflict' | 'denied' | 'indeterminate' | 'unavailable' };
type LocalDeviceCredentialRotationInput =
  | ({ phase: 'prepare'; successorExpiresAt: string } & Omit<LocalDeviceCredentialPrepareCommand,
      'kind' | 'successorCredentialId' | 'successorVerifierHash' | 'successorExpiresAt' | 'rotationRequestDigest'>)
  | ({ phase: 'activate' } & Omit<LocalDeviceCredentialActivateCommand, 'kind'>);
export type LocalDeviceCredentialRotationResult = AuthorityCommandResult
  | { status: 'prepared'; connectorCredential: string; credentialId: string; successorExpiresAt: string; rotationRequestDigest: string };

/** Narrow testable subset of the pinned Mech Storage CAS resource. */
export interface BrainAuthorizationAuthorityCasClient {
  getDocument(collection: string, documentKey: string): Promise<CasGetResult>;
  createDocument(body: CasCreateBody): Promise<CasCreateResult>;
  updateDocument(collection: string, documentKey: string, body: CasUpdateBody): Promise<CasUpdateResult>;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
function validRevisionNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validOpaqueRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function validDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^ldv_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function canonicalEd25519PublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.byteLength === 32 && decoded.toString('base64url') === value;
  } catch { return false; }
}
function validSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function validConnectorCredential(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= 256;
}
function validEd25519Signature(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value)) return false;
  try { const decoded = Buffer.from(value, 'base64url'); return decoded.byteLength === 64 && decoded.toString('base64url') === value; }
  catch { return false; }
}
function equalSha256(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function reauthIdentifierMatchesSequence(value: unknown, prefix: 'pop' | 'rot', sequence: number): value is string {
  return typeof value === 'string' && value.startsWith(`${prefix}_${sequence}_`)
    && /^[A-Za-z0-9_-]{16,256}$/.test(value);
}
function mintReauthIdentifier(prefix: 'pop' | 'rot', sequence: number): string {
  return `${prefix}_${sequence}_${randomBytes(18).toString('base64url')}`;
}
function validEnrollmentId(value: unknown): value is string { return typeof value === 'string' && /^lde_[A-Za-z0-9_-]{16,128}$/.test(value); }
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText = '00', offsetMinuteText = '00'] = match;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText,
  ].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}
/**
 * The storage predicate requires canonical UTC milliseconds. The source is an
 * already validated durable credential timestamp, never caller data; converting
 * an equivalent legacy RFC3339 representation preserves (or rounds down to)
 * its authority boundary rather than letting a caller choose one.
 */
function canonicalServerTimeDeadline(value: unknown): string | null {
  if (!validTimestamp(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function documentKey(brainId: string): string { return `brain:${encodeURIComponent(brainId)}`; }
function adapterIdentityVersion(record: AuthorityRecord): string | null {
  // BrainAuthorizationFence deliberately exposes one opaque adapter identity
  // component. Bind both selected and disabled adapter/target state into that
  // component so target identity remains covered even while execution is
  // disabled, without widening the public fence or exposing provider topology.
  return `v1.${createHash('sha256')
    .update(record.adapter_disposition).update('\0')
    .update(record.adapter_identity ?? '').update('\0')
    .update(record.adapter_version ?? '').update('\0')
    .update(record.target_disposition).update('\0')
    .update(record.target_id ?? '').digest('base64url')}`;
}
function fenceFor(record: AuthorityRecord): BrainAuthorizationFence {
  return createBrainAuthorizationFence({
    brainId: record.brain_id,
    fencingEpoch: record.fencing_epoch,
    ownerPrincipalId: record.owner_status === 'active' ? record.owner_principal_id : null,
    credentialRevision: record.credential_revision,
    hostId: record.target_disposition === 'active' ? record.host_id : null,
    deploymentGeneration: record.deployment_generation,
    adapterIdentityVersion: adapterIdentityVersion(record),
    capabilityPolicyRevision: record.capability_policy_revision,
  });
}
function localDeviceRecordIsValid(value: unknown, record: Pick<AuthorityRecord, 'brain_id' | 'owner_principal_id' | 'capabilities_revision'>): value is LocalDeviceAuthorityRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value, ['authority_capabilities_revision', 'brain_id', 'device_id', 'enrolled_at', 'enrolled_by_credential_id', 'last_seen_at', 'owner_principal_id', 'public_key', 'public_key_algorithm', 'public_key_fingerprint', 'revoked_at', 'schema_version', 'state'])) return false;
  const device = value as LocalDeviceAuthorityRecord;
  if (device.schema_version !== 1 || !validDeviceId(device.device_id) || device.brain_id !== record.brain_id
    || device.owner_principal_id !== record.owner_principal_id || device.public_key_algorithm !== 'ed25519'
    || !canonicalEd25519PublicKey(device.public_key) || !validSha256Hex(device.public_key_fingerprint)
    || createHash('sha256').update(Buffer.from(device.public_key, 'base64url')).digest('hex') !== device.public_key_fingerprint
    || !['active', 'revoked'].includes(device.state) || device.authority_capabilities_revision !== record.capabilities_revision
    || !validId(device.enrolled_by_credential_id) || !validTimestamp(device.enrolled_at)
    || (device.revoked_at !== null && !validTimestamp(device.revoked_at))
    || (device.last_seen_at !== null && !validTimestamp(device.last_seen_at))) return false;
  return device.state === 'active' ? device.revoked_at === null : device.revoked_at !== null;
}
function enrollmentIsValid(value: unknown): value is LocalDeviceEnrollmentRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && exactKeys(value, ['challenge', 'device_id', 'enrolled_at', 'enrolled_by_credential_id', 'enrollment_id', 'expires_at', 'public_key', 'secret_hash', 'start_command_id', 'start_request_digest'])
    && validEnrollmentId((value as LocalDeviceEnrollmentRecord).enrollment_id) && validDeviceId((value as LocalDeviceEnrollmentRecord).device_id) && validId((value as LocalDeviceEnrollmentRecord).start_command_id) && validOpaqueRevision((value as LocalDeviceEnrollmentRecord).start_request_digest)
    && canonicalEd25519PublicKey((value as LocalDeviceEnrollmentRecord).public_key) && validSha256Hex((value as LocalDeviceEnrollmentRecord).secret_hash)
    && validOpaqueRevision((value as LocalDeviceEnrollmentRecord).challenge) && validTimestamp((value as LocalDeviceEnrollmentRecord).expires_at)
    && validId((value as LocalDeviceEnrollmentRecord).enrolled_by_credential_id) && validTimestamp((value as LocalDeviceEnrollmentRecord).enrolled_at);
}
function credentialVerifierIsValid(value: unknown, record: Pick<AuthorityRecord, 'brain_id' | 'owner_principal_id' | 'local_device'>): value is LocalDeviceCredentialVerifier {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const enrollmentShape = exactKeys(value, ['authority_capabilities_revision', 'brain_id', 'completion_command_id', 'completion_request_digest', 'credential_id', 'device_id', 'expires_at', 'owner_principal_id', 'verifier_hash']);
  const rotationShape = exactKeys(value, ['authority_capabilities_revision', 'brain_id', 'credential_id', 'device_id', 'expires_at', 'owner_principal_id', 'prior_credential_id', 'rotation_command_id', 'rotation_id', 'rotation_request_digest', 'verifier_hash']);
  const credential = value as LocalDeviceCredentialVerifier;
  return (enrollmentShape || rotationShape)
    && validId(credential.credential_id) && validSha256Hex(credential.verifier_hash)
    && (enrollmentShape ? validId(credential.completion_command_id) && validOpaqueRevision(credential.completion_request_digest)
      : validId(credential.prior_credential_id) && validId(credential.rotation_id) && validId(credential.rotation_command_id) && validOpaqueRevision(credential.rotation_request_digest))
    && validTimestamp(credential.expires_at)
    && credential.brain_id === record.brain_id
    && credential.owner_principal_id === record.owner_principal_id
    && record.local_device != null
    && credential.device_id === record.local_device.device_id
    && validOpaqueRevision(credential.authority_capabilities_revision);
}
function pendingCredentialIsValid(value: unknown, record: Pick<AuthorityRecord, 'brain_id' | 'owner_principal_id' | 'capabilities_revision' | 'local_device' | 'local_device_credential'>): value is LocalDevicePendingCredential {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value, ['authority_capabilities_revision', 'brain_id', 'credential_id', 'device_id', 'expires_at', 'owner_principal_id', 'prepare_command_id', 'prepare_request_digest', 'prior_credential_id', 'rotation_id', 'verifier_hash'])) return false;
  const pending = value as LocalDevicePendingCredential;
  return validId(pending.credential_id) && validSha256Hex(pending.verifier_hash) && validTimestamp(pending.expires_at)
    && validId(pending.prior_credential_id) && validId(pending.rotation_id) && validId(pending.prepare_command_id)
    && validOpaqueRevision(pending.prepare_request_digest) && pending.brain_id === record.brain_id
    && pending.owner_principal_id === record.owner_principal_id && pending.device_id === record.local_device?.device_id
    && pending.authority_capabilities_revision === record.capabilities_revision
    && pending.prior_credential_id === record.local_device_credential?.credential_id
    && pending.credential_id !== pending.prior_credential_id;
}
function reauthChallengeIsValid(value: unknown, record: Pick<AuthorityRecord, 'brain_id' | 'capabilities_revision' | 'local_device' | 'local_device_credential' | 'local_device_credential_pending' | 'local_device_reauth_sequence'>): value is LocalDeviceReauthChallenge {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value, ['authority_capabilities_revision', 'brain_id', 'credential_id', 'device_id', 'expires_at', 'proof_challenge_id', 'purpose', 'reauth_sequence', 'rotation_id'])) return false;
  const challenge = value as LocalDeviceReauthChallenge;
  return validRevisionNumber(challenge.reauth_sequence) && challenge.reauth_sequence > 0
    && challenge.reauth_sequence === record.local_device_reauth_sequence
    && reauthIdentifierMatchesSequence(challenge.proof_challenge_id, 'pop', challenge.reauth_sequence)
    && validId(challenge.credential_id) && validTimestamp(challenge.expires_at)
    && (challenge.purpose === 'credential_activate' ? validId(challenge.rotation_id)
      : reauthIdentifierMatchesSequence(challenge.rotation_id, 'rot', challenge.reauth_sequence))
    && ['socket_open', 'credential_refresh', 'credential_activate'].includes(challenge.purpose)
    && challenge.brain_id === record.brain_id && challenge.authority_capabilities_revision === record.capabilities_revision
    && record.local_device?.state === 'active' && challenge.device_id === record.local_device.device_id
    && challenge.credential_id === (challenge.purpose === 'credential_activate'
      ? record.local_device_credential_pending?.credential_id : record.local_device_credential?.credential_id)
    && (challenge.purpose !== 'credential_activate' || challenge.rotation_id === record.local_device_credential_pending?.rotation_id);
}
function revokeReceiptsAreValid(value: unknown, record: Pick<AuthorityRecord, 'brain_id' | 'owner_principal_id'>): value is LocalDeviceRevokeReceipt[] {
  if (!Array.isArray(value) || value.length > MAX_LOCAL_DEVICE_REVOKE_RECEIPTS) return false;
  const commandIds = new Set<string>();
  return value.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || !exactKeys(entry, ['authority_capabilities_revision', 'command_digest', 'command_id', 'device_id', 'owner_principal_id', 'revoked_at', 'schema_version'])) return false;
    const receipt = entry as LocalDeviceRevokeReceipt;
    if (receipt.schema_version !== 1 || !validId(receipt.command_id) || !validOpaqueRevision(receipt.command_digest)
      || !validDeviceId(receipt.device_id) || receipt.owner_principal_id !== record.owner_principal_id
      || !validTimestamp(receipt.revoked_at) || !validOpaqueRevision(receipt.authority_capabilities_revision)
      || commandIds.has(receipt.command_id)) return false;
    commandIds.add(receipt.command_id);
    return true;
  });
}
function recordIsValid(value: unknown, brainId: string): value is AuthorityRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !(() => { const keys = Object.keys(value).filter((key) => !OPTIONAL_LOCAL_DEVICE_KEYS.includes(key)).sort(); return keys.length === LEGACY_RECORD_KEYS.length && keys.every((key, index) => key === LEGACY_RECORD_KEYS[index]); })()) return false;
  const record = value as AuthorityRecord;
  if (record.schema_version !== SCHEMA_VERSION || record.brain_id !== brainId || !validId(record.brain_id)
    || !validId(record.owner_principal_id) || !['active', 'revoked'].includes(record.owner_status)
    || !['active', 'revoked'].includes(record.target_disposition)
    || !['selected', 'disabled'].includes(record.adapter_disposition)
    || !validRevisionNumber(record.deployment_generation) || !validRevisionNumber(record.fencing_epoch)
    || !validRevisionNumber(record.credential_revision) || !validRevisionNumber(record.capability_policy_revision)
    || !validId(record.last_command_id) || !validOpaqueRevision(record.last_command_digest)
    || !['bootstrap', 'local_device_bootstrap', 'target_replace', 'target_revoke', 'owner_revoke', 'credential_revoke', 'adapter_select', 'adapter_disable', 'policy_change', 'local_device_bind', 'local_device_revoke', 'local_device_enrollment_start', 'local_device_enrollment_complete', 'local_device_reauth_issue', 'local_device_reauth_consume', 'local_device_credential_prepare', 'local_device_credential_activate'].includes(record.last_command_kind)
    || !validOpaqueRevision(record.capabilities_revision)
    || (record.local_device_reauth_sequence !== undefined && !validRevisionNumber(record.local_device_reauth_sequence))) return false;
  // A missing projection is valid only for pre-local-device schema-v1 history.
  // Treat a torn bind record as invalid rather than allowing commandMatches to
  // manufacture an idempotent success from its last-command metadata.
  if (record.last_command_kind === 'local_device_bind' && record.local_device == null) return false;
  if (record.last_command_kind === 'local_device_enrollment_start' && !enrollmentIsValid(record.local_device_enrollment)) return false;
  if (record.last_command_kind === 'local_device_enrollment_complete'
    && (record.local_device_enrollment !== null || record.local_device?.state !== 'active' || record.local_device_credential == null)) return false;
  if (record.last_command_kind === 'local_device_revoke'
    && (record.local_device?.state !== 'revoked' || record.local_device_enrollment !== null || record.local_device_credential !== null || record.local_device_credential_pending !== null || record.local_device_reauth !== null)) return false;
  if (record.last_command_kind === 'local_device_reauth_issue' && !reauthChallengeIsValid(record.local_device_reauth, record)) return false;
  if ((record.last_command_kind === 'local_device_reauth_consume' || record.last_command_kind === 'local_device_credential_prepare' || record.last_command_kind === 'local_device_credential_activate')
    && (record.local_device_reauth !== null || !validRevisionNumber(record.local_device_reauth_sequence)
      || record.local_device_reauth_sequence === 0)) return false;
  if (record.last_command_kind === 'local_device_credential_prepare' && record.local_device_credential_pending == null) return false;
  if (record.last_command_kind === 'local_device_credential_activate' && record.local_device_credential_pending !== null) return false;
  const activeTarget = record.target_disposition === 'active';
  if (activeTarget !== (record.target_id !== null && record.host_id !== null)
    || (activeTarget && record.deployment_generation === 0)
    || (record.target_id !== null && !validId(record.target_id)) || (record.host_id !== null && !validId(record.host_id))) return false;
  const selectedAdapter = record.adapter_disposition === 'selected';
  if (selectedAdapter !== (record.adapter_identity !== null && record.adapter_version !== null)
    || (record.adapter_identity !== null && !validId(record.adapter_identity))
    || (record.adapter_version !== null && !validId(record.adapter_version))) return false;
  try {
    return fenceFor(record).capabilitiesRevision === record.capabilities_revision
      && (record.local_device === undefined || record.local_device === null || localDeviceRecordIsValid(record.local_device, record))
      && (record.local_device_enrollment === undefined || record.local_device_enrollment === null || enrollmentIsValid(record.local_device_enrollment))
      && (record.local_device_credential === undefined || record.local_device_credential === null || credentialVerifierIsValid(record.local_device_credential, record))
      && (record.local_device_credential_pending === undefined || record.local_device_credential_pending === null || pendingCredentialIsValid(record.local_device_credential_pending, record))
      && (record.local_device_reauth === undefined || record.local_device_reauth === null || reauthChallengeIsValid(record.local_device_reauth, record))
      && (record.local_device_revoke_receipts === undefined || revokeReceiptsAreValid(record.local_device_revoke_receipts, record));
  } catch { return false; }
}
function parseDocument(value: unknown, brainId: string): CurrentAuthority | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, PROVIDER_KEYS)) return null;
  const document = value as CasDocument;
  if (!validId(document.id) || document.collection !== COLLECTION || document.document_key !== documentKey(brainId)
    || !validOpaqueRevision(document._rev) || !validTimestamp(document.created_at) || !validTimestamp(document.updated_at)
    || document.metadata === null || typeof document.metadata !== 'object' || Array.isArray(document.metadata)
    || !exactKeys(document.metadata, [])
    || !recordIsValid(document.data, brainId)) return null;
  return { record: document.data, revision: document._rev, document };
}
function exactJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => exactJson(value, right[index]));
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  return leftKeys.length === Object.keys(rightRecord).length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && exactJson(leftRecord[key], rightRecord[key]));
}
function revokeReceiptFor(record: AuthorityRecord, principalId: string, commandId: string): LocalDeviceRevokeReceipt | null {
  return record.local_device_revoke_receipts?.find((receipt) => receipt.command_id === commandId
    && receipt.owner_principal_id === principalId) ?? null;
}
function withCapabilityRevision(record: Omit<AuthorityRecord, 'capabilities_revision'>): AuthorityRecord {
  const provisional = { ...record, capabilities_revision: 'pending' } as AuthorityRecord;
  const capabilities_revision = fenceFor(provisional).capabilitiesRevision;
  const next: AuthorityRecord = {
    ...provisional,
    capabilities_revision,
  };
  if (provisional.local_device !== undefined) {
    next.local_device = provisional.local_device && { ...provisional.local_device, authority_capabilities_revision: capabilities_revision };
  }
  if (provisional.local_device_credential !== undefined) {
    next.local_device_credential = provisional.local_device_credential
      && (provisional.local_device_credential.authority_capabilities_revision === 'pending'
        ? { ...provisional.local_device_credential, authority_capabilities_revision: capabilities_revision }
        : provisional.local_device_credential);
  }
  if (provisional.local_device_credential_pending !== undefined) {
    next.local_device_credential_pending = provisional.local_device_credential_pending
      && (provisional.local_device_credential_pending.authority_capabilities_revision === 'pending'
        ? { ...provisional.local_device_credential_pending, authority_capabilities_revision: capabilities_revision }
        : provisional.local_device_credential_pending);
  }
  return next;
}
function authorityCommandDigest(command: InternalAuthorityCommand): string {
  const common = {
    kind: command.kind,
    commandId: command.commandId,
    brainId: command.brainId,
    ...(command.context.kind === 'authenticated_external_owner'
      ? { principalId: command.context.principalId }
      : { contextKind: command.context.kind, deviceId: command.context.deviceId }),
  };
  let semantic: Record<string, unknown>;
  switch (command.kind) {
    case 'bootstrap': semantic = { ...common, ownerPrincipalId: command.ownerPrincipalId, targetId: command.targetId,
      hostId: command.hostId, deploymentGeneration: command.deploymentGeneration,
      adapterIdentity: command.adapterIdentity, adapterVersion: command.adapterVersion }; break;
    case 'local_device_bootstrap': semantic = { ...common, ownerPrincipalId: command.ownerPrincipalId,
      adapterIdentity: command.adapterIdentity, adapterVersion: command.adapterVersion }; break;
    case 'target_replace': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision,
      targetId: command.targetId, hostId: command.hostId, deploymentGeneration: command.deploymentGeneration }; break;
    case 'adapter_select': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision,
      adapterIdentity: command.adapterIdentity, adapterVersion: command.adapterVersion }; break;
    case 'local_device_bind': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision,
      deviceId: command.deviceId, publicKey: command.publicKey,
      enrolledByCredentialId: command.enrolledByCredentialId, enrolledAt: command.enrolledAt }; break;
    case 'local_device_revoke': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision, revokedAt: command.revokedAt }; break;
    case 'local_device_enrollment_start': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision, enrollmentId: command.enrollmentId, deviceId: command.deviceId, publicKey: command.publicKey, secretHash: command.secretHash, challenge: command.challenge, expiresAt: command.expiresAt, enrolledByCredentialId: command.enrolledByCredentialId, enrolledAt: command.enrolledAt, startRequestDigest: command.startRequestDigest }; break;
    case 'local_device_enrollment_complete': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision, enrollmentId: command.enrollmentId, credentialId: command.credentialId, credentialVerifierHash: command.credentialVerifierHash, credentialExpiresAt: command.credentialExpiresAt, completionRequestDigest: command.completionRequestDigest }; break;
    case 'local_device_reauth_issue': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision, credentialId: command.credentialId, proofChallengeId: command.proofChallengeId, purpose: command.purpose, expiresAt: command.expiresAt, rotationId: command.rotationId, reauthSequence: command.reauthSequence }; break;
    case 'local_device_reauth_consume': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision, credentialId: command.credentialId, proofChallengeId: command.proofChallengeId, purpose: command.purpose, expiresAt: command.expiresAt, rotationId: command.rotationId, reauthSequence: command.reauthSequence }; break;
    case 'local_device_credential_prepare': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision, credentialId: command.credentialId, proofChallengeId: command.proofChallengeId, purpose: command.purpose, expiresAt: command.expiresAt, rotationId: command.rotationId, reauthSequence: command.reauthSequence, successorCredentialId: command.successorCredentialId, successorVerifierHash: command.successorVerifierHash, successorExpiresAt: command.successorExpiresAt, rotationRequestDigest: command.rotationRequestDigest }; break;
    case 'local_device_credential_activate': semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision, credentialId: command.credentialId, proofChallengeId: command.proofChallengeId, purpose: command.purpose, expiresAt: command.expiresAt, rotationId: command.rotationId, reauthSequence: command.reauthSequence }; break;
    default: semantic = { ...common, expectedCapabilitiesRevision: command.expectedCapabilitiesRevision };
  }
  return `v1.${createHash('sha256').update(JSON.stringify(semantic)).digest('base64url')}`;
}
function rotationRequestDigest(input: {
  brainId: string; deviceId: string; authorityRevision: string; credentialId: string; proofChallengeId: string;
  purpose: 'credential_refresh'; expiresAt: string; rotationId: string; successorCredentialId: string;
  successorVerifierHash: string; successorExpiresAt: string;
}): string {
  return `v1.${createHash('sha256').update(JSON.stringify(input)).digest('base64url')}`;
}
/** Canonical idempotency digest for a validated fixed public authority command. */
export function brainAuthorizationAuthorityCommandDigest(command: BrainAuthorizationAuthorityCommand): string {
  return authorityCommandDigest(command);
}
function bootstrapRecord(command: Extract<BrainAuthorizationAuthorityCommand, { kind: 'bootstrap' }>): AuthorityRecord {
  return withCapabilityRevision({ schema_version: 1, brain_id: command.brainId, owner_principal_id: command.ownerPrincipalId,
    owner_status: 'active', target_id: command.targetId, target_disposition: 'active', host_id: command.hostId,
    deployment_generation: command.deploymentGeneration, adapter_identity: command.adapterIdentity,
    adapter_version: command.adapterVersion, adapter_disposition: 'selected', fencing_epoch: 1, credential_revision: 1,
    capability_policy_revision: 1, last_command_digest: authorityCommandDigest(command),
    last_command_id: command.commandId, last_command_kind: command.kind, local_device: null, local_device_enrollment: null });
}
function localDeviceBootstrapRecord(command: Extract<BrainAuthorizationAuthorityCommand, { kind: 'local_device_bootstrap' }>): AuthorityRecord {
  return withCapabilityRevision({ schema_version: 1, brain_id: command.brainId, owner_principal_id: command.ownerPrincipalId,
    owner_status: 'active', target_id: null, target_disposition: 'revoked', host_id: null,
    deployment_generation: 0, adapter_identity: command.adapterIdentity, adapter_version: command.adapterVersion,
    adapter_disposition: 'selected', fencing_epoch: 1, credential_revision: 1, capability_policy_revision: 1,
    last_command_digest: authorityCommandDigest(command), last_command_id: command.commandId,
    last_command_kind: command.kind, local_device: null, local_device_enrollment: null });
}
function transition(record: AuthorityRecord, command: Exclude<InternalAuthorityCommand, { kind: 'bootstrap' }>, nowMs?: number): AuthorityRecord | null {
  const operational = command.kind === 'local_device_reauth_issue' || command.kind === 'local_device_reauth_consume'
    || command.kind === 'local_device_credential_prepare' || command.kind === 'local_device_credential_activate';
  if (!operational && record.fencing_epoch === Number.MAX_SAFE_INTEGER) return null;
  const base = { ...record, fencing_epoch: operational ? record.fencing_epoch : record.fencing_epoch + 1,
    last_command_digest: authorityCommandDigest(command), last_command_id: command.commandId, last_command_kind: command.kind,
    ...(operational ? {} : { local_device_reauth: null, local_device_credential_pending: null }) };
  switch (command.kind) {
    case 'target_replace':
      if (command.deploymentGeneration <= record.deployment_generation) return null;
      return withCapabilityRevision({ ...base, target_id: command.targetId, target_disposition: 'active', host_id: command.hostId, deployment_generation: command.deploymentGeneration });
    case 'target_revoke': return record.target_disposition === 'active'
      ? withCapabilityRevision({ ...base, target_id: null, target_disposition: 'revoked', host_id: null })
      : null;
    case 'owner_revoke': return record.credential_revision === Number.MAX_SAFE_INTEGER ? null
      : withCapabilityRevision({ ...base, owner_status: 'revoked', credential_revision: record.credential_revision + 1,
        local_device_credential: null, local_device_reauth: null });
    case 'credential_revoke': return record.credential_revision === Number.MAX_SAFE_INTEGER ? null
      : withCapabilityRevision({ ...base, credential_revision: record.credential_revision + 1,
        local_device_credential: null, local_device_reauth: null });
    case 'adapter_select': return record.adapter_disposition === 'selected'
      && record.adapter_identity === command.adapterIdentity && record.adapter_version === command.adapterVersion
      ? null
      : withCapabilityRevision({ ...base, adapter_identity: command.adapterIdentity, adapter_version: command.adapterVersion, adapter_disposition: 'selected' });
    case 'adapter_disable': return record.adapter_disposition === 'selected'
      ? withCapabilityRevision({ ...base, adapter_identity: null, adapter_version: null, adapter_disposition: 'disabled' })
      : null;
    case 'policy_change': return record.capability_policy_revision === Number.MAX_SAFE_INTEGER ? null
      : withCapabilityRevision({ ...base, capability_policy_revision: record.capability_policy_revision + 1 });
    case 'local_device_bind':
      if (record.local_device !== undefined && record.local_device !== null) return null;
      return withCapabilityRevision({ ...base, local_device: {
        schema_version: 1, device_id: command.deviceId, brain_id: record.brain_id,
        owner_principal_id: record.owner_principal_id, public_key_algorithm: 'ed25519', public_key: command.publicKey,
        public_key_fingerprint: createHash('sha256').update(Buffer.from(command.publicKey, 'base64url')).digest('hex'),
        state: 'active', authority_capabilities_revision: 'pending', enrolled_by_credential_id: command.enrolledByCredentialId,
        enrolled_at: command.enrolledAt, revoked_at: null, last_seen_at: null,
      } });
    case 'local_device_revoke':
      if (!record.local_device || record.local_device.state !== 'active') return null;
      if ((record.local_device_revoke_receipts?.length ?? 0) >= MAX_LOCAL_DEVICE_REVOKE_RECEIPTS) return null;
      const revoked = withCapabilityRevision({ ...base, local_device: {
        ...record.local_device, state: 'revoked', revoked_at: command.revokedAt,
      }, local_device_enrollment: null, local_device_credential: null, local_device_credential_pending: null, local_device_reauth: null });
      return { ...revoked, local_device_revoke_receipts: [
        ...(record.local_device_revoke_receipts ?? []),
        { schema_version: 1, command_id: command.commandId, command_digest: authorityCommandDigest(command),
          owner_principal_id: command.context.principalId, device_id: record.local_device.device_id,
          revoked_at: command.revokedAt, authority_capabilities_revision: revoked.capabilities_revision },
      ] };
    case 'local_device_enrollment_start':
      // An active enrolled device can only be replaced through the explicit
      // fenced revoke path. Starting a new enrollment here would return a
      // one-time secret that completion must subsequently refuse.
      if (record.local_device?.state === 'active'
        || (record.local_device_enrollment !== undefined && record.local_device_enrollment !== null
        && (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Date.parse(record.local_device_enrollment.expires_at) > nowMs))) return null;
      return withCapabilityRevision({ ...base, local_device_enrollment: { enrollment_id: command.enrollmentId, device_id: command.deviceId, public_key: command.publicKey, secret_hash: command.secretHash, challenge: command.challenge, expires_at: command.expiresAt, enrolled_by_credential_id: command.enrolledByCredentialId, enrolled_at: command.enrolledAt, start_command_id: command.commandId, start_request_digest: command.startRequestDigest } });
    case 'local_device_enrollment_complete': {
      const pending = record.local_device_enrollment;
      // Replacement is permitted only after the prior device's fenced revoke
      // barrier. An active device can never be silently replaced.
      if (!pending || pending.enrollment_id !== command.enrollmentId || record.local_device?.state === 'active'
        || typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Date.parse(pending.expires_at) <= nowMs) return null;
      return withCapabilityRevision({ ...base, local_device_enrollment: null, local_device: {
        schema_version: 1, device_id: pending.device_id, brain_id: record.brain_id, owner_principal_id: record.owner_principal_id,
        public_key_algorithm: 'ed25519', public_key: pending.public_key, public_key_fingerprint: createHash('sha256').update(Buffer.from(pending.public_key, 'base64url')).digest('hex'), state: 'active', authority_capabilities_revision: 'pending', enrolled_by_credential_id: pending.enrolled_by_credential_id, enrolled_at: pending.enrolled_at, revoked_at: null, last_seen_at: null,
      }, local_device_credential: {
        credential_id: command.credentialId, verifier_hash: command.credentialVerifierHash, expires_at: command.credentialExpiresAt,
        brain_id: record.brain_id, device_id: pending.device_id, owner_principal_id: record.owner_principal_id,
        authority_capabilities_revision: 'pending', completion_command_id: command.commandId, completion_request_digest: command.completionRequestDigest,
      } });
    }
    case 'local_device_reauth_issue':
      // Possession of the bearer credential alone must not let a caller evict a
      // proof challenge that still requires the enrolled device's private key.
      // The strict `>` keeps the established exact-expiry replacement boundary.
      if (record.local_device_reauth != null
        && (typeof nowMs !== 'number' || Date.parse(record.local_device_reauth.expires_at) > nowMs)) return null;
      if (command.purpose === 'credential_refresh' && record.local_device_credential_pending != null
        && (typeof nowMs !== 'number' || Date.parse(record.local_device_credential_pending.expires_at) > nowMs)) return null;
      if ((record.local_device_reauth_sequence ?? 0) === Number.MAX_SAFE_INTEGER
        || command.reauthSequence !== (record.local_device_reauth_sequence ?? 0) + 1
        || !reauthIdentifierMatchesSequence(command.proofChallengeId, 'pop', command.reauthSequence)
        || (command.purpose === 'credential_activate' ? !validId(command.rotationId)
          : !reauthIdentifierMatchesSequence(command.rotationId, 'rot', command.reauthSequence))) return null;
      const issuingCredential = command.purpose === 'credential_activate'
        ? record.local_device_credential_pending : record.local_device_credential;
      if (record.local_device?.state !== 'active' || record.local_device.device_id !== command.context.deviceId
        || record.local_device.authority_capabilities_revision !== record.capabilities_revision
        || issuingCredential?.credential_id !== command.credentialId
        || issuingCredential.authority_capabilities_revision !== record.capabilities_revision
        || (command.purpose === 'credential_activate' && issuingCredential.rotation_id !== command.rotationId)
        || typeof nowMs !== 'number' || Date.parse(issuingCredential.expires_at) <= nowMs
        || Date.parse(command.expiresAt) <= nowMs || Date.parse(command.expiresAt) - nowMs > MAX_REAUTH_CHALLENGE_TTL_MS) return null;
      return withCapabilityRevision({ ...base,
        ...(command.purpose === 'credential_refresh' ? { local_device_credential_pending: null } : {}),
        local_device_reauth_sequence: command.reauthSequence, local_device_reauth: {
        proof_challenge_id: command.proofChallengeId, credential_id: command.credentialId, purpose: command.purpose,
        expires_at: command.expiresAt, rotation_id: command.rotationId, reauth_sequence: command.reauthSequence, brain_id: record.brain_id,
        device_id: command.context.deviceId, authority_capabilities_revision: record.capabilities_revision,
      } });
    case 'local_device_reauth_consume': {
      const challenge = record.local_device_reauth;
      if (!challenge || challenge.proof_challenge_id !== command.proofChallengeId || challenge.credential_id !== command.credentialId
        || challenge.purpose !== command.purpose || challenge.expires_at !== command.expiresAt || challenge.rotation_id !== command.rotationId
        || challenge.reauth_sequence !== command.reauthSequence
        || typeof nowMs !== 'number' || Date.parse(challenge.expires_at) <= nowMs
        || !record.local_device_credential || Date.parse(record.local_device_credential.expires_at) <= nowMs) return null;
      return withCapabilityRevision({ ...base, local_device_reauth: null });
    }
    case 'local_device_credential_prepare': {
      const challenge = record.local_device_reauth;
      if (!challenge || challenge.proof_challenge_id !== command.proofChallengeId || challenge.credential_id !== command.credentialId
        || challenge.purpose !== command.purpose || challenge.expires_at !== command.expiresAt || challenge.rotation_id !== command.rotationId
        || challenge.reauth_sequence !== command.reauthSequence
        || record.local_device_credential?.credential_id !== command.credentialId || typeof nowMs !== 'number'
        || command.successorCredentialId === record.local_device_credential.credential_id
        || equalSha256(command.successorVerifierHash, record.local_device_credential.verifier_hash)
        || Date.parse(challenge.expires_at) <= nowMs || Date.parse(record.local_device_credential.expires_at) <= nowMs
        || Date.parse(command.successorExpiresAt) - nowMs < MIN_DEVICE_TTL_MS
        || Date.parse(command.successorExpiresAt) - nowMs > MAX_DEVICE_CREDENTIAL_TTL_MS) return null;
      return withCapabilityRevision({ ...base, local_device_reauth: null, local_device_credential_pending: {
        credential_id: command.successorCredentialId, verifier_hash: command.successorVerifierHash, expires_at: command.successorExpiresAt,
        brain_id: record.brain_id, device_id: command.context.deviceId, owner_principal_id: record.owner_principal_id,
        authority_capabilities_revision: record.capabilities_revision, prior_credential_id: command.credentialId, rotation_id: command.rotationId,
        prepare_command_id: command.commandId, prepare_request_digest: command.rotationRequestDigest,
      } });
    }
    case 'local_device_credential_activate': {
      const challenge = record.local_device_reauth;
      const pending = record.local_device_credential_pending;
      if (!challenge || !pending || challenge.proof_challenge_id !== command.proofChallengeId
        || challenge.credential_id !== command.credentialId || challenge.purpose !== command.purpose
        || challenge.expires_at !== command.expiresAt || challenge.rotation_id !== command.rotationId
        || challenge.reauth_sequence !== command.reauthSequence || pending.credential_id !== command.credentialId
        || pending.rotation_id !== command.rotationId || pending.prior_credential_id !== record.local_device_credential?.credential_id
        || typeof nowMs !== 'number' || Date.parse(challenge.expires_at) <= nowMs || Date.parse(pending.expires_at) <= nowMs) return null;
      return withCapabilityRevision({ ...base, local_device_reauth: null, local_device_credential_pending: null,
        local_device_credential: {
          credential_id: pending.credential_id, verifier_hash: pending.verifier_hash, expires_at: pending.expires_at,
          brain_id: pending.brain_id, device_id: pending.device_id, owner_principal_id: pending.owner_principal_id,
          authority_capabilities_revision: pending.authority_capabilities_revision, prior_credential_id: pending.prior_credential_id,
          rotation_id: pending.rotation_id, rotation_command_id: command.commandId,
          rotation_request_digest: pending.prepare_request_digest,
        } });
    }
  }
}
function commandIsValid(command: InternalAuthorityCommand): boolean {
  if (!isObject(command) || !validId(command.commandId) || !validId(command.brainId) || !isObject(command.context)) return false;
  const deviceCommand = command.kind === 'local_device_reauth_issue' || command.kind === 'local_device_reauth_consume'
    || command.kind === 'local_device_credential_prepare' || command.kind === 'local_device_credential_activate';
  if (deviceCommand) {
    if (!exactKeys(command.context, ['deviceId', 'kind']) || command.context.kind !== 'local_device_connector' || !validDeviceId(command.context.deviceId)) return false;
  } else if (!exactKeys(command.context, ['kind', 'principalId']) || command.context.kind !== 'authenticated_external_owner' || !validId(command.context.principalId)) return false;
  if (command.kind === 'bootstrap') return exactKeys(command, ['adapterIdentity', 'adapterVersion', 'brainId', 'commandId', 'context', 'deploymentGeneration', 'hostId', 'kind', 'ownerPrincipalId', 'targetId'])
    && validId(command.ownerPrincipalId) && command.context.principalId === command.ownerPrincipalId
    && validId(command.targetId) && validId(command.hostId) && validRevisionNumber(command.deploymentGeneration) && command.deploymentGeneration > 0
    && validId(command.adapterIdentity) && validId(command.adapterVersion);
  if (command.kind === 'local_device_bootstrap') return exactKeys(command, ['adapterIdentity', 'adapterVersion', 'brainId', 'commandId', 'context', 'kind', 'ownerPrincipalId'])
    && validId(command.ownerPrincipalId) && command.context.principalId === command.ownerPrincipalId
    && validId(command.adapterIdentity) && validId(command.adapterVersion);
  if (!validOpaqueRevision(command.expectedCapabilitiesRevision)) return false;
  if (command.kind === 'target_replace') return exactKeys(command, ['brainId', 'commandId', 'context', 'deploymentGeneration', 'expectedCapabilitiesRevision', 'hostId', 'kind', 'targetId'])
    && validId(command.targetId) && validId(command.hostId)
    && validRevisionNumber(command.deploymentGeneration) && command.deploymentGeneration > 0;
  if (command.kind === 'adapter_select') return exactKeys(command, ['adapterIdentity', 'adapterVersion', 'brainId', 'commandId', 'context', 'expectedCapabilitiesRevision', 'kind'])
    && validId(command.adapterIdentity) && validId(command.adapterVersion);
  if (command.kind === 'local_device_bind') return exactKeys(command, ['brainId', 'commandId', 'context', 'deviceId', 'enrolledAt', 'enrolledByCredentialId', 'expectedCapabilitiesRevision', 'kind', 'publicKey'])
    && validDeviceId(command.deviceId) && canonicalEd25519PublicKey(command.publicKey)
    && validId(command.enrolledByCredentialId) && validTimestamp(command.enrolledAt);
  if (command.kind === 'local_device_revoke') return exactKeys(command, ['brainId', 'commandId', 'context', 'expectedCapabilitiesRevision', 'kind', 'revokedAt'])
    && validTimestamp(command.revokedAt);
  if (command.kind === 'local_device_enrollment_start') return exactKeys(command, ['brainId', 'challenge', 'commandId', 'context', 'deviceId', 'enrolledAt', 'enrolledByCredentialId', 'enrollmentId', 'expectedCapabilitiesRevision', 'expiresAt', 'kind', 'publicKey', 'secretHash', 'startRequestDigest'])
    && validEnrollmentId(command.enrollmentId) && validDeviceId(command.deviceId) && canonicalEd25519PublicKey(command.publicKey) && validSha256Hex(command.secretHash) && validOpaqueRevision(command.challenge) && validTimestamp(command.expiresAt) && validId(command.enrolledByCredentialId) && validTimestamp(command.enrolledAt) && validOpaqueRevision(command.startRequestDigest);
  if (command.kind === 'local_device_enrollment_complete') {
    const valid = exactKeys(command, ['brainId', 'commandId', 'completionRequestDigest', 'context', 'credentialExpiresAt', 'credentialId', 'credentialVerifierHash', 'enrollmentId', 'expectedCapabilitiesRevision', 'kind'])
      && validEnrollmentId(command.enrollmentId) && validId(command.credentialId) && validSha256Hex(command.credentialVerifierHash) && validTimestamp(command.credentialExpiresAt) && validOpaqueRevision(command.completionRequestDigest);
    return valid;
  }
  if (command.kind === 'local_device_reauth_issue') return exactKeys(command, ['brainId', 'commandId', 'context', 'credential', 'credentialId', 'expectedCapabilitiesRevision', 'expiresAt', 'kind', 'proofChallengeId', 'purpose', 'reauthSequence', 'rotationId'])
    && validConnectorCredential(command.credential) && validId(command.credentialId) && validRevisionNumber(command.reauthSequence) && command.reauthSequence > 0
    && reauthIdentifierMatchesSequence(command.proofChallengeId, 'pop', command.reauthSequence) && ['socket_open', 'credential_refresh', 'credential_activate'].includes(command.purpose)
    && validTimestamp(command.expiresAt) && (command.purpose === 'credential_activate' ? validId(command.rotationId) : reauthIdentifierMatchesSequence(command.rotationId, 'rot', command.reauthSequence));
  if (command.kind === 'local_device_reauth_consume') return exactKeys(command, ['brainId', 'commandId', 'context', 'credential', 'credentialId', 'expectedCapabilitiesRevision', 'expiresAt', 'kind', 'proofChallengeId', 'purpose', 'reauthSequence', 'rotationId', 'signature'])
    && validConnectorCredential(command.credential) && validId(command.credentialId) && validRevisionNumber(command.reauthSequence) && command.reauthSequence > 0
    && reauthIdentifierMatchesSequence(command.proofChallengeId, 'pop', command.reauthSequence) && command.purpose === 'socket_open'
    && validTimestamp(command.expiresAt) && reauthIdentifierMatchesSequence(command.rotationId, 'rot', command.reauthSequence) && validEd25519Signature(command.signature);
  if (command.kind === 'local_device_credential_prepare') return exactKeys(command, ['brainId', 'commandId', 'context', 'credential', 'credentialId', 'expectedCapabilitiesRevision', 'expiresAt', 'kind', 'proofChallengeId', 'purpose', 'reauthSequence', 'rotationId', 'rotationRequestDigest', 'signature', 'successorCredentialId', 'successorExpiresAt', 'successorVerifierHash'])
    && validId(command.credentialId) && validRevisionNumber(command.reauthSequence) && command.reauthSequence > 0
    && reauthIdentifierMatchesSequence(command.proofChallengeId, 'pop', command.reauthSequence) && command.purpose === 'credential_refresh'
    && validTimestamp(command.expiresAt) && reauthIdentifierMatchesSequence(command.rotationId, 'rot', command.reauthSequence)
    && validConnectorCredential(command.credential) && validEd25519Signature(command.signature) && validOpaqueRevision(command.rotationRequestDigest) && validId(command.successorCredentialId) && validTimestamp(command.successorExpiresAt) && validSha256Hex(command.successorVerifierHash);
  if (command.kind === 'local_device_credential_activate') return exactKeys(command, ['brainId', 'commandId', 'context', 'credential', 'credentialId', 'expectedCapabilitiesRevision', 'expiresAt', 'kind', 'proofChallengeId', 'purpose', 'reauthSequence', 'rotationId', 'signature'])
    && validConnectorCredential(command.credential) && validId(command.credentialId) && validRevisionNumber(command.reauthSequence) && command.reauthSequence > 0
    && reauthIdentifierMatchesSequence(command.proofChallengeId, 'pop', command.reauthSequence) && command.purpose === 'credential_activate'
    && validTimestamp(command.expiresAt) && validId(command.rotationId) && validEd25519Signature(command.signature);
  return ['target_revoke', 'owner_revoke', 'credential_revoke', 'adapter_disable', 'policy_change'].includes(command.kind)
    && exactKeys(command, ['brainId', 'commandId', 'context', 'expectedCapabilitiesRevision', 'kind']);
}
function snapshotCommand(value: unknown): InternalAuthorityCommand | null {
  try {
    if (!isPlainDataObject(value)) return null;
    const context = Object.getOwnPropertyDescriptor(value, 'context')?.value;
    if (!isPlainDataObject(context)) return null;
    const snapshot = structuredClone(value) as InternalAuthorityCommand;
    return commandIsValid(snapshot) ? snapshot : null;
  } catch { return null; }
}
function legacyOwnershipHintIsAbsent(metadata: unknown): boolean {
  if (metadata === undefined || metadata === null) return true;
  if (!isObject(metadata)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(metadata, 'archive_tenant_id');
  if (!descriptor) return true;
  // Once durable authority is selected, any legacy ownership hint is a second
  // possible owner signal. It remains migration evidence only and must deny.
  return false;
}
type DecisionBrainSnapshot =
  | { disposition: 'valid'; brain: Pick<Brain, 'id' | 'metadata'> }
  | { disposition: 'invalid_id' }
  | { disposition: 'invalid_metadata'; brainId: string };

function snapshotDecisionBrain(input: unknown): DecisionBrainSnapshot {
  let brainId: string | undefined;
  try {
    if (!isPlainDataObject(input)) return { disposition: 'invalid_id' };
    const brain = Object.getOwnPropertyDescriptor(input, 'brain')?.value;
    if (!isPlainDataObject(brain)) return { disposition: 'invalid_id' };
    const idDescriptor = Object.getOwnPropertyDescriptor(brain, 'id');
    if (!idDescriptor || !('value' in idDescriptor) || !validId(idDescriptor.value)) return { disposition: 'invalid_id' };
    brainId = idDescriptor.value;
    const metadataDescriptor = Object.getOwnPropertyDescriptor(brain, 'metadata');
    if (metadataDescriptor && !('value' in metadataDescriptor)) return { disposition: 'invalid_metadata', brainId };
    const metadata = metadataDescriptor ? structuredClone(metadataDescriptor.value) : undefined;
    return { disposition: 'valid', brain: { id: brainId, metadata } as Pick<Brain, 'id' | 'metadata'> };
  } catch {
    return brainId ? { disposition: 'invalid_metadata', brainId } : { disposition: 'invalid_id' };
  }
}
function commandMatches(record: AuthorityRecord, command: InternalAuthorityCommand): boolean {
  if (record.last_command_id !== command.commandId || record.last_command_kind !== command.kind || record.brain_id !== command.brainId
    || (command.context.kind === 'authenticated_external_owner'
      ? command.context.principalId !== record.owner_principal_id
      : command.context.deviceId !== record.local_device?.device_id)) return false;
  return record.last_command_digest === authorityCommandDigest(command);
}
function credentialForDeviceCommand(
  record: AuthorityRecord,
  command: Extract<InternalAuthorityCommand, { context: LocalDeviceConnectorContext }>,
): LocalDeviceCredentialVerifier | LocalDevicePendingCredential | null | undefined {
  return (command.kind === 'local_device_reauth_issue' && command.purpose === 'credential_activate')
    || command.kind === 'local_device_credential_activate'
    ? record.local_device_credential_pending : record.local_device_credential;
}
function deviceCommandIsAuthorized(
  record: AuthorityRecord,
  command: Extract<InternalAuthorityCommand, { context: LocalDeviceConnectorContext }>,
  nowMs: number,
): boolean {
  const device = record.local_device;
  const currentCredential = record.local_device_credential;
  const credential = credentialForDeviceCommand(record, command);
  if (record.owner_status !== 'active' || device?.state !== 'active' || device.device_id !== command.context.deviceId
    || device.authority_capabilities_revision !== record.capabilities_revision
    || !credential || credential.credential_id !== command.credentialId || credential.device_id !== device.device_id
    || credential.authority_capabilities_revision !== record.capabilities_revision
    || Date.parse(credential.expires_at) <= nowMs
    || !equalSha256(credential.verifier_hash, createHash('sha256').update(command.credential).digest('hex'))) return false;
  if (command.kind === 'local_device_reauth_issue') {
    const ttlMs = Date.parse(command.expiresAt) - nowMs;
    const exactActiveRetry = commandMatches(record, command)
      && record.local_device_reauth?.reauth_sequence === command.reauthSequence
      && record.local_device_reauth.proof_challenge_id === command.proofChallengeId
      && Date.parse(record.local_device_reauth.expires_at) > nowMs;
    return exactActiveRetry || (ttlMs >= MIN_DEVICE_TTL_MS && ttlMs <= MAX_REAUTH_CHALLENGE_TTL_MS
      && Date.parse(command.expiresAt) <= Date.parse(credential.expires_at)
      && command.reauthSequence === (record.local_device_reauth_sequence ?? 0) + 1
      && reauthIdentifierMatchesSequence(command.proofChallengeId, 'pop', command.reauthSequence)
      && (command.purpose === 'credential_activate' ? command.rotationId === record.local_device_credential_pending?.rotation_id
        : reauthIdentifierMatchesSequence(command.rotationId, 'rot', command.reauthSequence)));
  }
  const challenge = record.local_device_reauth;
  if (!challenge || challenge.proof_challenge_id !== command.proofChallengeId
    || challenge.credential_id !== command.credentialId || challenge.purpose !== command.purpose
    || challenge.expires_at !== command.expiresAt || challenge.rotation_id !== command.rotationId
    || challenge.reauth_sequence !== command.reauthSequence
    || challenge.brain_id !== record.brain_id || challenge.device_id !== device.device_id
    || challenge.authority_capabilities_revision !== record.capabilities_revision
    || Date.parse(challenge.expires_at) <= nowMs) return false;
  let signatureValid = false;
  try {
    const payload = canonicalDeviceReauthProofPayload({
      fence: { brainId: record.brain_id, deviceId: device.device_id, authorityRevision: record.capabilities_revision },
      credentialId: command.credentialId, proofChallengeId: command.proofChallengeId, purpose: command.purpose,
      expiresAt: command.expiresAt, rotationId: command.rotationId,
    });
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(device.public_key, 'base64url')]);
    signatureValid = verify(null, Buffer.from(payload, 'utf8'), { key: spki, format: 'der', type: 'spki' }, Buffer.from(command.signature, 'base64url'));
  } catch { return false; }
  if (!signatureValid) return false;
  if (command.kind === 'local_device_credential_prepare') {
    const successorTtlMs = Date.parse(command.successorExpiresAt) - nowMs;
    return !!currentCredential && command.successorCredentialId !== currentCredential.credential_id
      && !equalSha256(command.successorVerifierHash, currentCredential.verifier_hash)
      && successorTtlMs >= MIN_DEVICE_TTL_MS && successorTtlMs <= MAX_DEVICE_CREDENTIAL_TTL_MS;
  }
  return true;
}

/** Private single-record authority. It accepts no storage coordinates or generic patches. */
export class BrainAuthorizationAuthorityRepository {
  constructor(private readonly cas: BrainAuthorizationAuthorityCasClient, private readonly options: { now?: () => Date } = {}) {}

  private async read(brainId: string): Promise<{ disposition: 'missing' | 'invalid' | 'unavailable' } | ({ disposition: 'current' } & CurrentAuthority)> {
    let result: CasGetResult;
    try { result = await this.cas.getDocument(COLLECTION, documentKey(brainId)); } catch { return { disposition: 'unavailable' }; }
    if (!result.ok) return result.code === 'DOCUMENT_NOT_FOUND' ? { disposition: 'missing' } : { disposition: 'invalid' };
    const parsed = parseDocument(result.document, brainId);
    return parsed ? { disposition: 'current', ...parsed } : { disposition: 'invalid' };
  }

  async inspect(brainId: string): Promise<AuthorityInspection> {
    if (!validId(brainId)) return { disposition: 'invalid' };
    const read = await this.read(brainId);
    if (read.disposition !== 'current') return read;
    return { disposition: 'current', record: structuredClone(read.record), fence: fenceFor(read.record) };
  }

  /**
   * Owner-facing revoke with a durable command receipt.  The caller supplies
   * no timestamp or fence: both are derived from the current authority state.
   * A receipt is checked again after any non-success result so concurrent
   * duplicates and a lost transport response recover to the original outcome.
   */
  async revokeLocalDevice(input: { commandId: string; brainId: string; context: AuthenticatedOwnerContext }): Promise<AuthorityCommandResult> {
    if (!isPlainDataObject(input) || !exactKeys(input, ['brainId', 'commandId', 'context'])
      || !validId(input.commandId) || !validId(input.brainId)
      || !isPlainDataObject(input.context) || !exactKeys(input.context, ['kind', 'principalId'])
      || input.context.kind !== 'authenticated_external_owner' || !validId(input.context.principalId)) return { status: 'denied' };
    let request: typeof input;
    try { request = structuredClone(input); } catch { return { status: 'denied' }; }
    const current = await this.read(request.brainId);
    if (current.disposition === 'unavailable') return { status: 'unavailable' };
    if (current.disposition === 'invalid') return { status: 'unavailable' };
    if (current.disposition !== 'current' || current.record.owner_principal_id !== request.context.principalId) return { status: 'denied' };
    const receipt = revokeReceiptFor(current.record, request.context.principalId, request.commandId);
    if (receipt) return { status: 'idempotent', fence: fenceFor(current.record) };
    if (current.record.owner_status !== 'active') return { status: 'denied' };
    if (current.record.local_device?.state !== 'active') return { status: 'denied' };
    let revokedAt: string;
    try { revokedAt = (this.options.now ?? (() => new Date()))().toISOString(); } catch { return { status: 'unavailable' }; }
    if (!validTimestamp(revokedAt)) return { status: 'unavailable' };
    const result = await this.#executeCommand({ kind: 'local_device_revoke', commandId: request.commandId,
      brainId: request.brainId, context: request.context,
      expectedCapabilitiesRevision: current.record.capabilities_revision, revokedAt });
    if (result.status === 'applied' || result.status === 'idempotent') return result;
    const reread = await this.read(request.brainId);
    if (reread.disposition === 'unavailable') return { status: 'unavailable' };
    if (reread.disposition === 'current' && reread.record.owner_principal_id === request.context.principalId
      && revokeReceiptFor(reread.record, request.context.principalId, request.commandId)) {
      return { status: 'idempotent', fence: fenceFor(reread.record) };
    }
    return result;
  }

  private async reconcile(
    command: InternalAuthorityCommand,
    intended: AuthorityRecord,
    priorRevision?: string,
  ): Promise<AuthorityCommandResult> {
    const reread = await this.read(command.brainId);
    if (reread.disposition === 'unavailable') return { status: 'unavailable' };
    if (reread.disposition !== 'current') return { status: 'conflict' };
    return (priorRevision === undefined || reread.revision !== priorRevision)
      && commandMatches(reread.record, command) && exactJson(reread.record, intended)
      ? { status: 'idempotent', fence: fenceFor(reread.record) }
      : { status: 'conflict' };
  }

  async issueLocalDeviceReauthChallenge(input: {
    commandId: string; brainId: string; context: LocalDeviceConnectorContext; credential: string;
    expectedCapabilitiesRevision: string; purpose: 'socket_open' | 'credential_refresh' | 'credential_activate'; expiresAt: string;
  }): Promise<LocalDeviceReauthChallengeIssueResult> {
    if (!isPlainDataObject(input)
      || !exactKeys(input, ['brainId', 'commandId', 'context', 'credential', 'expectedCapabilitiesRevision', 'expiresAt', 'purpose'])
      || !validId(input.commandId) || !validId(input.brainId) || !validConnectorCredential(input.credential)
      || !validOpaqueRevision(input.expectedCapabilitiesRevision) || !validTimestamp(input.expiresAt)
      || !['socket_open', 'credential_refresh', 'credential_activate'].includes(input.purpose)
      || !isPlainDataObject(input.context) || !exactKeys(input.context, ['deviceId', 'kind'])
      || input.context.kind !== 'local_device_connector' || !validDeviceId(input.context.deviceId)) return { status: 'denied' };
    let request: typeof input;
    try { request = structuredClone(input); } catch { return { status: 'denied' }; }
    const current = await this.read(request.brainId);
    if (current.disposition === 'unavailable') return { status: 'unavailable' };
    if (current.disposition !== 'current') return { status: 'denied' };
    if (current.record.last_command_kind === 'local_device_reauth_issue'
      && current.record.last_command_id === request.commandId) return { status: 'indeterminate' };
    if (current.record.capabilities_revision !== request.expectedCapabilitiesRevision) return { status: 'conflict' };
    const credential = request.purpose === 'credential_activate'
      ? current.record.local_device_credential_pending : current.record.local_device_credential;
    const reauthSequence = (current.record.local_device_reauth_sequence ?? 0) + 1;
    if (!credential || !Number.isSafeInteger(reauthSequence)) return { status: 'denied' };
    let proofChallengeId: string;
    let rotationId: string;
    try {
      proofChallengeId = mintReauthIdentifier('pop', reauthSequence);
      rotationId = request.purpose === 'credential_activate' && credential && 'rotation_id' in credential
        ? credential.rotation_id : mintReauthIdentifier('rot', reauthSequence);
    } catch { return { status: 'unavailable' }; }
    const command: LocalDeviceReauthIssueCommand = {
      kind: 'local_device_reauth_issue', commandId: request.commandId, brainId: request.brainId,
      context: request.context, credential: request.credential, expectedCapabilitiesRevision: request.expectedCapabilitiesRevision,
      credentialId: credential.credential_id, proofChallengeId, purpose: request.purpose, expiresAt: request.expiresAt,
      rotationId, reauthSequence,
    };
    const result = await this.#executeCommand(command);
    if (result.status !== 'applied' && result.status !== 'idempotent') return result;
    return { status: 'issued', brainId: request.brainId, deviceId: request.context.deviceId,
      authorityRevision: request.expectedCapabilitiesRevision, credentialId: credential.credential_id,
      proofChallengeId, purpose: request.purpose, expiresAt: request.expiresAt, rotationId, reauthSequence };
  }

  async advanceLocalDeviceCredentialRotation(input: LocalDeviceCredentialRotationInput): Promise<LocalDeviceCredentialRotationResult> {
    if (!isPlainDataObject(input) || (input.phase !== 'prepare' && input.phase !== 'activate')) return { status: 'denied' };
    const expectedKeys = input.phase === 'prepare'
      ? ['brainId', 'commandId', 'context', 'credential', 'credentialId', 'expectedCapabilitiesRevision', 'expiresAt', 'phase', 'proofChallengeId', 'purpose', 'reauthSequence', 'rotationId', 'signature', 'successorExpiresAt']
      : ['brainId', 'commandId', 'context', 'credential', 'credentialId', 'expectedCapabilitiesRevision', 'expiresAt', 'phase', 'proofChallengeId', 'purpose', 'reauthSequence', 'rotationId', 'signature'];
    if (!exactKeys(input, expectedKeys)) return { status: 'denied' };
    let request: LocalDeviceCredentialRotationInput;
    try { request = structuredClone(input) as LocalDeviceCredentialRotationInput; } catch { return { status: 'denied' }; }
    if (request.phase === 'activate') {
      return this.#executeCommand({ kind: 'local_device_credential_activate', commandId: request.commandId,
        brainId: request.brainId, context: request.context, expectedCapabilitiesRevision: request.expectedCapabilitiesRevision,
        credential: request.credential, credentialId: request.credentialId, proofChallengeId: request.proofChallengeId,
        purpose: request.purpose, expiresAt: request.expiresAt, rotationId: request.rotationId,
        reauthSequence: request.reauthSequence, signature: request.signature });
    }
    let connectorCredential: string;
    let successorCredentialId: string;
    try {
      connectorCredential = `ldc1_${randomBytes(32).toString('base64url')}`;
      successorCredentialId = `ldc_${randomBytes(18).toString('base64url')}`;
    } catch { return { status: 'unavailable' }; }
    const successorVerifierHash = createHash('sha256').update(connectorCredential).digest('hex');
    const requestDigest = rotationRequestDigest({ brainId: request.brainId, deviceId: request.context.deviceId,
      authorityRevision: request.expectedCapabilitiesRevision, credentialId: request.credentialId,
      proofChallengeId: request.proofChallengeId, purpose: request.purpose, expiresAt: request.expiresAt,
      rotationId: request.rotationId, successorCredentialId, successorVerifierHash,
      successorExpiresAt: request.successorExpiresAt });
    const result = await this.#executeCommand({ kind: 'local_device_credential_prepare', commandId: request.commandId,
      brainId: request.brainId, context: request.context, expectedCapabilitiesRevision: request.expectedCapabilitiesRevision,
      credential: request.credential, credentialId: request.credentialId, proofChallengeId: request.proofChallengeId,
      purpose: request.purpose, expiresAt: request.expiresAt, rotationId: request.rotationId,
      reauthSequence: request.reauthSequence, signature: request.signature, successorCredentialId,
      successorVerifierHash, successorExpiresAt: request.successorExpiresAt, rotationRequestDigest: requestDigest });
    return result.status === 'applied'
      ? { status: 'prepared', connectorCredential, credentialId: successorCredentialId,
          successorExpiresAt: request.successorExpiresAt, rotationRequestDigest: requestDigest }
      : result;
  }

  /**
   * Enrollment completion is intentionally a narrow authority operation: callers
   * provide a bounded lifetime, while this repository owns the persisted expiry.
   * It is not available through the generic command surface.
   */
  async completeLocalDeviceEnrollment(input: {
    commandId: string; brainId: string; context: AuthenticatedOwnerContext; expectedCapabilitiesRevision: string;
    enrollmentId: string; credentialId: string; credentialVerifierHash: string; completionRequestDigest: string;
    credentialTtlMs: number;
  }): Promise<AuthorityCommandResult> {
    if (!isPlainDataObject(input)
      || !exactKeys(input, ['brainId', 'commandId', 'completionRequestDigest', 'context', 'credentialId', 'credentialTtlMs', 'credentialVerifierHash', 'enrollmentId', 'expectedCapabilitiesRevision'])
      || !validId(input.commandId) || !validId(input.brainId) || !validEnrollmentId(input.enrollmentId)
      || !validId(input.credentialId) || !validSha256Hex(input.credentialVerifierHash)
      || !validOpaqueRevision(input.completionRequestDigest) || !validOpaqueRevision(input.expectedCapabilitiesRevision)
      || !Number.isSafeInteger(input.credentialTtlMs)
      || input.credentialTtlMs < MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS
      || input.credentialTtlMs > MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS
      || !isPlainDataObject(input.context) || !exactKeys(input.context, ['kind', 'principalId'])
      || input.context.kind !== 'authenticated_external_owner' || !validId(input.context.principalId)) return { status: 'denied' };
    let request: typeof input;
    let nowMs: number;
    try {
      request = structuredClone(input);
      nowMs = (this.options.now ?? (() => new Date()))().getTime();
    } catch { return { status: 'unavailable' }; }
    if (!Number.isFinite(nowMs)) return { status: 'unavailable' };
    const credentialExpiresAt = new Date(nowMs + request.credentialTtlMs).toISOString();
    return this.#executeCommand({ kind: 'local_device_enrollment_complete', commandId: request.commandId,
      brainId: request.brainId, context: request.context, expectedCapabilitiesRevision: request.expectedCapabilitiesRevision,
      enrollmentId: request.enrollmentId, credentialId: request.credentialId,
      credentialVerifierHash: request.credentialVerifierHash, credentialExpiresAt,
      completionRequestDigest: request.completionRequestDigest });
  }

  async execute(input: BrainAuthorizationAuthorityCommand): Promise<AuthorityCommandResult> {
    // Challenge issuance is deliberately absent from the public command union and
    // rejected at runtime too. Credential prepare/activation follow the same rule:
    // only their narrow repository methods may construct those durable transitions.
    if (['local_device_enrollment_complete', 'local_device_reauth_issue', 'local_device_credential_prepare', 'local_device_credential_activate']
      .includes((input as { kind?: string })?.kind ?? '')) return { status: 'denied' };
    return this.#executeCommand(input);
  }

  async #executeCommand(input: InternalAuthorityCommand): Promise<AuthorityCommandResult> {
    const command = snapshotCommand(input);
    if (!command) return { status: 'denied' };
    if (command.kind === 'bootstrap' || command.kind === 'local_device_bootstrap') {
      const intended = command.kind === 'bootstrap' ? bootstrapRecord(command) : localDeviceBootstrapRecord(command);
      let result: CasCreateResult;
      try { result = await this.cas.createDocument({ collection: COLLECTION, document_key: documentKey(command.brainId), data: intended, metadata: METADATA }); }
      catch { return this.reconcile(command, intended); }
      if (!result.ok) return this.reconcile(command, intended);
      const parsed = parseDocument(result.document, command.brainId);
      return parsed && exactJson(parsed.record, intended) ? { status: 'applied', fence: fenceFor(parsed.record) } : { status: 'unavailable' };
    }
    const current = await this.read(command.brainId);
    if (current.disposition === 'unavailable') return { status: 'unavailable' };
    if (current.disposition !== 'current') return { status: 'denied' };
    if (command.kind === 'local_device_revoke') {
      const receipt = revokeReceiptFor(current.record, command.context.principalId, command.commandId);
      if (receipt) return receipt.command_digest === authorityCommandDigest(command)
        ? { status: 'idempotent', fence: fenceFor(current.record) }
        : { status: 'conflict' };
    }
    const deviceCommand = command.context.kind === 'local_device_connector';
    let nowMs: number | undefined;
    if (deviceCommand || command.kind === 'local_device_enrollment_complete'
      || (command.kind === 'local_device_enrollment_start' && current.record.local_device_enrollment != null)) {
      try { nowMs = (this.options.now ?? (() => new Date()))().getTime(); } catch { return { status: 'denied' }; }
      if (!Number.isFinite(nowMs)) return { status: 'denied' };
    }
    if (deviceCommand && !deviceCommandIsAuthorized(current.record, command, nowMs!)) return { status: 'denied' };
    // A local clock check above rejects an already-expired durable credential
    // or enrollment secret before doing work. This storage-owned predicate
    // closes the remaining interval before the authority CAS. Its deadline is
    // always taken from durable authority state, never caller input.
    const serverTimeDeadline = deviceCommand
      ? credentialForDeviceCommand(current.record, command)?.expires_at
      : command.kind === 'local_device_enrollment_complete' ? current.record.local_device_enrollment?.expires_at : undefined;
    const canonicalDeadline = canonicalServerTimeDeadline(serverTimeDeadline);
    if ((deviceCommand || command.kind === 'local_device_enrollment_complete') && canonicalDeadline === null) return { status: 'denied' };
    if (commandMatches(current.record, command)) return { status: 'idempotent', fence: fenceFor(current.record) };
    if (current.record.owner_status !== 'active'
      || (command.context.kind === 'authenticated_external_owner'
        ? command.context.principalId !== current.record.owner_principal_id
        : command.context.deviceId !== current.record.local_device?.device_id)) return { status: 'denied' };
    if (command.expectedCapabilitiesRevision !== current.record.capabilities_revision) return { status: 'conflict' };
    const intended = transition(current.record, command, nowMs);
    if (!intended) return { status: 'denied' };
    let result: CasUpdateResult;
    try {
      result = await this.cas.updateDocument(COLLECTION, documentKey(command.brainId), {
        _rev: current.revision, data: intended, metadata: METADATA,
        ...(canonicalDeadline ? { precondition: { server_time_before: canonicalDeadline } } : {}),
      });
    }
    catch { return this.reconcile(command, intended, current.revision); }
    if (!result.ok) return this.reconcile(command, intended, current.revision);
    const parsed = parseDocument(result.document, command.brainId);
    if (!parsed || parsed.revision === current.revision || !exactJson(parsed.record, intended)) return { status: 'unavailable' };
    return { status: 'applied', fence: fenceFor(parsed.record) };
  }
}

/**
 * Decision adapter for the private hosted composition. The future I3
 * external-call revoke-versus-dispatch race remains
 * unproven: this repository performs no dispatch or external effect.
 */
export class DurableBrainAuthorizationDecisionAuthority implements BrainAuthorizationDecisionAuthority {
  constructor(private readonly repository: BrainAuthorizationAuthorityRepository) {}
  async decide(input: { brain: Pick<Brain, 'id' | 'metadata'> }): Promise<AnyBrainAuthorizationDecision> {
    const snapshot = snapshotDecisionBrain(input);
    if (snapshot.disposition === 'invalid_id') throw new Error('Brain identifier is invalid.');
    const brainId = snapshot.disposition === 'valid' ? snapshot.brain.id : snapshot.brainId;
    const inert = preCutoverBrainAuthorizationFence(brainId);
    if (snapshot.disposition === 'invalid_metadata' || !legacyOwnershipHintIsAbsent(snapshot.brain.metadata)) {
      return { allowed: false, reason: 'authorization_record_invalid', fence: inert, shadow: { state: 'not_comparable' } };
    }
    try { legacyBrainOwnershipCandidateFingerprint(snapshot.brain); } catch {
      return { allowed: false, reason: 'authorization_record_invalid', fence: inert, shadow: { state: 'not_comparable' } };
    }
    const inspected = await this.repository.inspect(brainId);
    if (inspected.disposition === 'unavailable') return { allowed: false, reason: 'authorization_store_unavailable', fence: inert, shadow: { state: 'not_comparable' } };
    if (inspected.disposition === 'missing') return { allowed: false, reason: 'ownership_unresolved', fence: inert, shadow: { state: 'not_recorded' } };
    if (inspected.disposition === 'invalid') return { allowed: false, reason: 'authorization_record_invalid', fence: inert, shadow: { state: 'not_comparable' } };
    if (inspected.record.owner_status !== 'active' || inspected.record.target_disposition !== 'active'
      || inspected.record.adapter_disposition !== 'selected') {
      return { allowed: false, reason: 'authorization_record_invalid', fence: inspected.fence, shadow: { state: 'not_comparable' } };
    }
    return { allowed: true, ownerPrincipalId: inspected.record.owner_principal_id, fence: inspected.fence };
  }
}
