/**
 * Agentbootup Server — Config
 */

/** v1 external personal API key prefix (PRD-0041). */
export const EXTERNAL_API_KEY_PREFIX = 'abu_live_';
export { BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX, BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH } from './lib/brain-authorization-limits';
import { BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX, BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH } from './lib/brain-authorization-limits';
import {
  DEFAULT_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
  MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
  MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
} from './lib/remote-local-device-credential-policy';
import { REMOTE_LOCAL_PREFLIGHT_MIN_PAYLOAD_BYTES } from './lib/remote-local-wss-preflight';

/** Max active personal keys per external user in v1. */
export const EXTERNAL_MAX_ACTIVE_KEYS_PER_USER = 5;

/** Per-external-key rate limit: requests per rolling minute window. */
export const EXTERNAL_RATE_LIMIT_PER_MINUTE = 60;

/** Minimum random suffix length after the external key prefix (FR-6 entropy guard). */
export const EXTERNAL_API_KEY_MIN_SUFFIX_LENGTH = 32;

/** Default device-auth grant lifetime (10 minutes). */
export const DEFAULT_DEVICE_AUTH_GRANT_TTL_SECONDS = 600;

/** CLI poll interval hint returned from device-auth start. */
export const DEFAULT_DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;

/**
 * Per-IP rate limit for unauthenticated device-auth start/poll endpoints.
 * Start and poll share one bucket so abuse cannot double the budget.
 */
export const DEFAULT_DEVICE_AUTH_RATE_LIMIT_PER_MINUTE = 20;
/** A single delayed retry protects read-only server paths from a short storage 429. */
export const DEFAULT_MECH_READ_RETRY_ATTEMPTS = 1;
export const DEFAULT_MECH_READ_RETRY_MAX_DELAY_MS = 15_000;

export interface ServerConfig {
  port: number;
  host: string;
  /** Bun per-request idle timeout, long enough for bounded brain asset batches. */
  serverIdleTimeoutSeconds: number;
  remoteLocalPreflightEnabled: boolean;
  remoteLocalPreflightToken: string | null;
  remoteLocalPreflightIdleTimeoutSeconds: number;
  remoteLocalPreflightMaxPayloadBytes: number;
  /** Explicit default-off gate for the authenticated daemon connector. */
  remoteLocalAdmissionEnabled: boolean;
  remoteLocalAdmissionInitialDeadlineMs: number;
  /** Lifetime for a newly enrolled device credential; every socket still needs fresh PoP. */
  remoteLocalInitialCredentialTtlMs: number;
  /** Separate default-off gate for externally authenticated operation routes. */
  remoteLocalOperationsEnabled: boolean;
  /** Bounded live admitted-connector registry capacity. */
  remoteLocalMaxConnections: number;
  /** Per-minute dispatch budget enforced independently by brain/device/consumer. */
  remoteLocalTurnAttemptsPerMinute: number;
  /** Bounded in-memory rate-budget cardinality. */
  remoteLocalMaxRateKeys: number;
  /** Maximum owner-SSE arming window for a process-local remote turn. */
  remoteLocalTurnArmTimeoutMs: number;
  apiKey: string;
  /** ClearAuth session signing secret (32+ chars). Null disables developer console routes. */
  authSecret: string | null;
  /** Public origin for ClearAuth callbacks and developer console links. */
  publicBaseUrl: string;
  isProduction: boolean;
  externalApiKeyPrefix: string;
  externalMaxActiveKeysPerUser: number;
  externalRateLimitPerMinute: number;
  /** Device-auth grant TTL in seconds (CLI browser approval). */
  deviceAuthGrantTtlSeconds: number;
  /** Per-IP rate limit for device-auth start/poll (unauthenticated). */
  deviceAuthRateLimitPerMinute: number;
  mechStorageUrl: string;
  mechVaultUrl: string;
  mechAppId: string;
  mechApiKey: string;
  mechApiSecret: string;
  /** Explicit cutover selector; disabled is deny-only. */
  brainAuthorizationMode: 'disabled' | 'durable';
  brainAuthorizationBootstrapCohort: readonly { brainId: string; ownerPrincipalId: string }[];
  brainAuthorizationAdapterIdentity: string | null;
  brainAuthorizationAdapterVersion: string | null;
  /** Fail-closed cap for complete generic NoSQL collection enumeration. */
  mechMaxEnumerationRecords: number;
  /** Bounded retries for idempotent Mech Storage GET requests only. */
  mechReadRetryAttempts: number;
  /** Refuse a retry when the server-requested backoff exceeds this cap. */
  mechReadRetryMaxDelayMs: number;
  agentHostRuntimeImage: string;
  agentHostRuntimePort: number;
  agentHostRuntimeHealthPath: string;
  agentHostRuntimeHealthIntervalSeconds: number;
  agentHostRuntimeHealthTimeoutSeconds: number;
  agentHostRuntimeCpu: string;
  agentHostRuntimeMemoryMb: number;
  /** Fleet Health Board stale window (ms). A host not reporting within this renders Stuck. */
  healthStaleAfterMs: number;
  /** Explicit rollout gate for the immutable transcript archive surface. */
  archiveEnabled: boolean;
  /** HMAC secret used only to authenticate archive durability receipts. */
  archiveReceiptSecret: string | null;
  archiveReceiptKeyId: string;
  archiveMaxPartBytes: number;
  archiveMaxParts: number;
  archiveMaxBytes: number;
  archiveInventoryPageSize: number;
  archiveInventoryMaxPageSize: number;
  archiveMaxConcurrentCommits: number;
  archiveCommitByteBudget: number;
  archiveMaxPendingCommits: number;
  archiveInventoryMaxScanRows: number;
  archiveInventoryMaxScanRequests: number;
  archiveStorageOperationTimeoutMs: number;
  archiveTemporaryPartRetentionMs: number;
  archiveGcMaxScanRows: number;
  /** Separate destructive-operation rollout gate; defaults off. */
  archiveTemporaryPartGcEnabled: boolean;
}

