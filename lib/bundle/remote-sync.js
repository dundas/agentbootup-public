import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@libsql/client';
import { readCredentials } from '../auth/credentials.js';
import { getAgentId } from '../project-config.js';
import { reindexSkillIndex } from '../brain/skill-index.js';
import { defaultBrainDbPath } from '../network/commands/brain-db.js';
import {
  computeInlineBundleHash,
  installBundle,
  normalizeBundleManifest,
  pruneHostedInitializerTargets,
  readBundleInstallState,
} from './installer.js';
import { RUNTIME_STATE_ROLES, assertContainedRelativePath, validateManifestSchema } from './manifest-schema.js';
import { readSelfManaged } from './self-managed.js';

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSelector(selector) {
  if (!selector) {
    throw new Error('bundle sync requires a selector (all | all-core | comma-separated bundle names)');
  }
  if (selector === 'all' || selector === 'all-core') return selector;
  const ids = splitCsv(selector);
  if (ids.length === 0) {
    throw new Error('bundle sync selector must not be empty');
  }
  return ids;
}

export async function requestHostedBundleSync({
  serverUrl,
  apiKey,
  targetRepoPath,
  targetAgentId,
  selector,
  dryRun = false,
  clis = undefined,
}) {
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/v1/skills/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      targetRepoPath,
      targetAgentId,
      skills: selector,
      options: {
        dryRun,
        ...(clis && clis.length > 0 ? { clis } : {}),
        capabilities: ['plural_self_manifest_sources'],
      },
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`hosted bundle sync failed: ${message}`);
  }

  if (!body?.data || typeof body.data !== 'object') {
    throw new Error('hosted bundle sync failed: invalid server response');
  }

  return body.data;
}

function resolveCliList(cliCsv) {
  const clis = splitCsv(cliCsv);
  if (clis.length === 0) return undefined;
  return clis;
}

function assertManifestFileCoverage(bundleName, manifest, fileMap) {
  const missing = manifest.files
    .filter((entry) => entry.required !== false)
    // WO §2: runtime-state roles are NOT in the source payload — skip coverage check.
    .filter((entry) => !entry.role || !RUNTIME_STATE_ROLES.has(entry.role))
    .map((entry) => entry.source)
    .filter((source) => typeof fileMap[source] !== 'string');
  if (missing.length > 0) {
    throw new Error(
      `hosted bundle payload for ${bundleName} is missing required file content for: ${missing.join(', ')}`,
    );
  }
}

function detectTargetConflicts(synced, io, disabledInitializerTargets = new Set()) {
  const seenFiles = new Map();
  const seenMutations = new Map();
  for (const item of synced) {
    let manifest;
    try {
      // Do not let an invalid item participate in global conflict planning.
      // The full per-bundle path below will report it as a failed result.
      validateManifestSchema(item.bundle_manifest, { label: `hosted bundle ${item.bundle_manifest?.bundle_name ?? 'unknown'}` });
      manifest = sanitizeHostedManifest(
        item.bundle_manifest,
        item.files ?? {},
        io,
        disabledInitializerTargets,
        item.self_manifest_source,
        item.self_manifest_sources,
        Object.hasOwn(item, 'self_manifest_sources'),
      );
    } catch {
      // Schema/normalization failures belong to the item's install result below.
      // Conflict planning must not turn one malformed hosted bundle into a
      // whole-sync abort before the per-bundle error boundary can classify it.
      continue;
    }
    const files = item.files ?? {};
    for (const entry of manifest.files) {
      const content = files[entry.source];
      if (typeof content !== 'string') continue;
      const prior = seenFiles.get(entry.target);
      if (!prior) {
        seenFiles.set(entry.target, { bundle: manifest.bundle_name, content });
        continue;
      }
      if (prior.content !== content) {
        throw new Error(
          `hosted bundle sync conflict: ${entry.target} differs between ${prior.bundle} and ${manifest.bundle_name}`,
        );
      }
    }
    for (const mutation of manifest.mutations ?? []) {
      const priorMutations = seenMutations.get(mutation.path) ?? [];
      for (const prior of priorMutations) {
        if (prior.type === 'append_block_if_missing' && mutation.type === 'append_block_if_missing') {
          continue;
        }
        if (prior.type === 'json_set' && mutation.type === 'json_set') {
          // Different key paths inside the same JSON file are independent. Cross-type
          // mutations on one path are rejected below because we cannot prove they are
          // safely composable at planner time.
          const sameKeyPath =
            JSON.stringify(prior.key_path ?? []) === JSON.stringify(mutation.key_path ?? []);
          const sameValue = JSON.stringify(prior.value) === JSON.stringify(mutation.value);
          if (!sameKeyPath || sameValue) continue;
          throw new Error(
            `hosted bundle sync conflict: ${mutation.path} json_set differs between ${prior.bundle} and ${manifest.bundle_name}`,
          );
        }
        throw new Error(
          `hosted bundle sync conflict: ${mutation.path} uses incompatible mutations between ${prior.bundle} and ${manifest.bundle_name}`,
        );
      }
      priorMutations.push({ bundle: manifest.bundle_name, ...mutation });
      seenMutations.set(mutation.path, priorMutations);
    }
  }
}

