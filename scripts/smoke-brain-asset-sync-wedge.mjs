#!/usr/bin/env bun
/**
 * scripts/smoke-brain-asset-sync-wedge.mjs
 *
 * Smoke test for the brain-asset-sync wedge fixes (bug report
 * msg-1784215098537-ia98qk):
 *   1. Initial sync completes promptly on a repo with a large node_modules
 *      tree (walk pruning + walkDepth) and logs "Sync complete".
 *   2. With a server that accepts connections but never responds, the sync
 *      watchdog aborts the cycle and daemon startup still reaches
 *      "Daemon running" (startup is not wedged by a dead server).
 *
 * Runs the REAL daemon as a subprocess with temp creds/config so the real
 * ~/.agentbootup is untouched. Exit 0 = PASS, exit 1 = BLOCK.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import http from 'http';

const tmpDir = mkdtempSync(join(tmpdir(), 'agentbootup-wedge-smoke-'));
const credsFile = join(tmpDir, 'credentials');
const configFile = join(tmpDir, 'config.json');

function makeProject(name) {
  const projectRoot = join(tmpDir, name);
  mkdirSync(join(projectRoot, '.claude', 'skills', 'sample'), { recursive: true });
  writeFileSync(join(projectRoot, '.claude', 'skills', 'sample', 'SKILL.md'), '# sample\n');
  writeFileSync(join(projectRoot, 'CLAUDE.md'), '# root config\n');
  // A large node_modules tree at the project root: 200 packages x 10 files,
  // nested 3 deep. Before the fix the walker visited every one of these on
  // every cycle; the smoke asserts the initial sync still completes fast.
  for (let p = 0; p < 200; p++) {
    const pkg = join(projectRoot, 'node_modules', `pkg-${p}`, 'lib', 'dist');
    mkdirSync(pkg, { recursive: true });
    for (let f = 0; f < 10; f++) writeFileSync(join(pkg, `file-${f}.js`), '// filler\n');
  }
  return projectRoot;
}

function startDaemon(projectRoot, serverUrl, extraEnv = {}) {
  // Bun does not propagate parent env mutations into children automatically —
  // pass the full env explicitly.
  const child = spawn(process.execPath, ['run', 'lib/daemon/brain-asset-sync.mjs'], {
    env: {
      ...process.env,
      AGENTBOOTUP_CREDS_FILE: credsFile,
      AGENTBOOTUP_CONFIG_FILE: configFile,
      AGENTBOOTUP_BRAIN_ID: 'wedge-smoke.gm',
      AGENTBOOTUP_PROJECT_ROOT: projectRoot,
      AGENTBOOTUP_BRAIN_SYNC_STATE_FILE: join(projectRoot, 'sync-state.json'),
      AGENTBOOTUP_DAEMON_DIR: join(projectRoot, 'daemon-state'),
      AGENTBOOTUP_DISABLE_HEALTH_SERVER: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, getOutput: () => output };
}

function waitFor(getOutput, needle, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (getOutput().includes(needle)) {
        clearInterval(timer);
        resolve({ found: true, elapsedMs: Date.now() - startedAt });
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve({ found: false, elapsedMs: Date.now() - startedAt });
      }
    }, 100);
  });
}

async function stopDaemon(child, forceAfterMs = 10_000) {
  const startedAt = Date.now();
  child.kill('SIGTERM');
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ forced: true, exitCode: null, elapsedMs: Date.now() - startedAt });
    }, forceAfterMs);
    child.on('exit', (code) => {
      clearTimeout(force);
      resolve({ forced: false, exitCode: code, elapsedMs: Date.now() - startedAt });
    });
  });
}

async function main() {
  // Real credential/config modules so the child can decrypt them.
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  const { writeCredentials } = await import('../lib/auth/credentials.js');
  const { writeConfig } = await import('../lib/config/config.js');

  let passed = 0;
  let failed = 0;

  // ── Scenario 1: healthy server, big repo — initial sync completes fast ──
  const okServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let files = [];
      try { files = JSON.parse(body).files ?? []; } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: { results: files.map((f) => ({ path: f.path, status: 'pushed' })) },
      }));
    });
  });
  await new Promise((resolve) => okServer.listen(0, '127.0.0.1', resolve));
  const okUrl = `http://127.0.0.1:${okServer.address().port}`;

  await writeCredentials({ apiKey: 'smoke-key', serverUrl: okUrl });
  await writeConfig({ brainId: 'wedge-smoke.gm' });

  const proj1 = makeProject('big-repo');
  const d1 = startDaemon(proj1, okUrl);
  const r1 = await waitFor(d1.getOutput, 'Sync complete', 30_000);
  const pushedAssets = d1.getOutput().includes('pushed=2');
  await stopDaemon(d1.child);
  okServer.close();

  if (r1.found && pushedAssets) {
    console.log(`  ✓ initial sync completed on big repo in ${r1.elapsedMs}ms (pushed=2: SKILL.md + CLAUDE.md)`);
    passed++;
  } else {
    console.error('  ✗ big-repo initial sync did not complete cleanly', {
      found: r1.found, elapsedMs: r1.elapsedMs, pushedAssets,
    });
    console.error(d1.getOutput().slice(-2000));
    failed++;
  }

  // ── Scenario 2: black-hole server — watchdog recovers, startup completes ──
  const deadServer = http.createServer(() => { /* accept, never respond */ });
  await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
  const deadUrl = `http://127.0.0.1:${deadServer.address().port}`;
  await writeCredentials({ apiKey: 'smoke-key', serverUrl: deadUrl });

  const proj2 = makeProject('dead-server-repo');
  const d2 = startDaemon(proj2, deadUrl, { AGENTBOOTUP_SYNC_WATCHDOG_MS: '3000' });
  const r2 = await waitFor(d2.getOutput, 'Daemon running', 30_000);
  const watchdogFired = d2.getOutput().includes('Sync watchdog');
  await stopDaemon(d2.child);

  if (r2.found && watchdogFired) {
    console.log(`  ✓ watchdog aborted the wedged cycle and startup reached "Daemon running" in ${r2.elapsedMs}ms`);
    passed++;
  } else {
    console.error('  ✗ dead-server startup did not recover via watchdog', {
      found: r2.found, elapsedMs: r2.elapsedMs, watchdogFired,
    });
    console.error(d2.getOutput().slice(-2000));
    failed++;
  }

  // ── Scenario 3: SIGTERM during a wedged cycle — shutdown exits promptly ──
  // Long sync watchdog (60s) so shutdown's own bound is what saves us; the
  // in-flight wait and the final flush are each capped at 1s, so graceful
  // exit must land well inside an orchestrator grace period.
  const proj3 = makeProject('shutdown-repo');
  const d3 = startDaemon(proj3, deadUrl, {
    AGENTBOOTUP_SYNC_WATCHDOG_MS: '60000',
    AGENTBOOTUP_SHUTDOWN_SYNC_WAIT_MS: '1000',
  });
  const r3 = await waitFor(d3.getOutput, 'Signal handlers installed', 30_000);
  // Wait for the initial sync cycle to actually be in flight before SIGTERM.
  // PRD-0054/0059 added a bounded memory-converge startup phase between
  // "Signal handlers installed" and the initial asset sync, so a fixed 500ms
  // gap no longer lands during the sync — it lands during converge. The
  // "NOTE canonical source" log fires when syncPendingFiles runs for a brain
  // with no source descriptor (this smoke's project), the reliable signal that
  // the initial sync has started and its fetch to the dead server is wedging.
  // Then give the fetch a short beat to take the sync lock before SIGTERM.
  await waitFor(d3.getOutput, 'NOTE canonical source', 30_000);
  await new Promise((r) => setTimeout(r, 300));
  const stop3 = await stopDaemon(d3.child, 8_000);
  deadServer.closeAllConnections?.();
  deadServer.close();

  // With the cycle still wedged past the bounded wait, shutdown must say so
  // honestly instead of silently rejoining the stuck cycle as a "final flush".
  const skippedFlush = d3.getOutput().includes('skipping final flush');
  if (r3.found && !stop3.forced && stop3.exitCode === 0 && skippedFlush) {
    console.log(`  ✓ SIGTERM during wedged cycle: graceful exit 0 in ${stop3.elapsedMs}ms, final flush honestly skipped`);
    passed++;
  } else {
    console.error('  ✗ shutdown did not exit promptly/honestly during a wedged cycle', {
      started: r3.found, forced: stop3.forced, exitCode: stop3.exitCode, elapsedMs: stop3.elapsedMs, skippedFlush,
    });
    console.error(d3.getOutput().slice(-2000));
    failed++;
  }

  console.log(`\nSmoke result: ${passed} passed, ${failed} failed → ${failed === 0 ? 'PASS' : 'BLOCK'}`);
  return failed === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error('Smoke error:', err);
  process.exitCode = 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
