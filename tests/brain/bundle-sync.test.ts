import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readFile } from 'fs/promises';
import { createClient } from '@libsql/client';
import { runBundleCommand } from '../../lib/bundle/cli.js';
import { requestHostedBundleSync } from '../../lib/bundle/remote-sync.js';
import { computeInlineBundleHash } from '../../lib/bundle/installer.js';
import { computeCanonicalBundleHash } from '../../lib/bundle/bundle-hash-contract.js';
import { handleSyncSkills } from '../../src/server/routes/skills-sync.ts';

// templates/brain/ is the tracked, canonical schema; brain/ is a gitignored runtime
// copy that only exists on a machine where the brain has been provisioned. Reading
// the runtime copy made this test unrunnable on a clean checkout. Every sibling
// (skills-cli, skill-index, schema-migration) already reads the template.
const SCHEMA_PATH = path.resolve(import.meta.dir, '../../templates/brain/brain-schema.sql');
const originalHome = process.env.AGENTBOOTUP_HOME;
let tmpRoots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
    out: () => out.join('\n'),
    err: () => err.join('\n'),
  };
}

function buildSkillBundleManifest(bundleName: string, files: Record<string, string>) {
  const fileEntries = Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, content]) => ({
      source: target,
      target,
      content,
      kind: target.startsWith('brain/scripts/') ? 'repo' : 'skill',
      required: target.endsWith('/SKILL.md') || target.startsWith('brain/scripts/'),
      role: target.endsWith('/SKILL.md')
        ? 'entrypoint'
        : target.startsWith('brain/scripts/')
          ? 'runtime'
          : 'reference',
    }));
  const bundleHash = computeInlineBundleHash(fileEntries, { bundleType: 'skill_bundle' });
  return {
    bundle_type: 'skill_bundle',
    bundle_name: bundleName,
    bundle_version: '1.0.0',
    version_id: `${bundleName}@1.0.0+sha256_${bundleHash.replace('sha256:', '').slice(0, 8)}`,
    bundle_hash: bundleHash,
    source: { repo: 'test-server', generated_at: '2026-06-05T00:00:00.000Z' },
    distribution: { mode: 'self_apply' },
    install: {
      state_file: `skills/state/${bundleName}.json`,
      backup_root: `skills/${bundleName}`,
    },
    validation: { commands: [] },
    mutations: [],
    files: fileEntries.map(({ content: _content, ...entry }) => entry),
  };
}

function withRecomputedHash(
  manifest: ReturnType<typeof buildSkillBundleManifest>,
  files: Record<string, string>,
) {
  const bundleHash = computeInlineBundleHash(
    Object.entries(files).map(([target, content]) => ({
      source: target,
      target,
      content,
      kind: target.startsWith('brain/scripts/') ? 'repo' : 'skill',
      required: target.endsWith('/SKILL.md') || target.startsWith('brain/scripts/'),
      role: target.endsWith('/SKILL.md')
        ? 'entrypoint'
        : target.startsWith('brain/scripts/')
          ? 'runtime'
          : 'reference',
    })),
    {
      bundleType: 'skill_bundle',
      mutations: manifest.mutations,
      validationCommands: manifest.validation.commands,
    },
  );
  manifest.bundle_hash = bundleHash;
  manifest.version_id = `${manifest.bundle_name}@${manifest.bundle_version}+sha256_${bundleHash.replace('sha256:', '').slice(0, 8)}`;
  return manifest;
}

