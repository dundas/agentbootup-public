import { createHash, randomBytes } from 'node:crypto';
import { type CasCreateBody, type CasCreateResult, type CasGetResult, type CasUpdateBody, type CasUpdateResult } from '@mech/storage-sdk';
import type { RemoteLocalOwnerOperationScope } from './remote-local-owner-operations';
import type { ApprovalAuthority } from './remote-local-relay-protocol';
import { retryStorageRead, type StorageReadRetryPolicy } from './storage-read-retry';

const COLLECTION = 'agentbootup_remote_local_approval_claims';
// A pending record gates external approval delivery. A failed CAS create has
// an uncertain outcome, so it is never retried. A subsequent read is safe and
// can reconcile a committed write. Its bounded 429 retry honors SDK metadata.
const PENDING_RECONCILE_READ_RETRY_POLICY: StorageReadRetryPolicy = { attempts: 4, maxDelayMs: 8_000 };
type Cas = { getDocument(collection: string, key: string): Promise<CasGetResult>; createDocument(body: CasCreateBody): Promise<CasCreateResult>; updateDocument(collection: string, key: string, body: CasUpdateBody): Promise<CasUpdateResult> };
type Input = { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; approvalRequestId: string; authority: ApprovalAuthority; disposition: 'allow' | 'deny'; idempotencyKey: string };
type ReplayInput = Omit<Input, 'authority'>;
type PendingInput = { scope: RemoteLocalOwnerOperationScope; commandId: string; sessionHandle: string; approvalRequestId: string; authority: ApprovalAuthority };
type Outcome = 'pending' | 'claimed' | 'accepted' | 'indeterminate' | 'intent_already_resolved';
type Snapshot = {
  tenantId: string; consumerId: string; brainId: string; targetDeviceId: string; sessionHandle: string; authorityRevision: string;
  environmentAuthorizationId: string; bindingDigest: string; approvalRequestDigest: string; intentDigest: string; fullAuthorityDigest: string;
  idempotencyKey: string; disposition: 'allow' | 'deny'; decidingPrincipalId: string; decidingCredentialId: string; resolutionId: string;
};
type IntentClaim = Snapshot & { schemaVersion: 2; createdAt: string };
type RequestReceipt = Snapshot & { schemaVersion: 2; outcome: Outcome; createdAt: string; updatedAt: string };
type PendingBase = { schemaVersion: 2; tenantId: string; consumerId: string; brainId: string; targetDeviceId: string;
  sessionHandle: string; authorityRevision: string; approvalRequestDigest: string; commandId: string; createdAt: string };
type PendingRequest = PendingBase & { kind: 'pending_request'; authority: ApprovalAuthority };
type PendingTombstone = PendingBase & { kind: 'pending_tombstone'; outcome: 'accepted' | 'indeterminate' | 'expired' | 'session_ended'; closedAt: string };

export type RemoteLocalApprovalClaimResult =
  | { status: 'accepted' | 'replayed'; resolutionId: string }
  | { status: 'indeterminate'; resolutionId: string }
  | { status: 'idempotency_conflict' | 'intent_already_resolved' | 'unavailable' };

/** Durable intent arbitration plus a separate decision-idempotency receipt. */
export class RemoteLocalApprovalStore {
  private readonly pendingReconcileReadRetryPolicy: StorageReadRetryPolicy;

  constructor(private readonly cas: Cas, options: { pendingReconcileReadRetryPolicy?: StorageReadRetryPolicy } = {}) {
    if (!cas?.getDocument || !cas?.createDocument || !cas?.updateDocument) throw new Error('RemoteLocalApprovalStore requires CAS');
    this.pendingReconcileReadRetryPolicy = options.pendingReconcileReadRetryPolicy ?? PENDING_RECONCILE_READ_RETRY_POLICY;
  }

