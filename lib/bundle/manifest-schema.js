/**
 * Manifest schema validation — PRD-0047 §7 / Task 2.
 *
 * `schemas/skill-bundle-manifest.schema.json` is the published, external-consumable
 * contract. This module enforces the same contract fail-closed in code (the repo
 * convention is hand-written focused validators, not a runtime JSON-Schema engine —
 * see lib/network/env/schema.js), so `bundle publish` and `bundle install` refuse a
 * non-conforming manifest at both ends.
 *
 * Two contract facts this file exists to hold the line on:
 *   1. `distribution.mode` and `projection.mode` are DIFFERENT namespaces. A
 *      `projection.mode` value (`repo_materialization`) must never be accepted as a
 *      `distribution.mode`, and vice-versa. Conflating them let a stale CLAUDE.md
 *      sentence contradict real behavior for months.
 *   2. Path authority: every manifest source/target/mutation path is preflighted
 *      through ONE shared containment helper (`assertContainedRelativePath`). No
 *      command-local path validator is permitted (Task 2.1a). Absolute, NUL-bearing,
 *      and traversal paths are rejected before normalization.
 *
 * Legacy aliases (`skill` -> `bundle_name`; file `path` -> `source`/`target`) are
 * BLESSED-AND-DEPRECATED: accepted so existing manifests keep installing, but
 * `collectManifestSchemaWarnings` surfaces them at publish so the two readers
 * (installer vs census) can never silently disagree about what is valid. Migrating
 * the aliases out is a Phase-2 follow-up, not this task.
 */

import path from 'path';
import semver from 'semver';
import { assertContainedRelativePath } from '../util/contained-path.js';

// Single source of truth for the bundle-manifest enums/denylist. installer.js imports
// these rather than redefining them, so the two validators can never silently diverge —
// the exact "two readers disagree" failure this module exists to prevent.
export const VALID_BUNDLE_TYPES = new Set(['skill_bundle', 'protocol_bundle', 'memory_snapshot']);
export const VALID_DISTRIBUTION_MODES = new Set(['direct_sync', 'self_apply', 'snapshot']);
export const VALID_FILE_ROLES = new Set([
  'entrypoint',
  'reference',
  'manifest',
  'wrapper',
  'eval',
  'canonical-protocol',
  'portable_materialized',
  'runtime',
  'canonical-runtime',
  'runtime-library',
  // WO msg-1784803031106-5b7jf2 §2 — bundle integrity contract file classes:
  'required_data',    // runtime data file that MUST exist at target after install;
  'generated_state',  // runtime state created at runtime, NOT required at install.
]);

/** WO §2: roles that describe runtime state, not bundle content. NOT in the
 *  source bundle (created at runtime), NOT part of the bundle hash. The installer
 *  skips them at source-check time and handles them at verify time. */
export const RUNTIME_STATE_ROLES = new Set(['required_data', 'generated_state']);
export const VALID_MEMORY_SNAPSHOT_FILE_ROLES = new Set([...VALID_FILE_ROLES, 'state_seed']);
export const VALID_PROJECTION_MODES = new Set(['repo_materialization']);
export const VALID_MUTATION_TYPES = new Set(['append_block_if_missing', 'json_set']);
// Prototype-pollution denylist for json_set key_path segments.
export const FORBIDDEN_KEY_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const BUNDLE_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isValidNpmPackageName(value) {
  return typeof value === 'string' && NPM_PACKAGE_NAME_RE.test(value);
}

export function isValidNpmVersionRange(value) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) return false;
  const trimmed = value.trim();
  // Bundle dependencies are registry packages, not arbitrary local paths or git URLs.
  // That keeps hosted bundle manifests from turning installation into code execution.
  if (
    /^(?:file:|link:|git\+|https?:|github:|git@)/i.test(trimmed) ||
    /^[a-z][a-z+.-]*:/i.test(trimmed) ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    /\s/.test(trimmed)
  ) {
    return false;
  }
  return semver.valid(trimmed) != null ||
    semver.validRange(trimmed, { loose: false }) != null;
}

export class ManifestSchemaError extends Error {
  constructor(errors, label) {
    const scope = label ? ` (${label})` : '';
    super(`Manifest failed schema validation${scope}:\n  - ${errors.join('\n  - ')}`);
    this.name = 'ManifestSchemaError';
    this.errors = errors;
  }
}

