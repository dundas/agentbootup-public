import { test, expect, describe } from 'bun:test';
import { checkRuntimeResolves, verifyRuntimeInstall } from '../../lib/doctor/runtime-check.js';
import { reduceHealthStatus } from '../../lib/brain/health-record.js';

describe('checkRuntimeResolves (FR-1)', () => {
  const readyOk = async () => ({ ok: true, runtimeSource: 'MECH_PLANE_BASE_URL' });

  test('readyz ready + lease answers → pass', async () => {
    const r = await checkRuntimeResolves({ readyz: readyOk, probeLease: async () => true });
    expect(r.state).toBe('pass');
    expect(r.category).toBe('runtime');
  });

  test('readyz not ok → fail', async () => {
    const r = await checkRuntimeResolves({ readyz: async () => ({ ok: false, runtimeSource: 'x' }), probeLease: async () => true });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/not ready/);
  });

  test('lease present but runtime does not answer → fail (don\'t trust chat_ready)', async () => {
    const r = await checkRuntimeResolves({ readyz: readyOk, probeLease: async () => false });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/did not answer/);
  });

  test('readyz throws (agent-host unreachable) → unknown, NOT fail (PRD-0039 FR-3)', async () => {
    const r = await checkRuntimeResolves({ readyz: async () => { throw new Error('504'); }, probeLease: async () => true });
    expect(r.state).toBe('unknown'); // unreachable source ≠ proven-dead runtime; must not Stuck the fleet
    expect(r.severity).toBe('warning');
    expect(r.message).toMatch(/readyz probe unreachable.*504/);
  });

  test('lease probe throws (cannot reach runtime address) → unknown, NOT fail (FR-3)', async () => {
    const r = await checkRuntimeResolves({ readyz: readyOk, probeLease: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.state).toBe('unknown');
    expect(r.message).toMatch(/lease probe unreachable.*ECONNREFUSED/);
  });

  test('pass-path with no runtimeSource still passes', async () => {
    const r = await checkRuntimeResolves({ readyz: async () => ({ ok: true }), probeLease: async () => true });
    expect(r.state).toBe('pass');
    expect(r.message).toMatch(/resolves and answers/);
  });

  test('missing probes (no accessor) → unknown, NOT fail (cannot determine ≠ proven-bad)', async () => {
    expect((await checkRuntimeResolves({ probeLease: async () => true })).state).toBe('unknown');
    expect((await checkRuntimeResolves({ readyz: readyOk })).state).toBe('unknown');
  });

  test('runtime PROVEN fail (readyz answered not-ready) → Stuck via the reducer', async () => {
    const rc = await checkRuntimeResolves({ readyz: readyOk, probeLease: async () => false });
    const reduced = reduceHealthStatus({
      runtime_resolves: rc,
      identity_materializes: { state: 'pass' },
      credentials_authenticate: { state: 'pass' },
      messaging_round_trips: { state: 'pass' },
    });
    expect(reduced.status).toBe('stuck');
  });

  // AC-2 regression (PRD-0039): the dominant false-Stuck — agent-host unreachable must NOT
  // Stuck the fleet. This test FAILS against pre-PRD-0039 code (which returned fail → stuck).
  test('AC-2 regression: agent-host UNREACHABLE → Degraded, NOT Stuck', async () => {
    const rc = await checkRuntimeResolves({ readyz: async () => { throw new Error('ECONNREFUSED'); }, probeLease: async () => true });
    expect(rc.state).toBe('unknown');
    const reduced = reduceHealthStatus({
      runtime_resolves: rc,
      identity_materializes: { state: 'pass' },
      credentials_authenticate: { state: 'pass' },
      messaging_round_trips: { state: 'pass' },
    });
    expect(reduced.status).toBe('degraded'); // was 'stuck' before the FR-3 fix
  });
});

describe('verifyRuntimeInstall (FR-1 / Bug sh49xw — provisioned ≠ runnable)', () => {
  const runtimePath = 'brain/scripts/brain-message-inbox.ts';
  const manifest = { files: [{ target: runtimePath, role: 'runtime', required: true }] };
  const goodRun = async (args, opts) => {
    if (args[0] === '--help') return { code: 0 };
    if (args[0] === '--read-only' && opts.emptyEnv) return { code: 10 };
    return { code: 1 };
  };

  test('declared + --help ok + empty-env read-only exits 10 → pass', async () => {
    const r = await verifyRuntimeInstall({ manifest, runtimePath, run: goodRun });
    expect(r.state).toBe('pass');
    expect(r.category).toBe('install');
  });

  test('runtime not declared in manifest → fail (the Bug sh49xw class)', async () => {
    const r = await verifyRuntimeInstall({ manifest: { files: [] }, runtimePath, run: goodRun });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/not declared as a runtime file/);
  });

  test('a wrapper installed without its runtime → fail (declared but --help non-zero)', async () => {
    const run = async (args) => (args[0] === '--help' ? { code: 127 } : { code: 0 });
    const r = await verifyRuntimeInstall({ manifest, runtimePath, run });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/--help exited 127/);
  });

  test('empty-env read-only that does NOT exit 10 → fail (does not fail closed)', async () => {
    const run = async (args, opts) => {
      if (args[0] === '--help') return { code: 0 };
      return { code: 0 }; // "works" on empty env — wrong, should be 10
    };
    const r = await verifyRuntimeInstall({ manifest, runtimePath, run });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/--read-only exited 0 \(expected 10\)/);
  });

  test('run that throws → fail (not a crash)', async () => {
    const run = async () => { throw new Error('ENOENT'); };
    const r = await verifyRuntimeInstall({ manifest, runtimePath, run });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/did not execute.*ENOENT/);
  });

  test('missing runtimePath / run → fail', async () => {
    expect((await verifyRuntimeInstall({ manifest, run: goodRun })).state).toBe('fail');
    expect((await verifyRuntimeInstall({ manifest, runtimePath })).state).toBe('fail');
  });
});
