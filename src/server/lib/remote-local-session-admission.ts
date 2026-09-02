import { randomBytes } from 'node:crypto';
import { type BrainAuthorizationAuthorityRepository } from './brain-authorization-authority-repository';
import { parseRemoteLocalRelayFrame } from './remote-local-relay-protocol';

/**
 * Private, transport-neutral admission boundary for the future relay upgrade.
 * It deliberately owns only ephemeral opaque session references; durable device
 * authority stays in the Task 2.1–2.3 authority record.
 */
export type RemoteLocalAdmissionCloseCode =
  | 'feature_disabled' | 'rate_limited' | 'invalid_proof' | 'revoked' | 'fence_changed'
  | 'expired' | 'unavailable' | 'indeterminate' | 'invalid_frame' | 'heartbeat_expired';

type DeviceContext = { kind: 'local_device_connector'; deviceId: string };
type Authenticated = { status: 'admitted'; fence: string; deviceId: string; credentialExpiresAt: string }
  | { status: 'prepared'; fence: string; deviceId: string; connectorCredential: string; credentialId: string; priorCredentialId: string; expiresAt: string; credentialExpiresAt: string; rotationId: string }
  | { status: 'refreshed'; fence: string; deviceId: string; credentialId: string; priorCredentialId: string; expiresAt: string; credentialExpiresAt: string; rotationId: string }
  | { status: 'close'; reason: 'invalid_proof' | 'revoked' | 'fence_changed' | 'expired' | 'unavailable' | 'indeterminate' | 'invalid_authority' };

export interface RemoteLocalSessionTransport {
  close(reason: { code: RemoteLocalAdmissionCloseCode }): void | Promise<void>;
}

export interface RemoteLocalSessionAdmissionDependencies {
  /** The Task 2.3 PoP store; this facade must be backed by its durable authority implementation. */
  reauthenticate: { authenticate(input: { brainId: string; context: DeviceContext; credential: string; proof: unknown }): Promise<Authenticated> };
  /** A direct, current authority projection. Never derive this from the in-memory registry. */
  inspectAuthority(brainId: string): Promise<{ disposition: 'current'; fence: string; deviceId: string; active: boolean } | { disposition: 'missing' | 'invalid' | 'unavailable' }>;
  /** A fail-closed, versioned server configuration snapshot, normally wired by Task 2.6. */
  feature: { snapshot(): Promise<{ enabled: boolean; revision: string }> };
  /** Server-owned, bounded admission budget.  It is intentionally configuration,
   * not an injectable allow/deny callback: callers must not be able to bypass it. */
  attemptLimit?: { maxAttempts?: number; windowMs?: number; maxKeys?: number };
  /**
   * A process-lifetime ceiling for opaque routing handles. Handles are never
   * reused, including after a transport closes, so exhausting this finite
   * namespace deliberately fails closed until the process is replaced.
   */
  sessionIdLimit?: { maxIds?: number };
  now?: () => Date;
  mintSessionId?: () => string;
  maxHeartbeatAgeMs?: number;
}

/** The production inspector for this seam; it reads the sole durable authority. */
export function inspectRemoteLocalDeviceAuthority(repository: BrainAuthorizationAuthorityRepository) {
  return async (brainId: string): Promise<{ disposition: 'current'; fence: string; deviceId: string; active: boolean } | { disposition: 'missing' | 'invalid' | 'unavailable' }> => {
    const inspected = await repository.inspect(brainId);
    if (inspected.disposition !== 'current') return inspected;
    const device = inspected.record.local_device;
    if (!device) return { disposition: 'invalid' };
    return { disposition: 'current', fence: inspected.fence.capabilitiesRevision, deviceId: device.device_id,
      active: inspected.record.owner_status === 'active' && device.state === 'active' && device.authority_capabilities_revision === inspected.fence.capabilitiesRevision };
  };
}

type Session = { id: string; brainId: string; deviceId: string; fence: string; featureRevision: string; credentialExpiresAt: number; transport: RemoteLocalSessionTransport; lastHeartbeatAt: number; closing?: Promise<void>; closeCode?: RemoteLocalAdmissionCloseCode };
const DEFAULT_HEARTBEAT_AGE_MS = 90_000;
const DEFAULT_ATTEMPT_LIMIT = { maxAttempts: 8, windowMs: 60_000, maxKeys: 2_048 } as const;
const DEFAULT_SESSION_ID_LIMIT = 8_192;