  async claim(input: Input): Promise<RemoteLocalApprovalClaimResult> {
    const intended = snapshot(input); if (!intended) return { status: 'unavailable' };
    const receipt = await this.ensureRequestReceipt(intended);
    if (receipt.status !== 'ready') return receipt;
    const bound = { ...intended, resolutionId: receipt.receipt.resolutionId };
    const intent = await this.ensureIntentClaim(bound);
    if (intent === 'unavailable') return { status: 'unavailable' };
    const outcome = intent === 'winner' ? 'claimed' : 'intent_already_resolved';
    const settled = await this.updateReceiptOutcome(receipt.key, receipt.receipt, outcome);
    if (intent === 'winner') return settled.status === 'updated'
      ? { status: 'accepted', resolutionId: receipt.receipt.resolutionId }
      : { status: 'indeterminate', resolutionId: receipt.receipt.resolutionId };
    if (settled.status === 'unavailable' || settled.status === 'conflict') return { status: 'unavailable' };
    return { status: 'intent_already_resolved' };
  }

  /** Stores only the opaque environment authority needed by another relay instance while it remains unexpired. */
  async registerPending(input: PendingInput): Promise<{ status: 'registered' | 'idempotent' | 'unavailable' }> {
    const record = pendingSnapshot(input); if (!record) return { status: 'unavailable' };
    const key = pendingKey(input.scope.tenantId, input.scope.consumerId, input.scope.brainId, input.approvalRequestId);
    try {
      const created = await this.cas.createDocument({ collection: COLLECTION, document_key: key, data: record, metadata: {} });
      if (created.ok) return samePending(created.document.data, record) ? { status: 'registered' } : { status: 'unavailable' };
      return samePending('current' in created ? created.current?.data : undefined, record) ? { status: 'idempotent' } : { status: 'unavailable' };
    } catch {
      try { const read = await readPendingWithRetry(this.cas, key, this.pendingReconcileReadRetryPolicy); return read.ok && samePending(read.document.data, record) ? { status: 'idempotent' } : { status: 'unavailable' }; }
      catch { return { status: 'unavailable' }; }
    }
  }

  async getPending(input: ReplayInput): Promise<{ status: 'found'; authority: ApprovalAuthority; commandId: string } | { status: 'resolved' | 'not_found' | 'unavailable' }> {
    const { scope, sessionHandle, approvalRequestId } = input;
    if (!validScope(scope) || !opaque(sessionHandle) || !opaque(approvalRequestId)) return { status: 'unavailable' };
    let read: CasGetResult;
    try { read = await this.cas.getDocument(COLLECTION, pendingKey(scope.tenantId, scope.consumerId, scope.brainId, approvalRequestId)); }
    catch { return { status: 'unavailable' }; }
    if (!read.ok) return read.code === 'DOCUMENT_NOT_FOUND' ? { status: 'not_found' } : { status: 'unavailable' };
    const terminal = parsePendingTombstone(read.document.data);
    if (terminal) return terminal.tenantId === scope.tenantId && terminal.consumerId === scope.consumerId && terminal.brainId === scope.brainId
      && terminal.targetDeviceId === scope.deviceId && terminal.authorityRevision === scope.fence.capabilitiesRevision && terminal.sessionHandle === sessionHandle
      && terminal.approvalRequestDigest === digest('approval-request-id:v2', [approvalRequestId]) && terminal.outcome === 'accepted'
      ? { status: 'resolved' } : { status: 'not_found' };
    const pending = parsePending(read.document.data);
    if (!pending || pending.tenantId !== scope.tenantId || pending.consumerId !== scope.consumerId || pending.brainId !== scope.brainId
      || pending.targetDeviceId !== scope.deviceId || pending.authorityRevision !== scope.fence.capabilitiesRevision || pending.sessionHandle !== sessionHandle
      || pending.approvalRequestDigest !== digest('approval-request-id:v2', [approvalRequestId])) return { status: 'not_found' };
    if (Date.parse(pending.authority.expiresAt) <= Date.now()) {
      const closed = await this.closePending({ scope, sessionHandle, approvalRequestId, outcome: 'expired' });
      return closed.status === 'unavailable' ? { status: 'unavailable' } : { status: 'not_found' };
    }
    return { status: 'found', authority: pending.authority, commandId: pending.commandId };
  }

