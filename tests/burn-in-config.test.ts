import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, chmodSync, realpathSync, writeFileSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadBurnInConfig } from '../scripts/burn-in/config';

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'burn-in-config-'))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function env(overrides: Record<string, string | undefined> = {}) {
  const local = path.join(dir, 'local');
  const remote = '/srv/bootup';
  const stateRoot = path.join(dir, 'state');
  const knownHosts = path.join(dir, 'known_hosts');
  mkdirSync(local, { recursive: true });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  writeFileSync(knownHosts, 'mini ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest\n', { mode: 0o600 });
  return {
    AGENTBOOTUP_BURNIN_BRAIN: 'bootup',
    AGENTBOOTUP_BURNIN_LOCAL_DIR: local,
    AGENTBOOTUP_BURNIN_MINI_SSH: 'operator@davids-mac-mini.lan',
    AGENTBOOTUP_BURNIN_KNOWN_HOSTS: knownHosts,
    AGENTBOOTUP_BURNIN_REMOTE_DIR: remote,
    AGENTBOOTUP_BURNIN_STORE: 'server://bootup',
    AGENTBOOTUP_BURNIN_CANONICAL_REF: 'refs/heads/main',
    AGENTBOOTUP_BURNIN_CANONICAL_COMMIT: 'a'.repeat(40),
    AGENTBOOTUP_BURNIN_STATE_ROOT: stateRoot,
    ...overrides,
  };
}

