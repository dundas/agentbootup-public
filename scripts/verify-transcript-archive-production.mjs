#!/usr/bin/env node

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDS_STATE_OK,
  inspectCredentials,
} from '../lib/auth/credentials.js';
import {
  TRANSCRIPT_EXIT_CODES,
  TranscriptArchiveClient,
} from '../lib/transcript-archive/client.js';
import { ARCHIVE_ADAPTER_PATTERN } from '../lib/transcript-archive/capability-validation.js';

const REQUIRED_CONFIRMED = [
  'objectVersioning',
  'replication',
  'checksum',
  'metadataRecovery',
  'retentionPolicy',
  'disasterRecovery',
  'exportPolicy',
  'tenantEncryption',
];
// temporaryObjectDeletion is deliberately not deletion authority. It controls
// server-side garbage collection of uncommitted upload parts; local offload
// depends only on the committed generation and its recovery evidence.
const REPORT_FIELDS = new Set([
  'schemaVersion', 'adapter', 'observedAt', 'objectVersioning', 'replication', 'checksum', 'metadataRecovery',
  'retentionPolicy', 'temporaryObjectDeletion', 'disasterRecovery', 'exportPolicy', 'tenantEncryption',
  'durabilityClass', 'evictionEligible', 'blockedReasons',
]);
const CHECK_BLOCKERS = Object.freeze({
  freshProbe: 'capability_probe_stale',
  versioning: 'object_versioning_unconfirmed',
  independentReplication: 'independent_replication_unconfirmed',
  checksum: 'checksum_unconfirmed',
  metadataRecovery: 'metadata_recovery_unconfirmed',
  retentionPolicy: 'retention_policy_unconfirmed',
  disasterRecovery: 'disaster_recovery_unconfirmed',
  exportPolicy: 'export_policy_unconfirmed',
  tenantEncryption: 'tenant_encryption_unconfirmed',
  durabilityClass: 'durability_class_unqualified',
  evictionAuthorization: 'eviction_unauthorized',
});

function usageError(message) {
  return Object.assign(new Error(message), { code: 'USAGE_ERROR', exitCode: TRANSCRIPT_EXIT_CODES.USAGE });
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
}

function parseArgs(argv) {
  const options = { json: false, maxAgeSeconds: 300 };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--json') options.json = true;
    else if (token === '--server-url') options.serverUrl = argv[++index];
    else if (token === '--brain') options.brainId = argv[++index];
    else if (token === '--max-age-seconds') options.maxAgeSeconds = Number(argv[++index]);
    else if (token === '--help' || token === '-h') options.help = true;
    else throw usageError(`Unknown option: ${token}`);
  }
  if (!Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 1 || options.maxAgeSeconds > 3600) {
    throw usageError('--max-age-seconds must be an integer from 1 to 3600');
  }
  return options;
}

function safeOrigin(serverUrl) {
  let parsed;
  try { parsed = new URL(serverUrl); } catch { throw usageError('A valid --server-url or configured credential server URL is required'); }
  const local = new Set(['localhost', '127.0.0.1', '::1']).has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw usageError('Production verification requires HTTPS (HTTP is allowed only for loopback tests)');
  }
  return parsed.origin;
}

function validateEvidence(name, value) {
  if (!plainObject(value)) throw new Error(`invalid_${name}`);
  const expected = name === 'replication' ? ['state', 'evidence', 'confirmedFailureDomains'] : ['state', 'evidence'];
  if (Object.keys(value).length !== expected.length || Object.keys(value).some((key) => !expected.includes(key))) {
    throw new Error(`invalid_${name}`);
  }
  if (!['confirmed', 'unsupported', 'unknown'].includes(value.state)
    || (value.evidence !== null && (typeof value.evidence !== 'string' || value.evidence.length > 256))) {
    throw new Error(`invalid_${name}`);
  }
  if (value.state === 'confirmed' && !value.evidence) throw new Error(`invalid_${name}`);
  if (name === 'replication' && value.confirmedFailureDomains !== null
    && (!Number.isSafeInteger(value.confirmedFailureDomains) || value.confirmedFailureDomains < 1)) {
    throw new Error('invalid_replication');
  }
}