async function seedBrainDb(root: string) {
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  const dbPath = path.join(root, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  await db.executeMultiple(await readFile(SCHEMA_PATH, 'utf8'));
  await db.close();
}

async function countIndexedSkills(root: string): Promise<number> {
  const db = createClient({ url: `file:${path.join(root, '.brain', 'brain.db')}` });
  try {
    const result = await db.execute('SELECT COUNT(*) AS c FROM skills');
    return Number(result.rows?.[0]?.c ?? 0);
  } finally {
    await db.close();
  }
}

afterEach(() => {
  process.env.AGENTBOOTUP_HOME = originalHome;
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hosted sync request advertises plural self-manifest provenance capability', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: { synced: [], skipped: [] } }), { status: 200 });
  }) as typeof fetch;
  try {
    await requestHostedBundleSync({
      serverUrl: 'https://example.test',
      apiKey: 'test',
      targetRepoPath: '/tmp/project',
      targetAgentId: 'brain-sync',
      selector: 'demo',
      clis: ['claude', 'codex'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect((requestBody?.options as { capabilities?: string[] }).capabilities)
    .toContain('plural_self_manifest_sources');
});

test('bundle sync installs hosted planned bundles and reindexes once', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-target-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );
  await seedBrainDb(targetRoot);

  const files = {
    '.claude/skills/demo/SKILL.md': '# demo\n',
  };
  const manifest = buildSkillBundleManifest('demo', files);
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'demo', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [{ id: 'demo', name: 'demo', files, bundle_manifest: manifest }],
        skipped: [],
      }),
    },
  );

  expect(code).toBe(0);
  expect(fs.readFileSync(path.join(targetRoot, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('# demo\n');
  expect(fs.existsSync(path.join(home, 'brains', 'brain-sync', 'installed', 'skills', 'state', 'demo.json'))).toBe(true);
  expect(await countIndexedSkills(targetRoot)).toBeGreaterThanOrEqual(1);
  expect(cap.out()).toContain('Sync complete');
});

test('bundle sync honors explicit nested self-manifest provenance and keeps preceding manifest fixtures raw', async () => {
  // Hosted payloads are reconstructed under a temporary source root. The
  // publisher supplies the self path explicitly; the client must not infer it
  // from filename, position, or JSON shape. This valid fixture deliberately
  // precedes the actual self source in the input map.
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-nested-self-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );

  const selfSource = '.claude/skills/nested-demo/skill-bundle-manifest.json';
  const fixtureSource = 'fixtures/skill-bundle-manifest.json';
  const files = {
    [fixtureSource]: JSON.stringify({ version_id: 'fixture@one', bundle_hash: 'sha256:fixture', fixture: true }),
    '.claude/skills/nested-demo/SKILL.md': '# nested demo\n',
    [selfSource]: '',
  };
  const manifest = buildSkillBundleManifest('nested-demo', files);
  manifest.files.find((entry) => entry.source === fixtureSource).kind = 'skill';
  manifest.files.find((entry) => entry.source === fixtureSource).target =
    '.claude/skills/nested-demo/fixtures/skill-bundle-manifest.json';
  manifest.validation = { commands: ['echo hosted validation must not run'] };
  manifest.dependencies = { 'hosted-only-package': '^1.0.0' };
  manifest.bundle_hash = computeCanonicalBundleHash(manifest.files, {
    bundleType: manifest.bundle_type,
    readFile: (entry) => entry.source === selfSource ? JSON.stringify(manifest) : files[entry.source],
    selfManifestSources: [selfSource],
    validationCommands: manifest.validation.commands,
    dependencies: manifest.dependencies,
  });
  manifest.version_id = `nested-demo@1.0.0+sha256_${manifest.bundle_hash.slice('sha256:'.length, 'sha256:'.length + 8)}`;
  files[selfSource] = JSON.stringify(manifest);
  const publishedFiles = { ...files };
  const cap = captureIo();

  const deps = {
    credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
    requestSyncFn: async () => ({
      targetRepoPath: targetRoot,
      targetAgentId: 'brain-sync',
      dryRun: false,
      synced: [{ id: 'nested-demo', name: 'nested-demo', files: { ...publishedFiles }, bundle_manifest: manifest, self_manifest_source: selfSource }],
      skipped: [],
    }),
  };
  const code = await runBundleCommand(
    ['sync', 'nested-demo', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    deps,
  );

  expect(code).toBe(0);
  expect(fs.readFileSync(path.join(targetRoot, selfSource), 'utf8')).not.toBe(publishedFiles[selfSource]);
  expect(fs.readFileSync(path.join(targetRoot, '.claude/skills/nested-demo/fixtures/skill-bundle-manifest.json'), 'utf8'))
    .toBe(publishedFiles[fixtureSource]);
  const state = JSON.parse(fs.readFileSync(
    path.join(home, 'brains', 'brain-sync', 'installed', 'skills', 'state', 'nested-demo.json'),
    'utf8',
  ));
  expect(state.status).toBe('applied');
  // The hosted boundary strips commands/dependencies, then reseals the exact
  // effective self payload rather than retaining the publisher's unsafe hash.
  const installedSelf = JSON.parse(fs.readFileSync(path.join(targetRoot, selfSource), 'utf8'));
  expect(state.bundle_hash).toBe(installedSelf.bundle_hash);
  expect(state.bundle_hash).not.toBe(manifest.bundle_hash);
  expect(installedSelf.validation.commands).toEqual([]);
  expect(installedSelf.dependencies).toEqual({});
  expect(cap.out()).toContain('Sync complete');

  // A second sync is a publish-like installed-payload hash check. If the nested
  // self source had not propagated into installBundle, this would report drift
  // and require a repair rather than producing the normal no-op result.
  const secondCap = captureIo();
  expect(await runBundleCommand(
    ['sync', 'nested-demo', '--target-root', targetRoot, '--cwd', targetRoot],
    secondCap.io,
    deps,
  )).toBe(0);
  expect(secondCap.out()).toContain('= nested-demo');

  // Absent/untrusted provenance is deliberately not repaired by filename or
  // structural inference; the recursive payload is therefore hash-invalid and
  // cannot be installed under a false identity claim.
  const untrustedRoot = tempDir('ab-bundle-sync-untrusted-self-');
  fs.writeFileSync(path.join(untrustedRoot, 'agentbootup.json'), JSON.stringify({ version: '2.0', agent_id: 'brain-untrusted' }));
  const noProvenanceDeps = {
    ...deps,
    requestSyncFn: async () => ({
      targetRepoPath: untrustedRoot,
      targetAgentId: 'brain-untrusted',
      dryRun: false,
      synced: [{ id: 'nested-demo', name: 'nested-demo', files: { ...publishedFiles }, bundle_manifest: manifest, self_manifest_source: '../outside' }],
      skipped: [],
    }),
  };
  const noProvenanceCap = captureIo();
  expect(await runBundleCommand(
    ['sync', 'nested-demo', '--target-root', untrustedRoot, '--cwd', untrustedRoot],
    noProvenanceCap.io,
    noProvenanceDeps,
  )).toBe(1);
  expect(noProvenanceCap.err()).toContain('invalid self manifest source');
});

test('independent server sync responses are stable and the second hosted sync is a no-op', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-server-stable-sync-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-server-stable' }, null, 2) + '\n',
    'utf8',
  );
  const id = 'server-stable';
  const selfSource = `.claude/skills/${id}/skill-bundle-manifest.json`;
  const skill = {
    id,
    name: id,
    description: 'stable server payload',
    tags: [],
    files: [
      { path: '.claude/skills/server-stable/SKILL.md', content: '# server stable\n' },
      {
        path: selfSource,
        content: JSON.stringify({
          bundle_version: '3.1.0',
          validation: { commands: ['must never reach hosted install'] },
          dependencies: { 'must-not-install': '^1.0.0' },
        }),
      },
    ],
    file_count: 2,
    created_at: '2026-06-05T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:00.000Z',
  };
  const requestPayload = {
    targetRepoPath: targetRoot,
    targetAgentId: 'brain-server-stable',
    skills: [id],
    options: { clis: ['claude'] },
  };
  const makeServerResponse = async () => {
    const response = await handleSyncSkills(
      new Request('http://localhost/v1/skills/sync', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestPayload),
      }),
      {
        list: async () => {
          const { files: _files, ...summary } = skill;
          return [summary];
        },
        get: async (requestedId: string) => requestedId === id ? skill : null,
      } as never,
      { getManifest: async () => null } as never,
    );
    expect(response.status).toBe(200);
    return (await response.json() as { data: { synced: Array<{
      files: Record<string, string>;
      self_manifest_source?: string;
      bundle_manifest: { bundle_hash: string; source: Record<string, unknown> };
    }> } }).data;
  };

  const first = await makeServerResponse();
  const second = await makeServerResponse();
  const firstBundle = first.synced[0]!;
  const secondBundle = second.synced[0]!;
  expect(firstBundle.self_manifest_source).toBe(selfSource);
  expect(secondBundle.self_manifest_source).toBe(selfSource);
  expect(secondBundle.bundle_manifest.bundle_hash).toBe(firstBundle.bundle_manifest.bundle_hash);
  expect(secondBundle.files[selfSource]).toBe(firstBundle.files[selfSource]);
  expect(firstBundle.bundle_manifest.source.generated_at).toBeUndefined();

  let calls = 0;
  const deps = {
    credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
    requestSyncFn: async () => {
      const data = calls++ === 0 ? first : second;
      return { ...data, targetRepoPath: targetRoot, targetAgentId: 'brain-server-stable', dryRun: false };
    },
  };
  const firstCap = captureIo();
  expect(await runBundleCommand(
    ['sync', id, '--target-root', targetRoot, '--cwd', targetRoot], firstCap.io, deps,
  )).toBe(0);
  const secondCap = captureIo();
  expect(await runBundleCommand(
    ['sync', id, '--target-root', targetRoot, '--cwd', targetRoot], secondCap.io, deps,
  )).toBe(0);
  expect(secondCap.out()).toContain(`= ${id}`);

});

