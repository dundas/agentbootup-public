import { describe, test, expect } from 'bun:test';
import { BundleBuilder, DEFAULT_TTL_SECONDS, DEFAULT_CLONE_DEPTH, BUNDLE_TRANSCRIPT_LIMIT } from '../lib/bundle-builder';
import { TRANSCRIPT_INLINE_THRESHOLD } from '../lib/transcript-store';
import type { TranscriptStoreAdapter } from '../types';
import type { Brain, Skill, TranscriptMeta } from '../types';
import type { AssetType, AssetCli, BrainAssetFilters } from '../lib/brain-asset-store';

const SAMPLE_BRAIN: Brain = {
  id: 'decisive-gm',
  repo_url: 'https://github.com/dundas/decisive-redux.git',
  repo_branch: 'main',
  vault_namespace: 'brain-server-prod',
  skills: [],
  memory_collection: 'agent_memory_decisive_gm',
  parent_brain: null,
  trust_level: 'full',
  metadata: {},
  registered_at: '2026-02-22T00:00:00Z',
  updated_at: '2026-02-22T00:00:00Z',
};

class MockVaultClient {
  constructor(private secrets: Record<string, string> = {}) {}

  async getDeploymentBundle(_namespace: string): Promise<Record<string, string>> {
    return this.secrets;
  }
}

class MockSkillStore {
  constructor(private skills: Record<string, Skill> = {}) {}

  async get(id: string): Promise<Skill | null> {
    return this.skills[id] ?? null;
  }
}

class MockMemoryStore {
  constructor(private files: Array<{ path: string; content: string }> = []) {}

  async pull(_collection: string): Promise<Array<{ path: string; content: string }>> {
    return this.files;
  }
}

class MockRegistryStore {
  constructor(private registry: { services: unknown[] } | null = null) {}

  async getRegistry(): Promise<{ services: unknown[] } | null> {
    return this.registry;
  }
}

class MockTranscriptStore implements TranscriptStoreAdapter {
  constructor(
    private metas: TranscriptMeta[] = [],
    private contents: Record<string, Buffer> = {},
    private downloadError?: Error,
  ) {}

  async list(_brainId: string): Promise<TranscriptMeta[]> {
    return this.metas;
  }

  async download(key: string): Promise<Buffer> {
    if (this.downloadError) throw this.downloadError;
    const buf = this.contents[key];
    if (!buf) throw new Error(`MockTranscriptStore: no content registered for key '${key}'`);
    return buf;
  }
}