export const DEFAULT_AGENTHOST_RUNTIME_IMAGE = 'ghcr.io/dundas/agenthost:latest';
export const DEFAULT_AGENTHOST_RUNTIME_PORT = 8787;
export const DEFAULT_AGENTHOST_RUNTIME_HEALTH_PATH = '/health';
export const DEFAULT_AGENTHOST_RUNTIME_HEALTH_INTERVAL_SECONDS = 5;
export const DEFAULT_AGENTHOST_RUNTIME_HEALTH_TIMEOUT_SECONDS = 2;
export const DEFAULT_AGENTHOST_RUNTIME_CPU = 'shared-1';
export const DEFAULT_AGENTHOST_RUNTIME_MEMORY_MB = 2048;
/** 5 minutes in ms. Matches DEFAULT_STALE_AFTER_MS in health-store.ts (the two must stay in sync). Override via AGENTBOOTUP_HEALTH_STALE_AFTER_SECONDS env var (PRD-0039 FR-12). */
export const DEFAULT_HEALTH_STALE_AFTER_MS = 5 * 60 * 1000;
export const DEFAULT_ARCHIVE_MAX_PART_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ARCHIVE_MAX_PARTS = 4096;
export const DEFAULT_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_ARCHIVE_INVENTORY_PAGE_SIZE = 100;
export const DEFAULT_ARCHIVE_INVENTORY_MAX_PAGE_SIZE = 500;
export const DEFAULT_ARCHIVE_MAX_CONCURRENT_COMMITS = 2;
export const DEFAULT_ARCHIVE_COMMIT_BYTE_BUDGET = 1536 * 1024 * 1024;
export const DEFAULT_ARCHIVE_MAX_PENDING_COMMITS = 32;
export const DEFAULT_ARCHIVE_INVENTORY_MAX_SCAN_ROWS = 100_000;
export const DEFAULT_ARCHIVE_INVENTORY_MAX_SCAN_REQUESTS = 1_000;
export const DEFAULT_ARCHIVE_STORAGE_OPERATION_TIMEOUT_MS = 30_000;
export const DEFAULT_ARCHIVE_TEMPORARY_PART_RETENTION_SECONDS = 24 * 60 * 60;
export const DEFAULT_ARCHIVE_GC_MAX_SCAN_ROWS = 100_000;
export const DEFAULT_MECH_MAX_ENUMERATION_RECORDS = 100_000;
// Keep server-side headroom above the client's 30s fetch deadline so request
// upload/parsing and response delivery cannot lose an otherwise completed push.
export const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = 60;
export const DEFAULT_REMOTE_LOCAL_PREFLIGHT_IDLE_TIMEOUT_SECONDS = 90;
export const DEFAULT_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES = 1024;
export const DEFAULT_REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS = 30_000;
export {
  DEFAULT_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
  MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
  MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS,
};
export const DEFAULT_REMOTE_LOCAL_MAX_CONNECTIONS = 128;
export const DEFAULT_REMOTE_LOCAL_TURN_ATTEMPTS_PER_MINUTE = 24;
export const DEFAULT_REMOTE_LOCAL_MAX_RATE_KEYS = 4_096;
export const DEFAULT_REMOTE_LOCAL_TURN_ARM_TIMEOUT_MS = 30_000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoundedPositiveInt(value: string | undefined, fallback: number, maximum: number): number {
  return Math.min(parsePositiveInt(value, fallback), maximum);
}