test('bundle sync preserves all top-level self-manifest mirrors returned by hosted sync', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-hosted-multicli-self-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-hosted-multicli' }, null, 2) + '\n',
    'utf8',
  );
  const id = 'hosted-multicli';
  const skill = {
    id,
    name: id,
    description: 'top-level manifest mirrors',
    tags: [],
    files: [
      { path: 'SKILL.md', content: '# hosted multicli\n' },
      { path: 'skill-bundle-manifest.json', content: JSON.stringify({
        bundle_version: '1.0.0', bundle_hash: 'sha256:stale', version_id: `${id}@1.0.0+sha256_stale`,
      }) },
    ],
    file_count: 2,
    created_at: '2026-06-05T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:00.000Z',
  };
  const response = await handleSyncSkills(
    new Request('http://localhost/v1/skills/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-hosted-multicli',
        skills: [id],
        options: { clis: ['claude', 'codex'], capabilities: ['plural_self_manifest_sources'] },
      }),
    }),
    {
      list: async () => {
        const { files: _files, ...summary } = skill;
        return [summary];
      },
      get: async (requestedId: string) => requestedId === id ? skill : null,
    } as never,
    { getManifest: async () => null } as never,
  );
  expect(response.status).toBe(200);
  const data = (await response.json() as { data: { synced: Array<{
    files: Record<string, string>;
    bundle_manifest: { bundle_hash: string };
    self_manifest_sources: string[];
  }> } }).data;
  const hosted = data.synced[0]!;
  const mirrors = [
    `.claude/skills/${id}/skill-bundle-manifest.json`,
    `.codex/skills/${id}/skill-bundle-manifest.json`,
  ];
  expect(hosted.self_manifest_sources).toEqual(mirrors);

  const deps = {
    credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
    requestSyncFn: async () => ({
      targetRepoPath: targetRoot,
      targetAgentId: 'brain-hosted-multicli',
      dryRun: false,
      synced: [hosted],
      skipped: [],
    }),
  };
  const firstCap = captureIo();
  expect(await runBundleCommand(
    ['sync', id, '--target-root', targetRoot, '--cwd', targetRoot], firstCap.io, deps,
  )).toBe(0);
  const installed = [
    fs.readFileSync(path.join(targetRoot, '.claude', 'skills', id, 'skill-bundle-manifest.json'), 'utf8'),
    fs.readFileSync(path.join(targetRoot, '.codex', 'skills', id, 'skill-bundle-manifest.json'), 'utf8'),
  ];
  expect(installed[0]).toBe(installed[1]);
  expect(JSON.parse(installed[0]!).bundle_hash).toBe(hosted.bundle_manifest.bundle_hash);

  const secondCap = captureIo();
  expect(await runBundleCommand(
    ['sync', id, '--target-root', targetRoot, '--cwd', targetRoot], secondCap.io, deps,
  )).toBe(0);
  expect(secondCap.out()).toContain(`= ${id}`);

  // The plural declaration is authoritative: a legacy field that disagrees,
  // or duplicate entries that would conceal identity drift, is rejected before
  // any hosted payload can be installed.
  for (const invalidProvenance of [
    { ...hosted, self_manifest_source: mirrors[1] },
    { ...hosted, self_manifest_sources: [mirrors[0]!, mirrors[0]!] },
  ]) {
    const invalidCap = captureIo();
    expect(await runBundleCommand(
      ['sync', id, '--target-root', targetRoot, '--cwd', targetRoot], invalidCap.io,
      {
        ...deps,
        requestSyncFn: async () => ({
          targetRepoPath: targetRoot,
          targetAgentId: 'brain-hosted-multicli',
          dryRun: false,
          synced: [invalidProvenance],
          skipped: [],
        }),
      },
    )).toBe(1);
    expect(invalidCap.err()).toContain('invalid self manifest source provenance');
  }
});

