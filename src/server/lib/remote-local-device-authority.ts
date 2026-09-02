import { randomBytes } from 'node:crypto';
import {
  type BrainAuthorizationAuthorityRepository,
  type LocalDeviceAuthorityRecord,
} from './brain-authorization-authority-repository';
import type { BrainAuthorizationFence } from './brain-authorization-decision';

export interface LocalDeviceRecord {
  schemaVersion: 1;
  deviceId: string;
  brainId: string;
  ownerPrincipalId: string;
  publicKeyAlgorithm: 'ed25519';
  publicKey: string;
  publicKeyFingerprint: string;
  state: 'active' | 'revoked';
  authorityCapabilitiesRevision: string;
  enrolledByCredentialId: string;
  enrolledAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

type OwnerContext = { kind: 'authenticated_external_owner'; principalId: string };
/**
 * Server-side enrollment intent projection. This is not client input: Task
 * 2.2 owns its durable, owner-bound creation and retry retention.
 */
export type TrustedLocalDeviceBindIntent = {
  commandId: string; brainId: string; context: OwnerContext; expectedCapabilitiesRevision: string;
  deviceId: string; publicKey: string; enrolledByCredentialId: string; enrolledAt: string;
};
type DeviceResult = { status: 'applied' | 'idempotent'; record: LocalDeviceRecord; fence: BrainAuthorizationFence } | { status: 'conflict' | 'denied' | 'unavailable' };

function project(record: LocalDeviceAuthorityRecord): LocalDeviceRecord {
  return {
    schemaVersion: record.schema_version, deviceId: record.device_id, brainId: record.brain_id,
    ownerPrincipalId: record.owner_principal_id, publicKeyAlgorithm: record.public_key_algorithm,
    publicKey: record.public_key, publicKeyFingerprint: record.public_key_fingerprint, state: record.state,
    authorityCapabilitiesRevision: record.authority_capabilities_revision,
    enrolledByCredentialId: record.enrolled_by_credential_id, enrolledAt: record.enrolled_at,
    revokedAt: record.revoked_at, lastSeenAt: record.last_seen_at,
  };
}
/** Mints an opaque local-device identifier; it carries no authority by itself. */
export function mintLocalDeviceId(): string { return `ldv_${randomBytes(18).toString('base64url')}`; }

/** Private facade over the one existing fenced authority; it owns no storage or runtime surface. */
export class RemoteLocalDeviceAuthority {
  constructor(private readonly repository: BrainAuthorizationAuthorityRepository) {}

  async bind(input: TrustedLocalDeviceBindIntent): Promise<DeviceResult> {
    const result = await this.repository.execute({
      kind: 'local_device_bind', commandId: input.commandId, brainId: input.brainId, context: input.context,
      expectedCapabilitiesRevision: input.expectedCapabilitiesRevision,
      deviceId: input.deviceId,
      publicKey: input.publicKey, enrolledByCredentialId: input.enrolledByCredentialId,
      enrolledAt: input.enrolledAt,
    });
    if (result.status !== 'applied' && result.status !== 'idempotent') return result;
    const inspected = await this.repository.inspect(input.brainId);
    if (inspected.disposition !== 'current' || inspected.record.local_device == null
      || inspected.fence.capabilitiesRevision !== result.fence.capabilitiesRevision) return { status: 'unavailable' };
    return { status: result.status, record: project(inspected.record.local_device), fence: inspected.fence };
  }

  async inspect(brainId: string): Promise<{ disposition: 'current'; record: LocalDeviceRecord; fence: BrainAuthorizationFence } | { disposition: 'missing' | 'invalid' | 'unavailable' }> {
    const inspected = await this.repository.inspect(brainId);
    if (inspected.disposition !== 'current') return inspected;
    return inspected.record.local_device == null ? { disposition: 'missing' }
      : { disposition: 'current', record: project(inspected.record.local_device), fence: inspected.fence };
  }
}
