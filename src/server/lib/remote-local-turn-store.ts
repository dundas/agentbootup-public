/**
 * Durable metadata-only receipt boundary for PRD-0072 Task 4.2.
 *
 * This module deliberately has no payload, output, event, terminal-reference, or
 * logging API. A later qualified connector-local encrypted terminal handoff may
 * disclose a result live, but it must remain outside this relay receipt store.
 */
import { createHash } from 'node:crypto';
import { StorageSdkError, type CasCreateBody, type CasCreateResult, type CasGetResult, type CasUpdateBody, type CasUpdateResult } from '@mech/storage-sdk';
import type { RemoteLocalOwnerOperationScope } from './remote-local-owner-operations';

const COLLECTION = 'agentbootup_remote_local_turn_receipts';
const SCHEMA_VERSION = 2;
const receiptFields = [
  'schemaVersion', 'commandId', 'tenantId', 'ownerPrincipalId', 'consumerId', 'credentialId', 'brainId', 'deviceId',
  'sessionHandle', 'fenceRevision', 'idempotencyKey', 'requestDigest', 'disposition',
  'createdAt', 'updatedAt', 'redactedOutcome',
] as const;
const terminalDispositions = ['completed', 'failed', 'indeterminate', 'interrupted'] as const;
const dispositions = ['accepted', 'in_progress', ...terminalDispositions] as const;
const DEFAULT_TERMINAL_RETRY_POLICY = Object.freeze({ attempts: 2, maxDelayMs: 5_000 });

type Cas = {
  getDocument(collection: string, key: string): Promise<CasGetResult>;
  createDocument(body: CasCreateBody): Promise<CasCreateResult>;
  updateDocument(collection: string, key: string, body: CasUpdateBody): Promise<CasUpdateResult>;
};
type Scope = { tenantId: string; ownerPrincipalId: string; consumerId: string; credentialId: string; brainId: string; deviceId: string; sessionHandle: string; fenceRevision: string };
type ReceiptInput = Scope & { idempotencyKey: string; requestDigest: string };
type Disposition = (typeof dispositions)[number];
type TerminalDisposition = (typeof terminalDispositions)[number];
type Receipt = ReceiptInput & {
  schemaVersion: 2; commandId: string; disposition: Disposition; createdAt: string; updatedAt: string;
  redactedOutcome: TerminalDisposition | null;
};
type TerminalReceipt = Receipt & { disposition: TerminalDisposition; redactedOutcome: TerminalDisposition };
type TerminalRetryPolicy = { attempts?: number; maxDelayMs?: number; sleep?: (delayMs: number) => Promise<void>; random?: () => number };

export type RemoteLocalTurnReceiptResult =
  | { status: 'accepted' | 'replay'; commandId: string; disposition: Disposition }
  | { status: 'conflict' | 'unavailable' };

export type RemoteLocalTurnStatusResult =
  | { status: 'updated' | 'idempotent'; commandId: string; disposition: TerminalDisposition }
  | { status: 'conflict' | 'unavailable' };

export type RemoteLocalTurnProgressResult =
  | { status: 'updated' | 'idempotent'; commandId: string; disposition: 'in_progress' }
  | { status: 'conflict' | 'unavailable' };

export type RemoteLocalTurnLookupResult =
  | { status: 'found'; commandId: string; disposition: Disposition }
  | { status: 'not_found' | 'unavailable' };

/**
 * The only future terminal-store seam. It intentionally conveys no terminal
 * reference or bytes through the relay persistence boundary: a qualified local
 * encrypted terminal implementation is responsible for its own authorization,
 * encryption, and direct one-time live handoff.
 */
export interface QualifiedLocalEncryptedTerminalHandoff {
  readonly kind: 'qualified_local_encrypted_terminal_handoff';
  readonly commandId: string;
  readonly targetDeviceId: string;
  readonly disposition: TerminalDisposition;
}

export class RemoteLocalTurnStore {
  static readonly persistedFields = Object.freeze(receiptFields);
  static readonly relayProhibitions = Object.freeze([
    'plaintext', 'prompt', 'output', 'event', 'terminal_reference', 'ciphertext', 'credential', 'url',
  ] as const);

  private readonly terminalRetryPolicy: Required<Pick<TerminalRetryPolicy, 'attempts' | 'maxDelayMs'>> & Pick<TerminalRetryPolicy, 'sleep' | 'random'>;

