import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectConfig, getAgentId, loadProjectConfig, resolveProjectAgentId } from '../lib/project-config.js';

const tempDirs = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-project-id-'));
  tempDirs.push(root);
  return root;
}

function writeJson(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveProjectAgentId', () => {
  test('resolves canonical agent_id from agentbootup.json', () => {
    const root = makeProject();
    writeJson(root, 'agentbootup.json', { agent_id: 'snake-brain' });

    expect(resolveProjectAgentId(root)).toBe('snake-brain');
  });

  test('accepts deployed agentId from brain/config.json', () => {
    const root = makeProject();
    writeJson(root, 'brain/config.json', { agentId: 'camel-brain' });

    expect(resolveProjectAgentId(root)).toBe('camel-brain');
  });

  test('accepts matching canonical and compatibility keys', () => {
    const root = makeProject();
    writeJson(root, 'brain/config.json', {
      agent_id: 'same-brain',
      agentId: 'same-brain',
    });

    expect(resolveProjectAgentId(root)).toBe('same-brain');
  });

  test('fails closed when canonical and compatibility keys conflict', () => {
    const root = makeProject();
    writeJson(root, 'brain/config.json', {
      agent_id: 'snake-brain',
      agentId: 'camel-brain',
    });

    expect(() => resolveProjectAgentId(root)).toThrow(/brain\/config\.json.*agent_id.*snake-brain.*agentId.*camel-brain.*refusing to choose/is);
    expect(() => getAgentId(root)).toThrow(/refusing to choose/i);
  });

  test('fails closed when the two project files identify different brains', () => {
    const root = makeProject();
    writeJson(root, 'agentbootup.json', { agent_id: 'canonical-brain' });
    writeJson(root, 'brain/config.json', { agentId: 'legacy-brain' });

    expect(() => resolveProjectAgentId(root)).toThrow(/agentbootup\.json.*agent_id.*canonical-brain.*brain\/config\.json.*agentId.*legacy-brain/is);
  });

  test('malformed config names every inspected file and supported key', () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, 'agentbootup.json'), '{ invalid json');

    expect(() => resolveProjectAgentId(root)).toThrow(/invalid JSON.*agentbootup\.json.*brain\/config\.json.*agent_id.*agentId/is);
  });

  test('missing config names every inspected file and supported key', () => {
    const root = makeProject();

    expect(() => resolveProjectAgentId(root)).toThrow(/agentbootup\.json.*brain\/config\.json.*agent_id.*agentId/is);
    expect(getAgentId(root)).toBeNull();
  });
});

