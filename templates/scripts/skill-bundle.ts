#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { normalizeBundleMutations, type BundleMutation } from "../../lib/brain/skill-bundle-mutations.ts";
import { computeCanonicalBundleHash, includeBundleHashFile, normalizeBundleDependencies, normalizedBundleHashBytes } from "../../lib/bundle/bundle-hash-contract.js";

type DistributionMode = "direct_sync" | "self_apply";
type FileKind = "skill" | "repo" | "state" | "docs";
type InstallStatus = "applied" | "rolled_back" | "failed";

type BundleManifest = {
  _manifestSource?: string;
  bundle_type?: string;
  skill: string;
  bundle_version: string;
  version_id: string;
  bundle_hash: string;
  source: {
    repo: string;
    commit?: string;
    generated_at?: string;
  };
  distribution?: {
    mode: DistributionMode;
    reason?: string;
  };
  install: {
    state_file: string;
    backup_root: string;
  };
  validation?: {
    commands?: string[];
  };
  mutations?: BundleMutation[];
  dependencies?: Record<string, string>;
  files: BundleFileEntry[];
};

type BundleFileEntry = {
  path?: string;
  source?: string;
  target?: string;
  kind: FileKind;
  required: boolean;
  role?: "entrypoint" | "runtime" | "compat_shim" | "reference" | "state_seed";
  shared?: boolean;
  shared_with?: string[];
};

type InstalledState = {
  skill: string;
  installed_version: string | null;
  version_id: string | null;
  bundle_hash: string | null;
  source_repo: string;
  applied_at: string | null;
  previous_version: string | null;
  previous_version_id: string | null;
  previous_installed_file_hashes?: Record<string, string>;
  previous_installed_mutation_hashes?: Record<string, string>;
  previous_kept_local_mutation_targets?: string[];
  previous_kept_local_mutation_hashes?: Record<string, string>;
  /** Mutation paths intentionally retained from the target rather than applied. */
  kept_local_mutation_targets?: string[];
  /** Definition hashes for kept mutations, used to detect future changes. */
  kept_local_mutation_hashes?: Record<string, string>;
  backup_path: string | null;
  installed_file_hashes?: Record<string, string>;
  installed_mutation_hashes?: Record<string, string>;
  status: InstallStatus;
  last_attempt?: {
    version_id: string;
    bundle_version: string;
    failed_at?: string;
    rolled_back_at?: string;
    error?: string;
  };
};

type Command = "status" | "install" | "rollback" | "help";

type ParsedArgs = {
  command: Command;
  manifestPath?: string;
  sourceRoot: string;
  targetRoot: string;
  force: boolean;
  dryRun: boolean;
  onConflict: ConflictPolicy;
  help: boolean;
};

type ConflictPolicy = "keep" | "theirs" | "prompt" | "fail";

type BackupEntry = {
  path: string;
  existed: boolean;
};

function usage(): string {
  return `skill-bundle — install versioned skill bundles safely

Usage:
  bun scripts/skill-bundle.ts status --manifest <path> [--source-root <dir>] [--target-root <dir>]
  bun scripts/skill-bundle.ts install --manifest <path> [--source-root <dir>] [--target-root <dir>] [--force] [--dry-run] [--on-conflict keep|theirs|prompt|fail]
  bun scripts/skill-bundle.ts rollback --manifest <path> [--target-root <dir>] [--dry-run]

Options:
  --manifest PATH       Path to skill-bundle-manifest.json
  --source-root DIR     Source repo root containing bundle files (default: cwd)
  --target-root DIR     Target repo root to modify (default: cwd)
  --force               Reinstall even if the same version_id is already installed
  --dry-run             Print planned changes without writing files
  --on-conflict POLICY  Local/upstream conflict behavior (non-TTY default: fail)
  -h, --help            Show help
`;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: Command = "help";
  let manifestPath: string | undefined;
  let sourceRoot = process.cwd();
  let targetRoot = process.cwd();
  let force = false;
  let dryRun = false;
  let onConflict: ConflictPolicy = process.stdin.isTTY ? "prompt" : "fail";
  let help = false;

  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--on-conflict" || arg.startsWith("--on-conflict=")) {
      const value = arg === "--on-conflict" ? argv[++i] : arg.slice("--on-conflict=".length);
      if (value !== "keep" && value !== "theirs" && value !== "prompt" && value !== "fail") {
        die(`Invalid --on-conflict value: ${value}`);
      }
      onConflict = value;
      continue;
    }
    if (arg === "--manifest") {
      manifestPath = argv[++i];
      continue;
    }
    if (arg.startsWith("--manifest=")) {
      manifestPath = arg.slice("--manifest=".length);
      continue;
    }
    if (arg === "--source-root") {
      sourceRoot = argv[++i] ?? sourceRoot;
      continue;
    }
    if (arg.startsWith("--source-root=")) {
      sourceRoot = arg.slice("--source-root=".length);
      continue;
    }
    if (arg === "--target-root") {
      targetRoot = argv[++i] ?? targetRoot;
      continue;
    }
    if (arg.startsWith("--target-root=")) {
      targetRoot = arg.slice("--target-root=".length);
      continue;
    }
    positionals.push(arg);
  }

  const first = positionals[0];
  if (first === "status" || first === "install" || first === "rollback" || first === "help") {
    command = first;
  }

  if (onConflict === "prompt" && !process.stdin.isTTY) {
    die("--on-conflict prompt requires an interactive terminal; use keep, theirs, or fail");
  }

  return {
    command,
    manifestPath,
    sourceRoot: resolve(sourceRoot),
    targetRoot: resolve(targetRoot),
    force,
    dryRun,
    onConflict,
    help,
  };
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function safeRel(base: string, path: string): string {
  return relative(base, path) || ".";
}

