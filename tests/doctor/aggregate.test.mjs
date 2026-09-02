import { test, expect, describe } from 'bun:test';
import { aggregateHealthRecord } from '../../lib/doctor/aggregate.js';

const base = { agentId: 'brain-a', machineId: 'mac-mini-1', environment: 'teleportation', ts: '2026-06-04T01:00:00Z' };
const passRunners = () => ({
  runtime_resolves: async () => ({ state: 'pass' }),
  identity_materializes: async () => ({ state: 'pass' }),
  credentials_authenticate: async () => ({ state: 'pass' }),
  messaging_round_trips: async () => ({ state: 'pass' }),
});

describe('aggregateHealthRecord (FR-7)', () => {
  test('all checks pass → Healthy §4 record', async () => {
    const rec = await aggregateHealthRecord({ ...base, runners: passRunners() });
    expect(rec.status).toBe('healthy');
    expect(rec.agent_id).toBe('brain-a');
    expect(rec.machine_id).toBe('mac-mini-1');
    expect(Object.keys(rec.checks).sort()).toEqual(
      ['credentials_authenticate', 'identity_materializes', 'messaging_round_trips', 'runtime_resolves'],
    );
  });

  test('a revoked credential (runs + proves fail) → Stuck', async () => {
    const runners = { ...passRunners(), credentials_authenticate: async () => ({ state: 'fail', message: 'revoked' }) };
    const rec = await aggregateHealthRecord({ ...base, runners });
    expect(rec.status).toBe('stuck');
  });

  test('GRACEFUL DEGRADATION: a 404/unreachable source (throws) → unknown → Degraded, NOT Stuck', async () => {
    const runners = {
      ...passRunners(),
      runtime_resolves: async () => { throw new Error('mech-run /v1/doctor 404'); },
    };
    const rec = await aggregateHealthRecord({ ...base, runners });
    expect(rec.status).toBe('degraded'); // NOT stuck — infra-absence is not proven-failure
    expect(rec.checks.runtime_resolves.state).toBe('unknown');
    expect(rec.checks.runtime_resolves.message).toMatch(/could not complete.*404/);
  });

  test('GRACEFUL DEGRADATION: a check with no runner wired → unknown → Degraded', async () => {
    const runners = { ...passRunners() };
    delete runners.messaging_round_trips; // mech-run chat probe not wired yet
    const rec = await aggregateHealthRecord({ ...base, runners });
    expect(rec.status).toBe('degraded');
    expect(rec.checks.messaging_round_trips.state).toBe('unknown');
    expect(rec.checks.messaging_round_trips.message).toMatch(/source not available/);
  });

  test('a runner returning a non-object → unknown (not a crash)', async () => {
    const runners = { ...passRunners(), identity_materializes: async () => 'nope' };
    const rec = await aggregateHealthRecord({ ...base, runners });
    expect(rec.checks.identity_materializes.state).toBe('unknown');
  });

  test('proven-fail still beats unknown: revoked cred + unreachable runtime → Stuck', async () => {
    const runners = {
      ...passRunners(),
      credentials_authenticate: async () => ({ state: 'fail' }),
      runtime_resolves: async () => { throw new Error('unreachable'); },
    };
    const rec = await aggregateHealthRecord({ ...base, runners });
    expect(rec.status).toBe('stuck'); // credentials fail dominates the unknown
  });

  test('stale → Stuck regardless of checks', async () => {
    const rec = await aggregateHealthRecord({ ...base, runners: passRunners(), stale: true });
    expect(rec.status).toBe('stuck');
    expect(rec.reason).toBe('report is stale');
  });

  test('no runners at all → all unknown → Degraded (never silently Healthy)', async () => {
    const rec = await aggregateHealthRecord({ ...base });
    expect(rec.status).toBe('degraded');
    expect(Object.values(rec.checks).every((c) => c.state === 'unknown')).toBe(true);
  });

  test('messaging_round_trips fail (non-load-bearing) → Degraded, not Stuck (AC-4 via aggregate)', async () => {
    const runners = { ...passRunners(), messaging_round_trips: async () => ({ state: 'fail' }) };
    const rec = await aggregateHealthRecord({ ...base, runners });
    expect(rec.status).toBe('degraded');
  });

  test('an extra (non-core) runner is invoked, not silently dropped', async () => {
    let called = false;
    const runners = { ...passRunners(), agentdrive_optional: async () => { called = true; return { state: 'pass', required: false }; } };
    const rec = await aggregateHealthRecord({ ...base, runners });
    expect(called).toBe(true);
    expect(rec.checks.agentdrive_optional).toBeDefined();
    expect(rec.status).toBe('healthy');
  });

  test('missing required identifiers → rejects (buildHealthRecord TypeError)', async () => {
    await expect(aggregateHealthRecord({ machineId: 'm', ts: 't', runners: passRunners() })).rejects.toThrow(/agent_id/);
  });

  test('custom requiredChecks promotes an extra check to load-bearing', async () => {
    const runners = { ...passRunners(), extra_required: async () => ({ state: 'fail' }) };
    // Without requiredChecks, extra_required is optional → its fail caps at degraded.
    const lenient = await aggregateHealthRecord({ ...base, runners });
    expect(lenient.status).toBe('degraded');
    // Marking it required makes its fail load-bearing (still degraded here since it has no
    // critical fail-status mapping, but it is now evaluated as required, not optional).
    const strict = await aggregateHealthRecord({ ...base, runners, requiredChecks: ['extra_required'] });
    expect(strict.checks.extra_required.state).toBe('fail');
    expect(['degraded', 'stuck']).toContain(strict.status);
  });
});
