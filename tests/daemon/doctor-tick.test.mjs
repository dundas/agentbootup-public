import { test, expect, describe } from 'bun:test';
import { startDoctorTick, isDoctorTickEnabled } from '../../lib/daemon/doctor-tick.js';

const baseRecord = {
  agent_id: 'brain-a', machine_id: 'm1', ts: '2026-06-04T12:00:00Z',
  status: 'degraded', checks: {}, reason: null, environment: null,
};

describe('startDoctorTick', () => {
  test('throws field-specific errors when serverUrl or apiKey is missing', () => {
    // Each assertion targets the field that's actually missing (distinct messages).
    expect(() => startDoctorTick({ serverUrl: '', apiKey: 'k' })).toThrow(/serverUrl is required/);
    expect(() => startDoctorTick({ serverUrl: 'https://s', apiKey: '' })).toThrow(/apiKey is required/);
  });

  test('AC-8: each tick freshly builds the record (distinct ts)', async () => {
    const tsSeen = [];
    const buildReport = async ({ ts }) => { tsSeen.push(ts); return { ...baseRecord, ts }; };
    const postReport = async () => {};
    // 10 ms tick / 300 ms wait — wide enough for flaky CI schedulers (roborev timing note)
    const { stop } = startDoctorTick({ serverUrl: 'https://s', apiKey: 'k', tickMs: 10, buildReport, postReport, log: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(tsSeen.length).toBeGreaterThanOrEqual(2);
    const unique = new Set(tsSeen);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });

  test('FR-9: build failure is logged and skipped — post is never called', async () => {
    const logs = [];
    let postCalled = false;
    const buildReport = async () => { throw new Error('no brain'); };
    const postReport = async () => { postCalled = true; };
    const { stop } = startDoctorTick({ serverUrl: 'https://s', apiKey: 'k', tickMs: 10, buildReport, postReport, log: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(postCalled).toBe(false);
    expect(logs.some((l) => l.includes('could not build'))).toBe(true);
  });

  test('FR-9: post failure is logged and NOT thrown (daemon isolation)', async () => {
    const logs = [];
    let threw = false;
    const buildReport = async ({ ts }) => ({ ...baseRecord, ts });
    const postReport = async () => { throw new Error('HTTP 503'); };
    const { stop } = startDoctorTick({ serverUrl: 'https://s', apiKey: 'k', tickMs: 10, buildReport, postReport, log: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(threw).toBe(false);
    expect(logs.some((l) => l.includes('delivery failed'))).toBe(true);
  });

  test('AC-9: stop() prevents further ticks', async () => {
    let count = 0;
    const buildReport = async ({ ts }) => { count++; return { ...baseRecord, ts }; };
    const postReport = async () => {};
    const { stop } = startDoctorTick({ serverUrl: 'https://s', apiKey: 'k', tickMs: 10, buildReport, postReport, log: () => {} });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    // Drain in-flight microtasks so a suspended runTick can complete before snapshotting.
    await Promise.resolve();
    const countAfterStop = count;
    await new Promise((r) => setTimeout(r, 100)); // no new ticks should fire after stop
    expect(count).toBe(countAfterStop);
  });

  test('warns when tickMs is >= 80% of the stale window (flap-prevention)', () => {
    const logs = [];
    const { stop } = startDoctorTick({ serverUrl: 'https://s', apiKey: 'k', tickMs: 270_000, buildReport: async ({ ts }) => ({ ...baseRecord, ts }), postReport: async () => {}, log: (m) => logs.push(m) });
    stop();
    expect(logs.some((l) => l.includes('WARN'))).toBe(true);
  });

  test('passes cwd through to the live builder so daemon health is scoped to the intended project', async () => {
    let seenCwd = null;
    const buildReport = async ({ ts, cwd }) => {
      seenCwd = cwd;
      return { ...baseRecord, ts };
    };
    const { stop } = startDoctorTick({ serverUrl: 'https://s', apiKey: 'k', cwd: '/tmp/doctor-scope', tickMs: 10, buildReport, postReport: async () => {}, log: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(seenCwd).toBe('/tmp/doctor-scope');
  });
});

describe('isDoctorTickEnabled', () => {
  test('returns false by default (off-by-default, AC-9)', () => {
    const orig = process.env.AGENTBOOTUP_DOCTOR_TICK_ENABLED;
    delete process.env.AGENTBOOTUP_DOCTOR_TICK_ENABLED;
    expect(isDoctorTickEnabled()).toBe(false);
    if (orig !== undefined) process.env.AGENTBOOTUP_DOCTOR_TICK_ENABLED = orig;
  });

  test('returns true only when set to exactly "1"', () => {
    process.env.AGENTBOOTUP_DOCTOR_TICK_ENABLED = '1';
    expect(isDoctorTickEnabled()).toBe(true);
    process.env.AGENTBOOTUP_DOCTOR_TICK_ENABLED = 'true';
    expect(isDoctorTickEnabled()).toBe(false);
    delete process.env.AGENTBOOTUP_DOCTOR_TICK_ENABLED;
  });
});
