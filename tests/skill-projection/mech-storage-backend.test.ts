/**
 * MechStorageBackend unit tests — uses MockMechClient (no real network calls)
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { MechStorageBackend } from '../../lib/skill-projection/backends/mech-storage.js';
import { MechStorageError } from '../../lib/skill-projection/backends/errors.js';

// ── MockMechClient ────────────────────────────────────────────────────────────

interface MechDocument {
  id: string;
  document_id: string;
  document: Record<string, unknown>;
}

class MockMechClient {
  docs: Map<string, MechDocument> = new Map();
  private nextId = 1;

  async listDocuments(_collection: string): Promise<MechDocument[]> {
    return Array.from(this.docs.values());
  }

  async getDocument(id: string): Promise<MechDocument | null> {
    return this.docs.get(id) ?? null;
  }

  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, document_id: id, document: data });
    return id;
  }

  async updateDocument(docId: string, _collection: string, data: Record<string, unknown>): Promise<void> {
    const existing = this.docs.get(docId);
    if (!existing) throw new Error(`Doc ${docId} not found`);
    this.docs.set(docId, { ...existing, document: data });
  }

  async deleteDocument(docId: string): Promise<void> {
    this.docs.delete(docId);
  }
}

/** Mock that always throws with a given error */
class ErrorMechClient {
  private err: Error & { status?: number };

  constructor(err: Error & { status?: number }) {
    this.err = err;
  }

