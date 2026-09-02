import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { SECRET_ENV_VAR_RE, validateBrainRuntimeV1 } from '../../lib/brain/brain-runtime.js';

test('brain-runtime-v1 schema artifact exists and requires runtime.required', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve('schemas/brain-runtime-v1.schema.json'), 'utf-8'));
  assert.equal(schema.required.includes('runtime'), true);
  assert.equal(schema.properties.runtime.required.includes('required'), true);
  assert.deepEqual(schema.properties.state_tree.properties.volume_strategy.enum, ['fly_volume_fork', 'local_worktree']);
  assert.deepEqual(schema.$defs.agentLocation.properties.type.enum, ['local', 'http', 'fly', 'admp', 'agent-host']);
  assert.equal(schema.properties.agent_host.properties.internal_auth_token_ref.type, 'string');
  assert.equal(schema.properties.agent_host.additionalProperties, false);
  assert.deepEqual(schema.properties.agent_host.required, ['internal_auth_token_ref']);
  assert.equal(schema.properties.env_var_refs.additionalProperties.properties.vault_ref.type, 'string');
  assert.equal(schema.properties.env_allowlist.type, 'array');
  assert.deepEqual(schema.properties.env_allowlist.items.properties.source.enum, ['vault_redemption', 'literal']);
  const secretPattern = schema.properties.env_allowlist.items.allOf.find((rule) => rule.$comment?.includes('Secret-like env vars')).if.properties.env_var.pattern;
  assert.equal(secretPattern, SECRET_ENV_VAR_RE.source);
});

test('validateBrainRuntimeV1 accepts Bun runtime with local mount target', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    wake_policy: { enabled: false, contract: 'phase-b-deferred' },
    mount_target: { type: 'local' },
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 rejects missing runtime.required', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: {},
    max_execution_ms: 600000,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /runtime\.required/);
});

test('validateBrainRuntimeV1 rejects invalid execution timeout', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 999,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /max_execution_ms/);
});

test('validateBrainRuntimeV1 rejects Phase B wake delivery semantics', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    wake_policy: { delivery: 'push' },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /Phase B/);
});

test('validateBrainRuntimeV1 requires agentId for non-local mount targets', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    mount_target: { type: 'fly', machineId: 'm1' },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /mount_target\.agentId/);
});

test('validateBrainRuntimeV1 accepts additive state_tree with supported volume strategy', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    mount_target: { type: 'admp', agentId: 'agent-host' },
    state_tree: { volume_strategy: 'local_worktree', future_field: true },
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 accepts local cwd and agent-host baseUrl targets', () => {
  const localResult = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    mount_target: { type: 'local', cwd: '/srv/brains/mech-libsql' },
  });
  assert.equal(localResult.ok, true);

  const agentHostResult = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    mount_target: { type: 'agent-host', baseUrl: 'http://localhost:8080', agentId: 'agent-host' },
  });
  assert.equal(agentHostResult.ok, true);
});

test('validateBrainRuntimeV1 rejects agent-host targets without baseUrl', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    mount_target: { type: 'agent-host', agentId: 'agent-host' },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /mount_target\.baseUrl/);
});

test('validateBrainRuntimeV1 rejects unsupported state_tree volume strategy', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.0',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    state_tree: { volume_strategy: 'snapshot_copy' },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /state_tree\.volume_strategy/);
});

test('validateBrainRuntimeV1 accepts agent-host internal auth token vault reference', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    agent_host: {
      internal_auth_token_ref: 'agent-host/staging/AGENT_HOST_SHARED_KEY',
    },
    env_allowlist: [
      {
        env_var: 'AGENT_HOST_SHARED_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/AGENT_HOST_SHARED_KEY',
        redemption_recipient_brain_id: 'agent-host',
      },
    ],
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 rejects blank agent-host internal auth token reference', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    agent_host: {
      internal_auth_token_ref: '',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /agent_host\.internal_auth_token_ref/);
});

test('validateBrainRuntimeV1 rejects non-path agent-host internal auth token values', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    agent_host: {
      internal_auth_token_ref: 'AGENT_HOST_SHARED_KEY',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /vault path reference/);
});

