import { expect, test } from 'bun:test';
import { normalizeEnvConfig } from './env-config.js';

function validConfig(overrides = {}) {
  return {
    schema_version: '1.0',
    environment: 'circle-computer',
    brains: ['circle_agent'],
    environment_skills: { path: './skills', optional: false },
    secret_source: { provider: 'mech-vault', namespace: 'circle-computer' },
    routing: { provider: 'mech-plane', endpoint: 'https://mech.example', approval_mode: 'manual' },
    approval_flow: { mode: 'orchestrate', endpoint: 'https://approval.example/v1/approve' },
    ...overrides,
  };
}

test('canonical env config accepts the frozen approval-flow endpoint shape', () => {
  expect(normalizeEnvConfig(validConfig())).toMatchObject({ ok: true });
});

test('canonical env config rejects smuggled top-level and approval-flow fields', () => {
  expect(normalizeEnvConfig(validConfig({ runtime_override: true }))).toMatchObject({
    ok: false, error: 'env config.runtime_override is not allowed',
  });
  expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'orchestrate', endpoint: 'https://approval.example', bypass: true } }))).toMatchObject({
    ok: false, error: 'approval_flow.bypass is not allowed',
  });
});

test('canonical env config rejects smuggled nested security fields', () => {
  expect(normalizeEnvConfig(validConfig({ secret_source: { provider: 'mech-vault', namespace: 'circle-computer', token: 'smuggled' } }))).toMatchObject({
    ok: false, error: 'secret_source.token is not allowed',
  });
  expect(normalizeEnvConfig(validConfig({ routing: { provider: 'mech-plane', endpoint: 'https://mech.example', approval_mode: 'manual', runtime_override: true } }))).toMatchObject({
    ok: false, error: 'routing.runtime_override is not allowed',
  });
});

test('canonical env config rejects approval-flow fields that do not belong to the selected mode', () => {
  expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'none', endpoint: '/approve' } }))).toMatchObject({
    ok: false, error: 'approval_flow.endpoint is only valid for mode "orchestrate"',
  });
  expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'orchestrate', parent_session_id_var: 'TELEPORTATION_PARENT_SESSION_ID' } }))).toMatchObject({
    ok: false, error: 'approval_flow.parent_session_id_var is only valid for mode "teleporter_hook"',
  });
  expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'teleporter_hook', endpoint: '/approve', parent_session_id_var: 'TELEPORTATION_PARENT_SESSION_ID' } }))).toMatchObject({
    ok: false, error: 'approval_flow.endpoint is only valid for mode "orchestrate"',
  });
});

test('canonical env config rejects malformed approval endpoints', () => {
  expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'orchestrate', endpoint: '/approve' } }))).toMatchObject({
    ok: true,
  });
  expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'orchestrate', endpoint: 'approve' } }))).toMatchObject({
    ok: false, error: 'approval_flow.endpoint must be an absolute http(s) URL, root-relative path, or METHOD /path when set',
  });
  expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'orchestrate', endpoint: 'POST /orchestrate/approve' } }))).toMatchObject({ ok: true });
  expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'orchestrate', endpoint: 'POST //evil.example/approve' } }))).toMatchObject({
    ok: false, error: 'approval_flow.endpoint must be an absolute http(s) URL, root-relative path, or METHOD /path when set',
  });
  expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'orchestrate', endpoint: '/\\evil.example/approve' } }))).toMatchObject({
    ok: false, error: 'approval_flow.endpoint must be an absolute http(s) URL, root-relative path, or METHOD /path when set',
  });
  for (const endpoint of ['/\t/evil.example/approve', '/\n/evil.example/approve', '/\r/evil.example/approve']) {
    expect(normalizeEnvConfig(validConfig({ approval_flow: { mode: 'orchestrate', endpoint } }))).toMatchObject({
      ok: false, error: 'approval_flow.endpoint must be an absolute http(s) URL, root-relative path, or METHOD /path when set',
    });
  }
});

test('legacy mech-plane approval endpoint rejects backslash bypasses', () => {
  expect(normalizeEnvConfig({
    schema_version: '0.1', environment: 'legacy', brain_allowlist: ['legacy-agent'],
    environment_skills: { path: './skills' }, secret_source: { provider: 'mech-vault', namespace: 'legacy' },
    routing_target: { provider: 'mech-plane', endpoint: 'https://mech.example' },
    approval_flow: { mechanism: 'mech-plane', endpoint: 'POST /\\evil.example/approve' },
  })).toMatchObject({
    ok: false, error: 'approval_flow.endpoint must be an absolute http(s) URL, root-relative path, or METHOD /path for mech-plane mechanism',
  });
});

test('legacy env config rejects smuggled and mechanism-inapplicable fields', () => {
  expect(normalizeEnvConfig({
    schema_version: '0.1', environment: 'legacy', brain_allowlist: ['legacy-agent'],
    environment_skills: { path: './skills' }, secret_source: { provider: 'mech-vault', namespace: 'legacy' },
    routing_target: { provider: 'mech-plane', endpoint: 'https://mech.example' },
    approval_flow: { mechanism: 'mech-plane', endpoint: 'POST /orchestrate/approve' },
    unexpected_top_level: true,
  })).toMatchObject({
    ok: false, error: 'env config.unexpected_top_level is not allowed',
  });
  expect(normalizeEnvConfig({
    schema_version: '0.1', environment: 'legacy', brain_allowlist: ['legacy-agent'],
    environment_skills: { path: './skills', unsafe: true }, secret_source: { provider: 'mech-vault', namespace: 'legacy' },
    routing_target: { provider: 'mech-plane', endpoint: 'https://mech.example' },
    approval_flow: { mechanism: 'mech-plane', endpoint: 'POST /orchestrate/approve' },
  })).toMatchObject({
    ok: false, error: 'environment_skills.unsafe is not allowed',
  });
  expect(normalizeEnvConfig({
    schema_version: '0.1', environment: 'legacy', brain_allowlist: ['legacy-agent'],
    environment_skills: { path: './skills' }, secret_source: { provider: 'mech-vault', namespace: 'legacy' },
    routing_target: { provider: 'mech-plane', endpoint: 'https://mech.example' },
    approval_flow: {
      mechanism: 'teleporter_hook',
      endpoint: 'POST /orchestrate/approve',
      parent_session_id_var: 'TELEPORTATION_PARENT_SESSION_ID',
    },
  })).toMatchObject({
    ok: false, error: 'approval_flow.endpoint is only valid for mech-plane mechanism',
  });
});