function sanitizeVersionId(versionId: string): string {
  return versionId.replace(/[^\w.-]+/g, "_");
}

function loadManifest(manifestArg: string | undefined, sourceRoot: string): { manifest: BundleManifest; manifestPath: string } {
  if (!manifestArg) die("Missing --manifest\n\n" + usage());
  const manifestPath = isAbsolute(manifestArg) ? manifestArg : resolve(sourceRoot, manifestArg);
  if (!existsSync(manifestPath)) die(`Manifest not found: ${manifestPath}`);
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as BundleManifest;
  manifest._manifestSource = relative(sourceRoot, manifestPath).replace(/\\/g, "/");
  if (!manifest.skill || !manifest.version_id || !manifest.bundle_hash || !manifest.install || !manifest.files?.length) {
    die(`Manifest is missing required fields: ${manifestPath}`);
  }
  try {
    manifest.mutations = normalizeBundleMutations(manifest.mutations ?? []);
  } catch (error) {
    die(`Invalid mutations in manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  manifest.dependencies = normalizeBundleDependencies(manifest.dependencies) as Record<string, string>;
  return { manifest, manifestPath };
}

function targetPath(root: string, relPath: string): string {
  return resolve(root, relPath);
}

function sourcePathFromEntry(entry: BundleFileEntry): string {
  return entry.source ?? entry.path ?? die(`Bundle file entry missing source/path`);
}

function targetPathFromEntry(entry: BundleFileEntry): string {
  return entry.target ?? entry.path ?? die(`Bundle file entry missing target/path`);
}

function bundleEntryLabel(entry: BundleFileEntry): string {
  return `${sourcePathFromEntry(entry)} -> ${targetPathFromEntry(entry)}`;
}

function mutationPath(mutation: BundleMutation): string {
  return mutation.path;
}

function mutationsByTarget(manifest: BundleManifest): Map<string, BundleMutation[]> {
  const mutationsByPath = new Map<string, BundleMutation[]>();
  for (const mutation of manifest.mutations ?? []) {
    const path = mutationPath(mutation);
    mutationsByPath.set(path, [...(mutationsByPath.get(path) ?? []), mutation]);
  }
  return mutationsByPath;
}

function mutationHashes(manifest: BundleManifest): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const [path, mutations] of mutationsByTarget(manifest)) {
    hashes[path] = createHash("sha256").update(JSON.stringify(mutations)).digest("hex");
  }
  return hashes;
}

function locallyAdaptedMutationTargets(manifest: BundleManifest, targetRoot: string, state: InstalledState): string[] {
  const baseline = state.installed_file_hashes ?? {};
  const definitions = state.installed_mutation_hashes ?? {};
  const currentDefinitions = mutationHashes(manifest);
  return [...mutationsByTarget(manifest).keys()]
    .filter((target) => {
      const dest = targetPath(targetRoot, target);
      return baseline[target] && definitions[target] === currentDefinitions[target]
        && existsSync(dest) && statSync(dest).isFile()
        && fileContentHash(dest, target, declaredSelfManifestSource(manifest)) !== baseline[target];
    })
    .sort();
}

function inventoryPaths(manifest: BundleManifest): string[] {
  const out = new Set<string>();
  for (const file of manifest.files) out.add(targetPathFromEntry(file));
  for (const mutation of manifest.mutations ?? []) out.add(mutationPath(mutation));
  return [...out].sort();
}

function fileContentHash(path: string, source = path.split(/[\\/]/).pop()!, selfManifestSource?: string): string {
  const hash = createHash("sha256");
  hash.update(normalizedBundleHashBytes(source, readFileSync(path), selfManifestSource ? [selfManifestSource] : []));
  return hash.digest("hex");
}

// A manifest path is identity-bearing only when it is also a declared payload
// source.  Loading `fixtures/skill-bundle-manifest.json` as the control file
// must not magically normalize an unrelated declared payload merely because of
// its filename.  This mirrors the installer/hosted explicit-provenance rule.
function declaredSelfManifestSource(manifest: BundleManifest): string | undefined {
  const source = manifest._manifestSource;
  if (!source) return undefined;
  return manifest.files.some((entry) => sourcePathFromEntry(entry) === source) ? source : undefined;
}

function installedFileHashes(
  manifest: BundleManifest,
  sourceRoot: string,
  targetRoot: string,
  current: InstalledState | null,
  skipTargets: Set<string>,
  keptLocalMutationTargets: Set<string>,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const target of inventoryPaths(manifest)) {
    // A kept mutation has no trustworthy upstream post-mutation baseline. Do
    // not manufacture one from the local target (or from a hypothetical
    // candidate): it must be reconsidered if its mutation definition changes.
    if (keptLocalMutationTargets.has(target)) continue;
    if (skipTargets.has(target)) {
      const prior = current?.installed_file_hashes?.[target];
      if (prior) { hashes[target] = prior; continue; }
      const file = manifest.files.find((entry) => targetPathFromEntry(entry) === target);
      if (file) {
        const source = targetPath(sourceRoot, sourcePathFromEntry(file));
        if (existsSync(source) && statSync(source).isFile()) hashes[target] = fileContentHash(source, sourcePathFromEntry(file), declaredSelfManifestSource(manifest));
      }
      continue;
    }
    const abs = targetPath(targetRoot, target);
    if (existsSync(abs) && statSync(abs).isFile()) {
      const file = manifest.files.find((entry) => targetPathFromEntry(entry) === target);
      hashes[target] = fileContentHash(abs, file ? sourcePathFromEntry(file) : target, file ? declaredSelfManifestSource(manifest) : undefined);
    }
  }
  return hashes;
}

async function resolveConflict(policy: ConflictPolicy, target: string): Promise<Exclude<ConflictPolicy, "prompt">> {
  if (policy !== "prompt") return policy;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Conflict at ${target}; choose keep, theirs, or fail [fail]: `)).trim();
    return answer === "keep" || answer === "theirs" ? answer : "fail";
  } finally {
    rl.close();
  }
}