function parseBoundedNonNegativeInt(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback;
}

function resolveArchiveReceiptSecret(enabled: boolean): string | null {
  const configured = process.env.AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET?.trim();
  if (configured) {
    if (Buffer.byteLength(configured, 'utf8') < 32) {
      throw new Error('AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET must be at least 32 bytes');
    }
    return configured;
  }
  if (!enabled) return null;
  throw new Error('Missing required environment variable: AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET');
}

function resolveAuthSecret(): string | null {
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error('AUTH_SECRET must be at least 32 characters when set');
    }
    return fromEnv;
  }
  if (process.env.NODE_ENV === 'test' || process.env.BUN_TEST === '1') {
    return 'dev-only-auth-secret-32-chars-min!!';
  }
  if (process.env.AGENTBOOTUP_AUTH_DEV_MODE === '1') {
    const nodeEnv = (process.env.NODE_ENV ?? '').toLowerCase();
    const safeForDevMode = !nodeEnv || nodeEnv === 'development';
    if (!safeForDevMode) {
      throw new Error('AGENTBOOTUP_AUTH_DEV_MODE is only allowed when NODE_ENV is unset or development');
    }
    return 'dev-only-auth-secret-32-chars-min!!';
  }
  return null;
}

function resolvePublicBaseUrl(port: number): string {
  const fromEnv = process.env.AGENTBOOTUP_PUBLIC_BASE_URL?.trim()
    || process.env.BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return `http://localhost:${port}`;
}

function resolveBrainAuthorizationConfig(): Pick<ServerConfig,
  'brainAuthorizationMode' | 'brainAuthorizationBootstrapCohort' | 'brainAuthorizationAdapterIdentity' | 'brainAuthorizationAdapterVersion'> {
  const rawMode = process.env.AGENTBOOTUP_BRAIN_AUTHORITY_MODE?.trim() || 'disabled';
  if (rawMode !== 'disabled' && rawMode !== 'durable') throw new Error('AGENTBOOTUP_BRAIN_AUTHORITY_MODE must be disabled or durable');
  if (rawMode === 'disabled') return {
    brainAuthorizationMode: 'disabled', brainAuthorizationBootstrapCohort: [],
    brainAuthorizationAdapterIdentity: null, brainAuthorizationAdapterVersion: null,
  };
  let value: unknown;
  try { value = JSON.parse(process.env.AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT ?? ''); }
  catch { throw new Error('AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT must be valid JSON'); }
  const validMemberId = (candidate: unknown) => typeof candidate === 'string' && candidate.length > 0
    && candidate.length <= BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH && candidate.trim() === candidate
    && !/[\u0000-\u001f\u007f]/.test(candidate);
  if (!Array.isArray(value) || value.length === 0 || value.length > BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX || value.some((member) => !member || typeof member !== 'object' || Array.isArray(member)
    || Object.keys(member).sort().join(',') !== 'brainId,ownerPrincipalId'
    || !validMemberId(member.brainId) || !validMemberId(member.ownerPrincipalId))) {
    throw new Error('AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT must be a non-empty exact owner cohort');
  }
  if (new Set(value.map((member) => member.brainId)).size !== value.length) {
    throw new Error('AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT must not contain duplicate or conflicting brains');
  }
  const adapterIdentity = process.env.AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_IDENTITY?.trim();
  const adapterVersion = process.env.AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_VERSION?.trim();
  if (!adapterIdentity || !adapterVersion) throw new Error('Durable brain authority requires adapter identity and version');
  return {
    brainAuthorizationMode: 'durable',
    brainAuthorizationBootstrapCohort: value as { brainId: string; ownerPrincipalId: string }[],
    brainAuthorizationAdapterIdentity: adapterIdentity,
    brainAuthorizationAdapterVersion: adapterVersion,
  };
}