function orderHostedSyncItemsForRequiredData(synced, disabledInitializerTargets = new Set()) {
  const providers = new Map();
  const requiredDataTargets = new Map();
  for (let index = 0; index < synced.length; index += 1) {
    const item = synced[index];
    try {
      const manifest = sanitizeHostedManifest(
        item.bundle_manifest,
        item.files ?? {},
        undefined,
        disabledInitializerTargets,
        item.self_manifest_source,
        item.self_manifest_sources,
        Object.hasOwn(item, 'self_manifest_sources'),
      );
      for (const entry of manifest.files) {
        if (entry.role === 'required_data') {
          const targets = requiredDataTargets.get(index) ?? new Set();
          targets.add(entry.target);
          requiredDataTargets.set(index, targets);
          continue;
        }
        if (!RUNTIME_STATE_ROLES.has(entry.role) && typeof item.files?.[entry.source] === 'string') {
          const targets = providers.get(entry.target) ?? new Set();
          targets.add(index);
          providers.set(entry.target, targets);
        }
      }
      for (const mutation of manifest.mutations) {
        // Both supported mutation kinds materialize a missing target when
        // required (the default). This makes a mutation-backed required_data
        // provider available before its consumer is installed.
        if (mutation.required === false) continue;
        const targets = providers.get(mutation.path) ?? new Set();
        targets.add(index);
        providers.set(mutation.path, targets);
      }
    } catch {
      // Invalid items retain their original position and are reported by the
      // per-bundle sync boundary; they cannot be trusted as a provider.
    }
  }

  const incoming = new Map(synced.map((_, index) => [index, new Set()]));
  const outgoing = new Map(synced.map((_, index) => [index, new Set()]));
  for (const [consumer, targets] of requiredDataTargets) {
    for (const target of targets) {
      for (const provider of providers.get(target) ?? []) {
        if (provider === consumer) continue;
        incoming.get(consumer).add(provider);
        outgoing.get(provider).add(consumer);
      }
    }
  }
  const ready = synced.map((_, index) => index).filter((index) => incoming.get(index).size === 0);
  const ordered = [];
  while (ready.length > 0) {
    const index = ready.shift();
    ordered.push(index);
    for (const dependent of outgoing.get(index)) {
      incoming.get(dependent).delete(index);
      if (incoming.get(dependent).size === 0) ready.push(dependent);
    }
  }
  // Cycles cannot make required_data materialize safely; preserve their input
  // order so the existing per-bundle fail-closed diagnostics remain explicit.
  for (let index = 0; index < synced.length; index += 1) {
    if (!ordered.includes(index)) ordered.push(index);
  }
  return ordered.map((index) => synced[index]);
}

function collectHostedInitializerTargets(synced) {
  const targets = new Set();
  for (const item of synced) {
    try {
      // A malformed item must not gain plan-wide authority to suppress content
      // in otherwise valid sibling bundles. Only schema-valid initializer
      // declarations contribute to the hosted trust boundary.
      validateManifestSchema(item.bundle_manifest, {
        label: `hosted bundle ${item.bundle_manifest?.bundle_name ?? 'unknown'}`,
      });
    } catch {
      continue;
    }
    for (const entry of Array.isArray(item.bundle_manifest?.files) ? item.bundle_manifest.files : []) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.initializer !== 'string') continue;
      try {
        targets.add(assertContainedRelativePath(entry.initializer, 'hosted initializer target'));
      } catch {
        // The per-bundle schema gate reports malformed initializer paths with
        // their bundle identity; do not let one bad entry abort plan discovery.
      }
    }
  }
  return targets;
}

