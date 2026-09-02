// Transport-agnostic seam for shared memory stores (PRD-0054 PR-3a / Slice C).
//
// PR-3a deliberately does NOT pick or wire a remote transport backend. Instead it
// defines one adapter contract that binds the existing file-backed store API today
// and leaves non-file schemes loud + unsupported until PR-3b. This gives the next
// slice a stable interface and contract tests without perturbing the proven file://
// implementation that already carries the memory safety protocol.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  assertPinPersistable,
  commitPublisherPin,
  fetchLatestFromStore,
  fetchMergedFromStore,
  getPublisherHeadPageSet,
  hasPinnedPublisherId,
  isDeferrableMemoryStoreError,
  localMemoryMatchesOwnHead,
  publishMemoryToStore,
  retirePublisherHead,
  resolveMemoryStore,
  resolvePublisherMachineId,
  staleFleetDeletions,
  validateReplayPublicationFiles,
} from './store.js';
import { assertContainedRelativePath } from '../bundle/manifest-schema.js';
import {
  collectMemoryFiles,
  computeBundleHash,
  createMemorySnapshotManifest,
} from '../bundle/installer.js';
import {
  assertHistoricalMemoryPathsSelected,
  assertBrainBackupPolicyReady,
  resolveBrainBackupSelection,
} from './brain-backup-selection.js';
import { createMemoryConflict } from './conflict.js';
import { calculateNextTombstones } from './tombstones.js';
import {
  headAssetPath,
  headPathPrefix,
  latestAssetPath,
  listRemoteMemoryAssetHashes,
  pullRemoteJsonAsset,
  pullRemoteSingleAsset,
  pushRemoteMemoryAssets,
  pushRemoteJsonAsset,
  resolveRemoteMemoryStoreConfig,
  snapshotManifestAssetPath,
  snapshotMarkersAssetPath,
  snapshotPayloadAssetPath,
} from './remote-store.js';

export { resolveMemoryStore, isDeferrableMemoryStoreError } from './store.js';

function isNotFoundError(error) {
  return Number(error?.status) === 404 || String(error?.code || '') === 'not_found';
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function publisherHeadIdFor({ machineId, projectRoot }) {
  const checkoutReal = fs.realpathSync(path.resolve(projectRoot));
  return crypto
    .createHash('sha256')
    .update(`${String(machineId)}\0${checkoutReal}`)
    .digest('hex')
    .slice(0, 24);
}

function safeMemoryPageKey(key) {
  if (typeof key !== 'string') return null;
  try {
    const rel = assertContainedRelativePath(key, 'remote head page key');
    return rel.startsWith('memory/') ? rel : null;
  } catch {
    return null;
  }
}

function remoteSnapshotCacheRoot(projectRoot, bundleHash) {
  const safeBundleHash = String(bundleHash || '').replace(/^sha256:/, '');
  return path.join(path.resolve(projectRoot), '.brain', 'remote-memory-cache', safeBundleHash);
}

function remoteSnapshotCacheBase(projectRoot) {
  return path.join(path.resolve(projectRoot), '.brain', 'remote-memory-cache');
}

const DEFAULT_REMOTE_READ_CONCURRENCY = 8;
const MAX_REMOTE_READ_CONCURRENCY = 16;

function remoteReadConcurrency() {
  const raw = process.env.AGENTBOOTUP_MEMORY_REMOTE_READ_CONCURRENCY;
  if (raw === undefined || raw === '') return DEFAULT_REMOTE_READ_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_REMOTE_READ_CONCURRENCY) {
    throw new Error(`AGENTBOOTUP_MEMORY_REMOTE_READ_CONCURRENCY must be an integer from 1 to ${MAX_REMOTE_READ_CONCURRENCY}`);
  }
  return parsed;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function publisherHeadMarkers({ sourceRoot, files, replayPayload = false, replayMtimes = null }) {
  const sourceReal = fs.realpathSync(path.resolve(sourceRoot));
  const markers = {};
  for (const rel of files) {
    const relN = assertContainedRelativePath(rel, 'memory file');
    try {
      markers[relN] = replayPayload ? Number(replayMtimes?.[relN]) : fs.statSync(path.join(sourceReal, relN)).mtimeMs;
    } catch {
      // omitted marker falls back to head/latest recency in merge logic
    }
  }
  return markers;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeRetiredHead(head, { retiredAt, retiredByMachineId, retiredByAgentId }) {
  if (!head || typeof head !== 'object' || Array.isArray(head)) {
    throw new Error('memory retire-head refused: publisher head is invalid');
  }
  return {
    ...head,
    retired: true,
    retirement: {
      ...(head.retirement && typeof head.retirement === 'object' && !Array.isArray(head.retirement) ? head.retirement : {}),
      retired_at: retiredAt,
      ...(retiredByMachineId ? { retired_by_machine_id: retiredByMachineId } : {}),
      retired_by_agent_id: retiredByAgentId,
    },
  };
}

function assertRemoteSnapshotManifest({ remote, bundleHash, manifest }) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
    throw new Error('memory fetch refused: malformed manifest (expected an object with a files array)');
  }
  if (manifest.bundle_type !== 'memory_snapshot') {
    throw new Error(`memory fetch refused: not a memory_snapshot (bundle_type="${manifest.bundle_type}")`);
  }
  if (
    manifest.bundle_name !== remote.brainId ||
    manifest?.source?.agent_id !== remote.brainId ||
    manifest.bundle_hash !== bundleHash
  ) {
    throw new Error(
      `memory fetch refused: snapshot identity (name="${manifest.bundle_name}", ` +
        `agent="${manifest?.source?.agent_id}", hash="${manifest.bundle_hash}") ` +
        `does not match the store pointer (agent="${remote.brainId}", hash="${bundleHash}")`,
    );
  }
}