function resolveRemoteLocalPreflightConfig(): Pick<ServerConfig, 'remoteLocalPreflightEnabled' | 'remoteLocalPreflightToken' | 'remoteLocalPreflightIdleTimeoutSeconds' | 'remoteLocalPreflightMaxPayloadBytes'> {
  const enabled = process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_ENABLED?.trim() === '1';
  const idleTimeoutSeconds = parseBoundedPositiveInt(process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_IDLE_TIMEOUT_SECONDS, DEFAULT_REMOTE_LOCAL_PREFLIGHT_IDLE_TIMEOUT_SECONDS, 120);
  const maxPayloadBytes = parseBoundedPositiveInt(process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES, DEFAULT_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES, 4096);
  if (enabled && maxPayloadBytes < REMOTE_LOCAL_PREFLIGHT_MIN_PAYLOAD_BYTES) throw new Error('AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES must fit the required heartbeat frame');
  const token = process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_TOKEN?.trim() || null;
  if (enabled && (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token))) throw new Error('AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_TOKEN must be 32-128 base64url characters when preflight is enabled');
  return { remoteLocalPreflightEnabled: enabled, remoteLocalPreflightToken: enabled ? token : null, remoteLocalPreflightIdleTimeoutSeconds: idleTimeoutSeconds, remoteLocalPreflightMaxPayloadBytes: maxPayloadBytes };
}

function resolveRemoteLocalAdmissionConfig(): Pick<ServerConfig, 'remoteLocalAdmissionEnabled' | 'remoteLocalAdmissionInitialDeadlineMs' | 'remoteLocalInitialCredentialTtlMs'> {
  const enabled = process.env.AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_ENABLED?.trim() === '1';
  const initialDeadlineMs = parseBoundedPositiveInt(
    process.env.AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS,
    DEFAULT_REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS,
    60_000,
  );
  if (enabled && initialDeadlineMs < 1_000) throw new Error('AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS must be 1000-60000 when admission is enabled');
  const rawCredentialTtl = process.env.AGENTBOOTUP_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS;
  const initialCredentialTtlMs = rawCredentialTtl === undefined
    ? DEFAULT_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS
    : (/^[0-9]+$/.test(rawCredentialTtl) ? Number(rawCredentialTtl) : NaN);
  if (!Number.isSafeInteger(initialCredentialTtlMs)
    || initialCredentialTtlMs < MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS
    || initialCredentialTtlMs > MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS) {
    throw new Error('AGENTBOOTUP_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS must be an integer between 3600000 and 2592000000');
  }
  return { remoteLocalAdmissionEnabled: enabled, remoteLocalAdmissionInitialDeadlineMs: initialDeadlineMs, remoteLocalInitialCredentialTtlMs: initialCredentialTtlMs };
}

