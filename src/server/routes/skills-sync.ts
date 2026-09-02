import { computeInlineBundleHash, normalizeBundleManifest } from '../../../lib/bundle/installer.js';
import { HttpError, jsonSuccess, readJsonBody, ensureIdentifier, ensureString } from '../errors';
import { RegistryStore } from '../lib/registry-store';
import { SkillStore } from '../lib/skill-store';
import type { Skill } from '../types';

type SyncCli = 'claude' | 'codex' | 'gemini' | 'cursor';

type ManifestEntry = {
  id: string;
  sync?: unknown;
  tags?: string[];
  target_agents?: string[];
  bundle_name?: string;
};

const CLI_SKILL_ROOTS: Record<SyncCli, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  cursor: '.cursor/skills',
};

function ensureStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseClis(value: unknown): SyncCli[] {
  if (value === undefined || value === null) return ['claude', 'codex', 'gemini'];
  const clis = ensureStringArray(value, 'options.clis');
  const valid = new Set<SyncCli>(['claude', 'codex', 'gemini', 'cursor']);
  for (const cli of clis) {
    if (!valid.has(cli as SyncCli)) {
      throw new HttpError(400, 'invalid_request', `Unsupported CLI "${cli}" in options.clis.`);
    }
  }
  return [...new Set(clis as SyncCli[])];
}

function supportsPluralSelfManifestSources(options: Record<string, unknown>): boolean {
  if (options.capabilities === undefined) return false;
  const capabilities = ensureStringArray(options.capabilities, 'options.capabilities');
  return capabilities.includes('plural_self_manifest_sources');
}

function parseSelection(value: unknown): 'all' | 'all-core' | string[] {
  if (value === 'all' || value === 'all-core') return value;
  if (Array.isArray(value)) {
    const ids = ensureStringArray(value, 'skills').map((id) => ensureIdentifier(id, 'skills[]', 200));
    if (ids.length === 0) {
      throw new HttpError(400, 'SELECTION_REQUIRED', "Field 'skills' must not be empty.");
    }
    return [...new Set(ids)];
  }
  throw new HttpError(
    400,
    'SELECTION_REQUIRED',
    "Field 'skills' is required and must be 'all', 'all-core', or a non-empty string array.",
  );
}

function extractManifestEntries(manifest: Record<string, unknown> | null): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  if (!manifest) return map;

  const buckets = ['skills', 'bundles', 'entries']
    .map((key) => manifest[key])
    .filter(Boolean);

  for (const bucket of buckets) {
    if (Array.isArray(bucket)) {
      for (const raw of bucket) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        const id =
          typeof entry.id === 'string'
            ? entry.id
            : typeof entry.bundle_name === 'string'
              ? entry.bundle_name
              : typeof entry.name === 'string'
                ? entry.name
                : null;
        if (!id) continue;
        map.set(id, {
          id,
          sync: entry.sync,
          tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
          target_agents: Array.isArray(entry.target_agents)
            ? entry.target_agents.filter((item): item is string => typeof item === 'string')
            : Array.isArray(entry.agents)
              ? entry.agents.filter((item): item is string => typeof item === 'string')
              : undefined,
          bundle_name: typeof entry.bundle_name === 'string' ? entry.bundle_name : undefined,
        });
      }
    } else if (bucket && typeof bucket === 'object') {
      for (const [id, raw] of Object.entries(bucket)) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        map.set(id, {
          id,
          sync: entry.sync,
          tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
          target_agents: Array.isArray(entry.target_agents)
            ? entry.target_agents.filter((item): item is string => typeof item === 'string')
            : Array.isArray(entry.agents)
              ? entry.agents.filter((item): item is string => typeof item === 'string')
              : undefined,
          bundle_name: typeof entry.bundle_name === 'string' ? entry.bundle_name : undefined,
        });
      }
    }
  }

  return map;
}

function entryIsCore(entry: ManifestEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.sync === 'core') return true;
  if (entry.tags?.includes('core')) return true;
  if (entry.sync && typeof entry.sync === 'object') {
    const sync = entry.sync as Record<string, unknown>;
    return sync.scope === 'core' || sync.tier === 'core' || sync.class === 'core';
  }
  return false;
}

function entryAllowsTarget(entry: ManifestEntry | undefined, targetAgentId: string): boolean {
  if (!entry?.target_agents || entry.target_agents.length === 0) return true;
  return entry.target_agents.includes(targetAgentId);
}

