export const ARCHIVE_LIMITS = Object.freeze({
  snapshotMaxAttempts: 3,
  uploadConcurrency: 3,
  verifierConcurrency: 3,
  verificationSweepTimeoutMs: 120_000,
  verificationSweepMaxTimeoutMs: 21_600_000,
  requestByteLimit: 4 * 1024 * 1024,
  eligibilityByteLimit: 256 * 1024 * 1024,
  streamingFileByteLimit: 1024 * 1024 * 1024 * 1024,
  ledgerByteLimit: 64 * 1024 * 1024,
  retryLimit: 5,
  retryBaseMs: 500,
  verifierTimeoutMs: 10_000,
  lockTimeoutMs: 620_000,
  lockQueueTimeoutMs: 625_000,
  staleLockMs: 30_000,
  identityByteLimit: 1024 * 1024,
  discoveryMaxDepth: 8,
  discoveryMaxFailures: 256,
  inventoryMaxPages: 1_000,
  inventoryMaxItems: 100_000,
  inventoryMaxEmptyPages: 100,
  ledgerGenerationLimit: 256,
  ledgerAuditLimit: 1000,
  ledgerRestoreHistoryLimit: 1000,
  ledgerOffloadHistoryLimit: 1000,
});

export const ARCHIVE_LIMIT_RANGES = Object.freeze({
  snapshotMaxAttempts: [1, 20],
  uploadConcurrency: [1, 32],
  verifierConcurrency: [1, 32],
  verificationSweepTimeoutMs: [10, 1_800_000],
  verificationSweepMaxTimeoutMs: [10, 86_400_000],
  requestByteLimit: [64 * 1024, 64 * 1024 * 1024],
  eligibilityByteLimit: [64 * 1024, 16 * 1024 * 1024 * 1024],
  streamingFileByteLimit: [4 * 1024 * 1024, 16 * 1024 * 1024 * 1024 * 1024],
  ledgerByteLimit: [64 * 1024, 1024 * 1024 * 1024],
  retryLimit: [0, 20],
  retryBaseMs: [10, 60_000],
  verifierTimeoutMs: [10, 300_000],
  lockTimeoutMs: [1_020, 1_800_000],
  lockQueueTimeoutMs: [1_020, 1_800_000],
  staleLockMs: [1_020, 1_799_999],
  identityByteLimit: [4 * 1024, 64 * 1024 * 1024],
  discoveryMaxDepth: [1, 64],
  discoveryMaxFailures: [1, 10_000],
  inventoryMaxPages: [1, 100_000],
  inventoryMaxItems: [1, 10_000_000],
  inventoryMaxEmptyPages: [1, 10_000],
  ledgerGenerationLimit: [1, 100_000],
  ledgerAuditLimit: [1, 100_000],
  ledgerRestoreHistoryLimit: [1, 100_000],
  ledgerOffloadHistoryLimit: [1, 100_000],
});
export const MIN_CLOSED_AGE_HOURS_RANGE = Object.freeze([0, 24 * 365]);

export const TRANSCRIPT_ARCHIVE_DEFAULTS = Object.freeze({
  capture: 'manual',
  archive: Object.freeze({ enabled: false }),
  consent: Object.freeze({ upload: 'ask' }),
  localRetention: Object.freeze({ mode: 'keep_all', minClosedAgeHours: 24 }),
});