function validateReport(report) {
  if (!plainObject(report) || Object.keys(report).length !== REPORT_FIELDS.size
    || Object.keys(report).some((key) => !REPORT_FIELDS.has(key))) throw new Error('invalid_capability_report');
  if (report.schemaVersion !== 1 || typeof report.adapter !== 'string'
    || !ARCHIVE_ADAPTER_PATTERN.test(report.adapter)
    || typeof report.observedAt !== 'string' || !Number.isFinite(Date.parse(report.observedAt))) {
    throw new Error('invalid_capability_report');
  }
  for (const name of [...REQUIRED_CONFIRMED, 'temporaryObjectDeletion']) validateEvidence(name, report[name]);
  if (!['unknown', 'single_region_versioned', 'versioned_replicated'].includes(report.durabilityClass)
    || typeof report.evictionEligible !== 'boolean'
    || !Array.isArray(report.blockedReasons)
    || report.blockedReasons.some((reason) => typeof reason !== 'string' || reason.length > 128)) {
    throw new Error('invalid_capability_report');
  }
  return report;
}

function safeFailureCode(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ? value : 'CAPABILITY_EVIDENCE_INVALID';
}

function hashIdentity(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function evaluateReport(report, checkedAt, maxAgeSeconds) {
  const ageSeconds = Math.floor((checkedAt.getTime() - Date.parse(report.observedAt)) / 1000);
  const checks = {
    freshProbe: ageSeconds >= -60 && ageSeconds <= maxAgeSeconds,
    versioning: report.objectVersioning.state === 'confirmed',
    independentReplication: report.replication.state === 'confirmed'
      && (report.replication.confirmedFailureDomains ?? 0) >= 2,
    checksum: report.checksum.state === 'confirmed',
    metadataRecovery: report.metadataRecovery.state === 'confirmed',
    retentionPolicy: report.retentionPolicy.state === 'confirmed',
    disasterRecovery: report.disasterRecovery.state === 'confirmed',
    exportPolicy: report.exportPolicy.state === 'confirmed',
    tenantEncryption: report.tenantEncryption.state === 'confirmed',
    durabilityClass: report.durabilityClass === 'versioned_replicated',
    evictionAuthorization: report.evictionEligible === true && report.blockedReasons.length === 0,
  };
  return { checks, passed: Object.values(checks).every(Boolean), ageSeconds };
}

async function resolveCredentials(options, deps) {
  if (options.credentials) return options.credentials;
  const envApiKey = deps.env.AGENTBOOTUP_API_KEY?.trim();
  const envServerUrl = deps.env.AGENTBOOTUP_SERVER_URL?.trim();
  if (envApiKey && (options.serverUrl || envServerUrl)) {
    return { apiKey: envApiKey, serverUrl: options.serverUrl || envServerUrl };
  }
  const state = await deps.inspectCredentials();
  if (state.state !== CREDS_STATE_OK) {
    throw Object.assign(new Error('Archive credentials are unavailable'), {
      code: 'AUTH_ERROR', exitCode: TRANSCRIPT_EXIT_CODES.AUTH,
    });
  }
  return { ...state.creds, ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}) };
}