test('bundle sync accepts a legacy single-source multi-CLI hosted response without hash drift', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-hosted-legacy-multicli-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-hosted-legacy' }, null, 2) + '\n',
    'utf8',
  );
  const id = 'hosted-legacy';
  const stale = JSON.stringify({ bundle_version: '1.0.0', bundle_hash: 'sha256:stale' });
  const skill = {
    id, name: id, description: 'legacy payload', tags: [],
    files: [
      { path: 'SKILL.md', content: '# legacy\n' },
      { path: 'skill-bundle-manifest.json', content: stale },
    ],
    file_count: 2,
    created_at: '2026-06-05T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:00.000Z',
  };
  const response = await handleSyncSkills(
    new Request('http://localhost/v1/skills/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-hosted-legacy',
        skills: [id],
        options: { clis: ['claude', 'codex'] },
      }),
    }),
    {
      list: async () => {
        const { files: _files, ...summary } = skill;
        return [summary];
      },
      get: async (requestedId: string) => requestedId === id ? skill : null,
    } as never,
    { getManifest: async () => null } as never,
  );
  expect(response.status).toBe(200);
  const data = (await response.json() as { data: { synced: Array<{
    files: Record<string, string>;
    self_manifest_source: string;
    self_manifest_sources?: string[];
  }> } }).data;
  const hosted = data.synced[0]!;
  expect(hosted.self_manifest_sources).toBeUndefined();
  expect(hosted.files[`.codex/skills/${id}/skill-bundle-manifest.json`]).toBe(stale);

  const deps = {
    credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
    requestSyncFn: async () => ({
      targetRepoPath: targetRoot, targetAgentId: 'brain-hosted-legacy', dryRun: false, synced: [hosted], skipped: [],
    }),
  };
  expect(await runBundleCommand(
    ['sync', id, '--target-root', targetRoot, '--cwd', targetRoot], captureIo().io, deps,
  )).toBe(0);
  expect(fs.readFileSync(path.join(targetRoot, '.codex', 'skills', id, 'skill-bundle-manifest.json'), 'utf8')).toBe(stale);
  const secondCap = captureIo();
  expect(await runBundleCommand(
    ['sync', id, '--target-root', targetRoot, '--cwd', targetRoot], secondCap.io, deps,
  )).toBe(0);
  expect(secondCap.out()).toContain(`= ${id}`);
});

