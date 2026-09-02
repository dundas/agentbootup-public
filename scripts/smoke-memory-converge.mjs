#!/usr/bin/env bun
/**
 * scripts/smoke-memory-converge.mjs — PRD-0054 Slice B smoke.
 *
 * Drives the REAL brain-asset-sync daemon subprocess with the converge legs
 * enabled against a temp file:// store:
 *   1. Operator publishes on checkout A → daemon on checkout B converges the
 *      page within one interval, logs the gate opening, and pushes memory/**
 *      to the (mock) asset server only after the gate opens.
 *   2. A deletes the page + publishes → B's copy is tombstone-removed.
 *   3. Unreachable store: gate stays closed — memory/** never reaches the
 *      asset server, while non-memory assets still sync.
 * Conflict-path scenarios are deliberately absent pending the PR-2a ruling
 * (consultation msg-1784289785400-r949fp). Exit 0 = PASS.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const daemonEntry = join(repoRoot, 'lib', 'daemon', 'brain-asset-sync.mjs');

const tmpDir = mkdtempSync(join(tmpdir(), 'agentbootup-converge-smoke-'));
const credsFile = join(tmpDir, 'credentials');
const configFile = join(tmpDir, 'config.json');

function makeCheckout(name) {
  const dir = join(tmpDir, name);
  mkdirSync(join(dir, 'memory'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'skills', 's'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', 's', 'SKILL.md'), '# s\n');
  writeFileSync(join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'converge-smoke.gm' }));
  // `dir` is under our private mkdtemp root and the policy basename is fixed.
  writeFileSync(join(dir, 'brain-backup.json'), JSON.stringify({ // nosemgrep
    schema: 'brain-backup/1',
    brain_id: 'converge-smoke.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  return dir;
}

function startDaemon(projectRoot, serverUrl, storeUrl) {
  const child = spawn(process.execPath, ['run', daemonEntry], {
    env: {
      ...process.env,
      AGENTBOOTUP_CREDS_FILE: credsFile,
      AGENTBOOTUP_CONFIG_FILE: configFile,
      AGENTBOOTUP_BRAIN_ID: 'converge-smoke.gm',
      AGENTBOOTUP_PROJECT_ROOT: projectRoot,
      AGENTBOOTUP_BRAIN_SYNC_STATE_FILE: join(projectRoot, 'sync-state.json'),
      AGENTBOOTUP_DAEMON_DIR: join(projectRoot, 'daemon-state'),
      AGENTBOOTUP_DISABLE_HEALTH_SERVER: '1',
      AGENTBOOTUP_MEMORY_CONVERGE_ENABLED: '1',
      AGENTBOOTUP_MEMORY_CONVERGE_INTERVAL_MS: '1500',
      AGENTBOOTUP_MEMORY_STORE: storeUrl,
      AGENTBOOTUP_MACHINE_ID_FILE: join(tmpDir, 'machine-id'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  return { child, getOutput: () => output };
}

function waitFor(fn, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (fn()) { clearInterval(t); resolve(true); }
      else if (Date.now() - startedAt > timeoutMs) { clearInterval(t); resolve(false); }
    }, 150);
  });
}

async function stopDaemon(child) {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const force = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8_000);
    child.on('exit', () => { clearTimeout(force); resolve(); });
  });
}

function makeAssetServer() {
  const pushedPaths = []; // entries: { path, at } — ordered, timestamped
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/v1/brains/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'converge-smoke.gm' } })); return;
      }
      if (req.method === 'POST' && req.url.includes('/brain-assets/')) {
        let files = [];
        try { files = JSON.parse(body).files ?? []; } catch { /* ignore */ }
        for (const f of files) pushedPaths.push({ path: f.path, at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { results: files.map((f) => ({ path: f.path, status: 'pushed' })) } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: {} }));
    });
  });
  return { server, pushedPaths };
}

