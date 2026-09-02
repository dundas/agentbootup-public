import fs from 'fs';
import path from 'path';
import {
  AGENTS_SKILL_TARGET_ROOT,
  CANONICAL_RUNTIME_SOURCE_ROOT,
  CANONICAL_SKILL_SOURCE_ROOT,
  loadBundleSourceRoots,
} from './roots-config.js';
import { RUNTIME_STATE_ROLES } from './manifest-schema.js';

const NON_DISTRIBUTED_SKILL_FILES = new Set(['skill-bundle-manifest.json', 'skill-bundle-extras.json']);

function listFilesRecursively(dir) {
  const out = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  };
  walk(dir);
  return out;
}

function listRelativeSkillFiles(skillDir) {
  if (!fs.existsSync(skillDir)) return [];
  return listFilesRecursively(skillDir).map((abs) => path.relative(skillDir, abs).replaceAll('\\', '/'));
}

export function hasAuthoredSkillContent(skillDir) {
  return listRelativeSkillFiles(skillDir).some((rel) => !NON_DISTRIBUTED_SKILL_FILES.has(rel));
}

export function listDeclaredSkillFiles(skillDir) {
  return listRelativeSkillFiles(skillDir).filter((rel) => !NON_DISTRIBUTED_SKILL_FILES.has(rel));
}

function skillInstallTarget(bundleName, relPath, installRoot) {
  return `${installRoot}/${bundleName}/${relPath}`;
}

function runtimeInstallTarget(bundleName, installRoot) {
  return `${installRoot}/${bundleName}.ts`;
}

