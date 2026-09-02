import { test, expect, beforeEach, afterAll } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import fs from 'fs';

// ── Isolation via AGENTBOOTUP_CONFIG_FILE env var ─────────────────────────────

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agentbootup-config-test-')
);

// Dynamic import so the module is loaded once with env var support available.
const { readConfig, writeConfig, getBrainId, setBrainId, getSkillsMode, setSkillsMode, getShareConfig, setShareConfig, normalizeShareConfig } = await import(
  '../../lib/config/config.js'
);

function configFile() {
  return process.env.AGENTBOOTUP_CONFIG_FILE!;
}

beforeEach(async () => {
  const f = path.join(tmpDir, `config-${Date.now()}-${Math.random()}.json`);
  process.env.AGENTBOOTUP_CONFIG_FILE = f;
  await fsp.unlink(f).catch(() => {});
});

afterAll(async () => {
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('readConfig returns {} when file does not exist', async () => {
  const config = await readConfig();
  expect(config).toEqual({});
});

test('writeConfig creates the config file with correct content', async () => {
  await writeConfig({ brainId: 'test-brain-01' });
  const raw = await fsp.readFile(configFile(), 'utf-8');
  const parsed = JSON.parse(raw);
  expect(parsed.brainId).toBe('test-brain-01');
});

test('readConfig returns persisted values', async () => {
  await writeConfig({ brainId: 'brain-abc' });
  const config = await readConfig();
  expect(config.brainId).toBe('brain-abc');
});

test('writeConfig merges with existing config', async () => {
  await writeConfig({ brainId: 'first-brain' });
  await writeConfig({ someOtherKey: 'value' });
  const config = await readConfig();
  expect(config.brainId).toBe('first-brain');
  expect((config as Record<string, unknown>).someOtherKey).toBe('value');
});

test('getBrainId returns null when file does not exist', async () => {
  const id = await getBrainId();
  expect(id).toBeNull();
});

test('setBrainId persists brain ID and getBrainId reads it back', async () => {
  await setBrainId('my-brain-id');
  const id = await getBrainId();
  expect(id).toBe('my-brain-id');
});

test('getBrainId returns null when brainId field is missing', async () => {
  await writeConfig({ otherField: 'x' } as Record<string, unknown>);
  const id = await getBrainId();
  expect(id).toBeNull();
});

test('config file is created with mode 0o600', async () => {
  await setBrainId('mode-check');
  const stat = await fsp.stat(configFile());
  expect(stat.mode & 0o777).toBe(0o600);
});

test('writeConfig corrects permissions on pre-existing file with wrong mode', async () => {
  await fsp.writeFile(configFile(), '{}', { mode: 0o644 });
  await setBrainId('fix-mode');
  const stat = await fsp.stat(configFile());
  expect(stat.mode & 0o777).toBe(0o600);
});

test('config directory is created with mode 0o700', async () => {
  const nestedDir = path.join(tmpDir, `nested-${Date.now()}`);
  process.env.AGENTBOOTUP_CONFIG_FILE = path.join(nestedDir, 'config.json');
  await writeConfig({ brainId: 'dir-mode-check' });
  const stat = await fsp.stat(nestedDir);
  expect(stat.mode & 0o777).toBe(0o700);
});

test('readConfig returns {} on malformed JSON', async () => {
  await fsp.writeFile(configFile(), '{ not valid json }', 'utf-8');
  const config = await readConfig();
  expect(config).toEqual({});
});

test('writeConfig overwrites brainId on second call', async () => {
  await setBrainId('old-id');
  await setBrainId('new-id');
  const id = await getBrainId();
  expect(id).toBe('new-id');
});

// ── Schema versioning ─────────────────────────────────────────────────────────

test('writeConfig includes _version field in file', async () => {
  await writeConfig({ brainId: 'test-brain' });
  const raw = JSON.parse(await fsp.readFile(configFile(), 'utf-8'));
  expect(raw._version).toBe(1);
});

test('readConfig strips _version from returned object', async () => {
  await writeConfig({ brainId: 'test-brain' });
  const config = await readConfig();
  expect(config._version).toBeUndefined();
  expect(config.brainId).toBe('test-brain');
});

test('readConfig migrates v0 file (no _version field) transparently', async () => {
  await fsp.writeFile(configFile(), JSON.stringify({ brainId: 'old-brain' }), 'utf-8');
  const config = await readConfig();
  expect(config.brainId).toBe('old-brain');
  expect(config._version).toBeUndefined();
});

// ── skills_mode ───────────────────────────────────────────────────────────────

test('getSkillsMode returns static when not set', async () => {
  const mode = await getSkillsMode();
  expect(mode).toBe('static');
});

test('getSkillsMode returns mech-storage when set to mech-storage', async () => {
  await setSkillsMode('mech-storage');
  const mode = await getSkillsMode();
  expect(mode).toBe('mech-storage');
});

test('setSkillsMode persists mech-storage to config', async () => {
  await setSkillsMode('mech-storage');
  const raw = JSON.parse(await fsp.readFile(configFile(), 'utf-8'));
  expect(raw.skills_mode).toBe('mech-storage');
});

test('share config round-trips through global config', async () => {
  await setShareConfig({
    provider: 'local',
    path: '/tmp/agent-share',
    brain_root: 'brains',
  });
  const share = await getShareConfig();
  expect(share).toEqual({
    provider: 'local',
    remote: '',
    mount_point: '',
    path: '/tmp/agent-share',
    brain_root: 'brains',
    bridge_enabled: false,
  });
});

test('normalizeShareConfig rejects invalid providers', () => {
  expect(normalizeShareConfig({ provider: 'bogus', path: '/tmp/share' })).toBeNull();
});

test('setShareConfig rejects invalid providers', async () => {
  await expect(setShareConfig({ provider: 'bogus', path: '/tmp/share' } as never)).rejects.toThrow('invalid share config');
});
