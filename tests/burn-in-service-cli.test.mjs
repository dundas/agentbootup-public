import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('released CLI exposes a read-only per-brain burn-in service status command', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'burn-in-service-cli-')));
  roots.push(root);
  const runtime = path.join(root, 'runtime');
  const state = path.join(root, 'state');
  const descriptorState = path.join(root, 'descriptors');
  const knownHosts = path.join(root, 'known_hosts');
  fs.mkdirSync(runtime);
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(descriptorState, { mode: 0o700 });
  fs.writeFileSync(knownHosts, 'mini ssh-ed25519 AAAA');
  fs.chmodSync(knownHosts, 0o600);

  const result = spawnSync('node', ['bootup.mjs', 'burn-in', 'service', 'status'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTBOOTUP_BURNIN_BRAIN: 'bootup',
      AGENTBOOTUP_BURNIN_LOCAL_DIR: runtime,
      AGENTBOOTUP_BURNIN_MINI_SSH: 'operator@mini',
      AGENTBOOTUP_BURNIN_KNOWN_HOSTS: knownHosts,
      AGENTBOOTUP_BURNIN_REMOTE_DIR: '/srv/bootup',
      AGENTBOOTUP_BURNIN_STORE: 'server://bootup',
      AGENTBOOTUP_BURNIN_CANONICAL_REF: 'refs/heads/main',
      AGENTBOOTUP_BURNIN_CANONICAL_COMMIT: 'a'.repeat(40),
      AGENTBOOTUP_BURNIN_STATE_ROOT: state,
      AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT: descriptorState,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).burn_in_service.name, 'agentbootup-burn-in-bootup');
  assert.equal(fs.readdirSync(root).sort().join(','), 'descriptors,known_hosts,runtime,state');
});
