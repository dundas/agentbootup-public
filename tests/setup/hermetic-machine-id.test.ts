import { test, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  HERMETIC_MACHINE_ID_DIR,
  resolveHermeticMachineIdFile,
  sweepStaleMachineIds,
  isPidAlive,
} from './machine-id-paths.ts';

// Absolute, because the probe runs from a temp cwd (see probePreload).
const PRELOAD = path.resolve(import.meta.dir, 'hermetic-machine-id.ts');

/**
 * Regression guard for the preload itself. Without it, deleting the `preload` line from
 * bunfig.toml — or breaking the "only when unset" guard — would silently re-arm the
 * leak: `getMachineId()` would mint `~/.agentbootup/machine-id` on the real host again,
 * and every other test would still pass.
 */
/**
 * Both branches of the preload are exercised in an ISOLATED process, because they are
 * mutually exclusive within one: the current process either had the variable set
 * before preload or it didn't. Asserting on the ambient value can only ever test one
 * branch, and asserting the exact hermetic path would wrongly fail whenever a caller
 * legitimately exported their own path (the "only when unset" contract working).
 */
function probePreload(env: Record<string, string | undefined>): string {
  // cwd is a temp dir, NOT the repo: bun reads bunfig.toml from the working directory,
  // so running here would apply the repo's own preload on top of the explicit one and
  // the probe would no longer be isolated from the configuration it is meant to test.
  const result = Bun.spawnSync({
    cmd: ['bun', '--preload', PRELOAD, '-e', 'console.log(process.env.AGENTBOOTUP_MACHINE_ID_FILE)'],
    env: { ...process.env, ...env } as Record<string, string>,
    cwd: os.tmpdir(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return new TextDecoder().decode(result.stdout).trim().split('\n').pop()!.trim();
}

test('preload sets a hermetic per-process path when the variable is unset', () => {
  const out = probePreload({ AGENTBOOTUP_MACHINE_ID_FILE: undefined });
  expect(out).toStartWith(HERMETIC_MACHINE_ID_DIR + path.sep);
  expect(out).toMatch(/machine-id-\d+$/);
  expect(out.startsWith(path.join(os.homedir(), '.agentbootup'))).toBe(false);
});

test('preload defers to an already-set variable ("only when unset")', () => {
  const sentinel = path.join(os.tmpdir(), 'agentbootup-preload-sentinel');
  expect(probePreload({ AGENTBOOTUP_MACHINE_ID_FILE: sentinel })).toBe(sentinel);
});

/**
 * And in THIS process, whichever branch ran, the id must not live in the real home.
 *
 * This is the invariant that actually matters, and it is why there is no in-process
 * assertion of the exact hermetic path. Consider deleting the bunfig preload line:
 *
 *   - with AGENTBOOTUP_MACHINE_ID_FILE unset  -> this test fails (verified). That is
 *     the only configuration in which the leak returns.
 *   - with it exported by the caller          -> this test passes, and correctly so:
 *     getMachineId() writes to the caller's path, so the suite is still isolated from
 *     ~/.agentbootup. Nothing has leaked.
 *
 * Asserting the exact per-pid path here would instead fail case 2, breaking the
 * "only when unset" contract the preload is documented to honour.
 */
test('the running suite is isolated from the real ~/.agentbootup', () => {
  const idFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  expect(idFile).toBeTruthy();
  expect(path.resolve(idFile!).startsWith(path.join(os.homedir(), '.agentbootup'))).toBe(false);
});

test('resolveHermeticMachineIdFile defers to an already-set variable', () => {
  expect(resolveHermeticMachineIdFile({ AGENTBOOTUP_MACHINE_ID_FILE: '/somewhere/else' }, 123)).toBeNull();
});

test('resolveHermeticMachineIdFile is per-process, so concurrent runs cannot race', () => {
  const a = resolveHermeticMachineIdFile({}, 123);
  const b = resolveHermeticMachineIdFile({}, 456);
  expect(a).not.toBe(b);
  expect(path.dirname(a!)).toBe(HERMETIC_MACHINE_ID_DIR);
  expect(path.dirname(b!)).toBe(HERMETIC_MACHINE_ID_DIR);
});

test('sweepStaleMachineIds removes ids of dead pids, and only when old', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sweep-'));
  try {
    const deadOld = path.join(dir, 'machine-id-1');
    const deadFresh = path.join(dir, 'machine-id-2');
    const unrelated = path.join(dir, 'not-a-machine-id');
    for (const f of [deadOld, deadFresh, unrelated]) fs.writeFileSync(f, 'x');
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(deadOld, old, old);
    fs.utimesSync(unrelated, old, old);

    sweepStaleMachineIds(dir, Date.now(), 60 * 60 * 1000, () => false); // all pids dead
    expect(fs.existsSync(deadOld)).toBe(false);
    expect(fs.existsSync(deadFresh)).toBe(true); // dead but not yet old
    expect(fs.existsSync(unrelated)).toBe(true); // not ours, never touched
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The finding that matters: a long-running test process must not have its live id
// deleted by a later `bun test` invocation, or it silently mints a fresh UUID.
test('sweepStaleMachineIds never deletes a live pid\'s id, however old', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sweep-live-'));
  try {
    const live = path.join(dir, `machine-id-${process.pid}`);
    fs.writeFileSync(live, 'x');
    const ancient = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(live, ancient, ancient);

    sweepStaleMachineIds(dir); // real liveness check: this process is obviously alive
    expect(fs.existsSync(live)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isPidAlive reports this process alive and an impossible pid dead', () => {
  expect(isPidAlive(process.pid)).toBe(true);
  expect(isPidAlive(2 ** 30)).toBe(false);
  // EPERM (exists, other user) counts as alive.
  expect(isPidAlive(1, () => { const e: NodeJS.ErrnoException = new Error('x'); e.code = 'EPERM'; throw e; })).toBe(true);
});

test('sweepStaleMachineIds does not throw on a missing directory', () => {
  expect(() => sweepStaleMachineIds(path.join(os.tmpdir(), 'ab-does-not-exist-' + Date.now()))).not.toThrow();
});