function isDirectoryPath(absPath) {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function readFileBase64(absSource) {
  try {
    return fs.readFileSync(absSource).toString('base64');
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    if (code === 'ENOENT') {
      throw new Error(`Required source file missing while reading declared bundle roots: ${absSource}`);
    }
    throw error;
  }
}

function preferredEntry(a, b) {
  // Entry-level kinds collapse repo/runtime roots to "repo" so canonical-source
  // selection only distinguishes skill assets from runtime files.
  let canonicalSourceBase;
  if (a.kind === 'repo' || b.kind === 'repo') {
    canonicalSourceBase = CANONICAL_RUNTIME_SOURCE_ROOT;
  } else if (a.target.startsWith(`${AGENTS_SKILL_TARGET_ROOT}/`) && b.target.startsWith(`${AGENTS_SKILL_TARGET_ROOT}/`)) {
    canonicalSourceBase = AGENTS_SKILL_TARGET_ROOT;
  } else {
    canonicalSourceBase = CANONICAL_SKILL_SOURCE_ROOT;
  }
  const aPriority = a.source.startsWith(`${canonicalSourceBase}/`) ? 0 : 1;
  const bPriority = b.source.startsWith(`${canonicalSourceBase}/`) ? 0 : 1;
  if (aPriority !== bPriority) return aPriority < bPriority ? a : b;
  return a.source.localeCompare(b.source) <= 0 ? a : b;
}

export function collapseMirroredEntries(entries, conflictMessage) {
  const groups = new Map();
  for (const entry of entries) {
    const existing = groups.get(entry.target) ?? [];
    existing.push(entry);
    groups.set(entry.target, existing);
  }

  const deduped = [];
  for (const target of [...groups.keys()].sort()) {
    const group = groups.get(target);
    let chosen = group[0];
    for (let index = 1; index < group.length; index += 1) {
      const entry = group[index];
      if (readFileBase64(chosen.absSource) !== readFileBase64(entry.absSource)) {
        throw new Error(conflictMessage(chosen, entry));
      }
      chosen = preferredEntry(chosen, entry);
    }
    deduped.push(chosen);
  }

  return deduped;
}

export function collectDeclaredBundleEntries(repoRoot, bundleName, opts = {}) {
  const warnings = [];
  const bundleRoots = loadBundleSourceRoots(repoRoot, opts);
  const entries = [];
  const rootPresence = [];
  const hasCanonicalRuntimeRoot = bundleRoots.roots.some(
    (root) => root.kind === 'repo/runtime' && root.source === CANONICAL_RUNTIME_SOURCE_ROOT,
  );

  if (bundleRoots.mode === 'replace' && !hasCanonicalRuntimeRoot) {
    const canonicalRuntimePath = path.join(repoRoot, CANONICAL_RUNTIME_SOURCE_ROOT, `${bundleName}.ts`);
    if (fs.existsSync(canonicalRuntimePath)) {
      warnings.push(
        `[bundle report] runtime for '${bundleName}' exists at ${CANONICAL_RUNTIME_SOURCE_ROOT}/${bundleName}.ts but replace-mode roots omit the canonical repo/runtime root; this runtime is not being tracked.`,
      );
    }
  }

  for (const root of bundleRoots.roots) {
    const absSourceRoot = path.join(repoRoot, root.source);
    if (!fs.existsSync(absSourceRoot)) {
      rootPresence.push({
        kind: root.kind,
        source: root.source,
        target: root.target,
        present: false,
      });
      warnings.push(`[bundle report] declared bundle root '${root.source}' does not exist; skipping.`);
      continue;
    }
    if (!isDirectoryPath(absSourceRoot)) {
      rootPresence.push({
        kind: root.kind,
        source: root.source,
        target: root.target,
        present: false,
      });
      warnings.push(`[bundle report] declared bundle root '${root.source}' is not a directory; skipping.`);
      continue;
    }

    if (root.kind === 'skill') {
      const skillDir = path.join(absSourceRoot, bundleName);
      const present = hasAuthoredSkillContent(skillDir);
      rootPresence.push({
        kind: root.kind,
        source: root.source,
        target: root.target,
        present,
      });
      if (!present) continue;

      const files = listDeclaredSkillFiles(skillDir);
      for (const rel of files) {
        entries.push({
          source: `${root.source}/${bundleName}/${rel}`,
          target: skillInstallTarget(bundleName, rel, root.target),
          absSource: path.join(skillDir, rel),
          kind: 'skill',
          role: rel === 'SKILL.md' ? 'entrypoint' : 'reference',
        });
      }
      continue;
    }

    if (root.kind === 'repo/runtime') {
      const runtimePath = path.join(absSourceRoot, `${bundleName}.ts`);
      const present = fs.existsSync(runtimePath);
      rootPresence.push({
        kind: root.kind,
        source: root.source,
        target: root.target,
        present,
      });
      if (!present) continue;
      entries.push({
        source: `${root.source}/${bundleName}.ts`,
        target: runtimeInstallTarget(bundleName, root.target),
        absSource: runtimePath,
        kind: 'repo',
        role: 'runtime',
      });
    }
  }

  const collapsedEntries = collapseMirroredEntries(
    entries,
    (prior, entry) =>
      `Declared bundle roots for '${bundleName}' map different content to ${entry.target}: ${prior.source} and ${entry.source}`,
  ).sort((a, b) => a.target.localeCompare(b.target) || a.source.localeCompare(b.source));

  const skillPresence = rootPresence.filter((root) => root.kind === 'skill');
  const asymmetry =
    skillPresence.length > 1 &&
    skillPresence.some((root) => root.present) &&
    skillPresence.some((root) => !root.present)
      ? {
          present: skillPresence.filter((root) => root.present).map((root) => root.source),
          missing: skillPresence.filter((root) => !root.present).map((root) => root.source),
        }
      : null;

  return {
    configPath: bundleRoots.configPath,
    configMode: bundleRoots.mode,
    entries: collapsedEntries,
    warnings,
    asymmetry,
    roots: bundleRoots.roots,
  };
}

export function reportBundleManifest({ manifest, findings }) {
  const manifestEntries = new Map(
    manifest.files.map((file) => [`${file.source}\0${file.target}`, file]),
  );
  const declaredEntries = new Map(
    findings.entries.map((entry) => [`${entry.source}\0${entry.target}`, entry]),
  );

  const missingFiles = findings.entries.filter((entry) => !manifestEntries.has(`${entry.source}\0${entry.target}`));
  const undeclaredManifestFiles = manifest.files.filter(
    (file) => !RUNTIME_STATE_ROLES.has(file.role)
      && !declaredEntries.has(`${file.source}\0${file.target}`),
  );

  return {
    warnings: findings.warnings,
    asymmetry: findings.asymmetry,
    missingFiles,
    undeclaredManifestFiles,
    drift: missingFiles.length > 0 || undeclaredManifestFiles.length > 0,
  };
}
