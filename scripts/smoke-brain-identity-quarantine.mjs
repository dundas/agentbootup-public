#!/usr/bin/env bun
/**
 * scripts/smoke-brain-identity-quarantine.mjs
 *
 * Smoke for PRD-0054 Slice A (identity handshake + 404 quarantine), driving
 * the REAL brain-asset-sync daemon subprocess:
 *   1. Unregistered brain (registry 404): startup handshake quarantines
 *      loudly (naming the register command), the daemon stays up, and sync
 *      cycles do NOT spin 404s against the push endpoint.
 *   2. Registry unavailable (5xx): handshake fails OPEN and the daemon
 *      proceeds to sync normally.
 *   3. Late registration: brain 404s at startup, then becomes registered;
 *      after the cooldown expires the next cycle succeeds and clears the
 *      quarantine.
 *
 * Temp creds/config; real ~/.agentbootup untouched. Exit 0 = PASS.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import http from 'http';

const tmpDir = mkdtempSync(join(tmpdir(), 'agentbootup-quarantine-smoke-'));
const credsFile = join(tmpDir, 'credentials');
const configFile = join(tmpDir, 'config.json');

function makeProject(name) {
  const projectRoot = join(tmpDir, name);
  mkdirSync(join(projectRoot, '.claude', 'skills', 'sample'), { recursive: true });
  writeFileSync(join(projectRoot, '.claude', 'skills', 'sample', 'SKILL.md'), '# sample\n');
  return projectRoot;
}

function startDaemon(projectRoot, serverUrl, extraEnv = {}) {
  const child = spawn(process.execPath, ['run', 'lib/daemon/brain-asset-sync.mjs'], {
    env: {
      ...process.env,
      AGENTBOOTUP_CREDS_FILE: credsFile,
      AGENTBOOTUP_CONFIG_FILE: configFile,
      AGENTBOOTUP_BRAIN_ID: 'quarantine-smoke.gm',
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
        resolve(true);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

async function stopDaemon(child) {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const force = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8_000);
    child.on('exit', () => { clearTimeout(force); resolve(); });
  });
}

/**
 * Mock server with a scriptable registry: `registered` flips scenario 3.
 * Counts pushes so scenario 1 can assert zero 404 spin.
 */
function makeServer(behavior) {
  const counts = { getBrain: 0, push: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/v1/brains/')) {
        counts.getBrain++;
        if (behavior.registryMode === '5xx') {
          res.writeHead(502); res.end('bad gateway'); return;
        }
        if (behavior.registered) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { id: 'quarantine-smoke.gm' } })); return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'not_found' } })); return;
      }
      if (req.method === 'POST' && req.url.includes('/brain-assets/')) {
        counts.push++;
        if (!behavior.registered) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'not_found' } })); return;
        }
        let files = [];
        try { files = JSON.parse(body).files ?? []; } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { results: files.map((f) => ({ path: f.path, status: 'pushed' })) } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: {} }));
    });
  });
  return { server, counts, behavior };
}

async function main() {
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  const { writeCredentials } = await import('../lib/auth/credentials.js');
  const { writeConfig } = await import('../lib/config/config.js');

  let passed = 0;
  let failed = 0;

  // ── Scenario 1: unregistered brain → loud quarantine, no 404 spin ─────────
  const s1 = makeServer({ registered: false, registryMode: 'ok' });
  await new Promise((r) => s1.server.listen(0, '127.0.0.1', r));
  const url1 = `http://127.0.0.1:${s1.server.address().port}`;
  await writeCredentials({ apiKey: 'smoke-key', serverUrl: url1 });
  await writeConfig({ brainId: 'quarantine-smoke.gm' });

  const d1 = startDaemon(makeProject('p1'), url1);
  const quarantined = await waitFor(d1.getOutput, 'agentbootup brain register quarantine-smoke.gm', 20_000);
  const running1 = await waitFor(d1.getOutput, 'Daemon running', 20_000);
  // Give it two would-be poll windows; quarantine must prevent any push.
  await new Promise((r) => setTimeout(r, 1_000));
  const noSpin = s1.counts.push === 0;
  await stopDaemon(d1.child);
  s1.server.close();

  if (quarantined && running1 && noSpin) {
    console.log(`  ✓ unregistered brain: loud quarantine with fix command, daemon up, zero push attempts (handshake calls=${s1.counts.getBrain})`);
    passed++;
  } else {
    console.error('  ✗ scenario 1 failed', { quarantined, running1, pushes: s1.counts.push });
    console.error(d1.getOutput().slice(-1500));
    failed++;
  }

  // ── Scenario 2: registry 5xx → fail-open, sync proceeds ───────────────────
  const s2 = makeServer({ registered: true, registryMode: '5xx' });
  await new Promise((r) => s2.server.listen(0, '127.0.0.1', r));
  const url2 = `http://127.0.0.1:${s2.server.address().port}`;
  await writeCredentials({ apiKey: 'smoke-key', serverUrl: url2 });

  const d2 = startDaemon(makeProject('p2'), url2);
  const failOpen = await waitFor(d2.getOutput, 'handshake inconclusive', 20_000);
  const synced2 = await waitFor(d2.getOutput, 'Sync complete: pushed=1', 20_000);
  await stopDaemon(d2.child);
  s2.server.close();

  if (failOpen && synced2) {
    console.log('  ✓ registry 5xx: handshake fails open and the first sync completes');
    passed++;
  } else {
    console.error('  ✗ scenario 2 failed', { failOpen, synced2 });
    console.error(d2.getOutput().slice(-1500));
    failed++;
  }

  // ── Scenario 3: late registration → cooldown expiry → success clears ──────
  const s3 = makeServer({ registered: false, registryMode: 'ok' });
  await new Promise((r) => s3.server.listen(0, '127.0.0.1', r));
  const url3 = `http://127.0.0.1:${s3.server.address().port}`;
  await writeCredentials({ apiKey: 'smoke-key', serverUrl: url3 });

  const d3 = startDaemon(makeProject('p3'), url3, {
    AGENTBOOTUP_BRAIN_404_COOLDOWN_MS: '2000',
    // Tight poll so the post-cooldown cycle happens fast: rely on the 60s
    // poll being too slow, so instead touch a file to trigger the debounced
    // watcher path after registration.
  });
  await waitFor(d3.getOutput, 'agentbootup brain register quarantine-smoke.gm', 20_000);
  await waitFor(d3.getOutput, 'Daemon running', 20_000);
  s3.behavior.registered = true; // brain gets registered
  await new Promise((r) => setTimeout(r, 2_200)); // cooldown expires
  // Trigger a sync via the file watcher.
  writeFileSync(join(tmpDir, 'p3', '.claude', 'skills', 'sample', 'SKILL.md'), '# sample v2\n');
  const cleared = await waitFor(d3.getOutput, 'identity quarantine cleared', 25_000);
  await stopDaemon(d3.child);
  s3.server.close();

  if (cleared) {
    console.log('  ✓ late registration: post-cooldown cycle succeeds and clears the quarantine');
    passed++;
  } else {
    console.error('  ✗ scenario 3 failed');
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
