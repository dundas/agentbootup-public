import { describe, expect, test } from 'bun:test';
import matrix from '../../config/runtime-adapter-support-matrix-v1.json';
import { ADAPTER_CONTRACT_VERSION, ADAPTER_OPERATIONS } from '../../lib/runtime-adapters/types.js';
import { defineRuntimeAdapter, createOperationResult } from '../../lib/runtime-adapters/types.js';
import {
  createRuntimeAdapterRegistry,
  validateSupportMatrix,
  verifySupportMatrixEvidence,
} from '../../lib/runtime-adapters/registry.js';
import path from 'node:path';

const requestFor = (lane: any, overrides: Record<string, unknown> = {}) => ({
  runtime_family: lane.runtime_family,
  runtime_version: lane.runtime_version,
  platform: structuredClone(lane.platform),
  adapter_version: lane.adapter.version,
  adapter_name: lane.adapter.name,
  adapter_contract_version: lane.adapter.contract_version,
  provenance: structuredClone(lane.provenance),
  capability_evidence: structuredClone(lane.capabilities),
  ...overrides,
});

const candidateRequestFor = (candidate: any, overrides: Record<string, unknown> = {}) => ({
  runtime_family: candidate.runtime_family,
  runtime_version: candidate.runtime_version,
  platform: { os: candidate.platform.os, os_version: null, architecture: candidate.platform.architecture, runtime: candidate.platform.runtime, runtime_version: null },
  adapter_name: null,
  adapter_version: null,
  adapter_contract_version: ADAPTER_CONTRACT_VERSION,
  provenance: structuredClone(candidate.provenance),
  capability_evidence: null,
  ...overrides,
});

const operationMethods = () => Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, async () => createOperationResult(name, {
  status: name === 'detect' ? 'supported' : 'skipped',
  evidence: [`operation:${name}`],
  ...(name === 'detect' ? {} : { error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Fixture operation.', remediation: 'Use the qualified runtime.' } }),
})]));

const adapterFor = (qualifiedMatrix: any, lane: any, mutate: (source: any) => void = () => {}) => {
  const source: any = {
    contract_version: lane.adapter.contract_version,
    runtime_family: lane.runtime_family,
    adapter_name: lane.adapter.name,
    adapter_version: lane.adapter.version,
    support_matrix: {
      reference: 'config/runtime-adapter-support-matrix-v1.json',
      revision: qualifiedMatrix.revision,
      runtime_version_range: lane.runtime_version,
      adapter_version_range: lane.adapter.version,
      compatible_platforms: [structuredClone(lane.platform)],
    },
    native_probe: {
      executable: lane.runtime_family, native_version: lane.runtime_version,
      subcommands: [], flags: ['--version'], non_destructive: true,
      attestation: { status: 'supported', evidence: structuredClone(lane.evidence) },
    },
    capabilities: structuredClone(lane.capabilities),
    ...operationMethods(),
  };
  mutate(source);
  return defineRuntimeAdapter(source);
};