async function selectInstallTargets(
  manifest: BundleManifest,
  sourceRoot: string,
  targetRoot: string,
  current: InstalledState | null,
  policy: ConflictPolicy,
  dryRun: boolean,
  force: boolean,
): Promise<{ skipTargets: Set<string>; keptLocalMutationTargets: Set<string> }> {
  const skip = new Set<string>();
  // This set represents an explicit operator ownership decision only. Automatic
  // local-adaptation detection still skips the mutation, but must retain the
  // managed baseline and mutation definition for a later revert or update.
  const keptLocalMutationTargets = new Set<string>();
  const baseline = current?.installed_file_hashes ?? {};
  const installedMutationHashes = current?.installed_mutation_hashes ?? {};
  const keptLocalMutationHashes = current?.kept_local_mutation_hashes ?? {};
  const currentMutationHashes = mutationHashes(manifest);
  const conflicts: string[] = [];
  const mutationPaths = new Set((manifest.mutations ?? []).map(mutationPath));
  for (const entry of manifest.files) {
    const target = targetPathFromEntry(entry);
    const source = targetPath(sourceRoot, sourcePathFromEntry(entry));
    const dest = targetPath(targetRoot, target);
    if (!existsSync(source) || !existsSync(dest) || !statSync(source).isFile() || !statSync(dest).isFile()) continue;
    // A source-root-equals-target-root self-install leaves this exact file in
    // place; it is not an overwrite of independently adapted local content.
    if (source === dest) { skip.add(target); continue; }
    const prior = baseline[target];
    if (force) continue;
    if (!prior) {
      if (fileContentHash(dest, sourcePathFromEntry(entry), declaredSelfManifestSource(manifest)) === fileContentHash(source, sourcePathFromEntry(entry), declaredSelfManifestSource(manifest))) continue;
      // A legacy installation — including a first install over an existing
      // target — cannot prove that the file is untouched. Treat it as a
      // conflict rather than silently destroying a local adaptation.
      const choice = await resolveConflict(policy, target);
      if (choice === "keep") { skip.add(target); continue; }
      if (choice === "theirs") continue;
      conflicts.push(target);
      if (!dryRun) {
        ensureParent(`${dest}.bundle-new`);
        cpSync(source, `${dest}.bundle-new`);
      }
      continue;
    }
    const local = fileContentHash(dest, sourcePathFromEntry(entry), declaredSelfManifestSource(manifest));
    const upstream = fileContentHash(source, sourcePathFromEntry(entry), declaredSelfManifestSource(manifest));
    // Both sides independently converged to the same bytes. This is a
    // no-op, but leave it eligible for apply so state advances the common
    // three-way ancestor to those bytes.
    if (local === upstream) continue;
    if (local === prior || upstream === prior) {
      if (upstream === prior && local !== prior) skip.add(target); // local-only adaptation
      continue;
    }
    const choice = await resolveConflict(policy, target);
    if (choice === "keep") { skip.add(target); continue; }
    if (choice === "theirs") continue;
    conflicts.push(target);
    if (!dryRun) {
      ensureParent(`${dest}.bundle-new`);
      cpSync(source, `${dest}.bundle-new`);
    }
  }
  for (const [target, mutations] of mutationsByTarget(manifest)) {
    const dest = targetPath(targetRoot, target);
    if (!existsSync(dest) || !statSync(dest).isFile()) continue;
    const prior = baseline[target];
    // Keep is a deliberate ownership decision. Preserve it only while the
    // exact mutation definition is unchanged; a different definition must be
    // reconsidered below instead of being silently treated as already applied.
    if (!force && keptLocalMutationHashes[target] === currentMutationHashes[target]) {
      skip.add(target);
      keptLocalMutationTargets.add(target);
      continue;
    }
    // Mutations are transformations, rather than an upstream source file. If
    // their definition has not changed, a differing target is local-only
    // adaptation (including json_set's formatting rewrite) and must not turn
    // into a spurious conflict on an unrelated bundle upgrade.
    if (!force && prior && installedMutationHashes[target] === currentMutationHashes[target] && fileContentHash(dest, target, declaredSelfManifestSource(manifest)) !== prior) {
      skip.add(target);
      continue;
    }
    if (prior && fileContentHash(dest, target, declaredSelfManifestSource(manifest)) === prior) continue;
    if (!mutationWouldChange(mutations, targetRoot, dest)) continue;
    if (force) continue;
    const choice = await resolveConflict(policy, target);
    if (choice === "keep") {
      skip.add(target);
      keptLocalMutationTargets.add(target);
      continue;
    }
    if (choice === "theirs") continue;
    conflicts.push(target);
    if (!dryRun) writeMutationCandidate(mutations, targetRoot, dest);
  }
  if (conflicts.length > 0) {
    throw new Error(`Local/upstream conflict(s): ${conflicts.join(", ")}.${dryRun ? " No candidates written during dry run." : " Wrote upstream candidates as .bundle-new"}`);
  }
  return { skipTargets: skip, keptLocalMutationTargets };
}