describe('BundleBuilder', () => {
  test('builds bundle with correct repo fields', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN);

    expect(bundle.brain.id).toBe('decisive-gm');
    expect(bundle.repo.url).toBe('https://github.com/dundas/decisive-redux.git');
    expect(bundle.repo.branch).toBe('main');
    expect(bundle.repo.clone_depth).toBe(DEFAULT_CLONE_DEPTH);
  });

  test('includes credentials from vault by default', async () => {
    const secrets = { SOME_KEY: 'secret-value', OTHER: 'other-value' };
    const builder = new BundleBuilder(new MockVaultClient(secrets) as never);
    const bundle = await builder.build(SAMPLE_BRAIN);

    expect(bundle.credentials).toEqual(secrets);
  });

  test('omits credentials when include_credentials=false', async () => {
    const secrets = { SOME_KEY: 'secret-value' };
    const builder = new BundleBuilder(new MockVaultClient(secrets) as never);
    const bundle = await builder.build(SAMPLE_BRAIN, { include_credentials: false });

    expect(bundle.credentials).toEqual({});
  });

  test('sets default ttl', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN);

    expect(bundle.ttl_seconds).toBe(DEFAULT_TTL_SECONDS);
  });

  test('respects custom ttl', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN, { ttl_seconds: 600 });

    expect(bundle.ttl_seconds).toBe(600);
  });

  test('includes base env_vars', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN);

    expect(bundle.env_vars.BRAIN_ID).toBe('decisive-gm');
    expect(bundle.env_vars.BRAIN_REPO_URL).toBe('https://github.com/dundas/decisive-redux.git');
    expect(bundle.env_vars.BRAIN_REPO_BRANCH).toBe('main');
  });

  test('repo-less brain omits repo env vars and sets a null repo url', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const repoLess = { ...SAMPLE_BRAIN, repo_url: null, repo_branch: null };
    const bundle = await builder.build(repoLess);

    expect(bundle.env_vars.BRAIN_ID).toBe('decisive-gm');
    expect('BRAIN_REPO_URL' in bundle.env_vars).toBe(false);
    expect('BRAIN_REPO_BRANCH' in bundle.env_vars).toBe(false);
    expect(bundle.repo.url).toBeNull();
    expect(bundle.repo.branch).toBeNull();
  });

  test('skills empty when include_skills not set', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN);
    expect(bundle.skills).toEqual([]);
  });

  test('memory is empty array (Phase 4)', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN);
    expect(bundle.memory).toEqual([]);
  });

  test('includes skill files when include_skills=true', async () => {
    const mockSkill: Skill = {
      id: 'transcript-query',
      name: 'Transcript Query',
      description: '',
      tags: [],
      files: [{ path: 'SKILL.md', content: '# Transcript Query' }],
      file_count: 1,
      created_at: '2026-02-22T00:00:00Z',
      updated_at: '2026-02-22T00:00:00Z',
    };
    const brainWithSkill = { ...SAMPLE_BRAIN, skills: ['transcript-query'] };
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { skillStore: new MockSkillStore({ 'transcript-query': mockSkill }) as never },
    );
    const bundle = await builder.build(brainWithSkill, { include_skills: true });

    expect(bundle.skills).toHaveLength(1);
    expect(bundle.skills[0].id).toBe('transcript-query');
    expect(bundle.skills[0].files).toHaveLength(1);
    expect(bundle.skills[0].files[0].path).toBe('SKILL.md');
  });

  test('caps skill files by default skill_limit', async () => {
    const makeSkill = (id: string): Skill => ({
      id,
      name: id,
      description: '',
      tags: [],
      files: [{ path: 'SKILL.md', content: `# ${id}` }],
      file_count: 1,
      created_at: '2026-02-22T00:00:00Z',
      updated_at: '2026-02-22T00:00:00Z',
    });

    const brainWithMany = { ...SAMPLE_BRAIN, skills: ['a', 'b', 'c', 'd'] };
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { skillStore: new MockSkillStore({ a: makeSkill('a'), b: makeSkill('b'), c: makeSkill('c'), d: makeSkill('d') }) as never },
    );
    const bundle = await builder.build(brainWithMany, { include_skills: true });

    expect(bundle.skills).toHaveLength(3);
    expect(bundle.skills.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  test('includes memory files when include_memory=true', async () => {
    const memFiles = [
      { path: 'memory/MEMORY.md', content: '# Memory' },
      { path: 'memory/daily/2026-02-22.md', content: '## Daily' },
    ];
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { memoryStore: new MockMemoryStore(memFiles) as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_memory: true });

    expect(bundle.memory).toHaveLength(2);
    expect(bundle.memory[0].path).toBe('memory/MEMORY.md');
    expect(bundle.memory[1].path).toBe('memory/daily/2026-02-22.md');
  });

  test('memory empty when include_memory=false (default)', async () => {
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { memoryStore: new MockMemoryStore([{ path: 'test.md', content: 'content' }]) as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN);
    expect(bundle.memory).toEqual([]);
  });

  test('silently skips missing skills', async () => {
    const brainWithSkill = { ...SAMPLE_BRAIN, skills: ['nonexistent-skill'] };
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { skillStore: new MockSkillStore({}) as never },
    );
    const bundle = await builder.build(brainWithSkill, { include_skills: true });
    expect(bundle.skills).toEqual([]);
  });

  test('registry_snapshot is null when no registryStore provided', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN);
    expect(bundle.registry_snapshot).toBeNull();
  });

  test('registry_snapshot is null when registry is empty', async () => {
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { registryStore: new MockRegistryStore(null) as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN);
    expect(bundle.registry_snapshot).toBeNull();
  });

  test('registry_snapshot is null by default even when registry store is present', async () => {
    const mockRegistry = {
      services: [
        {
          id: 'mech-storage',
          name: 'Mech Storage',
          baseUrl: 'https://mech-storage.fly.dev',
          endpoints: [],
        },
      ],
    };
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { registryStore: new MockRegistryStore(mockRegistry) as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN);
    expect(bundle.registry_snapshot).toBeNull();
  });

  test('registry_snapshot includes trimmed services without gotchas when enabled', async () => {
    const mockRegistry = {
      services: [
        {
          id: 'mech-storage',
          name: 'Mech Storage',
          baseUrl: 'https://mech-storage.fly.dev',
          description: 'NoSQL document storage',
          auth: { headers: ['X-Api-Key'] },
          healthCheck: '/health',
          categories: ['storage'],
          endpoints: [
            {
              method: 'POST',
              path: '/v1/documents',
              description: 'Create document',
              status: 'working' as const,
              gotchas: ['This is a secret gotcha that should be stripped'],
            },
          ],
        },
      ],
    };
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { registryStore: new MockRegistryStore(mockRegistry) as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_registry_snapshot: true });

    expect(bundle.registry_snapshot).not.toBeNull();
    expect(bundle.registry_snapshot).toHaveLength(1);
    const svc = bundle.registry_snapshot![0];
    expect(svc.id).toBe('mech-storage');
    expect(svc.name).toBe('Mech Storage');
    expect(svc.baseUrl).toBe('https://mech-storage.fly.dev');
    expect(svc.endpoints).toHaveLength(1);
    expect(svc.endpoints[0].method).toBe('POST');
    expect(svc.endpoints[0].path).toBe('/v1/documents');
    expect(svc.endpoints[0].status).toBe('working');
    // gotchas must be stripped from snapshot
    expect((svc.endpoints[0] as Record<string, unknown>).gotchas).toBeUndefined();
  });

  test('assembled_at is a valid ISO timestamp', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN);

    expect(() => new Date(bundle.assembled_at)).not.toThrow();
    expect(new Date(bundle.assembled_at).toISOString()).toBe(bundle.assembled_at);
  });

  test('handles empty vault namespace gracefully', async () => {
    const brainNoNamespace = { ...SAMPLE_BRAIN, vault_namespace: '' };
    const builder = new BundleBuilder(new MockVaultClient({ KEY: 'val' }) as never);
    const bundle = await builder.build(brainNoNamespace);

    // Empty namespace = no vault call = empty credentials
    expect(bundle.credentials).toEqual({});
  });

  test('transcripts is empty array by default', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN);
    expect(bundle.transcripts).toEqual([]);
  });

  test('transcripts empty when include_transcripts=false', async () => {
    const meta: TranscriptMeta = {
      key: 'transcripts/decisive-gm/mac1/claude/session.jsonl',
      brain_id: 'decisive-gm',
      machine_id: 'mac1',
      cli: 'claude',
      filename: 'session.jsonl',
      size: 1024,
      updated_at: '2026-02-22T10:00:00Z',
    };
    const transcriptStore = new MockTranscriptStore([meta]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: false });
    expect(bundle.transcripts).toEqual([]);
  });

  test('includes inline content for small files', async () => {
    const smallContent = Buffer.from('{"role":"user","content":"hello"}');
    const meta: TranscriptMeta = {
      key: 'transcripts/decisive-gm/mac1/claude/session.jsonl',
      brain_id: 'decisive-gm',
      machine_id: 'mac1',
      cli: 'claude',
      filename: 'session.jsonl',
      size: smallContent.length,
      updated_at: '2026-02-22T10:00:00Z',
    };
    const transcriptStore = new MockTranscriptStore(
      [meta],
      { [meta.key]: smallContent },
    );
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });

    expect(bundle.transcripts).toHaveLength(1);
    expect(bundle.transcripts_error).toBeUndefined();
    const t = bundle.transcripts[0];
    expect(t.filename).toBe('session.jsonl');
    expect(t.cli).toBe('claude');
    expect(t.machine_id).toBe('mac1');
    expect(t.content).toBe(smallContent.toString('base64'));
    expect(t.key).toBeUndefined();
  });

  test('uses key only for files exactly at the inline threshold (strict < boundary)', async () => {
    // size === inlineThreshold is NOT below threshold — must produce key-only
    const meta: TranscriptMeta = {
      key: 'transcripts/decisive-gm/mac1/claude/exact.jsonl',
      brain_id: 'decisive-gm',
      machine_id: 'mac1',
      cli: 'claude',
      filename: 'exact.jsonl',
      size: TRANSCRIPT_INLINE_THRESHOLD,
      updated_at: '2026-02-22T10:00:00Z',
    };
    const transcriptStore = new MockTranscriptStore([meta]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });
    expect(bundle.transcripts[0].key).toBe(meta.key);
    expect(bundle.transcripts[0].content).toBeUndefined();
  });

  test('uses key only for large files (above inline threshold)', async () => {
    const bigSize = TRANSCRIPT_INLINE_THRESHOLD + 1;
    const meta: TranscriptMeta = {
      key: 'transcripts/decisive-gm/mac1/claude/big.jsonl',
      brain_id: 'decisive-gm',
      machine_id: 'mac1',
      cli: 'claude',
      filename: 'big.jsonl',
      size: bigSize,
      updated_at: '2026-02-22T10:00:00Z',
    };
    const transcriptStore = new MockTranscriptStore([meta]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });

    expect(bundle.transcripts).toHaveLength(1);
    const t = bundle.transcripts[0];
    expect(t.key).toBe(meta.key);
    expect(t.content).toBeUndefined();
  });

  test('falls back to key when download fails for small file', async () => {
    const meta: TranscriptMeta = {
      key: 'transcripts/decisive-gm/mac1/cursor/notes.txt',
      brain_id: 'decisive-gm',
      machine_id: 'mac1',
      cli: 'cursor',
      filename: 'notes.txt',
      size: 500,
      updated_at: '2026-02-22T10:00:00Z',
    };
    const transcriptStore = new MockTranscriptStore(
      [meta],
      {},
      new Error('storage unavailable'),
    );
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });

    expect(bundle.transcripts).toHaveLength(1);
    const t = bundle.transcripts[0];
    expect(t.key).toBe(meta.key);
    expect(t.content).toBeUndefined();
  });

  test(`caps transcripts at BUNDLE_TRANSCRIPT_LIMIT (${BUNDLE_TRANSCRIPT_LIMIT})`, async () => {
    // Use large size to avoid download path — this test is only about cap enforcement
    const metas: TranscriptMeta[] = Array.from({ length: BUNDLE_TRANSCRIPT_LIMIT + 5 }, (_, i) => ({
      key: `transcripts/decisive-gm/mac1/claude/session-${i}.jsonl`,
      brain_id: 'decisive-gm',
      machine_id: 'mac1',
      cli: 'claude' as const,
      filename: `session-${i}.jsonl`,
      size: TRANSCRIPT_INLINE_THRESHOLD + 1,
      updated_at: new Date(Date.UTC(2026, 1, i + 1)).toISOString(),
    }));
    const transcriptStore = new MockTranscriptStore(metas);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });
    expect(bundle.transcripts).toHaveLength(BUNDLE_TRANSCRIPT_LIMIT);
  });

  test('cap keeps the most-recent BUNDLE_TRANSCRIPT_LIMIT items, excludes oldest', async () => {
    // Create BUNDLE_TRANSCRIPT_LIMIT + 3 metas, each with a distinct updated_at.
    // The last 3 (oldest) should be excluded after sorting + capping.
    const total = BUNDLE_TRANSCRIPT_LIMIT + 3;
    const largeSize = TRANSCRIPT_INLINE_THRESHOLD + 1;
    const metas: TranscriptMeta[] = Array.from({ length: total }, (_, i) => ({
      key: `transcripts/decisive-gm/mac1/claude/file-${i}.jsonl`,
      brain_id: 'decisive-gm', machine_id: 'mac1', cli: 'claude' as const,
      filename: `file-${i}.jsonl`, size: largeSize,
      // i=0 is oldest, i=(total-1) is newest
      updated_at: new Date(Date.UTC(2026, 1, i + 1)).toISOString(),
    }));
    const transcriptStore = new MockTranscriptStore(metas);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });

    expect(bundle.transcripts).toHaveLength(BUNDLE_TRANSCRIPT_LIMIT);
    // Newest should be present
    const filenames = bundle.transcripts.map((t) => t.filename);
    expect(filenames).toContain(`file-${total - 1}.jsonl`); // newest
    expect(filenames).toContain(`file-${total - BUNDLE_TRANSCRIPT_LIMIT}.jsonl`); // 20th newest
    // Oldest 3 should be absent
    for (let i = 0; i < 3; i++) {
      expect(filenames).not.toContain(`file-${i}.jsonl`);
    }
  });

  test('transcripts are sorted most-recently-updated first', async () => {
    // Use large size so download is not called — this test is only about sort order
    const largeSize = TRANSCRIPT_INLINE_THRESHOLD + 1;
    const metas: TranscriptMeta[] = [
      {
        key: 'transcripts/decisive-gm/mac1/claude/old.jsonl',
        brain_id: 'decisive-gm', machine_id: 'mac1', cli: 'claude',
        filename: 'old.jsonl', size: largeSize,
        updated_at: '2026-02-01T00:00:00Z',
      },
      {
        key: 'transcripts/decisive-gm/mac1/claude/new.jsonl',
        brain_id: 'decisive-gm', machine_id: 'mac1', cli: 'claude',
        filename: 'new.jsonl', size: largeSize,
        updated_at: '2026-02-22T00:00:00Z',
      },
    ];
    const transcriptStore = new MockTranscriptStore(metas);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });

    expect(bundle.transcripts[0].filename).toBe('new.jsonl');
    expect(bundle.transcripts[1].filename).toBe('old.jsonl');
  });

  test('stale metadata: file exceeds threshold after download → key-only fallback', async () => {
    // Simulates: list() says size < threshold, but actual downloaded bytes exceed it (stale metadata).
    const meta: TranscriptMeta = {
      key: 'transcripts/decisive-gm/mac1/claude/stale.jsonl',
      brain_id: 'decisive-gm', machine_id: 'mac1', cli: 'claude',
      filename: 'stale.jsonl',
      size: 100, // listed as small
      updated_at: '2026-02-22T10:00:00Z',
    };
    // But the actual downloaded content is above threshold
    const oversizedContent = Buffer.alloc(TRANSCRIPT_INLINE_THRESHOLD);
    const transcriptStore = new MockTranscriptStore([meta], { [meta.key]: oversizedContent });
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });
    expect(bundle.transcripts[0].key).toBe(meta.key);
    expect(bundle.transcripts[0].content).toBeUndefined();
  });

  test('download error falls back to key-only (simulates timeout rejection)', async () => {
    // Simulates the timeout case by rejecting immediately — exercises the same catch
    // block as the real Promise.race timer. Real timers are avoided to keep tests fast.
    class TimeoutSimulatingStore implements TranscriptStoreAdapter {
      async list(_brainId: string): Promise<TranscriptMeta[]> {
        return [{
          key: 'transcripts/decisive-gm/mac1/claude/slow.jsonl',
          brain_id: 'decisive-gm', machine_id: 'mac1', cli: 'claude',
          filename: 'slow.jsonl', size: 10, updated_at: '2026-02-22T10:00:00Z',
        }];
      }
      async download(_key: string): Promise<Buffer> {
        throw new Error('download timeout'); // same error the real timer emits
      }
    }
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: new TimeoutSimulatingStore() },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });
    expect(bundle.transcripts).toHaveLength(1);
    expect(bundle.transcripts[0].key).toBe('transcripts/decisive-gm/mac1/claude/slow.jsonl');
    expect(bundle.transcripts[0].content).toBeUndefined();
  });

  test('transcripts empty when no transcriptStore injected', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });
    expect(bundle.transcripts).toEqual([]);
    expect(bundle.transcripts_error).toBe('no_transcript_store');
  });

  test('transcripts empty when include_transcripts=true and list returns no files', async () => {
    const transcriptStore = new MockTranscriptStore([]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: transcriptStore },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });
    expect(bundle.transcripts).toEqual([]);
    expect(bundle.transcripts_error).toBeUndefined();
  });

  test('transcripts empty (graceful fallback) when list() throws', async () => {
    class FailingTranscriptStore implements TranscriptStoreAdapter {
      async list(_brainId: string): Promise<TranscriptMeta[]> {
        throw new Error('storage unavailable');
      }
      async download(_key: string): Promise<Buffer> { return Buffer.alloc(0); }
    }
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { transcriptStore: new FailingTranscriptStore() },
    );
    // list() failure degrades gracefully — sort/Promise.all are NOT caught
    const bundle = await builder.build(SAMPLE_BRAIN, { include_transcripts: true });
    expect(bundle.transcripts).toEqual([]);
    expect(bundle.transcripts_error).toBe('fetch_failed');
  });
});