  async closePending(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; approvalRequestId: string; outcome: PendingTombstone['outcome'] }): Promise<{ status: 'updated' | 'idempotent' | 'not_found' | 'conflict' | 'unavailable' }> {
    if (!validScope(input.scope) || !opaque(input.sessionHandle) || !opaque(input.approvalRequestId)) return { status: 'unavailable' };
    const key = pendingKey(input.scope.tenantId, input.scope.consumerId, input.scope.brainId, input.approvalRequestId);
    return this.closePendingKey(key, input.scope, input.sessionHandle, digest('approval-request-id:v2', [input.approvalRequestId]), input.outcome);
  }

  /** Validates a connector resolution against the durable winner and settles that request receipt. */
  async resolveConnector(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; authority: ApprovalAuthority; disposition: 'allow' | 'deny'; resolutionId: string; decider: { kind: 'owner'; principalId: string; credentialId: string } }): Promise<{ status: 'accepted' } | { status: 'invalid' | 'unavailable' }> {
    if (!validScope(input.scope) || !opaque(input.sessionHandle) || !opaque(input.resolutionId) || !validAuthority(input.scope, input.authority)
      || (input.disposition !== 'allow' && input.disposition !== 'deny') || input.decider.kind !== 'owner' || !opaque(input.decider.principalId) || !opaque(input.decider.credentialId)) return { status: 'invalid' };
    const intentParts = intentPartsFor(input.scope, input.sessionHandle, input.authority);
    let read: CasGetResult; try { read = await this.cas.getDocument(COLLECTION, `approval-intent:v2:${digest('approval-intent:v2', intentParts)}`); }
    catch { return { status: 'unavailable' }; }
    if (!read.ok) return { status: read.code === 'DOCUMENT_NOT_FOUND' ? 'invalid' : 'unavailable' };
    const claim = parseIntentClaim(read.document.data);
    if (!claim || claim.fullAuthorityDigest !== fullAuthorityDigest(input.authority) || claim.disposition !== input.disposition
      || claim.resolutionId !== input.resolutionId || claim.decidingPrincipalId !== input.decider.principalId
      || claim.decidingCredentialId !== input.decider.credentialId) return { status: 'invalid' };
    let receiptRead: CasGetResult; try { receiptRead = await this.cas.getDocument(COLLECTION, requestKey(claim)); }
    catch { return { status: 'unavailable' }; }
    if (!receiptRead.ok) return { status: 'unavailable' };
    const receipt = parseReceipt(receiptRead.document.data);
    if (!receipt || !sameRequestBinding(receipt, claim)) return { status: 'invalid' };
    if (receipt.outcome !== 'accepted' && receipt.outcome !== 'claimed') return { status: 'invalid' };
    const closed = await this.closePendingKey(pendingKeyFromDigest(claim.tenantId, claim.consumerId, claim.brainId, claim.approvalRequestDigest), input.scope,
      input.sessionHandle, claim.approvalRequestDigest, 'accepted');
    if (closed.status !== 'updated' && closed.status !== 'idempotent') return { status: 'unavailable' };
    const settled = receipt.outcome === 'accepted' ? { status: 'idempotent' as const, receipt }
      : await this.updateReceiptOutcome(requestKey(claim), receipt, 'accepted');
    return settled.status === 'updated' || (settled.status === 'idempotent' && settled.receipt.outcome === 'accepted')
      ? { status: 'accepted' } : { status: 'unavailable' };
  }

  /** Resolves a known decision receipt without requiring ephemeral broker state. */
  async replay(input: ReplayInput): Promise<RemoteLocalApprovalClaimResult | { status: 'not_found' }> {
    const { scope, sessionHandle, approvalRequestId, disposition, idempotencyKey } = input;
    if (!scope || !opaque(scope.tenantId) || !opaque(scope.consumerId) || !opaque(scope.ownerPrincipalId) || !opaque(scope.credentialId)
      || !opaque(scope.brainId) || !opaque(scope.deviceId) || !opaque(scope.fence.capabilitiesRevision) || !opaque(sessionHandle)
      || !opaque(approvalRequestId) || !opaque(idempotencyKey) || (disposition !== 'allow' && disposition !== 'deny')) return { status: 'unavailable' };
    const key = requestKeyParts(scope.tenantId, scope.consumerId, scope.brainId, idempotencyKey);
    let read: CasGetResult; try { read = await this.cas.getDocument(COLLECTION, key); } catch { return { status: 'unavailable' }; }
    if (!read.ok) return read.code === 'DOCUMENT_NOT_FOUND' ? { status: 'not_found' } : { status: 'unavailable' };
    const receipt = parseReceipt(read.document.data);
    if (!receipt || receipt.tenantId !== scope.tenantId || receipt.consumerId !== scope.consumerId || receipt.brainId !== scope.brainId
      || receipt.targetDeviceId !== scope.deviceId || receipt.authorityRevision !== scope.fence.capabilitiesRevision || receipt.sessionHandle !== sessionHandle
      || receipt.approvalRequestDigest !== digest('approval-request-id:v2', [approvalRequestId]) || receipt.idempotencyKey !== idempotencyKey
      || receipt.disposition !== disposition || receipt.decidingPrincipalId !== scope.ownerPrincipalId || receipt.decidingCredentialId !== scope.credentialId) {
      return { status: 'idempotency_conflict' };
    }
    if (receipt.outcome === 'accepted') return { status: 'replayed', resolutionId: receipt.resolutionId };
    if (receipt.outcome === 'intent_already_resolved') return { status: 'intent_already_resolved' };
    return { status: 'indeterminate', resolutionId: receipt.resolutionId };
  }

  async settle(input: Input & { resolutionId: string; outcome: 'accepted' | 'indeterminate' }): Promise<{ status: 'updated' | 'idempotent'; outcome: 'accepted' | 'indeterminate' } | { status: 'conflict' | 'unavailable' }> {
    const intended = snapshot(input, input.resolutionId); if (!intended) return { status: 'unavailable' };
    const key = requestKey(intended); let read: CasGetResult;
    try { read = await this.cas.getDocument(COLLECTION, key); } catch { return { status: 'unavailable' }; }
    if (!read.ok) return { status: 'unavailable' };
    const current = parseReceipt(read.document.data);
    if (!current || !sameRequestBinding(current, intended) || current.resolutionId !== intended.resolutionId) return { status: 'conflict' };
    if (current.outcome === input.outcome) return { status: 'idempotent', outcome: input.outcome };
    if (current.outcome === 'accepted') return { status: 'idempotent', outcome: 'accepted' };
    if (current.outcome !== 'claimed') return { status: 'conflict' };
    const updated = await this.updateReceiptOutcome(key, current, input.outcome);
    if (updated.status === 'updated' || updated.status === 'idempotent') {
      return { status: updated.status, outcome: updated.receipt.outcome as 'accepted' | 'indeterminate' };
    }
    return { status: updated.status };
  }

  private async ensureRequestReceipt(intended: Snapshot): Promise<
    | { status: 'ready'; key: string; receipt: RequestReceipt }
    | Exclude<RemoteLocalApprovalClaimResult, { status: 'accepted' }>
  > {
    const key = requestKey(intended); const now = new Date().toISOString();
    const createdReceipt: RequestReceipt = { schemaVersion: 2, ...intended, outcome: 'pending', createdAt: now, updatedAt: now };
    let value: unknown;
    try {
      const created = await this.cas.createDocument({ collection: COLLECTION, document_key: key, data: createdReceipt, metadata: {} });
      value = created.ok ? created.document.data : created.current?.data;
    } catch {
      try { const read = await this.cas.getDocument(COLLECTION, key); value = read.ok ? read.document.data : null; }
      catch { return { status: 'unavailable' }; }
    }
    const receipt = parseReceipt(value);
    if (!receipt) return { status: 'unavailable' };
    if (!sameRequestBinding(receipt, intended)) return { status: 'idempotency_conflict' };
    if (receipt.outcome === 'accepted') return { status: 'replayed', resolutionId: receipt.resolutionId };
    if (receipt.outcome === 'claimed' || receipt.outcome === 'indeterminate') return { status: 'indeterminate', resolutionId: receipt.resolutionId };
    if (receipt.outcome === 'intent_already_resolved') return { status: 'intent_already_resolved' };
    return { status: 'ready', key, receipt };
  }

  private async ensureIntentClaim(intended: Snapshot): Promise<'winner' | 'loser' | 'unavailable'> {
    const key = intentKey(intended); const claim: IntentClaim = { schemaVersion: 2, ...intended, createdAt: new Date().toISOString() };
    let value: unknown;
    try {
      const created = await this.cas.createDocument({ collection: COLLECTION, document_key: key, data: claim, metadata: {} });
      if (created.ok) return sameIntentClaim(created.document.data, claim) ? 'winner' : 'unavailable';
      value = created.current?.data;
    } catch {
      try { const read = await this.cas.getDocument(COLLECTION, key); value = read.ok ? read.document.data : null; }
      catch { return 'unavailable'; }
    }
    const current = parseIntentClaim(value);
    if (!current || current.intentDigest !== intended.intentDigest) return 'unavailable';
    return sameIntentClaim(current, claim) ? 'winner' : 'loser';
  }

  private async closePendingKey(key: string, scope: RemoteLocalOwnerOperationScope, sessionHandle: string, approvalRequestDigest: string,
    outcome: PendingTombstone['outcome']): Promise<{ status: 'updated' | 'idempotent' | 'not_found' | 'conflict' | 'unavailable' }> {
    let read: CasGetResult; try { read = await this.cas.getDocument(COLLECTION, key); } catch { return { status: 'unavailable' }; }
    if (!read.ok) return read.code === 'DOCUMENT_NOT_FOUND' ? { status: 'not_found' } : { status: 'unavailable' };
    const tombstone = parsePendingTombstone(read.document.data);
    if (tombstone) return tombstone.tenantId === scope.tenantId && tombstone.consumerId === scope.consumerId && tombstone.brainId === scope.brainId
      && tombstone.targetDeviceId === scope.deviceId && tombstone.authorityRevision === scope.fence.capabilitiesRevision
      && tombstone.sessionHandle === sessionHandle && tombstone.approvalRequestDigest === approvalRequestDigest && tombstone.outcome === outcome
      ? { status: 'idempotent' } : { status: 'conflict' };
    const pending = parsePending(read.document.data);
    if (!pending || pending.tenantId !== scope.tenantId || pending.consumerId !== scope.consumerId || pending.brainId !== scope.brainId
      || pending.targetDeviceId !== scope.deviceId || pending.authorityRevision !== scope.fence.capabilitiesRevision
      || pending.sessionHandle !== sessionHandle || pending.approvalRequestDigest !== approvalRequestDigest) return { status: 'unavailable' };
    const closedAt = new Date().toISOString();
    const next: PendingTombstone = { schemaVersion: 2, kind: 'pending_tombstone', tenantId: pending.tenantId, consumerId: pending.consumerId,
      brainId: pending.brainId, targetDeviceId: pending.targetDeviceId, sessionHandle: pending.sessionHandle, authorityRevision: pending.authorityRevision,
      approvalRequestDigest: pending.approvalRequestDigest, commandId: pending.commandId, createdAt: pending.createdAt, outcome, closedAt };
    try {
      const updated = await this.cas.updateDocument(COLLECTION, key, { _rev: read.document._rev, data: next, metadata: {} });
      if (updated.ok) return parsePendingTombstone(updated.document.data) ? { status: 'updated' } : { status: 'unavailable' };
      const raced = parsePendingTombstone('current' in updated ? updated.current?.data : undefined);
      return raced && raced.approvalRequestDigest === approvalRequestDigest
        ? raced.outcome === outcome ? { status: 'idempotent' } : { status: 'conflict' }
        : { status: 'unavailable' };
    } catch {
      try {
        const reconciled = await this.cas.getDocument(COLLECTION, key); const parsed = reconciled.ok ? parsePendingTombstone(reconciled.document.data) : null;
        return parsed?.approvalRequestDigest === approvalRequestDigest
          ? parsed.outcome === outcome ? { status: 'idempotent' } : { status: 'conflict' }
          : { status: 'unavailable' };
      }
      catch { return { status: 'unavailable' }; }
    }
  }

  private async updateReceiptOutcome(key: string, current: RequestReceipt, outcome: Exclude<Outcome, 'pending'>): Promise<
    | { status: 'updated' | 'idempotent'; receipt: RequestReceipt }
    | { status: 'conflict' | 'unavailable' }
  > {
    if (current.outcome === outcome) return { status: 'idempotent', receipt: current };
    let priorRevision: string | undefined;
    try {
      const read = await this.cas.getDocument(COLLECTION, key); if (!read.ok) return { status: 'unavailable' };
      const latest = parseReceipt(read.document.data);
      if (!latest || !sameRequestBinding(latest, current) || latest.resolutionId !== current.resolutionId) return { status: 'conflict' };
      if (latest.outcome === outcome) return { status: 'idempotent', receipt: latest };
      if (latest.outcome !== current.outcome) return { status: 'conflict' };
      priorRevision = read.document._rev;
      const next: RequestReceipt = { ...latest, outcome, updatedAt: new Date().toISOString() };
      const updated = await this.cas.updateDocument(COLLECTION, key, { _rev: priorRevision, data: next, metadata: {} });
      if (updated.ok) { const parsed = parseReceipt(updated.document.data); return parsed && parsed.outcome === outcome ? { status: 'updated', receipt: parsed } : { status: 'unavailable' }; }
      const raced = parseReceipt('current' in updated ? updated.current?.data : undefined);
      return raced && sameRequestBinding(raced, current) && raced.resolutionId === current.resolutionId && raced.outcome === outcome
        ? { status: 'idempotent', receipt: raced } : { status: 'conflict' };
    } catch {
      try {
        const read = await this.cas.getDocument(COLLECTION, key); if (!read.ok || (priorRevision !== undefined && read.document._rev === priorRevision)) return { status: 'unavailable' };
        const reconciled = parseReceipt(read.document.data);
        return reconciled && sameRequestBinding(reconciled, current) && reconciled.resolutionId === current.resolutionId && reconciled.outcome === outcome
          ? { status: 'idempotent', receipt: reconciled } : { status: 'conflict' };
      } catch { return { status: 'unavailable' }; }
    }
  }
}

