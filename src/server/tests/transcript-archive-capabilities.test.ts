import { describe, expect, test } from 'bun:test';
import { unknownArchiveCapabilities, validateArchiveCapabilities } from '../lib/transcript-archive-capabilities';

describe('archive storage capabilities', () => {
  test('unknown adapter evidence fails closed and never authorizes eviction', () => {
    const report = unknownArchiveCapabilities('mech_storage_r2', '2026-07-20T00:00:00.000Z');
    expect(validateArchiveCapabilities(report)).toEqual(report);
    expect(report).toMatchObject({ durabilityClass: 'unknown', evictionEligible: false });
    expect(report.blockedReasons).toContain('replication_unknown');
    expect(() => unknownArchiveCapabilities('adapter with spaces', '2026-07-20T00:00:00.000Z'))
      .toThrow(/identifier is invalid/);
  });

  test('claims cannot outrun evidence or manufacture eviction eligibility', () => {
    const report = unknownArchiveCapabilities('test_adapter', '2026-07-20T00:00:00.000Z');
    expect(() => validateArchiveCapabilities({ ...report, durabilityClass: 'versioned_replicated' })).toThrow(/not supported/);
    expect(() => validateArchiveCapabilities({ ...report, evictionEligible: true })).toThrow(/cannot authorize eviction/);
    expect(() => validateArchiveCapabilities({ ...report, objectVersioning: { state: 'confirmed', evidence: null } }))
      .toThrow(/requires evidence/);
  });

  test('a stale observation cannot satisfy a fresh capability probe', () => {
    const stale = unknownArchiveCapabilities('test_adapter', '2026-07-19T23:59:00.000Z');
    expect(() => validateArchiveCapabilities(stale, '2026-07-20T00:00:00.000Z')).toThrow(/stale/);
  });

  test('one failure domain cannot claim replicated durability', () => {
    const report = unknownArchiveCapabilities('single_domain_adapter', '2026-07-20T00:00:00.000Z');
    const overstated = {
      ...report,
      objectVersioning: { state: 'confirmed' as const, evidence: 'provider_version_id_readback' },
      replication: { state: 'confirmed' as const, evidence: 'single_domain_report', confirmedFailureDomains: 1 },
      metadataRecovery: { state: 'confirmed' as const, evidence: 'catalog_restore_drill' },
      durabilityClass: 'versioned_replicated' as const,
    };
    expect(() => validateArchiveCapabilities(overstated)).toThrow(/not supported/);
  });

  test('two-domain replication derives a class but remains blocked on later evidence gates', () => {
    const report = unknownArchiveCapabilities('qualified_test_adapter', '2026-07-20T00:00:00.000Z');
    const qualified = {
      ...report,
      objectVersioning: { state: 'confirmed' as const, evidence: 'provider_version_id_readback' },
      replication: { state: 'confirmed' as const, evidence: 'provider_replication_report', confirmedFailureDomains: 2 },
      metadataRecovery: { state: 'confirmed' as const, evidence: 'independent_catalog_restore_drill' },
      durabilityClass: 'versioned_replicated' as const,
    };
    expect(validateArchiveCapabilities(qualified)).toMatchObject({ durabilityClass: 'versioned_replicated', evictionEligible: false });
  });

  test('explicit eviction eligibility requires committed-archive proof but not unsupported temporary-part GC', () => {
    const report = unknownArchiveCapabilities('qualified_eviction_adapter', '2026-07-20T00:00:00.000Z');
    const confirmed = (evidence: string) => ({ state: 'confirmed' as const, evidence });
    const qualified = {
      ...report,
      objectVersioning: confirmed('provider_version_id_readback'),
      replication: { ...confirmed('provider_replication_report'), confirmedFailureDomains: 2 },
      checksum: confirmed('provider_checksum_readback'),
      metadataRecovery: confirmed('independent_catalog_restore_drill'),
      retentionPolicy: confirmed('effective_retention_policy'),
      disasterRecovery: confirmed('production_restore_drill'),
      exportPolicy: confirmed('account_export_contract'),
      tenantEncryption: confirmed('tenant_encryption_attestation'),
      durabilityClass: 'versioned_replicated' as const,
      evictionEligible: true,
      blockedReasons: [],
    };
    expect(validateArchiveCapabilities(qualified)).toMatchObject({
      durabilityClass: 'versioned_replicated', evictionEligible: true, blockedReasons: [],
      temporaryObjectDeletion: { state: 'unsupported' },
    });
    expect(() => validateArchiveCapabilities({
      ...qualified, retentionPolicy: report.retentionPolicy,
    })).toThrow(/cannot authorize eviction/);
  });

  test('replication without independently recoverable metadata cannot claim the replicated class', () => {
    const report = unknownArchiveCapabilities('partial_test_adapter', '2026-07-20T00:00:00.000Z');
    const unsupported = {
      ...report,
      objectVersioning: { state: 'confirmed' as const, evidence: 'version_readback' },
      replication: { state: 'confirmed' as const, evidence: 'two_domain_report', confirmedFailureDomains: 2 },
      durabilityClass: 'versioned_replicated' as const,
    };
    expect(() => validateArchiveCapabilities(unsupported)).toThrow(/not supported/);
  });
});
