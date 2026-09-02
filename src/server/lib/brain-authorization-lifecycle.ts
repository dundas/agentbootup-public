/**
 * Default-off authorization lifecycle semantics (PRD-0052k Task 1.0.1.2).
 *
 * This is an in-memory transition model, deliberately not a persistence or
 * authorization service. It names the records and monotonic state changes the
 * selected serializable authority must later commit atomically. In particular,
 * it has no endpoint, grant, host/device field, key material, enrollment, or
 * allow decision.
 */

export type BrainAuthorizationPrincipalStatus = 'active' | 'revoked';
export type BrainAuthorizationOwnerStatus = 'active' | 'revoked' | 'unassigned';
const SCHEMA_VERSION = 1;

export interface BrainAuthorizationAdministrator {
  principalId: string;
  status: BrainAuthorizationPrincipalStatus;
}

/** A generic principal only; it cannot describe an enrolled host or client credential. */
export interface AbstractNonLocalPrincipal {
  principalId: string;
  tenantId: string;
  status: BrainAuthorizationPrincipalStatus;
  credentialRevision: number;
}

export interface BrainAuthorizationLifecycleRecord {
  schemaVersion: 1;
  brainId: string;
  ownerPrincipalId: string | null;
  ownerStatus: BrainAuthorizationOwnerStatus;
  administrators: readonly BrainAuthorizationAdministrator[];
  principals: readonly AbstractNonLocalPrincipal[];
  fencingEpoch: number;
  credentialRevision: number;
}

export type BrainAuthorizationLifecycleEvent =
  | { kind: 'administrator_added'; principalId: string }
  | { kind: 'administrator_removed'; principalId: string }
  | { kind: 'principal_registered'; principalId: string; tenantId: string }
  | { kind: 'principal_revoked'; principalId: string }
  | { kind: 'owner_revoked' };

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sortedUnique<T extends { principalId: string }>(records: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const record of records) {
    if (!validIdentifier(record.principalId)) throw new Error('Principal identifier is invalid.');
    unique.set(record.principalId, record);
  }
  return [...unique.values()].sort((left, right) => left.principalId.localeCompare(right.principalId));
}

function assertRecord(record: BrainAuthorizationLifecycleRecord): void {
  if (record.schemaVersion !== SCHEMA_VERSION
    || !validIdentifier(record.brainId)
    || !validRevision(record.fencingEpoch)
    || !validRevision(record.credentialRevision)
    || (record.ownerPrincipalId !== null && !validIdentifier(record.ownerPrincipalId))
    || (record.ownerStatus === 'unassigned') !== (record.ownerPrincipalId === null)
    || !['active', 'revoked', 'unassigned'].includes(record.ownerStatus)
    || !record.administrators.every((administrator) => validIdentifier(administrator.principalId) && ['active', 'revoked'].includes(administrator.status))
    || !record.principals.every((principal) => validIdentifier(principal.principalId)
      && validIdentifier(principal.tenantId)
      && validRevision(principal.credentialRevision)
      && ['active', 'revoked'].includes(principal.status))) {
    throw new Error('Brain authorization lifecycle record is invalid.');
  }
}

function advance(record: BrainAuthorizationLifecycleRecord): Pick<BrainAuthorizationLifecycleRecord, 'fencingEpoch' | 'credentialRevision'> {
  return { fencingEpoch: record.fencingEpoch + 1, credentialRevision: record.credentialRevision + 1 };
}

/** Creates an owner record; it remains non-authorizing until the later cutover. */
export function createBrainAuthorizationLifecycleRecord(input: {
  brainId: string;
  ownerPrincipalId?: string | null;
  administrators?: readonly BrainAuthorizationAdministrator[];
  principals?: readonly AbstractNonLocalPrincipal[];
}): BrainAuthorizationLifecycleRecord {
  const ownerPrincipalId = input.ownerPrincipalId ?? null;
  const record: BrainAuthorizationLifecycleRecord = {
    schemaVersion: SCHEMA_VERSION,
    brainId: input.brainId,
    ownerPrincipalId,
    ownerStatus: ownerPrincipalId === null ? 'unassigned' : 'active',
    administrators: sortedUnique(input.administrators ?? []).map((administrator) => ({ ...administrator })),
    principals: sortedUnique(input.principals ?? []).map((principal) => ({ ...principal })),
    fencingEpoch: 0,
    credentialRevision: 0,
  };
  assertRecord(record);
  return record;
}

