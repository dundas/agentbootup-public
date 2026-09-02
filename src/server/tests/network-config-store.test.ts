/**
 * NetworkConfigStore unit tests — uses a mock MechClient
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { NetworkConfigStore } from '../lib/network-config-store';
import type { NetworkConfig } from '../lib/network-config-store';
import type { MechDocument } from '../types';

// ── Mock MechClient ───────────────────────────────────────────────────────────

class MockMechClient {
  private docs: Map<string, MechDocument> = new Map();
  private nextId = 1;

  async listDocuments(_collection: string): Promise<MechDocument[]> {
    return Array.from(this.docs.values());
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

// ── Helpers ──────────────────────────────────────────────────────────────────

const API_KEY_HASH = 'test-api-key-hash-abc123';

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    version: '2.0',
    role: 'network',
    projects: [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NetworkConfigStore', () => {
  let store: NetworkConfigStore;
  let mech: MockMechClient;

  beforeEach(() => {
    mech = new MockMechClient();
    store = new NetworkConfigStore(mech as never);
  });

  test('get returns null when no config exists', async () => {
    const config = await store.get(API_KEY_HASH);
    expect(config).toBeNull();
  });

  test('put stores config and get retrieves it', async () => {
    const config = makeConfig({
      hub: 'https://hub.example.com',
      projects: [
        { id: 'proj-a', agent_id: 'agent-a.gm', type: 'service', brain: true, trusted: true, capabilities: ['web'] },
      ],
    });

    const result = await store.put(API_KEY_HASH, config);
    expect(result.projectCount).toBe(1);

    const retrieved = await store.get(API_KEY_HASH);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.version).toBe('2.0');
    expect(retrieved!.role).toBe('network');
    expect(retrieved!.hub).toBe('https://hub.example.com');
    expect(retrieved!.projects).toHaveLength(1);
    expect(retrieved!.projects[0].agent_id).toBe('agent-a.gm');
    expect(retrieved!.projects[0].capabilities).toEqual(['web']);
  });

  test('put merges: existing projects retained when not in payload', async () => {
    // First push: 3 projects
    await store.put(API_KEY_HASH, makeConfig({
      projects: [
        { id: 'proj-a', agent_id: 'agent-a.gm' },
        { id: 'proj-b', agent_id: 'agent-b.gm' },
        { id: 'proj-c', agent_id: 'agent-c.gm' },
      ],
    }));

    // Second push: only 1 project — the other 2 must be retained
    const result = await store.put(API_KEY_HASH, makeConfig({
      projects: [
        { id: 'proj-a', agent_id: 'agent-a.gm' },
      ],
    }));

    expect(result.projectCount).toBe(3);

    const retrieved = await store.get(API_KEY_HASH);
    const agentIds = retrieved!.projects.map((p) => p.agent_id).sort();
    expect(agentIds).toEqual(['agent-a.gm', 'agent-b.gm', 'agent-c.gm']);
  });

  test('put upserts: existing project metadata updated when agent_id matches', async () => {
    await store.put(API_KEY_HASH, makeConfig({
      projects: [
        { id: 'proj-a', agent_id: 'agent-a.gm', type: 'service', capabilities: ['old'] },
      ],
    }));

    await store.put(API_KEY_HASH, makeConfig({
      projects: [
        { id: 'proj-a', agent_id: 'agent-a.gm', type: 'library', capabilities: ['new', 'updated'] },
      ],
    }));

    const retrieved = await store.get(API_KEY_HASH);
    expect(retrieved!.projects).toHaveLength(1);
    expect(retrieved!.projects[0].type).toBe('library');
    expect(retrieved!.projects[0].capabilities).toEqual(['new', 'updated']);
  });

  test('put adds: new projects appended alongside existing', async () => {
    await store.put(API_KEY_HASH, makeConfig({
      projects: [
        { id: 'proj-a', agent_id: 'agent-a.gm' },
      ],
    }));

    const result = await store.put(API_KEY_HASH, makeConfig({
      projects: [
        { id: 'proj-b', agent_id: 'agent-b.gm' },
      ],
    }));

    expect(result.projectCount).toBe(2);

    const retrieved = await store.get(API_KEY_HASH);
    const agentIds = retrieved!.projects.map((p) => p.agent_id).sort();
    expect(agentIds).toEqual(['agent-a.gm', 'agent-b.gm']);
  });

  test('put strips path fields from projects', async () => {
    await store.put(API_KEY_HASH, makeConfig({
      projects: [
        { id: 'proj-a', agent_id: 'agent-a.gm', path: './local/path' } as any,
        { id: 'proj-b', agent_id: 'agent-b.gm', path: '~/dev_env/foo' } as any,
      ],
    }));

    const retrieved = await store.get(API_KEY_HASH);
    for (const project of retrieved!.projects) {
      expect((project as any).path).toBeUndefined();
    }
  });

  test('top-level fields use last-write-wins', async () => {
    await store.put(API_KEY_HASH, makeConfig({
      hub: 'https://hub-v1.example.com',
      skills_source: '.',
      transcriptSync: { enabled: true, clis: ['claude'], retentionDays: 30 },
      projects: [{ id: 'p1', agent_id: 'a1.gm' }],
    }));

    // Second push updates hub but doesn't send skills_source or transcriptSync
    await store.put(API_KEY_HASH, makeConfig({
      hub: 'https://hub-v2.example.com',
      projects: [{ id: 'p1', agent_id: 'a1.gm' }],
    }));

    const retrieved = await store.get(API_KEY_HASH);
    expect(retrieved!.hub).toBe('https://hub-v2.example.com');
    // skills_source and transcriptSync retained from first push
    expect(retrieved!.skills_source).toBe('.');
    expect(retrieved!.transcriptSync).toEqual({ enabled: true, clis: ['claude'], retentionDays: 30 });
  });

  test('duplicate agent_id in payload: last entry wins', async () => {
    await store.put(API_KEY_HASH, makeConfig({
      projects: [
        { id: 'proj-a-old', agent_id: 'agent-a.gm', type: 'service' },
        { id: 'proj-a-new', agent_id: 'agent-a.gm', type: 'library' },
      ],
    }));

    const retrieved = await store.get(API_KEY_HASH);
    expect(retrieved!.projects).toHaveLength(1);
    expect(retrieved!.projects[0].id).toBe('proj-a-new');
    expect(retrieved!.projects[0].type).toBe('library');
  });

  test('different API key hashes are isolated', async () => {
    await store.put('key-1', makeConfig({
      projects: [{ id: 'p1', agent_id: 'a1.gm' }],
    }));
    await store.put('key-2', makeConfig({
      projects: [{ id: 'p2', agent_id: 'a2.gm' }],
    }));

    const config1 = await store.get('key-1');
    const config2 = await store.get('key-2');

    expect(config1!.projects).toHaveLength(1);
    expect(config1!.projects[0].agent_id).toBe('a1.gm');
    expect(config2!.projects).toHaveLength(1);
    expect(config2!.projects[0].agent_id).toBe('a2.gm');
  });

  test('removeProject removes project by agent_id', async () => {
    await store.put(API_KEY_HASH, makeConfig({
      projects: [
        { id: 'proj-a', agent_id: 'agent-a.gm' },
        { id: 'proj-b', agent_id: 'agent-b.gm' },
      ],
    }));

    const removed = await store.removeProject(API_KEY_HASH, 'agent-a.gm');
    expect(removed).toBe(true);

    const retrieved = await store.get(API_KEY_HASH);
    expect(retrieved!.projects).toHaveLength(1);
    expect(retrieved!.projects[0].agent_id).toBe('agent-b.gm');
  });

  test('removeProject returns false for non-existent agent_id', async () => {
    await store.put(API_KEY_HASH, makeConfig({
      projects: [{ id: 'proj-a', agent_id: 'agent-a.gm' }],
    }));

    const removed = await store.removeProject(API_KEY_HASH, 'non-existent.gm');
    expect(removed).toBe(false);
  });

  test('removeProject returns false when no config exists', async () => {
    const removed = await store.removeProject(API_KEY_HASH, 'agent-a.gm');
    expect(removed).toBe(false);
  });
});