async function materializeRemoteSnapshot({ projectRoot, remote, bundleHash, manifest, adapter, fetchFn, credentialsReader }) {
  assertRemoteSnapshotManifest({ remote, bundleHash, manifest });
  const cacheRoot = remoteSnapshotCacheRoot(projectRoot, bundleHash);
  const payloadRoot = path.join(cacheRoot, 'payload');
  const manifestPath = path.join(cacheRoot, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    fs.mkdirSync(payloadRoot, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  const missing = [];
  for (const file of manifest.files || []) {
    const rel = assertContainedRelativePath(file.target, 'remote snapshot manifest target');
    if (file.source !== file.target) {
      throw new Error(`remote snapshot requires source===target (source="${file.source}" target="${file.target}")`);
    }
    const dst = path.join(payloadRoot, rel);
    if (fs.existsSync(dst)) continue;
    missing.push({ rel, dst });
  }

  // Each payload object is independently addressable and integrity is checked
  // across the complete snapshot below. A bounded worker pool avoids turning a
  // large brain into hundreds of serial network round trips while preserving a
  // strict concurrency ceiling for the server and local file descriptors.
  const workers = Math.min(remoteReadConcurrency(), missing.length);
  let next = 0;
  const failures = [];
  await Promise.all(Array.from({ length: workers }, async () => {
    while (failures.length === 0) {
      const index = next++;
      if (index >= missing.length) return;
      const { rel, dst } = missing[index];
      try {
        const asset = await adapter.readSnapshotPayload({
          projectRoot,
          bundleHash,
          relPath: rel,
          fetchFn,
          credentialsReader,
        });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, Buffer.from(asset.content_base64, 'base64'));
      } catch (error) {
        failures.push(error);
      }
    }
  }));
  if (failures.length > 0) {
    // Keep completed objects as resumable cache. They are not trusted until
    // the full bundle hash verifies below, and an integrity failure removes
    // the whole cache. All workers settle before the error escapes, so no late
    // writer can race a caller's retry.
    throw failures[0];
  }

  const verify = computeBundleHash(manifest, payloadRoot);
  if (verify !== manifest.bundle_hash) {
    try {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    } catch {
      // Best effort only; integrity failure remains the authoritative outcome.
    }
    throw new Error(`memory fetch failed: bundle integrity ${verify} != manifest ${manifest.bundle_hash}`);
  }

  return { remote, manifest, payloadRoot, cacheRoot };
}

function createLocalOnlyAdapter() {
  return {
    mode: 'local-only',
    scheme: 'local-only',
    store: null,
    publish(opts) { return publishMemoryToStore({ ...opts, store: null }); },
    fetchLatest(opts) { return fetchLatestFromStore({ ...opts, store: null }); },
    fetchMerged(opts) { return fetchMergedFromStore({ ...opts, store: null }); },
    localMatchesOwnHead(opts) { return localMemoryMatchesOwnHead({ ...opts, store: null }); },
    getPublisherHeadPageSet(opts) { return getPublisherHeadPageSet({ ...opts, store: null }); },
    async publishAsync(opts) { return this.publish(opts); },
    async fetchLatestAsync(opts) { return this.fetchLatest(opts); },
    async fetchMergedAsync(opts) { return this.fetchMerged(opts); },
    async localMatchesOwnHeadAsync(opts) { return this.localMatchesOwnHead(opts); },
    async getPublisherHeadPageSetAsync(opts) { return this.getPublisherHeadPageSet(opts); },
    async retirePublisherHeadAsync() {
      throw new Error('memory retire-head: no shared store configured');
    },
  };
}

function createUnsupportedAdapter(store) {
  const fail = () => {
    throw new Error(`memory store scheme not yet supported: ${store.scheme} (PR-3a ships the seam only; transport lands in PR-3b)`);
  };
  return {
    mode: 'unsupported',
    scheme: store.scheme,
    store,
    publish() { return fail(); },
    fetchLatest() { return fail(); },
    fetchMerged() { return fail(); },
    localMatchesOwnHead() { return fail(); },
    getPublisherHeadPageSet() { return fail(); },
    async publishAsync() { return fail(); },
    async fetchLatestAsync() { return fail(); },
    async fetchMergedAsync() { return fail(); },
    async localMatchesOwnHeadAsync() { return fail(); },
    async getPublisherHeadPageSetAsync() { return fail(); },
    async retirePublisherHeadAsync() { return fail(); },
  };
}

function createFileAdapter(store) {
  return {
    mode: 'store',
    scheme: 'file',
    store,
    publish(opts) { return publishMemoryToStore({ ...opts, store }); },
    fetchLatest(opts) { return fetchLatestFromStore({ ...opts, store }); },
    fetchMerged(opts) { return fetchMergedFromStore({ ...opts, store }); },
    localMatchesOwnHead(opts) { return localMemoryMatchesOwnHead({ ...opts, store }); },
    getPublisherHeadPageSet(opts) { return getPublisherHeadPageSet({ ...opts, store }); },
    async publishAsync(opts) { return this.publish(opts); },
    async fetchLatestAsync(opts) { return this.fetchLatest(opts); },
    async fetchMergedAsync(opts) { return this.fetchMerged(opts); },
    async localMatchesOwnHeadAsync(opts) { return this.localMatchesOwnHead(opts); },
    async getPublisherHeadPageSetAsync(opts) { return this.getPublisherHeadPageSet(opts); },
    async retirePublisherHeadAsync(opts) { return retirePublisherHead({ ...opts, store }); },
  };
}

function createServerAdapter(store) {
  async function remoteConfig(opts = {}) {
    return resolveRemoteMemoryStoreConfig({
      projectRoot: opts.projectRoot,
      store,
      credentialsReader: opts.credentialsReader,
    });
  }

  const fail = () => {
    throw new Error('server-backed memory store requires async adapter methods (use publishAsync/fetchLatestAsync/...)');
  };

  function resolveServerPublisherId(opts) {
    if (opts.publisherId) return opts.publisherId;
    if (opts.machineId) return publisherHeadIdFor({ machineId: opts.machineId, projectRoot: opts.projectRoot });
    const publisherMachineId = resolvePublisherMachineId({ projectRoot: opts.projectRoot, machineId: null });
    return publisherHeadIdFor({ machineId: publisherMachineId, projectRoot: opts.projectRoot });
  }

  return {
    mode: 'store',
    scheme: 'server',
    store,
    publish() { return fail(); },
    fetchLatest() { return fail(); },
    fetchMerged() { return fail(); },
    localMatchesOwnHead() { return fail(); },
    getPublisherHeadPageSet() { return fail(); },
    async remoteConfig(opts) { return remoteConfig(opts); },
    async publishAsync(opts) {
      const remote = await remoteConfig(opts);
      const sourceRoot = opts.sourceRoot || opts.projectRoot;
      const selection = resolveBrainBackupSelection(opts.projectRoot);
      assertBrainBackupPolicyReady(selection, 'memory store publish');
      const publisherMachineId = resolvePublisherMachineId({ projectRoot: opts.projectRoot, machineId: opts.machineId ?? null });
      if (!hasPinnedPublisherId({ projectRoot: opts.projectRoot })) {
        assertPinPersistable({ projectRoot: opts.projectRoot });
      }

      const allFiles = opts.replayPayload
        ? validateReplayPublicationFiles(opts.replayFiles, opts.replayMtimes)
        : collectMemoryFiles(sourceRoot, 'memory store publish');
      if (opts.replayPayload) {
        assertHistoricalMemoryPathsSelected(selection, allFiles, 'memory store replay');
      }
      let staleSet = new Set();
      if (opts.replayPayload) {
        const fleetDeleted = (await this.fetchMergedAsync(opts)).deleted || new Map();
        const staleQueuedPages = allFiles.filter((page) => {
          const tombstone = fleetDeleted.get(page);
          return tombstone !== undefined && Math.floor(Number(opts.replayMtimes[page])) <= Number(tombstone);
        });
        if (staleQueuedPages.length > 0) {
          const error = new Error(`memory replay conflict: frozen payload would resurrect fleet-deleted page(s): ${staleQueuedPages.join(', ')}`);
          error.code = 'MEMORY_REPLAY_CONFLICT';
          error.conflict = createMemoryConflict(staleQueuedPages.map((path) => ({ path, reason_code: 'tombstone_resurrection' })));
          throw error;
        }
      } else {
        try {
          const fleetDeleted = (await this.fetchMergedAsync(opts)).deleted || new Map();
          staleSet = new Set(staleFleetDeletions({ projectRoot: opts.projectRoot, deleted: fleetDeleted, localBefore: new Set(allFiles) }));
        } catch {
          // best-effort only for direct non-replay callers
        }
      }

      const files = allFiles.filter((rel) => !staleSet.has(rel));
      const deletions = [...new Set([...(opts.deletedPages || []), ...staleSet])];
      const publisherId = publisherHeadIdFor({ machineId: publisherMachineId, projectRoot: opts.projectRoot });

      let prevHead = null;
      try {
        prevHead = await this.readHead({ ...opts, publisherId });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }

      if (files.length === 0) {
        const head = {
          version_id: null,
          bundle_hash: null,
          machine_id: publisherMachineId,
          markers: {},
          tombstones: calculateNextTombstones({
            prevMarkers: prevHead?.markers || {},
            prevTombstones: prevHead?.tombstones || {},
            markers: {},
            extraDeletions: deletions,
            extraDeletionTimes: opts.deletedPageTimes || {},
            authoritativePriorPages: opts.authoritativePriorPages || [],
            selection,
          }),
          updated_at: new Date().toISOString(),
        };
        await this.writeHead({ ...opts, publisherId, head });
        const persistedHead = await this.readHead({ ...opts, publisherId });
        if (
          !persistedHead ||
          persistedHead.bundle_hash !== null ||
          persistedHead.version_id !== null ||
          !sameJson(persistedHead.markers || {}, head.markers) ||
          !sameJson(persistedHead.tombstones || {}, head.tombstones)
        ) {
          throw new Error('memory publish failed: server did not durably reflect the tombstone-only publisher head after write');
        }
        commitPublisherPin({ projectRoot: opts.projectRoot, machineId: publisherMachineId });
        return { mode: 'store', published: true, version_id: null, store_path: null, pages: 0, unretired: Boolean(prevHead?.retired || prevHead?.retirement?.retired_at) };
      }

      const manifest = createMemorySnapshotManifest({
        targetRoot: sourceRoot,
        snapshotId: opts.snapshotId,
        files,
        sourceRepo: 'local-memory',
        agentId: remote.brainId,
      });
      const markers = publisherHeadMarkers({
        sourceRoot,
        files,
        replayPayload: Boolean(opts.replayPayload),
        replayMtimes: opts.replayMtimes || null,
      });

      if (opts.replayPayload) {
        const latest = await this.fetchLatestAsync(opts);
        const ownHeadBundleHash = prevHead?.bundle_hash || null;
        const latestBelongsToThisPublisher = latest.manifest && ownHeadBundleHash && ownHeadBundleHash === latest.manifest.bundle_hash;
        if (latest.manifest && !latestBelongsToThisPublisher) {
          const remoteByTarget = new Map(latest.manifest.files.map((file) => [file.target, file]));
          for (const file of manifest.files) {
            const remoteFile = remoteByTarget.get(file.target);
            if (!remoteFile) continue;
            const localBytes = fs.readFileSync(path.join(sourceRoot, file.source));
            const remoteBytes = fs.readFileSync(path.join(latest.payloadRoot, remoteFile.source));
            if (!localBytes.equals(remoteBytes)) {
              const error = new Error(`memory replay conflict: frozen payload differs from shared page ${file.target}`);
              error.code = 'MEMORY_REPLAY_CONFLICT';
              error.conflict = createMemoryConflict([{ path: file.target, reason_code: 'shared_page_bytes_differ' }]);
              throw error;
            }
          }
        }
      }

      // Snapshot publication is a two-phase protocol. Payload blobs may be
      // chunked across requests, so every payload chunk must succeed before
      // the manifest/markers make the snapshot discoverable. Unreferenced
      // payload blobs are safe to leave behind after a partial failure.
      const snapshotPayloadFiles = [];
      for (const rel of files) {
        const safeRel = assertContainedRelativePath(rel, 'memory file');
        const content = fs.readFileSync(path.join(fs.realpathSync(path.resolve(sourceRoot)), safeRel));
        snapshotPayloadFiles.push({
          path: snapshotPayloadAssetPath(manifest.bundle_hash, safeRel),
          content_base64: content.toString('base64'),
          asset_type: 'memory',
          cli: 'shared',
        });
      }
      const snapshotCommitFiles = [{
        path: snapshotManifestAssetPath(manifest.bundle_hash),
        content_base64: encodeJson(manifest),
        asset_type: 'memory',
        cli: 'shared',
      }, {
        path: snapshotMarkersAssetPath(manifest.bundle_hash),
        content_base64: encodeJson(markers),
        asset_type: 'memory',
        cli: 'shared',
      }];
      await pushRemoteMemoryAssets({
        remote,
        files: snapshotPayloadFiles,
        fetchFn: opts.fetchFn,
      });
      await pushRemoteMemoryAssets({
        remote,
        files: snapshotCommitFiles,
        fetchFn: opts.fetchFn,
      });
      const persistedManifest = await this.readSnapshotManifest({
        ...opts,
        projectRoot: opts.projectRoot,
        bundleHash: manifest.bundle_hash,
      });
      await materializeRemoteSnapshot({
        projectRoot: opts.projectRoot,
        remote,
        bundleHash: manifest.bundle_hash,
        manifest: persistedManifest,
        adapter: this,
        fetchFn: opts.fetchFn,
        credentialsReader: opts.credentialsReader,
      });

      const head = {
        version_id: manifest.version_id,
        bundle_hash: manifest.bundle_hash,
        machine_id: publisherMachineId,
        markers,
        tombstones: calculateNextTombstones({
          prevMarkers: prevHead?.markers || {},
          prevTombstones: prevHead?.tombstones || {},
          markers,
          extraDeletions: deletions,
          extraDeletionTimes: opts.deletedPageTimes || {},
          authoritativePriorPages: opts.authoritativePriorPages || [],
          selection,
        }),
        updated_at: new Date().toISOString(),
      };
      await this.writeHead({ ...opts, publisherId, head });
      const persistedHead = await this.readHead({ ...opts, publisherId });
      if (
        !persistedHead ||
        persistedHead.bundle_hash !== head.bundle_hash ||
        persistedHead.version_id !== head.version_id ||
        !sameJson(persistedHead.markers || {}, head.markers) ||
        !sameJson(persistedHead.tombstones || {}, head.tombstones)
      ) {
        throw new Error('memory publish failed: server did not durably reflect the publisher head after write');
      }
      await this.writeLatest({
        ...opts,
        latest: {
          version_id: manifest.version_id,
          bundle_hash: manifest.bundle_hash,
          pages: manifest.files.length,
          updated_at: new Date().toISOString(),
        },
      });
      commitPublisherPin({ projectRoot: opts.projectRoot, machineId: publisherMachineId });
      return {
        mode: 'store',
        published: true,
        version_id: manifest.version_id,
        store_path: `${remote.brainId}/${manifest.bundle_hash}`,
        pages: manifest.files.length,
        unretired: Boolean(prevHead?.retired || prevHead?.retirement?.retired_at),
      };
    },
    async fetchLatestAsync(opts) {
      const remote = await remoteConfig(opts);
      let latest;
      try {
        latest = await this.readLatest({ ...opts, projectRoot: opts.projectRoot });
      } catch (error) {
        if (isNotFoundError(error)) return { mode: 'store', manifest: null };
        throw error;
      }
      if (!latest?.bundle_hash) return { mode: 'store', manifest: null };
      const manifest = await this.readSnapshotManifest({
        ...opts,
        projectRoot: opts.projectRoot,
        bundleHash: latest.bundle_hash,
      });
      const materialized = await materializeRemoteSnapshot({
        projectRoot: opts.projectRoot,
        remote,
        bundleHash: latest.bundle_hash,
        manifest,
        adapter: this,
        fetchFn: opts.fetchFn,
        credentialsReader: opts.credentialsReader,
      });
      return { mode: 'store', manifest, payloadRoot: materialized.payloadRoot };
    },
    async fetchMergedAsync(opts) {
      const remote = await remoteConfig(opts);
      let headFiles = [];
      try {
        headFiles = (await this.listHeads(opts))?.files || [];
      } catch (error) {
        if (isNotFoundError(error)) return { mode: 'store', pages: null, deleted: new Map() };
        throw error;
      }

      const allTombstones = new Map();
      const allContentMarkers = new Map();
      const entries = [];
      let invalidContentPointers = 0;

      const mergeInto = (map, obj) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        for (const [key, value] of Object.entries(obj)) {
          const rel = safeMemoryPageKey(key);
          if (rel === null) continue;
          const n = Number(value);
          if (!Number.isFinite(n)) continue;
          map.set(rel, Math.max(finiteOr(map.get(rel), 0), n));
        }
      };

      const snapshotCache = new Map();
      const loadSnapshot = async (bundleHash) => {
        if (snapshotCache.has(bundleHash)) return snapshotCache.get(bundleHash);
        let snapshot = null;
        try {
          const manifest = await this.readSnapshotManifest({ ...opts, bundleHash });
          const materialized = await materializeRemoteSnapshot({
            projectRoot: opts.projectRoot,
            remote,
            bundleHash,
            manifest,
            adapter: this,
            fetchFn: opts.fetchFn,
            credentialsReader: opts.credentialsReader,
          });
          let rawMarkers = {};
          try {
            rawMarkers = await this.readSnapshotMarkers({ ...opts, bundleHash });
          } catch (error) {
            if (!isNotFoundError(error)) throw error;
          }
          const targets = new Set();
          const versionMarkers = {};
          for (const file of manifest.files || []) {
            const rel = safeMemoryPageKey(file?.target);
            if (!rel) continue;
            targets.add(rel);
            if (rawMarkers && Object.prototype.hasOwnProperty.call(rawMarkers, rel)) {
              versionMarkers[rel] = rawMarkers[rel];
            }
          }
          snapshot = { manifest, payloadRoot: materialized.payloadRoot, versionMarkers, targets };
        } catch {
          snapshot = null;
        }
        snapshotCache.set(bundleHash, snapshot);
        return snapshot;
      };

      for (const file of headFiles) {
        const headPath = typeof file?.path === 'string' ? file.path : null;
        if (!headPath || !headPath.startsWith('memory-store/heads/') || !headPath.endsWith('.json')) continue;
        const publisherId = path.basename(headPath, '.json');
        try {
          const head = await this.readHead({ ...opts, publisherId });
          mergeInto(allTombstones, head?.tombstones);
          const headMarkers = head?.markers && typeof head.markers === 'object' && !Array.isArray(head.markers)
            ? head.markers
            : null;
          if (typeof head?.bundle_hash === 'string' && head.bundle_hash) {
            const snapshot = await loadSnapshot(head.bundle_hash);
            if (!snapshot) {
              invalidContentPointers += 1;
              continue;
            }
            const ts = finiteOr(Date.parse(String(file?.synced_at || '')), 0);
            for (const target of snapshot.targets) {
              const cur = allContentMarkers.get(target);
              if (!cur || ts > cur.marker) allContentMarkers.set(target, { marker: ts, hash: head.bundle_hash });
            }
            entries.push({ bundle_hash: head.bundle_hash, markers: headMarkers, ts });
          }
        } catch {
          invalidContentPointers += 1;
        }
      }

      try {
        const latestMeta = await listRemoteMemoryAssetHashes({
          remote,
          pathPrefix: latestAssetPath(),
          fetchFn: opts.fetchFn,
        });
        const latestFile = (latestMeta?.files || []).find((file) => file.path === latestAssetPath());
        if (latestFile) {
          const latest = await this.readLatest(opts);
          if (typeof latest?.bundle_hash === 'string' && latest.bundle_hash) {
            const snapshot = await loadSnapshot(latest.bundle_hash);
            if (snapshot) {
              const ts = finiteOr(Date.parse(String(latestFile.synced_at || '')), 0);
              for (const target of snapshot.targets) {
                const cur = allContentMarkers.get(target);
                if (!cur || ts > cur.marker) allContentMarkers.set(target, { marker: ts, hash: latest.bundle_hash });
              }
              entries.push({ bundle_hash: latest.bundle_hash, markers: null, ts });
            } else {
              invalidContentPointers += 1;
            }
          } else {
            invalidContentPointers += 1;
          }
        }
      } catch (error) {
        if (!isNotFoundError(error)) invalidContentPointers += 1;
      }

      if (entries.length === 0 && invalidContentPointers > 0) {
        throw new Error('memory fetch failed: store has content pointer(s) but none are valid (store may be corrupt)');
      }
      if (entries.length === 0 && allTombstones.size === 0) {
        return { mode: 'store', pages: null, deleted: new Map(), storeReal: remoteSnapshotCacheBase(opts.projectRoot) };
      }

      const byHash = new Map();
      for (const entry of entries) {
        const prev = byHash.get(entry.bundle_hash);
        if (!prev) {
          byHash.set(entry.bundle_hash, {
            bundle_hash: entry.bundle_hash,
            ts: entry.ts,
            markers: entry.markers ? { ...entry.markers } : null,
          });
          continue;
        }
        prev.ts = Math.max(prev.ts, entry.ts);
        if (entry.markers) {
          prev.markers = prev.markers || {};
          for (const [key, value] of Object.entries(entry.markers)) {
            const n = Number(value);
            if (!Number.isFinite(n)) continue;
            prev.markers[key] = Math.max(finiteOr(prev.markers[key], 0), n);
          }
        }
      }

      const perPage = new Map();
      let anyLoaded = false;
      for (const entry of [...byHash.values()].sort((a, b) => b.ts - a.ts)) {
        const snapshot = await loadSnapshot(entry.bundle_hash);
        if (!snapshot) continue;
        anyLoaded = true;
        for (const file of snapshot.manifest.files || []) {
          const rel = safeMemoryPageKey(file?.target);
          if (!rel) continue;
          const marker = finiteOr(entry.markers?.[rel], finiteOr(snapshot.versionMarkers[rel], finiteOr(entry.ts, 0)));
          const cur = perPage.get(rel);
          if (!cur || marker > cur.marker || (marker === cur.marker && entry.bundle_hash > cur.hash)) {
            perPage.set(rel, { srcFile: path.join(snapshot.payloadRoot, rel), marker, hash: entry.bundle_hash });
          }
        }
      }

      if (entries.length > 0 && !anyLoaded) {
        throw new Error('memory fetch failed: no readable snapshot among the store pointers (store may be corrupt)');
      }

      const deleted = new Map();
      for (const [page, tombstoneMs] of allTombstones) {
        const rec = allContentMarkers.get(page);
        if (rec && Math.floor(rec.marker) > Number(tombstoneMs) && await loadSnapshot(rec.hash)) continue;
        perPage.delete(page);
        deleted.set(page, tombstoneMs);
      }

      return { mode: 'store', pages: perPage, deleted, storeReal: remoteSnapshotCacheBase(opts.projectRoot) };
    },
    async localMatchesOwnHeadAsync(opts) {
      let publisherId;
      try {
        publisherId = resolveServerPublisherId(opts);
      } catch {
        return { matches: false, reason: 'head_unreadable' };
      }
      let head;
      try {
        head = await this.readHead({ ...opts, publisherId });
      } catch (error) {
        if (isNotFoundError(error)) {
          const localFiles = collectMemoryFiles(opts.projectRoot);
          return localFiles.length === 0
            ? { matches: true, reason: 'empty_both' }
            : { matches: false, reason: 'never_published' };
        }
        return { matches: false, reason: 'head_unreadable' };
      }
      const localFiles = collectMemoryFiles(opts.projectRoot);
      if (!head?.bundle_hash) {
        return localFiles.length === 0
          ? { matches: true, reason: 'match' }
          : { matches: false, reason: 'tombstone_only_head' };
      }
      let manifest;
      try {
        manifest = await this.readSnapshotManifest({
          ...opts,
          bundleHash: head.bundle_hash,
        });
      } catch {
        return { matches: false, reason: 'head_unreadable' };
      }
      const remote = new Map((manifest.files || []).map((file) => [file.target, file]));
      if (remote.size !== localFiles.length) return { matches: false, reason: 'page_set_differs' };
      let snapshot;
      try {
        const remoteConfigValue = await remoteConfig(opts);
        snapshot = await materializeRemoteSnapshot({
          projectRoot: opts.projectRoot,
          remote: remoteConfigValue,
          bundleHash: head.bundle_hash,
          manifest,
          adapter: this,
          fetchFn: opts.fetchFn,
          credentialsReader: opts.credentialsReader,
        });
      } catch {
        return { matches: false, reason: 'content_differs' };
      }
      for (const rel of localFiles) {
        const entry = remote.get(rel);
        if (!entry) return { matches: false, reason: 'page_set_differs' };
        try {
          const localBytes = fs.readFileSync(path.join(path.resolve(opts.projectRoot), rel));
          const remoteBytes = fs.readFileSync(path.join(snapshot.payloadRoot, rel));
          if (!localBytes.equals(remoteBytes)) return { matches: false, reason: 'content_differs' };
        } catch {
          return { matches: false, reason: 'content_differs' };
        }
      }
      return { matches: true, reason: 'match' };
    },
    async getPublisherHeadPageSetAsync(opts) {
      let publisherId;
      try {
        publisherId = resolveServerPublisherId(opts);
      } catch {
        return new Set();
      }
      let head;
      try {
        head = await this.readHead({ ...opts, publisherId });
      } catch (error) {
        if (isNotFoundError(error)) return new Set();
        throw error;
      }
      const known = new Set();
      if (head?.markers && typeof head.markers === 'object') {
        for (const key of Object.keys(head.markers)) known.add(key);
      }
      if (head?.tombstones && typeof head.tombstones === 'object') {
        for (const key of Object.keys(head.tombstones)) known.add(key);
      }
      return known;
    },
    async retirePublisherHeadAsync(opts) {
      const remote = await remoteConfig(opts);
      let head;
      try {
        head = await this.readHead(opts);
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new Error(`memory retire-head refused: publisher head not found: ${opts.publisherId}`);
        }
        throw new Error(`memory retire-head refused: publisher head is unreadable/corrupt (${opts.publisherId}): ${error instanceof Error ? error.message : String(error)}`);
      }

      const retiredAtIso = new Date(opts.retiredAtMs ?? Date.now()).toISOString();
      const updated = normalizeRetiredHead(head, {
        retiredAt: retiredAtIso,
        retiredByMachineId: opts.retiredByMachineId ?? null,
        retiredByAgentId: remote.brainId,
      });
      await this.writeHead({ ...opts, head: updated });
      return {
        publisherId: opts.publisherId,
        retiredAt: retiredAtIso,
        alreadyRetired: Boolean(head.retired || head.retirement?.retired_at),
      };
    },
    async writeHead(opts) {
      const remote = await remoteConfig(opts);
      return pushRemoteJsonAsset({
        remote,
        path: headAssetPath(opts.publisherId),
        value: opts.head,
        fetchFn: opts.fetchFn,
      });
    },
    async readHead(opts) {
      const remote = await remoteConfig(opts);
      return pullRemoteJsonAsset({
        remote,
        path: headAssetPath(opts.publisherId),
        fetchFn: opts.fetchFn,
      });
    },
    async listHeads(opts) {
      const remote = await remoteConfig(opts);
      return listRemoteMemoryAssetHashes({
        remote,
        pathPrefix: headPathPrefix(),
        fetchFn: opts.fetchFn,
      });
    },
    async writeLatest(opts) {
      const remote = await remoteConfig(opts);
      return pushRemoteJsonAsset({
        remote,
        path: latestAssetPath(),
        value: opts.latest,
        fetchFn: opts.fetchFn,
      });
    },
    async readLatest(opts) {
      const remote = await remoteConfig(opts);
      return pullRemoteJsonAsset({
        remote,
        path: latestAssetPath(),
        fetchFn: opts.fetchFn,
      });
    },
    async readSnapshotManifest(opts) {
      const remote = await remoteConfig(opts);
      return pullRemoteJsonAsset({
        remote,
        path: snapshotManifestAssetPath(opts.bundleHash),
        fetchFn: opts.fetchFn,
      });
    },
    async readSnapshotMarkers(opts) {
      const remote = await remoteConfig(opts);
      return pullRemoteJsonAsset({
        remote,
        path: snapshotMarkersAssetPath(opts.bundleHash),
        fetchFn: opts.fetchFn,
      });
    },
    async readSnapshotPayload(opts) {
      const remote = await remoteConfig(opts);
      return pullRemoteSingleAsset({
        remote,
        path: snapshotPayloadAssetPath(opts.bundleHash, opts.relPath),
        fetchFn: opts.fetchFn,
      });
    },
  };
}

export function getMemoryStoreAdapter(store) {
  if (!store) return createLocalOnlyAdapter();
  if (store.scheme === 'file') return createFileAdapter(store);
  if (store.scheme === 'server') return createServerAdapter(store);
  return createUnsupportedAdapter(store);
}

export const createMemoryStoreAdapter = getMemoryStoreAdapter;