  async listDocuments(_collection: string): Promise<MechDocument[]> { throw this.err; }
  async getDocument(_id: string): Promise<MechDocument | null> { throw this.err; }
  async createDocument(_collection: string, _data: Record<string, unknown>): Promise<string> { throw this.err; }
  async updateDocument(_docId: string, _collection: string, _data: Record<string, unknown>): Promise<void> { throw this.err; }
  async deleteDocument(_docId: string): Promise<void> { throw this.err; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSkill(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-skill',
    content: '# Hello',
    scope: 'master' as const,
    tenantId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MechStorageBackend', () => {
  let mech: MockMechClient;
  let backend: MechStorageBackend;
  const agentId = 'test-agent';

  beforeEach(() => {
    mech = new MockMechClient();
    backend = new MechStorageBackend({ mechClient: mech as never, agentId });
  });

  // ── loadSkills ──────────────────────────────────────────────────────────────

  test('loadSkills returns [] when store is empty', async () => {
    const skills = await backend.loadSkills('master');
    expect(skills).toEqual([]);
  });

  test('loadSkills returns skills filtered by scope', async () => {
    await backend.saveSkill(makeSkill({ name: 'master-skill', scope: 'master', tenantId: null }));
    await backend.saveSkill(makeSkill({ name: 'tenant-skill', scope: 'tenant', tenantId: 'brain-1' }));

    const masterSkills = await backend.loadSkills('master');
    expect(masterSkills).toHaveLength(1);
    expect(masterSkills[0].name).toBe('master-skill');

    const tenantSkills = await backend.loadSkills('tenant', 'brain-1');
    expect(tenantSkills).toHaveLength(1);
    expect(tenantSkills[0].name).toBe('tenant-skill');
  });

  test('loadSkills filters by tenantId for tenant scope', async () => {
    await backend.saveSkill(makeSkill({ name: 'brain-1-skill', scope: 'tenant', tenantId: 'brain-1' }));
    await backend.saveSkill(makeSkill({ name: 'brain-2-skill', scope: 'tenant', tenantId: 'brain-2' }));

    const result = await backend.loadSkills('tenant', 'brain-1');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('brain-1-skill');
  });

  // ── saveSkill ───────────────────────────────────────────────────────────────

  test('saveSkill creates a new doc and returns skill with id when no id provided', async () => {
    const skill = makeSkill();
    const saved = await backend.saveSkill(skill);
    expect(saved.id).toBeTruthy();
    expect(typeof saved.id).toBe('string');
    expect(saved.name).toBe('test-skill');
  });

  test('saveSkill updates existing doc and returns skill with same id', async () => {
    const skill = makeSkill();
    const created = await backend.saveSkill(skill);

    const updated = await backend.saveSkill({ ...created, content: '# Updated' });
    expect(updated.id).toBe(created.id);
    expect(updated.content).toBe('# Updated');
  });

  // ── deleteSkill ─────────────────────────────────────────────────────────────

  test('deleteSkill removes a skill so it no longer appears in loadSkills', async () => {
    const saved = await backend.saveSkill(makeSkill());
    await backend.deleteSkill(saved.id!);
    const skills = await backend.loadSkills('master');
    expect(skills).toEqual([]);
  });

  // ── loadAgentConfig ─────────────────────────────────────────────────────────

  test('loadAgentConfig returns content when a matching config exists', async () => {
    // Manually seed a config doc into the mock
    await mech.createDocument(`${agentId}-agent-configs`, {
      scope: 'master',
      tenantId: null,
      content: '# My agent config',
    });

    const config = await backend.loadAgentConfig('master');
    expect(config).toBe('# My agent config');
  });

  test('loadAgentConfig returns null when no matching config exists', async () => {
    const config = await backend.loadAgentConfig('master');
    expect(config).toBeNull();
  });

  test('loadAgentConfig matches by tenantId', async () => {
    await mech.createDocument(`${agentId}-agent-configs`, {
      scope: 'tenant',
      tenantId: 'brain-1',
      content: '# Brain 1 config',
    });

    expect(await backend.loadAgentConfig('tenant', 'brain-2')).toBeNull();
    expect(await backend.loadAgentConfig('tenant', 'brain-1')).toBe('# Brain 1 config');
  });

  // ── loadVersions ────────────────────────────────────────────────────────────

  test('loadVersions returns [] when no versions exist', async () => {
    const versions = await backend.loadVersions('nonexistent-skill');
    expect(versions).toEqual([]);
  });

  test('loadVersions returns versions sorted descending by versionNum', async () => {
    const saved = await backend.saveSkill(makeSkill({ content: 'v1' }));
    await backend.saveVersion(saved.id!, 'test-skill', 'v1 content', 'agent-x');
    await backend.saveVersion(saved.id!, 'test-skill', 'v2 content', 'agent-x');
    await backend.saveVersion(saved.id!, 'test-skill', 'v3 content', 'agent-x');

    const versions = await backend.loadVersions(saved.id!);
    expect(versions).toHaveLength(3);
    expect(versions[0].versionNum).toBe(3);
    expect(versions[1].versionNum).toBe(2);
    expect(versions[2].versionNum).toBe(1);
  });

  // ── saveVersion ─────────────────────────────────────────────────────────────

  test('saveVersion creates version with correct sequential versionNum', async () => {
    const saved = await backend.saveSkill(makeSkill());
    await backend.saveVersion(saved.id!, 'test-skill', 'content v1', 'agent-x');
    await backend.saveVersion(saved.id!, 'test-skill', 'content v2', 'agent-x');

    const versions = await backend.loadVersions(saved.id!);
    expect(versions[0].versionNum).toBe(2);
    expect(versions[1].versionNum).toBe(1);
  });

  test('saveVersion stores savedBy attribution', async () => {
    const saved = await backend.saveSkill(makeSkill());
    await backend.saveVersion(saved.id!, 'test-skill', 'content v1', 'agent-attribution');

    const versions = await backend.loadVersions(saved.id!);
    expect(versions[0].savedBy).toBe('agent-attribution');
  });

  test('saveVersion trims to 20 most recent (create 22, assert 20 remain)', async () => {
    const saved = await backend.saveSkill(makeSkill());
    for (let i = 0; i < 22; i++) {
      await backend.saveVersion(saved.id!, 'test-skill', `content v${i + 1}`, 'agent-x');
    }

    const versions = await backend.loadVersions(saved.id!);
    expect(versions).toHaveLength(20);
    // Oldest two (versionNums 1 and 2) should be gone
    const nums = versions.map((v) => v.versionNum);
    expect(nums).not.toContain(1);
    expect(nums).not.toContain(2);
    expect(nums).toContain(22);
  });

  // ── restoreVersion ──────────────────────────────────────────────────────────

  test('restoreVersion snapshots current state before restoring target version', async () => {
    const saved = await backend.saveSkill(makeSkill({ content: 'original content', name: 'my-skill' }));
    await backend.saveVersion(saved.id!, 'my-skill', 'original content', 'snapshot before v1');
    // Now update skill to new content
    await backend.saveSkill({ ...saved, content: 'new content' });

    // Restore to version 1
    await backend.restoreVersion(saved.id!, 1, 'agent-y');

    // The skill content should now be the v1 content
    const skills = await backend.loadSkills('master');
    const skill = skills.find((s) => s.id === saved.id);
    expect(skill?.content).toBe('original content');

    // A new version snapshot should exist recording what was replaced
    const versions = await backend.loadVersions(saved.id!);
    const snapshotNote = versions.find((v) => v.note?.includes('Replaced by restore'));
    expect(snapshotNote).toBeDefined();
  });

  // ── isEmptyStore ────────────────────────────────────────────────────────────

  test('isEmptyStore returns true when no skills exist', async () => {
    expect(await backend.isEmptyStore()).toBe(true);
  });

  test('isEmptyStore returns false after saving a skill', async () => {
    await backend.saveSkill(makeSkill());
    expect(await backend.isEmptyStore()).toBe(false);
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  test('throws MechStorageError with UNAVAILABLE code when mechClient throws generic error', async () => {
    const errClient = new ErrorMechClient(new Error('Connection refused'));
    const errBackend = new MechStorageBackend({ mechClient: errClient as never, agentId });

    await expect(errBackend.loadSkills('master')).rejects.toBeInstanceOf(MechStorageError);
    await expect(errBackend.loadSkills('master')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  test('throws MechStorageError with UNAUTHORIZED code when mechClient throws 401', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    const errClient = new ErrorMechClient(err);
    const errBackend = new MechStorageBackend({ mechClient: errClient as never, agentId });

    await expect(errBackend.loadSkills('master')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  test('throws MechStorageError with UNAUTHORIZED code when mechClient throws 403', async () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    const errClient = new ErrorMechClient(err);
    const errBackend = new MechStorageBackend({ mechClient: errClient as never, agentId });

    await expect(errBackend.loadSkills('master')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