function assertNoFileMutationOverlap(manifest: BundleManifest): void {
  const mutationPaths = new Set((manifest.mutations ?? []).map(mutationPath));
  const overlappingTargets = manifest.files
    .map(targetPathFromEntry)
    .filter((target) => mutationPaths.has(target));
  if (overlappingTargets.length > 0) {
    throw new Error(`Manifest cannot combine file entries and mutations for the same target(s): ${[...new Set(overlappingTargets)].join(", ")}`);
  }
}

function computeBundleHash(manifest: BundleManifest, sourceRoot: string): string {
  const files: BundleFileEntry[] = [];
  for (const file of manifest.files) {
    if (!includeBundleHashFile(file, manifest.bundle_type)) continue;
    const sourceRel = sourcePathFromEntry(file);
    const abs = targetPath(sourceRoot, sourceRel);
    if (!existsSync(abs)) {
      if (file.required) die(`Required source file missing: ${sourceRel}`);
      continue;
    }
    const stats = statSync(abs);
    if (!stats.isFile()) die(`Bundle file must be a file, not a directory: ${sourceRel}`);
    files.push(file);
  }
  return computeCanonicalBundleHash(files, {
    bundleType: manifest.bundle_type,
    readFile: (file) => readFileSync(targetPath(sourceRoot, sourcePathFromEntry(file as BundleFileEntry))),
    mutations: manifest.mutations ?? [],
    validationCommands: manifest.validation?.commands ?? [],
    dependencies: manifest.dependencies ?? {},
    selfManifestSources: declaredSelfManifestSource(manifest) ? [declaredSelfManifestSource(manifest)!] : [],
  });
}

