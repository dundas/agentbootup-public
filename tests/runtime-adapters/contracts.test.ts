import { describe, expect, test } from 'bun:test';
import {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_OPERATIONS,
  DETECTION_STATUSES,
  ITEM_RESULT_STATUSES,
  OPERATION_STATUSES,
  RUNTIME_ERROR_CODES,
  STATE_CLASSES,
  createOperationResult,
  defineRuntimeAdapter,
  validateOperationResult,
} from '../../lib/runtime-adapters/types.js';

const declarationEvidence = {
  support_matrix: {
    reference: 'config/runtime-support.json', revision: '0052a-1',
    runtime_version_range: '*', adapter_version_range: '^0.1.0',
    compatible_platforms: [{ os: 'darwin', architecture: 'arm64' }],
  },
  native_probe: {
    executable: 'fixture-runtime', native_version: 'fixture', subcommands: [], flags: ['--version'],
    non_destructive: true, attestation: { status: 'supported', evidence: [{ reference: 'tests/evidence/native-probe.json', sha256: 'a'.repeat(64) }] },
  },
};
const digestEvidence = (name: string) => [{ reference: `tests/evidence/${name}.json`, sha256: 'a'.repeat(64) }];

describe('runtime adapter draft contract', () => {
  test('exports the complete frozen-for-draft taxonomies', () => {
    expect(ADAPTER_CONTRACT_VERSION).toBe('1.0.0-draft');
    expect(ADAPTER_OPERATIONS).toEqual([
      'detect', 'inventory', 'quiesce', 'snapshot', 'restore', 'verify', 'resume',
    ]);
    expect(STATE_CLASSES).toEqual([
      'portable_core', 'runtime_state', 'secret', 'external_state',
      'reproducible', 'machine_local', 'cache', 'manual_review',
    ]);
    expect(DETECTION_STATUSES).toEqual([
      'not_installed', 'unsupported_version', 'ambiguous', 'manual_review', 'supported',
    ]);
    expect(ITEM_RESULT_STATUSES).toEqual([
      'restored', 'redeemed', 're_enroll_required', 'skipped', 'unsupported', 'manual_review',
    ]);
    expect(OPERATION_STATUSES).toContain('manual_review');
    expect(RUNTIME_ERROR_CODES).toContain('UNSUPPORTED_SCHEMA_VERSION');
  });

  test('requires every operation and validates explicit capabilities', () => {
    const operation = async () => createOperationResult('detect', { status: 'supported' });
    expect(() => defineRuntimeAdapter({
      contract_version: ADAPTER_CONTRACT_VERSION,
      runtime_family: 'hermes',
      adapter_name: 'hermes-draft',
      adapter_version: '0.1.0',
      ...declarationEvidence,
      capabilities: Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, {
        available: true,
        mechanism: 'manual_action',
        evidence: digestEvidence(name),
      }])),
      detect: operation,
    } as any)).toThrow(/inventory (?:must be a function|is required)/);
  });

  test('accepts a complete adapter without invoking runtime effects', () => {
    const methods = Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, async () =>
      createOperationResult(name, { status: name === 'detect' ? 'supported' : 'success' }),
    ]));
    const adapter = defineRuntimeAdapter({
      contract_version: ADAPTER_CONTRACT_VERSION,
      runtime_family: 'circle-agent',
      adapter_name: 'circle-agent-draft',
      adapter_version: '0.1.0',
      ...declarationEvidence,
      capabilities: Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, {
        available: true,
        mechanism: name === 'snapshot' ? 'database_api' : 'safe_filesystem',
        evidence: digestEvidence(name),
      }])),
      ...methods,
    } as any);
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(adapter.runtime_family).toBe('circle-agent');
  });

  test('adapter declaration evidence is cloned, deeply frozen, and alias-safe', () => {
    const methods = Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, async () =>
      createOperationResult(name, { status: name === 'detect' ? 'supported' : 'success' }),
    ]));
    const supportMatrix = structuredClone(declarationEvidence.support_matrix);
    const nativeProbe = structuredClone(declarationEvidence.native_probe);
    const adapter = defineRuntimeAdapter({
      contract_version: ADAPTER_CONTRACT_VERSION,
      runtime_family: 'circle-agent', adapter_name: 'circle-agent-draft', adapter_version: '0.1.0',
      support_matrix: supportMatrix, native_probe: nativeProbe,
      capabilities: Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, {
        available: true, mechanism: 'safe_filesystem', evidence: digestEvidence(name),
      }])),
      ...methods,
    } as any);

    supportMatrix.compatible_platforms[0].os = 'mutated';
    nativeProbe.flags.push('--destructive');
    nativeProbe.attestation.evidence[0].reference = 'mutated';
    expect(adapter.support_matrix.compatible_platforms[0].os).toBe('darwin');
    expect(adapter.native_probe.flags).toEqual(['--version']);
    expect(adapter.native_probe.attestation.evidence).toEqual([{ reference: 'tests/evidence/native-probe.json', sha256: 'a'.repeat(64) }]);
    expect(Object.isFrozen(adapter.support_matrix.compatible_platforms[0])).toBe(true);
    expect(Object.isFrozen(adapter.native_probe.attestation.evidence)).toBe(true);
  });

  test('structured results cannot hide item-level non-success', () => {
    const result = createOperationResult('restore', {
      status: 'success',
      evidence: ['restore:item-results'],
      items: [{ item_id: 'credential:github', status: 're_enroll_required', remediation: 'Sign in again.' }],
    });
    expect(result.status).toBe('partial');
    expect(validateOperationResult(result)).toEqual({ ok: true, value: result });

    const forged = { ...result, status: 'success' };
    expect(validateOperationResult(forged).ok).toBe(false);
  });

  test('supported detection requires runtime, platform, identity, and capability evidence', () => {
    const incomplete = createOperationResult('detect', { status: 'supported', evidence: ['command:version'] });
    expect(validateOperationResult(incomplete).ok).toBe(false);

    const complete = createOperationResult('detect', {
      status: 'supported',
      evidence: ['command:hermes --version'],
      runtime_identity: {
        family: 'hermes', version: '0.18.2',
        source_platform: { os: 'darwin', architecture: 'arm64' },
        profiles: ['default'], agents: ['hermes'], workspaces: ['primary'],
        detection_evidence: ['command:hermes --version'],
      },
      capabilities: Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, {
        available: true, mechanism: 'native_command', evidence: [`help:${name}`],
      }])),
    });
    expect(validateOperationResult(complete)).toEqual({ ok: true, value: complete });

    for (const [status, code] of [
      ['not_installed', 'NOT_INSTALLED'],
      ['unsupported_version', 'UNSUPPORTED_VERSION'],
      ['ambiguous', 'AMBIGUOUS_RUNTIME'],
      ['manual_review', 'MANUAL_REVIEW_REQUIRED'],
    ] as const) {
      const valid = createOperationResult('detect', {
        status,
        evidence: [`probe:${status}`],
        error: { code, message: `${status} detected`, remediation: 'Follow the runtime setup guide.' },
      });
      expect(validateOperationResult(valid)).toEqual({ ok: true, value: valid });
      expect(validateOperationResult({ ...valid, error: undefined }).ok).toBe(false);
      expect(validateOperationResult({ ...valid, evidence: [] }).ok).toBe(false);
      expect(validateOperationResult({ ...valid, error: { ...valid.error!, code: 'RUNTIME_OPERATION_FAILED' } }).ok).toBe(false);
    }

    for (const key of ['profiles', 'agents', 'workspaces', 'detection_evidence'] as const) {
      const invalid = structuredClone(complete) as any;
      invalid.runtime_identity[key] = ['   '];
      expect(validateOperationResult(invalid).ok).toBe(false);
    }

    for (const mutate of [
      (value: any) => { value.evidence = []; },
      (value: any) => { value.runtime_identity.detection_evidence = []; },
      (value: any) => { value.capabilities.snapshot.evidence = []; },
    ]) {
      const invalid = structuredClone(complete) as any;
      mutate(invalid);
      expect(validateOperationResult(invalid).ok).toBe(false);
    }

    const unavailable = structuredClone(complete) as any;
    unavailable.capabilities.quiesce = { available: false, mechanism: 'manual_action', evidence: [] };
    expect(validateOperationResult(unavailable).ok).toBe(true);
    unavailable.capabilities.quiesce.mechanism = 'native_command';
    expect(validateOperationResult(unavailable).ok).toBe(false);
  });

  test('adapter draft declares configurable support and non-destructive native probe contract', () => {
    const methods = Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, async () =>
      createOperationResult(name, { status: name === 'detect' ? 'not_installed' : 'skipped' }),
    ]));
    const base = {
      contract_version: ADAPTER_CONTRACT_VERSION,
      runtime_family: 'hermes', adapter_name: 'hermes-draft', adapter_version: '0.1.0',
      support_matrix: {
        reference: 'config/runtime-support.json', revision: '0052a-1',
        runtime_version_range: '>=0.18.0 <0.19.0', adapter_version_range: '^0.1.0',
        compatible_platforms: [{ os: 'darwin', architecture: 'arm64' }],
      },
      native_probe: {
        executable: 'hermes', native_version: '0.18.2',
        subcommands: ['backup', 'import'], flags: ['--help', '--version'],
        non_destructive: true, attestation: { status: 'supported', evidence: digestEvidence('native-probe') },
      },
      capabilities: Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, {
        available: true, mechanism: 'native_command', evidence: digestEvidence(name),
      }])),
      ...methods,
    };
    expect(() => defineRuntimeAdapter(base as any)).not.toThrow();
    const forged = { ...base, capabilities: structuredClone(base.capabilities) } as any;
    forged.capabilities.detect.evidence[0].reference = '/etc/passwd';
    expect(() => defineRuntimeAdapter(forged)).toThrow(/repo-relative|artifact reference/i);
    const sparse = { ...base, capabilities: structuredClone(base.capabilities) } as any;
    delete sparse.capabilities.detect.evidence[0];
    expect(() => defineRuntimeAdapter(sparse)).toThrow(/sparse array holes/i);
    expect(() => defineRuntimeAdapter({ ...base, adapter_name: '' } as any)).toThrow(/adapter_name/);
    expect(() => defineRuntimeAdapter({ ...base, native_probe: { ...base.native_probe, non_destructive: false } } as any)).toThrow(/non_destructive/);
    expect(() => defineRuntimeAdapter({ ...base, support_matrix: { ...base.support_matrix, compatible_platforms: [] } } as any)).toThrow(/compatible_platforms/);
    expect(() => defineRuntimeAdapter({
      ...base,
      support_matrix: { ...base.support_matrix, compatible_platforms: [{ os: 'darwin', architecture: 'arm64', source_path: '/tmp' }] },
    } as any)).toThrow(/unsupported fields/);
    expect(() => defineRuntimeAdapter({
      ...base,
      native_probe: { ...base.native_probe, attestation: { ...base.native_probe.attestation, evidence: [] } },
    } as any)).toThrow(/evidence references/);
    expect(() => defineRuntimeAdapter({
      ...base,
      native_probe: { ...base.native_probe, attestation: { ...base.native_probe.attestation, detail: 'undeclared' } },
    } as any)).toThrow(/unsupported fields/);
    expect(() => defineRuntimeAdapter({ ...base, native_probe: { ...base.native_probe, executable: '/opt/runtime/bin/hermes' } } as any)).toThrow(/machine-neutral.*not a resolved path/i);
    expect(() => defineRuntimeAdapter({ ...base, native_probe: { ...base.native_probe, attestation: { ...base.native_probe.attestation, evidence: ['probe:version'] } } } as any)).toThrow(/plain object|digest-bound evidence object/i);
  });

  test('adapter declarations require plain records and own required fields throughout', () => {
    const methods = Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, async () => createOperationResult(name)]));
    const source: any = {
      contract_version: ADAPTER_CONTRACT_VERSION,
      runtime_family: 'hermes', adapter_name: 'hermes-draft', adapter_version: '0.1.0',
      ...structuredClone(declarationEvidence),
      capabilities: Object.fromEntries(ADAPTER_OPERATIONS.map((name) => [name, { available: true, mechanism: 'native_command', evidence: digestEvidence(name) }])),
      ...methods,
    };
    expect(() => defineRuntimeAdapter(Object.create(source))).toThrow(/plain object/i);
    const inheritedCapability = Object.create(source.capabilities.detect);
    source.capabilities.detect = inheritedCapability;
    expect(() => defineRuntimeAdapter(source)).toThrow(/capabilities\.detect must be a plain object/i);

    source.capabilities.detect = { available: true, mechanism: 'native_command', evidence: digestEvidence('detect') };
    const inheritedAttestation = Object.create(source.native_probe.attestation);
    source.native_probe.attestation = inheritedAttestation;
    expect(() => defineRuntimeAdapter(source)).toThrow(/native_probe\.attestation must be a plain object/i);
  });

  test('secret detector covers camelCase, kebab-case, and access tokens throughout results', () => {
    for (const candidate of [
      { diagnostics: { accessToken: 'live-value' } },
      { diagnostics: { provider_token: 'live-value' } },
      { diagnostics: { providerToken: 'live-value' } },
      { warnings: ['accessToken: live-value'] },
      { evidence: ['access-token=live-value'] },
      { items: [{ item_id: 'x', status: 'restored', remediation: 'credential: live-value' }] },
      { error: { code: 'VERIFICATION_FAILED', message: 'privateKey: live-value', remediation: 'Inspect redacted output.' } },
      { diagnostics: { authorization: 'Bearer ordinary-token' } },
      { diagnostics: { proxy_authorization: 'Basic ordinary-token' } },
      { diagnostics: { x_api_key: 'ordinary-token' } },
      { diagnostics: { xApiKey: 'ordinary-token' } },
      { warnings: ['Authorization: Bearer ordinary-token'] },
      { diagnostics: { headers: ['authorization', 'ordinary-live-token'] } },
      { diagnostics: { headers: [['proxy_authorization', 'Basic ordinary-live-token']] } },
      { diagnostics: { headers: [['x-api-key', 'ordinary-live-token']] } },
      { diagnostics: { headers: [{ name: 'authorization', value: 'ordinary-live-token' }] } },
      { diagnostics: { headers: [{ name: 'proxy-authorization', value: 'ordinary-live-token' }] } },
      { diagnostics: { headers: [{ name: 'x-api-key', value: 'ordinary-live-token' }] } },
      { diagnostics: { provider_output: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' } },
      { diagnostics: { provider_output: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' } },
      { warnings: ['Authorization: Basic ordinary-live-token'] },
    ]) {
      const result: any = createOperationResult('verify', { status: 'success', evidence: ['verify:fixture'] });
      Object.assign(result, candidate);
      expect(validateOperationResult(result).ok).toBe(false);
    }
    const harmless: any = createOperationResult('verify', { status: 'success', evidence: ['verify:fixture'] });
    harmless.diagnostics = {
      headers: [['accept', 'application/json']],
      labels: ['authorization', 'documentation'],
    };
    expect(validateOperationResult(harmless).ok).toBe(true);
  });

  test('authorization header containers reject short non-redacted credentials', () => {
    for (const headers of [
      [['authorization', 'abc123']],
      [{ name: 'authorization', value: 'abc123' }],
    ]) {
      const result = createOperationResult('verify', {
        status: 'success', evidence: ['verify:fixture'], diagnostics: { headers },
      });
      expect(validateOperationResult(result).ok).toBe(false);
    }
    const redacted = createOperationResult('verify', {
      status: 'success', evidence: ['verify:fixture'],
      diagnostics: { headers: [['authorization', '[redacted]']] },
    });
    expect(validateOperationResult(redacted).ok).toBe(true);
  });

  test('secret reference fields require typed opaque references', () => {
    const invalid = createOperationResult('verify', {
      status: 'success', evidence: ['verify:fixture'], diagnostics: { token_ref: 'hunter2' },
    });
    expect(validateOperationResult(invalid).ok).toBe(false);
    const valid = createOperationResult('verify', {
      status: 'success', evidence: ['verify:fixture'], diagnostics: { token_ref: 'vault://runtime/token' },
    });
    expect(validateOperationResult(valid).ok).toBe(true);
  });

  test('every successful operation result requires non-empty evidence', () => {
    for (const operation of ADAPTER_OPERATIONS.filter((name) => name !== 'detect')) {
      const result = createOperationResult(operation, { status: 'success' });
      expect(validateOperationResult(result).ok).toBe(false);
    }
  });

  test('operation statuses require evidence and actionable non-success details without contradictions', () => {
    const successWithError = createOperationResult('snapshot', {
      status: 'success', evidence: ['snapshot:ok'],
      error: { code: 'RUNTIME_OPERATION_FAILED', message: 'contradiction', remediation: 'Retry.' },
    });
    expect(validateOperationResult(successWithError).ok).toBe(false);

    const emptyPartial = createOperationResult('restore', { status: 'partial', evidence: ['restore:partial'] });
    expect(validateOperationResult(emptyPartial).ok).toBe(false);
    const actionablePartial = createOperationResult('restore', {
      status: 'partial', evidence: ['restore:partial'],
      items: [{ item_id: 'credential:github', status: 're_enroll_required', remediation: 'Sign in again.' }],
    });
    expect(validateOperationResult(actionablePartial).ok).toBe(true);

    const emptySkipped = createOperationResult('quiesce', { status: 'skipped', evidence: ['capability:none'] });
    expect(validateOperationResult(emptySkipped).ok).toBe(false);
    const explainedSkipped = createOperationResult('quiesce', {
      status: 'skipped', evidence: ['capability:none'],
      error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Quiesce is unavailable.', remediation: 'Stop the runtime manually.' },
    });
    expect(validateOperationResult(explainedSkipped).ok).toBe(true);
    expect(validateOperationResult({ ...explainedSkipped, evidence: [] }).ok).toBe(false);
    expect(validateOperationResult({
      ...explainedSkipped,
      items: [{ item_id: 'runtime:state', status: 'restored' }],
    }).ok).toBe(false);

    const supported: any = createOperationResult('detect', {
      status: 'supported', evidence: ['probe:version'],
      error: { code: 'RUNTIME_OPERATION_FAILED', message: 'contradiction', remediation: 'Retry.' },
    });
    expect(validateOperationResult(supported).ok).toBe(false);
  });

  test('structured errors require stable codes and remediation', () => {
    const invalid = createOperationResult('snapshot', {
      status: 'failed',
      error: { code: 'UNKNOWN_CODE' as any, message: 'failed', remediation: '' },
    });
    const checked = validateOperationResult(invalid);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.join('\n')).toMatch(/stable error code|remediation/);
  });

  test('result diagnostics reject secret material', () => {
    const checked = validateOperationResult({
      contract_version: ADAPTER_CONTRACT_VERSION,
      operation: 'verify',
      status: 'failed',
      error: {
        code: 'VERIFICATION_FAILED',
        message: 'verification failed',
        remediation: 'Inspect the redacted report.',
      },
      evidence: [],
      warnings: [],
      diagnostics: { api_token: 'live-token-value' },
      items: [],
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.join('\n')).toMatch(/raw secret/);
  });
});