function resolveRemoteLocalOperationsConfig(): Pick<ServerConfig, 'remoteLocalOperationsEnabled' | 'remoteLocalMaxConnections' | 'remoteLocalTurnAttemptsPerMinute' | 'remoteLocalMaxRateKeys' | 'remoteLocalTurnArmTimeoutMs'> {
  return {
    remoteLocalOperationsEnabled: process.env.AGENTBOOTUP_REMOTE_LOCAL_OPERATIONS_ENABLED?.trim() === '1',
    remoteLocalMaxConnections: parseBoundedPositiveInt(process.env.AGENTBOOTUP_REMOTE_LOCAL_MAX_CONNECTIONS, DEFAULT_REMOTE_LOCAL_MAX_CONNECTIONS, 4_096),
    remoteLocalTurnAttemptsPerMinute: parseBoundedPositiveInt(process.env.AGENTBOOTUP_REMOTE_LOCAL_TURN_ATTEMPTS_PER_MINUTE, DEFAULT_REMOTE_LOCAL_TURN_ATTEMPTS_PER_MINUTE, 1_000),
    remoteLocalMaxRateKeys: parseBoundedPositiveInt(process.env.AGENTBOOTUP_REMOTE_LOCAL_MAX_RATE_KEYS, DEFAULT_REMOTE_LOCAL_MAX_RATE_KEYS, 100_000),
    remoteLocalTurnArmTimeoutMs: parseBoundedPositiveInt(process.env.AGENTBOOTUP_REMOTE_LOCAL_TURN_ARM_TIMEOUT_MS, DEFAULT_REMOTE_LOCAL_TURN_ARM_TIMEOUT_MS, 300_000),
  };
}