test('bundle sync rejects a hosted manifest with a malformed (non-object) validation', async () => {
  // Regression: the hosted-install path strips validation.commands, but must NOT silently
  // objectify a malformed `validation` (e.g. a string) via spread — the schema guard has
  // to reject it (roborev). Preserving the malformed type is what lets the gate fire.
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-badval-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );
  await seedBrainDb(targetRoot);

  const files = { '.claude/skills/demo/SKILL.md': '# demo\n' };
  const manifest = { ...buildSkillBundleManifest('demo', files), validation: 'not-an-object' };
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'demo', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [{ id: 'demo', name: 'demo', files, bundle_manifest: manifest }],
        skipped: [],
      }),
    },
  );

  expect(code).not.toBe(0);
  expect(cap.err()).toContain('validation must be an object');
  expect(fs.existsSync(path.join(targetRoot, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(false);
});

test('bundle sync reports noop when the same bundle is already installed', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-noop-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );

  const files = {
    '.claude/skills/demo/SKILL.md': '# demo\n',
  };
  const manifest = buildSkillBundleManifest('demo', files);
  const deps = {
    credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
    requestSyncFn: async () => ({
      targetRepoPath: targetRoot,
      targetAgentId: 'brain-sync',
      dryRun: false,
      synced: [{ id: 'demo', name: 'demo', files, bundle_manifest: manifest }],
      skipped: [],
    }),
  };

  let cap = captureIo();
  let code = await runBundleCommand(['sync', 'demo', '--target-root', targetRoot, '--cwd', targetRoot], cap.io, deps);
  expect(code).toBe(0);

  cap = captureIo();
  code = await runBundleCommand(['sync', 'demo', '--target-root', targetRoot, '--cwd', targetRoot], cap.io, deps);
  expect(code).toBe(0);
  expect(cap.out()).toContain('= demo');
});

