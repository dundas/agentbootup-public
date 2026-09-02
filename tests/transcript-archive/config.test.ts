import { expect, test } from 'bun:test';
import { ARCHIVE_LIMITS, resolveTranscriptArchiveConfig } from '../../lib/transcript-archive/config.js';

test('defaults keep capture, archive, consent, and retention independent and safe', () => {
  const config = resolveTranscriptArchiveConfig({});
  expect(config).toMatchObject({ capture: 'manual', archive: { enabled: false }, consent: { upload: 'ask' }, localRetention: { mode: 'keep_all', minClosedAgeHours: 24 } });
  expect(config.limits).toEqual(ARCHIVE_LIMITS);
});

test('central limits are configurable without weakening deletion defaults', () => {
  const config = resolveTranscriptArchiveConfig({ transcripts: { archive: { enabled: true }, limits: { snapshotMaxAttempts: 7, verifierTimeoutMs: 2500, verifierConcurrency: 4 } } });
  expect(config.archive.enabled).toBe(true);
  expect(config.limits.snapshotMaxAttempts).toBe(7);
  expect(config.limits.verifierTimeoutMs).toBe(2500);
  expect(config.limits.verifierConcurrency).toBe(4);
  expect(config.localRetention.mode).toBe('keep_all');
  expect(Object.isFrozen(config) && Object.isFrozen(config.limits) && Object.isFrozen(config.archive)).toBe(true);
});

test('configured limits and retention reject invalid or unsafe ranges visibly', () => {
  for (const config of [
    { transcripts: { limits: { uploadConcurrency: 0 } } },
    { transcripts: { limits: { requestByteLimit: Number.MAX_SAFE_INTEGER } } },
    { transcripts: { limits: { retryBaseMs: 1.5 } } },
    { transcripts: { limits: { verifierTimeoutMs: 10_000, lockTimeoutMs: 20_000 } } },
    { transcripts: { limits: { verifierTimeoutMs: 10_000, verificationSweepTimeoutMs: 20_000 } } },
    { transcripts: { limits: { verificationSweepTimeoutMs: 120_000, verificationSweepMaxTimeoutMs: 119_999 } } },
    { transcripts: { limits: { verifierTimeoutMs: 10_000, staleLockMs: 20_000 } } },
    { transcripts: { limits: { staleLockMs: 60_000, lockTimeoutMs: 60_000 } } },
    { transcripts: { localRetention: { minClosedAgeHours: -1 } } },
    { transcripts: { limits: { uploadConcurency: 1 } } },
    { transcripts: { capture: 'continous' } },
    { transcripts: { archive: { enabled: 'yes' } } },
    { transcripts: { localRetention: { mode: 'delete_all' } } },
  ]) expect(() => resolveTranscriptArchiveConfig(config)).toThrow(/invalid transcript/i);
});

test('every central limit has a safe configurable integer default', () => {
  const config = resolveTranscriptArchiveConfig({});
  expect(Object.keys(config.limits).sort()).toEqual(Object.keys(ARCHIVE_LIMITS).sort());
  for (const value of Object.values(config.limits)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
});

test('configuration rejects dangerous and non-plain transcript subtrees', () => {
  expect(() => resolveTranscriptArchiveConfig(JSON.parse('{"transcripts":{"__proto__":{"polluted":true},"capture":"manual"}}'))).toThrow(/unknown setting/i);
  expect(() => resolveTranscriptArchiveConfig({ transcripts: Object.create(null) })).toThrow(/plain object/i);
  expect(({} as any).polluted).toBeUndefined();
});
