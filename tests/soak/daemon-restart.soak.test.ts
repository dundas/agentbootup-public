/**
 * Soak tests for the daemon restart path in lib/daemon/unified-daemon-cli.js.
 *
 * Unlike the unit tests in tests/daemon/ (which use synthetic PIDs and fully
 * mocked process.kill), these tests back agentStatus/agentStop/agentStart with
 * real Bun subprocesses so that OS-level behavior — SIGTERM delivery, SIGKILL,
 * kill-0 liveness probes — runs against actual kernel PIDs.
 *
 * The three scenarios:
 *
 *   1. Hung restart cycle   — subprocess ignores SIGTERM; restart path must time
 *      out twice, SIGKILL the real process, confirm death via kill-0, spawn new.
 *      Exercises the full SIGKILL fallback from PR #256. (20 cycles)
 *
 *   2. Graceful restart cycle — subprocess exits on SIGTERM; SIGKILL must never
 *      fire. Stress-tests the fast path. (30 cycles)
 *
 *   3. PID recycling safety — after SIGKILL fires, process.kill(pid, 0) is
 *      patched to keep returning "alive" (simulating PID reuse by a new process).
 *      Code must fail closed: no duplicate daemon started.
 *
 * Run explicitly: bun run soak
 * NOT included in npm test (too slow for CI; spawns real OS processes).
 * (bun run soak includes the required AGENTBOOTUP_ALLOW_TEST_SESSION=1 env.)
 */

import { test, expect, afterAll, beforeEach, mock, describe } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { writeCredentials as writeEncryptedCredentials } from '../../lib/auth/credentials.js';

// ── Mock agent-process before any import of unified-daemon-cli ─────────────────
// Must be declared at module level so mock.module fires before dynamic import.
// Use a mutable container object so each scenario can replace implementations.
// Unconfigured paths reject loudly rather than silently inheriting from a prior
// scenario (the improvement over bare let bindings).

const impls: {
  agentStart: (config: Record<string, any>) => Promise<Record<string, any>>;
  agentStatus: (name: string) => Promise<Record<string, any>>;
  agentStop: (name: string) => Promise<void>;
} = {
  agentStart: () => Promise.reject(new Error('agentStart not configured for this scenario')),
  agentStatus: () => Promise.reject(new Error('agentStatus not configured for this scenario')),
  agentStop: () => Promise.reject(new Error('agentStop not configured for this scenario')),
};

mock.module('@derivativelabs/agent-process', () => ({
  agentStart: async (config: Record<string, any>) => impls.agentStart(config),
  agentStop: async (name: string) => impls.agentStop(name),
  agentStatus: async (name: string) => impls.agentStatus(name),
  agentLogs: async () => {},
}));

// ── Module caching note ───────────────────────────────────────────────────────
// unified-daemon-cli.js is cached by the Bun module system after the first
// dynamic import(). This is safe here because all timing env vars
// (AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS, AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS,
// AGENTBOOTUP_DAEMON_NO_KILL_POLL) are read inside functions on each call
// (getStopTimeoutMs, getSigkillSettleMs, pollProcessDead) — not captured at module load time.
// WARNING: if those functions are ever refactored to cache env vars at module load,
// per-scenario env overrides here will silently use stale values.

// ── Test isolation ─────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-soak-'));
const credFile = path.join(tmpDir, 'credentials');
const configFile = path.join(tmpDir, 'config.json');
process.env.AGENTBOOTUP_CREDS_FILE = credFile;
process.env.AGENTBOOTUP_CONFIG_FILE = configFile;

// All spawned subprocesses — killed unconditionally in afterAll.
const allProcs: ReturnType<typeof Bun.spawn>[] = [];