test('bundle sync rejects an explicit empty hosted self-manifest source before writing files', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-empty-self-source-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-empty-self' }, null, 2) + '\n',
    'utf8',
  );
  const files = { '.claude/skills/demo/SKILL.md': '# demo\n' };
  const cap = captureIo();

  expect(await runBundleCommand(
    ['sync', 'demo', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-empty-self',
        dryRun: false,
        synced: [{
          id: 'demo',
          name: 'demo',
          files,
          bundle_manifest: buildSkillBundleManifest('demo', files),
          self_manifest_source: '',
        }],
        skipped: [],
      }),
    },
  )).toBe(1);
  expect(cap.err()).toContain('invalid self manifest source provenance');
  expect(fs.existsSync(path.join(targetRoot, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(false);
});

test('bundle sync rejects conflicting overlapping target paths before install', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-conflict-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );

  const firstFiles = { '.claude/skills/shared/SKILL.md': '# one\n' };
  const secondFiles = { '.claude/skills/shared/SKILL.md': '# two\n' };
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'alpha,beta', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [
          { id: 'alpha', name: 'alpha', files: firstFiles, bundle_manifest: buildSkillBundleManifest('alpha', firstFiles) },
          { id: 'beta', name: 'beta', files: secondFiles, bundle_manifest: buildSkillBundleManifest('beta', secondFiles) },
        ],
        skipped: [],
      }),
    },
  );

  expect(code).toBe(1);
  expect(cap.err()).toContain('conflict');
  expect(fs.existsSync(path.join(targetRoot, '.claude', 'skills', 'shared', 'SKILL.md'))).toBe(false);
});

test('bundle sync allows identical overlapping target file content', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-identical-file-overlap-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );

  const firstFiles = { '.claude/skills/shared/SKILL.md': '# shared\n' };
  const secondFiles = { '.claude/skills/shared/SKILL.md': '# shared\n' };
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'alpha,beta', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [
          { id: 'alpha', name: 'alpha', files: firstFiles, bundle_manifest: buildSkillBundleManifest('alpha', firstFiles) },
          { id: 'beta', name: 'beta', files: secondFiles, bundle_manifest: buildSkillBundleManifest('beta', secondFiles) },
        ],
        skipped: [],
      }),
    },
  );

  expect(code).toBe(0);
  expect(fs.readFileSync(path.join(targetRoot, '.claude', 'skills', 'shared', 'SKILL.md'), 'utf8')).toBe('# shared\n');
});