export function resolveConfig(): ServerConfig {
  const port = parsePort(process.env.PORT, 3000);
  const isProduction = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
  const apiKey = requireEnv('AGENTBOOTUP_API_KEY');
  const archiveEnabled = process.env.AGENTBOOTUP_ARCHIVE_ENABLED?.trim() === '1';
  const brainAuthorization = resolveBrainAuthorizationConfig();
  const remoteLocalPreflight = resolveRemoteLocalPreflightConfig();
  const remoteLocalAdmission = resolveRemoteLocalAdmissionConfig();
  const remoteLocalOperations = resolveRemoteLocalOperationsConfig();
  if (remoteLocalAdmission.remoteLocalAdmissionEnabled && brainAuthorization.brainAuthorizationMode !== 'durable') {
    throw new Error('AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_ENABLED requires durable brain authority');
  }
  if (remoteLocalOperations.remoteLocalOperationsEnabled && (!remoteLocalAdmission.remoteLocalAdmissionEnabled || brainAuthorization.brainAuthorizationMode !== 'durable')) {
    throw new Error('AGENTBOOTUP_REMOTE_LOCAL_OPERATIONS_ENABLED requires enabled durable remote-local admission');
  }
  const archiveInventoryMaxPageSize = parseBoundedPositiveInt(
    process.env.AGENTBOOTUP_ARCHIVE_INVENTORY_MAX_PAGE_SIZE,
    DEFAULT_ARCHIVE_INVENTORY_MAX_PAGE_SIZE,
    1000,
  );
  const archiveCommitByteBudget = parseBoundedPositiveInt(
    process.env.AGENTBOOTUP_ARCHIVE_COMMIT_BYTE_BUDGET, DEFAULT_ARCHIVE_COMMIT_BYTE_BUDGET, 2_000_000_000,
  );
  const archiveMaxBytes = Math.min(parseBoundedPositiveInt(
    process.env.AGENTBOOTUP_ARCHIVE_MAX_BYTES, DEFAULT_ARCHIVE_MAX_BYTES, 256 * 1024 * 1024,
  ), Math.floor(archiveCommitByteBudget / 3));
  const requestedConcurrentCommits = parseBoundedPositiveInt(
    process.env.AGENTBOOTUP_ARCHIVE_MAX_CONCURRENT_COMMITS, DEFAULT_ARCHIVE_MAX_CONCURRENT_COMMITS, 4,
  );
  return {
    port,
    host: process.env.HOST || '0.0.0.0',
    serverIdleTimeoutSeconds: parseBoundedPositiveInt(
      process.env.AGENTBOOTUP_SERVER_IDLE_TIMEOUT_SECONDS,
      DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
      120,
    ),
    ...remoteLocalPreflight,
    ...remoteLocalAdmission,
    ...remoteLocalOperations,
    apiKey,
    authSecret: resolveAuthSecret(),
    publicBaseUrl: resolvePublicBaseUrl(port),
    isProduction,
    externalApiKeyPrefix: process.env.AGENTBOOTUP_EXTERNAL_KEY_PREFIX?.trim() || EXTERNAL_API_KEY_PREFIX,
    deviceAuthGrantTtlSeconds: parsePositiveInt(
      process.env.AGENTBOOTUP_DEVICE_AUTH_TTL_SECONDS,
      DEFAULT_DEVICE_AUTH_GRANT_TTL_SECONDS,
    ),
    deviceAuthRateLimitPerMinute: parsePositiveInt(
      process.env.AGENTBOOTUP_DEVICE_AUTH_RATE_LIMIT_PER_MINUTE,
      DEFAULT_DEVICE_AUTH_RATE_LIMIT_PER_MINUTE,
    ),
    externalMaxActiveKeysPerUser: parsePositiveInt(
      process.env.AGENTBOOTUP_EXTERNAL_MAX_KEYS_PER_USER,
      EXTERNAL_MAX_ACTIVE_KEYS_PER_USER,
    ),
    externalRateLimitPerMinute: parsePositiveInt(
      process.env.AGENTBOOTUP_EXTERNAL_RATE_LIMIT_PER_MINUTE,
      EXTERNAL_RATE_LIMIT_PER_MINUTE,
    ),
    mechStorageUrl: process.env.MECH_STORAGE_URL || 'https://storage.mechdna.net',
    mechVaultUrl: process.env.MECH_VAULT_URL || 'https://vault.mechdna.net',
    mechAppId: requireEnv('MECH_APP_ID'),
    mechApiKey: requireEnv('MECH_API_KEY'),
    mechApiSecret: requireEnv('MECH_API_SECRET'),
    ...brainAuthorization,
    mechMaxEnumerationRecords: parseBoundedPositiveInt(
      process.env.MECH_MAX_ENUMERATION_RECORDS,
      DEFAULT_MECH_MAX_ENUMERATION_RECORDS,
      1_000_000,
    ),
    mechReadRetryAttempts: parseBoundedNonNegativeInt(
      process.env.MECH_READ_RETRY_ATTEMPTS,
      DEFAULT_MECH_READ_RETRY_ATTEMPTS,
      3,
    ),
    mechReadRetryMaxDelayMs: parseBoundedNonNegativeInt(
      process.env.MECH_READ_RETRY_MAX_DELAY_MS,
      DEFAULT_MECH_READ_RETRY_MAX_DELAY_MS,
      30_000,
    ),
    agentHostRuntimeImage: process.env.AGENTHOST_RUNTIME_IMAGE || DEFAULT_AGENTHOST_RUNTIME_IMAGE,
    agentHostRuntimePort: parsePort(process.env.AGENTHOST_RUNTIME_PORT, DEFAULT_AGENTHOST_RUNTIME_PORT),
    agentHostRuntimeHealthPath: process.env.AGENTHOST_RUNTIME_HEALTH_PATH || DEFAULT_AGENTHOST_RUNTIME_HEALTH_PATH,
    agentHostRuntimeHealthIntervalSeconds: parsePositiveInt(
      process.env.AGENTHOST_RUNTIME_HEALTH_INTERVAL_SECONDS,
      DEFAULT_AGENTHOST_RUNTIME_HEALTH_INTERVAL_SECONDS,
    ),
    agentHostRuntimeHealthTimeoutSeconds: parsePositiveInt(
      process.env.AGENTHOST_RUNTIME_HEALTH_TIMEOUT_SECONDS,
      DEFAULT_AGENTHOST_RUNTIME_HEALTH_TIMEOUT_SECONDS,
    ),
    agentHostRuntimeCpu: process.env.AGENTHOST_RUNTIME_CPU || DEFAULT_AGENTHOST_RUNTIME_CPU,
    agentHostRuntimeMemoryMb: parsePositiveInt(process.env.AGENTHOST_RUNTIME_MEMORY_MB, DEFAULT_AGENTHOST_RUNTIME_MEMORY_MB),
    // Env var unit: SECONDS (operator-friendly). Stored as ms (consistent with
    // DEFAULT_STALE_AFTER_MS in health-store.ts). parsePositiveInt returns the fallback
    // (DEFAULT_HEALTH_STALE_AFTER_MS / 1000 = 300) when unset or invalid, then * 1000.
    healthStaleAfterMs: parsePositiveInt(process.env.AGENTBOOTUP_HEALTH_STALE_AFTER_SECONDS, DEFAULT_HEALTH_STALE_AFTER_MS / 1000) * 1000,
    archiveEnabled,
    // Receipt verification must survive admin-key rotation. The archive surface is
    // explicit opt-in; once enabled, independent stable key material is mandatory.
    archiveReceiptSecret: resolveArchiveReceiptSecret(archiveEnabled),
    archiveReceiptKeyId: process.env.AGENTBOOTUP_ARCHIVE_RECEIPT_KEY_ID?.trim() || 'server-primary',
    archiveMaxPartBytes: Math.min(
      parseBoundedPositiveInt(process.env.AGENTBOOTUP_ARCHIVE_MAX_PART_BYTES, DEFAULT_ARCHIVE_MAX_PART_BYTES, 6 * 1024 * 1024),
      archiveMaxBytes,
    ),
    archiveMaxParts: parseBoundedPositiveInt(process.env.AGENTBOOTUP_ARCHIVE_MAX_PARTS, DEFAULT_ARCHIVE_MAX_PARTS, 10_000),
    archiveMaxBytes,
    archiveInventoryPageSize: Math.min(
      parsePositiveInt(process.env.AGENTBOOTUP_ARCHIVE_INVENTORY_PAGE_SIZE, DEFAULT_ARCHIVE_INVENTORY_PAGE_SIZE),
      archiveInventoryMaxPageSize,
    ),
    archiveInventoryMaxPageSize,
    archiveMaxConcurrentCommits: Math.max(1, Math.min(requestedConcurrentCommits, Math.floor(archiveCommitByteBudget / (archiveMaxBytes * 3)))),
    archiveCommitByteBudget,
    archiveMaxPendingCommits: parseBoundedPositiveInt(
      process.env.AGENTBOOTUP_ARCHIVE_MAX_PENDING_COMMITS, DEFAULT_ARCHIVE_MAX_PENDING_COMMITS, 128,
    ),
    archiveInventoryMaxScanRows: parseBoundedPositiveInt(
      process.env.AGENTBOOTUP_ARCHIVE_INVENTORY_MAX_SCAN_ROWS, DEFAULT_ARCHIVE_INVENTORY_MAX_SCAN_ROWS, 1_000_000,
    ),
    archiveInventoryMaxScanRequests: parseBoundedPositiveInt(
      process.env.AGENTBOOTUP_ARCHIVE_INVENTORY_MAX_SCAN_REQUESTS, DEFAULT_ARCHIVE_INVENTORY_MAX_SCAN_REQUESTS, 10_000,
    ),
    archiveStorageOperationTimeoutMs: parseBoundedPositiveInt(
      process.env.AGENTBOOTUP_ARCHIVE_STORAGE_OPERATION_TIMEOUT_MS, DEFAULT_ARCHIVE_STORAGE_OPERATION_TIMEOUT_MS, 300_000,
    ),
    archiveTemporaryPartRetentionMs: parseBoundedPositiveInt(
      process.env.AGENTBOOTUP_ARCHIVE_TEMPORARY_PART_RETENTION_SECONDS,
      DEFAULT_ARCHIVE_TEMPORARY_PART_RETENTION_SECONDS,
      30 * 24 * 60 * 60,
    ) * 1_000,
    archiveGcMaxScanRows: parseBoundedPositiveInt(
      process.env.AGENTBOOTUP_ARCHIVE_GC_MAX_SCAN_ROWS, DEFAULT_ARCHIVE_GC_MAX_SCAN_ROWS, 1_000_000,
    ),
    archiveTemporaryPartGcEnabled: process.env.AGENTBOOTUP_ARCHIVE_TEMPORARY_PART_GC_ENABLED?.trim().toLowerCase() === 'true',
  };
}