describe('configurable runtime support matrix', () => {
  test('pins the planning evidence exactly without making a production claim', () => {
    const checked = validateSupportMatrix(matrix);
    expect(checked.revision).toBe('0052a-2026-07-29.1');
    expect(checked.contract_version).toBe(ADAPTER_CONTRACT_VERSION);
    expect(checked.lanes.map((lane: any) => [lane.runtime_family, lane.runtime_version, lane.platform.os, lane.platform.architecture, lane.qualification])).toEqual([
      ['hermes', '0.19.0', 'darwin', 'arm64', 'planned_unqualified'],
      ['hermes', '0.19.0', 'linux', 'amd64', 'probe_only'],
      ['openclaw', '2026.6.6', 'darwin', 'arm64', 'probe_only'],
    ]);
    expect(checked.deferred_candidates).toEqual([expect.objectContaining({
      runtime_family: 'circle_agent',
      missing_exact_pins: ['platform.os_version', 'platform.bun'],
    })]);
    expect(checked.lanes.every((lane: any) => lane.qualification !== 'supported')).toBe(true);
    expect(checked.windows.status).toBe('unsupported');
    expect(checked.windows.remediation).toMatch(/blocking.*Windows.*baseline/i);
    const hermes = checked.lanes.filter((lane: any) => lane.runtime_family === 'hermes');
    expect(hermes).toHaveLength(2);
    expect(hermes.every((lane: any) =>
      Object.values(lane.capabilities).every((capability: any) =>
        capability.available === false &&
        capability.mechanism === 'manual_action' &&
        capability.evidence.length === 0))).toBe(true);
    expect(hermes.find((lane: any) => lane.platform.os === 'darwin').evidence.map(
      (item: any) => item.reference,
    )).not.toContain('tasks/0052e-hermes-m0h-linux-evidence.md');
    expect(hermes.find((lane: any) => lane.platform.os === 'linux').evidence.map(
      (item: any) => item.reference,
    )).toContain('tasks/0052e-hermes-m0h-linux-evidence.md');
    for (const lane of checked.lanes) {
      expect(Object.keys(lane.capabilities).sort()).toEqual([...ADAPTER_OPERATIONS].sort());
      expect(lane.evidence.length).toBeGreaterThan(0);
    }
  });

  test('validation is pure, immutable, strict, and rejects ambiguous lanes', () => {
    const source = structuredClone(matrix);
    const before = structuredClone(source);
    const checked = validateSupportMatrix(source);
    expect(source).toEqual(before);
    expect(Object.isFrozen(checked)).toBe(true);
    expect(Object.isFrozen(checked.lanes[0].capabilities)).toBe(true);

    expect(() => validateSupportMatrix({ ...source, surprise: true } as any)).toThrow(/unsupported fields.*surprise/i);
    expect(() => validateSupportMatrix({ ...source, lanes: [...source.lanes, structuredClone(source.lanes[0])] } as any)).toThrow(/ambiguous|duplicate/i);
    const unpinned = structuredClone(source) as any;
    unpinned.lanes[0].runtime_version = '>=0.1.0';
    expect(() => validateSupportMatrix(unpinned)).toThrow(/exact runtime_version/i);

    for (const forged of [undefined, () => true, 1n, new Date(), new Map(), Symbol('x')]) {
      const invalid = structuredClone(source) as any;
      invalid.lanes[0].provenance.forged = forged;
      expect(() => validateSupportMatrix(invalid)).toThrow(/JSON|unsupported|plain/i);
    }
    const cyclic = structuredClone(source) as any;
    cyclic.lanes[0].provenance.cycle = cyclic;
    expect(() => validateSupportMatrix(cyclic)).toThrow(/cycles/i);
    const moving = structuredClone(source) as any;
    moving.lanes[0].platform.runtime_version = 'latest';
    expect(() => validateSupportMatrix(moving)).toThrow(/exact pin/i);
    for (const field of [
      'source_tag', 'source_commit', 'wheel_sha256', 'python_artifact_sha256',
      'dependency_lock_sha256', 'evidence_sha256',
    ]) {
      const altered = structuredClone(source) as any;
      altered.lanes[0].provenance[field] = 'altered';
      expect(() => validateSupportMatrix(altered)).toThrow(/provenance|Hermes|pin/i);
    }

    const sparse = structuredClone(source) as any;
    const sparseOpenClaw = sparse.lanes.find((lane: any) => lane.runtime_family === 'openclaw');
    delete sparseOpenClaw.capabilities.detect.evidence[0];
    expect(() => validateSupportMatrix(sparse)).toThrow(/sparse array holes/i);
    const duplicateAcrossKinds = structuredClone(source) as any;
    duplicateAcrossKinds.deferred_candidates[0].id = duplicateAcrossKinds.lanes[0].id;
    expect(() => validateSupportMatrix(duplicateAcrossKinds)).toThrow(/duplicate matrix id/i);
    const duplicateCandidateIdentity = structuredClone(source) as any;
    duplicateCandidateIdentity.deferred_candidates.push(structuredClone(duplicateCandidateIdentity.deferred_candidates[0]));
    duplicateCandidateIdentity.deferred_candidates[1].id = 'circle-agent-duplicate-id';
    duplicateCandidateIdentity.deferred_candidates[1].remediation = 'Different text cannot disambiguate the same candidate identity.';
    expect(() => validateSupportMatrix(duplicateCandidateIdentity)).toThrow(/ambiguous duplicate deferred candidate identity/i);
    expect(() => validateSupportMatrix({ ...source, revision: 'release latest' } as any)).toThrow(/revision.*grammar/i);
    for (const missingPins of [
      ['platform.os_version', 'platform.runtime_version'],
      ['platform.os_version'],
      ['platform.os_version', 'platform.bun', 'platform.runtime_version'],
    ]) {
      const divergent = structuredClone(source) as any;
      divergent.deferred_candidates[0].missing_exact_pins = missingPins;
      expect(() => validateSupportMatrix(divergent)).toThrow(/exact Linux and Bun pins/i);
    }
    for (const reference of ['/var/lib/evidence', '/etc/passwd', '/private/tmp/x', '/tmp/x', 'C:\\temp\\x', '\\\\host\\share\\x', '//host/share/x']) {
      const invalid = structuredClone(source) as any;
      invalid.lanes[0].evidence[0].reference = reference;
      expect(() => validateSupportMatrix(invalid)).toThrow(/machine-neutral|path/i);
    }
    const typed = structuredClone(source) as any;
    typed.lanes[0].evidence[0].reference = `artifact://sha256/${'b'.repeat(64)}`;
    expect(() => validateSupportMatrix(typed)).not.toThrow();

    const falseClaim = structuredClone(source) as any;
    falseClaim.lanes[0].qualification = 'supported';
    expect(() => validateSupportMatrix(falseClaim)).toThrow(/qualification must remain.*clean-target restore/i);
    const incompleteProduction = structuredClone(source) as any;
    incompleteProduction.status = 'production';
    expect(() => validateSupportMatrix(incompleteProduction)).toThrow(/status must remain evidence_only.*clean-target restore/i);
  });

  test('verifies every repo-relative evidence pin against whole-file bytes', async () => {
    const result = await verifySupportMatrixEvidence(matrix, { source_root: path.resolve(import.meta.dir, '../..') });
    expect(result.verified_files).toEqual([
      'tasks/0052a-initial-support-matrix.md',
      'tasks/0052a-native-command-probe-evidence.md',
      'tasks/0052e-hermes-capture-strategy-decision.md',
      'tasks/0052e-hermes-m0h-database-safety.md',
      'tasks/0052e-hermes-m0h-full-backup.md',
      'tasks/0052e-hermes-m0h-linux-evidence.md',
      'tasks/0052e-hermes-m0h-outcome.md',
      'tasks/0052e-hermes-m0h-ownership-census.md',
      'tasks/0052e-hermes-m0h-profile-transfer.md',
      'tasks/0052e-hermes-m0h-quiescence.md',
      'tasks/0052e-hermes-qualification-lanes.md',
      'tasks/0052e-hermes-v019-pin-evidence.md',
    ]);
    const drifted = structuredClone(matrix) as any;
    drifted.lanes[0].evidence[0].sha256 = '0'.repeat(64);
    await expect(verifySupportMatrixEvidence(drifted, { source_root: path.resolve(import.meta.dir, '../..') })).rejects.toThrow(/sha256 (?:drifted|pins)/i);
  });

  test('binds Hermes/OpenClaw provenance only to locally verified lane evidence', async () => {
    const sourceRoot = path.resolve(import.meta.dir, '../..');
    const unbound = structuredClone(matrix) as any;
    unbound.lanes[0].provenance.evidence_sha256 = '0'.repeat(64);
    await expect(verifySupportMatrixEvidence(unbound, { source_root: sourceRoot })).rejects.toThrow(/provenance\.evidence_sha256.*locally verified lane evidence/i);

    const remoteOnly = structuredClone(matrix) as any;
    remoteOnly.lanes[0].evidence = [{ reference: `artifact://sha256/${remoteOnly.lanes[0].provenance.evidence_sha256}`, sha256: remoteOnly.lanes[0].provenance.evidence_sha256 }];
    await expect(verifySupportMatrixEvidence(remoteOnly, { source_root: sourceRoot })).rejects.toThrow(/provenance\.evidence_sha256.*locally verified lane evidence/i);

    const stale = structuredClone(matrix) as any;
    const staleOpenClaw = stale.lanes.find((lane: any) => lane.runtime_family === 'openclaw');
    staleOpenClaw.evidence[0].sha256 = 'f'.repeat(64);
    staleOpenClaw.provenance.evidence_sha256 = 'f'.repeat(64);
    await expect(verifySupportMatrixEvidence(stale, { source_root: sourceRoot })).rejects.toThrow(/evidence (?:sha256 drifted|file has conflicting sha256 pins)/i);
  });

  test('selection requires an exact lane, adapter contract, and capability evidence', () => {
    const registry = createRuntimeAdapterRegistry({ matrix });
    for (const lane of registry.matrix.lanes) {
      const result = registry.select(requestFor(lane));
      expect(result).toMatchObject({ status: 'manual_review', lane_id: lane.id, adapter: null });
      expect(result.error.remediation).toMatch(/qualification|restore drill|adapter/i);
    }

    const lane = registry.matrix.lanes[0];
    expect(registry.select(requestFor(lane, {
      runtime_version: '0.18.2',
      platform: {
        os: 'darwin', os_version: '14', architecture: 'arm64',
        runtime: 'python', runtime_version: '3.11.15',
      },
    }))).toMatchObject({ status: 'unsupported_version', adapter: null });
    expect(registry.select(requestFor(lane, { runtime_version: '0.1.1' }))).toMatchObject({ status: 'unsupported_version', adapter: null });
    expect(registry.select(requestFor(lane, { platform: { ...lane.platform, os: 'linux', architecture: 'arm64' } }))).toMatchObject({ status: 'unsupported_platform', adapter: null });
    expect(registry.select(requestFor(lane, { adapter_version: '0.2.0-draft' }))).toMatchObject({ status: 'unsupported_adapter', adapter: null });

    expect(registry.select(requestFor(lane, { provenance: { source_commit: 'invented' } }))).toMatchObject({ status: 'manual_review', adapter: null });

    const incomplete = requestFor(lane) as any;
    delete incomplete.platform.os_version;
    expect(registry.select(incomplete)).toMatchObject({ status: 'manual_review', error: { code: 'ADAPTER_CONTRACT_INVALID' } });
    for (const exactLane of registry.matrix.lanes) {
      for (const field of ['os_version', 'runtime_version']) {
        expect(registry.select(requestFor(exactLane, { platform: { ...exactLane.platform, [field]: null } }))).toMatchObject({ status: 'manual_review', error: { code: 'ADAPTER_CONTRACT_INVALID' } });
      }
    }
    expect(registry.select({ ...requestFor(lane), forged: true } as any)).toMatchObject({ status: 'manual_review', error: { code: 'ADAPTER_CONTRACT_INVALID' } });
    expect(registry.select(requestFor(lane, { platform: { ...lane.platform, extra: true } }))).toMatchObject({ status: 'manual_review', error: { code: 'ADAPTER_CONTRACT_INVALID' } });

    const mismatched = structuredClone(lane.capabilities) as any;
    mismatched.snapshot.evidence = ['evidence://invented'];
    expect(registry.select(requestFor(lane, { capability_evidence: mismatched }))).toMatchObject({ status: 'manual_review', adapter: null });
  });

  test('returns the deferred Circle remediation for an exactly typed candidate request', () => {
    const registry = createRuntimeAdapterRegistry({ matrix });
    const candidate: any = registry.matrix.deferred_candidates[0];
    const result = registry.select(candidateRequestFor(candidate));
    expect(result).toMatchObject({
      status: 'unsupported_version',
      adapter: null,
      error: { code: 'UNSUPPORTED_VERSION', remediation: candidate.remediation },
    });

    const malformed = structuredClone(candidate.provenance);
    malformed.agent_host_commit = 'not-a-commit';
    expect(registry.select(candidateRequestFor(candidate, { provenance: malformed }))).toMatchObject({ status: 'manual_review', error: { code: 'ADAPTER_CONTRACT_INVALID' } });

    const mutations: Array<(request: any) => void> = [
      (request) => { request.runtime_version = '0.1.1'; },
      (request) => { request.platform.os = 'freebsd'; },
      (request) => { request.platform.architecture = 'arm64'; },
      (request) => { request.platform.runtime = 'node'; },
      (request) => { request.platform.os_version = '6.8.0'; },
      (request) => { request.platform.runtime_version = '1.3.2'; },
      (request) => { request.adapter_name = 'circle-adapter'; },
      (request) => { request.adapter_version = '0.1.0'; },
      (request) => { request.adapter_contract_version = '1.0.1'; },
      (request) => { request.capability_evidence = Object.fromEntries(ADAPTER_OPERATIONS.map((operation) => [operation, { available: false, mechanism: 'manual_action', evidence: [] }])); },
      (request) => { request.provenance.source_commit = '0'.repeat(40); },
      (request) => { request.provenance.agent_host_version = '0.4.5'; },
      (request) => { request.provenance.agent_host_commit = '1'.repeat(40); },
      (request) => { request.provenance.image_digest = `sha256:${'2'.repeat(64)}`; },
    ];
    for (const mutate of mutations) {
      const request = candidateRequestFor(candidate);
      mutate(request);
      const mismatch = registry.select(request);
      expect(mismatch).toMatchObject({ status: 'manual_review', error: { code: 'MANUAL_REVIEW_REQUIRED' } });
      expect(mismatch.error.remediation).not.toBe(candidate.remediation);
      expect(JSON.stringify(mismatch)).not.toMatch(/0\.1\.0|linux|amd64|bun|41f4304|9f8926|c086183/);
    }
  });

  test('selects remediation from the one exact identity across distinct deferred candidates', () => {
    const expanded: any = structuredClone(matrix);
    const second = structuredClone(expanded.deferred_candidates[0]);
    second.id = 'circle-agent-0.2.0-linux-amd64-candidate';
    second.runtime_version = '0.2.0';
    second.provenance.source_commit = '3'.repeat(40);
    second.remediation = 'Regenerate the distinct Circle 0.2.0 candidate evidence.';
    expanded.deferred_candidates.push(second);
    const registry = createRuntimeAdapterRegistry({ matrix: expanded });
    expect(registry.matrix.deferred_candidates).toHaveLength(2);
    const selected = registry.select(candidateRequestFor(registry.matrix.deferred_candidates[1]));
    expect(selected).toMatchObject({ status: 'unsupported_version', error: { code: 'UNSUPPORTED_VERSION', remediation: second.remediation } });
    expect(selected.error.remediation).not.toBe(expanded.deferred_candidates[0].remediation);
  });

  test('binds each request runtime family to its provenance discriminant and requires own plain provenance', () => {
    const registry = createRuntimeAdapterRegistry({ matrix });
    const hermes = registry.matrix.lanes.find((lane: any) => lane.runtime_family === 'hermes');
    const openclaw = registry.matrix.lanes.find((lane: any) => lane.runtime_family === 'openclaw');
    expect(registry.select(requestFor(hermes, { provenance: structuredClone(openclaw.provenance) }))).toMatchObject({ status: 'manual_review', error: { code: 'ADAPTER_CONTRACT_INVALID' } });

    const candidate: any = registry.matrix.deferred_candidates[0];
    const inherited = Object.create({ format: candidate.provenance.format, source_commit: candidate.provenance.source_commit });
    Object.assign(inherited, {
      agent_host_version: candidate.provenance.agent_host_version,
      agent_host_commit: candidate.provenance.agent_host_commit,
      image_digest: candidate.provenance.image_digest,
    });
    expect(registry.select(candidateRequestFor(candidate, { provenance: inherited }))).toMatchObject({ status: 'manual_review', error: { code: 'ADAPTER_CONTRACT_INVALID' } });

    const custom = Object.assign(Object.create({ custom: true }), structuredClone(candidate.provenance));
    expect(registry.select(candidateRequestFor(candidate, { provenance: custom }))).toMatchObject({ status: 'manual_review', error: { code: 'ADAPTER_CONTRACT_INVALID' } });
  });

  test('registered adapters must declare the exact named identity and cloned capabilities', () => {
    const lane: any = validateSupportMatrix(matrix).lanes.find(
      (item: any) => item.runtime_family === 'openclaw',
    );
    const operations = Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, async () => ({ operation: name })]));
    const adapter: any = {
      contract_version: lane.adapter.contract_version,
      runtime_family: lane.runtime_family,
      adapter_name: lane.adapter.name,
      adapter_version: lane.adapter.version,
      capabilities: structuredClone(lane.capabilities),
      ...operations,
    };
    const registry = createRuntimeAdapterRegistry({ matrix, adapters: [adapter] });
    adapter.capabilities.detect.evidence[0].reference = 'forged-after-registration';
    expect(registry).toBeDefined();
    expect(() => createRuntimeAdapterRegistry({ matrix, adapters: [{ ...adapter, adapter_name: '' }] })).toThrow(/adapter_name|exact/i);
    expect(() => createRuntimeAdapterRegistry({ matrix, adapters: [adapter, { ...adapter }] })).toThrow(/ambiguous registered adapter/i);
    expect(() => createRuntimeAdapterRegistry({ matrix, adapters: [{ ...adapter, support_matrix: [] }] })).toThrow(/support_matrix.*plain object/i);
    expect(() => createRuntimeAdapterRegistry({ matrix, adapters: [{ ...adapter, native_probe: new Date() }] })).toThrow(/native_probe.*plain object/i);
  });

  test('registers the actual output of defineRuntimeAdapter without weakening evidence-only selection', () => {
    const lane: any = validateSupportMatrix(matrix).lanes.find(
      (item: any) => item.runtime_family === 'openclaw',
    );
    const methods = Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, async () => createOperationResult(name, {
      status: name === 'detect' ? 'not_installed' : 'skipped', evidence: [`operation:${name}`],
      error: { code: name === 'detect' ? 'NOT_INSTALLED' : 'CAPABILITY_UNAVAILABLE', message: 'Fixture operation.', remediation: 'Use the qualified runtime.' },
    })]));
    const source: any = {
      contract_version: lane.adapter.contract_version,
      runtime_family: lane.runtime_family,
      adapter_name: lane.adapter.name,
      adapter_version: lane.adapter.version,
      support_matrix: { reference: 'config/runtime-adapter-support-matrix-v1.json', revision: matrix.revision, runtime_version_range: lane.runtime_version, adapter_version_range: lane.adapter.version, compatible_platforms: [{ os: lane.platform.os, architecture: lane.platform.architecture }] },
      native_probe: { executable: 'hermes', native_version: lane.runtime_version, subcommands: [], flags: ['--version'], non_destructive: true, attestation: { status: 'not_installed', evidence: structuredClone(lane.evidence) } },
      capabilities: structuredClone(lane.capabilities),
      ...methods,
    };
    const adapter = defineRuntimeAdapter(source);
    source.capabilities.detect.evidence[0].reference = 'forged-after-definition';
    const registry = createRuntimeAdapterRegistry({ matrix, adapters: [adapter] });
    const selected = registry.select(requestFor(lane));
    expect(selected).toMatchObject({ status: 'manual_review', lane_id: lane.id, adapter: null });
    expect(selected.error.remediation).toMatch(/later M0\/M1 contract revision/i);
    expect(adapter.capabilities).toEqual(lane.capabilities);
  });

  test('draft registry cannot be promoted by synthetic matrix edits before clean-target qualification', () => {
    const qualified: any = structuredClone(matrix);
    qualified.status = 'production';
    qualified.lanes = [qualified.lanes[0]];
    qualified.lanes[0].qualification = 'supported';
    expect(() => validateSupportMatrix(qualified)).toThrow(/status must remain evidence_only.*clean-target restore/i);
    expect(() => createRuntimeAdapterRegistry({ matrix: qualified })).toThrow(/status must remain evidence_only.*clean-target restore/i);

    const supportedLane: any = structuredClone(matrix);
    supportedLane.lanes[0].qualification = 'supported';
    expect(() => validateSupportMatrix(supportedLane)).toThrow(/qualification must remain.*clean-target restore/i);
  });

  test('never reflects request controls, secrets, or machine paths in structured errors', () => {
    const registry = createRuntimeAdapterRegistry({ matrix });
    const lane = registry.matrix.lanes[0];
    const probes = [
      requestFor(lane, { runtime_family: 'unknown\nGITHUB_TOKEN=ghp_RequestSecret1234567890' }),
      requestFor(lane, { runtime_version: 'missing\u0000PRIVATE_VALUE' }),
      requestFor(lane, { platform: { ...lane.platform, os: '/Users/example/private-agent' } }),
      requestFor(lane, { adapter_name: 'missing\r/tmp/private-adapter' }),
    ];
    const candidate: any = registry.matrix.deferred_candidates[0];
    for (const unsafe of ['ghp_RequestSecret1234567890', '/Users/example/private-agent', 'bad\ncontrol']) {
      const provenance = structuredClone(candidate.provenance);
      provenance.agent_host_version = unsafe;
      probes.push(candidateRequestFor(candidate, { provenance }));
    }
    for (const probe of probes) {
      const result: any = registry.select(probe);
      const strings: string[] = [];
      const visit = (value: any) => {
        if (typeof value === 'string') strings.push(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
      };
      visit(result);
      expect(strings.every((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value))).toBe(true);
      expect(strings.join(' ')).not.toMatch(/RequestSecret|PRIVATE_VALUE|\/Users\/example|\/tmp\/private/);
      expect(result).toMatchObject({ adapter: null, error: { code: expect.any(String), message: expect.any(String), remediation: expect.any(String) } });
    }
  });

  test.each(['hermes', 'openclaw'])('every typed Windows %s lane is unsupported and actionable', (runtime_family) => {
    const registry = createRuntimeAdapterRegistry({ matrix });
    const lane = registry.matrix.lanes.find((item: any) => item.runtime_family === runtime_family);
    const result = registry.select(requestFor(lane, {
      platform: { ...lane.platform, os: 'windows' },
    }));
    expect(result).toMatchObject({ status: 'unsupported_platform', adapter: null });
    expect(result.error.code).toBe('UNSUPPORTED_PLATFORM');
    expect(result.error.remediation).toMatch(/Windows.*baseline|unsupported/i);
  });

  test('a typed Circle candidate remains unsupported on Windows without becoming selectable', () => {
    const registry = createRuntimeAdapterRegistry({ matrix });
    const candidate: any = registry.matrix.deferred_candidates[0];
    const result = registry.select(candidateRequestFor(candidate, { platform: { os: 'windows', os_version: null, architecture: candidate.platform.architecture, runtime: candidate.platform.runtime, runtime_version: null } }));
    expect(result).toMatchObject({ status: 'unsupported_platform', adapter: null, error: { code: 'UNSUPPORTED_PLATFORM' } });
  });
});
