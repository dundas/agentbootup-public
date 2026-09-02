import path from 'path';
import { withMemorySyncLock, isMemorySyncLockHeldByThisProcess, MemorySyncLockHeldError } from './sync-lock.js';
import fs from 'fs';
import { createClient } from '@libsql/client';
import { extractCwd, getFlagValue, hasFlag } from '../network/args.js';
import { getMachineId } from '../machine-id/machine-id.js';
import { isValidBrainId } from '../config/brain-id.js';
import { getAgentId } from '../project-config.js';
import { defaultBrainDbPath } from '../network/commands/brain-db.js';
import { signalDaemonByPidFile } from '../process/pid-utils.js';
import { stringifyJsonEnvelope } from '../json/safe-stringify.js';
import { readSchemaVersion, reapplyCanonicalTemplate, runBrainDbMigrations, stampV4SchemaMeta } from '../brain/brain-db-migrate.js';
import {
  collectMemoryFiles,
  createMemorySnapshotManifest,
  getBundleStoreRoot,
  installBundle,
  loadBundleManifest,
  publishBundle,
} from '../bundle/installer.js';
import { captureMemoryToBrainDb, refreshMemoryFromBrainDb } from './db.js';
import {
  resolveMemoryStore,
  publishMemoryToStore,
  fetchLatestFromStore,
  applyFetchedSnapshot,
  applyMergedSnapshot,
  getPublisherHeadPageSet,
  removeLocalMemoryPages,
  writeSyncBaseline,
  readSyncBaseline,
  readSyncBaselineHashes,
  sha256Hex,
  resolvePublisherMachineId,
  commitPublisherPin,
  assertPinPersistable,
  hasPinnedPublisherId,
  hasSyncBaseline,
  staleFleetDeletions,
  isDeferrableMemoryStoreError,
} from './store.js';
import { getMemoryStoreAdapter } from './store-adapter.js';
import {
  createBoundedMemoryFetch,
  headAssetPath,
  headPathPrefix,
  latestAssetPath,
  listRemoteMemoryAssetHashes,
  pullRemoteJsonAsset,
  resolveRemoteMemoryStoreConfig,
  snapshotManifestAssetPath,
  snapshotMarkersAssetPath,
  snapshotPayloadPrefix,
} from './remote-store.js';
import {
  enqueueReplayItem,
  hasReplayQueue,
  inspectReplayItem,
  isReplayHead,
  normalizeStoreIdentity,
  readReplayPayload,
  readReplayQueue,
  readReplayQueueReadOnly,
  recordReplayFailure,
  removeReplayItem,
} from './replay-queue.js';
import { writeBrainMap, loadBrainMap, verifyAgainstMap, BRAIN_MAP_FILENAME } from './brain-map.js';
import {
  assertBrainBackupPolicyReady,
  resolveBrainBackupSelection,
  selectedHistoricalMemoryPaths,
} from './brain-backup-selection.js';
import { createMemoryConflict, normalizeMemoryConflict } from './conflict.js';

function emitMemoryFailure(io, category, conflict) {
  try {
    io?.failure?.({ category, ...(conflict ? { conflict } : {}) });
  } catch {
    // Diagnostic callbacks must never change the command's established exit
    // or mutation behavior.
  }
}

function emitKnownMemoryError(io, error) {
  const status = Number(error?.status);
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (status === 401 || status === 403 || /AUTH|FORBIDDEN|UNAUTHORIZED/.test(code)) {
    emitMemoryFailure(io, 'authorization');
    return;
  }
  if (/INTEGRITY|INVALID_PAYLOAD|MALFORMED|CORRUPT/.test(code)) {
    emitMemoryFailure(io, 'invalid_payload');
    return;
  }
  if (/TIMEOUT|ETIMEDOUT|ABORT_ERR/.test(code)) {
    emitMemoryFailure(io, 'timeout');
    return;
  }
  if (/ECONN|ENET|EHOST|OFFLINE|UNREACHABLE/.test(code)) {
    emitMemoryFailure(io, 'unreachable');
    return;
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    emitMemoryFailure(io, 'local_precondition');
  }
}

