import { test, expect, describe } from 'bun:test';
import {
  CHECK_NAMES,
  checkContribution,
  reduceHealthStatus,
  buildHealthRecord,
} from '../../lib/brain/health-record.js';

const allPass = () =>
  Object.fromEntries(CHECK_NAMES.map((n) => [n, { state: 'pass' }]));

describe('checkContribution', () => {
  test('pass → healthy', () => {
    expect(checkContribution('credentials_authenticate', { state: 'pass' })).toBe('healthy');
  });

  test('required unknown → degraded (never healthy)', () => {
    expect(checkContribution('runtime_resolves', { state: 'unknown' })).toBe('degraded');
  });

  test('extra (non-core) optional unknown → healthy', () => {
    expect(checkContribution('agentdrive_optional', { state: 'unknown', required: false })).toBe('healthy');
  });

  test('core check ignores required:false for unknown too (stays degraded)', () => {
    expect(checkContribution('messaging_round_trips', { state: 'unknown', required: false })).toBe('degraded');
  });

  test('credentials/identity/runtime fail → stuck', () => {
    expect(checkContribution('credentials_authenticate', { state: 'fail' })).toBe('stuck');
    expect(checkContribution('identity_materializes', { state: 'fail' })).toBe('stuck');
    expect(checkContribution('runtime_resolves', { state: 'fail' })).toBe('stuck');
  });

  test('messaging fail → degraded (runtime up, chat dead — AC-4)', () => {
    expect(checkContribution('messaging_round_trips', { state: 'fail' })).toBe('degraded');
  });

  test('core check ignores required:false — keystone cannot be downgraded (adversarial finding)', () => {
    // A revoked CORE credential must stay Stuck even if flagged optional.
    expect(checkContribution('credentials_authenticate', { state: 'fail', required: false })).toBe('stuck');
    expect(checkContribution('identity_materializes', { state: 'fail', required: false })).toBe('stuck');
  });

  test('an EXTRA (non-core) optional check failure caps at degraded', () => {
    expect(checkContribution('agentdrive_optional', { state: 'fail', required: false })).toBe('degraded');
  });

  test('unrecognized non-pass state is treated as fail, never implicit pass', () => {
    expect(checkContribution('runtime_resolves', { state: 'garbage' })).toBe('stuck');
  });
});

