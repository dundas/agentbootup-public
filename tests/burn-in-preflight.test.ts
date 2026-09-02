import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { preflightBurnInRemote } from '../scripts/burn-in/preflight';
import { readRows } from '../scripts/burn-in/ledger';
import type { BurnInConfig } from '../scripts/burn-in/config';

test('remote preflight failure records a sanitized terminal reset before service start', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'burn-in-preflight-'));
  try {
    const stateRoot = path.join(root, 'state');
    mkdirSync(stateRoot, { mode: 0o700 });
    const config = { brain: 'bootup', localDir: path.join(root, 'local'), miniSsh: 'operator@mini', knownHosts: path.join(root, 'known_hosts'), miniDir: '/srv/bootup', store: 'server://bootup', canonicalRef: 'refs/heads/main', canonicalCommit: 'a'.repeat(40), descriptorStateRoot: path.join(root, 'descriptors'), stateRoot, ledger: path.join(stateRoot, 'ledger.jsonl'), receipt: { brain: 'bootup', store: 'server://bootup', canonical_ref: 'refs/heads/main', local_root: 'configured', mini_target: 'operator@mini', remote_root: 'configured', ledger: 'owned' } } satisfies BurnInConfig;
    expect(await preflightBurnInRemote(config, async () => false)).toBe(false);
    expect(readRows(config.ledger)).toEqual([expect.objectContaining({ reset: true, note: 'terminal/remote_preflight_failed' })]);
    expect(JSON.stringify(readRows(config.ledger))).not.toContain(config.miniDir);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