test('bundle sync rejects conflicting json_set mutations on the same key path', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-mutation-conflict-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );

  const firstFiles = { '.claude/skills/alpha/SKILL.md': '# alpha\n' };
  const secondFiles = { '.claude/skills/beta/SKILL.md': '# beta\n' };
  const firstManifest = buildSkillBundleManifest('alpha', firstFiles);
  const secondManifest = buildSkillBundleManifest('beta', secondFiles);
  firstManifest.mutations = [{ type: 'json_set', path: 'brain/config.json', key_path: ['mode'], value: 'alpha' }];
  secondManifest.mutations = [{ type: 'json_set', path: 'brain/config.json', key_path: ['mode'], value: 'beta' }];
  withRecomputedHash(firstManifest, firstFiles);
  withRecomputedHash(secondManifest, secondFiles);
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'alpha,beta', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [
          { id: 'alpha', name: 'alpha', files: firstFiles, bundle_manifest: firstManifest },
          { id: 'beta', name: 'beta', files: secondFiles, bundle_manifest: secondManifest },
        ],
        skipped: [],
      }),
    },
  );

  expect(code).toBe(1);
  expect(cap.err()).toContain('json_set differs');
});

test('bundle sync allows append_block_if_missing mutations to share a target path', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-mutation-compose-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );

  const firstFiles = { '.claude/skills/alpha/SKILL.md': '# alpha\n' };
  const secondFiles = { '.claude/skills/beta/SKILL.md': '# beta\n' };
  const firstManifest = buildSkillBundleManifest('alpha', firstFiles);
  const secondManifest = buildSkillBundleManifest('beta', secondFiles);
  firstManifest.mutations = [{ type: 'append_block_if_missing', path: '.gitignore', content: '# alpha\n' }];
  secondManifest.mutations = [{ type: 'append_block_if_missing', path: '.gitignore', content: '# beta\n' }];
  withRecomputedHash(firstManifest, firstFiles);
  withRecomputedHash(secondManifest, secondFiles);
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'alpha,beta', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [
          { id: 'alpha', name: 'alpha', files: firstFiles, bundle_manifest: firstManifest },
          { id: 'beta', name: 'beta', files: secondFiles, bundle_manifest: secondManifest },
        ],
        skipped: [],
      }),
    },
  );

  expect(code).toBe(0);
  expect(fs.readFileSync(path.join(targetRoot, '.gitignore'), 'utf8')).toContain('# alpha\n');
  expect(fs.readFileSync(path.join(targetRoot, '.gitignore'), 'utf8')).toContain('# beta\n');
});

test('bundle sync allows file targets and mutations to share a path', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-file-mutation-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );

  const firstFiles = {
    '.claude/skills/alpha/SKILL.md': '# alpha\n',
    '.gitignore': 'node_modules/\n',
  };
  const secondFiles = { '.claude/skills/beta/SKILL.md': '# beta\n' };
  const firstManifest = buildSkillBundleManifest('alpha', firstFiles);
  const secondManifest = buildSkillBundleManifest('beta', secondFiles);
  secondManifest.mutations = [{ type: 'append_block_if_missing', path: '.gitignore', content: '.brain/\n' }];
  withRecomputedHash(firstManifest, firstFiles);
  withRecomputedHash(secondManifest, secondFiles);
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'alpha,beta', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [
          { id: 'alpha', name: 'alpha', files: firstFiles, bundle_manifest: firstManifest },
          { id: 'beta', name: 'beta', files: secondFiles, bundle_manifest: secondManifest },
        ],
        skipped: [],
      }),
    },
  );

  expect(code).toBe(0);
  expect(fs.readFileSync(path.join(targetRoot, '.gitignore'), 'utf8')).toContain('node_modules/\n');
  expect(fs.readFileSync(path.join(targetRoot, '.gitignore'), 'utf8')).toContain('.brain/\n');
});