test('validateBrainRuntimeV1 rejects unexpected agent-host fields', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    agent_host: {
      internal_auth_token_ref: 'agent-host/staging/AGENT_HOST_SHARED_KEY',
      internal_auth_token: 'raw-secret-should-not-be-here',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /agent_host\.internal_auth_token is not allowed/);
});

test('validateBrainRuntimeV1 rejects empty agent-host objects', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    agent_host: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /agent_host\.internal_auth_token_ref/);
});

test('validateBrainRuntimeV1 rejects raw env var ref values', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_var_refs: {
      MECH_API_KEY: 'raw-secret-should-not-be-here',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_var_refs\.MECH_API_KEY/);
});

test('validateBrainRuntimeV1 accepts valid env var refs', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_var_refs: {
      MECH_API_KEY: { vault_ref: 'mech/staging/MECH_API_KEY' },
    },
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 rejects env var refs with non-path vault_ref format', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_var_refs: {
      MECH_API_KEY: { vault_ref: 'NOPATH' },
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_var_refs\.MECH_API_KEY\.vault_ref/);
});

test('validateBrainRuntimeV1 rejects env var refs with unknown fields', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_var_refs: {
      MECH_API_KEY: {
        vault_ref: 'mech/staging/MECH_API_KEY',
        value: 'raw-secret-should-not-be-here',
      },
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_var_refs\.MECH_API_KEY\.value is not allowed/);
});

test('validateBrainRuntimeV1 accepts vault redemption env allowlist entries', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_API_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/MECH_API_KEY',
        redemption_recipient_brain_id: 'agent-host',
        ttl: '1h',
      },
    ],
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 accepts literal env allowlist entries for non-secret values', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_APPS_URL',
        source: 'literal',
        required: true,
        value: 'https://apps.mechdna.net',
      },
    ],
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 accepts an empty env allowlist', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [],
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 rejects malformed env allowlist containers', () => {
  const nonArray = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: {},
  });
  assert.equal(nonArray.ok, false);
  assert.match(nonArray.errors.join('\n'), /env_allowlist must be an array/);

  const nullItem = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [null],
  });
  assert.equal(nullItem.ok, false);
  assert.match(nullItem.errors.join('\n'), /env_allowlist\[0\] must be an object/);
});

test('validateBrainRuntimeV1 rejects unknown env allowlist sources', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_APPS_URL',
        source: 'env',
        required: true,
        value: 'https://apps.mechdna.net',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.source must be one of: vault_redemption, literal/);
});

test('validateBrainRuntimeV1 rejects literal env allowlist values for secret-like env vars', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_API_KEY',
        source: 'literal',
        required: true,
        value: 'raw-secret-should-not-be-here',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.source literal is not allowed for secret-like env vars/);
});

test('validateBrainRuntimeV1 rejects plural and compound secret-like literal env vars', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'AUTH_TOKENS',
        source: 'literal',
        required: true,
        value: 'raw-secret-should-not-be-here',
      },
      {
        env_var: 'APIKEY',
        source: 'literal',
        required: true,
        value: 'raw-secret-should-not-be-here',
      },
      {
        env_var: 'SSHKEY',
        source: 'literal',
        required: true,
        value: 'raw-secret-should-not-be-here',
      },
      {
        env_var: 'REDIS_URL',
        source: 'literal',
        required: true,
        value: 'redis://user:pass@example.test:6379',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.source literal is not allowed/);
  assert.match(r.errors.join('\n'), /env_allowlist\[1\]\.source literal is not allowed/);
  assert.match(r.errors.join('\n'), /env_allowlist\[2\]\.source literal is not allowed/);
  assert.match(r.errors.join('\n'), /env_allowlist\[3\]\.source literal is not allowed/);
});

test('validateBrainRuntimeV1 accepts non-secret literals that contain secret words as substrings', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MONKEY_URL',
        source: 'literal',
        required: true,
        value: 'https://example.test',
      },
      {
        env_var: 'KEYSTONE_HOST',
        source: 'literal',
        required: true,
        value: 'https://example.test',
      },
      {
        env_var: 'MYAPIKEYVALUE',
        source: 'literal',
        required: true,
        value: 'https://example.test',
      },
      {
        env_var: 'FOOCONNECTION_STRING_HOST',
        source: 'literal',
        required: true,
        value: 'https://example.test',
      },
    ],
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 rejects malformed vault redemption env allowlist entries', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_API_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'MECH_API_KEY',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.vault_path/);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.redemption_recipient_brain_id/);
});

