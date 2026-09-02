import { ARCHIVE_ADAPTER_PATTERN } from '../../../lib/transcript-archive/capability-validation.js';

export type ArchiveCapabilityState = 'confirmed' | 'unsupported' | 'unknown';

export interface ArchiveCapabilityEvidence {
  state: ArchiveCapabilityState;
  evidence: string | null;
}

export interface ArchiveStorageCapabilities {
  schemaVersion: 1;
  adapter: string;
  observedAt: string;
  objectVersioning: ArchiveCapabilityEvidence;
  replication: ArchiveCapabilityEvidence & { confirmedFailureDomains: number | null };
  checksum: ArchiveCapabilityEvidence;
  metadataRecovery: ArchiveCapabilityEvidence;
  retentionPolicy: ArchiveCapabilityEvidence;
  temporaryObjectDeletion: ArchiveCapabilityEvidence;
  disasterRecovery: ArchiveCapabilityEvidence;
  exportPolicy: ArchiveCapabilityEvidence;
  tenantEncryption: ArchiveCapabilityEvidence;
  durabilityClass: 'unknown' | 'single_region_versioned' | 'versioned_replicated';
  evictionEligible: boolean;
  blockedReasons: string[];
}

const SAFE_EVIDENCE = /^[A-Za-z0-9][A-Za-z0-9._:@+\-= /]*$/;
const CAPABILITY_NAMES = [
  'objectVersioning', 'replication', 'checksum', 'metadataRecovery', 'retentionPolicy', 'temporaryObjectDeletion',
  'disasterRecovery', 'exportPolicy', 'tenantEncryption',
] as const;

function evidence(state: ArchiveCapabilityState, value: string | null): ArchiveCapabilityEvidence {
  if (!['confirmed', 'unsupported', 'unknown'].includes(state)) throw new Error('Archive capability state is invalid');
  if (value !== null && (value.length > 256 || !SAFE_EVIDENCE.test(value))) throw new Error('Archive capability evidence is invalid');
  if (state === 'confirmed' && !value) throw new Error('Confirmed archive capability requires evidence');
  return { state, evidence: value };
}

export function unknownArchiveCapabilities(adapter: string, observedAt: string): ArchiveStorageCapabilities {
  if (!ARCHIVE_ADAPTER_PATTERN.test(adapter)) throw new Error('Archive adapter identifier is invalid');
  if (!Number.isFinite(new Date(observedAt).getTime())) throw new Error('Archive capability observation time is invalid');
  return {
    schemaVersion: 1,
    adapter,
    observedAt,
    objectVersioning: evidence('unknown', null),
    replication: { ...evidence('unknown', null), confirmedFailureDomains: null },
    checksum: evidence('unknown', null),
    metadataRecovery: evidence('unknown', null),
    retentionPolicy: evidence('unknown', null),
    temporaryObjectDeletion: evidence('unsupported', 'adapter_has_no_object_delete_operation'),
    disasterRecovery: evidence('unknown', null),
    exportPolicy: evidence('unknown', null),
    tenantEncryption: evidence('unknown', null),
    durabilityClass: 'unknown',
    evictionEligible: false,
    blockedReasons: [
      'object_versioning_unknown', 'replication_unknown', 'checksum_unknown', 'metadata_recovery_unknown',
      'retention_policy_unknown', 'temporary_object_deletion_unsupported', 'disaster_recovery_unknown',
      'export_policy_unknown', 'tenant_encryption_unknown',
    ],
  };
}

export function validateArchiveCapabilities(input: unknown, expectedObservedAt?: string): ArchiveStorageCapabilities {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error('Archive capability report must be a plain object');
  }
  const value = input as Record<string, unknown>;
  const exact = new Set(['schemaVersion', 'adapter', 'observedAt', ...CAPABILITY_NAMES, 'durabilityClass', 'evictionEligible', 'blockedReasons']);
  if (Object.keys(value).some((key) => !exact.has(key)) || Object.keys(value).length !== exact.size) {
    throw new Error('Archive capability report has an invalid field set');
  }
  if (value.schemaVersion !== 1 || typeof value.adapter !== 'string' || typeof value.observedAt !== 'string') {
    throw new Error('Archive capability report identity is invalid');
  }
  if (expectedObservedAt !== undefined && value.observedAt !== expectedObservedAt) {
    throw new Error('Archive capability report is stale or belongs to another probe');
  }
  const result = unknownArchiveCapabilities(value.adapter, value.observedAt);
  for (const name of CAPABILITY_NAMES) {
    const item = value[name];
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new Error(`Archive capability ${name} is invalid`);
    }
    const raw = item as Record<string, unknown>;
    const expected = name === 'replication' ? ['state', 'evidence', 'confirmedFailureDomains'] : ['state', 'evidence'];
    if (Object.keys(raw).length !== expected.length || Object.keys(raw).some((key) => !expected.includes(key))) {
      throw new Error(`Archive capability ${name} has an invalid field set`);
    }
    const normalized = evidence(raw.state as ArchiveCapabilityState, raw.evidence as string | null);
    if (name === 'replication') {
      const domains = raw.confirmedFailureDomains;
      if (domains !== null && (!Number.isSafeInteger(domains) || (domains as number) < 1)) throw new Error('Replication failure-domain evidence is invalid');
      result.replication = { ...normalized, confirmedFailureDomains: domains as number | null };
    } else {
      result[name] = normalized as never;
    }
  }
  if (!Array.isArray(value.blockedReasons) || value.blockedReasons.some((reason) => typeof reason !== 'string' || !SAFE_EVIDENCE.test(reason))) {
    throw new Error('Archive capability blocked reasons are invalid');
  }
  const versioned = result.objectVersioning.state === 'confirmed';
  const replicated = result.replication.state === 'confirmed' && (result.replication.confirmedFailureDomains ?? 0) >= 2;
  const recoverableMetadata = result.metadataRecovery.state === 'confirmed';
  const derivedClass = versioned && replicated && recoverableMetadata
    ? 'versioned_replicated' : versioned ? 'single_region_versioned' : 'unknown';
  if (value.durabilityClass !== derivedClass) throw new Error('Archive durability class is not supported by capability evidence');
  if (typeof value.evictionEligible !== 'boolean') throw new Error('Archive eviction eligibility must be boolean');
  const evictionEvidenceConfirmed = versioned && replicated && recoverableMetadata
    && result.checksum.state === 'confirmed'
    && result.retentionPolicy.state === 'confirmed'
    && result.disasterRecovery.state === 'confirmed'
    && result.exportPolicy.state === 'confirmed'
    && result.tenantEncryption.state === 'confirmed'
    && value.blockedReasons.length === 0;
  // temporaryObjectDeletion is remote hygiene for uncommitted upload parts,
  // not proof that a committed generation can replace a local transcript.
  // It remains visible in the report and may block remote GC, but cannot grant
  // or revoke local eviction authority.
  // The adapter must opt in explicitly, and that signal cannot outrun the
  // independently validated durability, recovery, retention, and export proof.
  // A fully qualified adapter may still report false as a rollout hold.
  if (value.evictionEligible && !evictionEvidenceConfirmed) {
    throw new Error('Archive capability evidence cannot authorize eviction');
  }
  return {
    ...result,
    durabilityClass: derivedClass,
    evictionEligible: value.evictionEligible,
    blockedReasons: [...value.blockedReasons],
  };
}
