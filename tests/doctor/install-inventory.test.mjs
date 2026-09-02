import { describe, expect, test } from 'bun:test';
import {
  inspectAgentbootupInstalls,
  inventoryToDoctorIssues,
} from '../../lib/doctor/install-inventory.js';

function fakeDeps(overrides = {}) {
  const roots = new Map([
    ['/current', '/current'],
    ['/path/bin/agentbootup', '/path'],
    ['/brew/bin/agentbootup', '/brew'],
    ['/bun/bin/agentbootup', '/bun'],
    ['/foreign/lib/daemon/brain-asset-sync.mjs', '/foreign'],
    ['/foreign/lib/daemon/transcript-sync.mjs', '/foreign'],
    ['/current/lib/daemon/transcript-sync.mjs', '/current'],
  ]);
  const versions = new Map([
    ['/current/package.json', { name: 'agentbootup', version: '1.0.0' }],
    ['/path/package.json', { name: 'agentbootup', version: '2.0.0' }],
    ['/brew/package.json', { name: 'agentbootup', version: '3.0.0' }],
    ['/bun/package.json', { name: 'agentbootup', version: '4.0.0' }],
    ['/foreign/package.json', { name: 'agentbootup', version: '0.9.0' }],
  ]);
  return {
    pathDelimiter: ':',
    platform: 'darwin',
    env: { PATH: '/path/bin' },
    currentRoot: '/current',
    realpath: async (value) => value,
    stat: async (value) => ({ isFile: () => value.endsWith('agentbootup') || value.endsWith('.mjs') }),
    readPackage: async (file) => {
      if (!versions.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return versions.get(file);
    },
    resolveInstallRoot: async (candidate) => roots.get(candidate) ?? null,
    commandOutput: async (command, args) => {
      if (command === 'brew') return '/brew';
      if (command === 'bun') return '/bun/bin';
      if (command === 'ps') return [
        '101 node /foreign/lib/daemon/brain-asset-sync.mjs',
        '102 node /current/lib/daemon/transcript-sync.mjs',
      ].join('\n');
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    },
    processCwd: async (pid) => pid === 101 ? '/projects/alpha' : '/projects/current',
    ...overrides,
  };
}

describe('agentbootup install and daemon inventory', () => {
  test('discovers PATH, Homebrew, Bun, current, and process roots and reports differing versions', async () => {
    const inventory = await inspectAgentbootupInstalls(fakeDeps());
    expect(inventory.installs.map((entry) => entry.root).sort()).toEqual(
      ['/brew', '/bun', '/current', '/foreign', '/path'],
    );
    const issues = inventoryToDoctorIssues(inventory);
    const versionWarning = issues.find((issue) => issue.message.includes('Multiple agentbootup versions'));
    expect(versionWarning?.severity).toBe('warning');
    expect(versionWarning?.message).toContain('2.0.0');
    expect(versionWarning?.message).toContain('PATH');
    expect(versionWarning?.message).toContain('/brew');
  });

  test('canonicalizes aliases and does not warn for one root or distinct roots at one version', async () => {
    const deps = fakeDeps({
      env: { PATH: '/a/bin:/b/bin' },
      commandOutput: async (command) => command === 'ps' ? '' : (() => { throw new Error('unavailable'); })(),
      resolveInstallRoot: async (candidate) => {
        if (candidate === '/current') return '/real';
        if (candidate.endsWith('/agentbootup')) return candidate.startsWith('/a') ? '/real' : '/other';
        return null;
      },
      realpath: async (value) => value === '/other' ? '/other' : '/real',
      readPackage: async () => ({ name: 'agentbootup', version: '1.0.0' }),
    });
    const issues = inventoryToDoctorIssues(await inspectAgentbootupInstalls(deps));
    expect(issues.some((issue) => issue.message.includes('Multiple agentbootup versions'))).toBe(false);
    expect(issues.some((issue) => issue.severity === 'info' && issue.message.includes('same version'))).toBe(true);
  });

  test('reports each foreign daemon with PID, kind, project, root, and exact kill command', async () => {
    const inventory = await inspectAgentbootupInstalls(fakeDeps({
      commandOutput: async (command) => command === 'ps'
        ? '901 node /foreign/lib/daemon/brain-asset-sync.mjs\n902 env AGENTBOOTUP_PROJECT_ROOT=/projects/two node /foreign/lib/daemon/transcript-sync.mjs'
        : command === 'brew' ? '/brew' : '/bun/bin',
      processCwd: async (pid) => pid === 901 ? '/projects/one' : '/projects/two',
    }));
    const warnings = inventoryToDoctorIssues(inventory).filter((issue) => issue.message.includes('Foreign'));
    expect(warnings).toHaveLength(2);
    expect(warnings[0].message).toContain('PID 901');
    expect(warnings[0].message).toContain('brain-asset-sync');
    expect(warnings[0].message).toContain('/projects/one');
    expect(warnings[0].message).toContain('/foreign');
    expect(warnings[0].message).toContain('kill 901');
    expect(warnings[1].message).toContain('/projects/two');
  });

  test('current-root daemons do not warn', async () => {
    const inventory = await inspectAgentbootupInstalls(fakeDeps({
      commandOutput: async (command) => command === 'ps'
        ? '102 node /current/lib/daemon/transcript-sync.mjs'
        : command === 'brew' ? '/brew' : '/bun/bin',
      processCwd: async () => '/projects/current',
    }));
    expect(inventoryToDoctorIssues(inventory).some((issue) => issue.message.includes('Foreign'))).toBe(false);
  });

  test('ignores commands that only mention daemon filenames', async () => {
    const inventory = await inspectAgentbootupInstalls(fakeDeps({
      commandOutput: async (command) => command === 'ps'
        ? '777 rg brain-asset-sync.mjs /tmp/worktree\n778 vim /foreign/lib/daemon/transcript-sync.mjs'
        : command === 'brew' ? '/brew' : '/bun/bin',
    }));
    expect(inventory.daemons).toHaveLength(0);
    expect(inventoryToDoctorIssues(inventory).some((issue) => issue.message.includes('Foreign'))).toBe(false);
  });

  test('skips relative daemon scripts when cwd discovery fails instead of resolving against doctor cwd', async () => {
    const inventory = await inspectAgentbootupInstalls(fakeDeps({
      commandOutput: async (command) => command === 'ps'
        ? '777 node lib/daemon/transcript-sync.mjs'
        : command === 'brew' ? '/brew' : '/bun/bin',
      processCwd: async () => {
        throw new Error('permission denied');
      },
      resolveInstallRoot: async (candidate) => {
        if (candidate === '/current') return '/current';
        if (candidate.endsWith('/agentbootup')) return '/path';
        if (candidate === 'lib/daemon/transcript-sync.mjs') return '/foreign';
        return null;
      },
    }));
    expect(inventory.daemons).toHaveLength(0);
    const issues = inventoryToDoctorIssues(inventory);
    expect(issues.some((issue) => issue.message.includes('daemon cwd discovery failed for PID 777'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('relative script path lib/daemon/transcript-sync.mjs could not be resolved'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('Foreign transcript-sync daemon'))).toBe(false);
  });

  test('warns when a daemon launch is detected but its owning install root cannot be determined', async () => {
    const inventory = await inspectAgentbootupInstalls(fakeDeps({
      commandOutput: async (command) => command === 'ps'
        ? '901 node /gone/lib/daemon/transcript-sync.mjs'
        : command === 'brew' ? '/brew' : '/bun/bin',
      processCwd: async () => '/projects/gone',
      resolveInstallRoot: async (candidate) => {
        if (candidate === '/current') return '/current';
        if (candidate.endsWith('/agentbootup')) return '/path';
        if (candidate === '/gone/lib/daemon/transcript-sync.mjs') return null;
        return null;
      },
    }));
    expect(inventory.daemons).toHaveLength(0);
    const issues = inventoryToDoctorIssues(inventory);
    expect(issues.some((issue) => issue.message.includes('could not determine owning install for PID 901'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('/gone/lib/daemon/transcript-sync.mjs'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('Foreign transcript-sync daemon'))).toBe(false);
  });

  test('malformed metadata and unavailable process listing degrade to warnings', async () => {
    const inventory = await inspectAgentbootupInstalls(fakeDeps({
      readPackage: async () => { throw new SyntaxError('bad JSON'); },
      commandOutput: async () => { throw new Error('command unavailable'); },
    }));
    const issues = inventoryToDoctorIssues(inventory);
    expect(issues.some((issue) => issue.severity === 'warning' && issue.message.includes('inventory discovery'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('process listing'))).toBe(true);
  });

  test('inventory has no process-kill dependency or side effect', async () => {
    let killed = false;
    const inventory = await inspectAgentbootupInstalls(fakeDeps({ kill: () => { killed = true; } }));
    expect(inventory.daemons.length).toBeGreaterThan(0);
    expect(killed).toBe(false);
  });
});