function safeNow(now?: () => Date): number | null {
  try { const value = (now ?? (() => new Date()))().getTime(); return Number.isFinite(value) ? value : null; } catch { return null; }
}
function snapshotCanonicalTimestamp(value: unknown, key: string): { value: string; time: number } | null {
  try {
    if (!isPlainRecord(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || typeof descriptor.value !== 'string' || descriptor.value.length !== 24) return null;
    const time = Date.parse(descriptor.value);
    return Number.isSafeInteger(time) && new Date(time).toISOString() === descriptor.value ? { value: descriptor.value, time } : null;
  } catch { return null; }
}
function expiryTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length !== 24) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}
/** Frozen Task 1.4 subordinate routing-handle contract. */
const SESSION_HANDLE = /^rsh_[A-Za-z0-9_-]{16,128}$/;
function mint(): string { return `rsh_${randomBytes(24).toString('base64url')}`; }

const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_CREDENTIAL_LENGTH = 4_096;
const MAX_PROOF_DEPTH = 4;
const MAX_PROOF_KEYS = 24;
// This boundary snapshots hostile transport data before throttling or PoP.
// Per-leaf limits alone allow exponential breadth, so cap the whole copied
// proof as well.  The production PoP is far smaller than this 16KiB budget.
const MAX_PROOF_NODES = 128;
const MAX_PROOF_BYTES = 16 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch { return false; }
}
function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_OPAQUE_ID_LENGTH && OPAQUE_ID.test(value);
}
function isSessionHandle(value: unknown): value is string {
  return typeof value === 'string' && SESSION_HANDLE.test(value);
}
function isBoundedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CREDENTIAL_LENGTH && !CONTROL.test(value);
}
/**
 * Takes the untyped refresh boundary apart using descriptors only.  In
 * particular, never spread or destructure this input: either operation can
 * invoke an enumerable getter before the session is closed.  The proof is
 * copied into plain data records too, so a caller cannot mutate it while the
 * asynchronous PoP operation is in flight.
 */
type ProofSnapshotBudget = { nodes: number; bytes: number };
function consumeProofSnapshot(budget: ProofSnapshotBudget, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || budget.nodes >= MAX_PROOF_NODES || bytes > MAX_PROOF_BYTES - budget.bytes) return false;
  budget.nodes += 1;
  budget.bytes += bytes;
  return true;
}
function snapshotProof(value: unknown, depth = 0, budget: ProofSnapshotBudget = { nodes: 0, bytes: 0 }): unknown | undefined {
  try {
    if (typeof value === 'string') return isBoundedSecret(value) && consumeProofSnapshot(budget, Buffer.byteLength(value, 'utf8')) ? value : undefined;
    if (!isPlainRecord(value) || depth >= MAX_PROOF_DEPTH || !consumeProofSnapshot(budget, 0)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_PROOF_KEYS || keys.some((key) => typeof key !== 'string' || !isOpaqueId(key))) return undefined;
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (!consumeProofSnapshot(budget, Buffer.byteLength(key, 'utf8'))) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) return undefined;
      const child = descriptor.value;
      if (child === null || typeof child === 'boolean' || (typeof child === 'number' && Number.isFinite(child))) {
        if (!consumeProofSnapshot(budget, 8)) return undefined;
        copy[key] = child;
        continue;
      }
      if (typeof child === 'string' && child.length <= MAX_CREDENTIAL_LENGTH && !CONTROL.test(child)) {
        if (!consumeProofSnapshot(budget, Buffer.byteLength(child, 'utf8'))) return undefined;
        copy[key] = child;
        continue;
      }
      const nested = snapshotProof(child, depth + 1, budget);
      if (nested === undefined) return undefined;
      copy[key] = nested;
    }
    return Object.freeze(copy);
  } catch { return undefined; }
}
function snapshotDeviceContext(value: unknown): DeviceContext | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => key !== 'kind' && key !== 'deviceId')) return undefined;
    const kind = Object.getOwnPropertyDescriptor(value, 'kind');
    const deviceId = Object.getOwnPropertyDescriptor(value, 'deviceId');
    if (!kind || !deviceId || !kind.enumerable || !deviceId.enumerable || kind.get || kind.set || deviceId.get || deviceId.set
      || kind.value !== 'local_device_connector' || !isOpaqueId(deviceId.value)) return undefined;
    return Object.freeze({ kind: 'local_device_connector', deviceId: deviceId.value });
  } catch { return undefined; }
}
/**
 * Snapshot the whole admission request before its first await. The raw request
 * belongs to an untrusted transport and may be mutated after feature lookup;
 * retain neither its nested context nor proof object. Descriptor reads avoid
 * invoking accessors while copying the only supported data-only grammar.
 */