  constructor(private readonly cas: Cas, options: { terminalRetryPolicy?: TerminalRetryPolicy } = {}) {
    if (!cas || typeof cas !== 'object' || typeof cas.getDocument !== 'function'
      || typeof cas.createDocument !== 'function' || typeof cas.updateDocument !== 'function') {
      throw new Error('RemoteLocalTurnStore requires CAS');
    }
    const policy = options.terminalRetryPolicy ?? {};
    this.terminalRetryPolicy = {
      attempts: Number.isSafeInteger(policy.attempts) && policy.attempts! >= 0 ? policy.attempts! : DEFAULT_TERMINAL_RETRY_POLICY.attempts,
      maxDelayMs: Number.isSafeInteger(policy.maxDelayMs) && policy.maxDelayMs! >= 0 ? policy.maxDelayMs! : DEFAULT_TERMINAL_RETRY_POLICY.maxDelayMs,
      sleep: policy.sleep,
      random: policy.random,
    };
  }

  async accept(input: ReceiptInput & { now?: string }): Promise<RemoteLocalTurnReceiptResult> {
    const request = snapshotInput(input);
    if (!request) return { status: 'unavailable' };
    const commandId = commandIdFor(request);
    const key = documentKey(request, commandId);
    const suppliedNow = snapshotOptionalNow(input);
    if (suppliedNow === null) return { status: 'unavailable' };
    const now = suppliedNow ?? new Date().toISOString();
    if (!validTimestamp(now)) return { status: 'unavailable' };
    const receipt: Receipt = { schemaVersion: SCHEMA_VERSION, commandId, ...request, disposition: 'accepted', createdAt: now, updatedAt: now, redactedOutcome: null };
    try {
      const created = await this.cas.createDocument({ collection: COLLECTION, document_key: key, data: receipt, metadata: {} });
      if (created.ok) return sameReceipt(created.document.data, receipt) ? { status: 'accepted', commandId, disposition: 'accepted' } : { status: 'unavailable' };
      return this.reconcileExisting(created.current?.data, receipt);
    } catch {
      return this.reconcileAfterUncertainCreate(key, receipt);
    }
  }

  /** Complete a command with a bounded non-content outcome. Terminal states never change. */
  async terminalize(input: ReceiptInput & { disposition: TerminalDisposition; now?: string }): Promise<RemoteLocalTurnStatusResult> {
    return this.retryTerminalSettlement(() => this.terminalizeOnce(input));
  }

  private async terminalizeOnce(input: ReceiptInput & { disposition: TerminalDisposition; now?: string }): Promise<RemoteLocalTurnStatusResult> {
    const request = snapshotInput(input);
    const disposition = snapshotTerminalDisposition(input);
    const suppliedNow = snapshotOptionalNow(input);
    if (!request || !isTerminalDisposition(disposition) || suppliedNow === null) return { status: 'unavailable' };
    const now = suppliedNow ?? new Date().toISOString();
    if (!validTimestamp(now)) return { status: 'unavailable' };
    const key = documentKey(request, commandIdFor(request));
    let read: CasGetResult;
    try { read = await this.cas.getDocument(COLLECTION, key); } catch (error) {
      if (terminalRetryDelay(error, this.terminalRetryPolicy) !== null) throw error;
      return { status: 'unavailable' };
    }
    if (!read.ok) return { status: 'unavailable' };
    const current = parseReceipt(read.document.data);
    if (!current || !sameIdentity(current, request) || current.requestDigest !== request.requestDigest || current.commandId !== commandIdFor(request)) return { status: 'conflict' };
    if (isTerminalDisposition(current.disposition)) {
      return current.disposition === disposition ? { status: 'idempotent', commandId: current.commandId, disposition } : { status: 'conflict' };
    }
    const next: TerminalReceipt = { ...current, disposition, redactedOutcome: disposition, updatedAt: now };
    try {
      const updated = await this.cas.updateDocument(COLLECTION, key, { _rev: read.document._rev, data: next, metadata: {} });
      if (updated.ok) return sameReceipt(updated.document.data, next) ? { status: 'updated', commandId: next.commandId, disposition } : { status: 'unavailable' };
      return this.reconcileTerminal('current' in updated ? updated.current?.data : undefined, next);
    } catch (error) {
      if (terminalRetryDelay(error, this.terminalRetryPolicy) !== null) throw error;
      return this.reconcileUncertainTerminal(key, read.document._rev, next);
    }
  }

