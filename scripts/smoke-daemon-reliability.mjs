#!/usr/bin/env bun
/**
 * scripts/smoke-daemon-reliability.mjs
 *
 * Smoke test for P0 daemon reliability (WO-1, WO-2):
 *   1. Doctor with serverUrl port 0 → exits 1 and reports error (WO-2)
 *   2. Daemon start with serverUrl port 0 → exits 1 before starting (WO-1)
 *
 * Uses temp creds/config so real ~/.agentbootup is untouched.
 * Exit 0 = PASS, exit 1 = BLOCK
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const tmpDir = mkdtempSync(join(tmpdir(), 'agentbootup-smoke-'));
const credsFile = join(tmpDir, 'credentials');
const configFile = join(tmpDir, 'config.json');

const env = {
  ...process.env,
  AGENTBOOTUP_CREDS_FILE: credsFile,
  AGENTBOOTUP_CONFIG_FILE: configFile,
};

function run(args, label) {
  const r = spawnSync(process.execPath, ['run', 'bootup.mjs', ...args], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { ...r, label };
}

async function main() {
  // Write temp creds (port 0) and config using the real modules so decrypt works in child
  const { writeCredentials } = await import('../lib/auth/credentials.js');
  const { writeConfig } = await import('../lib/config/config.js');
  await import('fs/promises').then((fsp) => fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 }));
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  await writeCredentials({ apiKey: 'smoke-key', serverUrl: 'http://localhost:0' });
  await writeConfig({ brainId: 'smoke-test' });

  let passed = 0;
  let failed = 0;

  try {
    // WO-2: doctor must report error for port 0 and exit non-zero
    const doctor = run(['doctor'], 'doctor with port 0 creds');
    const doctorError = doctor.stderr + doctor.stdout;
    const doctorRejectsPort0 =
      doctor.status !== 0 && (doctorError.includes('port 0') || doctorError.includes('Invalid'));
    if (doctorRejectsPort0) {
      console.log('  ✓ doctor with serverUrl port 0 → exit 1 and error message (WO-2)');
      passed++;
    } else {
      console.error('  ✗ doctor with port 0: expected exit 1 and port 0 / Invalid message', {
        status: doctor.status,
        stderr: doctor.stderr?.slice(0, 200),
      });
      failed++;
    }

    // WO-1: daemon start must reject invalid serverUrl before starting any daemon
    // (--no-brain so we only start transcripts; --yes for consent; validation runs first)
    const daemon = run(['daemon', 'start', '--no-brain', '--yes'], 'daemon start with port 0 creds');
    const daemonError = daemon.stderr + daemon.stdout;
    const daemonRejectsPort0 =
      daemon.status !== 0 && (daemonError.includes('port 0') || daemonError.includes('Invalid'));
    if (daemonRejectsPort0) {
      console.log('  ✓ daemon start with serverUrl port 0 → exit 1 before start (WO-1)');
      passed++;
    } else {
      console.error('  ✗ daemon start with port 0: expected exit 1 and port 0 / Invalid message', {
        status: daemon.status,
        stderr: daemon.stderr?.slice(0, 200),
      });
      failed++;
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('');
  if (failed > 0) {
    console.error(`SMOKE BLOCK: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`SMOKE PASS: ${passed} checks (daemon reliability WO-1, WO-2)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
