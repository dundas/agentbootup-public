import { test, expect } from 'bun:test';
import { remoteHealthArgv, remoteRootArgv } from '../scripts/burn-in/health';
import { remoteAttestArgv } from '../scripts/burn-in/preflight';
import { remoteProbeArgv } from '../scripts/burn-in/probe';
import type { BurnInConfig } from '../scripts/burn-in/config';
import { mkdtempSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const knownHosts = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'burn-in-known-hosts-'))), 'known_hosts');
writeFileSync(knownHosts, 'mini ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest\n', { mode: 0o600 });
const canonicalKnownHosts = realpathSync(knownHosts);
const config = { brain: 'bootup', localDir: '/local', miniSsh: 'operator@mini', knownHosts, miniDir: '/srv/bootup', store: 'server://bootup', canonicalRef: 'refs/heads/main', canonicalCommit: 'a'.repeat(40), descriptorStateRoot: '/state/descriptors', stateRoot: '/state', ledger: '/state/ledger', receipt: { brain: 'bootup', store: 'server://bootup', canonical_ref: 'refs/heads/main', local_root: 'configured', mini_target: 'operator@mini', remote_root: 'configured', ledger: 'owned' } } satisfies BurnInConfig;

const sshPrefix = ['ssh', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `UserKnownHostsFile=${canonicalKnownHosts}`, '-o', 'StrictHostKeyChecking=yes', '--'];

test('all remote burn-in calls have fixed helper argv and no shell payload', () => {
  expect(remoteHealthArgv('operator@mini', 'bootup', knownHosts)).toEqual([...sshPrefix, 'operator@mini', 'agentbootup', 'burn-in', 'remote', 'health', '--brain', 'bootup']);
  expect(remoteRootArgv('operator@mini', '/srv/bootup', knownHosts)).toEqual([...sshPrefix, 'operator@mini', 'agentbootup', 'burn-in', 'remote', 'root', '--root', '/srv/bootup']);
  expect(remoteAttestArgv(config)).toEqual([...sshPrefix, 'operator@mini', 'agentbootup', 'burn-in', 'remote', 'attest', '--root', '/srv/bootup', '--brain', 'bootup', '--ref', 'refs/heads/main', '--commit', 'a'.repeat(40)]);
  expect(remoteProbeArgv('operator@mini', 'write', ['--root', '/srv/bootup', '--marker', 'memory/daily/burn-in-probe-macbook-to-mini-1.md'], knownHosts)).toEqual(['ssh', '-o', 'ConnectTimeout=15', ...sshPrefix.slice(3), 'operator@mini', 'agentbootup', 'burn-in', 'remote', 'write', '--root', '/srv/bootup', '--marker', 'memory/daily/burn-in-probe-macbook-to-mini-1.md']);
});

test('remote argv builders reject control, option, and shell injection inputs', () => {
  expect(() => remoteHealthArgv('-oProxyCommand=x', 'bootup', knownHosts)).toThrow();
  expect(() => remoteRootArgv('operator@mini', '/srv/x\n--evil', knownHosts)).toThrow();
  expect(() => remoteProbeArgv('operator@mini', 'write', ['--root', '/srv/x;id', '--marker', 'memory/daily/burn-in-probe-macbook-to-mini-1.md'], knownHosts)).toThrow();
  expect(() => remoteProbeArgv('operator@mini', 'write' as any, ['--root', '/srv/x', '--marker', 'memory/daily/not-a-probe.md'], knownHosts)).toThrow();
  expect(() => remoteAttestArgv({ ...config, canonicalRef: 'refs/heads/main\n--evil' })).toThrow();
  expect(() => remoteHealthArgv('operator@mini', 'bootup', path.join(realpathSync(tmpdir()), 'does-not-exist'))).toThrow('must exist');
});
