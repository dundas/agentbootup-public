import { describe, expect, test } from 'bun:test';
import { handleSyncSkills } from '../routes/skills-sync';
import { HttpError, jsonError } from '../errors';
import type { Skill, SkillSummary } from '../types';
import { computeInlineBundleHash } from '../../../lib/bundle/installer.js';

async function call(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonError(err.status, err.code, err.message);
    }
    throw err;
  }
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/v1/skills/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

class MockSkillStore {
  constructor(private skills: Record<string, Skill>) {}

  async list(): Promise<SkillSummary[]> {
    return Object.values(this.skills).map(({ files: _files, ...summary }) => summary);
  }

  async get(id: string): Promise<Skill | null> {
    return this.skills[id] ?? null;
  }
}

class MockRegistryStore {
  constructor(private manifest: Record<string, unknown> | null) {}

  async getManifest(): Promise<Record<string, unknown> | null> {
    return this.manifest;
  }
}

function sampleSkill(id: string, files: Skill['files']): Skill {
  return {
    id,
    name: id,
    description: `${id} skill`,
    tags: [],
    files,
    file_count: files.length,
    created_at: '2026-06-05T00:00:00.000Z',
    updated_at: '2026-06-05T00:00:00.000Z',
  };
}

describe('handleSyncSkills', () => {
  test('explicit skill sync returns projected files plus bundle manifest', async () => {
    const skillStore = new MockSkillStore({
      alpha: sampleSkill('alpha', [
        { path: 'SKILL.md', content: '# alpha\n' },
        { path: 'references/guide.md', content: 'guide\n' },
        {
          path: 'skill-bundle-manifest.json',
          content: JSON.stringify({
            bundle_version: '1.2.3',
            bundle_hash: 'sha256:stalehash',
            dependencies: { '@agentdispatch/cli': '^0.2.0' },
            distribution: { mode: 'self_apply' },
            validation: { commands: ['echo ok'] },
          }),
        },
      ]),
    });
    const registryStore = new MockRegistryStore(null);

    const res = await call(() =>
      handleSyncSkills(
        makeRequest({
          targetRepoPath: '/tmp/project',
          targetAgentId: 'brain-one',
          skills: ['alpha'],
          options: { clis: ['claude'] },
        }),
        skillStore as never,
        registryStore as never,
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        synced: Array<{
          id: string;
          files: Record<string, string>;
          bundle_manifest: {
            bundle_name: string;
            bundle_hash: string;
            install: { state_file: string };
            validation: { commands: string[] };
            files: Array<{ source: string; target: string; kind: string; role: string; required: boolean }>;
          };
          self_manifest_source?: string;
        }>;
        skipped: Array<{ id: string; reason: string }>;
      };
    };
    expect(body.data.synced).toHaveLength(1);
    expect(body.data.skipped).toHaveLength(0);
    expect(body.data.synced[0]?.files['.claude/skills/alpha/SKILL.md']).toBe('# alpha\n');
    expect(body.data.synced[0]?.bundle_manifest.bundle_name).toBe('alpha');
    expect(body.data.synced[0]?.bundle_manifest.bundle_hash).not.toBe('sha256:stalehash');
    expect(body.data.synced[0]?.bundle_manifest.install.state_file).toBe('skills/state/alpha.json');
    expect(body.data.synced[0]?.bundle_manifest.validation.commands).toEqual([]);
    expect(body.data.synced[0]?.bundle_manifest.dependencies).toEqual({});
    expect(body.data.synced[0]?.self_manifest_source).toBe('.claude/skills/alpha/skill-bundle-manifest.json');
    expect(body.data.synced[0]?.files['.claude/skills/alpha/skill-bundle-manifest.json'])
      .toContain(body.data.synced[0]?.bundle_manifest.bundle_hash);
    const generated = body.data.synced[0]!;
    expect(computeInlineBundleHash(
      generated.bundle_manifest.files.map((entry) => ({ ...entry, content: generated.files[entry.source] })),
      { bundleType: 'skill_bundle', selfManifestSources: [generated.self_manifest_source!] },
    )).toBe(generated.bundle_manifest.bundle_hash);
    const manifestSources = body.data.synced[0]?.bundle_manifest.files.map((entry: { source: string }) => entry.source) ?? [];
    for (const source of manifestSources) {
      expect(typeof body.data.synced[0]?.files[source]).toBe('string');
    }
  });

  test('top-level embedded manifests are sealed identically across every requested CLI mirror', async () => {
    const staleEmbeddedManifest = JSON.stringify({
      bundle_version: '4.2.0',
      version_id: 'alpha@4.2.0+sha256_stale',
      bundle_hash: 'sha256:stale',
      validation: { commands: ['never execute this'] },
    });
    const skillStore = new MockSkillStore({
      alpha: sampleSkill('alpha', [
        { path: 'SKILL.md', content: '# alpha\n' },
        { path: 'skill-bundle-manifest.json', content: staleEmbeddedManifest },
      ]),
    });
    const res = await call(() => handleSyncSkills(
      makeRequest({
        targetRepoPath: '/tmp/project',
        targetAgentId: 'brain-one',
        skills: ['alpha'],
        options: {
          clis: ['claude', 'codex'],
          capabilities: ['plural_self_manifest_sources'],
        },
      }),
      skillStore as never,
      new MockRegistryStore(null) as never,
    ));

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { synced: Array<{
      files: Record<string, string>;
      self_manifest_source?: string;
      self_manifest_sources?: string[];
      bundle_manifest: {
        bundle_hash: string;
        files: Array<{ source: string; target: string; kind: string; role: string; required: boolean }>;
      };
    }> } };
    const synced = body.data.synced[0]!;
    const mirrors = [
      '.claude/skills/alpha/skill-bundle-manifest.json',
      '.codex/skills/alpha/skill-bundle-manifest.json',
    ];

    // The compatibility field retains the first path, while the plural field
    // is the authoritative recursive provenance set for all emitted mirrors.
    expect(synced.self_manifest_source).toBe(mirrors[0]);
    expect(synced.self_manifest_sources).toEqual(mirrors);
    for (const mirror of mirrors) {
      expect(synced.files[mirror]).toBe(JSON.stringify(synced.bundle_manifest));
      expect(synced.bundle_manifest.files).toContainEqual(expect.objectContaining({ source: mirror, target: mirror }));
    }
    expect(synced.files[mirrors[0]]).not.toBe(staleEmbeddedManifest);
    expect(computeInlineBundleHash(
      synced.bundle_manifest.files.map((entry) => ({ ...entry, content: synced.files[entry.source] })),
      { bundleType: 'skill_bundle', selfManifestSources: synced.self_manifest_sources! },
    )).toBe(synced.bundle_manifest.bundle_hash);
  });

  test('top-level multi-CLI manifests retain the legacy one-self-source shape without capability', async () => {
    const staleEmbeddedManifest = JSON.stringify({
      bundle_version: '4.2.0',
      version_id: 'alpha@4.2.0+sha256_stale',
      bundle_hash: 'sha256:stale',
    });
    const skillStore = new MockSkillStore({
      alpha: sampleSkill('alpha', [
        { path: 'SKILL.md', content: '# alpha\n' },
        { path: 'skill-bundle-manifest.json', content: staleEmbeddedManifest },
      ]),
    });
    const res = await call(() => handleSyncSkills(
      makeRequest({
        targetRepoPath: '/tmp/project',
        targetAgentId: 'brain-one',
        skills: ['alpha'],
        // Deliberately no capabilities: this models an older client.
        options: { clis: ['claude', 'codex'] },
      }),
      skillStore as never,
      new MockRegistryStore(null) as never,
    ));

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { synced: Array<{
      files: Record<string, string>;
      self_manifest_source?: string;
      self_manifest_sources?: string[];
      bundle_manifest: { bundle_hash: string; files: Array<{ source: string; target: string }> };
    }> } };
    const synced = body.data.synced[0]!;
    const canonical = '.claude/skills/alpha/skill-bundle-manifest.json';
    const legacyMirror = '.codex/skills/alpha/skill-bundle-manifest.json';
    expect(synced.self_manifest_source).toBe(canonical);
    expect(synced.self_manifest_sources).toBeUndefined();
    expect(synced.files[canonical]).not.toBe(staleEmbeddedManifest);
    expect(synced.files[legacyMirror]).toBe(staleEmbeddedManifest);
    expect(computeInlineBundleHash(
      synced.bundle_manifest.files.map((entry) => ({ ...entry, content: synced.files[entry.source] })),
      { bundleType: 'skill_bundle', selfManifestSources: [canonical] },
    )).toBe(synced.bundle_manifest.bundle_hash);
  });

  test('uses an exact already-nested authored manifest as self provenance while leaving an earlier fixture raw', async () => {
    const fixture = JSON.stringify({
      bundle_version: 'fixture-version',
      bundle_hash: 'sha256:fixture-hash',
      validation: { commands: ['fixture command is data'] },
      dependencies: { 'fixture-package': '^1.0.0' },
    });
    const authored = JSON.stringify({
      bundle_version: '2.4.0',
      bundle_hash: 'sha256:stale-authored-hash',
      validation: { commands: ['this command must be stripped'] },
      dependencies: { 'hosted-package': '^9.0.0' },
      distribution: { mode: 'direct_sync' },
    });
    const selfSource = '.claude/skills/nested-alpha/skill-bundle-manifest.json';
    const skillStore = new MockSkillStore({
      'nested-alpha': sampleSkill('nested-alpha', [
        // Deliberately first and valid JSON: it must stay ordinary payload.
        { path: 'fixtures/skill-bundle-manifest.json', content: fixture },
        { path: selfSource, content: authored },
        { path: '.claude/skills/nested-alpha/SKILL.md', content: '# nested alpha\n' },
      ]),
    });
    const res = await call(() => handleSyncSkills(
      makeRequest({
        targetRepoPath: '/tmp/project',
        targetAgentId: 'brain-one',
        skills: ['nested-alpha'],
        options: { clis: ['claude'] },
      }),
      skillStore as never,
      new MockRegistryStore(null) as never,
    ));

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { synced: Array<{
      files: Record<string, string>;
      self_manifest_source?: string;
      bundle_manifest: {
        bundle_hash: string;
        bundle_version: string;
        distribution: { mode: string };
        validation: { commands: string[] };
        dependencies: Record<string, string>;
        files: Array<{ source: string; target: string }>;
      };
    }> } };
    const synced = body.data.synced[0]!;

    // The emitted identity is an exact source path and its matching entry has
    // the same target; remote-sync receives no opportunity to infer either.
    expect(synced.self_manifest_source).toBe(selfSource);
    expect(synced.bundle_manifest.files.find((file) => file.source === selfSource)).toMatchObject({
      source: selfSource,
      target: selfSource,
      kind: 'skill',
      role: 'reference',
      required: false,
    });
    expect(synced.bundle_manifest.bundle_version).toBe('2.4.0');
    expect(synced.bundle_manifest.distribution.mode).toBe('direct_sync');
    expect(synced.bundle_manifest.validation.commands).toEqual([]);
    expect(synced.bundle_manifest.dependencies).toEqual({});
    expect(synced.files['.claude/skills/nested-alpha/fixtures/skill-bundle-manifest.json']).toBe(fixture);
    expect(JSON.parse(synced.files[selfSource]!)).toEqual(synced.bundle_manifest);
    expect(computeInlineBundleHash(
      synced.bundle_manifest.files.map((entry) => ({ ...entry, content: synced.files[entry.source] })),
      { bundleType: 'skill_bundle', selfManifestSources: [selfSource] },
    )).toBe(synced.bundle_manifest.bundle_hash);
  });

  test('hosted sync strips dependency declarations for direct-sync payloads too', async () => {
    const skillStore = new MockSkillStore({
      alpha: sampleSkill('alpha', [
        { path: 'SKILL.md', content: '# alpha\n' },
        {
          path: 'skill-bundle-manifest.json',
          content: JSON.stringify({
            bundle_version: '1.2.3',
            dependencies: { '@agentdispatch/cli': '^0.2.0' },
            distribution: { mode: 'direct_sync' },
          }),
        },
      ]),
    });
    const registryStore = new MockRegistryStore(null);

    const res = await call(() =>
      handleSyncSkills(
        makeRequest({
          targetRepoPath: '/tmp/project',
          targetAgentId: 'brain-one',
          skills: ['alpha'],
          options: { clis: ['claude'] },
        }),
        skillStore as never,
        registryStore as never,
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        synced: Array<{
          bundle_manifest: {
            distribution: { mode: string };
            dependencies?: Record<string, string>;
          };
        }>;
      };
    };
    expect(body.data.synced[0]?.bundle_manifest.distribution.mode).toBe('direct_sync');
    expect(body.data.synced[0]?.bundle_manifest.dependencies).toEqual({});
  });

  test('all-core uses published manifest and skips out-of-scope target restrictions', async () => {
    const skillStore = new MockSkillStore({
      alpha: sampleSkill('alpha', [{ path: 'SKILL.md', content: '# alpha\n' }]),
      beta: sampleSkill('beta', [{ path: 'SKILL.md', content: '# beta\n' }]),
    });
    const registryStore = new MockRegistryStore({
      skills: {
        alpha: { sync: 'core' },
        beta: { sync: 'core', target_agents: ['other-brain'] },
      },
    });

    const res = await call(() =>
      handleSyncSkills(
        makeRequest({
          targetRepoPath: '/tmp/project',
          targetAgentId: 'brain-one',
          skills: 'all-core',
          options: { clis: ['claude'] },
        }),
        skillStore as never,
        registryStore as never,
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        synced: Array<{ id: string }>;
        skipped: Array<{ id: string; reason: string }>;
      };
    };
    expect(body.data.synced.map((item) => item.id)).toEqual(['alpha']);
    expect(body.data.skipped).toEqual([{ id: 'beta', reason: 'out-of-scope' }]);
  });

  test('explicit missing skill ids return 422', async () => {
    const skillStore = new MockSkillStore({
      alpha: sampleSkill('alpha', [{ path: 'SKILL.md', content: '# alpha\n' }]),
    });
    const registryStore = new MockRegistryStore(null);

    const res = await call(() =>
      handleSyncSkills(
        makeRequest({
          targetRepoPath: '/tmp/project',
          targetAgentId: 'brain-one',
          skills: ['alpha', 'missing'],
        }),
        skillStore as never,
        registryStore as never,
      ),
    );

    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SKILL_NOT_FOUND');
    expect(body.error.message).toContain('missing');
  });
});