function readPendingWithRetry(cas: Cas, key: string, policy: StorageReadRetryPolicy): Promise<CasGetResult> {
  return retryStorageRead(() => cas.getDocument(COLLECTION, key), policy);
}

function snapshot(input: Input, resolutionId = `rla_${randomBytes(18).toString('base64url')}`): Snapshot | null {
  const { scope, sessionHandle, approvalRequestId, authority, disposition, idempotencyKey } = input;
  if (!validScope(scope) || !opaque(sessionHandle) || !opaque(idempotencyKey) || !opaque(approvalRequestId)
    || (disposition !== 'allow' && disposition !== 'deny') || !opaque(resolutionId) || !validAuthority(scope, authority)) return null;
  const intentParts = intentPartsFor(scope, sessionHandle, authority);
  return { tenantId: scope.tenantId, consumerId: scope.consumerId, brainId: scope.brainId, targetDeviceId: scope.deviceId,
    sessionHandle, authorityRevision: scope.fence.capabilitiesRevision, environmentAuthorizationId: authority.environmentAuthorizationId,
    bindingDigest: authority.bindingDigest, approvalRequestDigest: digest('approval-request-id:v2', [approvalRequestId]),
    intentDigest: digest('approval-intent:v2', intentParts), fullAuthorityDigest: fullAuthorityDigest(authority),
    idempotencyKey, disposition, decidingPrincipalId: scope.ownerPrincipalId, decidingCredentialId: scope.credentialId, resolutionId };
}
function pendingSnapshot(input: PendingInput): PendingRequest | null {
  if (!validScope(input.scope) || !opaque(input.commandId) || !opaque(input.sessionHandle) || !opaque(input.approvalRequestId) || !validAuthority(input.scope, input.authority)) return null;
  return { schemaVersion: 2, kind: 'pending_request', tenantId: input.scope.tenantId, consumerId: input.scope.consumerId, brainId: input.scope.brainId,
    targetDeviceId: input.scope.deviceId, sessionHandle: input.sessionHandle, authorityRevision: input.scope.fence.capabilitiesRevision,
    approvalRequestDigest: digest('approval-request-id:v2', [input.approvalRequestId]), commandId: input.commandId, authority: structuredClone(input.authority), createdAt: new Date().toISOString() };
}
function validScope(scope: RemoteLocalOwnerOperationScope | null | undefined): scope is RemoteLocalOwnerOperationScope {
  return !!scope && [scope.tenantId, scope.ownerPrincipalId, scope.consumerId, scope.credentialId, scope.brainId, scope.deviceId, scope.fence?.capabilitiesRevision].every(opaque);
}
function validAuthority(scope: RemoteLocalOwnerOperationScope, authority: ApprovalAuthority | null | undefined): authority is ApprovalAuthority {
  if (!authority || authority.tenantId !== scope.tenantId || authority.consumerId !== scope.consumerId || authority.targetDeviceId !== scope.deviceId) return false;
  const parts = [authority.tenantId, authority.consumerId, authority.targetDeviceId, authority.environmentAuthorizationId, authority.bindingDigest,
    authority.mountId, authority.functionalityId, authority.resourceId, authority.principalId, authority.mountEpoch, authority.runGeneration, authority.expiresAt, authority.assurance];
  return parts.every(opaque) && /^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9_-]{32,128})$/.test(authority.bindingDigest)
    && Number.isFinite(Date.parse(authority.expiresAt)) && Date.parse(authority.expiresAt) > Date.now();
}
function intentPartsFor(scope: RemoteLocalOwnerOperationScope, sessionHandle: string, authority: ApprovalAuthority): string[] {
  return [scope.tenantId, scope.consumerId, scope.brainId, scope.deviceId, sessionHandle, scope.fence.capabilitiesRevision, authority.environmentAuthorizationId, authority.bindingDigest];
}
function fullAuthorityDigest(authority: ApprovalAuthority): string {
  return digest('approval-authority:v2', [authority.tenantId, authority.consumerId, authority.targetDeviceId, authority.environmentAuthorizationId, authority.bindingDigest,
    authority.mountId, authority.functionalityId, authority.resourceId, authority.principalId, authority.mountEpoch, authority.runGeneration, authority.expiresAt, authority.assurance]);
}
function requestKey(value: Snapshot): string { return requestKeyParts(value.tenantId, value.consumerId, value.brainId, value.idempotencyKey); }
function requestKeyParts(tenantId: string, consumerId: string, brainId: string, idempotencyKey: string): string { return `approval-request:v2:${digest('approval-request:v2', [tenantId, consumerId, brainId, idempotencyKey])}`; }
function pendingKey(tenantId: string, consumerId: string, brainId: string, approvalRequestId: string): string {
  return pendingKeyFromDigest(tenantId, consumerId, brainId, digest('approval-request-id:v2', [approvalRequestId]));
}
function pendingKeyFromDigest(tenantId: string, consumerId: string, brainId: string, approvalRequestDigest: string): string {
  return `approval-pending:v2:${digest('approval-pending:v2', [tenantId, consumerId, brainId, approvalRequestDigest])}`;
}
function intentKey(value: Snapshot): string { return `approval-intent:v2:${value.intentDigest}`; }
function digest(domain: string, parts: readonly string[]): string { return createHash('sha256').update([domain, ...parts].map((part) => `${Buffer.byteLength(part)}:${part}`).join('|')).digest('base64url'); }
function opaque(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
const snapshotKeys = ['tenantId', 'consumerId', 'brainId', 'targetDeviceId', 'sessionHandle', 'authorityRevision', 'environmentAuthorizationId', 'bindingDigest', 'approvalRequestDigest', 'intentDigest', 'fullAuthorityDigest', 'idempotencyKey', 'disposition', 'decidingPrincipalId', 'decidingCredentialId', 'resolutionId'] as const;
function parseSnapshot(value: Record<string, unknown>): value is Record<(typeof snapshotKeys)[number], string> & { disposition: 'allow' | 'deny' } { return snapshotKeys.every((key) => opaque(value[key])) && (value.disposition === 'allow' || value.disposition === 'deny'); }
function parseIntentClaim(value: unknown): IntentClaim | null { return !!value && typeof value === 'object' && !Array.isArray(value) && exactKeys(value as Record<string, unknown>, ['schemaVersion', ...snapshotKeys, 'createdAt']) && (value as Record<string, unknown>).schemaVersion === 2 && parseSnapshot(value as Record<string, unknown>) && opaque((value as Record<string, unknown>).createdAt) ? value as IntentClaim : null; }
function parseReceipt(value: unknown): RequestReceipt | null { return !!value && typeof value === 'object' && !Array.isArray(value) && exactKeys(value as Record<string, unknown>, ['schemaVersion', ...snapshotKeys, 'outcome', 'createdAt', 'updatedAt']) && (value as Record<string, unknown>).schemaVersion === 2 && parseSnapshot(value as Record<string, unknown>) && ['pending', 'claimed', 'accepted', 'indeterminate', 'intent_already_resolved'].includes(String((value as Record<string, unknown>).outcome)) && opaque((value as Record<string, unknown>).createdAt) && opaque((value as Record<string, unknown>).updatedAt) ? value as RequestReceipt : null; }
function parsePending(value: unknown): PendingRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, ['schemaVersion', 'kind', 'tenantId', 'consumerId', 'brainId', 'targetDeviceId', 'sessionHandle', 'authorityRevision', 'approvalRequestDigest', 'commandId', 'authority', 'createdAt'])) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 2 || candidate.kind !== 'pending_request' || !['tenantId', 'consumerId', 'brainId', 'targetDeviceId', 'sessionHandle', 'authorityRevision', 'approvalRequestDigest', 'commandId', 'createdAt'].every((key) => opaque(candidate[key]))) return null;
  const authority = candidate.authority;
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return null;
  const raw = authority as Record<string, unknown>;
  const authorityKeys = ['tenantId', 'consumerId', 'targetDeviceId', 'environmentAuthorizationId', 'bindingDigest', 'mountId', 'functionalityId', 'resourceId', 'principalId', 'mountEpoch', 'runGeneration', 'expiresAt', 'assurance'];
  if (!exactKeys(raw, authorityKeys) || !authorityKeys.every((key) => opaque(raw[key]))) return null;
  return value as PendingRequest;
}
function parsePendingTombstone(value: unknown): PendingTombstone | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, ['schemaVersion', 'kind', 'tenantId', 'consumerId', 'brainId', 'targetDeviceId', 'sessionHandle', 'authorityRevision', 'approvalRequestDigest', 'commandId', 'createdAt', 'outcome', 'closedAt'])) return null;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === 2 && candidate.kind === 'pending_tombstone'
    && ['tenantId', 'consumerId', 'brainId', 'targetDeviceId', 'sessionHandle', 'authorityRevision', 'approvalRequestDigest', 'commandId', 'createdAt', 'closedAt'].every((key) => opaque(candidate[key]))
    && ['accepted', 'indeterminate', 'expired', 'session_ended'].includes(String(candidate.outcome)) ? value as PendingTombstone : null;
}
function samePending(value: unknown, intended: PendingRequest): boolean {
  const parsed = parsePending(value); if (!parsed) return false;
  return parsed.schemaVersion === intended.schemaVersion && parsed.kind === intended.kind && parsed.tenantId === intended.tenantId
    && parsed.consumerId === intended.consumerId && parsed.brainId === intended.brainId && parsed.targetDeviceId === intended.targetDeviceId
    && parsed.sessionHandle === intended.sessionHandle && parsed.authorityRevision === intended.authorityRevision
    && parsed.approvalRequestDigest === intended.approvalRequestDigest && parsed.commandId === intended.commandId
    && sameAuthority(parsed.authority, intended.authority);
}
/** Storage may canonicalize JSON object key order; authority equality is semantic, never serialized-byte equality. */
function sameAuthority(left: ApprovalAuthority, right: ApprovalAuthority): boolean {
  return left.tenantId === right.tenantId && left.consumerId === right.consumerId && left.targetDeviceId === right.targetDeviceId
    && left.environmentAuthorizationId === right.environmentAuthorizationId && left.bindingDigest === right.bindingDigest
    && left.mountId === right.mountId && left.functionalityId === right.functionalityId && left.resourceId === right.resourceId
    && left.principalId === right.principalId && left.mountEpoch === right.mountEpoch && left.runGeneration === right.runGeneration
    && left.expiresAt === right.expiresAt && left.assurance === right.assurance;
}
function sameRequestBinding(left: Snapshot, right: Snapshot): boolean { return snapshotKeys.filter((key) => key !== 'resolutionId').every((key) => left[key] === right[key]); }
function sameIntentClaim(left: unknown, right: IntentClaim): boolean { const parsed = parseIntentClaim(left); return parsed !== null && snapshotKeys.every((key) => parsed[key] === right[key]); }