test('validateBrainRuntimeV1 rejects duplicate env allowlist env vars', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_APPS_URL',
        source: 'literal',
        required: true,
        value: 'https://apps.mechdna.net',
      },
      {
        env_var: 'MECH_APPS_URL',
        source: 'literal',
        required: true,
        value: 'https://apps.mechdna.net',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[1\]\.env_var duplicates another env_allowlist entry/);
});

test('validateBrainRuntimeV1 rejects invalid env allowlist env vars before duplicate tracking', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'mech api key',
        source: 'literal',
        required: true,
        value: 'https://apps.mechdna.net',
      },
      {
        env_var: 'mech api key',
        source: 'literal',
        required: true,
        value: 'https://apps.mechdna.net',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.env_var must be an uppercase environment variable name/);
  assert.match(r.errors.join('\n'), /env_allowlist\[1\]\.env_var must be an uppercase environment variable name/);
  assert.doesNotMatch(r.errors.join('\n'), /duplicates another env_allowlist entry/);
});

test('validateBrainRuntimeV1 rejects invalid env allowlist ttl values', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_API_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/MECH_API_KEY',
        redemption_recipient_brain_id: 'agent-host',
        ttl: 'forever',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.ttl/);
});

test('validateBrainRuntimeV1 accepts vault redemption env allowlist entries with vault_secret_id', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_API_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/MECH_API_KEY',
        vault_secret_id: 'synthetic-vault-secret-id-0001',
        redemption_recipient_brain_id: 'agent-host',
      },
    ],
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 rejects invalid vault_secret_id placement and values', () => {
  const literalResult = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_APPS_URL',
        source: 'literal',
        required: true,
        value: 'https://apps.mechdna.net',
        vault_secret_id: 'synthetic-vault-secret-id-0001',
      },
    ],
  });
  assert.equal(literalResult.ok, false);
  assert.match(literalResult.errors.join('\n'), /env_allowlist\[0\]\.vault_secret_id is not allowed for literal entries/);

  const emptyResult = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_API_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/MECH_API_KEY',
        vault_secret_id: '',
        redemption_recipient_brain_id: 'agent-host',
      },
    ],
  });
  assert.equal(emptyResult.ok, false);
  assert.match(emptyResult.errors.join('\n'), /env_allowlist\[0\]\.vault_secret_id/);
});

test('validateBrainRuntimeV1 rejects zero env allowlist ttl values', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_API_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/MECH_API_KEY',
        redemption_recipient_brain_id: 'agent-host',
        ttl: '0s',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.ttl/);
});

test('validateBrainRuntimeV1 rejects missing env allowlist env vars without poisoning duplicate detection', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        source: 'literal',
        required: true,
        value: 'https://apps.mechdna.net',
      },
      {
        env_var: 'MECH_APPS_URL',
        source: 'literal',
        required: true,
        value: 'https://apps.mechdna.net',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.env_var must be an uppercase environment variable name/);
  assert.doesNotMatch(r.errors.join('\n'), /duplicates another env_allowlist entry/);
});

test('validateBrainRuntimeV1 accepts transitional env allowlist and env var refs overlap', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_API_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/MECH_API_KEY',
        redemption_recipient_brain_id: 'agent-host',
      },
    ],
    env_var_refs: {
      MECH_API_KEY: { vault_ref: 'agent-host/staging/MECH_API_KEY' },
    },
  });
  assert.equal(r.ok, true);
});

test('validateBrainRuntimeV1 rejects mismatched agent host shared key references', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    agent_host: {
      internal_auth_token_ref: 'agent-host/staging/INGRESS_SHARED_KEY',
    },
    env_allowlist: [
      {
        env_var: 'AGENT_HOST_SHARED_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/OTHER_SHARED_KEY',
        redemption_recipient_brain_id: 'agent-host',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /AGENT_HOST_SHARED_KEY vault_path must match/);
});