function collectHostedOwnedTargets(synced, disabledInitializerTargets) {
  const targets = new Set();
  for (const item of synced) {
    try {
      const manifest = sanitizeHostedManifest(
        item.bundle_manifest,
        item.files ?? {},
        undefined,
        disabledInitializerTargets,
        item.self_manifest_source,
        item.self_manifest_sources,
        Object.hasOwn(item, 'self_manifest_sources'),
      );
      for (const entry of manifest.files) targets.add(entry.target);
      for (const target of manifest.projection?.targets ?? []) targets.add(target);
      for (const mutation of manifest.mutations) targets.add(mutation.path);
    } catch {
      // Invalid manifests do not establish safe ownership; their per-bundle
      // result is reported below and cannot suppress stale-script cleanup.
    }
  }
  return targets;
}

function containedDeclaredSelfManifestSources(manifest, fileMap, suppliedSource, suppliedSources, pluralPresent) {
  // The server emits this from the exact authored manifest path.  Do not fall
  // back to a filename/shape/content heuristic here: fixtures are payload.  A
  // malformed or uncontained provenance claim simply has no identity effect.
  if (!pluralPresent && suppliedSource == null) return [];
  const rawSources = pluralPresent ? suppliedSources : [suppliedSource];
  if (!Array.isArray(rawSources) || rawSources.length === 0 || rawSources.some((source) => typeof source !== 'string' || !source)) {
    return null;
  }
  if (pluralPresent && suppliedSource != null && suppliedSource !== rawSources[0]) return null;
  const contained = [];
  for (const source of rawSources) {
    const canonical = source.replace(/\\/g, '/');
    const normalized = path.posix.normalize(canonical);
    if (
      path.posix.isAbsolute(canonical) || canonical !== normalized || normalized === '.' ||
      normalized === '..' || normalized.startsWith('../')
    ) return null;
    const entry = manifest.files.find((file) => file.source === canonical);
    if (!entry || typeof fileMap[canonical] !== 'string' || contained.includes(canonical)) return null;
    contained.push(canonical);
  }
  return contained;
}

