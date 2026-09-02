/**
 * Test preload: keep the suite out of the real `~/.agentbootup`.
 *
 * `getMachineId()` creates `~/.agentbootup/machine-id` on the host when absent, and
 * that UUID is load-bearing twice over: it is the telemetry attribution id, and since
 * the credentials store was rebound to it, it is also what the at-rest key derives
 * from. A test run must never mint a machine's real identity — on a fresh machine,
 * `bun test` would otherwise decide who that machine is before the user ever runs the
 * CLI.
 *
 * Eight test files reach `getMachineId()` transitively (via `app.js`, `publish-code.js`,
 * `transcript-cache.js`, `doctor-report.js`, `writeCredentials()`), so isolating them
 * one `beforeEach` at a time is both repetitive and easy to forget in the next test
 * that happens to call one of those. A preload makes the default hermetic, and any file
 * that genuinely needs its own path (tests/daemon/machine-id.test.ts) still sets the
 * variable itself — this only fills in a default when none is set.
 */

import fs from 'fs';
import {
  HERMETIC_MACHINE_ID_DIR,
  resolveHermeticMachineIdFile,
  sweepStaleMachineIds,
} from './machine-id-paths.ts';

const resolved = resolveHermeticMachineIdFile(process.env, process.pid);
if (resolved) {
  // 0o700 like the real getMachineId() path: os.tmpdir() is shared across local users,
  // and the rest of this work is careful about exactly this exposure.
  fs.mkdirSync(HERMETIC_MACHINE_ID_DIR, { recursive: true, mode: 0o700 });
  try {
    // mkdir's mode is umask-masked, so tighten explicitly. On a shared tmpdir the
    // directory may already belong to another user (EPERM/EACCES), or a concurrent run
    // may have removed it (ENOENT). Those are expected and harmless — per-pid filenames
    // keep runs from colliding. Anything else is a real filesystem problem: rethrow it
    // rather than let a broken hermetic setup fail silently.
    fs.chmodSync(HERMETIC_MACHINE_ID_DIR, 0o700);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') throw err;
  }
  sweepStaleMachineIds(HERMETIC_MACHINE_ID_DIR);
  // Start this process from a clean id. `bun test` never runs `process.on('exit')`
  // handlers (verified), so teardown happens on the way in, not on the way out.
  fs.rmSync(resolved, { force: true });
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = resolved;
}