function snapshotOpenInput(value: unknown): { brainId: string; context: DeviceContext; credential: string; proof: unknown; transport: RemoteLocalSessionTransport } | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 5 || keys.some((key) => key !== 'brainId' && key !== 'context' && key !== 'credential' && key !== 'proof' && key !== 'transport')) return undefined;
    const brainId = Object.getOwnPropertyDescriptor(value, 'brainId');
    const context = Object.getOwnPropertyDescriptor(value, 'context');
    const credential = Object.getOwnPropertyDescriptor(value, 'credential');
    const proof = Object.getOwnPropertyDescriptor(value, 'proof');
    const transport = Object.getOwnPropertyDescriptor(value, 'transport');
    if (!brainId || !context || !credential || !proof || !transport
      || !brainId.enumerable || !context.enumerable || !credential.enumerable || !proof.enumerable || !transport.enumerable
      || brainId.get || brainId.set || context.get || context.set || credential.get || credential.set || proof.get || proof.set || transport.get || transport.set
      || !isOpaqueId(brainId.value) || !isBoundedSecret(credential.value)) return undefined;
    const contextCopy = snapshotDeviceContext(context.value);
    const proofCopy = snapshotProof(proof.value);
    const transportCopy = transportFrom({ transport: transport.value });
    if (!contextCopy || proofCopy === undefined || !transportCopy) return undefined;
    return Object.freeze({ brainId: brainId.value, context: contextCopy, credential: credential.value, proof: proofCopy, transport: transportCopy });
  } catch { return undefined; }
}
function snapshotRefreshInput(value: unknown): { credential: string; proof: unknown } | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => key !== 'credential' && key !== 'proof')) return undefined;
    const credential = Object.getOwnPropertyDescriptor(value, 'credential');
    const proof = Object.getOwnPropertyDescriptor(value, 'proof');
    if (!credential || !proof || !credential.enumerable || !proof.enumerable || credential.get || credential.set || proof.get || proof.set
      || !isBoundedSecret(credential.value)) return undefined;
    const proofCopy = snapshotProof(proof.value);
    return proofCopy === undefined ? undefined : { credential: credential.value, proof: proofCopy };
  } catch { return undefined; }
}
const CLOSE_CODES: ReadonlySet<RemoteLocalAdmissionCloseCode> = new Set([
  'feature_disabled', 'rate_limited', 'invalid_proof', 'revoked', 'fence_changed',
  'expired', 'unavailable', 'indeterminate', 'invalid_frame', 'heartbeat_expired',
]);
function closeCode(value: unknown, fallback: RemoteLocalAdmissionCloseCode = 'fence_changed'): RemoteLocalAdmissionCloseCode {
  return typeof value === 'string' && CLOSE_CODES.has(value as RemoteLocalAdmissionCloseCode) ? value as RemoteLocalAdmissionCloseCode : fallback;
}
function transportFrom(value: unknown): RemoteLocalSessionTransport | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'transport');
    const transport = descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
    if (transport === null || (typeof transport !== 'object' && typeof transport !== 'function')) return undefined;
    // Find a data-method without invoking an attacker-controlled getter. Store a
    // bound wrapper, so later close paths cannot re-read a mutable transport.
    let owner: object | null = transport as object;
    for (let depth = 0; owner && depth < 8; depth += 1, owner = Object.getPrototypeOf(owner)) {
      const close = Object.getOwnPropertyDescriptor(owner, 'close');
      if (!close) continue;
      if (close.get || close.set || typeof close.value !== 'function') return undefined;
      return { close: close.value.bind(transport) };
    }
    return undefined;
  } catch { return undefined; }
}

