#!/usr/bin/env bun

import { join, relative, dirname } from "node:path";
import { readdirSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { normalizeBundleMutations, type BundleMutation } from "../lib/brain/skill-bundle-mutations.ts";
import { CANONICAL_RUNTIME_SOURCE_ROOT, loadBundleSourceRoots } from "../lib/bundle/roots-config.js";
import { collapseMirroredEntries, hasAuthoredSkillContent, listDeclaredSkillFiles } from "../lib/bundle/report.js";
import { assertContainedRelativePath, RUNTIME_STATE_ROLES } from "../lib/bundle/manifest-schema.js";
import { computeCanonicalBundleHash, normalizeBundleDependencies } from "../lib/bundle/bundle-hash-contract.js";

const repoRoot = join(import.meta.dir, "..");
// Legacy runtime location retained only to surface stale authorship if a runtime
// is still sitting under the removed templates tree.
const legacyScriptsRoot = join(repoRoot, "templates/scripts");

// Install-target roots — the single place that decides where each class of file
// lands in a consumer repo. Targets are author-defined and uniform across every
// brain so the doctor, conformance gate, and teleportation discover the runtime
// at a fixed, zero-config path (no --source-root, no per-consumer remap).
export const INSTALL_ROOTS = {
  skill: ".claude/skills", // skill assets: SKILL.md, references, fixtures
  "repo/runtime": "brain/scripts", // repo-self-contained runtime scripts
} as const;
export const MANIFEST_ANCHOR_ROOT = INSTALL_ROOTS.skill;

const bundleVersion = "1.0.0";

export function runtimeInstallTarget(skillName: string, installRoot = INSTALL_ROOTS["repo/runtime"]): string {
  return `${installRoot}/${skillName}.ts`;
}

export function skillInstallTarget(skillName: string, skillRel: string, installRoot = INSTALL_ROOTS.skill): string {
  return `${installRoot}/${skillName}/${skillRel}`;
}

export type { BundleMutation };
export { normalizeBundleMutations };

export type ManifestExtras = {
  // Canonical (deeply key-stable) form of the effective extras — fold THIS into the
  // bundle hash so whitespace/key-reorder reformats (top-level or nested) stay
  // churn-free. "" when no extras file is present (preserves the 0-churn guarantee).
  canonical: string;
  validationCanonical: string;
  mutationsCanonical: string;
  dependenciesCanonical: string;
  validationCommands: string[];
  mutations: BundleMutation[];
  runtimeState: RuntimeStateEntry[];
  dependencies: Record<string, string>;
};

export type RuntimeStateEntry = {
  target: string;
  role: "required_data" | "generated_state";
  initializer?: string;
};

// Deterministic JSON with recursively sorted object keys, so semantically-equal
// values produce an identical string regardless of authored key order.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// Optional per-skill manifest extras: validation commands + mutations the generator
// cannot infer from files (e.g. install-verify smoke, .gitignore edits).
export async function readManifestExtras(skillDir: string): Promise<ManifestExtras> {
  const extrasPath = join(skillDir, "skill-bundle-extras.json");
  const raw = existsSync(extrasPath) ? await Bun.file(extrasPath).text() : "";
  if (!raw) {
    return {
      canonical: "",
      validationCanonical: "",
      mutationsCanonical: "",
      dependenciesCanonical: "",
      validationCommands: [],
      mutations: [],
      runtimeState: [],
      dependencies: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Identify the failing file rather than aborting the whole run with a bare stack.
    throw new Error(`Malformed ${extrasPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${extrasPath}: expected a JSON object`);
  }

  const obj = parsed as { validation?: unknown; mutations?: unknown; dependencies?: unknown; runtime_state?: unknown };
  if (obj.validation !== undefined && (obj.validation === null || typeof obj.validation !== "object" || Array.isArray(obj.validation))) {
    throw new Error(`Invalid ${extrasPath}: validation must be an object`);
  }
  const commands = (obj.validation as { commands?: unknown } | undefined)?.commands;
  if (commands !== undefined && !Array.isArray(commands)) {
    throw new Error(`Invalid ${extrasPath}: validation.commands must be an array`);
  }
  if (Array.isArray(commands) && commands.some((c) => typeof c !== "string")) {
    throw new Error(`Invalid ${extrasPath}: validation.commands must contain only strings`);
  }
  // mutations: array only at parse time; normalizeBundleMutations() coerces legacy
  // {file, append} to append_block_if_missing before manifest emission.
  const muts = obj.mutations;
  if (muts !== undefined && !Array.isArray(muts)) {
    throw new Error(`Invalid ${extrasPath}: mutations must be an array`);
  }
  if (obj.dependencies !== undefined && (obj.dependencies === null || typeof obj.dependencies !== "object" || Array.isArray(obj.dependencies))) {
    throw new Error(`Invalid ${extrasPath}: dependencies must be an object`);
  }
  if (obj.dependencies && Object.values(obj.dependencies).some((range) => typeof range !== "string")) {
    throw new Error(`Invalid ${extrasPath}: dependency ranges must be strings`);
  }

  const runtimeStateRaw = obj.runtime_state;
  if (runtimeStateRaw !== undefined && !Array.isArray(runtimeStateRaw)) {
    throw new Error(`Invalid ${extrasPath}: runtime_state must be an array`);
  }
  const runtimeState = (runtimeStateRaw ?? []).map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid ${extrasPath}: runtime_state[${index}] must be an object`);
    }
    const value = entry as Record<string, unknown>;
    if (typeof value.target !== "string" || value.target.length === 0) {
      throw new Error(`Invalid ${extrasPath}: runtime_state[${index}].target must be a non-empty string`);
    }
    if (value.role !== "required_data" && value.role !== "generated_state") {
      throw new Error(`Invalid ${extrasPath}: runtime_state[${index}].role must be required_data or generated_state`);
    }
    if (value.initializer !== undefined && typeof value.initializer !== "string") {
      throw new Error(`Invalid ${extrasPath}: runtime_state[${index}].initializer must be a string when present`);
    }
    if (value.role !== "required_data" && value.initializer !== undefined) {
      throw new Error(`Invalid ${extrasPath}: runtime_state[${index}].initializer is only valid for required_data`);
    }
    const target = assertContainedRelativePath(value.target, `runtime_state[${index}].target`);
    const initializer = value.initializer === undefined
      ? undefined
      : assertContainedRelativePath(value.initializer, `runtime_state[${index}].initializer`);
    if (initializer !== undefined && ![".ts", ".js", ".mjs", ".cjs"].some((extension) => initializer.endsWith(extension))) {
      throw new Error(`Invalid ${extrasPath}: runtime_state[${index}].initializer must reference a script file (.ts/.js/.mjs/.cjs)`);
    }
    return { target, role: value.role, ...(initializer === undefined ? {} : { initializer }) };
  }).sort((left, right) =>
    left.target.localeCompare(right.target)
    || left.role.localeCompare(right.role)
    || (left.initializer ?? "").localeCompare(right.initializer ?? ""));

  const validationCommands = commands ?? [];
  const mutations = normalizeBundleMutations(muts ?? []);
  const dependencies = normalizeBundleDependencies(obj.dependencies) as Record<string, string>;
  return {
    canonical: stableStringify({ validationCommands, mutations, dependencies, runtimeState }),
    validationCanonical: validationCommands.length > 0 ? JSON.stringify(validationCommands) : "",
    mutationsCanonical: mutations.length > 0 ? JSON.stringify(mutations) : "",
    dependenciesCanonical: Object.keys(dependencies).length > 0 ? JSON.stringify(dependencies) : "",
    validationCommands,
    mutations,
    runtimeState,
    dependencies,
  };
}

async function readManifestExtrasForSkill(
  skillName: string,
  skillRoots: { source: string; absSourceRoot: string }[],
): Promise<ManifestExtras> {
  const extrasRoots = skillRoots.filter((root) =>
    existsSync(join(root.absSourceRoot, skillName, "skill-bundle-extras.json")),
  );

  if (extrasRoots.length === 0) {
    return {
      canonical: "",
      validationCanonical: "",
      mutationsCanonical: "",
      dependenciesCanonical: "",
      validationCommands: [],
      mutations: [],
      runtimeState: [],
      dependencies: {},
    };
  }

  const extrasByRoot = await Promise.all(
    extrasRoots.map(async (root) => ({
      root,
      extras: await readManifestExtras(join(root.absSourceRoot, skillName)),
    })),
  );
  const baseline = extrasByRoot[0].extras.canonical;
  const conflictingRoots = extrasByRoot.filter(({ extras }) => extras.canonical !== baseline);

  if (conflictingRoots.length > 0) {
    throw new Error(
      `Conflicting skill-bundle-extras.json files found for '${skillName}' under declared roots: ${extrasByRoot
        .map(({ root }) => `${root.source}/${skillName}/skill-bundle-extras.json`)
        .join(", ")}. Consolidate extras into a single declared root or make the mirrored extras identical.`,
    );
  }

  return extrasByRoot[0].extras;
}

function listFilesRecursively(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(dir);
  return out.sort();
}

function isDirectoryPath(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

type BundleHashFile = {
  source: string;
  target: string;
  absSource: string;
  kind?: string;
  role?: string;
};

export async function computeBundleHash(
  filePaths: BundleHashFile[],
  extras: { mutationsCanonical?: string; validationCanonical?: string; dependenciesCanonical?: string; bundleType?: string; selfManifestSource?: string; runtimeState?: RuntimeStateEntry[] } = {},
): Promise<string> {
  const files = [
    ...filePaths,
    ...(extras.runtimeState ?? []).map((entry) => ({
      source: entry.target,
      target: entry.target,
      absSource: "",
      kind: "runtime_state",
      role: entry.role,
      initializer: entry.initializer,
    })),
  ];
  return computeCanonicalBundleHash(files, {
    bundleType: extras.bundleType,
    readFile: (file) => readFileSync(file.absSource),
    mutations: extras.mutationsCanonical ? JSON.parse(extras.mutationsCanonical) : [],
    validationCommands: extras.validationCanonical ? JSON.parse(extras.validationCanonical) : [],
    dependencies: extras.dependenciesCanonical ? JSON.parse(extras.dependenciesCanonical) : {},
    selfManifestSources: extras.selfManifestSource ? [extras.selfManifestSource] : [],
  });
}

type FileEntry = {
  source: string;
  target: string;
  absSource: string;
  kind: "skill" | "repo";
  required: boolean;
  role: "entrypoint" | "runtime" | "reference" | "required_data" | "generated_state";
};

export type GenerateOptions = {
  repoRoot?: string;
  configPath?: string;
  skillsRoot?: string;
  skillRootOverrides?: Record<string, string>;
  brainScriptsRoot?: string;
  runtimeRootOverrides?: Record<string, string>;
  legacyScriptsRoot?: string;
  warn?: (msg: string) => void;
};

export async function main(opts: GenerateOptions = {}): Promise<{ generated: number; updated: number; skipped: number }> {
  const effectiveRepoRoot = opts.repoRoot ?? repoRoot;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const legacyDir = opts.legacyScriptsRoot ?? join(effectiveRepoRoot, relative(repoRoot, legacyScriptsRoot));
  const bundleRoots = loadBundleSourceRoots(effectiveRepoRoot, { configPath: opts.configPath });
  const resolveSkillRoot = (root: { source: string; target: string }): string => {
    const explicitOverride = opts.skillRootOverrides?.[root.source];
    if (explicitOverride) return explicitOverride;
    if (opts.skillsRoot && root.source === INSTALL_ROOTS.skill) return opts.skillsRoot;
    return join(effectiveRepoRoot, root.source);
  };
  const skillRoots = bundleRoots.roots
    .filter((root) => root.kind === "skill")
    .map((root) => ({
      ...root,
      absSourceRoot: resolveSkillRoot(root),
    }));
  const runtimeRoots = bundleRoots.roots
    .filter((root) => root.kind === "repo/runtime")
    .map((root) => ({
      ...root,
      absSourceRoot: opts.runtimeRootOverrides?.[root.source]
        ?? (opts.brainScriptsRoot && root.source === CANONICAL_RUNTIME_SOURCE_ROOT
          ? opts.brainScriptsRoot
          : join(effectiveRepoRoot, root.source)),
    }));
  const hasCanonicalRuntimeRoot = runtimeRoots.some((root) => root.source === CANONICAL_RUNTIME_SOURCE_ROOT);
  let skippedSkillRoot = false;

  if (skillRoots.length === 0) {
    throw new Error("Bundle roots config must declare at least one skill root");
  }

  // Use commit timestamp so regenerating without changes produces identical output.
  const gitCommit = await Bun.$`git -C ${effectiveRepoRoot} rev-parse --short HEAD`.text().catch(() => "unknown");
  const gitTimestamp = await Bun.$`git -C ${effectiveRepoRoot} log -1 --format=%cI`.text().catch(() => new Date().toISOString());
  const commit = gitCommit.trim();
  const commitTimestamp = gitTimestamp.trim();
  // CI only receives tracked source files. Excluding local ignored artifacts
  // keeps generated manifests deterministic between a developer checkout and
  // the clean checkout used by the template gate.
  let trackedOutput: string | null;
  try {
    trackedOutput = await Bun.$`git -C ${effectiveRepoRoot} ls-files`.text();
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr)
      : "";
    // A caller may intentionally supply a temporary non-Git source tree. Any
    // other Git failure (broken index, permission error, missing executable)
    // must remain visible rather than silently widening the generated payload.
    if (!/not a git repository/i.test(stderr)) throw error;
    trackedOutput = null;
  }
  // Programmatic callers and focused tests may provide a temporary source tree
  // rather than a Git checkout. In that case there is no authoritative tracked
  // set, so retain the established filesystem-backed behavior.
  const trackedFiles = trackedOutput == null
    ? null
    : new Set(trackedOutput.trim().split("\n").filter(Boolean));
  const skillNames = new Set<string>();
  for (const root of skillRoots) {
    if (!existsSync(root.absSourceRoot)) {
      skippedSkillRoot = true;
      warn(`[generate-skill-manifests] warn: declared bundle root '${root.source}' does not exist; skipping.`);
      continue;
    }
    if (!isDirectoryPath(root.absSourceRoot)) {
      skippedSkillRoot = true;
      warn(`[generate-skill-manifests] warn: declared bundle root '${root.source}' is not a directory; skipping.`);
      continue;
    }
    const entries = readdirSync(root.absSourceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => hasAuthoredSkillContent(join(root.absSourceRoot, name)));
    for (const entry of entries) skillNames.add(entry);
  }
  for (const root of runtimeRoots) {
    if (!existsSync(root.absSourceRoot)) {
      warn(`[generate-skill-manifests] warn: declared bundle root '${root.source}' does not exist; skipping.`);
      continue;
    }
    if (!isDirectoryPath(root.absSourceRoot)) {
      warn(`[generate-skill-manifests] warn: declared bundle root '${root.source}' is not a directory; skipping.`);
      continue;
    }
  }
  const skillDirs = [...skillNames].sort();
  let generated = 0;
  let updated = 0;
  let skipped = 0;
  const anchorRoot = join(effectiveRepoRoot, MANIFEST_ANCHOR_ROOT);
  if (!skippedSkillRoot && existsSync(anchorRoot) && isDirectoryPath(anchorRoot)) {
    for (const entry of readdirSync(anchorRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (skillNames.has(entry.name)) continue;
      const staleManifestPath = join(anchorRoot, entry.name, "skill-bundle-manifest.json");
      if (!existsSync(staleManifestPath)) continue;
      rmSync(staleManifestPath, { force: true });
      warn(`[generate-skill-manifests] warn: removed stale manifest: ${staleManifestPath}`);
      updated++;
    }
  } else if (skippedSkillRoot && existsSync(anchorRoot) && isDirectoryPath(anchorRoot)) {
    warn(
      "[generate-skill-manifests] warn: skipping stale manifest cleanup because one or more declared bundle roots were unavailable.",
    );
  }
  for (const skillName of skillDirs) {
    const manifestDir = join(anchorRoot, skillName);
    const manifestPath = join(manifestDir, "skill-bundle-manifest.json");
    const hasRuntime = runtimeRoots.some((root) => existsSync(join(root.absSourceRoot, `${skillName}.ts`)));

    // Catch a runtime authored at the legacy templates/scripts/<skill>.ts path, which
    // would otherwise be silently skipped (never emitted as a kind:repo runtime entry).
    if (!hasRuntime && existsSync(join(legacyDir, `${skillName}.ts`))) {
      warn(
        `[generate-skill-manifests] warn: runtime for '${skillName}' found at legacy templates/scripts/ — move it to brain/scripts/ to be distributed.`,
      );
    }

    const {
      validationCanonical,
      mutationsCanonical,
      dependenciesCanonical,
      validationCommands,
      mutations,
      runtimeState,
      dependencies,
    } = await readManifestExtrasForSkill(skillName, skillRoots);

    const fileEntries: FileEntry[] = [];

    if (bundleRoots.mode === "replace" && !hasCanonicalRuntimeRoot) {
      const canonicalRuntimeScript = join(effectiveRepoRoot, CANONICAL_RUNTIME_SOURCE_ROOT, `${skillName}.ts`);
      if (existsSync(canonicalRuntimeScript)) {
        warn(
          `[generate-skill-manifests] warn: runtime for '${skillName}' exists at ${CANONICAL_RUNTIME_SOURCE_ROOT}/${skillName}.ts but replace-mode roots omit the canonical repo/runtime root; this runtime will not be distributed.`,
        );
      }
    }

    for (const root of skillRoots) {
      const skillDir = join(root.absSourceRoot, skillName);
      if (!hasAuthoredSkillContent(skillDir)) continue;
      const declaredFiles = listDeclaredSkillFiles(skillDir);
      for (const skillRel of declaredFiles) {
        const abs = join(skillDir, skillRel);

        const installPath = skillInstallTarget(skillName, skillRel, root.target);
        const isEntrypoint = skillRel === "SKILL.md";
        // Only SKILL.md and runtime are required; reference files (fixtures, tests) are optional.
        const required = isEntrypoint;
        const role = isEntrypoint ? "entrypoint" : "reference";
        const sourcePath = `${root.source}/${skillName}/${skillRel}`;
        if (trackedFiles && !trackedFiles.has(sourcePath)) continue;

        fileEntries.push({ source: sourcePath, target: installPath, absSource: abs, kind: "skill", required, role });
      }
    }

    for (const root of runtimeRoots) {
      const runtimeScript = join(root.absSourceRoot, `${skillName}.ts`);
      if (!existsSync(runtimeScript)) continue;
      const sourcePath = `${root.source}/${skillName}.ts`;
      const installPath = runtimeInstallTarget(skillName, root.target);
      fileEntries.push({
        source: sourcePath, target: installPath, absSource: runtimeScript,
        kind: "repo", required: true, role: "runtime",
      });
    }

    // A required_data initializer is itself an install prerequisite even when it
    // lives alongside otherwise-optional skill reference files. Mark the
    // declared script target required without overwriting its explicit role.
    const initializerTargets = new Set(
      runtimeState.flatMap((entry) => entry.initializer === undefined ? [] : [entry.initializer]),
    );
    for (const entry of fileEntries) {
      if (!initializerTargets.has(entry.target)) continue;
      entry.required = true;
    }
    const declaredTargets = new Set(fileEntries.map((entry) => entry.target));
    const missingInitializers = [...initializerTargets].filter((target) => !declaredTargets.has(target));
    if (missingInitializers.length > 0) {
      throw new Error(
        `Refusing to emit '${skillName}' manifest: required_data initializer target(s) are not bundled: ${missingInitializers.join(", ")}`,
      );
    }

    const collapsedEntries = collapseMirroredEntries(
      fileEntries,
      (prior, entry) =>
        `Duplicate manifest target for '${skillName}': ${entry.target} declared by both ${prior.source} and ${entry.source} with different content`,
    );

    if (collapsedEntries.length === 0) {
      throw new Error(`Refusing to emit empty manifest for '${skillName}': no declared source files remain under configured bundle roots`);
    }

    // Validate every generated target before the no-rewrite fast path. Otherwise
    // an already-written invalid manifest can be silently retained when its hash
    // happens to match the duplicate runtime_state declaration set.
    const manifestTargets = new Set(collapsedEntries.map((entry) => entry.target));
    for (const entry of runtimeState) {
      if (manifestTargets.has(entry.target)) {
        throw new Error(`Duplicate manifest target for '${skillName}': runtime_state target '${entry.target}' collides with a declared file or another runtime_state entry`);
      }
      manifestTargets.add(entry.target);
    }

    const hashInputs = collapsedEntries.map((f) => ({
      source: f.source,
      target: f.target,
      absSource: f.absSource,
      kind: f.kind,
      role: f.role,
    }));
    // The generated control manifest is recursive only when that exact file is
    // itself a declared payload entry.  This is path provenance, not a suffix
    // rule for any other manifest-named file in the skill tree.
    const selfManifestSource = collapsedEntries.find((entry) => entry.absSource === manifestPath)?.source;
    const bundleHash = await computeBundleHash(hashInputs, {
      mutationsCanonical,
      validationCanonical,
      runtimeState,
      dependenciesCanonical,
      ...(selfManifestSource ? { selfManifestSource } : {}),
      runtimeState,
    });

    const manifestFiles = [...collapsedEntries
      .map(({ absSource: _abs, ...rest }) => rest)
      , ...runtimeState.map((entry) => ({
        source: entry.target,
        target: entry.target,
        kind: "skill" as const,
        required: entry.role === "required_data",
        role: entry.role,
        ...(entry.initializer === undefined ? {} : { initializer: entry.initializer }),
      }))]
      .sort((a, b) => a.target.localeCompare(b.target) || a.source.localeCompare(b.source));
    const projectionTargets = manifestFiles
      .filter((entry) => !RUNTIME_STATE_ROLES.has(entry.role))
      .map(({ target }) => target);

    // Only rewrite when both the content hash and derived projection agree. The
    // projection intentionally excludes runtime state, so a generator-rule
    // correction can change it without changing bundleHash.
    const existed = existsSync(manifestPath);
    if (existed) {
      try {
        const existing = JSON.parse(await Bun.file(manifestPath).text());
        if (
          existing.bundle_hash === bundleHash
          && existing?.projection?.mode === "repo_materialization"
          && JSON.stringify(existing.projection.targets) === JSON.stringify(projectionTargets)
          && JSON.stringify(existing.files) === JSON.stringify(manifestFiles)
        ) {
          skipped++;
          continue;
        }
      } catch {
        // Malformed manifest — fall through to rewrite.
      }
    }

    const shortHash = bundleHash.replace("sha256:", "").slice(0, 8);
    const versionId = `${skillName}@${bundleVersion}+sha256_${shortHash}`;

    const manifest = {
      bundle_type: "skill_bundle",
      bundle_name: skillName,
      skill: skillName,
      bundle_version: bundleVersion,
      version_id: versionId,
      bundle_hash: bundleHash,
      source: { repo: "agentbootup", commit, generated_at: commitTimestamp },
      distribution: { mode: "self_apply" },
      install: {
        state_file: `skills/state/${skillName}.json`,
        backup_root: `skills/${skillName}`,
      },
      projection: {
        mode: "repo_materialization",
        targets: projectionTargets,
      },
      validation: { commands: validationCommands },
      mutations,
      dependencies,
      files: manifestFiles,
    };

    mkdirSync(dirname(manifestPath), { recursive: true });
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    if (existed) updated++; else generated++;
  }

  console.log(`Manifests: ${generated} generated, ${updated} updated, ${skipped} unchanged (${skillDirs.length} skills total)`);
  return { generated, updated, skipped };
}

if (import.meta.main) {
  await main();
}
