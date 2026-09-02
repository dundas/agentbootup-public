import { test, expect, describe } from 'bun:test';
import { BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX, BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH, DEFAULT_HEALTH_STALE_AFTER_MS, DEFAULT_REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS, DEFAULT_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS, DEFAULT_REMOTE_LOCAL_PREFLIGHT_IDLE_TIMEOUT_SECONDS, DEFAULT_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES, DEFAULT_REMOTE_LOCAL_TURN_ARM_TIMEOUT_MS, DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS, MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS, MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS, resolveConfig } from '../config';
import { DEFAULT_STALE_AFTER_MS } from '../lib/health-store';

// Tests for the stale-window config field (FR-12 / PRD-0039).
// We test the constant directly and the parsePositiveInt helper's behavior
// (which governs the env-var → ms conversion) rather than calling resolveConfig()
// end-to-end — resolveConfig requires live required-env vars (API keys) and is
// exercised by integration tests.

describe('DEFAULT_HEALTH_STALE_AFTER_MS (FR-12)', () => {
  test('is 5 minutes in ms — matches DEFAULT_STALE_AFTER_MS in health-store.ts', () => {
    expect(DEFAULT_HEALTH_STALE_AFTER_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_HEALTH_STALE_AFTER_MS).toBe(300_000);
  });
  // Machine-checked sync guard: config.ts and health-store.ts must agree on the default.
  // A silent divergence would make the env-override and the no-override code paths disagree.
  test('equals DEFAULT_STALE_AFTER_MS from health-store.ts (sync guard)', () => {
    expect(DEFAULT_HEALTH_STALE_AFTER_MS).toBe(DEFAULT_STALE_AFTER_MS);
  });
});

// Test the seconds→ms conversion logic in isolation (mirrors what resolveConfig does).
function parseStaleWindowMs(envValue: string | undefined, defaultMs: number): number {
  if (!envValue) return defaultMs;
  const parsed = parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  return parsed * 1000;
}

describe('stale window env parsing (FR-12 — mirrors resolveConfig logic)', () => {
  test('unset → default 300 000 ms', () => {
    expect(parseStaleWindowMs(undefined, DEFAULT_HEALTH_STALE_AFTER_MS)).toBe(300_000);
  });
  test('valid integer seconds → correct ms', () => {
    expect(parseStaleWindowMs('30', DEFAULT_HEALTH_STALE_AFTER_MS)).toBe(30_000);
    expect(parseStaleWindowMs('120', DEFAULT_HEALTH_STALE_AFTER_MS)).toBe(120_000);
  });
  test('0 → default (parsePositiveInt rejects ≤0)', () => {
    expect(parseStaleWindowMs('0', DEFAULT_HEALTH_STALE_AFTER_MS)).toBe(300_000);
  });
  test('negative → default', () => {
    expect(parseStaleWindowMs('-60', DEFAULT_HEALTH_STALE_AFTER_MS)).toBe(300_000);
  });
  test('float truncated to integer seconds (parseInt behavior)', () => {
    expect(parseStaleWindowMs('45.9', DEFAULT_HEALTH_STALE_AFTER_MS)).toBe(45_000);
  });
  test('non-numeric → default', () => {
    expect(parseStaleWindowMs('abc', DEFAULT_HEALTH_STALE_AFTER_MS)).toBe(300_000);
  });
});