describe('ensureProjectConfig', () => {
  test('creates agentbootup.json with agent_id + projects:[self] when absent', () => {
    const root = makeProject();
    const result = ensureProjectConfig(root, { agentId: 'circle-agent', projectId: 'circle-agent' });

    expect(result.created).toBe(true);
    expect(result.changed).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    expect(config.agent_id).toBe('circle-agent');
    expect(config.projects).toEqual([
      { id: 'circle-agent', agent_id: 'circle-agent', path: '.', brain: true },
    ]);
  });

  test('appends a self-target when projects exists but lacks self (preserves others)', () => {
    const root = makeProject();
    writeJson(root, 'agentbootup.json', {
      agent_id: 'decisive',
      projects: [{ id: 'other', agent_id: 'other', path: '/x', brain: true }],
    });

    const result = ensureProjectConfig(root, { agentId: 'decisive', projectId: 'decisive' });

    expect(result.created).toBe(false);
    expect(result.changed).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    expect(config.projects).toHaveLength(2);
    expect(config.projects[1]).toEqual({ id: 'decisive', agent_id: 'decisive', path: '.', brain: true });
    expect(config.projects[0].id).toBe('other');
  });

  test('is a no-op when agent_id + self-target already present', () => {
    const root = makeProject();
    const before = JSON.stringify({
      agent_id: 'agentbeacon',
      projects: [{ id: 'agentbeacon', agent_id: 'agentbeacon', path: '.', brain: true }],
      hub: 'https://x',
    }, null, 2) + '\n';
    fs.writeFileSync(path.join(root, 'agentbootup.json'), before);

    const result = ensureProjectConfig(root, { agentId: 'agentbeacon', projectId: 'agentbeacon' });

    expect(result.created).toBe(false);
    expect(result.changed).toBe(false);
    expect(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8')).toBe(before);
  });

  test('sets agent_id when missing but preserves existing projects', () => {
    const root = makeProject();
    writeJson(root, 'agentbootup.json', {
      projects: [{ id: 'p', agent_id: 'p', path: '/p', brain: true }],
    });

    const result = ensureProjectConfig(root, { agentId: 'ohok', projectId: 'ohok' });

    expect(result.changed).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    expect(config.agent_id).toBe('ohok');
    expect(config.projects).toHaveLength(2);
  });

  test('uses projectId for the self-target id when it differs from agentId (provision path)', () => {
    const root = makeProject();
    // provision derives projectId from agentId (strips .gm/.mm), so they differ.
    const result = ensureProjectConfig(root, { agentId: 'mech-client.gm', projectId: 'mech-client' });

    expect(result.created).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    expect(config.agent_id).toBe('mech-client.gm');
    // id comes from projectId, agent_id from agentId
    expect(config.projects[0]).toEqual({ id: 'mech-client', agent_id: 'mech-client.gm', path: '.', brain: true });
  });

  test('a disagreeing existing agent_id is preserved + reported as staleAgentId (no silent overwrite)', () => {
    const root = makeProject();
    writeJson(root, 'agentbootup.json', { agent_id: 'old-name', projects: [] });

    const result = ensureProjectConfig(root, { agentId: 'new-name', projectId: 'new-name' });

    expect(result.created).toBe(false);
    expect(result.changed).toBe(true); // the self-target is appended
    expect(result.staleAgentId).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    // agent_id NOT overwritten — preserved to surface the conflict
    expect(config.agent_id).toBe('old-name');
    // but the self-target for the new identity is still appended
    const self = config.projects.find((p) => p.agent_id === 'new-name');
    expect(self).toEqual({ id: 'new-name', agent_id: 'new-name', path: '.', brain: true });
  });

  test('resulting config is loadable by loadProjectConfig and has a valid self-target', () => {
    const root = makeProject();
    ensureProjectConfig(root, { agentId: 'bootup', projectId: 'bootup' });

    const { config } = loadProjectConfig(root);
    expect(config.agent_id).toBe('bootup');
    const self = config.projects.find((p) => p.id === 'bootup');
    expect(self).toEqual({ id: 'bootup', agent_id: 'bootup', path: '.', brain: true });
  });

  test('a corrupt existing config is backed up to .corrupt and rebuilt with the identity facts', () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, 'agentbootup.json'), '{ invalid json }');

    const result = ensureProjectConfig(root, { agentId: 'signal', projectId: 'signal' });

    expect(result.created).toBe(false);
    expect(result.wipedCorrupt).toBe(true);
    expect(result.backedUp).toBe(true);
    // corrupt bytes preserved for diagnosis
    expect(fs.readFileSync(path.join(root, 'agentbootup.json.corrupt'), 'utf-8')).toBe('{ invalid json }');
    // rebuilt config is valid and has the identity + self-target
    const config = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    expect(config.agent_id).toBe('signal');
    expect(config.projects).toEqual([
      { id: 'signal', agent_id: 'signal', path: '.', brain: true },
    ]);
  });

  test('a parseable-but-non-object config (array) is treated as corrupt: backed up + rebuilt', () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, 'agentbootup.json'), '[]');

    const result = ensureProjectConfig(root, { agentId: 'blankpost', projectId: 'blankpost' });

    expect(result.wipedCorrupt).toBe(true);
    expect(result.backedUp).toBe(true);
    expect(fs.readFileSync(path.join(root, 'agentbootup.json.corrupt'), 'utf-8')).toBe('[]');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    expect(config.agent_id).toBe('blankpost');
    expect(config.projects).toEqual([
      { id: 'blankpost', agent_id: 'blankpost', path: '.', brain: true },
    ]);
  });

  test('when the .corrupt backup fails, the corrupt config is left in place (no data loss, no rebuild)', () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, 'agentbootup.json'), '{ invalid }');
    // Make the repo root read-only so copyFileSync (-> .corrupt) fails.
    fs.chmodSync(root, 0o555);

    const result = ensureProjectConfig(root, { agentId: 'agentdrive', projectId: 'agentdrive' });

    expect(result.wipedCorrupt).toBe(true);
    expect(result.backedUp).toBe(false);
    expect(result.changed).toBe(false);
    // The corrupt bytes are still the live config (not overwritten).
    expect(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8')).toBe('{ invalid }');
    // No .corrupt file was created.
    expect(fs.existsSync(path.join(root, 'agentbootup.json.corrupt'))).toBe(false);

    fs.chmodSync(root, 0o755); // restore so afterEach cleanup can rmSync
  });
});