function isRepoRelativePath(relPath: string): boolean {
  return (
    relPath.startsWith('.claude/') ||
    relPath.startsWith('.codex/') ||
    relPath.startsWith('.gemini/') ||
    relPath.startsWith('.cursor/') ||
    relPath.startsWith('.agents/') ||
    relPath.startsWith('.ai/') ||
    relPath.startsWith('brain/') ||
    relPath.startsWith('scripts/') ||
    relPath.startsWith('memory/') ||
    relPath === 'CLAUDE.md' ||
    relPath === 'AGENTS.md' ||
    relPath === 'GEMINI.md'
  );
}

function authoredManifestPath(skillId: string, relPath: string): string | null {
  // These are the only publisher-declared control-manifest locations.  This is
  // intentionally an exact path allowlist, rather than `endsWith(...)`, JSON
  // parsing, or a "first manifest-shaped file wins" convention: arbitrary
  // payloads and fixtures may legitimately be named
  // `skill-bundle-manifest.json`.
  if (relPath === 'skill-bundle-manifest.json') return relPath;
  for (const root of Object.values(CLI_SKILL_ROOTS)) {
    if (relPath === `${root}/${skillId}/skill-bundle-manifest.json`) return relPath;
  }
  return null;
}

function embeddedManifestFile(skill: Skill) {
  return skill.files.find((file) => authoredManifestPath(
    skill.id,
    file.path.replace(/\\/g, '/').replace(/^\.\/+/, ''),
  ));
}

function materializeSkillFiles(skill: Skill, clis: SyncCli[]): { files: Map<string, string>; selfManifestSources: string[] } {
  const files = new Map<string, string>();
  // This comes from the publisher's exact authored path, not from a filename
  // guess over the emitted payload.  Consumers can therefore normalize only
  // the declared recursive manifest and leave manifest-shaped fixtures raw.
  const selfManifestSources: string[] = [];
  for (const file of skill.files) {
    const relPath = file.path.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!relPath) continue;
    const authoredPath = authoredManifestPath(skill.id, relPath);
    if (isRepoRelativePath(relPath)) {
      files.set(relPath, file.content);
      if (authoredPath) selfManifestSources.push(relPath);
      continue;
    }
    for (const cli of clis) {
      const target = `${CLI_SKILL_ROOTS[cli]}/${skill.id}/${relPath}`;
      files.set(target, file.content);
      if (authoredPath) selfManifestSources.push(target);
    }
  }
  return { files, selfManifestSources };
}

function parseEmbeddedBundleMetadata(skill: Skill): {
  bundleVersion?: string;
  distributionMode?: 'direct_sync' | 'self_apply';
  mutations?: unknown[];
} {
  const manifestFile = embeddedManifestFile(skill);
  if (!manifestFile) return {};
  try {
    const parsed = JSON.parse(manifestFile.content) as Record<string, unknown>;
    return {
      bundleVersion: typeof parsed.bundle_version === 'string' ? parsed.bundle_version : undefined,
      distributionMode:
        parsed.distribution && typeof parsed.distribution === 'object' && (parsed.distribution as Record<string, unknown>).mode === 'direct_sync'
          ? 'direct_sync'
          : 'self_apply',
      mutations: Array.isArray(parsed.mutations) ? parsed.mutations : [],
    };
  } catch {
    return {};
  }
}

function classifyRole(targetPath: string): { kind: string; role: string } {
  if (targetPath.includes('/SKILL.md')) return { kind: 'skill', role: 'entrypoint' };
  if (targetPath.startsWith('brain/scripts/')) return { kind: 'repo', role: 'runtime' };
  return { kind: 'skill', role: 'reference' };
}

function buildBundleManifest(skill: Skill, files: Map<string, string>, selfManifestSources: string[] = []) {
  const embedded = parseEmbeddedBundleMetadata(skill);
  const fileEntries = [...files.entries()].map(([target, content]) => {
    const { kind, role } = classifyRole(target);
    return {
      source: target,
      target,
      content,
      kind,
      role,
      required: role === 'entrypoint' || role === 'runtime',
    };
  });
  const version = embedded.bundleVersion ?? '1.0.0';
  const baseManifest = normalizeBundleManifest({
    bundle_type: 'skill_bundle',
    bundle_name: skill.id,
    bundle_version: version,
    version_id: `${skill.id}@${version}+sha256_pending`,
    bundle_hash: 'sha256:pending',
    source: {
      repo: 'agentbootup-server',
      // This source metadata is materialized into a self-referential payload,
      // so it must be stable for unchanged published input. `updated_at` is
      // publisher-owned identity; a request-time generation timestamp is not.
      skill_id: skill.id,
      updated_at: skill.updated_at,
    },
    distribution: { mode: embedded.distributionMode ?? 'self_apply' },
    install: { state_file: `skills/state/${skill.id}.json`, backup_root: `skills/${skill.id}` },
    validation: { commands: [] },
    dependencies: {},
    mutations: embedded.mutations ?? [],
    files: fileEntries.map(({ content: _content, ...entry }) => entry),
  });
  const bundleHash = computeInlineBundleHash(fileEntries.map((entry) =>
    selfManifestSources.includes(entry.source) ? { ...entry, content: JSON.stringify(baseManifest) } : entry,
  ), {
    bundleType: 'skill_bundle',
    mutations: embedded.mutations ?? [],
    validationCommands: [],
    selfManifestSources,
  });
  const manifest = normalizeBundleManifest({
    ...baseManifest,
    version_id: `${skill.id}@${version}+sha256_${bundleHash.replace('sha256:', '').slice(0, 8)}`,
    bundle_hash: bundleHash,
  });
  for (const selfManifestSource of selfManifestSources) {
    files.set(selfManifestSource, JSON.stringify(manifest));
  }
  return manifest;
}

