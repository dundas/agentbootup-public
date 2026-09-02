import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

test('live secret verifier fails closed before credentials or network without human acknowledgement', () => {
  const env = { ...process.env };
  delete env.AGENTBOOTUP_SECRETS_LIVE_VERIFY;
  delete env.AGENTBOOTUP_SECRETS_LIVE_BRAIN_ID;
  const script = path.resolve('scripts/verify-secrets-live-contract.mjs');

  const result = spawnSync(process.execPath, [script], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /PAUSE:.*human security\/deployment gate/i);
  assert.equal(result.stdout, '');
});

test('live verifier requires an explicit deployed target before credentials or network', () => {
  const env = {
    ...process.env,
    AGENTBOOTUP_SECRETS_LIVE_VERIFY: 'I_ACKNOWLEDGE_DISPOSABLE_BRAIN_SECRET_OVERWRITE',
    AGENTBOOTUP_SECRETS_LIVE_BRAIN_ID: 'disposable-test-brain',
    AGENTBOOTUP_SECRETS_LIVE_RUN_NONCE: 'n'.repeat(32),
  };
  delete env.AGENTBOOTUP_SECRETS_LIVE_SERVER_URL;
  delete env.AGENTBOOTUP_CREDS_FILE;
  const script = path.resolve('scripts/verify-secrets-live-contract.mjs');
  const result = spawnSync(process.execPath, [
    script,
    'export',
    '--evidence',
    path.resolve('/tmp/secrets-live-evidence.json'),
  ], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /explicitly approved HTTPS deployment/i);
});

test('live verifier requires an ephemeral runtime credential instead of persisted machine config', () => {
  const env = {
    ...process.env,
    AGENTBOOTUP_SECRETS_LIVE_VERIFY: 'I_ACKNOWLEDGE_DISPOSABLE_BRAIN_SECRET_OVERWRITE',
    AGENTBOOTUP_SECRETS_LIVE_BRAIN_ID: 'disposable-test-brain',
    AGENTBOOTUP_SECRETS_LIVE_RUN_NONCE: 'n'.repeat(32),
    AGENTBOOTUP_SECRETS_LIVE_SERVER_URL: 'https://staging.example.com',
  };
  delete env.AGENTBOOTUP_SECRETS_LIVE_API_KEY;
  delete env.AGENTBOOTUP_CREDS_FILE;
  const script = path.resolve('scripts/verify-secrets-live-contract.mjs');
  const result = spawnSync('bun', [
    script,
    'export',
    '--evidence',
    path.resolve('/tmp/secrets-live-evidence.json'),
  ], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /ephemeral runtime grant/i);
  assert.equal(result.stdout, '');
});

test('live verifier is shipped and specifies two-host, expiry, and cleanup evidence without SKIP success', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.ok(packageJson.files.includes('scripts/verify-secrets-live-contract.mjs'));
  const source = fs.readFileSync(path.resolve('scripts/verify-secrets-live-contract.mjs'), 'utf8');
  assert.match(source, /export phase/i);
  assert.match(source, /import phase/i);
  assert.match(source, /different host/i);
  assert.match(source, /non-secret, high-entropy.*correlation metadata/is);
  assert.match(source, /PASS deployed expiry/i);
  assert.match(source, /runSecretsCleanup/);
  assert.match(source, /readCredentialsImpl/);
  assert.equal(source.match(/confirmBrainId:\s*brainId/g)?.length, 2);
  assert.doesNotMatch(source, /\bSKIP\b/);
});
