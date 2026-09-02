import { describe, test, expect, beforeEach } from 'bun:test';
import { SkillStore } from '../lib/skill-store';
import type { MechDocument } from '../types';

// ── Mock MechClient ──────────────────────────────────────────────────────────

class MockMechClient {
  private docs: Map<string, { id: string; document: Record<string, unknown> }> = new Map();
  private nextId = 1;

  async listDocuments(_collection: string): Promise<MechDocument[]> {
    return Array.from(this.docs.values()).map((d) => ({
      id: d.id,
      document_id: d.id,
      document: d.document,
    }));
  }

  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, document: data });
    return id;
  }

  async deleteDocument(docId: string): Promise<void> {
    this.docs.delete(docId);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_SKILL = {
  id: 'transcript-query',
  name: 'Transcript Query',
  description: 'Query session transcripts across CLIs',
  tags: ['transcripts', 'history', 'search'],
  files: [
    { path: 'SKILL.md', content: '# Transcript Query\n\nQuery transcripts.' },
    { path: 'lib/parser.js', content: "export function parse() { return {}; }" },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SkillStore', () => {
  let store: SkillStore;

  beforeEach(() => {
    store = new SkillStore(new MockMechClient() as never);
  });

  test('creates a skill', async () => {
    const skill = await store.create(SAMPLE_SKILL);
    expect(skill.id).toBe('transcript-query');
    expect(skill.name).toBe('Transcript Query');
    expect(skill.file_count).toBe(2);
    expect(skill.files).toHaveLength(2);
  });

  test('sets timestamps on create', async () => {
    const skill = await store.create(SAMPLE_SKILL);
    expect(() => new Date(skill.created_at)).not.toThrow();
    expect(() => new Date(skill.updated_at)).not.toThrow();
    expect(new Date(skill.created_at).toISOString()).toBe(skill.created_at);
  });

  test('defaults description and tags when omitted', async () => {
    const skill = await store.create({ id: 'minimal', name: 'Minimal', files: SAMPLE_SKILL.files });
    expect(skill.description).toBe('');
    expect(skill.tags).toEqual([]);
  });

  test('list returns skills without file content', async () => {
    await store.create(SAMPLE_SKILL);
    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe('transcript-query');
    expect('files' in summaries[0]).toBe(false);
  });

  test('list returns multiple skills', async () => {
    await store.create(SAMPLE_SKILL);
    await store.create({ ...SAMPLE_SKILL, id: 'other-skill', name: 'Other' });
    const summaries = await store.list();
    expect(summaries).toHaveLength(2);
  });

  test('get returns full skill with files', async () => {
    await store.create(SAMPLE_SKILL);
    const skill = await store.get('transcript-query');
    expect(skill).not.toBeNull();
    expect(skill!.files).toHaveLength(2);
    expect(skill!.files[0].path).toBe('SKILL.md');
    expect(skill!.files[1].path).toBe('lib/parser.js');
  });

  test('get returns null for unknown skill', async () => {
    const skill = await store.get('does-not-exist');
    expect(skill).toBeNull();
  });

  test('create rejects duplicate ID', async () => {
    await store.create(SAMPLE_SKILL);
    await expect(store.create(SAMPLE_SKILL)).rejects.toThrow("Skill 'transcript-query' already exists.");
  });

  test('delete removes skill', async () => {
    await store.create(SAMPLE_SKILL);
    await store.delete('transcript-query');
    const skill = await store.get('transcript-query');
    expect(skill).toBeNull();
  });

  test('delete throws for unknown skill', async () => {
    await expect(store.delete('does-not-exist')).rejects.toThrow("Skill 'does-not-exist' not found.");
  });
});
