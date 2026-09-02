import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runNetworkCommand } from '../lib/network/cli-router.js';
import { getWatchHealth } from '../lib/network/runtime/watch-agent.js';

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

test('watch command supports install/start tick/status/stop lifecycle', async () => {
  const root = mkd('agentbootup-watch-daemon-');
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2)
  );

  const installRun = makeIo();
  assert.equal(await runNetworkCommand(['watch', '--install', '--cwd', root], installRun.io), 0);
  assert.match(installRun.out.join('\n'), /installed/);

  const startRun = makeIo();
  assert.equal(await runNetworkCommand(['watch', '--start', '--cwd', root], startRun.io), 0);
  assert.match(startRun.out.join('\n'), /non-persistent mode/);

  const statusRun = makeIo();
  assert.equal(await runNetworkCommand(['watch', '--status', '--cwd', root], statusRun.io), 0);
  assert.match(statusRun.out.join('\n'), /stopped/);
  assert.match(statusRun.out.join('\n'), /PID:/);

  const stopRun = makeIo();
  assert.equal(await runNetworkCommand(['watch', '--stop', '--cwd', root], stopRun.io), 0);
  assert.match(stopRun.out.join('\n'), /stopped/);
});

test('watch health reports stale pid as stopped', async () => {
  const root = mkd('agentbootup-watch-stale-pid-');
  fs.writeFileSync(
    path.join(root, '.agentbootup-watch.json'),
    JSON.stringify({
      running: true,
      installed: true,
      pid: 999999,
      lastHeartbeatAt: new Date().toISOString(),
      lastTickAt: new Date().toISOString(),
    }, null, 2)
  );

  const health = getWatchHealth(root);
  assert.equal(health.running, false);
  assert.equal(health.healthy, false);
});

test('watch command rejects overflow interval and conflicting mode flags', async () => {
  const root = mkd('agentbootup-watch-guardrails-');
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2)
  );

  const overflow = makeIo();
  assert.equal(await runNetworkCommand(['watch', '--interval', '999d', '--cwd', root], overflow.io), 1);
  assert.match(overflow.err.join('\n'), /exceeds maximum/);

  const conflict = makeIo();
  assert.equal(await runNetworkCommand(['watch', '--once', '--start', '--cwd', root], conflict.io), 1);
  assert.match(conflict.err.join('\n'), /choose only one mode flag/);
});

test('doctor --fix attempts to auto-start watch daemon', { timeout: 70000 }, async () => {
  const root = mkd('agentbootup-watch-fix-');
  const project = path.join(root, 'p');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(project, 'GEMINI.md'), '# Gemini\n');
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'brain', 'CLAUDE.md'), '# Brain\n');

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'p', path: project, agent_id: 'p-gm' }],
    }, null, 2)
  );

  const run = makeIo();
  assert.equal(await runNetworkCommand(['doctor', '--fix', '--cwd', root], run.io), 0);
  const out = run.out.join('\n');
  assert.match(out, /watch_daemon: auto-start attempted/);
  const health = getWatchHealth(root);
  assert.equal(health.running, true);
  assert.equal(health.pendingServices, false);
});
