import { describe, expect, test } from 'bun:test';
import { verifyProductionArchive } from '../../scripts/verify-transcript-archive-production.mjs';

function response(data: any, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { success: true, data } : data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function report(overrides: Record<string, any> = {}) {
  const confirmed = (evidence: string) => ({ state: 'confirmed', evidence });
  return {
    schemaVersion: 1,
    adapter: 'test_versioned_store',
    observedAt: '2026-07-20T18:00:00.000Z',
    objectVersioning: confirmed('version_id_readback'),
    replication: { ...confirmed('two_domain_confirmation'), confirmedFailureDomains: 2 },
    checksum: confirmed('sha256_readback'),
    metadataRecovery: confirmed('catalog_restore_drill'),
    retentionPolicy: confirmed('retention_policy_v1'),
    temporaryObjectDeletion: { state: 'unsupported', evidence: 'no_delete_operation' },
    disasterRecovery: confirmed('restore_drill_v1'),
    exportPolicy: confirmed('export_policy_v1'),
    tenantEncryption: confirmed('tenant_encryption_v1'),
    durabilityClass: 'versioned_replicated',
    evictionEligible: false,
    blockedReasons: ['phase_4_not_authorized'],
    ...overrides,
  };
}

const base = {
  brainId: 'brain-a',
  serverUrl: 'https://agentbootup.example',
  credentials: { serverUrl: 'https://agentbootup.example', apiKey: 'never-print-this-key' },
  maxAgeSeconds: 300,
  retryLimit: 0,
};
const now = () => new Date('2026-07-20T18:01:00.000Z');

describe('production transcript archive verifier', () => {
  test('passes committed-archive proof while treating unsupported temporary-part GC as non-authoritative', async () => {
    const result = await verifyProductionArchive(base, { now, fetch: async () => response(report({
      adapter: 'qualified@test+v=1',
      evictionEligible: true,
      blockedReasons: [],
    })) });
    expect(result).toMatchObject({ exitCode: 0, evidence: {
      verdict: 'PROCEED', so27: 'PASS', durabilityClass: 'versioned_replicated', evictionEligible: true,
      checks: { independentReplication: true, metadataRecovery: true, evictionAuthorization: true },
      blockedReasons: [],
    } });
  });

  test('fails SO-27 when storage evidence is strong but eviction remains unauthorized', async () => {
    const result = await verifyProductionArchive(base, { now, fetch: async () => response(report()) });
    expect(result).toMatchObject({ exitCode: 7, evidence: {
      verdict: 'PAUSE', so27: 'FAIL', durabilityClass: 'versioned_replicated', evictionEligible: false,
      checks: { independentReplication: true, metadataRecovery: true, evictionAuthorization: false },
    } });
    expect(JSON.stringify(result)).not.toContain('never-print-this-key');
  });

  test('fails closed on unknown production capabilities without leaking a response body', async () => {
    const unknown = report({
      objectVersioning: { state: 'unknown', evidence: null },
      replication: { state: 'unknown', evidence: null, confirmedFailureDomains: null },
      metadataRecovery: { state: 'unknown', evidence: null },
      durabilityClass: 'unknown',
      blockedReasons: ['object_versioning_unknown', 'replication_unknown', 'metadata_recovery_unknown'],
    });
    const result = await verifyProductionArchive(base, { now, fetch: async () => response(unknown) });
    expect(result).toMatchObject({ exitCode: 7, evidence: { verdict: 'PAUSE', so27: 'FAIL',
      checks: { versioning: false, independentReplication: false, metadataRecovery: false } } });
    expect(result.evidence.blockedReasons).toContain('object_versioning_unconfirmed');
    expect(JSON.stringify(result)).not.toContain('object_versioning_unknown');
  });

  test('sanitizes endpoint and authentication failures', async () => {
    const result = await verifyProductionArchive(base, { now, fetch: async () => response({
      error: { code: 'archive_disabled', message: 'secret body must not escape' },
    }, 503) });
    expect(result).toMatchObject({ exitCode: 6, evidence: { verdict: 'PAUSE', so27: 'FAIL',
      failureCode: 'archive_disabled', checks: { capabilityEndpoint: false } } });
    expect(JSON.stringify(result)).not.toContain('secret body must not escape');
    expect(JSON.stringify(result)).not.toContain('never-print-this-key');

    const hostileCode = await verifyProductionArchive(base, { now, fetch: async () => response({
      error: { code: 'secret body must not escape', message: 'another secret body' },
    }, 503) });
    expect(hostileCode.evidence).toMatchObject({ failureCode: 'CAPABILITY_EVIDENCE_INVALID' });
    expect(JSON.stringify(hostileCode)).not.toContain('secret body');

    const missingCredentials = await verifyProductionArchive({
      brainId: 'brain-a', serverUrl: 'https://agentbootup.example',
    }, {
      now, env: {}, inspectCredentials: async () => ({ state: 'missing' }),
    });
    expect(missingCredentials).toMatchObject({ exitCode: 3, evidence: {
      targetOrigin: 'https://agentbootup.example', verdict: 'PAUSE', so27: 'FAIL', failureCode: 'AUTH_ERROR',
      blockedReasons: ['production_credentials_unavailable'],
    } });
  });

  test('rejects stale, malformed, and non-HTTPS evidence targets', async () => {
    const stale = await verifyProductionArchive(base, { now: () => new Date('2026-07-20T19:00:00.000Z'),
      fetch: async () => response(report()) });
    expect(stale.evidence).toMatchObject({ verdict: 'PAUSE', checks: { freshProbe: false } });
    const malformed = await verifyProductionArchive(base, { now, fetch: async () => response({ ...report(), extra: true }) });
    expect(malformed.evidence).toMatchObject({ failureCode: 'CAPABILITY_EVIDENCE_INVALID' });
    await expect(verifyProductionArchive({ ...base, serverUrl: 'http://production.example' }, { now,
      fetch: async () => response(report()) })).rejects.toMatchObject({ code: 'USAGE_ERROR' });
  });
});