// ── MockBrainAssetStore ──────────────────────────────────────────────────────

class MockBrainAssetStore {
  public lastFilters: BrainAssetFilters | undefined;

  constructor(
    private assets: Array<{
      path: string;
      content: string;
      asset_type: AssetType;
      cli: AssetCli;
      size: number;
      synced_at: string;
      hash: string;
      _collection: string;
    }> = [],
  ) {}

  async pull(
    _brainId: string,
    filters: BrainAssetFilters = {},
  ): Promise<typeof this.assets> {
    this.lastFilters = filters;
    return this.assets.filter((asset) =>
      !filters.excludePathPrefixes?.some((prefix) => asset.path.startsWith(prefix)),
    );
  }
}

describe('BundleBuilder — include_brain_assets', () => {
  test('brain_assets is null by default (include_brain_assets not set)', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN);
    expect(bundle.brain_assets).toBeNull();
  });

  test('brain_assets is null when include_brain_assets=false', async () => {
    const assetStore = new MockBrainAssetStore([
      {
        path: '.claude/skills/my-skill/SKILL.md',
        content: '# My Skill',
        asset_type: 'skill',
        cli: 'claude',
        size: 10,
        synced_at: '2026-01-01T00:00:00Z',
        hash: 'abc123',
        _collection: 'brain_assets_decisive-gm',
      },
    ]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { brainAssetStore: assetStore as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_brain_assets: false });
    expect(bundle.brain_assets).toBeNull();
  });

  test('brain_assets returns assets when include_brain_assets=true', async () => {
    const assetStore = new MockBrainAssetStore([
      {
        path: '.claude/skills/my-skill/SKILL.md',
        content: '# My Skill',
        asset_type: 'skill',
        cli: 'claude',
        size: 10,
        synced_at: '2026-01-01T00:00:00Z',
        hash: 'abc123',
        _collection: 'brain_assets_decisive-gm',
      },
      {
        path: '.claude/agents/my-agent.md',
        content: '# My Agent',
        asset_type: 'agent',
        cli: 'claude',
        size: 10,
        synced_at: '2026-01-01T00:00:00Z',
        hash: 'def456',
        _collection: 'brain_assets_decisive-gm',
      },
    ]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { brainAssetStore: assetStore as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_brain_assets: true });
    expect(bundle.brain_assets).not.toBeNull();
    expect(bundle.brain_assets).toHaveLength(2);
    expect(assetStore.lastFilters?.excludePathPrefixes).toEqual(['brain-db-backup/']);
  });

  test('boot bundles always exclude secret assets', async () => {
    const assetStore = new MockBrainAssetStore([
      {
        path: '.env',
        content: Buffer.from('fixture-only').toString('base64'),
        asset_type: 'secret',
        cli: 'shared',
        size: 12,
        synced_at: '2026-01-01T00:00:00Z',
        hash: 'secret-fixture',
        _collection: 'brain_assets_decisive-gm',
      },
      {
        path: 'brain/config.json',
        content: 'e30=',
        asset_type: 'config',
        cli: 'shared',
        size: 2,
        synced_at: '2026-01-01T00:00:00Z',
        hash: 'config',
        _collection: 'brain_assets_decisive-gm',
      },
    ]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { brainAssetStore: assetStore as never },
    );

    const bundle = await builder.build(SAMPLE_BRAIN, { include_brain_assets: true });

    expect(bundle.brain_assets?.map((asset) => asset.path)).toEqual(['brain/config.json']);
  });

  test('no builder option can opt secret assets into a boot bundle', async () => {
    const assetStore = new MockBrainAssetStore([
      {
        path: '.env',
        content: Buffer.from('fixture-only').toString('base64'),
        asset_type: 'secret',
        cli: 'shared',
        size: 12,
        synced_at: '2026-01-01T00:00:00Z',
        hash: 'secret-fixture',
        _collection: 'brain_assets_decisive-gm',
      },
    ]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { brainAssetStore: assetStore as never },
    );

    const bundle = await builder.build(SAMPLE_BRAIN, {
      include_brain_assets: true,
      ...({ include_secret_assets: true } as Record<string, unknown>),
    } as never);

    expect(bundle.brain_assets).toEqual([]);
  });

  test('brain_assets excludes recovery-only brain.db backups from boot bundles', async () => {
    const assetStore = new MockBrainAssetStore([
      {
        path: 'brain-db-backup/decisive-gm/2026-07-19.db',
        content: 'YmFja3Vw',
        asset_type: 'config',
        cli: 'shared',
        size: 6,
        synced_at: '2026-07-19T00:00:00Z',
        hash: 'backup',
        _collection: 'brain_assets_decisive-gm',
      },
      {
        path: 'brain/config.json',
        content: 'e30=',
        asset_type: 'config',
        cli: 'shared',
        size: 2,
        synced_at: '2026-07-19T00:00:00Z',
        hash: 'config',
        _collection: 'brain_assets_decisive-gm',
      },
    ]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { brainAssetStore: assetStore as never },
    );

    const bundle = await builder.build(SAMPLE_BRAIN, { include_brain_assets: true });

    expect(bundle.brain_assets?.map((asset) => asset.path)).toEqual(['brain/config.json']);
  });

  test('brain_assets content is base64-encoded', async () => {
    const originalContent = '# My Skill\n\nSome content here.';
    // The store persists content as raw base64 (matching what the push route stores).
    const storedBase64 = Buffer.from(originalContent, 'utf8').toString('base64');
    const assetStore = new MockBrainAssetStore([
      {
        path: '.claude/skills/my-skill/SKILL.md',
        content: storedBase64,  // stored as raw base64 — not plain text
        asset_type: 'skill',
        cli: 'claude',
        size: originalContent.length,
        synced_at: '2026-01-01T00:00:00Z',
        hash: 'abc123',
        _collection: 'brain_assets_decisive-gm',
      },
    ]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { brainAssetStore: assetStore as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_brain_assets: true });
    expect(bundle.brain_assets).not.toBeNull();
    const asset = bundle.brain_assets![0];
    expect(typeof asset.content_base64).toBe('string');
    // content_base64 is returned as-is from storage — decode once to verify original content
    const decoded = Buffer.from(asset.content_base64, 'base64').toString('utf8');
    expect(decoded).toBe(originalContent);
  });

  test('brain_assets is null when no brainAssetStore injected and include_brain_assets=true', async () => {
    const builder = new BundleBuilder(new MockVaultClient() as never);
    const bundle = await builder.build(SAMPLE_BRAIN, { include_brain_assets: true });
    expect(bundle.brain_assets).toBeNull();
  });

  test('brain_assets includes asset_type and cli fields', async () => {
    const assetStore = new MockBrainAssetStore([
      {
        path: 'memory/MEMORY.md',
        content: '# Memory',
        asset_type: 'memory',
        cli: 'shared',
        size: 8,
        synced_at: '2026-01-01T00:00:00Z',
        hash: 'xyz789',
        _collection: 'brain_assets_decisive-gm',
      },
    ]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { brainAssetStore: assetStore as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_brain_assets: true });
    expect(bundle.brain_assets).not.toBeNull();
    const asset = bundle.brain_assets![0];
    expect(asset.asset_type).toBe('memory');
    expect(asset.cli).toBe('shared');
    expect(asset.path).toBe('memory/MEMORY.md');
  });

  test('brain_assets returns empty array when store has no assets', async () => {
    const assetStore = new MockBrainAssetStore([]);
    const builder = new BundleBuilder(
      new MockVaultClient() as never,
      { brainAssetStore: assetStore as never },
    );
    const bundle = await builder.build(SAMPLE_BRAIN, { include_brain_assets: true });
    expect(bundle.brain_assets).not.toBeNull();
    expect(bundle.brain_assets).toEqual([]);
  });
});
