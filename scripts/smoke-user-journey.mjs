#!/usr/bin/env bun
/**
 * scripts/smoke-user-journey.mjs
 *
 * Real user smoke: run the "Getting Started" journey in an isolated env.
 * Requires AGENTBOOTUP_SMOKE_API_KEY (and optional AGENTBOOTUP_SMOKE_SERVER_URL).
 *
 * Journey:
 *   1. auth login
 *   2. config set-brain
 *   3. doctor (must run; may warn daemon not running / archive missing)
 *   4. daemon start --yes (must not crash; may fail connect if key invalid)
 *   5. daemon status
 *   6. daemon stop (cleanup)
 *
 * Exit 0 = PASS, exit 1 = BLOCK
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const apiKey = process.env.AGENTBOOTUP_SMOKE_API_KEY;
const serverUrl = process.env.AGENTBOOTUP_SMOKE_SERVER_URL || 'https://agentbootup.fly.dev';

if (!apiKey) {
  console.error('Real user smoke requires AGENTBOOTUP_SMOKE_API_KEY');
  console.error('Example: AGENTBOOTUP_SMOKE_API_KEY=your-key bun run scripts/smoke-user-journey.mjs');
  process.exit(1);
}

const tmpDir = mkdtempSync(join(tmpdir(), 'agentbootup-user-smoke-'));
const projectDir = mkdtempSync(join(tmpdir(), 'agentbootup-user-smoke-project-'));
const credsFile = join(tmpDir, 'credentials');
const configFile = join(tmpDir, 'config.json');
const syncStateFile = join(tmpDir, 'sync-state.json');
const daemonDir = join(tmpDir, 'daemon');
const transcriptsDir = join(tmpDir, 'transcripts');
// Doctor checks for CLI roots; create empty dirs so "roots found" doesn't fail
const cliRoot = join(tmpDir, 'cli');
const claudeRoot = join(cliRoot, 'claude');
const codexRoot = join(cliRoot, 'codex');
const geminiRoot = join(cliRoot, 'gemini');
const cursorRoot = join(cliRoot, 'cursor');

const baseEnv = {
  ...process.env,
  AGENTBOOTUP_CREDS_FILE: credsFile,
  AGENTBOOTUP_CONFIG_FILE: configFile,
  AGENTBOOTUP_SYNC_STATE_FILE: syncStateFile,
  AGENTBOOTUP_DAEMON_DIR: daemonDir,
  AGENTBOOTUP_TRANSCRIPTS_DIR: transcriptsDir,
  AGENTBOOTUP_RESTORE_ROOT_CLAUDE: claudeRoot,
  AGENTBOOTUP_RESTORE_ROOT_CODEX: codexRoot,
  AGENTBOOTUP_RESTORE_ROOT_GEMINI: geminiRoot,
  AGENTBOOTUP_RESTORE_ROOT_CURSOR: cursorRoot,
};

const repoRoot = join(import.meta.dir, '..');

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, ['run', 'bootup.mjs', ...args], {
    env: baseEnv,
    encoding: 'utf8',
    timeout: opts.timeout ?? 30_000,
    cwd: repoRoot,
  });
  return r;
}

async function main() {
  const { mkdir } = await import('fs/promises');
  await mkdir(claudeRoot, { recursive: true });
  await mkdir(codexRoot, { recursive: true });
  await mkdir(geminiRoot, { recursive: true });
  await mkdir(cursorRoot, { recursive: true });
  await mkdir(transcriptsDir, { recursive: true });

  let passed = 0;
  let failed = 0;

  try {
    // 1. auth login
    const auth = run(['auth', 'login', '--api-key', apiKey, '--server-url', serverUrl]);
    if (auth.status !== 0) {
      console.error('  ✗ auth login failed:', auth.stderr?.trim() || auth.error);
      failed++;
    } else {
      console.log('  ✓ auth login');
      passed++;
    }
    if (failed) throw new Error('Journey aborted after auth');

    // 2. config set-brain
    const config = run(['config', 'set-brain', 'smoke-test-brain']);
    if (config.status !== 0) {
      console.error('  ✗ config set-brain failed:', config.stderr?.trim());
      failed++;
    } else {
      console.log('  ✓ config set-brain');
      passed++;
    }
    if (failed) throw new Error('Journey aborted after config');

    // 3. doctor (must run; may have warnings)
    const doctor = run(['doctor']);
    const doctorOut = (doctor.stdout + doctor.stderr).trim();
    if (doctor.signal) {
      console.error('  ✗ doctor killed:', doctor.signal);
      failed++;
    } else {
      console.log('  ✓ doctor ran (exit %s)', doctor.status);
      passed++;
      if (doctorOut) console.log(doctorOut.split('\n').map((l) => '    ' + l).join('\n'));
    }
    if (failed) throw new Error('Journey aborted after doctor');

    // 4. daemon start --yes (must not crash)
    const start = run(['daemon', 'start', '--yes'], { timeout: 60_000 });
    const startOut = (start.stdout + start.stderr).trim();
    if (start.signal) {
      console.error('  ✗ daemon start killed:', start.signal);
      failed++;
    } else if (start.status !== 0 && !startOut.includes('Invalid') && !startOut.includes('unreachable') && !startOut.includes('Server')) {
      // Accept exit 1 only if it's a clear connectivity/validation error, not a crash
      console.error('  ✗ daemon start failed (unexpected):', startOut.slice(0, 300));
      failed++;
    } else {
      console.log('  ✓ daemon start (exit %s)', start.status);
      passed++;
      if (startOut) console.log(startOut.split('\n').map((l) => '    ' + l).join('\n'));
    }

    // 5. daemon status
    const status = run(['daemon', 'status']);
    if (status.signal) {
      console.error('  ✗ daemon status killed:', status.signal);
      failed++;
    } else {
      console.log('  ✓ daemon status (exit %s)', status.status);
      passed++;
      if (status.stdout?.trim()) console.log(status.stdout.trim().split('\n').map((l) => '    ' + l).join('\n'));
    }

    // 6. daemon stop (cleanup)
    const stop = run(['daemon', 'stop']);
    if (stop.signal) {
      console.error('  ⚠ daemon stop killed:', stop.signal);
    } else {
      console.log('  ✓ daemon stop (cleanup)');
    }
  } catch (err) {
    console.error(err.message);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }

  console.log('');
  if (failed > 0) {
    console.error(`USER JOURNEY SMOKE BLOCK: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`USER JOURNEY SMOKE PASS: ${passed} steps`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
