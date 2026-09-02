import { createHash, timingSafeEqual, verify } from 'node:crypto';
import { BrainAuthorizationAuthorityRepository } from './brain-authorization-authority-repository';
import { canonicalDeviceReauthProofPayload } from './remote-local-relay-protocol';

const DEFAULT_CHALLENGE_TTL_MS = 30_000;
const DEFAULT_CREDENTIAL_TTL_MS = 5 * 60_000;
const MIN_TTL_MS = 1_000;
const MAX_CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CREDENTIAL_TTL_MS = 60 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const spki = (raw: string) => Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64url')]);
const equal = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

type DeviceContext = { kind: 'local_device_connector'; deviceId: string };
type Purpose = 'socket_open' | 'credential_refresh' | 'credential_activate';
type Proof = {
  fence: { brainId: string; deviceId: string; authorityRevision: string };
  credentialId: string; proofChallengeId: string; purpose: Purpose; expiresAt: string; rotationId: string;
  signatureAlgorithm: 'ed25519'; signature: string;
};

function boundedTtl(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < MIN_TTL_MS || selected > maximum) throw new Error(`${name} is outside the server bound.`);
  return selected;
}
function safeNow(now: (() => Date) | undefined): Date | null {
  try { const value = (now ?? (() => new Date()))(); return Number.isFinite(value.getTime()) ? value : null; } catch { return null; }
}
function signatureIsBounded(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try { return Buffer.from(value, 'base64url').byteLength === 64; } catch { return false; }
}
function credentialIsBounded(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= 256;
}

/** Private stateful PoP seam. It creates neither a route, listener, nor socket. */
export class RemoteLocalDeviceReauthenticationStore {
  private readonly challengeTtlMs: number;
  private readonly credentialTtlMs: number;

  constructor(
    private readonly repository: BrainAuthorizationAuthorityRepository,
    private readonly options: { now?: () => Date; challengeTtlMs?: number; credentialTtlMs?: number } = {},
  ) {
    this.challengeTtlMs = boundedTtl(options.challengeTtlMs, DEFAULT_CHALLENGE_TTL_MS, MAX_CHALLENGE_TTL_MS, 'challengeTtlMs');
    this.credentialTtlMs = boundedTtl(options.credentialTtlMs, DEFAULT_CREDENTIAL_TTL_MS, MAX_CREDENTIAL_TTL_MS, 'credentialTtlMs');
  }

  async issueChallenge(input: {
    commandId: string; brainId: string; context: DeviceContext; credential: string;
    expectedCapabilitiesRevision: string; purpose: Purpose;
  }) {
    const now = safeNow(this.options.now);
    if (!now || !input || input.context?.kind !== 'local_device_connector' || !['socket_open', 'credential_refresh', 'credential_activate'].includes(input.purpose)
      || !credentialIsBounded(input.credential)) return { status: 'denied' as const };
    const expiresAt = new Date(now.getTime() + this.challengeTtlMs).toISOString();
    const result = await this.repository.issueLocalDeviceReauthChallenge({ commandId: input.commandId, brainId: input.brainId,
      context: input.context, expectedCapabilitiesRevision: input.expectedCapabilitiesRevision,
      credential: input.credential, purpose: input.purpose, expiresAt });
    return result.status === 'issued' ? result : { status: 'denied' as const };
  }