/** Ephemeral, bounded, fail-closed budget keyed only by public routing IDs. */
class DeviceAttemptLimiter {
  private readonly entries = new Map<string, { count: number; startedAt: number }>();
  private lastNow: number | null = null;
  constructor(private readonly now: () => number | null, private readonly maxAttempts: number, private readonly windowMs: number, private readonly maxKeys: number) {}
  consume(brainId: string, deviceId: string): boolean {
    const now = this.now();
    if (now === null || (this.lastNow !== null && now < this.lastNow)) return false;
    this.lastNow = now;
    for (const [key, value] of this.entries) if (now - value.startedAt >= this.windowMs) this.entries.delete(key);
    // length-delimited composite avoids ambiguous brain/device concatenation.
    const key = `${brainId.length}:${brainId}${deviceId.length}:${deviceId}`;
    const existing = this.entries.get(key);
    if (!existing && this.entries.size >= this.maxKeys) return false;
    if (!existing) { this.entries.set(key, { count: 1, startedAt: now }); return true; }
    if (existing.count >= this.maxAttempts) return false;
    existing.count += 1;
    return true;
  }
}

export class RemoteLocalSessionAdmission {
  private readonly sessions = new Map<string, Session>();
  // Reservations are deliberately separate from the live registry. They make
  // an asynchronously-admitted handle exclusive before PoP/authority awaits.
  private readonly reservations = new Map<string, object>();
  // A closed handle remains permanently retired for this process. Never evict:
  // evicting would turn a bounded map into a replay/reuse path.
  private readonly retired = new Set<string>();
  private readonly maxHeartbeatAgeMs: number;
  private readonly attempts: DeviceAttemptLimiter;
  private readonly maxSessionIds: number;