function loadCommittedBrainMap(cwd) {
  let map;
  try {
    map = loadBrainMap(cwd);
  } catch (err) {
    return {
      ok: false,
      code: 1,
      error: `brain-map present but invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, code: 0, map };
}

// Normalize the single-latest fetch into the same {mode, pages:Map} shape the merge produces, so
// the default and --merge refresh paths share one apply/report tail. marker/hash are unused for
// the single-snapshot path (no conflict resolution needed).
function normalizeLatest(res) {
  if (res.mode !== 'store' || !res.manifest) {
    return { mode: res.mode, pages: null, store_root: res.store_root };
  }
  const pages = new Map();
  for (const file of res.manifest.files) {
    pages.set(file.target, { srcFile: path.join(res.payloadRoot, file.target), marker: 0, hash: res.manifest.bundle_hash });
  }
  // The single-latest view has no cross-head tombstones (one coherent snapshot); no deletions.
  return { mode: 'store', pages, deleted: new Map(), storeReal: res.storeReal };
}

// After a store refresh, report present/missing against the committed brain-map (if any) so
// restore is VERIFIABLE against the git-committed inventory, not just the store's own manifest.
function reportAgainstMap(cwd, io, map) {
  if (!map) return { ok: true, code: 0, missing: [], extra: [], expected: 0, present: 0, skipped: true };
  const v = verifyAgainstMap(cwd, map);
  io.stdout(`brain-map:       ${v.present.length}/${v.expected} expected pages present`);
  io.stdout(`brain-map extra: ${v.extra.length}`);
  if (v.missing.length) {
    io.stderr(`brain-map MISSING ${v.missing.length} page(s) (gap not covered by the store):`);
    for (const rel of v.missing.slice(0, 20)) io.stderr(`  - ${rel}`);
  }
  if (v.missing.length > 0) emitMemoryFailure(io, 'local_precondition');
  return {
    ok: v.missing.length === 0,
    code: v.missing.length > 0 ? 3 : 0,
    missing: v.missing,
    extra: v.extra,
    expected: v.expected,
    present: v.present.length,
  };
}

function usage() {
  return [
    'Usage: agentbootup memory <subcommand> [options]',
    '',
    'Subcommands:',
    '  capture  [--cwd <dir>] [--prune-missing]',
    '  refresh  [--cwd <dir>] [--force] [--from-store] [--latest] [--store <url>]',
    '  publish  [--snapshot-id <id>] [--cwd <dir>] [--store <url>]  reconcile then publish',
    '  retire-head <publisher-id> [--cwd <dir>] [--store <url>]     retire one publisher head',
    '  flush    [--snapshot-id <id>] [--cwd <dir>] [--store <url>]  capture, queue, then replay',
    '  replay   [--cwd <dir>] [--store <url>] [--json]              deliver queued immutable snapshots',
    '           [--inspect <queue-id>] | [--discard <queue-id> --confirm-loss]',
    '  diagnose [--cwd <dir>] [--store <url>] [--json]             read-only queue and remote-store health',
    '  map      [--cwd <dir>]                    write brain-map.json (committed presence pointer)',
    '  verify   [--cwd <dir>]                    check memory/ against the committed brain-map',
    '  snapshot [--snapshot-id <id>] [--cwd <dir>] [--dry-run]',
    '  restore --snapshot <manifest-path> [--target <dir>] [--force] [--dry-run]',
    '',
    'Notes:',
    '  capture writes memory/ pages into brain.db canonical tables (memory_events, memory_pages).',
    '  use --prune-missing only when local memory/ is a trusted full projection and missing files should become canonical deletes.',
    '  refresh materializes missing pages back into memory/ without clobbering drifted local edits unless --force is set.',
    '    --from-store merges across all publisher heads (cross-machine): distinct pages union, same-page',
    '      newest-wins, deletions converge via tombstones. --latest opts to the single latest snapshot.',
    '  publish first reconciles missing shared-store pages into memory/, then pushes a content-addressed snapshot.',
    '    publish refuses with exit 3 if a shared page conflicts with a local edit; NOTE a non-zero exit is',
    '    NOT a no-op: non-conflicting pages may already be materialized and stale fleet-deleted pages already',
    '    removed from memory/ before the conflict is reported. Review memory/ before retrying.',
    '  the shared store is resolved from --store or AGENTBOOTUP_MEMORY_STORE (file://<dir> in PR-1); unset = local-only.',
    '  memory snapshots are stored as memory_snapshot bundle artifacts under ~/.agentbootup/bundles/.',
    '  refresh/publish/flush/replay/restore take the cross-process sync lock; exit 5 = lock held',
    '    (daemon sync in progress) — retry shortly.',
    '  remote snapshot reads use 8 concurrent requests by default;',
    '    AGENTBOOTUP_MEMORY_REMOTE_READ_CONCURRENCY may tune this from 1 to 16.',
  ].join('\n');
}

function diagnosticErrorCode(error) {
  if (typeof error?.code === 'string' && /^[a-z0-9_:-]{1,80}$/i.test(error.code)) return error.code;
  if (Number.isInteger(error?.status)) return `http_${error.status}`;
  return 'unreadable';
}

function diagnosticBundleHash(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
}

async function diagnoseRemoteMemoryStore({ projectRoot, store, fetchFn }) {
  const remote = await resolveRemoteMemoryStoreConfig({ projectRoot, store });
  const report = {
    scheme: 'server',
    brain_id: remote.brainId,
    reachable: false,
    heads: { listed: 0, readable: 0, unreadable: [] },
    latest: { present: false, readable: false, bundle_hash: null, error: null },
    snapshots: [],
  };
  const [headsList, latestList] = await Promise.all([
    listRemoteMemoryAssetHashes({ remote, pathPrefix: headPathPrefix(), fetchFn }),
    listRemoteMemoryAssetHashes({ remote, pathPrefix: latestAssetPath(), fetchFn }),
  ]);
  report.reachable = true;
  const heads = Array.isArray(headsList?.files) ? headsList.files : [];
  report.heads.listed = heads.length;
  const referenced = new Set();
  for (const entry of heads) {
    const assetPath = typeof entry?.path === 'string' ? entry.path : '';
    const publisherId = assetPath.startsWith(headPathPrefix()) && assetPath.endsWith('.json')
      ? assetPath.slice(headPathPrefix().length, -'.json'.length)
      : null;
    if (!publisherId) {
      report.heads.unreadable.push({ publisher_id: null, error: 'invalid_path' });
      continue;
    }
    try {
      const pointer = await pullRemoteJsonAsset({ remote, path: headAssetPath(publisherId), fetchFn });
      const bundleHash = diagnosticBundleHash(pointer?.bundle_hash);
      if (!bundleHash) throw Object.assign(new Error('invalid head pointer'), { code: 'invalid_pointer' });
      report.heads.readable += 1;
      referenced.add(bundleHash);
    } catch (error) {
      report.heads.unreadable.push({ publisher_id: publisherId, error: diagnosticErrorCode(error) });
    }
  }
  if (Array.isArray(latestList?.files) && latestList.files.length > 0) {
    report.latest.present = true;
    try {
      const pointer = await pullRemoteJsonAsset({ remote, path: latestAssetPath(), fetchFn });
      report.latest.bundle_hash = diagnosticBundleHash(pointer?.bundle_hash);
      if (!report.latest.bundle_hash) throw Object.assign(new Error('invalid latest pointer'), { code: 'invalid_pointer' });
      report.latest.readable = true;
      referenced.add(report.latest.bundle_hash);
    } catch (error) {
      report.latest.error = diagnosticErrorCode(error);
    }
  }
  for (const bundleHash of [...referenced].sort()) {
    const snapshot = { bundle_hash: bundleHash, manifest: 'unreadable', markers: 'unreadable', payload_assets: null };
    try {
      const manifest = await pullRemoteJsonAsset({ remote, path: snapshotManifestAssetPath(bundleHash), fetchFn });
      snapshot.manifest = diagnosticBundleHash(manifest?.bundle_hash) === bundleHash && Array.isArray(manifest?.files)
        ? 'readable' : 'invalid';
    } catch (error) {
      snapshot.manifest = diagnosticErrorCode(error);
    }
    try {
      await pullRemoteJsonAsset({ remote, path: snapshotMarkersAssetPath(bundleHash), fetchFn });
      snapshot.markers = 'readable';
    } catch (error) {
      snapshot.markers = diagnosticErrorCode(error);
    }
    try {
      const payloads = await listRemoteMemoryAssetHashes({
        remote,
        pathPrefix: snapshotPayloadPrefix(bundleHash),
        fetchFn,
      });
      snapshot.payload_assets = Array.isArray(payloads?.files) ? payloads.files.length : 0;
    } catch (error) {
      snapshot.payload_assets = diagnosticErrorCode(error);
    }
    report.snapshots.push(snapshot);
  }
  return report;
}

async function diagnoseMemoryState({ projectRoot, store, fetchFn }) {
  const report = {
    schema: 'memory-diagnose/v1',
    read_only: true,
    replay: { present: false, queue_valid: true, items: [], error: null },
    store: null,
  };
  try {
    const queue = readReplayQueueReadOnly(projectRoot);
    report.replay.present = queue.items.length > 0 || fs.existsSync(queue.paths.queuePath);
    report.replay.items = queue.items.map((item) => ({
      id: item.id,
      bundle_hash: item.bundle_hash,
      attempt_count: item.attempt_count,
      last_outcome: item.last_outcome?.type ?? null,
    }));
  } catch (error) {
    report.replay.queue_valid = false;
    report.replay.error = diagnosticErrorCode(error);
  }
  if (!store) {
    report.store = { scheme: 'none', reachable: false, error: 'not_configured' };
    return report;
  }
  if (store.scheme !== 'server') {
    report.store = { scheme: store.scheme, reachable: true, remote_diagnostics: 'not_applicable' };
    return report;
  }
  try {
    report.store = await diagnoseRemoteMemoryStore({ projectRoot, store, fetchFn });
  } catch (error) {
    report.store = { scheme: 'server', reachable: false, error: diagnosticErrorCode(error) };
  }
  return report;
}

function defaultSnapshotId() {
  return new Date().toISOString().replace(/[:]/g, '-');
}

function reportStoreReconcile(io, fetched, applied) {
  if (!fetched?.manifest || !applied) return;
  io.stdout(`Reconciled memory from shared store (${fetched.manifest.version_id}) before publish`);
  io.stdout(`available_pages: ${applied.available_pages}`);
  io.stdout(`restored:        ${applied.restored.length}`);
  io.stdout(`overwritten:     ${applied.overwritten.length}`);
  io.stdout(`unchanged:       ${applied.unchanged.length}`);
  io.stdout(`drifted:         ${applied.drifted.length}`);
  for (const rel of applied.drifted) {
    io.stderr(`drifted page left untouched before publish: ${rel}`);
  }
}

function emptyReplayResult(pending) {
  return { pending, replayed: 0, blocked_conflict: 0, retrying: 0, degraded: 0, deferred_unreachable: 0, failed_invalid_queue: 0 };
}

function formatConflictDetails(record) {
  let details = '';
  const conflicts = record?.conflicts;
  const conflictCount = Array.isArray(conflicts) ? conflicts.length : 0;
  for (let index = 0; index < conflictCount; index += 1) {
    const item = conflicts[index];
    if (details) details += ', ';
    details += `${item.path} (${item.reason_code})`;
  }
  if (record?.omitted_count > 0) {
    if (details) details += ', ';
    details += `+${record.omitted_count} more`;
  }
  return details;
}

function reportReplayResult(io, result, json) {
  if (json) {
    io.stdout(stringifyJsonEnvelope(result));
    return;
  }
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'conflict') io.stdout(`${key}: ${value}`);
  }
  const details = formatConflictDetails(result.conflict);
  if (details) io.stderr(`memory conflict details: ${details}`);
}

// Shared by explicit replay and the pre-publish gate. It only ever publishes a
// verified immutable payload; current checkout memory is not consulted here.
async function replayQueuedStore({ projectRoot, store }, io = null) {
  if (!hasReplayQueue(projectRoot)) return { result: emptyReplayResult(0), code: 0 };
  const queue = readReplayQueue(projectRoot);
  const identity = normalizeStoreIdentity(store);
  const matching = queue.items.filter((item) => item.store_identity === identity);
  const result = emptyReplayResult(matching.length);
  if (matching.length === 0) return { result, code: 0 };
  const adapter = getMemoryStoreAdapter(store);

  const recordLocalPrecondition = (item, code) => {
    emitMemoryFailure(io, 'local_precondition');
    const safeCode = code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
      ? code
      : 'LOCAL_PRECONDITION';
    const recorded = recordReplayFailure({
      projectRoot,
      id: item.id,
      type: 'retrying',
      detail: safeCode,
    });
    if (recorded.item.last_outcome.type === 'degraded') result.degraded += 1;
    else result.retrying += 1;
    return { result, code: 1 };
  };

  let machineId = null;
  try { machineId = await getMachineId(); } catch { /* existing publisher pin or store checks decide recovery */ }
  if (!machineId && !hasPinnedPublisherId({ projectRoot })) {
    try {
      // Distinguish a genuinely absent pin from a corrupt one without persisting the fallback.
      resolvePublisherMachineId({ projectRoot, machineId: null });
    } catch (error) {
      emitMemoryFailure(io, 'local_precondition');
      return { result, code: 1, error: error instanceof Error ? error.message : String(error) };
    }
    emitMemoryFailure(io, 'local_precondition');
    return {
      result,
      code: 1,
      error: 'machine id unavailable and this checkout has no pinned publisher identity; restore machine id or refresh from the store before replaying',
    };
  }

  const availability = await adapter.fetchLatestAsync({ projectRoot });
  if (availability.mode === 'unreachable') {
    emitMemoryFailure(io, 'unreachable');
    return { result, code: 1, error: `shared store unreachable (${availability.store_root})` };
  }

  for (const item of matching) {
    let payload;
    try {
      payload = readReplayPayload({ projectRoot, item });
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') {
        return recordLocalPrecondition(item, error.code);
      }
      if (isDeferrableMemoryStoreError(error)) {
        emitMemoryFailure(io, 'unreachable');
        recordReplayFailure({ projectRoot, id: item.id, type: 'deferred_unreachable', detail: error.code });
        result.deferred_unreachable += 1;
        return { result, code: 4 };
      }
      emitMemoryFailure(io, 'invalid_payload');
      recordReplayFailure({ projectRoot, id: item.id, type: 'failed_invalid_payload', detail: error instanceof Error ? error.message : String(error) });
      result.failed_invalid_queue += 1;
      return { result, code: 1 };
    }
    try {
      await adapter.publishAsync({
        projectRoot,
        snapshotId: item.snapshot_id,
        machineId,
        deletedPages: item.deleted_pages || [],
        deletedPageTimes: item.deleted_page_times || {},
        sourceRoot: payload.payloadRoot,
        replayPayload: true,
        replayFiles: payload.files,
        replayMtimes: payload.fileMtimes,
      });
      // PR-2a: hash the frozen bytes BEFORE removeReplayItem deletes the
      // payload directory (reading after removal silently yields nothing —
      // the initial implementation did exactly that).
      const frozenHashes = {};
      const frozenPages = [];
      try {
        for (const rel of payload.files) {
          frozenPages.push(rel);
          frozenHashes[rel] = sha256Hex(fs.readFileSync(path.join(payload.payloadRoot, rel)));
        }
      } catch { /* eligibility-only */ }
      removeReplayItem({ projectRoot, id: item.id });
      result.replayed += 1;
      result.pending -= 1;
      // PR-2a: a replayed publish makes the FROZEN bytes the store content —
      // merge them into the baseline CAS references (and page set) so the
      // next same-page edit from this checkout fast-forwards instead of
      // being falsely refused with "no baseline content reference"
      // (roborev). MERGE, never replace: the existing baseline's page set
      // drives deletion detection and must not shrink here. Best-effort —
      // a failed baseline write only costs fast-forward eligibility.
      try {
        const prevPages = readSyncBaseline({ projectRoot, store });
        const prevHashes = readSyncBaselineHashes({ projectRoot, store });
        // Replayed DELETIONS leave the baseline (roborev High): keeping them
        // would let a later publish's absent-vs-baseline scan re-tombstone a
        // page another checkout has since recreated. In practice the
        // publish-side reconcile re-materializes such pages first (T8), but
        // correctness must not depend on that write succeeding.
        //
        // prevPages UNION is deliberate (rebutted follow-up finding, T9):
        // refresh only baselines pages it actually MATERIALIZED, so a
        // baseline page absent locally means a genuine user deletion —
        // tombstoning it is correct. Rebuilding from the frozen set alone
        // would DROP refresh-added pages from the baseline, silently
        // disabling delete-detection for them: a later real local delete
        // would never tombstone and the page would resurrect on refresh —
        // the exact MEMORY_SYNC_SAFETY resurrection class.
        const replayedDeletes = new Set(item.deleted_pages || []);
        const pages = new Set([...prevPages, ...frozenPages].filter((r) => !replayedDeletes.has(r)));
        const pageHashes = { ...prevHashes, ...frozenHashes };
        for (const r of replayedDeletes) delete pageHashes[r];
        writeSyncBaseline({ projectRoot, store, pages, pageHashes });
      } catch { /* eligibility-only; the publish itself succeeded */ }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDeferrableMemoryStoreError(error)) {
        emitMemoryFailure(io, 'unreachable');
        recordReplayFailure({ projectRoot, id: item.id, type: 'deferred_unreachable', detail: error.code });
        result.deferred_unreachable += 1;
        return { result, code: 4 };
      }
      if (error?.code === 'MEMORY_REPLAY_CONFLICT') {
        result.conflict = normalizeMemoryConflict(error.conflict);
        io?.conflict?.(result.conflict);
        emitMemoryFailure(io, 'conflict', result.conflict);
        recordReplayFailure({ projectRoot, id: item.id, type: 'blocked_conflict', detail: message });
        result.blocked_conflict += 1;
        return { result, code: 3 };
      }
      if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') {
        return recordLocalPrecondition(item, error.code);
      }
      if (/store root does not exist/.test(message)) {
        emitMemoryFailure(io, 'unreachable');
        recordReplayFailure({ projectRoot, id: item.id, type: 'deferred_unreachable', detail: message });
        result.deferred_unreachable += 1;
        return { result, code: 4 };
      }
      const recorded = recordReplayFailure({ projectRoot, id: item.id, type: 'retrying', detail: message });
      if (recorded.item.last_outcome.type === 'degraded') result.degraded += 1;
      else result.retrying += 1;
      return { result, code: 1 };
    }
  }
  return { result, code: 0 };
}

function openBrainDb(projectRoot) {
  const dbPath = defaultBrainDbPath(projectRoot);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  return {
    dbPath,
    db: createClient({ url: `file:${dbPath}` }),
  };
}

async function ensureBrainDbReady({ db, projectRoot, dbPath }) {
  const tables = await db.execute(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  const userTables = new Set((tables.rows ?? []).map((row) => String(row.name)));
  const trivialTables = new Set(['schema_meta']);
  const onlyTrivialTables = [...userTables].every((name) => trivialTables.has(name));
  if (userTables.size === 0 || onlyTrivialTables) {
    await reapplyCanonicalTemplate(db);
    await stampV4SchemaMeta(db);
    return;
  }

  const version = await readSchemaVersion(db);
  if (version >= 4) return;
  await runBrainDbMigrations(db, {
    brainDbFilePath: dbPath,
    brainId: getAgentId(projectRoot) ?? 'unknown',
  });
}

export function triggerBrainDbSyncSignal(projectRoot, opts = {}) {
  const platform = opts.platform || process.platform;
  const brainId = getAgentId(projectRoot);
  if (!brainId) {
    return {
      ok: true,
      signaled: false,
      code: 'missing-agent-id',
      reason: 'agent_id unavailable — local capture only',
    };
  }
  if (!isValidBrainId(brainId)) {
    return {
      ok: true,
      signaled: false,
      code: 'invalid-agent-id',
      reason: `agent_id invalid (${brainId}) — local capture only`,
    };
  }
  const result = signalDaemonByPidFile(`brain-db-sync-${brainId}`, {
    signal: 'SIGUSR1',
    platform,
  });
  return result.signaled ? result : {
    ...result,
    reason: `${result.reason} — local capture only`,
  };
}

/**
 * PR-2a: fast-forward eligibility for a publish's drifted pages.
 * Eligible iff for EVERY drifted page: (1) the merged store content's
 * VALIDATED bytes hash-equal this checkout's baseline hash for the page
 * (store unchanged since our last sync — the CAS clause; store-derived,
 * never publisher-advertised markers), and (2) the local file is STRICTLY
 * newer than the merged store marker at normalized integer-ms precision
 * (bounded by the documented clock-skew caveat; OQ-8 tiers).
 * Any read/merge failure or missing reference => NOT eligible (conservative).
 */
async function allDriftedFastForwardable({ cwd, store, adapter, drifted }) {
  let merged;
  try {
    merged = await adapter.fetchMergedAsync({ projectRoot: cwd, store });
  } catch {
    return {
      ok: false,
      reason: 'store merge unreadable',
      conflict: createMemoryConflict(drifted.map((path) => ({ path, reason_code: 'store_merge_unreadable' }))),
    };
  }
  if (!(merged?.pages instanceof Map)) {
    return {
      ok: false,
      reason: 'no merged store view',
      conflict: createMemoryConflict(drifted.map((path) => ({ path, reason_code: 'merged_view_unavailable' }))),
    };
  }
  const baselineHashes = readSyncBaselineHashes({ projectRoot: cwd, store });
  const failures = [];
  for (const rel of drifted) {
    const entry = merged.pages.get(rel);
    if (!entry?.srcFile) { failures.push({ path: rel, reason_code: 'merged_content_missing', reason: `no merged content for ${rel}` }); continue; }
    const want = baselineHashes[rel];
    if (!want) { failures.push({ path: rel, reason_code: 'baseline_reference_missing', reason: `no baseline content reference for ${rel}` }); continue; }
    let storeBytes;
    try { storeBytes = fs.readFileSync(entry.srcFile); } catch { failures.push({ path: rel, reason_code: 'store_bytes_unreadable', reason: `store bytes unreadable for ${rel}` }); continue; }
    if (sha256Hex(storeBytes) !== want) { failures.push({ path: rel, reason_code: 'store_changed_since_baseline', reason: `store moved since last sync for ${rel}` }); continue; }
    let localMtime;
    try { localMtime = fs.statSync(path.join(cwd, rel)).mtimeMs; } catch { failures.push({ path: rel, reason_code: 'local_page_unreadable', reason: `local page unreadable: ${rel}` }); continue; }
    if (!(Math.floor(localMtime) > Math.floor(Number(entry.marker)))) {
      failures.push({ path: rel, reason_code: 'local_not_strictly_newer', reason: `local edit not strictly newer than the store for ${rel}` });
    }
  }
  return failures.length
    ? { ok: false, reason: failures[0].reason, conflict: createMemoryConflict(failures) }
    : { ok: true };
}

/** Subcommands that mutate memory/ or .brain/ state and must hold the
 * cross-process sync lock (PRD-0054 FR 7a). `capture`/`map`/`verify`/
 * `snapshot` touch only brain.db or read-only surfaces. */
const LOCKED_SUBCOMMANDS = new Set(['refresh', 'publish', 'retire-head', 'flush', 'replay', 'restore']);

function throwIfMemoryCommandAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('memory command aborted');
}

export async function runMemoryCommand(args, io, options = {}) {
  const signal = options.signal;
  // Bound each memory server fetch to a per-fetch timeout (and compose with the
  // cycle signal) so an unresponsive (black-hole) server fails fast instead of
  // wedging the daemon converge cycle until the cycle-level signal aborts it.
  // Reuses the same bound as the remote-store defaults (see remote-store.js).
  const fetchFn = options.fetchFn ?? (signal
    ? createBoundedMemoryFetch(signal)
    : undefined);
  throwIfMemoryCommandAborted(signal);
  const extracted = extractCwd(args);
  const cwd = path.resolve(extracted.cwd);
  const rest = extracted.args;
  const subcommand = rest[0];

  // Cross-process mutex: serialize against the daemon converge legs (and
  // other CLI invocations). Skipped when THIS process already holds the lock
  // — the daemon invokes these subcommands from inside its own locked cycle.
  if (LOCKED_SUBCOMMANDS.has(subcommand) && !isMemorySyncLockHeldByThisProcess(cwd)) {
    try {
      return await withMemorySyncLock(
        { projectRoot: cwd, holderLabel: `memory-${subcommand}`, waitMs: 10_000 },
        () => runMemoryCommand(args, io, options),
      );
    } catch (err) {
      if (err instanceof MemorySyncLockHeldError) {
        emitMemoryFailure(io, 'lock_held');
        io.stderr(err.message);
        return 5; // lock held — retry shortly (documented in usage)
      }
      throw err;
    }
  }
  let publishStore = null;
  let publishSnapshotId = null;
  let publishDeletedPages = [];
  let publishDeletedPageTimes = {};

  try {
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      io.stdout(usage());
      return 0;
    }

    if (subcommand === 'diagnose') {
      const store = resolveMemoryStore(getFlagValue(rest, '--store'));
      const report = await diagnoseMemoryState({ projectRoot: cwd, store, fetchFn });
      // This deliberately emits a stable structured document even without --json:
      // diagnostics are intended for automation and must not be parsed from prose.
      io.stdout(stringifyJsonEnvelope(report));
      return report.replay.queue_valid && report.store?.reachable !== false ? 0 : 1;
    }

    if (subcommand === 'capture') {
      const { dbPath, db } = openBrainDb(cwd);
      try {
        await ensureBrainDbReady({ db, projectRoot: cwd, dbPath });
        const machineId = await getMachineId();
        const result = await captureMemoryToBrainDb({
          db,
          projectRoot: cwd,
          machineId,
          pruneMissing: hasFlag(rest, '--prune-missing'),
        });
        io.stdout(`Captured ${result.captured.length} memory page(s) into ${dbPath}`);
        io.stdout(`scanned:   ${result.scanned}`);
        io.stdout(`deleted:   ${result.deleted.length}`);
        io.stdout(`unchanged: ${result.unchanged.length}`);
        return 0;
      } finally {
        await db.close();
      }
    }

    if (subcommand === 'refresh') {
      // --from-store fetches the latest snapshot from the SHARED store (cross-machine).
      // Default refresh materializes from the local brain.db view.
      if (hasFlag(rest, '--from-store')) {
        const store = resolveMemoryStore(getFlagValue(rest, '--store'));
        const adapter = getMemoryStoreAdapter(store);
        // DEFAULT: per-page merge across all publisher heads — distinct pages from every machine/
        // worktree converge in ONE round, same-page conflicts resolve newest-wins, and deletions
        // converge via tombstones (a page deleted fleet-wide is removed, not resurrected).
        // --latest takes CONTENT from the single latest snapshot instead of unioning heads (an escape
        // hatch for one coherent content view), but it STILL honors fleet deletions (see below) so it
        // cannot resurrect a tombstoned page. The default unions content across all heads; --latest
        // does not — that is the only difference now.
        const useMerge = !hasFlag(rest, '--latest');
        if (hasFlag(rest, '--merge')) {
          io.stderr('memory refresh: --merge is deprecated — per-page merge is now the DEFAULT; the flag is a no-op (use --latest for the single-snapshot view)');
        }
        const fetched = useMerge
          ? await adapter.fetchMergedAsync({ projectRoot: cwd, fetchFn })
          : normalizeLatest(await adapter.fetchLatestAsync({ projectRoot: cwd, fetchFn }));
        // The bounded daemon startup phase may time out while remote I/O is
        // pending. Check cancellation before the first local write so a late
        // response cannot materialize pages, mint a publisher pin, or update
        // the sync baseline after startup has returned.
        throwIfMemoryCommandAborted(signal);
        let latestDegraded = false; // --latest could not collect fleet state (corrupt heads)
        // `--latest` takes CONTENT from the single latest snapshot, but it must STILL honor fleet
        // deletions — otherwise it resurrects a page the fleet has tombstoned (latest.json isn't
        // advanced by a tombstone-only publish, so it can still list a since-deleted page), and a
        // later `publish` then treats that resurrected local page as a legitimate re-creation and
        // republishes it (roborev). Attach the fleet tombstones so the deletion converges here too.
        if (!useMerge && fetched.mode === 'store') {
          // Tombstone collection is BEST-EFFORT for --latest: this is the escape hatch for getting one
          // coherent snapshot when per-head state is unhealthy, so unrelated head corruption must NOT
          // make it fail (roborev). If the merge pass throws (corrupt heads), degrade to latest-only
          // content with a warning rather than failing the refresh.
          try {
            const merged = await adapter.fetchMergedAsync({ projectRoot: cwd, fetchFn });
            throwIfMemoryCommandAborted(signal);
            const fleetDeleted = merged.deleted || new Map();
            for (const p of fleetDeleted.keys()) fetched.pages?.delete(p); // don't materialize a deleted page
            fetched.deleted = fleetDeleted; // and remove any local copy
            // normalizeLatest drops storeReal when the latest snapshot is manifest-less (empty store).
            // A deletion-only --latest pass then reaches applyMergedSnapshot, which REQUIRES a trusted
            // store root — carry it from the merge result so it never runs with storeReal undefined
            // (roborev). The merge returns a storeReal whenever it produced any deletions.
            if (!fetched.storeReal && merged.storeReal) fetched.storeReal = merged.storeReal;
          } catch (err) {
            latestDegraded = true;
            io.stderr(`memory refresh --latest: could not collect fleet deletions (${err instanceof Error ? err.message : String(err)}); proceeding with latest-snapshot content only (deletions NOT applied this pass)`);
          }
        }
        if (fetched.mode === 'local-only') {
          // Honest no-op, not an error: boot-time callers on store-less machines must not
          // fail hard. "unset = local-only" is the documented contract (roborev 11597).
          // NOTE: validate the committed brain-map only AFTER this early return — a store-less
          // machine must not fail on an invalid local map when nothing is being fetched (roborev 11623).
          io.stdout('memory refresh --from-store: no shared store configured (local-only); nothing to fetch');
          return 0;
        }
        if (fetched.mode === 'unreachable') {
          // Store WAS configured but the root is missing/unmounted — a real outage. Never
          // report success-as-if-fetched (roborev 11600). Surface this before any local-map parse.
          emitMemoryFailure(io, 'unreachable');
          io.stderr(`memory refresh --from-store: shared store unreachable (${fetched.store_root}) — mount missing or mistyped`);
          return 1;
        }
        // Only now are we actually consuming store data — validate the committed map here.
        const mapState = loadCommittedBrainMap(cwd);
        if (!mapState.ok) {
          emitMemoryFailure(io, 'invalid_payload');
          io.stderr(mapState.error);
          return mapState.code;
        }
        const pageCount = fetched.pages ? fetched.pages.size : 0;
        const deleteCount = fetched.deleted ? fetched.deleted.size : 0;
        if (pageCount === 0 && deleteCount === 0) {
          // A DEGRADED --latest (fleet-state collection threw on corrupt heads) has NOT proven the store
          // empty — there may be head-backed content/deletions we couldn't read. Do NOT bootstrap an
          // empty baseline (which would poison future delete detection) and do NOT claim success; the
          // store could not be coherently read (roborev).
          if (latestDegraded) {
            emitMemoryFailure(io, 'invalid_payload');
            io.stderr('memory refresh --latest: fleet state was unreadable and latest.json is empty — the store could not be coherently read; not bootstrapping an empty baseline (fix the corrupt heads or use the default merge to see the error)');
            return 1;
          }
          io.stdout('Refreshed memory from shared store');
          io.stdout('available_pages: 0 (store reachable, nothing published yet)');
          // Bootstrap a brand-new (provably EMPTY) store: we JUST refreshed and found NO content, heads,
          // or tombstones, so there is NO old head anywhere. That makes it SAFE to pin a FALLBACK
          // identity now even during a machine-id outage (nothing to orphan), which is what lets a first
          // publish proceed — the publish guard requires a pin, not a baseline (roborev: a stale baseline
          // is NOT proof of prior state for a pre-upgrade checkout, so only an empty store may bootstrap).
          throwIfMemoryCommandAborted(signal);
          if (!writeSyncBaseline({ projectRoot: cwd, pages: new Set(), store })) {
            emitMemoryFailure(io, 'local_precondition');
            io.stderr('memory refresh --from-store: could not persist the sync baseline under .brain/; fix .brain/ writability');
            return 1;
          }
          let rid = null;
          try { rid = await getMachineId(); } catch { /* machine id unavailable — a fallback pin is safe on an empty store */ }
          throwIfMemoryCommandAborted(signal);
          try {
            commitPublisherPin({ projectRoot: cwd, machineId: rid }); // rid or deterministic fallback — safe: store is empty
          } catch (err) {
            emitMemoryFailure(io, 'local_precondition');
            io.stderr(`memory refresh --from-store: could not persist a bootstrap publisher pin under .brain/ (${err instanceof Error ? err.message : String(err)}); a later publish will be refused — fix .brain/ writability`);
            return 1;
          }
          const mapResult = reportAgainstMap(cwd, io, mapState.map);
          return mapResult.code;
        }
        throwIfMemoryCommandAborted(signal);
        const applied = applyMergedSnapshot({
          projectRoot: cwd,
          pages: fetched.pages || new Map(),
          deleted: fetched.deleted || null,
          storeReal: fetched.storeReal,
          force: hasFlag(rest, '--force'),
        });
        io.stdout(
          useMerge
            ? `Refreshed memory from shared store (per-page merge across ${pageCount} page(s))`
            : `Refreshed memory from shared store (latest snapshot, ${pageCount} page(s))`,
        );
        io.stdout(`available_pages: ${applied.available_pages}`);
        io.stdout(`restored:        ${applied.restored.length}`);
        io.stdout(`overwritten:     ${applied.overwritten.length}`);
        io.stdout(`removed:         ${applied.removed.length}`);
        io.stdout(`unchanged:       ${applied.unchanged.length}`);
        io.stdout(`drifted:         ${applied.drifted.length}`);
        for (const rel of applied.drifted) {
          io.stderr(`drifted page left untouched: ${rel}`);
        }
        // Sync baseline = the store-backed page set INTERSECTED with what is ACTUALLY present locally
        // after apply. Two independent constraints (roborev): (1) exclude LOCAL-ONLY pages never in the
        // store, so deleting one doesn't tombstone it fleet-wide; (2) exclude store pages that did NOT
        // materialize (a refused write through a symlinked memory/, permission failure, unreadable
        // source — left in `drifted`), so a page the user never actually received isn't misread as an
        // intentional deletion on the next publish and tombstoned fleet-wide. A legitimately drifted
        // page (local edit preserved) IS present locally, so it correctly stays in the baseline.
        const localAfterRefresh = new Set(collectMemoryFiles(cwd));
        const storeBacked = fetched.pages ? [...fetched.pages.keys()] : [];
        // A failed baseline write must be surfaced, not swallowed — a later publish during a machine-id
        // outage depends on the baseline (hasSyncBaseline) and would otherwise be silently refused while
        // this refresh claimed full success (roborev). Same fatal treatment as the empty-store bootstrap.
        // PR-2a: the CAS reference for a DRIFTED page must stay at what this
        // checkout last ACCEPTED — recording the new store hash for content we
        // declined would let the very next publish fast-forward a genuine
        // both-sides conflict (delayed auto-resolve; caught red-first by T6 +
        // the daemon hermetic tests). Drifted pages keep their previous
        // baseline hash (or none), applied/unchanged pages take the new one.
        const prevBaselineHashes = readSyncBaselineHashes({ projectRoot: cwd, store });
        const baselineHashes = { ...(applied.storeHashes || {}) };
        for (const rel of applied.drifted) {
          if (prevBaselineHashes[rel]) baselineHashes[rel] = prevBaselineHashes[rel];
          else delete baselineHashes[rel];
        }
        throwIfMemoryCommandAborted(signal);
        if (!writeSyncBaseline({ projectRoot: cwd, pages: new Set(storeBacked.filter((p) => localAfterRefresh.has(p))), store, pageHashes: baselineHashes })) {
          io.stderr('memory refresh --from-store: pages were materialized but the sync baseline could NOT be persisted under .brain/ — a later publish may be refused during a machine-id outage; fix .brain/ writability');
          return 1;
        }
        // Backfill the pinned publisher identity on refresh when a REAL machine id is available.
        // Pre-upgrade checkouts have no pin file; without this, their FIRST post-upgrade publish while
        // machine-id happens to be unavailable would mint a fallback id and orphan the old real-id head
        // (roborev migration edge). Refresh is the frequent op, so this pins the real id on the common
        // path and shrinks that window to "never refreshed post-upgrade AND publishes machine-id-down".
        // Only pin a REAL id here — never a fallback during refresh, or a transient machine-id outage
        // would itself pin the wrong identity ahead of publish.
        // Pin backfill is BEST-EFFORT and never fatal to refresh — refresh is the recovery step the user
        // runs before retrying publish and does NOT require a valid pin. A machine-id outage OR a
        // corrupt/un-writable pin is caught and logged; publish handles pinning (roborev).
        try {
          const rid = await getMachineId();
          throwIfMemoryCommandAborted(signal);
          if (rid) commitPublisherPin({ projectRoot: cwd, machineId: rid });
        } catch (err) {
          throwIfMemoryCommandAborted(signal);
          io.stderr(`memory refresh: publisher-id pin backfill skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
        const mapResult = reportAgainstMap(cwd, io, mapState.map);
        if (!mapResult.ok) {
          if (mapResult.error) io.stderr(mapResult.error);
          return mapResult.code;
        }
        return 0;
      }

      const { dbPath, db } = openBrainDb(cwd);
      try {
        await ensureBrainDbReady({ db, projectRoot: cwd, dbPath });
        const result = await refreshMemoryFromBrainDb({
          db,
          projectRoot: cwd,
          force: hasFlag(rest, '--force'),
        });
        io.stdout(`Refreshed memory from ${dbPath}`);
        io.stdout(`available_pages: ${result.available_pages}`);
        io.stdout(`restored:        ${result.restored.length}`);
        io.stdout(`overwritten:     ${result.overwritten.length}`);
        io.stdout(`drifted:         ${result.drifted.length}`);
        for (const item of result.drifted) {
          io.stderr(`drifted page left untouched: ${item.page_path} (rev ${item.rev})`);
        }
        return 0;
      } finally {
        await db.close();
      }
    }

    if (subcommand === 'map') {
      const { doc, path: dest, selection } = writeBrainMap(cwd);
      const byType = {};
      for (const p of doc.pages) byType[p.type] = (byType[p.type] || 0) + 1;
      io.stdout(`Wrote ${dest}`);
      io.stdout(`brain:      ${doc.brain}`);
      io.stdout(`page_count: ${doc.page_count}`);
      io.stdout(`selection:  ${JSON.stringify(selection.counts)}`);
      io.stdout(`by type:    ${JSON.stringify(byType)}`);
      return 0;
    }

    if (subcommand === 'verify') {
      const mapState = loadCommittedBrainMap(cwd);
      if (!mapState.ok) {
        io.stderr(`memory verify failed: ${mapState.error}`);
        return mapState.code;
      }
      const map = mapState.map;
      if (!map) {
        io.stderr(`memory verify: no ${BRAIN_MAP_FILENAME} found — run: agentbootup memory map`);
        return 1;
      }
      const v = verifyAgainstMap(cwd, map);
      io.stdout(`brain-map: ${v.selectedPresent.length}/${v.expected} expected pages present`);
      io.stdout(`missing:   ${v.missing.length}`);
      io.stdout(`extra:     ${v.extra.length} (selected, not yet in the map)`);
      io.stdout(`ignored:   ${v.counts.IGNORED}`);
      io.stdout(`unselected:${String(v.counts.UNSELECTED).padStart(4, ' ')}`);
      io.stdout(`secret:    ${v.counts.SECRET_BLOCKED}`);
      for (const rel of v.missing.slice(0, 20)) io.stderr(`  MISSING ${rel}`);
      for (const rel of v.selectionMissing.slice(0, 20)) io.stderr(`  UNSELECTED_MAP_ENTRY ${rel}`);
      if (!v.policyReady || v.counts.SECRET_BLOCKED > 0) {
        io.stderr(
          `memory verify: selection policy is not ready (${v.selectionState}); ` +
          'run the local backup-selection proposal/dry-run',
        );
        return 1;
      }
      return v.missing.length > 0 || v.selectionMissing.length > 0 ? 3 : 0;
    }

    if (subcommand === 'publish') {
      const store = resolveMemoryStore(getFlagValue(rest, '--store'));
      const adapter = getMemoryStoreAdapter(store);
      publishStore = store;
      publishSnapshotId = getFlagValue(rest, '--snapshot-id') || defaultSnapshotId();
      if (!store) {
        emitMemoryFailure(io, 'local_precondition');
        io.stderr('memory publish: no shared store configured (set --store or AGENTBOOTUP_MEMORY_STORE)');
        return 1;
      }
      const drain = await replayQueuedStore({ projectRoot: cwd, store }, io);
      if (drain.code !== 0) {
        if (drain.error) io.stderr(`memory publish: ${drain.error}`);
        reportReplayResult(io, drain.result, false);
        return drain.code;
      }
      // Resolve machine identity up front so we can distinguish the user's DELETIONS (pages in this
      // publisher's prior head but absent locally now) from genuine gaps BEFORE reconcile runs.
      let realMachineId = null;
      try {
        realMachineId = await getMachineId();
      } catch (err) {
        io.stderr(`memory publish: machine id unavailable (${err instanceof Error ? err.message : String(err)})`);
      }
      // Fail CLOSED when a real machine id is unavailable AND there is no pinned identity. A sync
      // baseline is NOT a sufficient substitute (roborev): a PRE-UPGRADE checkout has a real old head
      // under its REAL machine id, but the deterministic fallback id looks at the WRONG (nonexistent)
      // head, and its baseline may be STALE (old publishes never wrote one, or it predates a later
      // publish) — so a page that existed only in the old head is published as merely "absent", never
      // tombstoned, and a stale head resurrects it. Refuse and guide the user to restore machine id or
      // refresh first. (A genuinely EMPTY store is handled safely by the bootstrap path, which pins a
      // fallback identity during refresh precisely because there is no old head to orphan.)
      if (!realMachineId && !hasPinnedPublisherId({ projectRoot: cwd })) {
        try {
          // Distinguish a genuinely absent pin from a corrupt one without persisting the fallback.
          resolvePublisherMachineId({ projectRoot: cwd, machineId: null });
        } catch (error) {
          emitMemoryFailure(io, 'local_precondition');
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
        emitMemoryFailure(io, 'local_precondition');
        io.stderr('memory publish refused: machine id unavailable and this checkout has no pinned publisher identity, so deletions cannot be detected reliably — restore machine id, or run `agentbootup memory refresh --from-store` first (an empty store pins a fallback id; otherwise fix machine id), and retry');
        return 1;
      }
      // Confirm the store is REACHABLE before pinning any identity. Pinning a fallback id during a
      // transient outage (when NO publish actually happens) would orphan the real-id head on the next
      // reachable publish — the split-head state this change avoids (roborev). Fetch the latest snapshot
      // up front and bail if unreachable, BEFORE resolvePublisherMachineId persists anything.
      const fetched = await adapter.fetchLatestAsync({ projectRoot: cwd });
      if (fetched.mode === 'unreachable') {
        emitMemoryFailure(io, 'unreachable');
        io.stderr(`memory publish: shared store unreachable (${fetched.store_root}) — mount missing or mistyped`);
        return 1;
      }
      // Never publish headless once merge is the default — a headless publish drops this checkout's
      // deletions from the fleet merge (roborev). Pin ONE stable, persisted per-checkout identity, only
      // now that we know the store is reachable and the publish will proceed.
      const machineId = resolvePublisherMachineId({ projectRoot: cwd, machineId: realMachineId });
      // Baseline of what this checkout had after its last sync (covers a FRESH checkout that
      // refreshed then deleted a shared page — it has no prior head, so the head diff alone misses
      // the deletion). Union prior-head pages with the baseline; a page in either but no longer
      // local is an intentional deletion, NOT a gap.
      const selection = resolveBrainBackupSelection(cwd);
      assertBrainBackupPolicyReady(selection, 'memory store publish');
      const historicalKnownBefore = [...
        await adapter.getPublisherHeadPageSetAsync({ projectRoot: cwd, machineId }),
        ...readSyncBaseline({ projectRoot: cwd, store }),
      ];
      const knownBefore = new Set(selectedHistoricalMemoryPaths(selection, historicalKnownBefore));
      const localBefore = new Set(collectMemoryFiles(cwd));
      const deletedByUser = [...knownBefore].filter((p) => !localBefore.has(p));
      publishDeletedPages = deletedByUser;
      publishDeletedPageTimes = Object.fromEntries(deletedByUser.map((page) => [page, Date.now()]));
      // Also honor FLEET-wide deletions. A page the fleet has tombstoned must be re-removed on publish
      // if it is either ABSENT locally (reconcile re-added it from a stale latest.json) OR present but
      // STALE — a pre-delete copy the user never re-created after the tombstone. Only a local copy
      // STRICTLY NEWER than the tombstone is a genuine re-creation and is preserved, using the same
      // floored-mtime rule as the merge (roborev — mere local presence is NOT proof of re-creation; one
      // stale checkout would otherwise undo a fleet delete by publishing unrelated work).
      const fleetDeleted = (await adapter.fetchMergedAsync({ projectRoot: cwd })).deleted || new Map();
      const reResurrected = staleFleetDeletions({ projectRoot: cwd, deleted: fleetDeleted, localBefore });

      // Pre-flight the pin BEFORE any LOCAL mutation (reconcile writes/removes below) and before the
      // store write — but ONLY when a pin must actually be CREATED. If this checkout already has a
      // valid pin, commitPublisherPin() is a no-op, so a read-only .brain/ must not block an otherwise
      // safe publish (roborev). When we do need to mint one, refusing here means neither the local
      // checkout nor the store is mutated, so a writability failure never orphans a head.
      if (!hasPinnedPublisherId({ projectRoot: cwd })) {
        assertPinPersistable({ projectRoot: cwd });
      }

      let reconcileDrift = 0;
      let reconcileRestored = 0;
      let publishDrifted = [];
      if (fetched.manifest) {
        const applied = applyFetchedSnapshot({
          projectRoot: cwd,
          manifest: fetched.manifest,
          payloadRoot: fetched.payloadRoot,
          force: false,
        });
        reportStoreReconcile(io, fetched, applied);
        reconcileDrift = applied.drifted.length;
        reconcileRestored = applied.restored.length;
        publishDrifted = applied.drifted;
      }
      // Re-remove pages reconcile should not have (re)added: our own deletions + fleet-tombstoned
      // pages we didn't have locally. Run this BEFORE any conflict exit so a same-page conflict on
      // an UNRELATED page can't strand and permanently undo a deletion on retry (roborev). A page we
      // still have locally is never in either set (preserved). removeLocalMemoryPages containment-
      // checks every path (untrusted store head data) before deleting.
      const mustDelete = new Set([...deletedByUser, ...reResurrected]);
      const { failed: removeFailed } = removeLocalMemoryPages({ projectRoot: cwd, rels: mustDelete });
      if (removeFailed.length > 0) {
        emitMemoryFailure(io, 'local_precondition');
        // A page that MUST stay deleted is still on disk (rmSync failed, or a symlinked/uncontained
        // path). Publishing now would re-include it AND suppress its tombstone (present in the head's
        // current set), silently resurrecting content the user deleted (roborev). Refuse before writing.
        io.stderr(`memory publish refused: could not remove page(s) that must stay deleted: ${removeFailed.join(', ')} — publishing would resurrect them; fix permissions/symlinks and retry`);
        return 1;
      }
      if (reconcileDrift > 0) {
        // PR-2a fast-forward (decisive ruling msg-1784305375296): a drifted
        // page may publish iff ONLY the local side moved — local strictly
        // newer (normalized ms) than the merged store marker AND the store's
        // VALIDATED bytes still hash-equal this checkout's baseline (the
        // compare-and-swap reference recorded at last sync). Store divergence
        // since our sync (both-sides-moved, stale baseline, forged markers
        // with changed bytes) stays exit 3 — merge first. ALL drifted pages
        // must be eligible; one ineligible page fails the whole publish.
        const ffOk = await allDriftedFastForwardable({ cwd, store, adapter, drifted: publishDrifted });
        if (!ffOk.ok) {
          // Reconciliation never forces remote bytes over local drift; only missing remote pages can
          // have been materialized before this conflict is reported.
          const mergeSummary = reconcileRestored > 0
            ? ` ${reconcileRestored} non-conflicting page(s) were written to memory/; review memory/ before retrying.`
            : '';
          io.stderr(`memory publish conflict: merge drifted pages with the shared snapshot before publishing.${ffOk.reason ? ` (${ffOk.reason})` : ''}${mergeSummary}`);
          const conflict = normalizeMemoryConflict(ffOk.conflict);
          const details = formatConflictDetails(conflict);
          if (details) io.stderr(`memory conflict details: ${details}`);
          io.conflict?.(conflict);
          emitMemoryFailure(io, 'conflict', conflict);
          return 3;
        }
        io.stdout(`fast-forward publish: ${reconcileDrift} locally-edited page(s) — store unchanged since last sync (only-local-moved)`);
      }
      const snapshotId = publishSnapshotId;
      // File-store latest.json is an atomic pointer but not a compare-and-swap. Concurrent
      // publishers may still race after this best-effort reconciliation; store-level locking
      // or a conditional pointer update is required before claiming a hard lost-update guard.
      // Pass the detected deletions so publish tombstones them even when this checkout has no prior
      // head (fresh-checkout first-publish delete, detected via the sync baseline). The head is keyed
      // by the RESOLVED machineId (deterministic even without a persisted pin), so it is written under
      // the same identity the pin will record.
      // publishMemoryToStore resolves+persists the pinned identity itself (after the store write
      // succeeds), so no separate CLI-side commit is needed. The CLI's earlier assertPinPersistable
      // pre-flight (before local reconcile) is what guarantees that internal commit cannot fail.
      const result = await adapter.publishAsync({
        projectRoot: cwd,
        snapshotId,
        machineId,
        deletedPages: deletedByUser,
        authoritativePriorPages: [...knownBefore],
      });
      if (result.version_id) {
        io.stdout(`Published memory to shared store: ${result.version_id}`);
        io.stdout(`pages:      ${result.pages}`);
        io.stdout(`store_path: ${result.store_path}`);
      } else {
        // Empty memory/ → tombstone-only head (deletions recorded; no content snapshot).
        io.stdout('Published memory to shared store: empty (tombstone-only — all local pages deleted)');
      }
      // Record the post-publish page set as the new sync baseline for future delete detection. The
      // publish already SUCCEEDED (head + pin durable), so a failed baseline write here is a non-fatal
      // WARNING, not a failure — the head/tombstones are the primary signal; the baseline only aids a
      // future fresh-checkout delete detection (roborev: handle post-publish baseline separately).
      const publishedHashes = {};
      for (const rel of collectMemoryFiles(cwd)) {
        try { publishedHashes[rel] = sha256Hex(fs.readFileSync(path.join(cwd, rel))); } catch { /* absent → no hash */ }
      }
      if (!writeSyncBaseline({ projectRoot: cwd, pages: new Set(collectMemoryFiles(cwd)), store, pageHashes: publishedHashes })) {
        io.stderr('memory publish: WARNING — published successfully, but the sync baseline could not be updated under .brain/; future delete detection on this checkout may use stale state until .brain/ is writable');
      }
      if (result.unretired) {
        io.stderr('memory publish: WARNING — this publisher head had been retired and is now live again');
      }
      return 0;
    }

    if (subcommand === 'retire-head') {
      const publisherId = rest[1];
      if (!publisherId) {
        io.stderr('memory retire-head: missing publisher id');
        return 1;
      }
      const store = resolveMemoryStore(getFlagValue(rest, '--store'));
      if (!store) {
        io.stderr('memory retire-head: no shared store configured (set --store or AGENTBOOTUP_MEMORY_STORE)');
        return 1;
      }
      let machineId = null;
      try { machineId = await getMachineId(); } catch { /* retired_by_machine_id is best-effort only */ }
      const adapter = getMemoryStoreAdapter(store);
      const result = await adapter.retirePublisherHeadAsync({
        projectRoot: cwd,
        publisherId,
        retiredByMachineId: machineId,
      });
      io.stdout(`Retired publisher head: ${result.publisherId}`);
      io.stdout(`retired_at: ${result.retiredAt}`);
      if (result.alreadyRetired) {
        io.stderr('memory retire-head: head was already retired; refreshed marker timestamp');
      }
      return 0;
    }

    if (subcommand === 'flush') {
      const store = resolveMemoryStore(getFlagValue(rest, '--store'));
      const { dbPath, db } = openBrainDb(cwd);
      let captureResult;
      try {
        await ensureBrainDbReady({ db, projectRoot: cwd, dbPath });
        let machineId = null;
        try { machineId = await getMachineId(); } catch { /* capture is still safe without a machine id */ }
        captureResult = await captureMemoryToBrainDb({
          db,
          projectRoot: cwd,
          machineId,
          pruneMissing: hasFlag(rest, '--prune-missing'),
        });
      } finally {
        await db.close();
      }
      const sync = triggerBrainDbSyncSignal(cwd);
      if (sync.signaled) {
        io.stdout(`brain-db-sync: signaled PID ${sync.pid} via SIGUSR1`);
      } else {
        io.stdout(`brain-db-sync: ${sync.reason}`);
      }
      if (!store) {
        io.stdout(`Flushed ${captureResult.captured.length} memory page(s) into ${dbPath}`);
        io.stdout(`scanned:   ${captureResult.scanned}`);
        io.stdout(`deleted:   ${captureResult.deleted.length}`);
        io.stdout(`unchanged: ${captureResult.unchanged.length}`);
        return 0;
      }
      // Empty memory is a valid tombstone-only publish, but cannot be represented as
      // a replay payload (which intentionally requires at least one immutable file).
      if (collectMemoryFiles(cwd).length === 0) {
        const storeRef = store.scheme === 'file'
          ? `file://${store.root}`
          : store.scheme === 'server'
            ? `server://${store.brainId || ''}`
            : `${store.scheme}://`;
        return runMemoryCommand(['publish', '--cwd', cwd, '--store', storeRef, '--snapshot-id', getFlagValue(rest, '--snapshot-id') || defaultSnapshotId()], io);
      }
      // Freeze the requested state before any publish preflight can fail. The delegated
      // replay drains only this durable FIFO item; it never re-publishes live memory.
      const snapshotId = getFlagValue(rest, '--snapshot-id') || defaultSnapshotId();
      const localPages = new Set(collectMemoryFiles(cwd));
      const deletedPages = [...readSyncBaseline({ projectRoot: cwd, store })].filter((page) => !localPages.has(page));
      const deletedPageTimes = Object.fromEntries(deletedPages.map((page) => [page, Date.now()]));
      const queued = enqueueReplayItem({ projectRoot: cwd, store, snapshotId, deletedPages, deletedPageTimes });
      io.stdout(`Queued memory flush: ${queued.item.id}`);
      const replay = await replayQueuedStore({ projectRoot: cwd, store }, io);
      if (replay.error) io.stderr(`memory flush: ${replay.error}`);
      reportReplayResult(io, replay.result, hasFlag(rest, '--json'));
      return replay.code;
    }

    if (subcommand === 'replay') {
      const inspectId = getFlagValue(rest, '--inspect');
      const discardId = getFlagValue(rest, '--discard');
      if (inspectId && discardId) {
        io.stderr('memory replay: use only one of --inspect or --discard');
        return 1;
      }
      if (inspectId) {
        // Inspection is forensic/read-only. In particular, malformed payloads
        // must remain inspectable without changing FIFO state or metadata.
        const inspected = inspectReplayItem({ projectRoot: cwd, id: inspectId });
        if (hasFlag(rest, '--json')) io.stdout(stringifyJsonEnvelope(inspected));
        else {
          io.stdout(`id: ${inspected.item.id}`);
          io.stdout(`store_identity: ${inspected.item.store_identity}`);
          io.stdout(`attempt_count: ${inspected.item.attempt_count}`);
          io.stdout(`last_outcome: ${inspected.item.last_outcome?.type ?? 'none'}`);
          io.stdout(`payload_valid: ${inspected.payload.valid}`);
        }
        return inspected.payload.valid ? 0 : 1;
      }
      if (discardId) {
        if (!hasFlag(rest, '--confirm-loss')) {
          io.stderr('memory replay: --discard requires literal --confirm-loss');
          return 1;
        }
        const head = isReplayHead({ projectRoot: cwd, id: discardId });
        const outcome = head.item.last_outcome?.type;
        if (!head.isHead || !['blocked_conflict', 'degraded', 'failed_invalid_payload'].includes(outcome)) {
          io.stderr('memory replay: only the current terminal FIFO head may be discarded');
          return 1;
        }
        removeReplayItem({ projectRoot: cwd, id: discardId });
        io.stderr(`memory replay: discarded ${discardId}; frozen delivery payload was intentionally lost`);
        return 0;
      }
      const store = resolveMemoryStore(getFlagValue(rest, '--store'));
      if (!store) {
        io.stderr('memory replay: no shared store configured (set --store or AGENTBOOTUP_MEMORY_STORE)');
        return 1;
      }
      const replay = await replayQueuedStore({ projectRoot: cwd, store }, io);
      if (replay.error) io.stderr(`memory replay: ${replay.error}`);
      reportReplayResult(io, replay.result, hasFlag(rest, '--json'));
      return replay.code;
    }

    if (subcommand === 'snapshot') {
      const snapshotId = getFlagValue(rest, '--snapshot-id') || defaultSnapshotId();
      const files = collectMemoryFiles(cwd);
      if (files.length === 0) {
        io.stderr('memory snapshot failed: no files found under memory/');
        return 1;
      }
      const manifest = createMemorySnapshotManifest({
        targetRoot: cwd,
        snapshotId,
        files,
        sourceRepo: 'local-memory',
      });
      const published = publishBundle({
        manifest,
        sourceRoot: cwd,
        dryRun: hasFlag(rest, '--dry-run'),
      });
      io.stdout(
        `${published.dry_run ? 'Would publish' : 'Published'} memory snapshot ${manifest.version_id} → ${published.publish_root}`,
      );
      io.stdout(`bundle_store: ${getBundleStoreRoot()}`);
      return 0;
    }

    if (subcommand === 'restore') {
      const snapshot = getFlagValue(rest, '--snapshot');
      if (!snapshot) {
        io.stderr('memory restore failed: --snapshot <manifest-path> is required');
        return 1;
      }
      const target = path.resolve(getFlagValue(rest, '--target') || cwd);
      const manifestPath = path.resolve(snapshot);
      const { manifest } = loadBundleManifest(manifestPath);
      if (manifest.bundle_type !== 'memory_snapshot') {
        io.stderr(`memory restore failed: ${manifestPath} is not a memory_snapshot manifest`);
        return 1;
      }
      const sourceRoot = path.join(path.dirname(manifestPath), 'payload');
      const result = installBundle({
        manifest,
        sourceRoot,
        targetRoot: target,
        force: hasFlag(rest, '--force'),
        dryRun: hasFlag(rest, '--dry-run'),
      });
      io.stdout(
        result.noop
          ? result.reason
          : `${result.dry_run ? 'Dry-run restored' : 'Restored'} memory snapshot ${manifest.version_id}`,
      );
      if (!result.noop) {
        io.stdout(`target:     ${target}`);
        io.stdout(`state_path: ${result.state_path}`);
      }
      return 0;
    }

    io.stdout(usage());
    return 1;
  } catch (error) {
    if (subcommand === 'publish' && publishStore && isDeferrableMemoryStoreError(error)) {
      try {
        const queued = enqueueReplayItem({ projectRoot: cwd, store: publishStore, snapshotId: publishSnapshotId, deletedPages: publishDeletedPages, deletedPageTimes: publishDeletedPageTimes });
        const retryStoreRef = publishStore.scheme === 'file'
          ? `file://${publishStore.root}`
          : publishStore.scheme === 'server'
            ? `server://${publishStore.brainId || ''}`
            : `${publishStore.scheme}://`;
        io.stderr(`memory publish deferred: ${error.code}; queued ${queued.item.id} at ${queued.queue.paths.queuePath}`);
        io.stderr(`retry: agentbootup memory replay --cwd ${cwd} --store ${retryStoreRef}`);
        emitMemoryFailure(io, 'unreachable');
        return 4;
      } catch (queueError) {
        emitMemoryFailure(io, 'local_precondition');
        io.stderr(`memory publish failed: transient store error could not be queued (${queueError instanceof Error ? queueError.message : String(queueError)})`);
        return 1;
      }
    }
    emitKnownMemoryError(io, error);
    io.stderr(`memory failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