describe('reduceHealthStatus', () => {
  test('all four pass → healthy, no reason', () => {
    const r = reduceHealthStatus(allPass());
    expect(r.status).toBe('healthy');
    expect(r.reason).toBeNull();
  });

  test('revoked credential → stuck (AC-1: the dead-key class)', () => {
    const checks = { ...allPass(), credentials_authenticate: { state: 'fail', message: 'token did not authenticate' } };
    const r = reduceHealthStatus(checks);
    expect(r.status).toBe('stuck');
    expect(r.reason).toMatch(/credentials_authenticate fail/);
  });

  test('process-up but chat-dead → degraded (AC-4), not healthy, not stuck', () => {
    const checks = { ...allPass(), messaging_round_trips: { state: 'fail', message: 'chat API timeout' } };
    const r = reduceHealthStatus(checks);
    expect(r.status).toBe('degraded');
    expect(r.reason).toMatch(/messaging_round_trips fail/);
  });

  test('stuck beats degraded when both present', () => {
    const checks = {
      ...allPass(),
      messaging_round_trips: { state: 'fail' },
      runtime_resolves: { state: 'fail' },
    };
    expect(reduceHealthStatus(checks).status).toBe('stuck');
  });

  test('missing required check → unknown → degraded, never implicit pass', () => {
    const checks = {
      runtime_resolves: { state: 'pass' },
      identity_materializes: { state: 'pass' },
      credentials_authenticate: { state: 'pass' },
      // messaging_round_trips omitted entirely
    };
    const r = reduceHealthStatus(checks);
    expect(r.status).toBe('degraded');
    expect(r.checks.messaging_round_trips.state).toBe('unknown');
    expect(r.reason).toMatch(/messaging_round_trips unknown/);
  });

  test('unknown never yields healthy', () => {
    const checks = { ...allPass(), identity_materializes: { state: 'unknown' } };
    expect(reduceHealthStatus(checks).status).toBe('degraded');
  });

  test('stale report → stuck regardless of check states', () => {
    const r = reduceHealthStatus(allPass(), { stale: true });
    expect(r.status).toBe('stuck');
    expect(r.reason).toBe('report is stale');
  });

  test('custom requiredChecks cannot drop a core check (union, not replace)', () => {
    // Caller tries to scope to only runtime_resolves; the other 3 core checks must still
    // be normalized to unknown → degraded, never silently dropped.
    const r = reduceHealthStatus({ runtime_resolves: { state: 'pass' } }, { requiredChecks: ['runtime_resolves'] });
    expect(Object.keys(r.checks).sort()).toEqual([...CHECK_NAMES].sort());
    expect(r.status).toBe('degraded'); // the 3 missing core checks are unknown
  });

  test('extra non-required check passes through to normalized output', () => {
    const checks = { ...allPass(), agentdrive_optional: { state: 'pass', required: false } };
    const r = reduceHealthStatus(checks);
    expect(r.checks.agentdrive_optional).toEqual({ state: 'pass', required: false });
    expect(r.status).toBe('healthy');
  });

  test('malformed checks are normalized to {state:unknown} for shape consistency', () => {
    const r = reduceHealthStatus({ runtime_resolves: {}, weird_extra: null });
    expect(r.checks.runtime_resolves.state).toBe('unknown');
    expect(r.checks.weird_extra.state).toBe('unknown');
    expect(r.status).toBe('degraded'); // unknown core check, never implicit pass
  });

  test('two equal-precedence degraded checks → reason names the first encountered', () => {
    const checks = {
      runtime_resolves: { state: 'pass' },
      identity_materializes: { state: 'pass' },
      credentials_authenticate: { state: 'pass' },
      messaging_round_trips: { state: 'unknown', message: 'first' },
      extra_degrade: { state: 'fail', required: false, message: 'second' },
    };
    const r = reduceHealthStatus(checks);
    expect(r.status).toBe('degraded');
    expect(r.reason).toMatch(/messaging_round_trips unknown/); // first degraded contributor wins the reason
  });

  test('an EXTRA optional integration credential failure does not flip the agent to stuck (open Q3)', () => {
    // Open Q3 is about *extra* integration creds, NOT the core credentials_authenticate check.
    const checks = { ...allPass(), agentdrive_optional: { state: 'fail', required: false } };
    expect(reduceHealthStatus(checks, { requiredChecks: CHECK_NAMES }).status).toBe('degraded');
  });

  test('a core credential failure flagged optional still flips to stuck (keystone guard)', () => {
    const checks = { ...allPass(), credentials_authenticate: { state: 'fail', required: false } };
    expect(reduceHealthStatus(checks).status).toBe('stuck');
  });
});

describe('buildHealthRecord', () => {
  test('assembles the §4 record with normalized checks + reduced status', () => {
    const rec = buildHealthRecord({
      agent_id: 'brain-a',
      machine_id: 'mac-mini-1',
      environment: 'teleportation',
      ts: '2026-06-03T21:00:00Z',
      checks: { ...allPass(), credentials_authenticate: { state: 'fail', message: 'revoked' } },
    });
    expect(rec.agent_id).toBe('brain-a');
    expect(rec.machine_id).toBe('mac-mini-1');
    expect(rec.environment).toBe('teleportation');
    expect(rec.ts).toBe('2026-06-03T21:00:00Z');
    expect(rec.status).toBe('stuck');
    expect(rec.reason).toMatch(/credentials_authenticate fail/);
    expect(Object.keys(rec.checks).sort()).toEqual([...CHECK_NAMES].sort());
  });

  test('throws on missing required identifiers', () => {
    expect(() => buildHealthRecord({ machine_id: 'm', ts: 't' })).toThrow(/agent_id/);
    expect(() => buildHealthRecord({ agent_id: 'a', ts: 't' })).toThrow(/machine_id/);
    expect(() => buildHealthRecord({ agent_id: 'a', machine_id: 'm' })).toThrow(/ts/);
    expect(() => buildHealthRecord(null)).toThrow(/input object/);
  });
});