describe('standalone burn-in configuration', () => {
  test('requires every runtime identity input; no Circle fallback exists', () => {
    for (const key of ['AGENTBOOTUP_BURNIN_BRAIN', 'AGENTBOOTUP_BURNIN_LOCAL_DIR', 'AGENTBOOTUP_BURNIN_MINI_SSH', 'AGENTBOOTUP_BURNIN_KNOWN_HOSTS', 'AGENTBOOTUP_BURNIN_REMOTE_DIR', 'AGENTBOOTUP_BURNIN_STORE', 'AGENTBOOTUP_BURNIN_CANONICAL_REF', 'AGENTBOOTUP_BURNIN_CANONICAL_COMMIT', 'AGENTBOOTUP_BURNIN_STATE_ROOT']) {
      const values = env({ [key]: undefined });
      expect(() => loadBurnInConfig(values)).toThrow(key);
    }
  });

  test('accepts explicit standalone config and does not serialize roots in its receipt', () => {
    const config = loadBurnInConfig(env());
    expect(config.brain).toBe('bootup');
    expect(config.store).toBe('server://bootup');
    expect(JSON.stringify(config.receipt)).not.toContain(dir);
    expect(JSON.stringify(config.receipt)).not.toContain('/srv/bootup');
  });

  test('accepts a trailing slash on the configured local runtime directory', () => {
    const config = loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_LOCAL_DIR: `${path.join(dir, 'local')}${path.sep}` }));
    expect(config.localDir).toBe(path.join(dir, 'local'));
  });

  test('creates a fresh nested owned state root without modifying its parent', () => {
    const stateRoot = path.join(dir, 'new', 'nested', 'state');
    const config = loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_STATE_ROOT: stateRoot }));
    expect(config.stateRoot).toBe(stateRoot);
    expect(require('fs').statSync(stateRoot).mode & 0o777).toBe(0o700);
  });

  test('rejects a local runtime symlink and a ledger inside the checkout', () => {
    const target = path.join(dir, 'target');
    mkdirSync(target);
    const linked = path.join(dir, 'linked');
    symlinkSync(target, linked);
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_LOCAL_DIR: linked }))).toThrow('symlink');
    expect(loadBurnInConfig(env()).ledger).toBe(path.join(path.join(dir, 'state'), 'burn-in-bootup.jsonl'));
  });

  test('rejects a ledger path through a symlinked state directory', () => {
    const state = path.join(dir, 'state-link-target');
    mkdirSync(state);
    const linked = path.join(dir, 'state-link');
    symlinkSync(state, linked);
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_STATE_ROOT: linked }))).toThrow('symlink');
  });

  test('rejects a lexical symlink ancestor even when dot-dot would normalize it away', () => {
    const target = path.join(dir, 'target');
    mkdirSync(target);
    const linked = path.join(dir, 'state-alias');
    symlinkSync(target, linked);
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_STATE_ROOT: `${linked}/../state` }))).toThrow('symlinked component');
  });

  test('rejects a shared state root and a ledger alias outside that owned root', () => {
    const shared = path.join(dir, 'shared');
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_STATE_ROOT: shared }))).toThrow('shared');
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_LEDGER: path.join(dir, 'other.jsonl') }))).toThrow('not supported');
  });

  test('requires a server store for the same brain and an absolute remote root', () => {
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_STORE: 'server://other' }))).toThrow('brain');
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_STORE: 'local' }))).toThrow('server://');
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_REMOTE_DIR: 'relative' }))).toThrow('absolute');
  });

  test('rejects missing, writable, and symlinked known-hosts trust files', () => {
    const missing = path.join(dir, 'missing_known_hosts');
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_KNOWN_HOSTS: missing }))).toThrow('must exist');
    const writable = path.join(dir, 'writable_known_hosts'); writeFileSync(writable, 'host key\n', { mode: 0o600 }); chmodSync(writable, 0o666);
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_KNOWN_HOSTS: writable }))).toThrow('writable');
    const linked = path.join(dir, 'linked_known_hosts'); symlinkSync(path.join(dir, 'known_hosts'), linked);
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_KNOWN_HOSTS: linked }))).toThrow('symlink');
  });

  test('rejects shared and symlinked known-hosts parent directories', () => {
    const shared = path.join(dir, 'shared-known-hosts');
    mkdirSync(shared, { mode: 0o700 }); chmodSync(shared, 0o770);
    const sharedKnownHosts = path.join(shared, 'known_hosts'); writeFileSync(sharedKnownHosts, 'host key\n', { mode: 0o600 });
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_KNOWN_HOSTS: sharedKnownHosts }))).toThrow('parent directories must not be group- or world-writable');

    const target = path.join(dir, 'known-hosts-target'); mkdirSync(target, { mode: 0o700 });
    const targetKnownHosts = path.join(target, 'known_hosts'); writeFileSync(targetKnownHosts, 'host key\n', { mode: 0o600 });
    const linked = path.join(dir, 'known-hosts-parent-link'); symlinkSync(target, linked);
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_KNOWN_HOSTS: path.join(linked, 'known_hosts') }))).toThrow('symlinked parent directory');
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_KNOWN_HOSTS: `${linked}/../known_hosts` }))).toThrow('symlinked parent directory');
  });

  test('allows only root-owned sticky writable known-hosts ancestors', () => {
    const stickyRoot = realpathSync('/tmp');
    const stickyStat = lstatSync(stickyRoot);
    expect(stickyStat.uid).toBe(0);
    expect(stickyStat.mode & 0o1000).not.toBe(0);
    expect(stickyStat.mode & 0o022).not.toBe(0);
    const stickyChild = mkdtempSync(path.join(stickyRoot, 'burn-in-known-hosts-'));
    try {
      const trusted = path.join(stickyChild, 'known_hosts'); writeFileSync(trusted, 'host key\n', { mode: 0o600 });
      expect(loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_KNOWN_HOSTS: trusted })).knownHosts).toBe(trusted);
    } finally { rmSync(stickyChild, { recursive: true, force: true }); }

    const worldWritable = path.join(dir, 'world-writable-known-hosts'); mkdirSync(worldWritable, { mode: 0o700 }); chmodSync(worldWritable, 0o777);
    const worldWritableKnownHosts = path.join(worldWritable, 'known_hosts'); writeFileSync(worldWritableKnownHosts, 'host key\n', { mode: 0o600 });
    expect(() => loadBurnInConfig(env({ AGENTBOOTUP_BURNIN_KNOWN_HOSTS: worldWritableKnownHosts }))).toThrow('unless root-owned sticky');
  });
});