async function main() {
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  // One machine id for creds + daemon (creds are machine-id-bound); publisher
  // identities still differ per checkout (machineId x checkout realpath).
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = join(tmpDir, 'machine-id');
  const { writeCredentials } = await import('../lib/auth/credentials.js');
  const { writeConfig } = await import('../lib/config/config.js');
  const { runMemoryCommand } = await import('../lib/memory/cli.js');
  const io = { stdout: () => {}, stderr: () => {} };

  let passed = 0;
  let failed = 0;

  const storeRoot = join(tmpDir, 'store');
  mkdirSync(storeRoot, { recursive: true });
  const storeUrl = `file://${storeRoot}`;
  const A = makeCheckout('A');
  const B = makeCheckout('B');

  const { server, pushedPaths } = makeAssetServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  await writeCredentials({ apiKey: 'smoke-key', serverUrl });
  await writeConfig({ brainId: 'converge-smoke.gm' });

  // Publish from A (operator side, same machine id, distinct checkout identity).
  writeFileSync(join(A, 'memory', 'MEMORY.md'), 'fleet truth v1\n');
  if (await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io) !== 0) {
    console.error('  ✗ setup: publish from A failed'); failed++;
  }

  // ── Scenario 1: B daemon converges A's page, gate opens, memory syncs ─────
  const d1 = startDaemon(B, serverUrl, storeUrl);
  const converged = await waitFor(() => fs.existsSync(join(B, 'memory', 'MEMORY.md')), 25_000);
  // Use the daemon's OWN log timestamp for the gate event — a polled
  // observation time lags the event and breaks the ordering comparison.
  let gateOpenAt = 0;
  const gateLogged = await waitFor(() => {
    if (gateOpenAt) return true;
    const m = d1.getOutput().match(/^(\S+) \[brain-asset-sync\] Memory converge gate open/m);
    if (m) { gateOpenAt = Date.parse(m[1]); return true; }
    return false;
  }, 10_000);
  const memoryPushed = await waitFor(() => pushedPaths.some((p) => p.path.startsWith('memory/')), 25_000);
  // ORDER assertion (roborev): the first memory/** upload must be AT OR
  // AFTER the gate-open event. Same-millisecond is deliberately allowed:
  // the gate check happens synchronously before discovery within one cycle,
  // so gate-open and the first push can share a ms tick — what must never
  // happen is a push with an EARLIER timestamp.
  const firstMemoryPushAt = pushedPaths.find((p) => p.path.startsWith('memory/'))?.at ?? 0;
  const orderedCorrectly = gateOpenAt > 0 && firstMemoryPushAt >= gateOpenAt;
  if (converged && gateLogged && memoryPushed && orderedCorrectly &&
      fs.readFileSync(join(B, 'memory', 'MEMORY.md'), 'utf8') === 'fleet truth v1\n') {
    console.log('  ✓ A publish → B daemon converges, gate opens, memory/** first syncs at-or-after gate-open');
    passed++;
  } else {
    console.error('  ✗ scenario 1', { converged, gateLogged, memoryPushed, orderedCorrectly, gateOpenAt, firstMemoryPushAt });
    console.error(d1.getOutput().slice(-1500));
    failed++;
  }

  // ── Scenario 2: deletion on A tombstone-propagates to B ───────────────────
  rmSync(join(A, 'memory', 'MEMORY.md'));
  writeFileSync(join(A, 'memory', 'KEEP.md'), 'keep\n');
  const pubRc = await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io);
  const removed = pubRc === 0
    ? await waitFor(() => !fs.existsSync(join(B, 'memory', 'MEMORY.md')) && fs.existsSync(join(B, 'memory', 'KEEP.md')), 25_000)
    : false;
  await stopDaemon(d1.child);
  if (pubRc === 0 && removed) {
    console.log('  ✓ deletion on A tombstone-removes on B while other pages persist');
    passed++;
  } else {
    console.error('  ✗ scenario 2', { pubRc, removed });
    console.error(d1.getOutput().slice(-1500));
    failed++;
  }

  // ── Scenario 3: unreachable store → gate stays closed, memory never pushes ─
  const C = makeCheckout('C');
  writeFileSync(join(C, 'memory', 'MEMORY.md'), 'must not leak\n');
  pushedPaths.length = 0;
  const d3 = startDaemon(C, serverUrl, `file://${join(tmpDir, 'no-such-store')}`);
  await waitFor(() => d3.getOutput().includes('Sync complete'), 25_000);
  await new Promise((r) => setTimeout(r, 2_000)); // extra cycles
  const leaked = pushedPaths.some((p) => p.path.startsWith('memory/'));
  const nonMemorySynced = pushedPaths.some((p) => p.path.startsWith('.claude/'));
  await stopDaemon(d3.child);
  server.close();
  if (!leaked && nonMemorySynced) {
    console.log('  ✓ unreachable store: gate stays closed — memory/** withheld, non-memory assets sync');
    passed++;
  } else {
    console.error('  ✗ scenario 3', { leaked, nonMemorySynced });
    console.error(d3.getOutput().slice(-1500));
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