  constructor(private readonly dependencies: RemoteLocalSessionAdmissionDependencies) {
    const value = dependencies.maxHeartbeatAgeMs ?? DEFAULT_HEARTBEAT_AGE_MS;
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 5 * 60_000) throw new Error('maxHeartbeatAgeMs is outside the server bound.');
    this.maxHeartbeatAgeMs = value;
    const limit = { ...DEFAULT_ATTEMPT_LIMIT, ...dependencies.attemptLimit };
    if (!Number.isSafeInteger(limit.maxAttempts) || limit.maxAttempts < 1 || limit.maxAttempts > 100
      || !Number.isSafeInteger(limit.windowMs) || limit.windowMs < 1_000 || limit.windowMs > 5 * 60_000
      || !Number.isSafeInteger(limit.maxKeys) || limit.maxKeys < 1 || limit.maxKeys > 10_000) throw new Error('attemptLimit is outside the server bound.');
    this.attempts = new DeviceAttemptLimiter(() => safeNow(this.dependencies.now), limit.maxAttempts, limit.windowMs, limit.maxKeys);
    const sessionLimit = dependencies.sessionIdLimit?.maxIds ?? DEFAULT_SESSION_ID_LIMIT;
    if (!Number.isSafeInteger(sessionLimit) || sessionLimit < 1 || sessionLimit > 100_000) throw new Error('sessionIdLimit is outside the server bound.');
    this.maxSessionIds = sessionLimit;
  }

  size(): number { return this.sessions.size; }

  async open(input: unknown): Promise<{ status: 'admitted'; sessionId: string; fence: string } | { status: 'closed'; code: RemoteLocalAdmissionCloseCode }> {
    // Treat the runtime boundary as untyped: reject malformed values before any
    // feature lookup, limiter key construction, hashing, or PoP facade call.
    const admission = snapshotOpenInput(input);
    if (!admission) return this.reject(transportFrom(input), 'fence_changed');
    // Default-off must precede *all* mutable admission work, including a
    // generator that might have side effects. A malformed configuration is
    // indistinguishable from disabled.
    const feature = await this.feature();
    if (!feature) return this.reject(admission.transport, 'feature_disabled');
    // Retired handles cannot be evicted without violating the frozen
    // non-reuse contract. Stop issuance before minting once their bounded
    // process-lifetime namespace is full.
    if (!this.canIssueSessionId()) return this.reject(admission.transport, 'unavailable');
    // Allocate only after default-off has been resolved. An injected generator
    // is never an authority: its output must be a frozen, unused handle.
    let sessionId: unknown;
    try { sessionId = (this.dependencies.mintSessionId ?? mint)(); } catch { return this.reject(admission.transport, 'unavailable'); }
    if (!isSessionHandle(sessionId)) return this.reject(admission.transport, 'unavailable');
    const reservation = this.reserveSessionId(sessionId);
    if (!reservation) return this.reject(admission.transport, 'unavailable');
    try {
      if (!this.limited(admission.brainId, admission.context.deviceId)) return this.reject(admission.transport, 'rate_limited');
      if (!await this.sameFeature(feature.revision)) return this.reject(admission.transport, 'feature_disabled');
      const authenticated = await this.authenticate(admission);
      if (authenticated.status !== 'admitted') return this.reject(admission.transport, authenticated.reason);
      // The facade is a boundary adapter, not an authority.  Its claimed identity
      // must exactly match the connector identity it was asked to authenticate.
      if (authenticated.deviceId !== admission.context.deviceId) return this.reject(admission.transport, 'fence_changed');
      if (!await this.sameFeature(feature.revision)) return this.reject(admission.transport, 'feature_disabled');
      const current = await this.current(admission.brainId, admission.context.deviceId, authenticated.fence);
      if (current !== 'current') return this.reject(admission.transport, current);
      if (!await this.sameFeature(feature.revision)) return this.reject(admission.transport, 'feature_disabled');
      const now = safeNow(this.dependencies.now);
      if (now === null) return this.reject(admission.transport, 'unavailable');
      // Commit only if our exclusive reservation still owns this handle. This
      // synchronous swap cannot replace a concurrent session registry entry.
      const credentialExpiresAt = expiryTime(authenticated.credentialExpiresAt);
      if (credentialExpiresAt === null || credentialExpiresAt <= now) return this.reject(admission.transport, 'expired');
      const session: Session = { id: sessionId, brainId: admission.brainId, deviceId: admission.context.deviceId, fence: authenticated.fence, featureRevision: feature.revision, credentialExpiresAt, transport: admission.transport, lastHeartbeatAt: now };
      if (!this.commitReservation(sessionId, reservation, session)) return this.reject(admission.transport, 'unavailable');
      return { status: 'admitted', sessionId, fence: authenticated.fence };
    } finally {
      this.releaseReservation(sessionId, reservation);
    }
  }

  async heartbeat(sessionId: string): Promise<{ status: 'live' } | { status: 'closed'; code: RemoteLocalAdmissionCloseCode }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'closed', code: 'fence_changed' };
    const result = await this.recheck(session, true);
    return result.status === 'live' && !this.isCurrent(session) ? this.closed() : result;
  }

  /** Bounded admission predicate only. It does not route or dispatch a command. */
  async claimCommand(sessionId: string): Promise<{ status: 'admitted'; fence: string } | { status: 'closed'; code: RemoteLocalAdmissionCloseCode }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'closed', code: 'fence_changed' };
    const checked = await this.recheck(session, false);
    return checked.status === 'live' && this.isCurrent(session) ? { status: 'admitted', fence: session.fence } : checked.status === 'live' ? this.closed() : checked;
  }

  async refresh(sessionId: unknown, input: unknown): Promise<
    | { status: 'prepared'; connectorCredential: string; credentialId: string; priorCredentialId: string; expiresAt: string; rotationId: string; fence: string }
    | { status: 'refreshed'; credentialId: string; priorCredentialId: string; expiresAt: string; rotationId: string; fence: string }
    | { status: 'closed'; code: RemoteLocalAdmissionCloseCode }
  > {
    // This exact snapshot must precede Map lookup, feature checks, limiter use,
    // or PoP work. Invalid input closes an identified live session once.
    const refresh = snapshotRefreshInput(input);
    if (!isOpaqueId(sessionId)) return { status: 'closed', code: 'fence_changed' };
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'closed', code: 'fence_changed' };
    if (!refresh) return this.close(session, 'invalid_proof');
    if (!await this.sameFeature(session.featureRevision)) return this.close(session, 'feature_disabled');
    if (!this.isCurrent(session)) return this.closed();
    if (!this.limited(session.brainId, session.deviceId)) return this.close(session, 'rate_limited');
    if (!await this.sameFeature(session.featureRevision)) return this.close(session, 'feature_disabled');
    if (!this.isCurrent(session)) return this.closed();
    // A refresh can prepare/activate a durable credential. Revalidate the
    // already-admitted credential immediately before that authority work so a
    // stale socket cannot use rotation to extend itself past its own expiry.
    const liveness = await this.recheck(session, false);
    if (liveness.status !== 'live') return liveness;
    if (!this.isCurrent(session)) return this.closed();
    const result = await this.authenticate({ brainId: session.brainId, context: { kind: 'local_device_connector', deviceId: session.deviceId }, ...refresh });
    // Reauthentication may await durable authority work. The original socket's
    // credential can expire while that await is outstanding; never let a
    // returned successor extend this already-expired session.
    const afterAuthentication = await this.recheck(session, false);
    if (afterAuthentication.status !== 'live') return afterAuthentication;
    if (!this.isCurrent(session)) return this.closed();
    if (result.status === 'close') return this.close(session, result.reason);
    if (result.status !== 'prepared' && result.status !== 'refreshed') return this.close(session, 'unavailable');
    if (result.deviceId !== session.deviceId) return this.close(session, 'fence_changed');
    if (!await this.sameFeature(session.featureRevision)) return this.close(session, 'feature_disabled');
    if (!this.isCurrent(session)) return this.closed();
    const current = await this.current(session.brainId, session.deviceId, result.fence);
    if (!this.isCurrent(session)) return this.closed();
    if (current !== 'current') return this.close(session, current);
    // Preparation leaves the prior credential authoritative. Configuration is
    // sampled again immediately before the one-time raw successor disclosure.
    // Activation contains no raw secret: the connector learned it only after a
    // successful prepared response and therefore cannot be stranded by a later close.
    if (!await this.sameFeature(session.featureRevision)) return this.close(session, 'feature_disabled');
    if (!this.isCurrent(session)) return this.closed();
    const credentialExpiresAt = expiryTime(result.credentialExpiresAt);
    if (credentialExpiresAt === null) return this.close(session, 'unavailable');
    session.fence = result.fence;
    session.credentialExpiresAt = credentialExpiresAt;
    // Raw successor material exists only on the prepared branch and is never
    // placed in the registry. Activation returns metadata only.
    return result.status === 'prepared'
      ? { status: 'prepared', connectorCredential: result.connectorCredential, credentialId: result.credentialId,
          priorCredentialId: result.priorCredentialId, expiresAt: result.expiresAt, rotationId: result.rotationId, fence: result.fence }
      : { status: 'refreshed', credentialId: result.credentialId, priorCredentialId: result.priorCredentialId,
          expiresAt: result.expiresAt, rotationId: result.rotationId, fence: result.fence };
  }

  async receive(sessionId: string, input: string | Uint8Array): Promise<{ status: 'live' } | { status: 'closed'; code: RemoteLocalAdmissionCloseCode }> {
    let parsed;
    try { parsed = parseRemoteLocalRelayFrame(input, 'connector_to_relay'); } catch {
      const session = this.sessions.get(sessionId);
      return session ? this.close(session, 'invalid_frame') : { status: 'closed', code: 'invalid_frame' };
    }
    if (parsed.type === 'protocol.error') {
      const session = this.sessions.get(sessionId);
      return session ? this.close(session, 'invalid_frame') : { status: 'closed', code: 'invalid_frame' };
    }
    if (!('fence' in parsed)) {
      const session = this.sessions.get(sessionId);
      return session ? this.close(session, 'invalid_frame') : { status: 'closed', code: 'invalid_frame' };
    }
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'closed', code: 'fence_changed' };
    if (parsed.fence.brainId !== session.brainId || parsed.fence.deviceId !== session.deviceId || parsed.fence.authorityRevision !== session.fence) {
      return this.close(session, 'fence_changed');
    }
    return parsed.type === 'heartbeat' ? this.heartbeat(sessionId) : this.recheck(session, false);
  }

  /** Revalidates an admitted session for a separately parsed closed protocol lane. */
  async recheckSession(sessionId: string): Promise<{ status: 'live' } | { status: 'closed'; code: RemoteLocalAdmissionCloseCode }> {
    if (!isOpaqueId(sessionId)) return { status: 'closed', code: 'fence_changed' };
    const session = this.sessions.get(sessionId);
    return session ? this.recheck(session, false) : { status: 'closed', code: 'fence_changed' };
  }

  async revoke(sessionId: unknown, code: unknown = 'revoked'): Promise<{ status: 'closed'; code: RemoteLocalAdmissionCloseCode }> {
    const normalized = closeCode(code);
    if (!isOpaqueId(sessionId)) return { status: 'closed', code: normalized };
    const session = this.sessions.get(sessionId);
    return session ? this.close(session, normalized) : { status: 'closed', code: normalized };
  }

  private async recheck(session: Session, heartbeat: boolean): Promise<{ status: 'live' } | { status: 'closed'; code: RemoteLocalAdmissionCloseCode }> {
    if (!this.isCurrent(session)) return this.closed();
    if (!await this.sameFeature(session.featureRevision)) return this.close(session, 'feature_disabled');
    if (!this.isCurrent(session)) return this.closed();
    const now = safeNow(this.dependencies.now);
    if (now === null) return this.close(session, 'unavailable');
    if (now < session.lastHeartbeatAt) return this.close(session, 'unavailable');
    if (now >= session.credentialExpiresAt) return this.close(session, 'expired');
    if (now - session.lastHeartbeatAt > this.maxHeartbeatAgeMs) return this.close(session, 'heartbeat_expired');
    const current = await this.current(session.brainId, session.deviceId, session.fence);
    if (!this.isCurrent(session)) return this.closed();
    if (current !== 'current') return this.close(session, current);
    if (!await this.sameFeature(session.featureRevision)) return this.close(session, 'feature_disabled');
    if (!this.isCurrent(session)) return this.closed();
    if (heartbeat) session.lastHeartbeatAt = now;
    return { status: 'live' };
  }

  private async authenticate(input: { brainId: string; context: DeviceContext; credential: string; proof: unknown }): Promise<Authenticated> {
    try {
      const result = await this.dependencies.reauthenticate.authenticate(input);
      if (!isPlainRecord(result) || typeof result.status !== 'string') return { status: 'close', reason: 'unavailable' };
      if (result.status === 'close') {
        // Task 2.3's internal invalid_authority is deliberately not a transport
        // code. It is indistinguishable at admission from a changed authority.
        const reason = result.reason === 'invalid_authority' ? 'fence_changed' : result.reason;
        return reason === 'invalid_proof' || reason === 'revoked' || reason === 'fence_changed' || reason === 'expired'
          || reason === 'unavailable' || reason === 'indeterminate'
          ? { status: 'close', reason } : { status: 'close', reason: 'unavailable' };
      }
      const credentialExpiry = snapshotCanonicalTimestamp(result, 'credentialExpiresAt');
      if (result.status === 'admitted' && isOpaqueId(result.fence) && isOpaqueId(result.deviceId) && credentialExpiry) return { status: 'admitted', fence: result.fence, deviceId: result.deviceId, credentialExpiresAt: credentialExpiry.value };
      const publicExpiry = snapshotCanonicalTimestamp(result, 'expiresAt');
      if (result.status === 'prepared' && isOpaqueId(result.fence) && isOpaqueId(result.deviceId)
        && isBoundedSecret(result.connectorCredential) && isOpaqueId(result.credentialId) && isOpaqueId(result.priorCredentialId)
        && publicExpiry && credentialExpiry && isOpaqueId(result.rotationId)) return {
          status: 'prepared', fence: result.fence, deviceId: result.deviceId, connectorCredential: result.connectorCredential,
          credentialId: result.credentialId, priorCredentialId: result.priorCredentialId, expiresAt: publicExpiry.value,
          credentialExpiresAt: credentialExpiry.value, rotationId: result.rotationId,
        };
      if (result.status === 'refreshed' && isOpaqueId(result.fence) && isOpaqueId(result.deviceId)
        && isOpaqueId(result.credentialId) && isOpaqueId(result.priorCredentialId)
        && publicExpiry && credentialExpiry && isOpaqueId(result.rotationId)) return {
          status: 'refreshed', fence: result.fence, deviceId: result.deviceId, credentialId: result.credentialId,
          priorCredentialId: result.priorCredentialId, expiresAt: publicExpiry.value, credentialExpiresAt: credentialExpiry.value,
          rotationId: result.rotationId,
        };
      return { status: 'close', reason: 'unavailable' };
    } catch { return { status: 'close', reason: 'unavailable' }; }
  }
  private async feature(): Promise<{ enabled: true; revision: string } | null> {
    try { const value = await this.dependencies.feature.snapshot(); return value.enabled === true && typeof value.revision === 'string' && value.revision.length > 0 ? value : null; } catch { return null; }
  }
  private async sameFeature(revision: string): Promise<boolean> {
    const current = await this.feature();
    return current?.revision === revision;
  }
  private limited(brainId: string, deviceId: string): boolean { return this.attempts.consume(brainId, deviceId); }
  private canIssueSessionId(): boolean {
    // Count each state because a reservation or live session will eventually
    // become a tombstone. This guarantees close() never needs to evict one.
    return this.sessions.size + this.reservations.size + this.retired.size < this.maxSessionIds;
  }
  private reserveSessionId(sessionId: string): object | undefined {
    if (!this.canIssueSessionId() || this.sessions.has(sessionId) || this.reservations.has(sessionId) || this.retired.has(sessionId)) return undefined;
    const reservation = Object.create(null);
    this.reservations.set(sessionId, reservation);
    return reservation;
  }
  private releaseReservation(sessionId: string, reservation: object): void {
    if (this.reservations.get(sessionId) === reservation) this.reservations.delete(sessionId);
  }
  private commitReservation(sessionId: string, reservation: object, session: Session): boolean {
    if (this.reservations.get(sessionId) !== reservation || this.sessions.has(sessionId) || this.retired.has(sessionId)) return false;
    this.sessions.set(sessionId, session);
    this.reservations.delete(sessionId);
    return true;
  }
  private isCurrent(session: Session): boolean { return this.sessions.get(session.id) === session && !session.closing; }
  private closed(): { status: 'closed'; code: RemoteLocalAdmissionCloseCode } { return { status: 'closed', code: 'fence_changed' }; }
  private async current(brainId: string, deviceId: string, fence: string): Promise<'current' | 'revoked' | 'fence_changed' | 'unavailable'> {
    try {
      const authority = await this.dependencies.inspectAuthority(brainId);
      if (authority.disposition === 'unavailable') return 'unavailable';
      if (authority.disposition !== 'current') return 'fence_changed';
      if (authority.active !== true) return authority.active === false ? 'revoked' : 'fence_changed';
      if (typeof authority.deviceId !== 'string' || authority.deviceId.length < 1 || typeof authority.fence !== 'string' || authority.fence.length < 1) return 'fence_changed';
      return authority.deviceId === deviceId && authority.fence === fence ? 'current' : 'fence_changed';
    } catch { return 'unavailable'; }
  }
  private async reject(transport: RemoteLocalSessionTransport | undefined, code: RemoteLocalAdmissionCloseCode): Promise<{ status: 'closed'; code: RemoteLocalAdmissionCloseCode }> {
    try { await transport?.close({ code }); } catch { /* close failures remain closed */ }
    return { status: 'closed', code };
  }
  private async close(session: Session, code: RemoteLocalAdmissionCloseCode): Promise<{ status: 'closed'; code: RemoteLocalAdmissionCloseCode }> {
    if (!session.closing) {
      // Mark first: all concurrently-held session references observe closure before
      // their next continuation, even while transport.close is suspended.
      let resolveClose!: () => void;
      session.closing = new Promise<void>((resolve) => { resolveClose = resolve; });
      // The first synchronous caller owns the close disposition. Every racing
      // caller returns this same value after awaiting the one transport close.
      session.closeCode = code;
      this.sessions.delete(session.id);
      // Admission capacity reserves room for every current session to become a
      // tombstone, so this cannot overflow without a programming error. If it
      // does, sealing future issuance still preserves non-reuse.
      this.retired.add(session.id);
      Promise.resolve().then(() => session.transport.close({ code: session.closeCode! })).catch(() => undefined).finally(resolveClose);
    }
    await session.closing;
    return { status: 'closed', code: session.closeCode! };
  }
}
