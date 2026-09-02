/**
 * Shared restore helper for the `node:test` (.mjs) files.
 *
 * `bun test` — which is how this repo runs its suite — shares ONE process across test
 * files (verified: two files report the same pid, where `node --test` gives each its
 * own). So a test file that overrides AGENTBOOTUP_MACHINE_ID_FILE and then deletes it,
 * or throws before restoring it, leaves the variable wrong for every file that runs
 * afterwards — and the next getMachineId() falls through to the real
 * ~/.agentbootup/machine-id and mints the host's identity.
 *
 * Registering through `afterEach` (rather than restoring at the end of a test body)
 * makes it exception-safe: it runs even when a test throws.
 */

/**
 * Capture the ambient value now, and restore it after every test.
 * @param {(fn: () => void) => void} afterEach the runner's afterEach hook
 */
export function restoreMachineIdEnvAfterEach(afterEach) {
  const preloaded = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  afterEach(() => {
    if (preloaded === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = preloaded;
  });
}