  /** Records the ingress boundary before connector delivery; it never carries request content. */
  async markInProgress(input: ReceiptInput & { now?: string }): Promise<RemoteLocalTurnProgressResult> {
    const request = snapshotInput(input);
    const suppliedNow = snapshotOptionalNow(input);
    if (!request || suppliedNow === null) return { status: 'unavailable' };
    const now = suppliedNow ?? new Date().toISOString();
    if (!validTimestamp(now)) return { status: 'unavailable' };
    const commandId = commandIdFor(request);
    const key = documentKey(request, commandId);
    let read: CasGetResult;
    try { read = await this.cas.getDocument(COLLECTION, key); } catch { return { status: 'unavailable' }; }
    if (!read.ok) return { status: 'unavailable' };
    const current = parseReceipt(read.document.data);
    if (!current || !sameIdentity(current, request) || current.requestDigest !== request.requestDigest || current.commandId !== commandId) return { status: 'conflict' };
    if (current.disposition === 'in_progress') return { status: 'idempotent', commandId, disposition: 'in_progress' };
    if (isTerminalDisposition(current.disposition)) return { status: 'conflict' };
    const next: Receipt = { ...current, disposition: 'in_progress', updatedAt: now };
    try {
      const updated = await this.cas.updateDocument(COLLECTION, key, { _rev: read.document._rev, data: next, metadata: {} });
      if (updated.ok) return sameReceipt(updated.document.data, next) ? { status: 'updated', commandId, disposition: 'in_progress' } : { status: 'unavailable' };
      return this.reconcileProgress('current' in updated ? updated.current?.data : undefined, next);
    } catch {
      return this.reconcileUncertainProgress(key, read.document._rev, next);
    }
  }

  /** Reads only the receipt's bounded disposition after the caller has derived durable scope. */
  async status(input: Omit<Scope, 'sessionHandle'> & { commandId: string }): Promise<RemoteLocalTurnLookupResult> {
    const scope = snapshotScope(input);
    const commandId = snapshotCommandId(input);
    if (!scope || !commandId) return { status: 'unavailable' };
    try {
      const read = await this.cas.getDocument(COLLECTION, documentKey(scope, commandId));
      if (!read.ok) return { status: 'not_found' };
      const receipt = parseReceipt(read.document.data);
      return receipt && sameScope(receipt, scope) && receipt.commandId === commandId
        ? { status: 'found', commandId, disposition: receipt.disposition }
        : { status: 'unavailable' };
    } catch { return { status: 'unavailable' }; }
  }

  /** Settles a known command from its trusted connector terminal receipt. */
  async terminalizeCommand(input: Omit<Scope, 'sessionHandle'> & { commandId: string; disposition: TerminalDisposition; now?: string }): Promise<RemoteLocalTurnStatusResult> {
    const scope = snapshotScope(input); const commandId = snapshotCommandId(input);
    if (!scope || !commandId || !isTerminalDisposition(input.disposition)) return { status: 'unavailable' };
    return this.retryTerminalSettlement(async () => {
      let read: CasGetResult;
      try { read = await this.cas.getDocument(COLLECTION, documentKey(scope, commandId)); } catch (error) {
        if (terminalRetryDelay(error, this.terminalRetryPolicy) !== null) throw error;
        return { status: 'unavailable' };
      }
      if (!read.ok) return { status: 'unavailable' };
      const receipt = parseReceipt(read.document.data);
      if (!receipt || !sameScope(receipt, scope) || receipt.commandId !== commandId) return { status: 'conflict' };
      return this.terminalize({ ...receipt, disposition: input.disposition, now: input.now });
    });
  }

  private reconcileExisting(value: unknown, intended: Receipt): RemoteLocalTurnReceiptResult {
    const current = parseReceipt(value);
    if (!current) return { status: 'unavailable' };
    return sameIdentity(current, intended) && current.commandId === intended.commandId && current.requestDigest === intended.requestDigest
      ? { status: 'replay', commandId: current.commandId, disposition: current.disposition }
      : { status: 'conflict' };
  }

  private async reconcileAfterUncertainCreate(key: string, intended: Receipt): Promise<RemoteLocalTurnReceiptResult> {
    try {
      const read = await this.cas.getDocument(COLLECTION, key);
      return read.ok ? this.reconcileExisting(read.document.data, intended) : { status: 'unavailable' };
    } catch { return { status: 'unavailable' }; }
  }

  private reconcileTerminal(value: unknown, intended: TerminalReceipt): RemoteLocalTurnStatusResult {
    const current = parseReceipt(value);
    if (!current || !sameIdentity(current, intended) || current.requestDigest !== intended.requestDigest || current.commandId !== intended.commandId) return { status: 'conflict' };
    return current.disposition === intended.disposition && current.redactedOutcome === intended.redactedOutcome
      ? { status: 'idempotent', commandId: current.commandId, disposition: intended.disposition }
      : { status: 'conflict' };
  }