function readInstalledState(targetRoot: string, manifest: BundleManifest): InstalledState | null {
  const path = targetPath(targetRoot, manifest.install.state_file);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as InstalledState;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function backupBundle(
  manifest: BundleManifest,
  targetRoot: string,
  backupVersionId: string,
  dryRun: boolean,
): { backupDir: string; entries: BackupEntry[] } {
  const backupDir = targetPath(
    targetRoot,
    join(manifest.install.backup_root, sanitizeVersionId(backupVersionId)),
  );
  if (existsSync(backupDir)) {
    throw new Error("Bundle backup destination already exists; refusing to overwrite prior rollback evidence");
  }
  const entries: BackupEntry[] = [];
  let incompleteGeneration = false;
  try {
    for (const path of inventoryPaths(manifest)) {
      const absTarget = targetPath(targetRoot, path);
      const exists = existsSync(absTarget);
      entries.push({ path, existed: exists });
      if (!exists || dryRun) continue;
      incompleteGeneration = true;
      const absBackup = join(backupDir, path);
      ensureParent(absBackup);
      cpSync(absTarget, absBackup);
    }

    if (!dryRun) {
      incompleteGeneration = true;
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, "backup-metadata.json"), JSON.stringify({ entries }, null, 2) + "\n", "utf8");
      incompleteGeneration = false;
    }
  } catch (error) {
    if (incompleteGeneration) rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }

  return { backupDir, entries };
}

function applyBundle(manifest: BundleManifest, sourceRoot: string, targetRoot: string, dryRun: boolean, skipTargets = new Set<string>()): void {
  for (const file of manifest.files) {
    const sourceRel = sourcePathFromEntry(file);
    const targetRel = targetPathFromEntry(file);
    if (skipTargets.has(targetRel)) continue;
    const source = targetPath(sourceRoot, sourceRel);
    if (!existsSync(source)) {
      if (file.required) die(`Required source file missing during apply: ${sourceRel}`);
      continue;
    }
    if (dryRun) continue;
    const dest = targetPath(targetRoot, targetRel);
    ensureParent(dest);
    cpSync(source, dest);
  }
  for (const mutation of manifest.mutations ?? []) {
    if (skipTargets.has(mutationPath(mutation))) continue;
    applyMutation(mutation, targetRoot, dryRun);
  }
}

function writeMutationCandidate(mutations: BundleMutation[], targetRoot: string, dest: string): void {
  const candidateRoot = mkdtempSync(join(tmpdir(), "agentbootup-mutation-candidate-"));
  try {
    const candidate = targetPath(candidateRoot, mutationPath(mutations[0]!));
    ensureParent(candidate);
    cpSync(dest, candidate);
    applyMutations(mutations, candidateRoot, false);
    if (existsSync(candidate)) {
      ensureParent(`${dest}.bundle-new`);
      cpSync(candidate, `${dest}.bundle-new`);
    }
  } finally {
    rmSync(candidateRoot, { recursive: true, force: true });
  }
}

function mutationWouldChange(mutations: BundleMutation[], targetRoot: string, dest: string): boolean {
  const candidateRoot = mkdtempSync(join(tmpdir(), "agentbootup-mutation-check-"));
  try {
    const candidate = targetPath(candidateRoot, mutationPath(mutations[0]!));
    ensureParent(candidate);
    cpSync(dest, candidate);
    applyMutations(mutations, candidateRoot, false);
    return !existsSync(candidate) || fileContentHash(candidate, mutations[0]!.path) !== fileContentHash(dest, mutations[0]!.path);
  } finally {
    rmSync(candidateRoot, { recursive: true, force: true });
  }
}