export async function verifyProductionArchive(options = {}, injected = {}) {
  const deps = {
    env: injected.env ?? process.env,
    inspectCredentials: injected.inspectCredentials ?? inspectCredentials,
    now: injected.now ?? (() => new Date()),
    fetch: injected.fetch ?? globalThis.fetch,
  };
  const brainId = options.brainId ?? deps.env.AGENTBOOTUP_BRAIN_ID?.trim();
  if (!brainId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(brainId)) {
    throw usageError('A safe --brain or AGENTBOOTUP_BRAIN_ID is required');
  }
  let credentials;
  try {
    credentials = await resolveCredentials(options, deps);
  } catch (error) {
    const configuredServerUrl = options.serverUrl || deps.env.AGENTBOOTUP_SERVER_URL?.trim();
    const targetOrigin = configuredServerUrl ? safeOrigin(configuredServerUrl) : null;
    return {
      exitCode: Number.isSafeInteger(error?.exitCode) ? error.exitCode : TRANSCRIPT_EXIT_CODES.AUTH,
      evidence: {
        schemaVersion: 1,
        checkedAt: deps.now().toISOString(),
        targetOrigin,
        brainIdHash: hashIdentity(brainId),
        so27: 'FAIL',
        verdict: 'PAUSE',
        failureCode: 'AUTH_ERROR',
        checks: { capabilityEndpoint: false },
        blockedReasons: ['production_credentials_unavailable'],
      },
    };
  }
  const serverUrl = options.serverUrl || credentials.serverUrl;
  const targetOrigin = safeOrigin(serverUrl);
  const checkedAt = deps.now();
  const base = {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    targetOrigin,
    brainIdHash: hashIdentity(brainId),
    so27: 'FAIL',
    verdict: 'PAUSE',
  };
  try {
    const client = new TranscriptArchiveClient({
      serverUrl, apiKey: credentials.apiKey, fetch: deps.fetch, timeoutMs: options.timeoutMs ?? 30_000,
      retryLimit: options.retryLimit ?? 1,
      retryBaseMs: options.retryBaseMs ?? 250,
    });
    const report = validateReport(await client.capabilities(brainId));
    const evaluated = evaluateReport(report, checkedAt, options.maxAgeSeconds ?? 300);
    return {
      exitCode: evaluated.passed ? 0 : TRANSCRIPT_EXIT_CODES.VERIFICATION,
      evidence: {
        ...base,
        so27: evaluated.passed ? 'PASS' : 'FAIL',
        verdict: evaluated.passed ? 'PROCEED' : 'PAUSE',
        adapter: report.adapter,
        observedAt: report.observedAt,
        observationAgeSeconds: evaluated.ageSeconds,
        durabilityClass: report.durabilityClass,
        evictionEligible: report.evictionEligible,
        checks: evaluated.checks,
        blockedReasons: Object.entries(evaluated.checks)
          .filter(([, passed]) => !passed)
          .map(([name]) => CHECK_BLOCKERS[name]),
      },
    };
  } catch (error) {
    const exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : TRANSCRIPT_EXIT_CODES.VERIFICATION;
    return {
      exitCode,
      evidence: {
        ...base,
        failureCode: safeFailureCode(error?.code),
        checks: { capabilityEndpoint: false },
        blockedReasons: ['production_capability_evidence_unavailable'],
      },
    };
  }
}

function help() {
  return `Usage: node scripts/verify-transcript-archive-production.mjs --brain <id> [--server-url <https-url>] [--max-age-seconds <n>] [--json]\n\nCredentials come from AGENTBOOTUP_API_KEY + AGENTBOOTUP_SERVER_URL, or the encrypted agentbootup credential store. Secret values and transcript content are never emitted.`;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? TRANSCRIPT_EXIT_CODES.USAGE; return; }
  if (options.help) { console.log(help()); return; }
  let result;
  try { result = await verifyProductionArchive(options); }
  catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? TRANSCRIPT_EXIT_CODES.USAGE; return; }
  if (options.json) console.log(JSON.stringify(result.evidence));
  else {
    console.log(`Transcript archive production gate: ${result.evidence.verdict} (SO-27 ${result.evidence.so27})`);
    console.log(`Target: ${result.evidence.targetOrigin}`);
    console.log(`Blocked: ${(result.evidence.blockedReasons || []).join(', ') || 'none'}`);
  }
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
