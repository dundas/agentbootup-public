/**
 * tests/daemon/inbox-enabled.test.ts
 *
 * Unit tests for getInboxEnabled / setInboxEnabled in lib/config/config.js
 * and the inboxEnabled opt-in guard in getInboxAgentEntries.
 *
 * Uses AGENTBOOTUP_CONFIG_FILE env var for test isolation (same pattern as
 * config-cli.test.ts).
 */

import { test, expect, describe, beforeEach, afterEach, afterAll } from 'bun:test';
import fsp from 'fs/promises';
import fs, { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// ── Temp dirs ──────────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agentbootup-inbox-enabled-test-'));

// ── Config isolation helpers ───────────────────────────────────────────────────

function isolatedConfigFile(): string {
  return path.join(tmpDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// ── Lazily import config helpers after setting AGENTBOOTUP_CONFIG_FILE ─────────
//
// ESM module caches mean we cannot re-import per test; instead we use the env
// var which getConfigFilePath() reads lazily on every call.

const { getInboxEnabled, setInboxEnabled } = await import('../../lib/config/config.js');

// ── Cleanup ────────────────────────────────────────────────────────────────────

afterAll(async () => {
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── getInboxEnabled / setInboxEnabled ──────────────────────────────────────────

describe('getInboxEnabled', () => {
  beforeEach(() => {
    process.env.AGENTBOOTUP_CONFIG_FILE = isolatedConfigFile();
  });

  afterEach(() => {
    delete process.env.AGENTBOOTUP_CONFIG_FILE;
  });

  test('returns false when config file does not exist', async () => {
    const result = await getInboxEnabled('decisive.gm');
    expect(result).toBe(false);
  });

  test('returns false when config has no inboxEnabled key', async () => {
    const configFile = process.env.AGENTBOOTUP_CONFIG_FILE!;
    await fsp.writeFile(
      configFile,
      JSON.stringify({ _version: 1, brainId: 'some-brain' }, null, 2) + '\n',
    );
    const result = await getInboxEnabled('decisive.gm');
    expect(result).toBe(false);
  });

  test('returns false for an unknown agentId even when inboxEnabled map exists', async () => {
    const configFile = process.env.AGENTBOOTUP_CONFIG_FILE!;
    await fsp.writeFile(
      configFile,
      JSON.stringify({ _version: 1, inboxEnabled: { 'other.gm': true } }, null, 2) + '\n',
    );
    const result = await getInboxEnabled('unknown.gm');
    expect(result).toBe(false);
  });

  test('returns false when agentId is explicitly set to false', async () => {
    const configFile = process.env.AGENTBOOTUP_CONFIG_FILE!;
    await fsp.writeFile(
      configFile,
      JSON.stringify({ _version: 1, inboxEnabled: { 'decisive.gm': false } }, null, 2) + '\n',
    );
    const result = await getInboxEnabled('decisive.gm');
    expect(result).toBe(false);
  });
});

describe('setInboxEnabled + getInboxEnabled round-trips', () => {
  beforeEach(() => {
    process.env.AGENTBOOTUP_CONFIG_FILE = isolatedConfigFile();
  });

  afterEach(() => {
    delete process.env.AGENTBOOTUP_CONFIG_FILE;
  });

  test('setInboxEnabled(true) persists and getInboxEnabled returns true', async () => {
    await setInboxEnabled('decisive.gm', true);
    const result = await getInboxEnabled('decisive.gm');
    expect(result).toBe(true);
  });

  test('setInboxEnabled(false) persists and getInboxEnabled returns false', async () => {
    await setInboxEnabled('decisive.gm', true);
    await setInboxEnabled('decisive.gm', false);
    const result = await getInboxEnabled('decisive.gm');
    expect(result).toBe(false);
  });

  test('setting one agentId does not affect another', async () => {
    await setInboxEnabled('brain-a.gm', true);
    const resultA = await getInboxEnabled('brain-a.gm');
    const resultB = await getInboxEnabled('brain-b.gm');
    expect(resultA).toBe(true);
    expect(resultB).toBe(false);
  });

  test('multiple agents can be enabled independently', async () => {
    await setInboxEnabled('brain-a.gm', true);
    await setInboxEnabled('brain-b.gm', true);
    expect(await getInboxEnabled('brain-a.gm')).toBe(true);
    expect(await getInboxEnabled('brain-b.gm')).toBe(true);
  });

  test('persists to disk under the inboxEnabled key', async () => {
    const configFile = process.env.AGENTBOOTUP_CONFIG_FILE!;
    await setInboxEnabled('decisive.gm', true);
    const raw = JSON.parse(await fsp.readFile(configFile, 'utf-8'));
    expect(raw.inboxEnabled).toBeDefined();
    expect(raw.inboxEnabled['decisive.gm']).toBe(true);
  });

  test('merges without overwriting other agentIds', async () => {
    const configFile = process.env.AGENTBOOTUP_CONFIG_FILE!;
    await setInboxEnabled('brain-a.gm', true);
    await setInboxEnabled('brain-b.gm', true);
    const raw = JSON.parse(await fsp.readFile(configFile, 'utf-8'));
    expect(raw.inboxEnabled['brain-a.gm']).toBe(true);
    expect(raw.inboxEnabled['brain-b.gm']).toBe(true);
  });
});

// ── getInboxAgentEntries opt-in guard ──────────────────────────────────────────

describe('getInboxAgentEntries inboxEnabled guard', () => {
  let networkRoot: string;

  beforeEach(() => {
    process.env.AGENTBOOTUP_CONFIG_FILE = isolatedConfigFile();
    const netDir = path.join(tmpDir, `network-${Date.now()}`);
    mkdirSync(netDir, { recursive: true });
    networkRoot = netDir;
    process.env.AGENTBOOTUP_NETWORK_ROOT = networkRoot;
  });

  afterEach(() => {
    delete process.env.AGENTBOOTUP_CONFIG_FILE;
    delete process.env.AGENTBOOTUP_NETWORK_ROOT;
  });

  function writeNetworkConfig(projects: object[]) {
    writeFileSync(
      path.join(networkRoot, 'agentbootup.json'),
      JSON.stringify({ version: '2.0', role: 'network', projects }),
    );
  }

  test('skips projects where getInboxEnabled returns false', async () => {
    const projectDir = path.join(tmpDir, `proj-skip-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    writeNetworkConfig([{ id: 'proj-skip', agent_id: 'skip.gm', path: projectDir }]);

    // Do NOT call setInboxEnabled — defaults to false.

    const { getInboxAgentEntries } = await import('../../lib/daemon/daemon-registry.js');
    const entries = await getInboxAgentEntries({ allocate: false });
    expect(entries).toHaveLength(0);
  });

  test('includes projects where getInboxEnabled returns true with existing port+secret', async () => {
    const projectDir = path.join(tmpDir, `proj-include-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    const agentId = `include-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
    writeNetworkConfig([{ id: 'proj-include', agent_id: agentId, path: projectDir }]);

    // Pre-provision port and secret in config.
    const { writeConfig } = await import('../../lib/config/config.js');
    const testPort = 8799;
    const testSecret = 'a'.repeat(64);
    await writeConfig({
      portRegistry: { inbox: { [agentId]: testPort } },
      inboxWebhookSecrets: { [agentId]: testSecret },
    });

    // Enable the inbox daemon.
    await setInboxEnabled(agentId, true);

    const { getInboxAgentEntries } = await import('../../lib/daemon/daemon-registry.js');
    const entries = await getInboxAgentEntries({ allocate: false });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries.find((e) => e.env?.AGENTBOOTUP_BRAIN_ID === agentId);
    expect(entry).toBeDefined();
    expect(entry!.env.AGENTBOOTUP_INBOX_PORT).toBe(String(testPort));
    expect(entry!.env.AGENTBOOTUP_INBOX_WEBHOOK_SECRET).toBe(testSecret);
  });

  test('read-only allocate:false does not auto-enable a legacy project that already has port + secret but no flag', async () => {
    const projectDir = path.join(tmpDir, `proj-migrate-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    const agentId = `migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
    writeNetworkConfig([{ id: 'proj-migrate', agent_id: agentId, path: projectDir }]);

    // Pre-provision port and secret WITHOUT setting inboxEnabled flag.
    const { writeConfig } = await import('../../lib/config/config.js');
    const testPort = 8800;
    const testSecret = 'b'.repeat(64);
    await writeConfig({
      portRegistry: { inbox: { [agentId]: testPort } },
      inboxWebhookSecrets: { [agentId]: testSecret },
    });

    // Do NOT call setInboxEnabled — allocate:false is read-only by default.

    const { getInboxAgentEntries } = await import('../../lib/daemon/daemon-registry.js');
    const entries = await getInboxAgentEntries({ allocate: false });
    const entry = entries.find((e) => e.env?.AGENTBOOTUP_BRAIN_ID === agentId);
    expect(entry).toBeDefined();

    // Read-only discovery must not persist the flag.
    const enabled = await getInboxEnabled(agentId);
    expect(enabled).toBe(false);
  });

  test('explicit legacy-enrollment mode persists inboxEnabled for existing port+secret', async () => {
    const projectDir = path.join(tmpDir, `proj-migrate-write-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    const agentId = `migrate-write-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
    writeNetworkConfig([{ id: 'proj-migrate-write', agent_id: agentId, path: projectDir }]);

    const { writeConfig } = await import('../../lib/config/config.js');
    const testPort = 8803;
    const testSecret = 'f'.repeat(64);
    await writeConfig({
      portRegistry: { inbox: { [agentId]: testPort } },
      inboxWebhookSecrets: { [agentId]: testSecret },
    });

    const { getInboxAgentEntries } = await import('../../lib/daemon/daemon-registry.js');
    const entries = await getInboxAgentEntries({
      allocate: false,
      persistExistingProvisionedEnrollment: true,
    });
    const entry = entries.find((e) => e.env?.AGENTBOOTUP_BRAIN_ID === agentId);
    expect(entry).toBeDefined();

    const enabled = await getInboxEnabled(agentId);
    expect(enabled).toBe(true);
  });

  test('migration path 2: includes project with brain-schema.sql, no flag', async () => {
    // A brain that has been provisioned (brain-schema.sql exists) but never had
    // inboxEnabled set should still get an inbox entry via the hasBrainDb
    // implicit-enablement migration path, as long as port+secret are pre-seeded
    // (allocate:false skips allocation, so they must be present to get an entry).
    //
    // writeNetworkConfig writes a single-entry agentbootup.json — it intentionally
    // owns the entire network config for this test. Each test uses a fresh networkRoot
    // from beforeEach so there is no accumulation between tests.
    const projectDir = path.join(tmpDir, `proj-hasBrainDb-${Date.now()}`);
    const brainDir = path.join(projectDir, '.brain');
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(path.join(brainDir, 'brain-schema.sql'), '-- schema');
    const agentId = `hasBrainDb-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
    writeNetworkConfig([{ id: 'proj-hasBrainDb', agent_id: agentId, path: projectDir }]);

    // Pre-seed port + secret so allocate:false can build the entry.
    // Intentionally do NOT set inboxEnabled — migration path 2 handles this.
    const { writeConfig } = await import('../../lib/config/config.js');
    const testPort = 8801;
    const testSecret = 'c'.repeat(64);
    await writeConfig({
      portRegistry: { inbox: { [agentId]: testPort } },
      inboxWebhookSecrets: { [agentId]: testSecret },
    });

    const { getInboxAgentEntries } = await import('../../lib/daemon/daemon-registry.js');
    const entries = await getInboxAgentEntries({ allocate: false });
    const entry = entries.find((e) => e.env?.AGENTBOOTUP_BRAIN_ID === agentId);
    expect(entry).toBeDefined();
    expect(entry!.env.AGENTBOOTUP_INBOX_PORT).toBe(String(testPort));
  });

  test('migration path 2: includes project with only brain.db (no brain-schema.sql)', async () => {
    // Covers the brain.db branch of the Promise.any check — brain-schema.sql is
    // written first during provisioning, brain.db afterward. This confirms both
    // paths of hasBrainDb are exercised independently.
    // writeNetworkConfig owns the entire network config for this test (single entry).
    const projectDir = path.join(tmpDir, `proj-brainDb-${Date.now()}`);
    const brainDir = path.join(projectDir, '.brain');
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(path.join(brainDir, 'brain.db'), ''); // brain.db only, no schema.sql
    const agentId = `brainDbOnly-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
    writeNetworkConfig([{ id: 'proj-brainDb', agent_id: agentId, path: projectDir }]);

    const { writeConfig } = await import('../../lib/config/config.js');
    const testPort = 8802;
    const testSecret = 'd'.repeat(64);
    await writeConfig({
      portRegistry: { inbox: { [agentId]: testPort } },
      inboxWebhookSecrets: { [agentId]: testSecret },
    });

    const { getInboxAgentEntries } = await import('../../lib/daemon/daemon-registry.js');
    const entries = await getInboxAgentEntries({ allocate: false });
    const entry = entries.find((e) => e.env?.AGENTBOOTUP_BRAIN_ID === agentId);
    expect(entry).toBeDefined();
  });

  test('migration path 2: excludes project with no brain files and no flag', async () => {
    // A project directory that has no .brain/brain.db or .brain/brain-schema.sql
    // and no inboxEnabled flag should be excluded — hasBrainDb returns false.
    // writeNetworkConfig owns the entire network config for this test (single entry).
    const projectDir = path.join(tmpDir, `proj-noBrain-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true }); // no .brain/ subdirectory
    const agentId = `noBrain-${Date.now()}-${Math.random().toString(36).slice(2)}.gm`;
    writeNetworkConfig([{ id: 'proj-noBrain', agent_id: agentId, path: projectDir }]);

    // No flag, no port/secret, no brain files → must be excluded.
    const { getInboxAgentEntries } = await import('../../lib/daemon/daemon-registry.js');
    const entries = await getInboxAgentEntries({ allocate: false });
    const entry = entries.find((e) => e.env?.AGENTBOOTUP_BRAIN_ID === agentId);
    expect(entry).toBeUndefined();
  });
});
