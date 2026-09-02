import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { realSoak } from '../../tasks/evidence/0072/qualify-mech-plane-runtime-successor.ts';

// Real subprocesses, real signals, real pipe lifetimes. Per the repo's own lesson, anything
// touching OS signals or PID lifecycle belongs in the soak lane rather than the default
// suite: mocked kills pass while real bugs ship, and the genuine subprocess load these need
// tips borderline 5s-timeout tests elsewhere in phase 1 into flaking.
const t_after = [];
test.after?.(async () => { for (const d of t_after) await rm(d, { recursive: true, force: true }); });

test('realSoak does not false-fail a slow but successful run, and bounds a held pipe', { timeout: 90_000 }, async () => {
  // Regression: an earlier drain armed its grace window at spawn instead of at process exit,
  // so a healthy multi-minute soak blew the deadline, discarded all output, and reported
  // real_probe_output_drain_incomplete on an exit-0 run. A gate that false-fails is as broken
  // as one that cannot fail, so both directions are asserted here.
  const plane = await mkdtemp('/tmp/mech-plane-drain-');
  await mkdir(join(plane, 'scripts'), { recursive: true });
  t_after.push(plane);

  // (a) Slow success: emits its summary only after outliving any spawn-anchored deadline.
  const results = [];
  for (const cycle of [1, 2]) {
    for (const mode of ['allow', 'deny', 'expiry', 'disconnect']) {
      const outcome = mode === 'allow' ? { approved: true, decision: 'once', reason: 'resolved' }
        : mode === 'deny' ? { approved: false, decision: 'deny', reason: 'resolved' }
          : mode === 'expiry' ? { approved: false, decision: 'deny', reason: 'expired' }
            : { approved: false, decision: 'deny', reason: 'cancelled' };
      results.push({
        cycle, mode, nativeToolObserved: true, approvalRequested: true, bindingDigestPresent: true, expiryPresent: true,
        approvalOutcome: outcome, effectObserved: mode === 'allow',
        approvalRequestCount: 1,
        approvalDecisionsSubmitted: mode === 'allow' || mode === 'deny' ? 1 : 0,
        approvalDecisionsAccepted: mode === 'allow' || mode === 'deny' ? 1 : 0,
        runtime: mode === 'disconnect' ? { stopReason: 'cancelled', exitCode: null } : { stopReason: 'end_turn', exitCode: 0 },
      });
    }
  }
  const summary = { schemaVersion: 'mech-plane.runtime-approval-soak.v2', runtime: { package: '@mech/run', version: '0.4.6', provider: 'codex' }, cycles: 2, passed: true, results };
  await writeFile(join(plane, 'scripts', 'soak-runtime-approval.ts'),
    `await Bun.sleep(1200);\nconsole.log(${JSON.stringify(JSON.stringify(summary))});\n`);
  // Grace (200ms) is deliberately SHORTER than the child's runtime (1200ms). If the grace
  // window is armed at spawn instead of at exit it expires mid-run and this assertion fails —
  // which is precisely the regression. Verified red against that mutant.
  const slow = await realSoak(plane, '/tmp', 60_000, 200);
  assert.equal(slow.ok, true, 'a slow but successful soak must not be reported as drain-incomplete');
  assert.equal(slow.outputDrainComplete, true);
  assert.equal(slow.cases, 8);

  // (b) Watchdog still bounds a run that exceeds its timeout.
  await writeFile(join(plane, 'scripts', 'soak-runtime-approval.ts'), 'await Bun.sleep(20_000);\n');
  const hung = await realSoak(plane, '/tmp', 1_000);
  assert.equal(hung.ok, false);
  assert.equal(hung.watchdogTerminationApplied, true);
  // Retained failure evidence must say whether the GROUP was killed or only the direct
  // child — on the timeout path most of all, since that is where descendants survive.
  assert.equal(typeof hung.groupTerminationApplied, 'boolean', 'timeout evidence must record group-termination outcome');
  assert.equal(hung.groupTerminationApplied, true, 'watchdog must terminate the process group');

  // (c) CONTAINMENT: a descendant that inherits the pipes and outlives its parent must be
  // terminated before realSoak returns — otherwise it keeps doing real-agent work and
  // touching local effects after the qualifier has already reported. The grandchild writes a
  // sentinel only if it survives its sleep, so the sentinel's ABSENCE is the proof.
  const sentinel = join(plane, 'descendant-survived.txt');
  await writeFile(join(plane, 'scripts', 'soak-runtime-approval.ts'),
    `Bun.spawn(['bun', '-e', 'await Bun.sleep(3000); await Bun.write(${JSON.stringify(sentinel)}, "survived")'], `
    + `{ stdout: 'inherit', stderr: 'inherit' });\n`
    + `process.exit(0);\n`);
  const started = Date.now();
  const held = await realSoak(plane, '/tmp', 30_000, 500);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20_000, `qualifier must return bounded, took ${elapsed}ms`);
  assert.equal(held.ok, false, 'a probe with no parsable summary must not pass');

  // Wait past the grandchild's own lifetime. If containment worked it was killed long before
  // this; if it leaked, the sentinel appears and the assertion fails.
  await new Promise((r) => setTimeout(r, 4_000));
  let survived = false;
  try { await readFile(sentinel, 'utf8'); survived = true; } catch { survived = false; }
  assert.equal(survived, false, 'descendant must be terminated before realSoak returns, not left running');
});