  async authenticate(input: { brainId: string; context: DeviceContext; credential: string; proof?: Proof }) {
    const proof = input?.proof;
    if (!proof || !credentialIsBounded(input?.credential)) return { status: 'close' as const, reason: 'invalid_proof' as const };
    const now = safeNow(this.options.now);
    if (!now) return { status: 'close' as const, reason: 'unavailable' as const };
    const inspected = await this.repository.inspect(input.brainId);
    if (inspected.disposition !== 'current') return { status: 'close' as const, reason: inspected.disposition === 'unavailable' ? 'unavailable' as const : 'invalid_authority' as const };
    const device = inspected.record.local_device;
    const currentCredential = inspected.record.local_device_credential;
    const credential = proof.purpose === 'credential_activate'
      ? inspected.record.local_device_credential_pending : currentCredential;
    const challenge = inspected.record.local_device_reauth;
    if (inspected.record.owner_status !== 'active' || device?.state !== 'active') return { status: 'close' as const, reason: 'revoked' as const };
    if (!credential || device.device_id !== input.context?.deviceId || credential.device_id !== device.device_id
      || credential.brain_id !== input.brainId || credential.owner_principal_id !== inspected.record.owner_principal_id
      || credential.authority_capabilities_revision !== inspected.fence.capabilitiesRevision
      || device.authority_capabilities_revision !== inspected.fence.capabilitiesRevision) return { status: 'close' as const, reason: 'fence_changed' as const };
    if (Date.parse(credential.expires_at) <= now.getTime()) return { status: 'close' as const, reason: 'expired' as const };
    if (typeof input.credential !== 'string' || !equal(credential.verifier_hash, hash(input.credential)) || !challenge
      || proof.signatureAlgorithm !== 'ed25519' || !signatureIsBounded(proof.signature)
      || proof.fence?.brainId !== input.brainId || proof.fence.deviceId !== device.device_id
      || proof.fence.authorityRevision !== inspected.fence.capabilitiesRevision
      || proof.credentialId !== credential.credential_id || proof.proofChallengeId !== challenge.proof_challenge_id
      || proof.purpose !== challenge.purpose || proof.expiresAt !== challenge.expires_at || proof.rotationId !== challenge.rotation_id
      || challenge.brain_id !== input.brainId || challenge.device_id !== device.device_id
      || challenge.authority_capabilities_revision !== inspected.fence.capabilitiesRevision) return { status: 'close' as const, reason: 'invalid_proof' as const };
    if (Date.parse(challenge.expires_at) <= now.getTime()) return { status: 'close' as const, reason: 'expired' as const };
    let verified = false;
    try {
      verified = verify(null, Buffer.from(canonicalDeviceReauthProofPayload(proof), 'utf8'),
        { key: spki(device.public_key), format: 'der', type: 'spki' }, Buffer.from(proof.signature, 'base64url'));
    } catch { /* fail closed */ }
    if (!verified) return { status: 'close' as const, reason: 'invalid_proof' as const };

    if (proof.purpose === 'socket_open') {
      const consumed = await this.repository.execute({ kind: 'local_device_reauth_consume', commandId: `consume:${proof.rotationId}`,
        brainId: input.brainId, context: input.context, expectedCapabilitiesRevision: inspected.fence.capabilitiesRevision,
        credential: input.credential, credentialId: proof.credentialId, proofChallengeId: proof.proofChallengeId, purpose: proof.purpose,
        expiresAt: proof.expiresAt, rotationId: proof.rotationId, reauthSequence: challenge.reauth_sequence, signature: proof.signature });
      if (consumed.status !== 'applied') return { status: 'close' as const, reason: consumed.status === 'unavailable' || consumed.status === 'idempotent' ? 'indeterminate' as const : 'invalid_proof' as const };
      const rechecked = await this.repository.inspect(input.brainId);
      if (rechecked.disposition !== 'current') return { status: 'close' as const, reason: 'unavailable' as const };
      if (rechecked.record.owner_status !== 'active' || rechecked.record.local_device?.state !== 'active') return { status: 'close' as const, reason: 'revoked' as const };
      if (rechecked.fence.capabilitiesRevision !== inspected.fence.capabilitiesRevision || rechecked.record.local_device_credential?.credential_id !== proof.credentialId) return { status: 'close' as const, reason: 'fence_changed' as const };
      return { status: 'admitted' as const, disposition: 'socket_open' as const, fence: inspected.fence.capabilitiesRevision,
        deviceId: device.device_id, credentialExpiresAt: credential.expires_at };
    }

    if (proof.purpose === 'credential_activate') {
      const activated = await this.repository.advanceLocalDeviceCredentialRotation({ phase: 'activate', commandId: `activate:${proof.rotationId}`,
        brainId: input.brainId, context: input.context, expectedCapabilitiesRevision: inspected.fence.capabilitiesRevision,
        credential: input.credential, credentialId: proof.credentialId, proofChallengeId: proof.proofChallengeId,
        purpose: proof.purpose, expiresAt: proof.expiresAt, rotationId: proof.rotationId,
        reauthSequence: challenge.reauth_sequence, signature: proof.signature });
      if (activated.status !== 'applied') return { status: 'close' as const, reason: activated.status === 'unavailable' || activated.status === 'idempotent' ? 'indeterminate' as const : 'invalid_proof' as const };
      const rechecked = await this.repository.inspect(input.brainId);
      const active = rechecked.disposition === 'current' ? rechecked.record.local_device_credential : null;
      if (rechecked.disposition !== 'current' || rechecked.record.owner_status !== 'active' || rechecked.record.local_device?.state !== 'active'
        || rechecked.fence.capabilitiesRevision !== inspected.fence.capabilitiesRevision || active?.credential_id !== proof.credentialId
        || active.rotation_id !== proof.rotationId || active.rotation_command_id !== `activate:${proof.rotationId}`
        || rechecked.record.local_device_credential_pending !== null || !equal(active.verifier_hash, hash(input.credential))) {
        return { status: 'close' as const, reason: rechecked.disposition === 'current' ? 'fence_changed' as const : 'unavailable' as const };
      }
      return { status: 'refreshed' as const, credentialId: proof.credentialId,
        priorCredentialId: active.prior_credential_id!, expiresAt: active.expires_at, rotationId: proof.rotationId,
        fence: inspected.fence.capabilitiesRevision, deviceId: device.device_id, credentialExpiresAt: active.expires_at };
    }

    const successorExpiresAt = new Date(now.getTime() + this.credentialTtlMs).toISOString();
    const prepared = await this.repository.advanceLocalDeviceCredentialRotation({ phase: 'prepare', commandId: `prepare:${proof.rotationId}`,
      brainId: input.brainId, context: input.context, expectedCapabilitiesRevision: inspected.fence.capabilitiesRevision,
      credential: input.credential, credentialId: proof.credentialId, proofChallengeId: proof.proofChallengeId, purpose: proof.purpose, expiresAt: proof.expiresAt,
      rotationId: proof.rotationId, reauthSequence: challenge.reauth_sequence, signature: proof.signature, successorExpiresAt });
    if (prepared.status !== 'prepared') return { status: 'close' as const, reason: prepared.status === 'unavailable' || prepared.status === 'idempotent' ? 'indeterminate' as const : 'invalid_proof' as const };
    const rechecked = await this.repository.inspect(input.brainId);
    const current = rechecked.disposition === 'current' ? rechecked.record.local_device_credential : null;
    const pending = rechecked.disposition === 'current' ? rechecked.record.local_device_credential_pending : null;
    if (rechecked.disposition !== 'current' || rechecked.record.owner_status !== 'active' || rechecked.record.local_device?.state !== 'active'
      || rechecked.fence.capabilitiesRevision !== inspected.fence.capabilitiesRevision || current?.credential_id !== proof.credentialId
      || pending?.credential_id !== prepared.credentialId || pending.rotation_id !== proof.rotationId
      || pending.prepare_command_id !== `prepare:${proof.rotationId}` || pending.prepare_request_digest !== prepared.rotationRequestDigest
      || !equal(pending.verifier_hash, hash(prepared.connectorCredential))) {
      return { status: 'close' as const, reason: rechecked.disposition === 'current' ? 'fence_changed' as const : 'unavailable' as const };
    }
    return { status: 'prepared' as const, connectorCredential: prepared.connectorCredential, credentialId: prepared.credentialId,
      priorCredentialId: proof.credentialId, expiresAt: successorExpiresAt, rotationId: proof.rotationId,
      fence: inspected.fence.capabilitiesRevision, deviceId: device.device_id, credentialExpiresAt: current.expires_at };
  }
}