test('bundle sync fails on missing required hosted content and cleans temp roots', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-missing-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );

  const files = { '.claude/skills/demo/SKILL.md': '# demo\n' };
  const manifest = buildSkillBundleManifest('demo', files);
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('ab-bundle-sync-demo-')).length;
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'demo', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [{ id: 'demo', name: 'demo', files: {}, bundle_manifest: manifest }],
        skipped: [],
      }),
    },
  );

  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('ab-bundle-sync-demo-')).length;
  expect(code).toBe(1);
  expect(cap.err()).toContain('missing required');
  expect(after).toBe(before);
});

test('bundle sync ignores hosted validation commands', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-validation-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );

  const files = { '.claude/skills/demo/SKILL.md': '# demo\n' };
  const manifest = buildSkillBundleManifest('demo', files);
  manifest.validation = { commands: ['touch SHOULD_NOT_EXIST'] };
  const sanitizedHash = computeInlineBundleHash(
    Object.entries(files).map(([target, content]) => ({
      source: target,
      target,
      content,
      kind: target.startsWith('brain/scripts/') ? 'repo' : 'skill',
      required: target.endsWith('/SKILL.md') || target.startsWith('brain/scripts/'),
      role: target.endsWith('/SKILL.md')
        ? 'entrypoint'
        : target.startsWith('brain/scripts/')
          ? 'runtime'
          : 'reference',
    })),
    { bundleType: 'skill_bundle', validationCommands: [] },
  );
  manifest.bundle_hash = sanitizedHash;
  manifest.version_id = `demo@1.0.0+sha256_${sanitizedHash.replace('sha256:', '').slice(0, 8)}`;
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'demo', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [{ id: 'demo', name: 'demo', files, bundle_manifest: manifest }],
        skipped: [],
      }),
    },
  );

  expect(code).toBe(0);
  expect(cap.err()).toContain('ignoring 1 hosted validation command');
  expect(fs.existsSync(path.join(targetRoot, 'SHOULD_NOT_EXIST'))).toBe(false);
});

test('bundle sync warns when reindex fails after a successful install', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-reindex-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );
  fs.mkdirSync(path.join(targetRoot, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, '.brain', 'brain.db'), 'not-a-sqlite-db', 'utf8');

  const files = { '.claude/skills/demo/SKILL.md': '# demo\n' };
  const manifest = buildSkillBundleManifest('demo', files);
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'demo', '--target-root', targetRoot, '--cwd', targetRoot],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: false,
        synced: [{ id: 'demo', name: 'demo', files, bundle_manifest: manifest }],
        skipped: [],
      }),
    },
  );

  expect(code).toBe(0);
  expect(fs.readFileSync(path.join(targetRoot, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('# demo\n');
  expect(cap.err()).toContain('warning: local reindex failed after install');
});

test('bundle sync skips reindex during dry runs', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const targetRoot = tempDir('ab-bundle-sync-dry-run-');
  fs.writeFileSync(
    path.join(targetRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'brain-sync' }, null, 2) + '\n',
    'utf8',
  );
  fs.mkdirSync(path.join(targetRoot, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, '.brain', 'brain.db'), 'not-a-sqlite-db', 'utf8');

  const files = { '.claude/skills/demo/SKILL.md': '# demo\n' };
  const manifest = buildSkillBundleManifest('demo', files);
  const cap = captureIo();

  const code = await runBundleCommand(
    ['sync', 'demo', '--target-root', targetRoot, '--cwd', targetRoot, '--dry-run'],
    cap.io,
    {
      credentialsReader: async () => ({ apiKey: 'test', serverUrl: 'https://example.test' }),
      requestSyncFn: async () => ({
        targetRepoPath: targetRoot,
        targetAgentId: 'brain-sync',
        dryRun: true,
        synced: [{ id: 'demo', name: 'demo', files, bundle_manifest: manifest }],
        skipped: [],
      }),
    },
  );

  expect(code).toBe(0);
  expect(cap.err()).not.toContain('warning: local reindex failed after install');
  expect(fs.existsSync(path.join(targetRoot, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(false);
});