function sanitizeHostedManifest(
  rawManifest,
  fileMap,
  io,
  disabledInitializerTargets = new Set(),
  suppliedSelfManifestSource = null,
  suppliedSelfManifestSources = undefined,
  pluralPresent = false,
) {
  const manifest = normalizeBundleManifest(rawManifest);
  const selfManifestSources = containedDeclaredSelfManifestSources(
    manifest,
    fileMap,
    suppliedSelfManifestSource,
    suppliedSelfManifestSources,
    pluralPresent,
  );
  // Absence means this payload has no recursive control-manifest claim.  A
  // supplied-but-invalid claim is different: silently treating it as absent
  // would write the unsealed bytes to disk after sanitizing only the in-memory
  // manifest.  Fail closed rather than inventing provenance from a filename.
  if ((pluralPresent || suppliedSelfManifestSource != null) && !selfManifestSources) {
    throw new Error('Hosted bundle declares invalid self manifest source provenance');
  }
  if (selfManifestSources.length > 0) {
    Object.defineProperty(manifest, '__bundleSelfSources', { value: selfManifestSources, enumerable: false });
  }
  let mutated = false;
  if (manifest.validation.commands.length > 0) {
    io?.stderr?.(
      `bundle sync: ignoring ${manifest.validation.commands.length} hosted validation command(s) for ${manifest.bundle_name}`,
    );
    manifest.validation = { ...manifest.validation, commands: [] };
    mutated = true;
  }
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    io?.stderr?.(
      `bundle sync: ignoring ${Object.keys(manifest.dependencies).length} hosted dependency declaration(s) for ${manifest.bundle_name}`,
    );
    manifest.dependencies = {};
    mutated = true;
  }
  const initializerTargets = new Set(
    manifest.files.flatMap((entry) => entry.initializer == null ? [] : [entry.initializer]),
  );
  const initializerCount = initializerTargets.size;
  if (initializerCount > 0) {
    // Hosted bundles are data received from a remote service. Like validation
    // commands and dependencies above, initializer scripts are an execution
    // vector and must never run implicitly in the consumer's checkout.
    io?.stderr?.(
      `bundle sync: disabling ${initializerCount} hosted initializer execution request(s) for ${manifest.bundle_name}`,
    );
    // Do not merely suppress execution: these remote scripts are untrusted and
    // must not be materialized into the consumer checkout for later tooling to
    // discover. They are needed only to service the rejected initializer path.
    manifest.files = manifest.files
      .filter((entry) => !initializerTargets.has(entry.target))
      .map((entry) => entry.initializer == null ? entry : { ...entry, initializer: null });
    if (Array.isArray(manifest.projection?.targets)) {
      manifest.projection = {
        ...manifest.projection,
        targets: manifest.projection.targets.filter((target) => !initializerTargets.has(target)),
      };
    }
    const initializerMutations = manifest.mutations.filter((mutation) => initializerTargets.has(mutation.path));
    if (initializerMutations.length > 0) {
      io?.stderr?.(
        `bundle sync: ignoring ${initializerMutations.length} hosted mutation(s) targeting disabled initializer script(s) for ${manifest.bundle_name}`,
      );
      // Mutations are writes just as surely as files are. Leaving one aimed at
      // a stripped initializer target would re-materialize untrusted script
      // bytes through append_block_if_missing or json_set.
      manifest.mutations = manifest.mutations.filter((mutation) => (
        !initializerTargets.has(mutation.path)
      ));
    }
    mutated = true;
  }
  const crossBundleInitializerFiles = manifest.files.filter((entry) => (
    disabledInitializerTargets.has(entry.target)
  ));
  if (crossBundleInitializerFiles.length > 0) {
    const requiredCollisions = crossBundleInitializerFiles.filter((entry) => entry.required !== false);
    if (requiredCollisions.length > 0) {
      throw new Error(
        `hosted bundle sync refuses required file(s) targeting disabled initializer script(s): ${requiredCollisions
          .map((entry) => entry.target)
          .join(', ')}`,
      );
    }
    io?.stderr?.(
      `bundle sync: ignoring ${crossBundleInitializerFiles.length} hosted file(s) targeting disabled initializer script(s) for ${manifest.bundle_name}`,
    );
    // A sibling bundle cannot reinstall a script another hosted bundle asked us
    // to execute. Apply the same plan-wide boundary to payload files and
    // projections that already protects mutations below.
    manifest.files = manifest.files.filter((entry) => !disabledInitializerTargets.has(entry.target));
    if (Array.isArray(manifest.projection?.targets)) {
      manifest.projection = {
        ...manifest.projection,
        targets: manifest.projection.targets.filter((target) => !disabledInitializerTargets.has(target)),
      };
    }
    mutated = true;
  }
  const crossBundleInitializerMutations = manifest.mutations.filter((mutation) => (
    disabledInitializerTargets.has(mutation.path)
  ));
  if (crossBundleInitializerMutations.length > 0) {
    io?.stderr?.(
      `bundle sync: ignoring ${crossBundleInitializerMutations.length} hosted mutation(s) targeting disabled initializer script(s) for ${manifest.bundle_name}`,
    );
    // A different item in this plan declared this path as an initializer. Do
    // not let a later hosted mutation recreate executable bytes there, even if
    // the later bundle has no initializer declaration of its own.
    manifest.mutations = manifest.mutations.filter((mutation) => !disabledInitializerTargets.has(mutation.path));
    mutated = true;
  }
  if (mutated) {
    // Hosted validation/dependency declarations are stripped before install.
    // If the manifest includes itself, hash the exact effective payload that
    // writeTempPayload will materialize, not the pre-sanitization bytes.
    if (selfManifestSources.length > 0) {
      const stagedSelfManifest = JSON.stringify({
        ...manifest,
        bundle_hash: 'sha256:pending',
        version_id: `${manifest.bundle_name}@${manifest.bundle_version}+sha256_pending`,
      });
      for (const selfManifestSource of selfManifestSources) fileMap[selfManifestSource] = stagedSelfManifest;
    }
    const hashFiles = manifest.files
      // Runtime-state entries intentionally have no payload bytes, but their
      // contract metadata is hashable by computeInlineBundleHash. Keep them in
      // the rehash input so hosted and local integrity calculations agree.
      .filter((entry) => RUNTIME_STATE_ROLES.has(entry.role) || typeof fileMap[entry.source] === 'string' || entry.required === false)
      .map((entry) => ({ ...entry, content: fileMap[entry.source] ?? '' }));
    const bundleHash = computeInlineBundleHash(hashFiles, {
      bundleType: manifest.bundle_type,
      mutations: manifest.mutations,
      dependencies: manifest.dependencies,
      validationCommands: manifest.validation.commands,
      selfManifestSources,
    });
    manifest.bundle_hash = bundleHash;
    manifest.version_id = `${manifest.bundle_name}@${manifest.bundle_version}+sha256_${bundleHash.replace('sha256:', '').slice(0, 8)}`;
    for (const selfManifestSource of selfManifestSources) fileMap[selfManifestSource] = JSON.stringify(manifest);
  }
  return manifest;
}

