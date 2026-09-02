#!/usr/bin/env bun

/**
 * Human-gated, two-host verification for the deployed manual-secret contract.
 *
 * Host A:
 *   bun scripts/verify-secrets-live-contract.mjs export --evidence /secure/path/evidence.json
 * Host B:
 *   bun scripts/verify-secrets-live-contract.mjs import --evidence /secure/path/evidence.json
 *
 * Both phases require the same run nonce. It is non-secret, high-entropy
 * correlation metadata transported through the environment for two-phase
 * continuity; it grants no access and authenticates nothing. The evidence
 * contains only bounded identifiers/timestamps and a host fingerprint; it
 * contains no secret bytes or content-derived hashes.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runSecretsCleanup,
  runSecretsPull,
  runSecretsPush,
} from '../lib/network/commands/secrets.js';
import {
  SECRET_REL_PATHS,
  SECRET_TTL_MIN_SECONDS,
  isCanonicalUtcIsoTimestamp,
} from '../lib/brain/asset-contract.js';

const LIVE_ACK = 'I_ACKNOWLEDGE_DISPOSABLE_BRAIN_SECRET_OVERWRITE';
const EVIDENCE_SCHEMA = 'agentbootup.secrets-live-contract-evidence.v1';
const phase = process.argv[2];
const evidenceFlag = process.argv.indexOf('--evidence');
const evidencePath = evidenceFlag >= 0 ? process.argv[evidenceFlag + 1] : undefined;
const brainId = process.env.AGENTBOOTUP_SECRETS_LIVE_BRAIN_ID?.trim();
const serverUrl = process.env.AGENTBOOTUP_SECRETS_LIVE_SERVER_URL?.trim()?.replace(/\/$/, '');
const runNonce = process.env.AGENTBOOTUP_SECRETS_LIVE_RUN_NONCE;
const runtimeApiKey = process.env.AGENTBOOTUP_SECRETS_LIVE_API_KEY;

function pause(message) {
  console.error(`PAUSE: ${message}`);
  process.exit(2);
}

if (process.env.AGENTBOOTUP_SECRETS_LIVE_VERIFY !== LIVE_ACK) {
  pause(
    `set AGENTBOOTUP_SECRETS_LIVE_VERIFY=${LIVE_ACK} only after the human security/deployment gate approves live verification.`,
  );
}
if (!['export', 'import'].includes(phase)) {
  pause('choose exactly one phase: export on host A or import on host B.');
}
if (!evidencePath || !path.isAbsolute(evidencePath)) {
  pause('--evidence must be an explicit absolute path carried from host A to host B.');
}
if (!brainId || !/^[A-Za-z0-9._-]{1,128}$/.test(brainId)) {
  pause('AGENTBOOTUP_SECRETS_LIVE_BRAIN_ID must name a registered disposable verification brain.');
}
if (!serverUrl || !/^https:\/\/[^/]+(?:\/.*)?$/.test(serverUrl)) {
  pause('AGENTBOOTUP_SECRETS_LIVE_SERVER_URL must pin the explicitly approved HTTPS deployment.');
}
if (typeof runNonce !== 'string' || runNonce.length < 32) {
  pause('AGENTBOOTUP_SECRETS_LIVE_RUN_NONCE must be a non-secret high-entropy correlation value of at least 32 characters shared across both phases.');
}
if (typeof globalThis.Bun === 'undefined') {
  pause('live verification requires Bun so runtime credentials are never serialized into helper argv.');
}
if (typeof runtimeApiKey !== 'string' || runtimeApiKey.length < 16) {
  pause('AGENTBOOTUP_SECRETS_LIVE_API_KEY must be supplied through the approved ephemeral runtime grant.');
}

const runtimeCredentials = Object.freeze({ apiKey: runtimeApiKey, serverUrl });
const credentialOptions = Object.freeze({
  readCredentialsImpl: async () => runtimeCredentials,
});

const hostFingerprint = crypto.createHash('sha256')
  .update([os.hostname(), os.platform(), os.arch(), os.homedir()].join('\0'))
  .digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentbootup-secrets-live-${phase}-`));
let projectRoot = path.join(root, 'project');
const io = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

function seedProject() {
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'agentbootup.json'),
    `${JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: brainId,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function fixtureBytes(runId, relPath) {
  const digest = crypto.createHmac('sha256', runNonce)
    .update(`${runId}\0${relPath}`)
    .digest('hex');
  if (relPath === '.env') return Buffer.from(`LIVE_CONTRACT_FIXTURE=${digest}\n`, 'utf8');
  if (relPath === '.dev.vars') return Buffer.from(`LIVE_CONTRACT_FIXTURE=${digest}\r\n`, 'utf8');
  return Buffer.from(`${JSON.stringify({ live_contract_fixture: digest })}\n`, 'utf8');
}

function writeFixtures(runId) {
  fs.mkdirSync(path.join(projectRoot, 'brain'), { recursive: true });
  for (const relPath of SECRET_REL_PATHS) {
    fs.writeFileSync(path.join(projectRoot, relPath), fixtureBytes(runId, relPath), { mode: 0o600 });
  }
}

function readEvidence() {
  const stat = fs.lstatSync(evidencePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('evidence must be a regular non-symlink file');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  if (
    evidence?.schema !== EVIDENCE_SCHEMA
    || typeof evidence.run_id !== 'string'
    || !/^[a-f0-9]{32}$/.test(evidence.run_id)
    || evidence.brain_id !== brainId
    || evidence.server_url !== serverUrl
    || typeof evidence.source_host_fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(evidence.source_host_fingerprint)
    || !isCanonicalUtcIsoTimestamp(evidence.expires_at)
  ) {
    throw new Error('evidence does not match the approved run, brain, or deployed target');
  }
  return evidence;
}

async function exportPhase() {
  if (fs.existsSync(evidencePath)) throw new Error('refusing to overwrite an existing evidence file');
  const runId = crypto.randomBytes(16).toString('hex');
  seedProject();
  writeFixtures(runId);
  let code = await runSecretsPush(projectRoot, io, {
    ...credentialOptions,
    dryRun: true,
    ttlSeconds: SECRET_TTL_MIN_SECONDS,
    expectedServerUrl: serverUrl,
  });
  if (code !== 0) throw new Error('non-mutating deployed-server preflight failed');
  code = await runSecretsPush(projectRoot, io, {
    ...credentialOptions,
    ttlSeconds: SECRET_TTL_MIN_SECONDS,
    expectedServerUrl: serverUrl,
  });
  if (code !== 0) throw new Error('deployed-server push failed');
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    run_id: runId,
    brain_id: brainId,
    server_url: serverUrl,
    source_host_fingerprint: hostFingerprint,
    expires_at: new Date(Date.now() + SECRET_TTL_MIN_SECONDS * 1000).toISOString(),
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`PASS export phase: ${SECRET_REL_PATHS.length} sources pushed; transfer evidence to a different host.`);
}

async function importPhase() {
  const evidence = readEvidence();
  if (evidence.source_host_fingerprint === hostFingerprint) {
    throw new Error('import phase must run on a different host from the export phase');
  }
  seedProject();
  try {
    let code = await runSecretsPull(projectRoot, io, {
      ...credentialOptions,
      force: true,
      expectedServerUrl: serverUrl,
    });
    if (code !== 0) throw new Error('second-host pull failed');
    for (const relPath of SECRET_REL_PATHS) {
      const actual = fs.readFileSync(path.join(projectRoot, relPath));
      if (!actual.equals(fixtureBytes(evidence.run_id, relPath))) {
        throw new Error(`exact-byte mismatch for ${relPath}`);
      }
      console.log(`PASS exact bytes: ${relPath}`);
    }

    const waitMs = Date.parse(evidence.expires_at) - Date.now() + 1_500;
    if (waitMs > 0) {
      console.log(`Waiting for deployed expiry boundary (${Math.ceil(waitMs / 1000)}s max).`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const expiryRoot = path.join(root, 'expiry-check');
    projectRoot = expiryRoot;
    seedProject();
    code = await runSecretsPull(projectRoot, io, {
      ...credentialOptions,
      force: true,
      expectedServerUrl: serverUrl,
    });
    if (code !== 0) throw new Error('expiry verification pull failed');
    if (SECRET_REL_PATHS.some((relPath) => fs.existsSync(path.join(projectRoot, relPath)))) {
      throw new Error('expired secret generation remained restorable');
    }
    console.log('PASS deployed expiry: expired generation is not restorable.');
  } finally {
    projectRoot = path.join(root, 'cleanup-project');
    seedProject();
    const cleanupCode = await runSecretsCleanup(projectRoot, io, {
      ...credentialOptions,
      expectedServerUrl: serverUrl,
      confirmBrainId: brainId,
    });
    if (cleanupCode !== 0) {
      throw new Error('remote secret cleanup failed; retain evidence and retry cleanup before reusing the brain');
    }
  }
  console.log('PASS import phase: true second-host bytes, expiry, and remote cleanup verified.');
}

try {
  await (phase === 'export' ? exportPhase() : importPhase());
} catch (err) {
  console.error(`FAIL deployed secret contract ${phase}: ${err.message}`);
  if (phase === 'export') {
    projectRoot = path.join(root, 'cleanup-project');
    seedProject();
    const cleanupCode = await runSecretsCleanup(projectRoot, io, {
      ...credentialOptions,
      expectedServerUrl: serverUrl,
      confirmBrainId: brainId,
    });
    if (cleanupCode !== 0) {
      console.error('FAIL remote cleanup after export failure; keep this disposable brain quarantined.');
    }
  }
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