describe('resolveConfig auth secret validation', () => {
  test('brain authority defaults off and durable selection requires an exact explicit cohort', () => {
    const names = ['AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET',
      'AGENTBOOTUP_BRAIN_AUTHORITY_MODE', 'AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT',
      'AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_IDENTITY', 'AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_VERSION'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret' });
    try {
      for (const name of names.slice(4)) delete process.env[name];
      expect(resolveConfig()).toMatchObject({ brainAuthorizationMode: 'disabled', brainAuthorizationBootstrapCohort: [] });
      process.env.AGENTBOOTUP_BRAIN_AUTHORITY_MODE = 'durable';
      expect(() => resolveConfig()).toThrow('BOOTSTRAP_COHORT');
      process.env.AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT = JSON.stringify([{ brainId: 'brain-a', ownerPrincipalId: 'user-a' }]);
      process.env.AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_IDENTITY = 'circle-agent';
      process.env.AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_VERSION = '1';
      expect(resolveConfig()).toMatchObject({ brainAuthorizationMode: 'durable', brainAuthorizationBootstrapCohort: [{ brainId: 'brain-a', ownerPrincipalId: 'user-a' }] });
    } finally {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });

  test('brain authority config accepts the cohort maximum and rejects max plus one and oversized identifiers', () => {
    const names = ['AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET', 'AGENTBOOTUP_BRAIN_AUTHORITY_MODE', 'AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT', 'AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_IDENTITY', 'AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_VERSION'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret', AGENTBOOTUP_BRAIN_AUTHORITY_MODE: 'durable', AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_IDENTITY: 'circle-agent', AGENTBOOTUP_BRAIN_AUTHORITY_ADAPTER_VERSION: '1' });
    const atMax = Array.from({ length: BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX }, (_, index) => ({ brainId: `brain-${index}`, ownerPrincipalId: `user-${index}` }));
    try {
      process.env.AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT = JSON.stringify(atMax);
      expect(resolveConfig().brainAuthorizationBootstrapCohort).toHaveLength(BRAIN_AUTHORIZATION_BOOTSTRAP_COHORT_MAX);
      process.env.AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT = JSON.stringify([{ brainId: 'b'.repeat(BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH), ownerPrincipalId: 'user-a' }]);
      expect(resolveConfig().brainAuthorizationBootstrapCohort[0]?.brainId).toHaveLength(BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH);
      process.env.AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT = JSON.stringify([...atMax, { brainId: 'extra', ownerPrincipalId: 'extra' }]);
      expect(() => resolveConfig()).toThrow('BOOTSTRAP_COHORT');
      process.env.AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT = JSON.stringify([{ brainId: 'b'.repeat(BRAIN_AUTHORIZATION_BOOTSTRAP_MEMBER_ID_MAX_LENGTH + 1), ownerPrincipalId: 'user-a' }]);
      expect(() => resolveConfig()).toThrow('BOOTSTRAP_COHORT');
      process.env.AGENTBOOTUP_BRAIN_AUTHORITY_BOOTSTRAP_COHORT = JSON.stringify([{ brainId: 'brain-a', ownerPrincipalId: 'user-a' }, { brainId: 'brain-a', ownerPrincipalId: 'user-b' }]);
      expect(() => resolveConfig()).toThrow('duplicate or conflicting');
    } finally {
      for (const name of names) prior[name] === undefined ? delete process.env[name] : process.env[name] = prior[name];
    }
  });

  test('server idle timeout covers bounded brain asset pushes and stays operator-configurable', () => {
    const names = ['AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET',
      'AGENTBOOTUP_SERVER_IDLE_TIMEOUT_SECONDS'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      AGENTBOOTUP_API_KEY: 'admin-key',
      MECH_APP_ID: 'app',
      MECH_API_KEY: 'key',
      MECH_API_SECRET: 'secret',
    });
    try {
      delete process.env.AGENTBOOTUP_SERVER_IDLE_TIMEOUT_SECONDS;
      expect(resolveConfig().serverIdleTimeoutSeconds).toBe(DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS);
      process.env.AGENTBOOTUP_SERVER_IDLE_TIMEOUT_SECONDS = '45';
      expect(resolveConfig().serverIdleTimeoutSeconds).toBe(45);
      process.env.AGENTBOOTUP_SERVER_IDLE_TIMEOUT_SECONDS = '999';
      expect(resolveConfig().serverIdleTimeoutSeconds).toBe(120);
    } finally {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });

  test('remote-local preflight is default-off and requires an operator token only when enabled', () => {
    const names = ['AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET', 'AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_ENABLED', 'AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_TOKEN', 'AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret' });
    try {
      delete process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_ENABLED;
      delete process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_TOKEN;
      process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES = '1';
      expect(resolveConfig().remoteLocalPreflightEnabled).toBe(false);
      delete process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES;
      expect(resolveConfig()).toMatchObject({ remoteLocalPreflightEnabled: false, remoteLocalPreflightToken: null, remoteLocalPreflightIdleTimeoutSeconds: DEFAULT_REMOTE_LOCAL_PREFLIGHT_IDLE_TIMEOUT_SECONDS, remoteLocalPreflightMaxPayloadBytes: DEFAULT_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES });
      process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_ENABLED = '1';
      expect(() => resolveConfig()).toThrow('PREFLIGHT_TOKEN');
      process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_TOKEN = 't'.repeat(32);
      expect(resolveConfig()).toMatchObject({ remoteLocalPreflightEnabled: true, remoteLocalPreflightToken: 't'.repeat(32) });
      process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_TOKEN = `${'t'.repeat(31)},x`;
      expect(() => resolveConfig()).toThrow('PREFLIGHT_TOKEN');
      process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_TOKEN = 't'.repeat(32);
      process.env.AGENTBOOTUP_REMOTE_LOCAL_PREFLIGHT_MAX_PAYLOAD_BYTES = '1';
      expect(() => resolveConfig()).toThrow('PREFLIGHT_MAX_PAYLOAD_BYTES');
    } finally {
      for (const name of names) prior[name] === undefined ? delete process.env[name] : process.env[name] = prior[name];
    }
  });

  test('remote-local connector admission is default-off and cannot enable without durable authority', () => {
    const names = ['AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET', 'AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_ENABLED', 'AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS', 'AGENTBOOTUP_REMOTE_LOCAL_OPERATIONS_ENABLED', 'AGENTBOOTUP_BRAIN_AUTHORITY_MODE'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret' });
    try {
      delete process.env.AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_ENABLED;
      delete process.env.AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS;
      delete process.env.AGENTBOOTUP_REMOTE_LOCAL_OPERATIONS_ENABLED;
      delete process.env.AGENTBOOTUP_BRAIN_AUTHORITY_MODE;
      expect(resolveConfig()).toMatchObject({ remoteLocalAdmissionEnabled: false, remoteLocalAdmissionInitialDeadlineMs: DEFAULT_REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS, remoteLocalOperationsEnabled: false });
      process.env.AGENTBOOTUP_REMOTE_LOCAL_OPERATIONS_ENABLED = '1';
      expect(() => resolveConfig()).toThrow('OPERATIONS_ENABLED requires enabled durable remote-local admission');
      delete process.env.AGENTBOOTUP_REMOTE_LOCAL_OPERATIONS_ENABLED;
      process.env.AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_ENABLED = '1';
      expect(() => resolveConfig()).toThrow('requires durable brain authority');
      process.env.AGENTBOOTUP_REMOTE_LOCAL_ADMISSION_INITIAL_DEADLINE_MS = '1';
      expect(() => resolveConfig()).toThrow('INITIAL_DEADLINE');
    } finally {
      for (const name of names) prior[name] === undefined ? delete process.env[name] : process.env[name] = prior[name];
    }
  });

  test('remote-local turn arming remains bounded and operator-configurable', () => {
    const names = ['AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET', 'AGENTBOOTUP_REMOTE_LOCAL_TURN_ARM_TIMEOUT_MS'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret' });
    try {
      delete process.env.AGENTBOOTUP_REMOTE_LOCAL_TURN_ARM_TIMEOUT_MS;
      expect(resolveConfig().remoteLocalTurnArmTimeoutMs).toBe(DEFAULT_REMOTE_LOCAL_TURN_ARM_TIMEOUT_MS);
      process.env.AGENTBOOTUP_REMOTE_LOCAL_TURN_ARM_TIMEOUT_MS = '45000';
      expect(resolveConfig().remoteLocalTurnArmTimeoutMs).toBe(45_000);
      process.env.AGENTBOOTUP_REMOTE_LOCAL_TURN_ARM_TIMEOUT_MS = '999999';
      expect(resolveConfig().remoteLocalTurnArmTimeoutMs).toBe(300_000);
    } finally {
      for (const name of names) prior[name] === undefined ? delete process.env[name] : process.env[name] = prior[name];
    }
  });

  test('initial remote-local credential lifetime is bounded, strict, and independent of the admission gate', () => {
    const names = ['AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET', 'AGENTBOOTUP_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret' });
    try {
      delete process.env.AGENTBOOTUP_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS;
      expect(resolveConfig()).toMatchObject({ remoteLocalAdmissionEnabled: false, remoteLocalInitialCredentialTtlMs: DEFAULT_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS });
      process.env.AGENTBOOTUP_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS = String(MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS);
      expect(resolveConfig().remoteLocalInitialCredentialTtlMs).toBe(MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS);
      process.env.AGENTBOOTUP_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS = String(MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS);
      expect(resolveConfig().remoteLocalInitialCredentialTtlMs).toBe(MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS);
      for (const value of ['', ' ', '1.5', 'not-a-number', String(MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS - 1), String(MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS + 1)]) {
        process.env.AGENTBOOTUP_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS = value;
        expect(() => resolveConfig()).toThrow('INITIAL_CREDENTIAL_TTL');
      }
    } finally {
      for (const name of names) prior[name] === undefined ? delete process.env[name] : process.env[name] = prior[name];
    }
  });

  test('generic Mech enumeration budget defaults high, is configurable, and is bounded', () => {
    const names = ['AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET',
      'MECH_MAX_ENUMERATION_RECORDS'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      AGENTBOOTUP_API_KEY: 'admin-key',
      MECH_APP_ID: 'app',
      MECH_API_KEY: 'key',
      MECH_API_SECRET: 'secret',
    });
    try {
      delete process.env.MECH_MAX_ENUMERATION_RECORDS;
      expect(resolveConfig().mechMaxEnumerationRecords).toBe(100_000);
      process.env.MECH_MAX_ENUMERATION_RECORDS = '125000';
      expect(resolveConfig().mechMaxEnumerationRecords).toBe(125_000);
      process.env.MECH_MAX_ENUMERATION_RECORDS = '999999999';
      expect(resolveConfig().mechMaxEnumerationRecords).toBe(1_000_000);
    } finally {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });

  test('read-only Mech throttle retry is bounded and can be disabled', () => {
    const names = ['AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET',
      'MECH_READ_RETRY_ATTEMPTS', 'MECH_READ_RETRY_MAX_DELAY_MS'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret',
    });
    try {
      delete process.env.MECH_READ_RETRY_ATTEMPTS;
      delete process.env.MECH_READ_RETRY_MAX_DELAY_MS;
      expect(resolveConfig()).toMatchObject({ mechReadRetryAttempts: 1, mechReadRetryMaxDelayMs: 15_000 });
      process.env.MECH_READ_RETRY_ATTEMPTS = '0';
      process.env.MECH_READ_RETRY_MAX_DELAY_MS = '25';
      expect(resolveConfig()).toMatchObject({ mechReadRetryAttempts: 0, mechReadRetryMaxDelayMs: 25 });
      process.env.MECH_READ_RETRY_ATTEMPTS = '99';
      process.env.MECH_READ_RETRY_MAX_DELAY_MS = '999999';
      expect(resolveConfig()).toMatchObject({ mechReadRetryAttempts: 1, mechReadRetryMaxDelayMs: 15_000 });
    } finally {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });

  test('archive maximums cannot imply multi-gigabyte concurrent assembly', () => {
    const names = ['NODE_ENV', 'AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET',
      'AGENTBOOTUP_ARCHIVE_ENABLED',
      'AGENTBOOTUP_ARCHIVE_MAX_BYTES', 'AGENTBOOTUP_ARCHIVE_MAX_PART_BYTES',
      'AGENTBOOTUP_ARCHIVE_MAX_CONCURRENT_COMMITS', 'AGENTBOOTUP_ARCHIVE_COMMIT_BYTE_BUDGET',
      'AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      NODE_ENV: 'test', AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret',
      AGENTBOOTUP_ARCHIVE_ENABLED: '1',
      AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET: 'test-only-stable-receipt-secret-32-bytes',
      AGENTBOOTUP_ARCHIVE_MAX_BYTES: String(4 * 1024 ** 3),
      AGENTBOOTUP_ARCHIVE_MAX_PART_BYTES: String(4 * 1024 ** 3),
      AGENTBOOTUP_ARCHIVE_MAX_CONCURRENT_COMMITS: '16',
      AGENTBOOTUP_ARCHIVE_COMMIT_BYTE_BUDGET: String(512 * 1024 ** 2),
    });
    try {
      const config = resolveConfig();
      expect(config.archiveMaxBytes).toBe(Math.floor(512 * 1024 ** 2 / 3));
      expect(config.archiveMaxPartBytes).toBe(6 * 1024 ** 2);
      expect(config.archiveMaxConcurrentCommits).toBe(1);
      expect(config.archiveMaxBytes * config.archiveMaxConcurrentCommits * 3).toBeLessThanOrEqual(config.archiveCommitByteBudget);
    } finally {
      for (const name of names) prior[name] === undefined ? delete process.env[name] : process.env[name] = prior[name]!;
    }
  });

  test('rejects AUTH_SECRET shorter than 32 characters', () => {
    const priorSecret = process.env.AUTH_SECRET;
    const priorApiKey = process.env.AGENTBOOTUP_API_KEY;
    process.env.AUTH_SECRET = 'x'.repeat(31);
    process.env.AGENTBOOTUP_API_KEY = 'test-admin-key';
    try {
      expect(() => resolveConfig()).toThrow('AUTH_SECRET must be at least 32 characters');
    } finally {
      if (priorSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = priorSecret;
      if (priorApiKey === undefined) delete process.env.AGENTBOOTUP_API_KEY;
      else process.env.AGENTBOOTUP_API_KEY = priorApiKey;
    }
  });

  test('enabled archive requires a dedicated stable receipt secret of at least 32 bytes', () => {
    const names = ['NODE_ENV', 'AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET',
      'AGENTBOOTUP_ARCHIVE_ENABLED', 'AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      NODE_ENV: 'test', AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret',
      AGENTBOOTUP_ARCHIVE_ENABLED: '1',
      AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET: 'short',
    });
    try {
      expect(() => resolveConfig()).toThrow('AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET must be at least 32 bytes');
      delete process.env.AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET;
      expect(() => resolveConfig()).toThrow('Missing required environment variable: AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET');
    } finally {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });

  test('disabled archive remains backward compatible without receipt key material', () => {
    const names = ['NODE_ENV', 'AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET',
      'AGENTBOOTUP_ARCHIVE_ENABLED', 'AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      NODE_ENV: 'test', AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret',
    });
    delete process.env.AGENTBOOTUP_ARCHIVE_ENABLED;
    delete process.env.AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET;
    try {
      expect(resolveConfig()).toMatchObject({ archiveEnabled: false, archiveReceiptSecret: null });
    } finally {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });

  test('temporary-part GC has a separate explicit default-off gate', () => {
    const names = ['NODE_ENV', 'AGENTBOOTUP_API_KEY', 'MECH_APP_ID', 'MECH_API_KEY', 'MECH_API_SECRET',
      'AGENTBOOTUP_ARCHIVE_ENABLED', 'AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET',
      'AGENTBOOTUP_ARCHIVE_TEMPORARY_PART_GC_ENABLED'] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      NODE_ENV: 'test', AGENTBOOTUP_API_KEY: 'admin-key', MECH_APP_ID: 'app', MECH_API_KEY: 'key', MECH_API_SECRET: 'secret',
    });
    delete process.env.AGENTBOOTUP_ARCHIVE_ENABLED;
    delete process.env.AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET;
    delete process.env.AGENTBOOTUP_ARCHIVE_TEMPORARY_PART_GC_ENABLED;
    try {
      expect(resolveConfig().archiveTemporaryPartGcEnabled).toBe(false);
      process.env.AGENTBOOTUP_ARCHIVE_TEMPORARY_PART_GC_ENABLED = 'TRUE';
      expect(resolveConfig().archiveTemporaryPartGcEnabled).toBe(true);
      process.env.AGENTBOOTUP_ARCHIVE_TEMPORARY_PART_GC_ENABLED = '1';
      expect(resolveConfig().archiveTemporaryPartGcEnabled).toBe(false);
    } finally {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });
});