afterAll(async () => {
  for (const proc of allProcs) {
    // SIGKILL — SIGTERM would be silently ignored by stubborn (SIGTERM-trapping) processes.
    // ESRCH is expected and benign: the restart cycle already killed most of these PIDs.
    try { proc.kill('SIGKILL'); } catch (e: any) {
      if (e?.code !== 'ESRCH') process.stderr.write(`afterAll kill error: ${e}\n`);
    }
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
  mock.restore();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const FIXTURE = path.join(import.meta.dir, 'fixtures', 'cooperative-daemon.ts');

function spawnDaemon(stubborn: boolean): ReturnType<typeof Bun.spawn> {
  // Stubborn: use a shell trap that ignores SIGTERM from the first instruction,
  // eliminating any race between spawn and the test's first agentStopImpl call.
  // Cooperative: use the Bun fixture which exits normally on SIGTERM.
  const cmd = stubborn
    // printf "ready\n" runs after trap "" TERM is registered, so awaitReady
    // confirms the trap is installed before any SIGTERM can arrive.
    ? ['sh', '-c', 'trap "" TERM; printf "ready\n"; while true; do sleep 0.5; done']
    : ['bun', FIXTURE];
  const proc = Bun.spawn(cmd, {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  allProcs.push(proc);
  return proc;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) {
    // EPERM = process exists but caller lacks permission → treat as alive.
    // ESRCH = no such process → dead. Any other error → dead (conservative).
    return e?.code === 'EPERM';
  }
}

async function awaitReady(proc: ReturnType<typeof Bun.spawn>, timeoutMs = 5_000): Promise<void> {
  if (!proc.stdout) throw new Error('awaitReady: proc.stdout is not a pipe — spawn with stdout: "pipe"');
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = '';
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`awaitReady timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timer]);
      if (done) throw new Error('awaitReady: subprocess exited before writing "ready\\n"');
      buf += dec.decode(value, { stream: true });
      if (buf.includes('ready\n')) return;
    }
  } finally {
    clearTimeout(timerId);
    // Await cancel so the pending read() settles before releaseLock — required by
    // the Web Streams spec; releaseLock before settlement may throw TypeError.
    await reader.cancel().catch((e) => process.stderr.write(`awaitReady cancel error: ${e}\n`));
    reader.releaseLock();
  }
}

async function writeCredentials(): Promise<void> {
  await writeEncryptedCredentials({ apiKey: 'soak-test-key', serverUrl: 'https://example.com' });
}

async function writeConsentedConfig(): Promise<void> {
  await fsp.writeFile(configFile, JSON.stringify({
    brainId: 'soak-test-brain',
    dataTransmissionAcknowledged: true,
    brainAssetTransmissionAcknowledged: true,
  }));
}

function captureOutput(): { logs: string[]; errs: string[]; restore: () => void } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  console.error = (...args: unknown[]) => errs.push(args.join(' '));
  return { logs, errs, restore: () => { console.log = origLog; console.error = origErr; } };
}

// runCommand relies on process.exit throws propagating out of runDaemonCommand.
// This is safe because runDaemonCommand has no top-level try/catch — it delegates
// to handlers (handleRestart etc.) which call process.exit() directly and do not
// catch the Error we throw from our process.exit override.
async function runCommand(argv: string[]): Promise<{ exitCode: number | null; logs: string[]; errs: string[] }> {
  const { runDaemonCommand } = await import('../../lib/daemon/unified-daemon-cli.js');
  const cap = captureOutput();
  let exitCode: number | null = null;
  const origExit = process.exit;
  (process as any).exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`process.exit(${code})`); };
  try {
    await runDaemonCommand(argv);
  } catch (e: any) {
    if (!String(e.message).startsWith('process.exit(')) throw e;
  } finally {
    (process as any).exit = origExit;
    cap.restore();
  }
  return { exitCode, logs: cap.logs, errs: cap.errs };
}

function resetImpls(): void {
  impls.agentStart = () => Promise.reject(new Error('agentStart not configured for this scenario'));
  impls.agentStatus = () => Promise.reject(new Error('agentStatus not configured for this scenario'));
  impls.agentStop = () => Promise.reject(new Error('agentStop not configured for this scenario'));
}

// ── Scenario 1: Hung daemon restart cycle ──────────────────────────────────────

describe('soak: hung daemon restart cycle', () => {
  beforeEach(resetImpls);
  test('20 cycles — SIGKILL path, each cycle completes and old PID confirmed dead', async () => {
    const CYCLES = 20;
    process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '300';
    process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS = '2000';

    await writeCredentials();
    await writeConsentedConfig();

    // Start with one stubborn subprocess as the "currently running daemon".
    let currentProc: ReturnType<typeof Bun.spawn> = spawnDaemon(true);
    const timings: number[] = [];

    // agentStop: deliver SIGTERM — subprocess ignores it (stubborn).
    impls.agentStop = async (_name: string) => {
      try { currentProc.kill('SIGTERM'); } catch {}
    };

    // agentStatus: use real kill-0 against the current subprocess PID.
    // This means the SIGKILL path gets a real PID to verify and kill.
    impls.agentStatus = async (name: string) => {
      if (name !== 'agentbootup-brain') return { name, state: 'unknown', platform: 'test' };
      const pid = currentProc.pid;
      if (!pid) return { name, state: 'stopped', platform: 'test' };
      if (isAlive(pid)) return { name, state: 'running', pid, platform: 'test' };
      return { name, state: 'stopped', pid, platform: 'test' };
    };

    // agentStart: spawn a new stubborn subprocess and update currentProc.
    impls.agentStart = async (_config: Record<string, any>) => {
      const proc = spawnDaemon(true);
      await awaitReady(proc); // wait for trap "" TERM to be registered
      currentProc = proc;
      return { pid: proc.pid, port: null };
    };

    // Ensure the initial subprocess's trap is registered before the first cycle.
    await awaitReady(currentProc);

    try {
      for (let i = 0; i < CYCLES; i++) {
        const pidBefore = currentProc.pid!;

        const t0 = Date.now();
        const { exitCode, logs } = await runCommand(['daemon', 'restart', '--no-transcripts', '--yes']);
        const elapsed = Date.now() - t0;
        timings.push(elapsed);

        expect(exitCode).toBeNull();
        expect(logs.join('\n')).toContain('Restart complete');

        // Old PID must be confirmed dead at the OS level.
        expect(isAlive(pidBefore)).toBe(false);

        // New subprocess must be alive and have a different PID.
        // (Same PID is vanishingly rare but theoretically possible; no assertion on !=.)
        expect(isAlive(currentProc.pid!)).toBe(true);

        if ((i + 1) % 5 === 0) {
          const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
          process.stderr.write(`  [soak] hung ${i + 1}/${CYCLES} elapsed=${elapsed}ms avg=${avg}ms pid=${currentProc.pid}\n`);
        }
      }
    } finally {
      // SIGKILL — stubborn processes ignore SIGTERM, so kill() with no arg is a no-op.
      try { currentProc.kill('SIGKILL'); } catch {}
      delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
      delete process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS;
    }

    expect(timings.length).toBe(CYCLES);
    const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
    const max = Math.max(...timings);
    const min = Math.min(...timings);
    process.stderr.write(`  [soak] hung summary: avg=${avg}ms min=${min}ms max=${max}ms over ${CYCLES} cycles\n`);
    // Observed avg ~830ms on a 2024 Mac (STOP_TIMEOUT_MS=300 × ~2-3 attempts before
    // SIGKILL; SIGKILL_SETTLE_MS=2000 dominates — tightening settle would lower avg).
    // Floor 100ms catches stop-path bypass; 5s ceiling absorbs CI scheduling jitter.
    expect(avg).toBeLessThan(5_000);
    expect(avg).toBeGreaterThan(100);
  }, { timeout: 180_000 });
});

// ── Scenario 2: Graceful daemon restart cycle ──────────────────────────────────

describe('soak: graceful daemon restart cycle', () => {
  beforeEach(resetImpls);
  test('30 cycles — cooperative stop, SIGKILL never fires, avg < 2s', async () => {
    const CYCLES = 30;
    process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '2000';
    process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS = '100';

    await writeCredentials();
    await writeConsentedConfig();

    let currentProc: ReturnType<typeof Bun.spawn> = spawnDaemon(false /* cooperative */);
    const timings: number[] = [];

    // Track SIGKILL calls to the daemon PID being restarted each cycle.
    // Use a snapshot (spiedPid) updated at cycle start so the spy does not
    // read currentProc.pid live — after agentStart updates currentProc, live
    // reads would compare the old PID against the new one and miss the violation.
    const sigkillPids: number[] = [];
    let spiedPid: number = currentProc.pid!;
    const origKill = process.kill.bind(process);

    impls.agentStop = async (_name: string) => {
      try { currentProc.kill('SIGTERM'); } catch {}
    };

    impls.agentStatus = async (name: string) => {
      if (name !== 'agentbootup-brain') return { name, state: 'unknown', platform: 'test' };
      const pid = currentProc.pid;
      if (!pid) return { name, state: 'stopped', platform: 'test' };
      if (isAlive(pid)) return { name, state: 'running', pid, platform: 'test' };
      return { name, state: 'stopped', pid, platform: 'test' };
    };

    impls.agentStart = async (_config: Record<string, any>) => {
      const proc = spawnDaemon(false /* cooperative */);
      await awaitReady(proc);
      currentProc = proc;
      return { pid: proc.pid, port: null };
    };

    // Ensure SIGTERM handler is registered in the cooperative fixture before the
    // first restart cycle; without this there is a race if the OS schedules the
    // subprocess slowly.
    await awaitReady(currentProc);

    try {
      (process as any).kill = (pid: number, signal: number | string) => {
        if (String(signal) === 'SIGKILL' && pid === spiedPid) sigkillPids.push(pid);
        return (origKill as any)(pid, signal);
      };

      for (let i = 0; i < CYCLES; i++) {
        const pidBefore = currentProc.pid!;
        spiedPid = pidBefore; // snapshot PID before agentStart can update currentProc
        sigkillPids.length = 0;

        const t0 = Date.now();
        const { exitCode, logs } = await runCommand(['daemon', 'restart', '--no-transcripts', '--yes']);
        const elapsed = Date.now() - t0;
        timings.push(elapsed);

        expect(exitCode).toBeNull();
        expect(logs.join('\n')).toContain('Restart complete');
        expect(isAlive(pidBefore)).toBe(false);
        expect(isAlive(currentProc.pid!)).toBe(true);
        // SIGKILL must never be sent on the graceful path.
        // Sentinel: the process.kill(verifiedPid, 'SIGKILL') call inside ensureAgentStarted.
        expect(sigkillPids).toEqual([]);

        if ((i + 1) % 10 === 0) {
          const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
          process.stderr.write(`  [soak] graceful ${i + 1}/${CYCLES} elapsed=${elapsed}ms avg=${avg}ms\n`);
        }
      }
    } finally {
      (process as any).kill = origKill;
      try { currentProc.kill(); } catch {}
      delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
      delete process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS;
    }

    expect(timings.length).toBe(CYCLES);
    const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
    const max = Math.max(...timings);
    process.stderr.write(`  [soak] graceful summary: avg=${avg}ms max=${max}ms over ${CYCLES} cycles\n`);
    expect(avg).toBeLessThan(2_000);
    // Floor: > 0 (graceful restarts can be very fast on warm hardware; > 0 catches
    // a fully bypassed stop path that would produce zero avg).
    expect(avg).toBeGreaterThan(0);
  }, { timeout: 60_000 });
});

// ── Scenario 3: PID recycling safety net ──────────────────────────────────────
//
// AGENTBOOTUP_DAEMON_NO_KILL_POLL=1 makes pollProcessDead always return false —
// the same observable outcome as PID recycling (a new process at the old PID
// appears alive to kill-0). This verifies the fail-closed behaviour: when the
// settle poll cannot confirm death, the code must NOT start a duplicate daemon.

describe('soak: PID recycling safety net', () => {
  beforeEach(resetImpls);
  test('SIGKILL fires but death unconfirmed (AGENTBOOTUP_DAEMON_NO_KILL_POLL=1, mirrors PID reuse) → fail closed, no duplicate start', async () => {
    // 50ms (not 5ms) to absorb scheduler jitter; this scenario tests the
    // NO_KILL_POLL guard, not timing precision.
    process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS = '50';
    process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS = '50';
    // AGENTBOOTUP_DAEMON_NO_KILL_POLL=1 makes pollProcessDead always return false.
    // This is the same outcome PID recycling produces: kill-0 on the old PID
    // succeeds because a new unrelated process now holds it. The code must not
    // start a duplicate daemon when settle confirmation is unavailable.
    process.env.AGENTBOOTUP_DAEMON_NO_KILL_POLL = '1';

    await writeCredentials();
    await writeConsentedConfig();

    // Spawn a real stubborn process whose PID agentStatus will report as "running".
    // The production code SIGKILLs it; NO_KILL_POLL=1 then simulates PID recycling
    // by making pollProcessDead return false (death unconfirmable → fail closed).
    const stubborn = spawnDaemon(true);
    await awaitReady(stubborn); // trap "" TERM registered before restart cycle
    const stubbornPid = stubborn.pid!;
    const startCalls: number[] = [];

    // agentStatus intentionally never flips to stopped — this simulates PID reuse
    // after SIGKILL: a new unrelated process took the old PID, so kill-0 still
    // succeeds and pollProcessDead (bypassed by NO_KILL_POLL=1) can't confirm death.
    impls.agentStatus = async (name: string) => {
      if (name !== 'agentbootup-brain') return { name, state: 'unknown', platform: 'test' };
      return { name, state: 'running', pid: stubbornPid, platform: 'test' };
    };

    impls.agentStop = async (_name: string) => {
      // Graceful stop never works — simulates a daemon that survives SIGTERM.
    };

    impls.agentStart = async (_config: Record<string, any>) => {
      startCalls.push(Date.now());
      throw new Error('agentStart must not be called when PID recycling is detected (fail-closed guard broken)');
    };

    try {
      const { exitCode, errs } = await runCommand(['daemon', 'restart', '--no-transcripts', '--yes']);

      // Fail closed: no new daemon started (would be a duplicate)
      expect(startCalls).toHaveLength(0);
      // Exit 1 from handleStart's failure reporting. The !== null check guards against
      // runDaemonCommand swallowing the process.exit throw internally.
      expect(exitCode).not.toBeNull();
      expect(exitCode).toBe(1);
      // Error must surface that SIGKILL was tried but settle confirmation failed
      expect(errs.join('\n')).toMatch(/survived SIGKILL/i);
    } finally {
      delete process.env.AGENTBOOTUP_DAEMON_NO_KILL_POLL;
      // SIGKILL — stubborn fixture traps SIGTERM; bare kill() is a no-op.
      try { stubborn.kill('SIGKILL'); } catch {}
      delete process.env.AGENTBOOTUP_DAEMON_STOP_TIMEOUT_MS;
      delete process.env.AGENTBOOTUP_DAEMON_SIGKILL_SETTLE_MS;
    }
  }, { timeout: 30_000 });
});