function boundedInteger(name, value, fallback, [minimum, maximum]) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`invalid transcript ${name}: expected an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function resolveArchiveLimit(name, value) {
  if (!Object.prototype.hasOwnProperty.call(ARCHIVE_LIMITS, name)) throw new TypeError(`unknown transcript archive limit: ${name}`);
  return boundedInteger(`limits.${name}`, value, ARCHIVE_LIMITS[name], ARCHIVE_LIMIT_RANGES[name]);
}

export function validateArchiveLimitRelationships(limits, verifierTimeoutMs = limits.verifierTimeoutMs) {
  const minimumVerifierBudget = verifierTimeoutMs * 2 + 1_000;
  if (limits.lockTimeoutMs < minimumVerifierBudget || limits.lockQueueTimeoutMs < minimumVerifierBudget) {
    throw new TypeError(`invalid transcript limits: archive lock timeouts must be at least ${minimumVerifierBudget}ms for the verifier budget`);
  }
  if (limits.verificationSweepTimeoutMs < minimumVerifierBudget) throw new TypeError(`invalid transcript limits: verificationSweepTimeoutMs must be at least ${minimumVerifierBudget}ms for one verifier batch`);
  if (limits.verificationSweepMaxTimeoutMs < limits.verificationSweepTimeoutMs) throw new TypeError('invalid transcript limits: verificationSweepMaxTimeoutMs must not be shorter than verificationSweepTimeoutMs');
  if (limits.staleLockMs < minimumVerifierBudget) throw new TypeError(`invalid transcript limits: staleLockMs must be at least ${minimumVerifierBudget}ms for one verifier batch`);
  if (limits.staleLockMs >= limits.lockTimeoutMs) throw new TypeError('invalid transcript limits: staleLockMs must be shorter than lockTimeoutMs so confirmed dead owners can be reclaimed');
}

function assertKnownKeys(value, allowed, name) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`invalid transcript ${name}: expected a plain object`);
  }
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`invalid transcript ${name}.${key}: unknown setting`);
  return value;
}

const limitKeys = Object.keys(ARCHIVE_LIMITS).sort();
const rangeKeys = Object.keys(ARCHIVE_LIMIT_RANGES).sort();
if (JSON.stringify(limitKeys) !== JSON.stringify(rangeKeys)) throw new Error('transcript archive limit defaults and ranges are inconsistent');
for (const key of limitKeys) {
  const [minimum, maximum] = ARCHIVE_LIMIT_RANGES[key];
  if (!Number.isSafeInteger(ARCHIVE_LIMITS[key]) || ARCHIVE_LIMITS[key] < minimum || ARCHIVE_LIMITS[key] > maximum) {
    throw new Error(`transcript archive default limit is out of range: ${key}`);
  }
}

export function resolveTranscriptArchiveConfig(config = {}) {
  // This resolver owns only the transcripts subtree of the application's
  // shared config object; sibling application settings are intentionally ignored.
  const input = assertKnownKeys(config?.transcripts, new Set(['capture', 'archive', 'consent', 'localRetention', 'limits']), 'configuration');
  const archive = assertKnownKeys(input.archive, new Set(['enabled']), 'archive');
  const consent = assertKnownKeys(input.consent, new Set(['upload']), 'consent');
  const localRetention = assertKnownKeys(input.localRetention, new Set(['mode', 'minClosedAgeHours']), 'localRetention');
  const limits = assertKnownKeys(input.limits, new Set(limitKeys), 'limits');
  if (input.capture !== undefined && !new Set(['manual', 'continuous']).has(input.capture)) throw new TypeError('invalid transcript capture: expected manual or continuous');
  if (archive.enabled !== undefined && typeof archive.enabled !== 'boolean') throw new TypeError('invalid transcript archive.enabled: expected boolean');
  if (consent.upload !== undefined && !new Set(['ask', 'granted']).has(consent.upload)) throw new TypeError('invalid transcript consent.upload: expected ask or granted');
  if (localRetention.mode !== undefined && localRetention.mode !== 'keep_all') throw new TypeError('invalid transcript localRetention.mode: only keep_all is supported');
  const resolvedLimits = Object.freeze(Object.fromEntries(Object.entries(ARCHIVE_LIMITS).map(([key, fallback]) => [key, boundedInteger(`limits.${key}`, limits[key], fallback, ARCHIVE_LIMIT_RANGES[key])])));
  validateArchiveLimitRelationships(resolvedLimits);
  return Object.freeze({
    capture: input.capture ?? TRANSCRIPT_ARCHIVE_DEFAULTS.capture,
    archive: Object.freeze({ enabled: archive.enabled ?? TRANSCRIPT_ARCHIVE_DEFAULTS.archive.enabled }),
    consent: Object.freeze({ upload: consent.upload ?? TRANSCRIPT_ARCHIVE_DEFAULTS.consent.upload }),
    localRetention: Object.freeze({
      mode: 'keep_all',
      minClosedAgeHours: boundedInteger('localRetention.minClosedAgeHours', localRetention.minClosedAgeHours, TRANSCRIPT_ARCHIVE_DEFAULTS.localRetention.minClosedAgeHours, MIN_CLOSED_AGE_HOURS_RANGE),
    }),
    limits: resolvedLimits,
  });
}
