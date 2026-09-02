/**
 * tests/daemon/daemon-registry.test.ts
 *
 * Unit tests for lib/daemon/daemon-registry.js
 * Focuses on getCustomAgentEntries() — the new extensibility surface.
 * getNetworkProjects / getBrainAgentEntries / getBrainDbAgentEntries /
 * getInboxAgentEntries are covered indirectly via unified-daemon-cli.test.ts.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

// ── Test isolation ─────────────────────────────────────────────────────────────

let tmpDir: string;
let networkRoot: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'daemon-registry-test-'));
  networkRoot = join(tmpDir, 'network');
  mkdirSync(networkRoot, { recursive: true });
  process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
});

afterEach(() => {
  delete process.env.AGENTBOOTUP_NETWORK_ROOT;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeNetworkConfig(projects: object[]) {
  writeFileSync(
    join(networkRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'network', projects }),
  );
}

function writeProjectDaemons(projectPath: string, declarations: object[]) {
  mkdirSync(join(projectPath, 'brain'), { recursive: true }); // nosemgrep
  writeFileSync(join(projectPath, 'brain', 'daemons.json'), JSON.stringify(declarations)); // nosemgrep
}

async function getModule() {
  return import('../../lib/daemon/daemon-registry.js');
}

// ── path-existence guard (multi-machine partial install) ──────────────────────

describe('path-existence guard', () => {
  test('single-brain fallback preserves the configured brain id for status health lookup', async () => {
    const configFile = join(tmpDir, 'single-brain-config.json');
    process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
    rmSync(networkRoot, { recursive: true, force: true });
    writeFileSync(configFile, JSON.stringify({ brainId: 'single-brain.gm' }));
    try {
      const { getBrainAgentEntries } = await getModule();
      await expect(getBrainAgentEntries()).resolves.toEqual([
        expect.objectContaining({ name: 'agentbootup-brain', key: 'brain', brainId: 'single-brain.gm' }),
      ]);
    } finally {
      delete process.env.AGENTBOOTUP_CONFIG_FILE;
    }
  });

  test('getBrainAgentEntries skips project whose path does not exist', async () => {
    const nonexistent = `/tmp/nonexistent-brain-path-${Date.now()}`;
    writeNetworkConfig([{ id: 'ghost-brain', agent_id: 'ghost.gm', path: nonexistent }]);

    const { getBrainAgentEntries } = await getModule();
    const entries = await getBrainAgentEntries();
    expect(entries).toHaveLength(0);
  });

  test('getInboxAgentEntries skips project whose path does not exist', async () => {
    const nonexistent = `/tmp/nonexistent-brain-path-${Date.now()}`;
    writeNetworkConfig([{ id: 'ghost-inbox', agent_id: 'ghost-inbox.gm', path: nonexistent }]);

    const { getInboxAgentEntries } = await getModule();
    const entries = await getInboxAgentEntries({ allocate: false });
    expect(entries).toHaveLength(0);
  });

  test('getCustomAgentEntries skips project whose path does not exist', async () => {
    const nonexistent = `/tmp/nonexistent-brain-path-${Date.now()}`;
    writeNetworkConfig([{ id: 'ghost-custom', agent_id: 'ghost-custom.gm', path: nonexistent }]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries).toHaveLength(0);
  });

  test('AGENTBOOTUP_MACHINE_ID is present in getBrainAgentEntries entries', async () => {
    const projectDir = join(tmpDir, 'proj-machine-brain');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-machine-brain', agent_id: 'machine.gm', path: projectDir }]);

    const { getBrainAgentEntries } = await getModule();
    const entries = await getBrainAgentEntries();
    expect(entries).toHaveLength(1);
    expect(typeof entries[0].env?.AGENTBOOTUP_MACHINE_ID).toBe('string');
    expect(entries[0].env?.AGENTBOOTUP_MACHINE_ID.length).toBeGreaterThan(0);
  });

  test('AGENTBOOTUP_MACHINE_ID is present in getInboxAgentEntries entries', async () => {
    const configFile = join(tmpDir, `config-machine-inbox-${Date.now()}.json`);
    // Set AGENTBOOTUP_CONFIG_FILE before writeNetworkConfig so all config reads
    // (including those inside getInboxAgentEntries) use the same isolated file.
    process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
    try {
      const projectDir = join(tmpDir, `proj-machine-inbox-${Date.now()}`);
      mkdirSync(projectDir, { recursive: true });
      const agentId = `machine-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
      writeNetworkConfig([{ id: 'proj-machine-inbox', agent_id: agentId, path: projectDir }]);

      // Pre-provision port + secret and enable inbox.
      // Use a random high port to avoid collision with other tests running in parallel.
      const testPort = 19000 + Math.floor(Math.random() * 900);
      const config = await import('../../lib/config/config.js');
      await config.writeConfig({
        portRegistry: { inbox: { [agentId]: testPort } },
        inboxWebhookSecrets: { [agentId]: 'c'.repeat(64) },
      });
      await config.setInboxEnabled(agentId, true);

      const { getInboxAgentEntries } = await getModule();
      const entries = await getInboxAgentEntries({ allocate: false });
      expect(entries.length).toBeGreaterThan(0);
      const entry = entries.find((e: any) => e.env?.AGENTBOOTUP_BRAIN_ID === agentId);
      expect(entry).toBeDefined();
      expect(typeof entry!.env.AGENTBOOTUP_MACHINE_ID).toBe('string');
      expect(entry!.env.AGENTBOOTUP_MACHINE_ID.length).toBeGreaterThan(0);
    } finally {
      delete process.env.AGENTBOOTUP_CONFIG_FILE;
    }
  });

  test('getInboxAgentEntries entries have PATH prepended with user bin dirs', async () => {
    const configFile = join(tmpDir, `config-path-inbox-${Date.now()}.json`);
    process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
    try {
      const projectDir = join(tmpDir, `proj-path-inbox-${Date.now()}`);
      mkdirSync(projectDir, { recursive: true });
      const agentId = `path-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
      writeNetworkConfig([{ id: 'proj-path-inbox', agent_id: agentId, path: projectDir }]);

      const testPort = 19900 + Math.floor(Math.random() * 99);
      const config = await import('../../lib/config/config.js');
      await config.writeConfig({
        portRegistry: { inbox: { [agentId]: testPort } },
        inboxWebhookSecrets: { [agentId]: 'd'.repeat(64) },
      });
      await config.setInboxEnabled(agentId, true);

      const { getInboxAgentEntries } = await getModule();
      const entries = await getInboxAgentEntries({ allocate: false });
      const entry = entries.find((e: any) => e.env?.AGENTBOOTUP_BRAIN_ID === agentId);
      expect(entry).toBeDefined();
      // PATH must be present and start with ~/.claude/local/bin (the highest-priority user bin dir)
      const entryPath: string = entry!.env.PATH;
      expect(typeof entryPath).toBe('string');
      expect(entryPath.length).toBeGreaterThan(0);
      const homeDir = homedir();
      expect(entryPath.startsWith(join(homeDir, '.claude', 'local', 'bin'))).toBe(true);
    } finally {
      delete process.env.AGENTBOOTUP_CONFIG_FILE;
    }
  });

  test('DAEMON_PATH string contains /.claude/local/bin', async () => {
    const { DAEMON_PATH } = await getModule();
    expect(typeof DAEMON_PATH).toBe('string');
    expect(DAEMON_PATH).toContain('/.claude/local/bin');
  });

  test('getInboxAgentEntries entries PATH starts with ~/.claude/local/bin (highest priority)', async () => {
    const configFile = join(tmpDir, `config-claude-path-inbox-${Date.now()}.json`);
    process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
    try {
      const projectDir = join(tmpDir, `proj-claude-path-inbox-${Date.now()}`);
      mkdirSync(projectDir, { recursive: true });
      const agentId = `claude-path-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
      writeNetworkConfig([{ id: 'proj-claude-path-inbox', agent_id: agentId, path: projectDir }]);

      const testPort = 20000 + Math.floor(Math.random() * 99);
      const config = await import('../../lib/config/config.js');
      await config.writeConfig({
        portRegistry: { inbox: { [agentId]: testPort } },
        inboxWebhookSecrets: { [agentId]: 'e'.repeat(64) },
      });
      await config.setInboxEnabled(agentId, true);

      const { getInboxAgentEntries } = await getModule();
      const entries = await getInboxAgentEntries({ allocate: false });
      const entry = entries.find((e: any) => e.env?.AGENTBOOTUP_BRAIN_ID === agentId);
      expect(entry).toBeDefined();
      const entryPath: string = entry!.env.PATH;
      expect(typeof entryPath).toBe('string');
      // ~/.claude/local/bin must be the FIRST entry (highest priority)
      const homeDir = homedir();
      expect(entryPath.startsWith(join(homeDir, '.claude', 'local', 'bin'))).toBe(true);
    } finally {
      delete process.env.AGENTBOOTUP_CONFIG_FILE;
    }
  });

  test('getBrainAgentEntries keeps entry for project with no path field', async () => {
    // Path-less entries are valid for remote-only asset sync — the asymmetric guard
    // (p.path && !existsSync) must not filter them out.
    writeNetworkConfig([{ id: 'pathless-brain', agent_id: 'pathless.gm' }]);

    const { getBrainAgentEntries } = await getModule();
    const entries = await getBrainAgentEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('agentbootup-brain-pathless-brain');
  });

  test('getBrainDbAgentEntries skips project whose path does not exist', async () => {
    const nonexistent = `/tmp/nonexistent-brain-path-${Date.now()}`;
    writeNetworkConfig([{ id: 'ghost-db', agent_id: 'ghost-db.gm', path: nonexistent }]);

    const { getBrainDbAgentEntries } = await getModule();
    const entries = await getBrainDbAgentEntries();
    expect(entries).toHaveLength(0);
  });

  test('AGENTBOOTUP_MACHINE_ID is present in getBrainDbAgentEntries entries', async () => {
    const projectDir = join(tmpDir, 'proj-machine-db');
    mkdirSync(join(projectDir, '.brain'), { recursive: true }); // nosemgrep
    // Create brain.db sentinel + .env with required DB vars so getBrainDbAgentEntries includes this project.
    writeFileSync(join(projectDir, '.brain', 'brain.db'), ''); // nosemgrep
    writeFileSync(join(projectDir, '.env'), 'BRAIN_DB_URL=libsql://test.turso.io\nBRAIN_DB_TOKEN=tok\n'); // nosemgrep
    writeNetworkConfig([{ id: 'proj-machine-db', agent_id: 'machine-db.gm', path: projectDir }]);

    const { getBrainDbAgentEntries } = await getModule();
    const entries = await getBrainDbAgentEntries();
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries.find((e: any) => e.env?.BRAIN_DB_BRAIN_ID === 'machine-db.gm');
    expect(entry).toBeDefined();
    expect(typeof entry!.env.AGENTBOOTUP_MACHINE_ID).toBe('string');
    expect(entry!.env.AGENTBOOTUP_MACHINE_ID.length).toBeGreaterThan(0);
  });

  test('AGENTBOOTUP_MACHINE_ID is present in getCustomAgentEntries entries', async () => {
    const projectDir = join(tmpDir, 'proj-machine-custom');
    mkdirSync(projectDir, { recursive: true });
    const scriptPath = join(projectDir, 'custom-daemon.mjs');
    writeFileSync(scriptPath, ''); // nosemgrep
    writeProjectDaemons(projectDir, [{ name: 'my-daemon', script: 'custom-daemon.mjs' }]);
    writeNetworkConfig([{ id: 'proj-machine-custom', agent_id: 'machine-custom.gm', path: projectDir }]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(typeof entries[0].env?.AGENTBOOTUP_MACHINE_ID).toBe('string');
    expect(entries[0].env?.AGENTBOOTUP_MACHINE_ID.length).toBeGreaterThan(0);
  });
});

// ── getCustomAgentEntries ─────────────────────────────────────────────────────

describe('getCustomAgentEntries', () => {
  test('returns empty array when no network config', async () => {
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
    const { getCustomAgentEntries } = await getModule();
    expect(await getCustomAgentEntries()).toEqual([]);
  });

  test('returns empty array when project has no brain/daemons.json', async () => {
    const projectDir = join(tmpDir, 'proj-a');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-a', agent_id: 'a.gm', path: projectDir }]);

    const { getCustomAgentEntries } = await getModule();
    expect(await getCustomAgentEntries()).toEqual([]);
  });

  test('returns empty array when brain/daemons.json is empty array', async () => {
    const projectDir = join(tmpDir, 'proj-empty');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-empty', agent_id: 'empty.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, []);

    const { getCustomAgentEntries } = await getModule();
    expect(await getCustomAgentEntries()).toEqual([]);
  });

  test('returns entry with correct agent name and label', async () => {
    const projectDir = join(tmpDir, 'proj-b');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-b', agent_id: 'b.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'heartbeat', script: 'lib/daemon/heartbeat.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('agentbootup-heartbeat-proj-b');
    expect(entries[0].label).toBe('heartbeat: b.gm');
    expect(entries[0].key).toBe('heartbeat-proj-b');
    expect(entries[0].projectId).toBe('proj-b');
  });

  test('resolves script relative to project path', async () => {
    const projectDir = join(tmpDir, 'proj-c');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-c', agent_id: 'c.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'my-daemon', script: 'lib/daemon/my-daemon.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries[0].script).toBe(join(projectDir, 'lib/daemon/my-daemon.mjs'));
  });

  test('uses absolute script path as-is', async () => {
    const projectDir = join(tmpDir, 'proj-abs');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-abs', agent_id: 'abs.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'my-daemon', script: '/opt/custom/daemon.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries[0].script).toBe('/opt/custom/daemon.mjs');
  });

  test('always injects AGENTBOOTUP_BRAIN_ID and AGENTBOOTUP_PROJECT_ROOT', async () => {
    const projectDir = join(tmpDir, 'proj-env');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-env', agent_id: 'env.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'my-daemon', script: 'daemon.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries[0].env.AGENTBOOTUP_BRAIN_ID).toBe('env.gm');
    expect(entries[0].env.AGENTBOOTUP_PROJECT_ROOT).toBe(projectDir);
  });

  test('forwards declared env keys from process.env', async () => {
    const projectDir = join(tmpDir, 'proj-fwd');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-fwd', agent_id: 'fwd.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      {
        name: 'heartbeat',
        script: 'daemon.mjs',
        env: ['AGENTBOOTUP_MECH_PLANE_URL', 'AGENTBOOTUP_MECH_PLANE_KEY'],
      },
    ]);

    process.env.AGENTBOOTUP_MECH_PLANE_URL = 'http://localhost:3100';
    process.env.AGENTBOOTUP_MECH_PLANE_KEY = 'test-key';
    try {
      const { getCustomAgentEntries } = await getModule();
      const entries = await getCustomAgentEntries();
      expect(entries[0].env.AGENTBOOTUP_MECH_PLANE_URL).toBe('http://localhost:3100');
      expect(entries[0].env.AGENTBOOTUP_MECH_PLANE_KEY).toBe('test-key');
    } finally {
      delete process.env.AGENTBOOTUP_MECH_PLANE_URL;
      delete process.env.AGENTBOOTUP_MECH_PLANE_KEY;
    }
  });

  test('omits declared env keys not present in process.env', async () => {
    const projectDir = join(tmpDir, 'proj-omit');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-omit', agent_id: 'omit.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'my-daemon', script: 'daemon.mjs', env: ['MISSING_VAR_XYZ'] },
    ]);
    delete process.env.MISSING_VAR_XYZ;

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries[0].env).not.toHaveProperty('MISSING_VAR_XYZ');
  });

  test('sanitizes daemon name to lowercase alphanumeric + hyphens', async () => {
    const projectDir = join(tmpDir, 'proj-sanitize');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-sanitize', agent_id: 'san.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'My Daemon!2', script: 'daemon.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    // Sanitized: "My Daemon!2" → "my-daemon-2"
    expect(entries[0].name).toBe('agentbootup-my-daemon-2-proj-sanitize');
    expect(entries[0].name).not.toMatch(/[^a-z0-9-]/);
  });

  test('skips entry with missing name', async () => {
    const projectDir = join(tmpDir, 'proj-noname');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-noname', agent_id: 'nn.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { script: 'daemon.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    expect(await getCustomAgentEntries()).toEqual([]);
  });

  test('skips entry with missing script', async () => {
    const projectDir = join(tmpDir, 'proj-noscript');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-noscript', agent_id: 'ns.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'my-daemon', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    expect(await getCustomAgentEntries()).toEqual([]);
  });

  test('skips projects with no path', async () => {
    writeNetworkConfig([{ id: 'no-path', agent_id: 'np.gm' }]);

    const { getCustomAgentEntries } = await getModule();
    expect(await getCustomAgentEntries()).toEqual([]);
  });

  test('aggregates entries across multiple projects', async () => {
    const projA = join(tmpDir, 'multi-a');
    const projB = join(tmpDir, 'multi-b');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    writeNetworkConfig([
      { id: 'multi-a', agent_id: 'a.gm', path: projA },
      { id: 'multi-b', agent_id: 'b.gm', path: projB },
    ]);
    writeProjectDaemons(projA, [{ name: 'heartbeat', script: 'daemon.mjs', env: [] }]);
    writeProjectDaemons(projB, [{ name: 'heartbeat', script: 'daemon.mjs', env: [] }]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name)).toEqual([
      'agentbootup-heartbeat-multi-a',
      'agentbootup-heartbeat-multi-b',
    ]);
  });

  test('multiple daemons per project are all returned', async () => {
    const projectDir = join(tmpDir, 'proj-multi-d');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-multi-d', agent_id: 'md.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'heartbeat', script: 'daemon-a.mjs', env: [] },
      { name: 'metrics', script: 'daemon-b.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name)).toContain('agentbootup-heartbeat-proj-multi-d');
    expect(entries.map((e) => e.name)).toContain('agentbootup-metrics-proj-multi-d');
  });

  test('skips entry when sanitized name starts with hyphen only', async () => {
    const projectDir = join(tmpDir, 'proj-badsanitize');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-badsanitize', agent_id: 'bs.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: '!!!', script: 'daemon.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    expect(await getCustomAgentEntries()).toEqual([]);
  });

  test('skips second entry when two names sanitize to the same string', async () => {
    const projectDir = join(tmpDir, 'proj-dupname');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-dupname', agent_id: 'dup.gm', path: projectDir }]);
    // "my daemon" and "my-daemon" both sanitize to "my-daemon"
    writeProjectDaemons(projectDir, [
      { name: 'my daemon', script: 'daemon-a.mjs', env: [] },
      { name: 'my-daemon', script: 'daemon-b.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toContain('daemon-a.mjs');
  });

  test('skips entry when relative script resolves outside project root', async () => {
    const projectDir = join(tmpDir, 'proj-traversal');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-traversal', agent_id: 'tr.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'escape', script: '../../../etc/passwd', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    expect(await getCustomAgentEntries()).toEqual([]);
  });

  test('allows absolute script path regardless of project root', async () => {
    const projectDir = join(tmpDir, 'proj-absscript');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-absscript', agent_id: 'abs2.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'external', script: '/opt/my-daemon.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe('/opt/my-daemon.mjs');
  });

  test('generated agent name contains no dots', async () => {
    const projectDir = join(tmpDir, 'proj-nodots');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-nodots', agent_id: 'some.brain.gm', path: projectDir }]);
    writeProjectDaemons(projectDir, [
      { name: 'heartbeat', script: 'daemon.mjs', env: [] },
    ]);

    const { getCustomAgentEntries } = await getModule();
    const entries = await getCustomAgentEntries();
    // agent_id has dots but project id does not — name must be dot-free
    expect(entries[0].name).not.toContain('.');
  });
});

// ── getExpectedServices ───────────────────────────────────────────────────────

describe('getExpectedServices', () => {
  test('returns empty array when brain not in network config', async () => {
    writeNetworkConfig([{ id: 'other-brain', agent_id: 'other.gm', path: join(tmpDir, 'other') }]);
    const { getExpectedServices } = await getModule();
    const services = await getExpectedServices('missing.gm');
    expect(services).toEqual([]);
  });

  test('returns empty array when brain path does not exist on this machine', async () => {
    const nonexistent = `/tmp/nonexistent-expected-svc-${Date.now()}`;
    writeNetworkConfig([{ id: 'ghost-svc', agent_id: 'ghost.gm', path: nonexistent }]);
    const { getExpectedServices } = await getModule();
    const services = await getExpectedServices('ghost.gm');
    expect(services).toEqual([]);
  });

  test('returns brain-asset-sync entry for brain on this machine', async () => {
    const projectDir = join(tmpDir, 'proj-svc-brain');
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'svc-brain', agent_id: 'svc.gm', path: projectDir }]);
    const { getExpectedServices } = await getModule();
    const services = await getExpectedServices('svc.gm');
    const brainSvc = services.find((s: any) => s.type === 'brain-asset-sync');
    expect(brainSvc).toBeDefined();
    expect(brainSvc!.name).toBe('agentbootup-brain-svc-brain');
    expect(brainSvc!.brainId).toBe('svc.gm');
    expect(brainSvc!.projectId).toBe('svc-brain');
  });

  test('returns only brain-asset-sync when inbox is not enabled', async () => {
    const configFile = join(tmpDir, `config-svc-no-inbox-${Date.now()}.json`);
    process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
    try {
      const projectDir = join(tmpDir, `proj-svc-no-inbox-${Date.now()}`);
      mkdirSync(projectDir, { recursive: true });
      const agentId = `svc-no-inbox-${Date.now()}.gm`;
      writeNetworkConfig([{ id: 'svc-no-inbox', agent_id: agentId, path: projectDir }]);
      // No inbox provisioning — inbox not enabled
      const { getExpectedServices } = await getModule();
      const services = await getExpectedServices(agentId);
      expect(services.some((s: any) => s.type === 'inbox')).toBe(false);
      expect(services.some((s: any) => s.type === 'brain-asset-sync')).toBe(true);
    } finally {
      delete process.env.AGENTBOOTUP_CONFIG_FILE;
    }
  });

  test('returns brain-asset-sync and inbox entries when inbox is enabled and provisioned', async () => {
    const configFile = join(tmpDir, `config-svc-inbox-${Date.now()}.json`);
    process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
    try {
      const projectDir = join(tmpDir, `proj-svc-inbox-${Date.now()}`);
      mkdirSync(projectDir, { recursive: true });
      const agentId = `svc-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
      writeNetworkConfig([{ id: 'svc-inbox', agent_id: agentId, path: projectDir }]);
      const testPort = 21000 + Math.floor(Math.random() * 900);
      const config = await import('../../lib/config/config.js');
      await config.writeConfig({
        portRegistry: { inbox: { [agentId]: testPort } },
        inboxWebhookSecrets: { [agentId]: 'f'.repeat(64) },
      });
      await config.setInboxEnabled(agentId, true);

      const { getExpectedServices } = await getModule();
      const services = await getExpectedServices(agentId);
      const brainSvc = services.find((s: any) => s.type === 'brain-asset-sync');
      const inboxSvc = services.find((s: any) => s.type === 'inbox');
      expect(brainSvc).toBeDefined();
      expect(inboxSvc).toBeDefined();
      expect(inboxSvc!.port).toBe(testPort);
      expect(inboxSvc!.brainId).toBe(agentId);
      expect(inboxSvc!.projectId).toBe('svc-inbox');
    } finally {
      delete process.env.AGENTBOOTUP_CONFIG_FILE;
    }
  });

  test('returns inbox for a legacy provisioned brain without inboxEnabled flag when requested for reconcile discovery', async () => {
    const configFile = join(tmpDir, `config-svc-legacy-inbox-${Date.now()}.json`);
    process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
    try {
      const projectDir = join(tmpDir, `proj-svc-legacy-inbox-${Date.now()}`);
      mkdirSync(join(projectDir, '.brain'), { recursive: true });
      writeFileSync(join(projectDir, '.brain', 'brain-schema.sql'), '-- schema');
      const agentId = `svc-legacy-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
      writeNetworkConfig([{ id: 'svc-legacy-inbox', agent_id: agentId, path: projectDir }]);

      const { getExpectedServices } = await getModule();
      const services = await getExpectedServices(agentId, { includeUnprovisionedInbox: true });
      const inboxSvc = services.find((s: any) => s.type === 'inbox');
      expect(inboxSvc).toBeDefined();
      expect(inboxSvc!.brainId).toBe(agentId);
      expect(inboxSvc!.projectId).toBe('svc-legacy-inbox');
      expect(inboxSvc!.port).toBeNull();
    } finally {
      delete process.env.AGENTBOOTUP_CONFIG_FILE;
    }
  });

  test('does not return unprovisioned legacy inboxes during default read-only service discovery', async () => {
    const configFile = join(tmpDir, `config-svc-default-legacy-${Date.now()}.json`);
    process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
    try {
      const projectDir = join(tmpDir, `proj-svc-default-legacy-${Date.now()}`);
      mkdirSync(join(projectDir, '.brain'), { recursive: true });
      writeFileSync(join(projectDir, '.brain', 'brain-schema.sql'), '-- schema');
      const agentId = `svc-default-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
      writeNetworkConfig([{ id: 'svc-default-legacy', agent_id: agentId, path: projectDir }]);

      const { getExpectedServices } = await getModule();
      const services = await getExpectedServices(agentId);
      expect(services.some((s: any) => s.type === 'inbox')).toBe(false);
      expect(services.some((s: any) => s.type === 'brain-asset-sync')).toBe(true);
    } finally {
      delete process.env.AGENTBOOTUP_CONFIG_FILE;
    }
  });

  test('does not persist inboxEnabled during read-only service discovery for already provisioned inboxes', async () => {
    const configFile = join(tmpDir, `config-svc-readonly-inbox-${Date.now()}.json`);
    process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
    try {
      const projectDir = join(tmpDir, `proj-svc-readonly-inbox-${Date.now()}`);
      mkdirSync(projectDir, { recursive: true });
      const agentId = `svc-readonly-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
      writeNetworkConfig([{ id: 'svc-readonly-inbox', agent_id: agentId, path: projectDir }]);

      const config = await import('../../lib/config/config.js');
      await config.writeConfig({
        portRegistry: { inbox: { [agentId]: 21991 } },
        inboxWebhookSecrets: { [agentId]: 'e'.repeat(64) },
      });

      const { getExpectedServices } = await getModule();
      const services = await getExpectedServices(agentId);
      const inboxSvc = services.find((s: any) => s.type === 'inbox');
      expect(inboxSvc).toBeDefined();
      expect(inboxSvc!.port).toBe(21991);

      const persisted = await config.getInboxEnabled(agentId);
      expect(persisted).toBe(false);
    } finally {
      delete process.env.AGENTBOOTUP_CONFIG_FILE;
    }
  });
});