function realpathIfExisting(location) {
  try {
    return (fs.realpathSync.native ?? fs.realpathSync)(location);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertHostedWritesDoNotAliasDisabledInitializers(manifest, targetRoot, disabledInitializerTargets) {
  if (disabledInitializerTargets.size === 0) return;
  const protectedTargets = [...disabledInitializerTargets]
    .map((target) => ({
      target,
      // The lexical gate has already canonicalized this target. realpath adds
      // the filesystem's own identity rules (case folding / Unicode
      // normalization) for an existing local initializer script.
      realpath: realpathIfExisting(path.resolve(targetRoot, target)),
    }))
    .filter((entry) => entry.realpath != null);
  if (protectedTargets.length === 0) return;
  const writes = [
    ...manifest.files.map((entry) => entry.target),
    ...manifest.mutations.map((mutation) => mutation.path),
  ];
  for (const target of writes) {
    if (disabledInitializerTargets.has(target)) continue;
    const candidateRealpath = realpathIfExisting(path.resolve(targetRoot, target));
    if (candidateRealpath == null) continue;
    const collision = protectedTargets.find((entry) => entry.realpath === candidateRealpath);
    if (collision) {
      throw new Error(
        `hosted bundle sync refuses filesystem-alias target ${target} for disabled initializer script ${collision.target}`,
      );
    }
  }
}

function captureAbsentDisabledInitializerTargets(targetRoot, disabledInitializerTargets) {
  const absent = new Set();
  for (const target of disabledInitializerTargets) {
    try {
      fs.lstatSync(path.resolve(targetRoot, target));
    } catch (error) {
      if (error?.code === 'ENOENT') absent.add(target);
      else throw error;
    }
  }
  return absent;
}

function assertAbsentDisabledInitializersStayAbsent(targetRoot, absentTargets) {
  for (const target of absentTargets) {
    try {
      fs.lstatSync(path.resolve(targetRoot, target));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`hosted bundle sync refuses filesystem-alias materialization of disabled initializer script ${target}`);
  }
}

function removeHostedInitializerTargets(entries, targetRoot, dryRun, io) {
  // Only legacy clients that materialized hosted initializer payloads can have
  // hash-bearing records here. Current hosted sync strips those payloads and
  // deliberately records no deletion provenance.
  const removedTargets = new Set();
  for (const entry of entries) {
    const target = typeof entry === 'string' ? entry : entry?.target;
    const expectedHash = typeof entry === 'object' ? entry?.hash : null;
    let safeTarget;
    try {
      safeTarget = assertContainedRelativePath(target, 'recorded hosted initializer target');
    } catch (error) {
      io?.stderr?.(`bundle sync: ignoring malformed recorded initializer target: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- target passed assertContainedRelativePath above, which rejects absolute and traversal paths.
    const destination = path.resolve(targetRoot, safeTarget);
    try {
      // lstat is intentional: existsSync follows a dangling symlink and
      // would prune its provenance while leaving the symlink on disk.
      if (!fs.lstatSync(destination).isFile()) {
        io?.stderr?.(`bundle sync: preserving non-file hosted initializer target without file provenance: ${safeTarget}`);
        continue;
      }
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
      if (typeof expectedHash !== 'string' || actualHash !== expectedHash) {
        io?.stderr?.(`bundle sync: preserving locally modified hosted initializer target: ${safeTarget}`);
        continue;
      }
      if (dryRun) {
        io?.stderr?.(`bundle sync: would remove stale hosted initializer script: ${safeTarget}`);
        continue;
      }
      // Remove only bytes proven to be the hosted payload recorded in state.
      // A remote manifest must never authorize deletion of locally-authored
      // content merely because it names the same contained target path.
      fs.rmSync(destination, { recursive: true, force: true });
      removedTargets.add(safeTarget);
      io?.stderr?.(`bundle sync: removed stale hosted initializer script: ${safeTarget}`);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        removedTargets.add(safeTarget);
        continue;
      }
      // The sanitized install has already succeeded. A leftover stale path
      // must not report the whole sync as failed; leave a diagnostic for a
      // later retry instead.
      io?.stderr?.(`bundle sync: could not remove hosted initializer target ${safeTarget}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removedTargets;
}

function writeTempPayload(tempRoot, manifest, fileMap) {
  for (const entry of manifest.files) {
    // WO §2: runtime-state roles are NOT in the source payload — skip materialization.
    if (entry.role && RUNTIME_STATE_ROLES.has(entry.role)) continue;
    const content = fileMap[entry.source];
    if (typeof content !== 'string') {
      if (entry.required !== false) {
        throw new Error(`missing required content for ${entry.source}`);
      }
      continue;
    }
    const dest = path.join(tempRoot, entry.source);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
}

function assertHostedRequiredDataCompatibility(manifest, targetRoot, plannedProviders = new Set()) {
  const mutationProviders = new Set(
    manifest.mutations
      // Both supported mutations create their target when it is absent unless
      // explicitly optional. A hosted bundle can therefore safely satisfy its
      // own required_data contract without an initializer or pre-existing file.
      .filter((mutation) => mutation.required !== false)
      .map((mutation) => mutation.path),
  );
  const missing = manifest.files
    .filter((entry) => entry.role === 'required_data')
    .filter((entry) => !mutationProviders.has(entry.target))
    .filter((entry) => !plannedProviders.has(entry.target))
    .filter((entry) => {
      try {
        const safeTarget = assertContainedRelativePath(entry.target, 'hosted required_data target');
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- safeTarget passed the shared lexical containment gate immediately above.
        return !fs.statSync(path.join(targetRoot, safeTarget)).isFile();
      } catch { return true; }
    })
    .map((entry) => entry.target);
  if (missing.length > 0) {
    throw new Error(
      `hosted bundle sync cannot bootstrap required_data target(s): ${missing.join(', ')}. `
      + 'Hosted initializers are disabled; create the data locally or install from a trusted local bundle first.',
    );
  }
}

async function reindexIfPresent(targetRoot, io) {
  const dbPath = defaultBrainDbPath(targetRoot);
  if (!fs.existsSync(dbPath)) return false;
  const db = createClient({ url: `file:${dbPath}` });
  try {
    await reindexSkillIndex(db, targetRoot, { log: (line) => io?.stdout?.(line) });
    return true;
  } finally {
    if (typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function runHostedBundleSync({
  selector,
  cwd,
  targetRoot = cwd,
  force = false,
  dryRun = false,
  noReindex = false,
  materializeAgents = false,
  cliCsv = '',
  io,
  requestSyncFn = requestHostedBundleSync,
  credentialsReader = readCredentials,
}) {
  const normalizedSelector = parseSelector(selector);
  const targetAgentId = getAgentId(targetRoot);
  if (!targetAgentId) {
    throw new Error('could not determine agent_id — ensure agentbootup.json exists in the target checkout');
  }

  const creds = await credentialsReader();
  if (!creds?.apiKey || !creds?.serverUrl) {
    throw new Error('no credentials — run: agentbootup auth login');
  }

  const plan = await requestSyncFn({
    serverUrl: creds.serverUrl,
    apiKey: creds.apiKey,
    targetRepoPath: targetRoot,
    targetAgentId,
    selector: normalizedSelector,
    dryRun,
    clis: resolveCliList(cliCsv),
  });

  const syncedRaw = Array.isArray(plan.synced) ? plan.synced : [];
  const skipped = Array.isArray(plan.skipped) ? plan.skipped : [];
  // Self-managed pin: a repo that commits its own protocol-layer amendment declares itself
  // self-managed (.ai/protocols/self-managed.json) so hosted sync does NOT re-apply canonical
  // PROTOCOL bundles over it — the clobber that wipes a committed local amendment like
  // circle_computer's 0f. Partition protocol bundles out BEFORE plan-wide preprocessing so a
  // skipped protocol bundle cannot block sibling skill bundles via conflict detection or
  // affect ownership/cleanup decisions. Non-protocol bundles (skills, etc.) still sync.
  // Fail-open: a malformed marker is not a pin (protocols still sync).
  const selfManagedMarker = readSelfManaged(targetRoot);
  const selfManaged = selfManagedMarker?.enabled === true;
  const skippedSelfManagedProtocol = [];
  const synced = selfManaged
    ? syncedRaw.filter((item) => {
        if (item.bundle_manifest?.bundle_type === 'protocol_bundle') {
          skippedSelfManagedProtocol.push(item);
          return false;
        }
        return true;
      })
    : syncedRaw;
  const disabledInitializerTargets = collectHostedInitializerTargets(synced);
  const ownedTargets = collectHostedOwnedTargets(synced, disabledInitializerTargets);
  // Planning must stay silent: the per-bundle install pass emits each hosted
  // trust-boundary warning once, rather than duplicating it during preflight.
  detectTargetConflicts(synced, undefined, disabledInitializerTargets);
  const orderedSynced = orderHostedSyncItemsForRequiredData(synced, disabledInitializerTargets);
  const results = [];
  // Record self-managed protocol bundles as skipped results up front (they were excluded
  // from preprocessing above; emit them here so they appear in the sync summary output).
  for (const item of skippedSelfManagedProtocol) {
    io?.stdout?.(`bundle sync: skipping protocol bundle ${item.bundle_manifest?.bundle_name ?? 'unknown'} — target ${targetAgentId} is self-managed${selfManagedMarker?.reason ? ` (${selfManagedMarker.reason})` : ''}`);
    results.push({
      bundle_name: item.bundle_manifest?.bundle_name ?? 'unknown',
      version_id: item.bundle_manifest?.version_id ?? null,
      status: 'skipped_self_managed',
      self_managed: true,
      self_managed_reason: selfManagedMarker?.reason ?? '',
    });
  }
  let failures = 0;
  let installedCount = 0;
  const successfulInstallTargets = new Set();
  const dryRunProvidedTargets = new Set();
  const deferredInitializerCleanup = [];

  for (const item of orderedSynced) {
    const files = item.files ?? {};
    let tempRoot = null;
    try {
      // Validate every raw hosted field before deriving the install-only copy.
      // Sanitization suppresses execution-capable metadata, but it must never
      // conceal invalid dependency ranges or validation command types.
      validateManifestSchema(item.bundle_manifest, { label: `hosted bundle ${item.bundle_manifest?.bundle_name ?? 'unknown'}` });
      const manifest = sanitizeHostedManifest(
        item.bundle_manifest,
        files,
        io,
        disabledInitializerTargets,
        item.self_manifest_source,
        item.self_manifest_sources,
        Object.hasOwn(item, 'self_manifest_sources'),
      );
      // Set membership above catches lexical aliases. This boundary catches
      // aliases that only the target filesystem can resolve (e.g. case-folded
      // or Unicode-normalized spellings on a case-insensitive volume).
      assertHostedWritesDoNotAliasDisabledInitializers(manifest, targetRoot, disabledInitializerTargets);
      const absentDisabledInitializerTargets = captureAbsentDisabledInitializerTargets(
        targetRoot,
        disabledInitializerTargets,
      );
      const priorState = readBundleInstallState(manifest, targetRoot, targetAgentId);
      const priorHostedInitializerTargets = Array.isArray(priorState?.hosted_initializer_targets)
        ? priorState.hosted_initializer_targets : [];
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ab-bundle-sync-${manifest.bundle_name}-`));
      assertManifestFileCoverage(manifest.bundle_name, manifest, files);
      writeTempPayload(tempRoot, manifest, files);
      assertHostedRequiredDataCompatibility(manifest, targetRoot, dryRun ? dryRunProvidedTargets : undefined);
      const result = installBundle({
        manifest,
        rawManifest: item.bundle_manifest,
        sourceRoot: tempRoot,
        targetRoot,
        force,
        dryRun,
        agentId: targetAgentId,
        materializeAgents,
        // Sanitized hosted sync never materializes initializer bytes, so this
        // run cannot establish deletion provenance for a pre-existing local
        // script. Retain only trusted provenance recorded by a legacy prior
        // install that actually wrote the payload.
        hostedInitializerTargets: priorHostedInitializerTargets,
        postApplyGuard: () => assertAbsentDisabledInitializersStayAbsent(
          targetRoot,
          absentDisabledInitializerTargets,
        ),
        dryRunProvidedTargets: dryRun ? dryRunProvidedTargets : undefined,
      });
      for (const entry of manifest.files) successfulInstallTargets.add(entry.target);
      for (const target of manifest.projection?.targets ?? []) successfulInstallTargets.add(target);
      // Mutations own their materialized path just like manifest files do. If
      // a later successful bundle intentionally writes an old hosted
      // initializer path, do not let deferred stale-script cleanup erase that
      // bundle's output.
      for (const mutation of manifest.mutations) successfulInstallTargets.add(mutation.path);
      if (dryRun) {
        for (const entry of manifest.files) {
          if (!RUNTIME_STATE_ROLES.has(entry.role) && typeof files[entry.source] === 'string') {
            dryRunProvidedTargets.add(entry.target);
          }
        }
        for (const mutation of manifest.mutations) {
          if (mutation.required !== false) dryRunProvidedTargets.add(mutation.path);
        }
      }
      // Only a prior applied install can prove these bytes originated from a
      // hosted payload. The current manifest is untrusted input and its script
      // entry was stripped before install, so it grants no delete authority.
      deferredInitializerCleanup.push({ manifest, entries: priorHostedInitializerTargets });
      if (!dryRun && !result.noop) installedCount += 1;
      results.push({
        bundle_name: manifest.bundle_name,
        version_id: manifest.version_id,
        status: result.noop ? 'noop' : 'installed',
        ...result,
      });
    } catch (error) {
      failures += 1;
      results.push({
        bundle_name: item.bundle_manifest?.bundle_name ?? item.id ?? 'unknown',
        version_id: item.bundle_manifest?.version_id ?? null,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const cleanupEntries = deferredInitializerCleanup
    .flatMap(({ entries }) => entries)
    .filter((entry) => {
      const rawTarget = typeof entry === 'string' ? entry : entry?.target;
      let target;
      try {
        target = assertContainedRelativePath(rawTarget, 'recorded hosted initializer target');
      } catch {
        // removeHostedInitializerTargets will emit the malformed-record warning;
        // it must never bypass plan ownership due to a non-canonical key here.
        return true;
      }
      // A separate bundle in this sync plan explicitly owns this path. Retain
      // it even if that bundle rolled back: deferred cleanup cannot distinguish
      // a restored valid payload from stale initializer bytes by pathname alone.
      return !successfulInstallTargets.has(target) && !ownedTargets.has(target);
    });
  const removedInitializerTargets = removeHostedInitializerTargets(
    cleanupEntries,
    targetRoot,
    dryRun,
    io,
  );
  for (const { manifest } of deferredInitializerCleanup) {
    pruneHostedInitializerTargets(
      manifest,
      targetRoot,
      targetAgentId,
      removedInitializerTargets,
      dryRun,
    );
  }

  let reindexed = false;
  if (!noReindex && installedCount > 0) {
    try {
      reindexed = await reindexIfPresent(targetRoot, io);
    } catch (error) {
      io?.stderr?.(
        `bundle sync: warning: local reindex failed after install: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const selfManagedSkipped = results.filter((r) => r.status === 'skipped_self_managed').length;
  return {
    targetAgentId,
    selector: normalizedSelector,
    results,
    skipped,
    self_managed_skipped: selfManagedSkipped,
    failures,
    reindexed,
    dryRun,
  };
}