/**
 * The single shared containment helper now lives in `lib/util/contained-path.js`
 * so non-bundle contracts (`brain-runtime-manifest/2`) can enforce the same gate
 * without importing this module's dependency graph. Re-exported here because
 * PRD-0047 §7 clause 9 names `assertContainedRelativePath` as the path authority
 * and existing callers import it from this module.
 */
export { assertContainedRelativePath };

function checkContained(value, label, errors) {
  try {
    assertContainedRelativePath(value, label);
  } catch (err) {
    errors.push(err.message);
  }
}

/**
 * Resolve the effective bundle name, honoring the deprecated `skill` alias.
 * Returns null when neither is present (a hard error, reported by the caller).
 */
export function resolveBundleName(rawManifest) {
  if (!rawManifest || typeof rawManifest !== 'object') return null;
  const name = rawManifest.bundle_name ?? rawManifest.skill;
  return typeof name === 'string' && name.trim() ? name : null;
}

/**
 * Resolve the effective bundle_type, honoring the deprecated `skill` alias exactly as
 * the installer does (`installer.js`: a manifest carrying `skill` but no explicit
 * `bundle_type` is a skill bundle). Validating the effective type — not the literal
 * field — keeps this validator from being stricter than the installer it guards.
 */
export function resolveBundleType(rawManifest) {
  if (!rawManifest || typeof rawManifest !== 'object') return null;
  return rawManifest.bundle_type ?? (rawManifest.skill ? 'skill_bundle' : null);
}

/**
 * Structural validation of a raw (pre-normalization) manifest. Throws
 * ManifestSchemaError with an aggregated error list on any violation. Accepts a
 * manifest that has already been normalized (its shape is a strict subset of valid).
 */