function applyMutations(mutations: BundleMutation[], targetRoot: string, dryRun: boolean): void {
  for (const mutation of mutations) applyMutation(mutation, targetRoot, dryRun);
}

function applyMutation(mutation: BundleMutation, targetRoot: string, dryRun: boolean): void {
  const dest = targetPath(targetRoot, mutation.path);
  switch (mutation.type) {
    case "append_block_if_missing": {
      const required = mutation.required ?? true;
      if (!existsSync(dest)) {
        if (!required) return;
        if (dryRun) return;
        ensureParent(dest);
        writeFileSync(dest, mutation.content.endsWith("\n") ? mutation.content : mutation.content + "\n", "utf8");
        return;
      }
      const current = readFileSync(dest, "utf8");
      const match = mutation.match ?? mutation.content;
      if (current.includes(match)) return;
      if (dryRun) return;
      const prefix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
      const block = mutation.content.endsWith("\n") ? mutation.content : mutation.content + "\n";
      writeFileSync(dest, current + prefix + block, "utf8");
      return;
    }
    case "json_set": {
      const required = mutation.required ?? true;
      if (!existsSync(dest)) {
        if (!required) return;
        if (dryRun) return;
        ensureParent(dest);
        writeFileSync(dest, "{}\n", "utf8");
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>;
      } catch (error) {
        die(`Failed to parse JSON for mutation at ${mutation.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      let cursor: Record<string, unknown> = parsed;
      for (let i = 0; i < mutation.key_path.length - 1; i++) {
        const key = mutation.key_path[i]!;
        const next = cursor[key];
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          cursor[key] = {};
        }
        cursor = cursor[key] as Record<string, unknown>;
      }
      cursor[mutation.key_path[mutation.key_path.length - 1]!] = mutation.value;
      if (dryRun) return;
      writeFileSync(dest, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      return;
    }
    default:
      return;
  }
}

async function runValidation(manifest: BundleManifest, targetRoot: string, dryRun: boolean): Promise<void> {
  const commands = manifest.validation?.commands ?? [];
  for (const command of commands) {
    console.log(`• validate: ${command}`);
    if (dryRun) continue;
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: targetRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (stdout.trim()) console.log(stdout.trim());
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `Validation failed: ${command}`);
    }
  }
}

function writeInstalledState(targetRoot: string, manifest: BundleManifest, state: InstalledState, dryRun: boolean): void {
  const statePath = targetPath(targetRoot, manifest.install.state_file);
  if (dryRun) return;
  ensureParent(statePath);
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function restoreBackup(
  manifest: BundleManifest,
  targetRoot: string,
  backupDir: string,
  entries: BackupEntry[],
  dryRun: boolean,
): void {
  for (const entry of entries) {
    const target = targetPath(targetRoot, entry.path);
    const backup = join(backupDir, entry.path);
    if (entry.existed) {
      if (dryRun) continue;
      if (!existsSync(backup)) die(`Backup file missing during rollback: ${safeRel(targetRoot, backup)}`);
      ensureParent(target);
      cpSync(backup, target);
    } else if (existsSync(target)) {
      if (!dryRun) rmSync(target, { force: true });
    }
  }
}

async function cmdStatus(manifest: BundleManifest, sourceRoot: string, targetRoot: string): Promise<void> {
  const computedHash = computeBundleHash(manifest, sourceRoot);
  const state = readInstalledState(targetRoot, manifest);
  console.log(`skill:        ${manifest.skill}`);
  console.log(`version:      ${manifest.bundle_version}`);
  console.log(`version_id:   ${manifest.version_id}`);
  console.log(`distribution: ${manifest.distribution?.mode ?? "unknown"}`);
  console.log(`source_root:  ${sourceRoot}`);
  console.log(`target_root:  ${targetRoot}`);
  console.log(`file_count:   ${manifest.files.length}`);
  console.log(`manifest_hash:${manifest.bundle_hash}`);
  console.log(`actual_hash:  ${computedHash}`);
  if (manifest.bundle_hash !== computedHash) {
    console.log("hash_status:  DRIFT");
  } else {
    console.log("hash_status:  OK");
  }
  if (!state) {
    console.log("installed:    no");
    return;
  }
  console.log(`installed:    yes`);
  console.log(`state.status: ${state.status}`);
  console.log(`state.version:${state.installed_version ?? "(none)"}`);
  console.log(`state.id:     ${state.version_id ?? "(none)"}`);
  console.log(`backup_path:  ${state.backup_path ?? "(none)"}`);
  if ((state.kept_local_mutation_targets?.length ?? 0) > 0) {
    console.log(`kept_local_mutation_targets: ${state.kept_local_mutation_targets!.join(", ")}`);
  }
  const adaptedMutationTargets = locallyAdaptedMutationTargets(manifest, targetRoot, state);
  if (adaptedMutationTargets.length > 0) {
    console.log(`locally_adapted_mutation_targets: ${adaptedMutationTargets.join(", ")}`);
  }
}

async function cmdInstall(
  manifest: BundleManifest,
  sourceRoot: string,
  targetRoot: string,
  force: boolean,
  dryRun: boolean,
  onConflict: ConflictPolicy,
): Promise<void> {
  const computedHash = computeBundleHash(manifest, sourceRoot);
  if (computedHash !== manifest.bundle_hash) {
    die(
      `Bundle hash mismatch.\nExpected: ${manifest.bundle_hash}\nActual:   ${computedHash}\nRefuse install until manifest is updated.`,
    );
  }

  // Reject impossible ownership before creating a backup or touching the
  // target. The installer cannot safely decide whether copy or mutation owns
  // a shared path.
  assertNoFileMutationOverlap(manifest);

  const current = readInstalledState(targetRoot, manifest);
  if (!force && current?.version_id === manifest.version_id) {
    console.log(`Already installed: ${manifest.version_id}`);
    return;
  }

  const priorVersionId = current?.version_id ?? `preinstall-${new Date().toISOString().replace(/[:]/g, "-")}`;
  const backupVersionId = `${priorVersionId}-attempt-${randomUUID()}`;
  const { backupDir, entries } = backupBundle(manifest, targetRoot, backupVersionId, dryRun);

  console.log(`Installing ${manifest.version_id}`);
  console.log(`• source: ${sourceRoot}`);
  console.log(`• target: ${targetRoot}`);
  console.log(`• backup: ${safeRel(targetRoot, backupDir)}`);

  try {
    const { skipTargets, keptLocalMutationTargets } = await selectInstallTargets(manifest, sourceRoot, targetRoot, current, onConflict, dryRun, force);
    applyBundle(manifest, sourceRoot, targetRoot, dryRun, skipTargets);
    await runValidation(manifest, targetRoot, dryRun);

    const nextState: InstalledState = {
      skill: manifest.skill,
      installed_version: manifest.bundle_version,
      version_id: manifest.version_id,
      bundle_hash: manifest.bundle_hash,
      source_repo: manifest.source.repo,
      applied_at: dryRun ? null : new Date().toISOString(),
      previous_version: current?.installed_version ?? null,
      previous_version_id: current?.version_id ?? null,
      previous_installed_file_hashes: current?.installed_file_hashes,
      previous_installed_mutation_hashes: current?.installed_mutation_hashes,
      previous_kept_local_mutation_targets: current?.kept_local_mutation_targets,
      previous_kept_local_mutation_hashes: current?.kept_local_mutation_hashes,
      backup_path: safeRel(targetRoot, backupDir),
      // Record the post-apply upstream baseline, not a kept local file. A
      // `keep` decision retains its prior hash so the three-way ancestor
      // remains available on the next update; mutation targets use their
      // post-mutation bytes as that baseline.
      installed_file_hashes: dryRun ? undefined : installedFileHashes(manifest, sourceRoot, targetRoot, current, skipTargets, keptLocalMutationTargets),
      installed_mutation_hashes: dryRun ? undefined : Object.fromEntries(
        Object.entries(mutationHashes(manifest)).filter(([target]) => !keptLocalMutationTargets.has(target)),
      ),
      kept_local_mutation_targets: dryRun ? undefined : [...keptLocalMutationTargets].sort(),
      kept_local_mutation_hashes: dryRun ? undefined : Object.fromEntries(
        [...keptLocalMutationTargets].sort().map((target) => [target, mutationHashes(manifest)[target]!]),
      ),
      status: "applied",
    };
    writeInstalledState(targetRoot, manifest, nextState, dryRun);
    console.log(dryRun ? "Dry run complete." : "Install complete.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Install failed: ${message}`);
    console.error("Restoring previous bundle from backup...");
    restoreBackup(manifest, targetRoot, backupDir, entries, dryRun);

    const rolledBackState: InstalledState = {
      skill: manifest.skill,
      installed_version: current?.installed_version ?? null,
      version_id: current?.version_id ?? null,
      bundle_hash: current?.bundle_hash ?? null,
      source_repo: current?.source_repo ?? manifest.source.repo,
      applied_at: current?.applied_at ?? null,
      previous_version: current?.previous_version ?? null,
      previous_version_id: current?.previous_version_id ?? null,
      previous_installed_file_hashes: current?.previous_installed_file_hashes,
      previous_installed_mutation_hashes: current?.previous_installed_mutation_hashes,
      previous_kept_local_mutation_targets: current?.previous_kept_local_mutation_targets,
      previous_kept_local_mutation_hashes: current?.previous_kept_local_mutation_hashes,
      kept_local_mutation_targets: current?.kept_local_mutation_targets,
      kept_local_mutation_hashes: current?.kept_local_mutation_hashes,
      backup_path: safeRel(targetRoot, backupDir),
      installed_file_hashes: current?.installed_file_hashes,
      installed_mutation_hashes: current?.installed_mutation_hashes,
      status: current ? "rolled_back" : "failed",
      last_attempt: {
        version_id: manifest.version_id,
        bundle_version: manifest.bundle_version,
        ...(current ? { rolled_back_at: new Date().toISOString() } : { failed_at: new Date().toISOString() }),
        error: message,
      },
    };
    writeInstalledState(targetRoot, manifest, rolledBackState, dryRun);
    process.exit(1);
  }
}

async function cmdRollback(manifest: BundleManifest, targetRoot: string, dryRun: boolean): Promise<void> {
  const current = readInstalledState(targetRoot, manifest);
  if (!current?.backup_path) die(`No backup_path recorded for ${manifest.skill}`);
  const backupDir = targetPath(targetRoot, current.backup_path);
  if (!existsSync(backupDir)) die(`Backup directory not found: ${backupDir}`);

  const metaPath = join(backupDir, "backup-metadata.json");
  if (!existsSync(metaPath)) die(`Backup metadata missing: ${metaPath}`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { entries: BackupEntry[] };

  console.log(`Rolling back ${manifest.skill}`);
  console.log(`• target: ${targetRoot}`);
  console.log(`• backup: ${current.backup_path}`);

  restoreBackup(manifest, targetRoot, backupDir, meta.entries, dryRun);

  const nextState: InstalledState = {
    skill: manifest.skill,
    installed_version: current.previous_version ?? null,
    version_id: current.previous_version_id ?? null,
    bundle_hash: null,
    source_repo: current.source_repo,
    applied_at: current.applied_at,
    previous_version: null,
    previous_version_id: null,
    previous_installed_file_hashes: undefined,
    previous_installed_mutation_hashes: undefined,
    previous_kept_local_mutation_targets: undefined,
    previous_kept_local_mutation_hashes: undefined,
    backup_path: current.backup_path,
    installed_file_hashes: current.previous_installed_file_hashes,
    installed_mutation_hashes: current.previous_installed_mutation_hashes,
    kept_local_mutation_targets: current.previous_kept_local_mutation_targets,
    kept_local_mutation_hashes: current.previous_kept_local_mutation_hashes,
    status: "rolled_back",
    last_attempt: {
      version_id: current.version_id ?? manifest.version_id,
      bundle_version: current.installed_version ?? manifest.bundle_version,
      rolled_back_at: new Date().toISOString(),
    },
  };
  writeInstalledState(targetRoot, manifest, nextState, dryRun);
  console.log(dryRun ? "Dry run rollback complete." : "Rollback complete.");
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help || parsed.command === "help") {
    console.log(usage());
    return;
  }

  const { manifest, manifestPath } = loadManifest(parsed.manifestPath, parsed.sourceRoot);
  console.log(`Manifest: ${manifestPath}`);

  switch (parsed.command) {
    case "status":
      await cmdStatus(manifest, parsed.sourceRoot, parsed.targetRoot);
      break;
    case "install":
      await cmdInstall(manifest, parsed.sourceRoot, parsed.targetRoot, parsed.force, parsed.dryRun, parsed.onConflict);
      break;
    case "rollback":
      await cmdRollback(manifest, parsed.targetRoot, parsed.dryRun);
      break;
    default:
      console.log(usage());
      process.exit(1);
  }
}

await main();
