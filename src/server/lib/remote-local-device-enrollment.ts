import { createHash, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { BrainAuthorizationAuthorityRepository } from './brain-authorization-authority-repository';
import { RemoteLocalDeviceAuthority } from './remote-local-device-authority';
import {
  DEFAULT_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
  MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
  MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
  REMOTE_LOCAL_ENROLLMENT_TTL_MS,
} from './remote-local-device-credential-policy';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptDigest = (value: Record<string, string>) => `v1.${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}`;
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const id = (prefix: string) => `${prefix}_${randomBytes(18).toString('base64url')}`;
function spki(raw: string): Buffer { return Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64url')]); }

/** Private, unmounted enrollment seam; no route or connector is constructed here. */
export class RemoteLocalDeviceEnrollmentStore {
  constructor(private readonly repository: BrainAuthorizationAuthorityRepository, private readonly options: { now?: () => Date; initialCredentialTtlMs?: number } = {}) {
    const ttl = options.initialCredentialTtlMs ?? DEFAULT_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS || ttl > MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS) {
      throw new Error('remote-local initial credential TTL is outside the configured MVP bound');
    }
  }

  async start(input: { commandId: string; brainId: string; context: { kind: 'authenticated_external_owner'; principalId: string }; expectedCapabilitiesRevision: string; publicKey: string; enrolledByCredentialId: string }) {
    const prior = await this.repository.inspect(input.brainId);
    const startRequestDigest = receiptDigest({ commandId: input.commandId, brainId: input.brainId, ownerPrincipalId: input.context.principalId, expectedCapabilitiesRevision: input.expectedCapabilitiesRevision, publicKey: input.publicKey, enrolledByCredentialId: input.enrolledByCredentialId });
    if (prior.disposition === 'current' && prior.record.owner_principal_id === input.context.principalId && prior.record.local_device_enrollment?.start_command_id === input.commandId) {
      return prior.record.local_device_enrollment.start_request_digest === startRequestDigest
        ? { status: 'indeterminate' as const, disposition: 'enrollment_start_recorded' as const, fence: prior.fence }
        : { status: 'conflict' as const };
    }
    const now = (this.options.now ?? (() => new Date()))(); const enrollmentId = id('lde'); const deviceId = `ldv_${randomBytes(18).toString('base64url')}`;
    const enrollmentSecret = randomBytes(32).toString('base64url'); const challenge = randomBytes(32).toString('base64url'); const enrolledAt = now.toISOString(); const expiresAt = new Date(now.getTime() + REMOTE_LOCAL_ENROLLMENT_TTL_MS).toISOString();
    const result = await this.repository.execute({ kind: 'local_device_enrollment_start', ...input, enrollmentId, deviceId, secretHash: hash(enrollmentSecret), challenge, expiresAt, enrolledAt, startRequestDigest });
    if (result.status === 'idempotent') return { status: 'indeterminate' as const, disposition: 'enrollment_start_recorded' as const, fence: result.fence };
    if (result.status !== 'applied') return result;
    return { status: 'pending' as const, enrollmentId, enrollmentSecret, deviceId, challenge, fence: result.fence };
  }

  async complete(input: { commandId: string; brainId: string; context: { kind: 'local_device_enrollment_daemon'; deviceId: string }; enrollmentId: string; enrollmentSecret: string; signature: string }) {
    const inspected = await this.repository.inspect(input.brainId);
    if (inspected.disposition !== 'current') return { status: 'denied' as const };
    const completionRequestDigest = receiptDigest({ commandId: input.commandId, brainId: input.brainId, deviceId: input.context.deviceId, enrollmentId: input.enrollmentId, enrollmentSecretHash: hash(input.enrollmentSecret) });
    const credential = inspected.record.local_device_credential;
    if (credential?.completion_command_id === input.commandId && credential.completion_request_digest === completionRequestDigest) {
      return { status: 'indeterminate' as const, disposition: 'enrollment_completion_recorded' as const, fence: inspected.fence };
    }
    const pending = inspected.record.local_device_enrollment;
    if (!pending || pending.enrollment_id !== input.enrollmentId || pending.device_id !== input.context.deviceId || new Date(pending.expires_at).getTime() <= (this.options.now ?? (() => new Date()))().getTime() || !equal(pending.secret_hash, hash(input.enrollmentSecret))) return { status: 'denied' as const };
    let proof = false; try { proof = verify(null, Buffer.from(pending.challenge, 'utf8'), { key: spki(pending.public_key), format: 'der', type: 'spki' }, Buffer.from(input.signature, 'base64url')); } catch { /* deny */ }
    if (!proof) return { status: 'denied' as const };
    const connectorCredential = `ldc1_${randomBytes(32).toString('base64url')}`;
    const bound = await this.repository.completeLocalDeviceEnrollment({ commandId: input.commandId, brainId: input.brainId, context: { kind: 'authenticated_external_owner', principalId: inspected.record.owner_principal_id }, expectedCapabilitiesRevision: inspected.fence.capabilitiesRevision, enrollmentId: pending.enrollment_id, credentialId: `ldc_${randomBytes(18).toString('base64url')}`, credentialVerifierHash: hash(connectorCredential), completionRequestDigest, credentialTtlMs: this.options.initialCredentialTtlMs ?? DEFAULT_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS });
    if (bound.status === 'idempotent') return { status: 'indeterminate' as const, disposition: 'enrollment_completion_recorded' as const, fence: bound.fence };
    if (bound.status !== 'applied') return bound;
    const device = await new RemoteLocalDeviceAuthority(this.repository).inspect(input.brainId);
    if (device.disposition !== 'current') return { status: 'unavailable' as const };
    return { status: bound.status, record: device.record, fence: bound.fence, connectorCredential };
  }
}