  private reconcileProgress(value: unknown, intended: Receipt): RemoteLocalTurnProgressResult {
    const current = parseReceipt(value);
    if (!current || !sameIdentity(current, intended) || current.requestDigest !== intended.requestDigest || current.commandId !== intended.commandId) return { status: 'conflict' };
    return current.disposition === 'in_progress'
      ? { status: 'idempotent', commandId: current.commandId, disposition: 'in_progress' }
      : { status: 'conflict' };
  }

  private async reconcileUncertainTerminal(key: string, previousRevision: string, intended: TerminalReceipt): Promise<RemoteLocalTurnStatusResult> {
    try {
      const read = await this.cas.getDocument(COLLECTION, key);
      if (!read.ok || read.document._rev === previousRevision) return { status: 'unavailable' };
      const current = parseReceipt(read.document.data);
      return current && sameReceipt(current, intended)
        ? { status: 'idempotent', commandId: intended.commandId, disposition: intended.disposition }
        : { status: 'conflict' };
    } catch (error) {
      if (terminalRetryDelay(error, this.terminalRetryPolicy) !== null) throw error;
      return { status: 'unavailable' };
    }
  }

  /** A 429 is a known-uncommitted request. Retry by re-reading, never by replaying a stale CAS write. */
  private async retryTerminalSettlement<T extends RemoteLocalTurnStatusResult>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        const delayMs = attempt < this.terminalRetryPolicy.attempts ? terminalRetryDelay(error, this.terminalRetryPolicy) : null;
        if (delayMs === null) return { status: 'unavailable' } as T;
        await (this.terminalRetryPolicy.sleep ?? sleep)(delayMs);
      }
    }
  }

  private async reconcileUncertainProgress(key: string, previousRevision: string, intended: Receipt): Promise<RemoteLocalTurnProgressResult> {
    try {
      const read = await this.cas.getDocument(COLLECTION, key);
      if (!read.ok || read.document._rev === previousRevision) return { status: 'unavailable' };
      const current = parseReceipt(read.document.data);
      return current && sameReceipt(current, intended)
        ? { status: 'idempotent', commandId: intended.commandId, disposition: 'in_progress' }
        : { status: 'conflict' };
    } catch { return { status: 'unavailable' }; }
  }
}

/** Converts the authorized fence projection into the receipt store's closed scope. */
export function createRemoteLocalConnectorTerminalizer(store: RemoteLocalTurnStore): (input: {
  scope: RemoteLocalOwnerOperationScope;
  commandId: string;
  disposition: 'completed' | 'interrupted' | 'indeterminate';
}) => Promise<void> {
  return async ({ scope, commandId, disposition }) => {
    const result = await store.terminalizeCommand({
      tenantId: scope.tenantId, ownerPrincipalId: scope.ownerPrincipalId, consumerId: scope.consumerId, credentialId: scope.credentialId, brainId: scope.brainId,
      deviceId: scope.deviceId, fenceRevision: scope.fence.capabilitiesRevision, commandId, disposition,
    });
    if (result.status !== 'updated' && result.status !== 'idempotent') {
      throw new Error(`Unable to terminalize remote-local command: ${result.status}`);
    }
  };
}