/**
 * Applies only lifecycle vocabulary. There is intentionally no transfer,
 * deletion, client registration, host enrollment, or authorization outcome.
 * Repeat revocations are idempotent and do not advance the fence again.
 */
export function applyBrainAuthorizationLifecycleEvent(
  record: BrainAuthorizationLifecycleRecord,
  event: BrainAuthorizationLifecycleEvent,
): BrainAuthorizationLifecycleRecord {
  assertRecord(record);
  switch (event.kind) {
    case 'administrator_added': {
      if (!validIdentifier(event.principalId)) throw new Error('Principal identifier is invalid.');
      const existing = record.administrators.find((administrator) => administrator.principalId === event.principalId);
      // Removed administrator IDs are never silently reactivated. A future
      // authority may define an explicit replacement ceremony, not this model.
      if (existing) return record;
      const administrators = sortedUnique([
        ...record.administrators.filter((administrator) => administrator.principalId !== event.principalId),
        { principalId: event.principalId, status: 'active' as const },
      ]);
      return { ...record, administrators };
    }
    case 'administrator_removed': {
      if (!validIdentifier(event.principalId)) throw new Error('Principal identifier is invalid.');
      const existing = record.administrators.find((administrator) => administrator.principalId === event.principalId);
      if (!existing || existing.status === 'revoked') return record;
      const administrators = sortedUnique(record.administrators.map((administrator) => administrator.principalId === event.principalId
        ? { ...administrator, status: 'revoked' as const }
        : administrator));
      return { ...record, administrators };
    }
    case 'principal_registered': {
      if (!validIdentifier(event.principalId) || !validIdentifier(event.tenantId)) throw new Error('Principal identifier is invalid.');
      const existing = record.principals.find((principal) => principal.principalId === event.principalId);
      if (existing?.status === 'active' && existing.tenantId === event.tenantId) return record;
      // A revoked principal identifier is never silently reactivated. Recovery
      // requires a new abstract principal ID in the future authority.
      if (existing?.status === 'revoked') return record;
      if (existing) throw new Error('Principal tenant is immutable.');
      const principals = sortedUnique([
        ...record.principals.filter((principal) => principal.principalId !== event.principalId),
        { principalId: event.principalId, tenantId: event.tenantId, status: 'active' as const, credentialRevision: 0 },
      ]);
      return { ...record, principals };
    }
    case 'principal_revoked': {
      if (!validIdentifier(event.principalId)) throw new Error('Principal identifier is invalid.');
      const existing = record.principals.find((principal) => principal.principalId === event.principalId);
      if (!existing || existing.status === 'revoked') return record;
      const principals = sortedUnique(record.principals.map((principal) => principal.principalId === event.principalId
        ? { ...principal, status: 'revoked' as const, credentialRevision: principal.credentialRevision + 1 }
        : principal));
      return { ...record, principals, ...advance(record) };
    }
    case 'owner_revoked': {
      if (record.ownerStatus !== 'active') return record;
      const principals = record.ownerPrincipalId === null ? record.principals : sortedUnique(record.principals.map((principal) => principal.principalId === record.ownerPrincipalId
        ? { ...principal, status: 'revoked' as const, credentialRevision: principal.credentialRevision + 1 }
        : principal));
      return { ...record, ownerStatus: 'revoked', principals, ...advance(record) };
    }
  }
}

/** Administrators may administer records, never message/content/replay or impersonate an owner. */
export function canAdministerBrainAuthorizationRecord(record: BrainAuthorizationLifecycleRecord, principalId: string): boolean {
  assertRecord(record);
  return record.administrators.some((administrator) => administrator.principalId === principalId && administrator.status === 'active');
}

/** This remains explicitly false until the selected authority and cutover are proven. */
export function mayAccessBrainMessaging(): false {
  return false;
}