test('validateBrainRuntimeV1 requires shared key env allowlist when agent host auth is configured', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    agent_host: {
      internal_auth_token_ref: 'agent-host/staging/INGRESS_SHARED_KEY',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist must include AGENT_HOST_SHARED_KEY/);
});

test('validateBrainRuntimeV1 requires agent host auth when shared key env allowlist is configured', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'AGENT_HOST_SHARED_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/INGRESS_SHARED_KEY',
        redemption_recipient_brain_id: 'agent-host',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /agent_host\.internal_auth_token_ref is required/);
});

test('validateBrainRuntimeV1 rejects unknown env allowlist fields', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    env_allowlist: [
      {
        env_var: 'MECH_API_KEY',
        source: 'vault_redemption',
        required: true,
        vault_path: 'agent-host/staging/MECH_API_KEY',
        redemption_recipient_brain_id: 'agent-host',
        raw_value: 'raw-secret-should-not-be-here',
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /env_allowlist\[0\]\.raw_value is not allowed/);
});

test('validateBrainRuntimeV1 rejects model routing defaults with unknown fields', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    model_routing_defaults: {
      provider: 'mech-llms',
      task_model: 'default-task',
      raw_token: 'raw-secret-should-not-be-here',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /model_routing_defaults\.raw_token is not allowed/);
});

test('validateBrainRuntimeV1 rejects blank model routing defaults', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    model_routing_defaults: {
      provider: '',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /model_routing_defaults\.provider/);
});

test('validateBrainRuntimeV1 accepts model routing defaults', () => {
  const r = validateBrainRuntimeV1({
    schema_version: '1.1',
    runtime: { required: { bun: '>=1.3.0' } },
    max_execution_ms: 600000,
    model_routing_defaults: {
      provider: 'mech-llms',
      task_model: 'default-task',
      chat_model: 'default-chat',
    },
  });
  assert.equal(r.ok, true);
});

test('staging-bundle.json validates as brain-runtime-v1 and carries vault references only', () => {
  const bundle = JSON.parse(fs.readFileSync(path.resolve('schemas/staging-bundle.json'), 'utf-8'));
  const r = validateBrainRuntimeV1(bundle);
  assert.equal(r.ok, true);
  assert.equal(bundle.agent_host.internal_auth_token_ref, 'agent-host/staging/INGRESS_SHARED_KEY');
  assert.deepEqual(Object.keys(bundle.env_var_refs).sort(), [
    'AGENT_HOST_SHARED_KEY',
    'MECH_API_KEY',
    'MECH_APPS_URL',
    'MECH_LLMS_URL',
  ]);
  assert.equal(bundle.env_var_refs.AGENT_HOST_SHARED_KEY.vault_ref, 'agent-host/staging/INGRESS_SHARED_KEY');
  assert.deepEqual(bundle.env_allowlist.map((entry) => entry.env_var).sort(), [
    'AGENT_HOST_SHARED_KEY',
    'MECH_API_KEY',
    'MECH_APPS_URL',
    'MECH_LLMS_URL',
  ]);
  assert.equal(bundle.env_allowlist.find((entry) => entry.env_var === 'AGENT_HOST_SHARED_KEY').vault_path, 'agent-host/staging/INGRESS_SHARED_KEY');
  assert.equal(bundle.env_allowlist.find((entry) => entry.env_var === 'MECH_API_KEY').vault_path, 'agent-host/staging/MECH_API_KEY');
  assert.equal(bundle.env_allowlist.find((entry) => entry.env_var === 'MECH_APPS_URL').value, 'https://apps.mechdna.net');
  assert.equal(bundle.env_allowlist.find((entry) => entry.env_var === 'MECH_LLMS_URL').value, 'https://llms.mechdna.net');
  for (const entry of bundle.env_allowlist) {
    if (SECRET_ENV_VAR_RE.test(entry.env_var)) {
      assert.equal(entry.source, 'vault_redemption', `${entry.env_var} must use vault_redemption`);
      assert.match(entry.vault_path, /\//, `${entry.env_var} must use a vault path`);
      assert.equal(entry.value, undefined, `${entry.env_var} must not carry a literal value`);
    }
  }
  assert.equal(bundle.model_routing_defaults.task_model, 'default-task');
  assert.equal(bundle.model_routing_defaults.chat_model, 'default-chat');
});