function documentKey(scope: Pick<Scope, 'tenantId' | 'ownerPrincipalId' | 'consumerId' | 'brainId' | 'deviceId' | 'fenceRevision'>, commandId: string): string { return `turn:v2:${scopeHash(scope)}:${commandId}`; }
function commandIdFor(input: ReceiptInput): string { return `rlc_${hash('command-id:v2', input)}`; }
function scopeHash(input: Pick<Scope, 'tenantId' | 'ownerPrincipalId' | 'consumerId' | 'brainId' | 'deviceId' | 'fenceRevision'>): string {
  const encoded = ['receipt-scope:v2', input.tenantId, input.ownerPrincipalId, input.consumerId, input.brainId, input.deviceId, input.fenceRevision]
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
  return createHash('sha256').update(encoded).digest('base64url');
}
function hash(domain: string, input: ReceiptInput): string {
  const encoded = [domain, input.tenantId, input.ownerPrincipalId, input.consumerId, input.brainId, input.deviceId, input.sessionHandle, input.fenceRevision, input.idempotencyKey]
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
  return createHash('sha256').update(encoded).digest('base64url');
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>): boolean { const actual = Object.keys(value).sort(); const expected = [...receiptFields].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function validOpaque(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value); }
function validDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value); }
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function isDisposition(value: unknown): value is Disposition { return typeof value === 'string' && (dispositions as readonly string[]).includes(value); }
function isTerminalDisposition(value: unknown): value is TerminalDisposition { return typeof value === 'string' && (terminalDispositions as readonly string[]).includes(value); }
function snapshotInput(value: unknown): ReceiptInput | null {
  if (!isObject(value) || !Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor)) return null;
  const candidate = { tenantId: value.tenantId, ownerPrincipalId: value.ownerPrincipalId, consumerId: value.consumerId, credentialId: value.credentialId, brainId: value.brainId, deviceId: value.deviceId,
    sessionHandle: value.sessionHandle, fenceRevision: value.fenceRevision, idempotencyKey: value.idempotencyKey, requestDigest: value.requestDigest };
  return Object.values(candidate).slice(0, -1).every(validOpaque) && validDigest(candidate.requestDigest) ? candidate as ReceiptInput : null;
}
function snapshotScope(value: unknown): Omit<Scope, 'sessionHandle'> | null {
  if (!isObject(value) || !Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor)) return null;
  const candidate = { tenantId: value.tenantId, ownerPrincipalId: value.ownerPrincipalId, consumerId: value.consumerId, credentialId: value.credentialId, brainId: value.brainId, deviceId: value.deviceId, fenceRevision: value.fenceRevision };
  return Object.values(candidate).every(validOpaque) ? candidate as Omit<Scope, 'sessionHandle'> : null;
}
function snapshotCommandId(value: unknown): string | null {
  if (!isObject(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'commandId');
  return descriptor && 'value' in descriptor && /^rlc_[A-Za-z0-9_-]{43}$/.test(String(descriptor.value)) ? descriptor.value as string : null;
}
function snapshotOptionalNow(value: unknown): string | undefined | null {
  if (!isObject(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'now');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) return null;
  return descriptor.value === undefined || validTimestamp(descriptor.value) ? descriptor.value : null;
}
function snapshotTerminalDisposition(value: unknown): TerminalDisposition | null {
  if (!isObject(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'disposition');
  return descriptor && 'value' in descriptor && isTerminalDisposition(descriptor.value) ? descriptor.value : null;
}
function parseReceipt(value: unknown): Receipt | null {
  if (!isObject(value) || !exactKeys(value) || value.schemaVersion !== SCHEMA_VERSION || !snapshotInput(value)
    || !/^rlc_[A-Za-z0-9_-]{43}$/.test(String(value.commandId)) || !isDisposition(value.disposition)
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)
    || !(value.redactedOutcome === null || isTerminalDisposition(value.redactedOutcome))) return null;
  if ((isTerminalDisposition(value.disposition) && value.redactedOutcome !== value.disposition)
    || (!isTerminalDisposition(value.disposition) && value.redactedOutcome !== null)) return null;
  return value as Receipt;
}
function sameIdentity(left: ReceiptInput, right: ReceiptInput): boolean {
  return left.tenantId === right.tenantId && left.ownerPrincipalId === right.ownerPrincipalId && left.consumerId === right.consumerId && left.brainId === right.brainId
    && left.deviceId === right.deviceId && left.sessionHandle === right.sessionHandle && left.fenceRevision === right.fenceRevision
    && left.idempotencyKey === right.idempotencyKey;
}
function sameScope(left: Omit<Scope, 'sessionHandle'>, right: Omit<Scope, 'sessionHandle'>): boolean {
  return left.tenantId === right.tenantId && left.ownerPrincipalId === right.ownerPrincipalId && left.consumerId === right.consumerId && left.brainId === right.brainId
    && left.deviceId === right.deviceId && left.fenceRevision === right.fenceRevision;
}
function sameReceipt(left: unknown, right: Receipt): boolean {
  const parsed = parseReceipt(left);
  return parsed !== null && receiptFields.every((field) => parsed[field] === right[field]);
}

function terminalRetryDelay(error: unknown, policy: Required<Pick<TerminalRetryPolicy, 'attempts' | 'maxDelayMs'>> & Pick<TerminalRetryPolicy, 'random'>): number | null {
  if (!(error instanceof StorageSdkError) || error.status !== 429 || !Number.isSafeInteger(error.retryAfterMs)
    || error.retryAfterMs === undefined || error.retryAfterMs < 0 || error.retryAfterMs > policy.maxDelayMs) return null;
  const headroom = policy.maxDelayMs - error.retryAfterMs;
  const jitterCeiling = Math.min(headroom, 1_000, Math.ceil(error.retryAfterMs / 10));
  return error.retryAfterMs + Math.floor((policy.random ?? Math.random)() * Math.max(1, jitterCeiling));
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