export async function handleSyncSkills(req: Request, skillStore: SkillStore, registryStore: RegistryStore): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
  }

  const payload = body as Record<string, unknown>;
  const targetRepoPath = ensureString(payload.targetRepoPath, 'targetRepoPath', { maxLength: 4000 });
  const targetAgentId = ensureIdentifier(ensureString(payload.targetAgentId, 'targetAgentId', { maxLength: 200 }), 'targetAgentId', 200);
  const selection = parseSelection(payload.skills);
  const options =
    payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options)
      ? (payload.options as Record<string, unknown>)
      : {};
  const dryRun = options.dryRun === true;
  const clis = parseClis(options.clis);
  const pluralSelfManifestSources = supportsPluralSelfManifestSources(options);

  const manifest = await registryStore.getManifest();
  const manifestEntries = extractManifestEntries(manifest);
  const summaries = await skillStore.list();
  const summaryIds = new Set(summaries.map((skill) => skill.id));
  const knownIds = new Set([...manifestEntries.keys(), ...summaryIds]);

  let requestedIds: string[];
  if (selection === 'all') {
    requestedIds = [...knownIds].sort();
  } else if (selection === 'all-core') {
    // If no curated manifest exists yet, preserve historical broad-sync behavior by
    // falling back to all known skills instead of returning an empty plan.
    requestedIds = manifestEntries.size > 0
      ? [...manifestEntries.values()].filter((entry) => entryIsCore(entry)).map((entry) => entry.id).sort()
      : [...summaryIds].sort();
  } else {
    const missing = selection.filter((id) => !knownIds.has(id));
    if (missing.length > 0) {
      throw new HttpError(422, 'SKILL_NOT_FOUND', `Unknown skill ids: ${missing.join(', ')}`);
    }
    requestedIds = selection;
  }

  const synced: Array<{
    id: string;
    name: string;
    files: Record<string, string>;
    bundle_manifest: Record<string, unknown>;
    self_manifest_source?: string;
    self_manifest_sources?: string[];
  }> = [];
  const skipped: Array<{ id: string; reason: 'out-of-scope' | 'already-current' | 'not-found' }> = [];

  for (const id of requestedIds) {
    const entry = manifestEntries.get(id);
    if (!entryAllowsTarget(entry, targetAgentId)) {
      skipped.push({ id, reason: 'out-of-scope' });
      continue;
    }
    const skill = await skillStore.get(id);
    if (!skill) {
      skipped.push({ id, reason: 'not-found' });
      continue;
    }

    const materialized = materializeSkillFiles(skill, clis);
    const files = materialized.files;
    // Provenance comes from exact publisher-authored paths, rather than a
    // client-side structural or filename inference. A top-level authored
    // manifest is materialized to every requested CLI root, and every mirror
    // is recursive self-content: leaving any one unlisted would cause its
    // literal hash/version fields to poison canonical hash verification.
    // Old clients understand only one recursive source. Do not emit a
    // multi-source hash to them: their verifier would normalize the first
    // mirror but treat every additional mirror as literal content. The plural
    // contract is therefore opt-in via an explicit request capability.
    const selfManifestSources = pluralSelfManifestSources
      ? materialized.selfManifestSources
      : materialized.selfManifestSources.slice(0, 1);
    const bundleManifest = buildBundleManifest(skill, files, selfManifestSources);
    synced.push({
      id: skill.id,
      name: skill.name,
      files: Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b))),
      bundle_manifest: bundleManifest as Record<string, unknown>,
      ...(selfManifestSources.length > 0
        ? {
            // Retain the original single-source field for older clients. Only
            // capable clients receive the full explicit provenance set.
            self_manifest_source: selfManifestSources[0],
            ...(pluralSelfManifestSources ? { self_manifest_sources: selfManifestSources } : {}),
          }
        : {}),
    });
  }

  return jsonSuccess(200, {
    targetRepoPath,
    targetAgentId,
    dryRun,
    synced,
    skipped,
  });
}
