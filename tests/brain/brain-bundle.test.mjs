import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  migrateNetworkConfigToBrainBundleV1,
  validateBrainBundleV1,
} from '../../lib/brain/brain-bundle.js';

test('brain-bundle-v1 schema artifact exists and declares manifest_version 1', () => {
  const schemaPath = path.resolve('schemas/brain-bundle-v1.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  assert.equal(schema.properties.manifest_version.const, 1);
  assert.equal(schema.properties.identity.additionalProperties, false);
});

test('validateBrainBundleV1 accepts a minimal portable bundle', () => {
  const result = validateBrainBundleV1({
    manifest_version: 1,
    brainId: 'bootup',
    identity: { projectId: 'agentbootup', agentId: 'bootup.gm' },
    credential_references: [
      { provider: 'mech-vault', namespace: 'bootup-production', key: 'BRAIN_DB_TOKEN' },
    ],
  });
  assert.equal(result.ok, true);
});

test('validateBrainBundleV1 rejects missing identity', () => {
  const result = validateBrainBundleV1({ manifest_version: 1 });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /brainId/);
});

test('validateBrainBundleV1 rejects env-specific fields', () => {
  const result = validateBrainBundleV1({
    manifest_version: 1,
    brainId: 'bootup',
    workspace: { path: './agentbootup' },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /does not belong in L1/);
});

test('validateBrainBundleV1 rejects unsupported credential reference fields', () => {
  const result = validateBrainBundleV1({
    manifest_version: 1,
    brainId: 'bootup',
    credential_references: [
      { provider: 'mech-vault', namespace: 'bootup', value: 'plaintext-secret' },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsupported fields/);
});

test('validateBrainBundleV1 rejects mixed valid and unsupported credential reference fields', () => {
  const result = validateBrainBundleV1({
    manifest_version: 1,
    brainId: 'bootup',
    credential_references: [
      { provider: 'mech-vault', namespace: 'bootup', key: 'BRAIN_DB_TOKEN', note: 'inline metadata' },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsupported fields: note/);
});

test('validateBrainBundleV1 rejects routing metadata in L1', () => {
  const result = validateBrainBundleV1({
    manifest_version: 1,
    brainId: 'bootup',
    routing: { provider: 'mech-plane', endpoint: 'https://mech-plane.example' },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /routing does not belong in L1/);
});

test('validateBrainBundleV1 requires identity values to be non-empty when identity is set', () => {
  const result = validateBrainBundleV1({
    manifest_version: 1,
    brainId: 'bootup',
    identity: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /identity must include projectId or agentId/);
});

test('migrateNetworkConfigToBrainBundleV1 maps network config additively', () => {
  const bundle = migrateNetworkConfigToBrainBundleV1(
    {
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'bootup', agent_id: 'bootup', path: './agentbootup', branch: 'main' },
      ],
    },
    { brainId: 'bootup', environmentId: 'decisive' }
  );

  assert.equal(bundle.manifest_version, 1);
  assert.equal(bundle.brainId, 'bootup');
  assert.equal(bundle.identity, undefined);
  assert.equal(bundle.source.format, 'agentbootup.json');
  assert.equal(bundle.workspace, undefined);
  assert.equal(validateBrainBundleV1(bundle).ok, true);
});

test('migrateNetworkConfigToBrainBundleV1 preserves top-level identity fields when present', () => {
  const bundle = migrateNetworkConfigToBrainBundleV1({
    version: '2.0',
    id: 'agentbootup',
    agent_id: 'bootup.gm',
  });

  assert.equal(bundle.identity.projectId, 'agentbootup');
  assert.equal(bundle.identity.agentId, 'bootup.gm');
  assert.equal(validateBrainBundleV1(bundle).ok, true);
});