export function validateManifestSchema(rawManifest, options = {}) {
  const label = options.label ?? null;
  const errors = [];

  if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)) {
    throw new ManifestSchemaError(['manifest must be a JSON object'], label);
  }

  // Identity ------------------------------------------------------------------
  if (!resolveBundleName(rawManifest)) {
    errors.push('bundle_name is required (or the deprecated `skill` alias)');
  }
  if (!VALID_BUNDLE_TYPES.has(resolveBundleType(rawManifest))) {
    errors.push(`bundle_type must be one of: ${[...VALID_BUNDLE_TYPES].join(', ')}`);
  }
  for (const field of ['bundle_version', 'version_id']) {
    const v = rawManifest[field];
    if (typeof v !== 'string' || !v.trim()) {
      errors.push(`${field} is required and must be a non-empty string`);
    }
  }
  if (typeof rawManifest.bundle_hash !== 'string' || !BUNDLE_HASH_RE.test(rawManifest.bundle_hash)) {
    errors.push('bundle_hash is required and must match sha256:<64 hex>');
  }
  // `metadata.version` is the PRD-§7 human-version name; the live field is
  // top-level `bundle_version`. If metadata.version is present it must be a string,
  // but it is intentionally not required (fleet migration is decisive's call).
  if (rawManifest.metadata != null) {
    if (typeof rawManifest.metadata !== 'object' || Array.isArray(rawManifest.metadata)) {
      errors.push('metadata must be an object when present');
    } else if (
      rawManifest.metadata.version != null &&
      (typeof rawManifest.metadata.version !== 'string' || !rawManifest.metadata.version.trim())
    ) {
      errors.push('metadata.version must be a non-empty string when present');
    }
  }

  // Runtime dependencies -----------------------------------------------------
  if (rawManifest.dependencies != null) {
    if (typeof rawManifest.dependencies !== 'object' || Array.isArray(rawManifest.dependencies)) {
      errors.push('dependencies must be an object when present');
    } else {
      for (const [name, range] of Object.entries(rawManifest.dependencies)) {
        if (!isValidNpmPackageName(name)) {
          errors.push(`dependencies.${name} must be a valid npm package name`);
        }
        if (!isValidNpmVersionRange(range)) {
          errors.push(`dependencies.${name} must be a non-empty registry npm version range`);
        }
      }
    }
  }

  // Mode namespaces — kept strictly separate ----------------------------------
  if (rawManifest.distribution != null && (typeof rawManifest.distribution !== 'object' || Array.isArray(rawManifest.distribution))) {
    errors.push('distribution must be an object when present');
  }
  const distMode = rawManifest.distribution?.mode;
  if (distMode != null && !VALID_DISTRIBUTION_MODES.has(distMode)) {
    // The most likely way to hit this is a projection value leaking into distribution.
    const hint = VALID_PROJECTION_MODES.has(distMode)
      ? ` — '${distMode}' is a projection.mode, not a distribution.mode; the two namespaces must not be crossed`
      : '';
    errors.push(`distribution.mode must be one of: ${[...VALID_DISTRIBUTION_MODES].join(', ')}${hint}`);
  }
  if (rawManifest.projection != null) {
    if (typeof rawManifest.projection !== 'object' || Array.isArray(rawManifest.projection)) {
      errors.push('projection must be an object when present');
    } else {
      const projMode = rawManifest.projection.mode;
      if (projMode != null && !VALID_PROJECTION_MODES.has(projMode)) {
        const hint = VALID_DISTRIBUTION_MODES.has(projMode)
          ? ` — '${projMode}' is a distribution.mode, not a projection.mode`
          : '';
        errors.push(`projection.mode must be one of: ${[...VALID_PROJECTION_MODES].join(', ')}${hint}`);
      }
      if (rawManifest.projection.targets != null) {
        if (!Array.isArray(rawManifest.projection.targets)) {
          errors.push('projection.targets must be an array when present');
        } else {
          rawManifest.projection.targets.forEach((t, i) =>
            checkContained(t, `projection.targets[${i}]`, errors),
          );
        }
      }
    }
  }

  // install / validation ------------------------------------------------------
  if (rawManifest.install != null) {
    if (typeof rawManifest.install !== 'object' || Array.isArray(rawManifest.install)) {
      errors.push('install must be an object when present');
    } else {
      for (const field of ['state_file', 'backup_root']) {
        if (rawManifest.install[field] != null) {
          checkContained(rawManifest.install[field], `install.${field}`, errors);
        }
      }
    }
  }
  if (rawManifest.validation != null && (typeof rawManifest.validation !== 'object' || Array.isArray(rawManifest.validation))) {
    errors.push('validation must be an object when present');
  }
  if (rawManifest.validation?.commands != null) {
    if (!Array.isArray(rawManifest.validation.commands)) {
      errors.push('validation.commands must be an array when present');
    } else {
      // These commands are executed for repo-authored manifests — validate raw item
      // types rather than let normalization silently String()-coerce them.
      rawManifest.validation.commands.forEach((cmd, i) => {
        if (typeof cmd !== 'string') {
          errors.push(`validation.commands[${i}] must be a string`);
        }
      });
    }
  }

  // mutations -----------------------------------------------------------------
  if (rawManifest.mutations != null) {
    if (!Array.isArray(rawManifest.mutations)) {
      errors.push('mutations must be an array when present');
    } else {
      rawManifest.mutations.forEach((m, i) => {
        if (!m || typeof m !== 'object') {
          errors.push(`mutations[${i}] must be an object`);
          return;
        }
        if (!VALID_MUTATION_TYPES.has(m.type)) {
          errors.push(`mutations[${i}].type must be one of: ${[...VALID_MUTATION_TYPES].join(', ')}`);
        }
        checkContained(m.path, `mutations[${i}].path`, errors);
        // json_set requires a key_path — enforce the same contract the installer's
        // normalizeMutation does, so a manifest cannot pass this gate and fail at
        // install (roborev finding: schema/validator/installer must agree end-to-end).
        if (m.type === 'json_set') {
          const kp = m.key_path;
          if (!Array.isArray(kp) || kp.length === 0) {
            errors.push(`mutations[${i}].key_path is required for json_set and must be a non-empty array`);
          } else {
            kp.forEach((seg, j) => {
              if (typeof seg !== 'string' || !seg.trim()) {
                errors.push(`mutations[${i}].key_path[${j}] must be a non-empty string`);
              } else if (FORBIDDEN_KEY_SEGMENTS.has(seg)) {
                errors.push(`mutations[${i}].key_path[${j}] is a forbidden key segment`);
              }
            });
          }
        }
      });
    }
  }

  // files ---------------------------------------------------------------------
  if (!Array.isArray(rawManifest.files) || rawManifest.files.length === 0) {
    errors.push('files must be a non-empty array');
  } else {
    const bundleType = resolveBundleType(rawManifest);
    const validFileRoles = bundleType === 'memory_snapshot'
      ? VALID_MEMORY_SNAPSHOT_FILE_ROLES
      : VALID_FILE_ROLES;
    rawManifest.files.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        errors.push(`files[${i}] must be an object`);
        return;
      }
      // Mirror the published schema's string-typed properties: an explicit null must not
      // be silently masked by the `?? entry.path` alias fallback. Without this, code accepts
      // { source: null, path: "x" } while the schema rejects it — reopening the drift this
      // PR closes. Omit the key to use the path alias; never set it to null.
      for (const field of ['source', 'target', 'path']) {
        if (entry[field] === null) {
          errors.push(`files[${i}].${field} must not be null (omit the key to use the path alias)`);
        }
      }
      if (entry.role !== undefined && entry.role !== null && !validFileRoles.has(entry.role)) {
        errors.push(`files[${i}].role must be one of: ${[...validFileRoles].join(', ')} (or null)`);
      }
      // WO §2: initializer — a script that creates a required_data file if absent.
      // Only valid with role: required_data. Must be a contained relative path.
      if (entry.initializer != null) {
        if (entry.role !== 'required_data') {
          errors.push(`files[${i}].initializer is only valid with role: required_data (found role: ${String(entry.role)})`);
        } else {
          checkContained(entry.initializer, `files[${i}].initializer`, errors);
        }
      }
      // WO §2 (roborev r16): reject non-boolean required values before applying
      // role-specific rules. A string "false" would bypass the generated_state/
      // required_data checks ("false" === false is false) but later be coerced by
      // normalizeFileEntry, defeating the fail-closed contract.
      if (entry.required !== undefined && typeof entry.required !== 'boolean') {
        errors.push(`files[${i}].required must be a boolean (found: ${typeof entry.required})`);
      }
      // WO §2: generated_state means "not required at install" — a manifest that
      // sets required: true on a generated_state file is contradictory and would
      // silently bypass the verify skip. Reject at schema validation time.
      if (entry.role === 'generated_state' && entry.required === true) {
        errors.push(`files[${i}].required must not be true for role: generated_state (generated_state is not required at install)`);
      }
      // WO §2 (roborev r9): required_data is ALWAYS required at install — the
      // installer treats it as required regardless of the boolean. Reject
      // required: false to avoid a schema/installer semantic mismatch.
      if (entry.role === 'required_data' && entry.required === false) {
        errors.push(`files[${i}].required must not be false for role: required_data (required_data is always required at install)`);
      }
      // WO §2: required_data without an initializer is a fail-closed contract — the
      // installer will refuse to complete if the file is absent at the target.
      // That's valid (it's the strictest form); just no auto-creation. No extra error.
      if (bundleType !== 'memory_snapshot' && entry.kind === 'state') {
        errors.push(`files[${i}].kind "state" is reserved for memory_snapshot bundles`);
      }
      const source = entry.source ?? entry.path;
      const target = entry.target ?? entry.path;
      if (!source) {
        errors.push(`files[${i}] must include source (or the deprecated \`path\` alias)`);
      } else {
        checkContained(source, `files[${i}].source`, errors);
      }
      if (!target) {
        errors.push(`files[${i}] must include target (or the deprecated \`path\` alias)`);
      } else {
        checkContained(target, `files[${i}].target`, errors);
      }
    });
  }

  // WO §2 (roborev r5): every initializer must reference a file entry's target —
  // the script must be bundled and installed, not just exist in the source tree.
  // Without this, runInitializers resolves the initializer against targetRoot and
  // fails because the script was never copied.
  // WO §2 (roborev r6): normalize both sides (path.normalize) so ./prefix and
  // backslash separators don't cause false rejections. Reject self-references
  // (initializer pointing at the required_data entry's own target).
  // WO §2 (roborev r8): path.normalize on POSIX doesn't canonicalize backslashes —
  // replace them with forward slashes first so cross-platform manifests compare.
  const canon = (p) => path.normalize(String(p).replace(/\\/g, '/'));
  if (Array.isArray(rawManifest.files)) {
    // WO §2 (roborev r15): detect duplicate targets — a Map keyed by target would
    // silently overwrite duplicates, hiding the wrong entry from the initializer
    // cross-file check. Reject upfront so the manifest is unambiguous.
    const seenTargets = new Set();
    rawManifest.files.forEach((entry, i) => {
      if (entry && typeof entry === 'object' && (entry.target ?? entry.path)) {
        const t = canon(entry.target ?? entry.path);
        if (seenTargets.has(t)) {
          errors.push(`files[${i}].target (${entry.target ?? entry.path}) is a duplicate — each target must be unique`);
        }
        seenTargets.add(t);
      }
    });
    // Build a map: canonical target → file entry, for cross-file validation.
    const targetMap = new Map();
    for (const e of rawManifest.files) {
      if (e && typeof e === 'object' && (e.target ?? e.path)) {
        targetMap.set(canon(e.target ?? e.path), e);
      }
    }
    rawManifest.files.forEach((entry, i) => {
      if (entry && typeof entry === 'object' && entry.initializer != null && entry.role === 'required_data') {
        const initNorm = canon(entry.initializer);
        const ownTarget = canon(entry.target ?? entry.path ?? '');
        if (initNorm === ownTarget) {
          errors.push(`files[${i}].initializer (${entry.initializer}) must not reference the required_data entry's own target — it must point to a distinct script`);
        } else {
          const referenced = targetMap.get(initNorm);
          if (!referenced) {
            errors.push(`files[${i}].initializer (${entry.initializer}) must match another file entry's target — the initializer script must be bundled and installed`);
          } else if (referenced.role && RUNTIME_STATE_ROLES.has(referenced.role)) {
            // WO §2 (roborev r7): the initializer must point to a file that is actually
            // copied during install. Runtime-state roles are skipped by applyBundle, so
            // an initializer pointing at another required_data/generated_state entry
            // would not be installed and runInitializers would fail.
            errors.push(`files[${i}].initializer (${entry.initializer}) must reference a non-runtime-state file entry (found role: ${String(referenced.role)}) — runtime-state files are not copied during install`);
          } else if (referenced.required === false) {
            // WO §2 (roborev r7): optional files may not be present in the source bundle,
            // so the initializer might not be installed. Require it to be required.
            errors.push(`files[${i}].initializer (${entry.initializer}) must reference a required file entry (found required: false) — optional files may not be installed`);
          } else {
            // WO §2 (roborev r13): the initializer must be an executable script.
            // Without this, a manifest could point at a .md file and fail at install
            // when Bun tries to execute it.
            const refTarget = referenced.target ?? referenced.path ?? '';
            const SCRIPT_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs'];
            if (!SCRIPT_EXTENSIONS.some(ext => refTarget.endsWith(ext))) {
              errors.push(`files[${i}].initializer (${entry.initializer}) must reference a script file (.ts/.js/.mjs/.cjs) — found: ${refTarget}`);
            }
          }
        }
      }
    });
  }

  if (errors.length > 0) {
    throw new ManifestSchemaError(errors, label);
  }
  return true;
}

/**
 * Non-fatal deprecation warnings (legacy aliases in use). Returned so publish can
 * surface them alongside taxonomy warnings — the aliases are valid, but leaving them
 * silent is what let installer and census disagree about validity.
 */
export function collectManifestSchemaWarnings(rawManifest) {
  const warnings = [];
  if (!rawManifest || typeof rawManifest !== 'object') return warnings;
  if (rawManifest.bundle_name == null && typeof rawManifest.skill === 'string') {
    warnings.push(
      `Deprecated: manifest uses \`skill\` as the bundle name. Add \`bundle_name\` — the \`skill\` alias is accepted for now but will be removed.`,
    );
  }
  if (Array.isArray(rawManifest.files)) {
    rawManifest.files.forEach((entry, i) => {
      if (entry && typeof entry === 'object' && entry.path != null && (entry.source == null || entry.target == null)) {
        warnings.push(
          `Deprecated: files[${i}] uses \`path\` as source/target. Set explicit \`source\` and \`target\` — the \`path\` alias is accepted for now but will be removed.`,
        );
      }
    });
  }
  return warnings;
}
