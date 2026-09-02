// Shared-store transport for canonical memory (PRD-0051, db-free).
//
// The local brain.db (lib/memory/db.js) is an event-sourced ledger scoped to one
// machine. To make memory a FLEET substrate we move pages between machines as a
// content-addressed snapshot bundle over a SHARED store — no remote database.
//
// Invariant (shared with refreshMemoryFromBrainDb): content-addressed pages +
// non-destructive materialization. Fill gaps, never clobber a drifted local edit
// unless --force. The transport source (local brain.db view vs fetched bundle) does
// not change the write-to-memory/ semantics.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { assertContainedRelativePath } from '../bundle/manifest-schema.js';
import { getAgentId } from '../project-config.js';
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

// Reject any identifier that is not a single safe path segment before it is joined into
// a store path. agent_id/version_id come from untrusted JSON (agentbootup.json, the shared
// store's latest.json); "../../outside" must never escape store.root. (roborev 11596.)
function assertSafeSegment(value, label) {
  const v = String(value);
  if (!v || v === '.' || v === '..' || v.includes('/') || v.includes('\\') || v.includes('\0')) {
    throw new Error(`${label} must be a single safe path segment (got "${value}")`);
  }
  return v;
}

// Return the numeric value if it is finite, else the fallback. Unlike `Number(x) || fallback`,
// this treats a legitimate 0 as a real value rather than "absent" (roborev/Claude review).
function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Content-addressed store key: the FULL sha256 digest. version_id only embeds the first 8
// hex of the hash (32 bits) — different payloads could collide on the same version dir and
// silently overwrite each other. Key the store dir on the full 256-bit digest (roborev 11605).
function hashDirKey(bundleHash, label = 'bundle_hash') {
  const hex = String(bundleHash).replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${label} is not a full sha256 digest: "${bundleHash}"`);
  return hex;
}

export function validateReplayPublicationFiles(replayFiles, replayMtimes) {
  if (!Array.isArray(replayFiles) || replayFiles.length === 0) {
    throw new Error('memory replay refused: validated manifest target list is missing');
  }
  if (!replayMtimes || typeof replayMtimes !== 'object' || Array.isArray(replayMtimes)) {
    throw new Error('memory replay refused: immutable payload is missing source mtime metadata');
  }
  const files = [];
  const seen = new Set();
  for (const value of replayFiles) {
    const rel = assertContainedRelativePath(value, 'replay manifest target');
    if (!rel.startsWith('memory/')) throw new Error(`memory replay refused: unsafe manifest target ${rel}`);
    if (seen.has(rel)) throw new Error(`memory replay refused: duplicate manifest target ${rel}`);
    const mtime = Number(replayMtimes[rel]);
    if (!Number.isFinite(mtime)) throw new Error(`memory replay refused: missing source mtime metadata for ${rel}`);
    seen.add(rel);
    files.push(rel);
  }
  const mtimePaths = Object.keys(replayMtimes);
  if (mtimePaths.length !== files.length || mtimePaths.some((rel) => !seen.has(rel))) {
    throw new Error('memory replay refused: source mtime metadata does not exactly match manifest targets');
  }
  return files;
}

// Mirror resolveAgentId() in installer.js so publish and fetch key the store dir
// identically. Never derive identity from os.hostname() (feedback_hostname_is_not_an_identity).
function storeAgentId(projectRoot) {
  return assertSafeSegment(
    getAgentId(projectRoot) || path.basename(path.resolve(projectRoot)) || 'unknown',
    'agent_id',
  );
}

// Create every path segment under the store root, refusing any pre-planted symlinked
// component. Write-path counterpart to assertWithinStore — a co-writer who pre-creates
// store/<agentId> (or the content-addressed, hence predictable, version dir) as a symlink
// would otherwise make copy/write/rename escape the store tree (roborev 11601). storeReal
// must already exist (publish requires it).
function mkdirWithinStore(dir, storeReal) {
  const relative = path.relative(storeReal, dir);
  if (relative === '' ) return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`store write refused: ${dir} escapes ${storeReal}`);
  }
  let cur = storeReal;
  for (const seg of relative.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    let st = null;
    try { st = fs.lstatSync(cur); } catch { st = null; }
    if (!st) {
      // Concurrent identical publishers race here: another process may create this segment
      // between our lstat and mkdir. EEXIST is fine — re-lstat and validate (roborev 11603).
      try {
        fs.mkdirSync(cur);
        continue;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        st = fs.lstatSync(cur);
      }
    }
    if (st.isSymbolicLink()) throw new Error(`store write refused: symlink component (${cur})`);
    if (!st.isDirectory()) throw new Error(`store write refused: non-directory in path (${cur})`);
  }
}

// Verify every ANCESTOR component from rootReal down to `rel`'s parent is a real (non-symlink)
// directory — used before a DELETE. assertWithinStore only rejects symlinks that escape the
// checkout via realpath; an IN-REPO symlink (e.g. memory -> .git) resolves back inside the checkout
// and would otherwise let a tombstone rmSync files through it (e.g. .git/config) (roborev).
function assertNoSymlinkedAncestor(rootReal, rel) {
  let cur = rootReal;
  const segs = String(rel).split('/').filter(Boolean);
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch { throw new Error(`refused: missing component (${cur})`); }
    if (st.isSymbolicLink()) throw new Error(`refused: symlink component (${cur})`);
    if (!st.isDirectory()) throw new Error(`refused: non-directory component (${cur})`);
  }
}

// Refuse to write local memory STATE (.brain/ baseline + pin) through a symlinked .brain — following
// it would place these files OUTSIDE the checkout (roborev). A missing .brain is fine (mkdir creates a
// real dir); an EXISTING .brain must be a real directory. checkoutReal is already realpath-resolved, so
// checking .brain directly (its only ancestor is the trusted checkout root) is sufficient.
function assertBrainDirSafe(projectRoot) {
  let checkoutReal;
  try {
    checkoutReal = fs.realpathSync(path.resolve(projectRoot));
  } catch {
    checkoutReal = path.resolve(projectRoot);
  }
  const brain = path.join(checkoutReal, '.brain');
  let st;
  try {
    st = fs.lstatSync(brain);
  } catch {
    return; // absent → mkdir will create a real dir under the trusted checkout
  }
  if (st.isSymbolicLink()) throw new Error(`memory state write refused: .brain is a symlink (${brain}) — refusing to write baseline/pin state through it`);
  if (!st.isDirectory()) throw new Error(`memory state write refused: .brain exists but is not a directory (${brain})`);
}

// Refuse to write over a pre-planted symlink at a destination FILE (copy/write would follow
// it out of the store tree).
function assertWritableTarget(filePath) {
  let st = null;
  try { st = fs.lstatSync(filePath); } catch { return; }
  if (st.isSymbolicLink()) throw new Error(`store write refused: destination is a symlink (${filePath})`);
}

// The shared store is untrusted (potentially multi-writer). A malicious writer can plant
// symlinks so a read/hash/copy exfiltrates or injects arbitrary local files. Require every
// fetched path to be a NON-symlink whose realpath stays under the store root — mirrors
// decisive's refresh containment (feedback_validate_bytes_you_apply_at_the_funnel).
//
// TRUST MODEL (the outer boundary): WRITE access to the store is the trust gate — only
// brains holding the store's credential (AgentDrive key / mount ACL) may publish, exactly
// like push access to a git remote. The read- and write-path symlink/containment/identity/
// integrity checks here are DEFENSE-IN-DEPTH against corruption, accidents, and a
// compromised-but-authorized writer — not a claim that memory stays safe if an arbitrary
// attacker gains write access. That is the ACL's job, not this module's.
function assertWithinStore(filePath, storeReal, label) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${label} not found in store: ${filePath}`);
  }
  if (st.isSymbolicLink()) throw new Error(`${label} refused: symlink in shared store (${filePath})`);
  const real = fs.realpathSync(filePath);
  if (real !== storeReal && !real.startsWith(storeReal + path.sep)) {
    throw new Error(`${label} refused: resolves outside the store (${real})`);
  }
  return real;
}

// Compute the stable per-publisher id (machine + checkout) used to key this working copy's head.
function publisherIdFor(machineId, checkoutReal) {
  return crypto
    .createHash('sha256')
    .update(`${assertSafeSegment(machineId, 'machine_id')}\0${checkoutReal}`)
    .digest('hex')
    .slice(0, 24);
}

// Write/update THIS publisher's head, computing carried/new tombstones by diffing the current
// markers against the prior head (markers present before but absent now = deleted). Used by both
// content publishes and the tombstone-only (empty memory/) path — bundleHash/versionId may be null
// for a tombstone-only head (no content snapshot).
function writePublisherHead({ storeReal, agentId, checkoutReal, machineId, bundleHash, versionId, markers, extraDeletions = [], extraDeletionTimes = {}, authoritativePriorPages = [], selection = null }) {
  const headsDir = path.join(storeReal, agentId, 'heads');
  const headFile = path.join(headsDir, `${publisherIdFor(machineId, checkoutReal)}.json`);
  let prevMarkers = {};
  let prevTombstones = {};
  let wasRetired = false;
  // An existing head carries this publisher's recorded tombstones. If it EXISTS but cannot be parsed,
  // we must NOT silently overwrite it with empty prior state — that drops every previously recorded
  // deletion for this checkout and resurrects those pages on the next merge (roborev). Fail the publish
  // instead; a MISSING head (first publish) is the only legitimate empty-prior case.
  if (fs.existsSync(headFile)) {
    assertWithinStore(headFile, storeReal, 'head');
    let prev;
    try {
      prev = JSON.parse(fs.readFileSync(headFile, 'utf8'));
    } catch (err) {
      throw new Error(`memory publish refused: existing publisher head is unreadable/corrupt (${headFile}); refusing to overwrite and lose recorded deletions — repair or remove it first: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (prev?.markers && typeof prev.markers === 'object' && !Array.isArray(prev.markers)) prevMarkers = prev.markers;
    if (prev?.tombstones && typeof prev.tombstones === 'object' && !Array.isArray(prev.tombstones)) prevTombstones = prev.tombstones;
    wasRetired = Boolean(prev?.retired || prev?.retirement?.retired_at);
  }
  const tombstones = calculateNextTombstones({
    prevMarkers,
    prevTombstones,
    markers,
    extraDeletions,
    extraDeletionTimes,
    authoritativePriorPages,
    selection,
  });
  mkdirWithinStore(headsDir, storeReal);
  assertWritableTarget(headFile);
  atomicWriteJson(headFile, {
    version_id: versionId,
    bundle_hash: bundleHash,
    machine_id: machineId,
    markers, // fresh per-publish markers ride on the head (correct even when the dir is reused)
    tombstones, // per-page deletion tombstones so the merge converges deletions
    updated_at: new Date().toISOString(),
  });
  return { tombstones, unretired: wasRetired };
}

export function retirePublisherHead({ projectRoot, store, publisherId, retiredByMachineId = null, retiredAtMs = Date.now() }) {
  if (!store) throw new Error('memory retire-head: no shared store configured');
  assertFileStore(store);
  if (!fs.existsSync(store.root) || !fs.statSync(store.root).isDirectory()) {
    throw new Error(`memory retire-head refused: store root does not exist or is not a directory: ${store.root}`);
  }

  const safePublisherId = assertSafeSegment(publisherId, 'publisher_id');
  const storeReal = fs.realpathSync(store.root);
  const agentId = storeAgentId(projectRoot);
  const headFile = path.join(storeReal, agentId, 'heads', `${safePublisherId}.json`);
  if (!fs.existsSync(headFile)) {
    throw new Error(`memory retire-head refused: publisher head not found: ${safePublisherId}`);
  }

  assertWithinStore(headFile, storeReal, 'head');
  let head;
  try {
    head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
  } catch (err) {
    throw new Error(`memory retire-head refused: publisher head is unreadable/corrupt (${safePublisherId}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!head || typeof head !== 'object' || Array.isArray(head)) {
    throw new Error(`memory retire-head refused: publisher head is invalid (${safePublisherId})`);
  }

  const retiredAtIso = new Date(retiredAtMs).toISOString();
  const updated = {
    ...head,
    retired: true,
    retirement: {
      ...(head.retirement && typeof head.retirement === 'object' && !Array.isArray(head.retirement) ? head.retirement : {}),
      retired_at: retiredAtIso,
      ...(retiredByMachineId ? { retired_by_machine_id: retiredByMachineId } : {}),
      retired_by_agent_id: agentId,
    },
  };
  assertWritableTarget(headFile);
  atomicWriteJson(headFile, updated);
  return { publisherId: safePublisherId, retiredAt: retiredAtIso, alreadyRetired: Boolean(head.retired || head.retirement?.retired_at) };
}

// Canonicalize the CHECKOUT root the SAME way publisher-head identity is keyed (realpath), so .brain
// state is found regardless of which alias the checkout is accessed through — a symlinked path during
// refresh and the real path during publish must resolve to the SAME .brain, or the code would see false
// "no baseline/pin" and mint a second identity for one checkout (roborev).
function checkoutRealRoot(projectRoot) {
  try {
    return fs.realpathSync(path.resolve(projectRoot));
  } catch {
    return path.resolve(projectRoot);
  }
}
// The sync baseline records the set of memory pages this checkout had after its last refresh/publish
// (local state under .brain/, gitignored). It lets a publish detect deletions made on a FRESH
// checkout that refreshed-then-deleted a shared page — that page is in the baseline but no longer
// local, so it's an intentional deletion (roborev), which the prior-head diff alone can't see.
function syncBaselinePath(projectRoot) {
  return path.join(checkoutRealRoot(projectRoot), '.brain', 'memory-sync-baseline.json');
}
// Canonicalize the store root so an equivalent path (symlinked/alternate mount) still matches the
// baseline it was recorded against, instead of falsely tripping the fail-closed guard (roborev).
function canonicalStoreKey(store) {
  if (!store) return null;
  if (store.scheme === 'file') {
    if (!store.root) return null;
    try {
      return `file://${fs.realpathSync(store.root)}`;
    } catch {
      return `file://${path.resolve(store.root)}`;
    }
  }
  if (store.scheme === 'agentdrive') {
    return typeof store.ref === 'string' && store.ref ? `agentdrive://${store.ref}` : 'agentdrive://';
  }
  if (store.scheme === 'server') {
    return typeof store.brainId === 'string' && store.brainId ? `server://${store.brainId}` : 'server://';
  }
  return `${String(store.scheme || 'unknown')}://`;
}
// The baseline is SCOPED to the (store, agent_id) it was recorded against. A baseline from store A must
// NOT drive deletion detection for a publish to store B, or an agent_id change — else pages never in the
// current store get tombstoned (roborev). Default the agent id to this checkout's identity.
// Returns true iff the baseline was persisted. Callers that DEPEND on the baseline (the empty-store
// bootstrap, which uses it to unblock a later publish) must check this and surface a failure rather
// than claim a sync that did not persist (roborev).
export function writeSyncBaseline({ projectRoot, pages, store, agentId, pageHashes = null }) {
  try {
    assertBrainDirSafe(projectRoot);
    const dir = path.join(checkoutRealRoot(projectRoot), '.brain');
    fs.mkdirSync(dir, { recursive: true });
    const arr = [...pages].filter((p) => typeof p === 'string' && p.startsWith('memory/')).sort();
    // PR-2a: per-page sha256 of the VALIDATED store bytes at sync time — the
    // fast-forward publish gate's compare-and-swap reference. Only hashes for
    // pages in the baseline set are kept; absent hashes simply make a page
    // ineligible for fast-forward (conservative, and rollback-safe: older
    // binaries ignore this field entirely).
    const page_hashes = {};
    if (pageHashes && typeof pageHashes === 'object') {
      for (const rel of arr) {
        const h = pageHashes[rel];
        if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) page_hashes[rel] = h;
      }
    }
    atomicWriteJson(syncBaselinePath(projectRoot), {
      pages: arr,
      page_hashes,
      store_key: canonicalStoreKey(store),
      agent_id: agentId ?? storeAgentId(projectRoot),
      updated_at: new Date().toISOString(),
    });
    return true;
  } catch {
    return false; // best effort for the general path; bootstrap callers MUST surface a false result
  }
}
// Pre-flight: verify the pinned identity CAN be persisted BEFORE mutating the shared store. The store
// head-write and the local pin-write are separate, so either order leaves a failure window (roborev):
// pin-first orphans a pre-existing head if the publish aborts; pin-after leaves a head with no pin if
// the pin write fails. Verifying .brain/ writability up front lets us mutate the store and THEN commit
// the pin knowing it will succeed — closing both windows (modulo a negligible local-fs TOCTOU).
export function assertPinPersistable({ projectRoot }) {
  const dir = path.join(checkoutRealRoot(projectRoot), '.brain');
  try {
    assertBrainDirSafe(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    // Do a REAL create-and-remove probe rather than only fs.accessSync(W_OK): creating the pin file
    // also needs directory execute/search (X_OK) on POSIX, so a mode-0200 dir would pass a W_OK check
    // yet still fail the actual write AFTER the store head/latest were written — the orphaned-head
    // window this preflight exists to close (roborev). The probe exercises the same operation the pin
    // write does, using a unique temp name so it never races a concurrent writer.
    const probe = path.join(dir, `.pin-probe-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
  } catch (err) {
    throw new Error(`memory publish refused: .brain/ is not writable (${dir}), so the publisher identity pin cannot be persisted — fix .brain/ writability before publishing: ${err instanceof Error ? err.message : String(err)}`);
  }
}
// Load + VALIDATE the baseline. Returns {valid, matches, pages}: valid = file parses with a pages array;
// matches = it was recorded against the CURRENT store_key + agent_id. A corrupt/truncated file is NOT
// valid (so the fail-closed guard cannot be bypassed by garbage; roborev), and a cross-store baseline is
// valid-but-not-matching (so it is ignored for deletion detection without being treated as "no sync").
function loadSyncBaseline({ projectRoot, store, agentId }) {
  const empty = { valid: false, matches: false, pages: new Set(), pageHashes: {} };
  try {
    const f = syncBaselinePath(projectRoot);
    if (!fs.existsSync(f)) return empty;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!d || !Array.isArray(d.pages)) return empty; // corrupt/wrong shape → not valid
    const wantStore = canonicalStoreKey(store);
    const wantAgent = agentId ?? storeAgentId(projectRoot);
    const matches = (d.store_key ?? null) === wantStore && (d.agent_id ?? null) === wantAgent;
    const pageHashes = {};
    if (d.page_hashes && typeof d.page_hashes === 'object' && !Array.isArray(d.page_hashes)) {
      for (const [k, v] of Object.entries(d.page_hashes)) {
        if (typeof k === 'string' && typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) pageHashes[k] = v;
      }
    }
    return { valid: true, matches, pages: new Set(d.pages.filter((p) => typeof p === 'string')), pageHashes };
  } catch {
    return empty; // unreadable/parse error → not valid
  }
}
export function readSyncBaseline({ projectRoot, store, agentId }) {
  const b = loadSyncBaseline({ projectRoot, store, agentId });
  return b.valid && b.matches ? b.pages : new Set(); // only a VALID, MATCHING baseline drives deletions
}

/** PR-2a: baseline content hashes (VALID + MATCHING baselines only). */
export function readSyncBaselineHashes({ projectRoot, store, agentId }) {
  const b = loadSyncBaseline({ projectRoot, store, agentId });
  return b.valid && b.matches && b.pageHashes ? b.pageHashes : {};
}

/** sha256 hex of a buffer — the baseline/fast-forward content identity. */
export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Once `--merge` is the DEFAULT refresh mode, a publish MUST write a per-publisher head or deletions
// never converge fleet-wide. If the real machine id is unavailable we cannot silently degrade to a
// headless (latest-only) publish (roborev).
//
// A checkout keeps ONE stable publisher identity for its entire life, PINNED on first publish under
// .brain/ (gitignored) and reused thereafter regardless of whether the machine id is available on
// later publishes. If the id changed across publishes (real -> fallback when machine-id drops, or
// fallback -> real when it recovers) the checkout would leave a SECOND, orphaned head in heads/; the
// merge reads every head, so the orphan's tombstones keep winning against later republishes and a
// re-created page can stay falsely deleted indefinitely (roborev). Pinning guarantees exactly one
// head per checkout in both directions. The pinned id is the real machine id when available at first
// publish, else a fallback DERIVED DETERMINISTICALLY from the checkout path — so it is stable across
// publishes even when .brain/ cannot be persisted (a random UUID would re-mint per publish and
// re-orphan; roborev). Two machines sharing an absolute checkout path collide on the fallback id,
// but that is inherent to any machine-id-less fallback and only affects the degraded path.
function publisherIdStatePath(projectRoot) {
  return path.join(checkoutRealRoot(projectRoot), '.brain', 'publisher-id.json');
}
function deterministicFallbackId(projectRoot) {
  let checkoutReal;
  try {
    checkoutReal = fs.realpathSync(path.resolve(projectRoot));
  } catch {
    checkoutReal = path.resolve(projectRoot);
  }
  return `fallback-${crypto.createHash('sha256').update(checkoutReal).digest('hex').slice(0, 32)}`;
}
// PURE RESOLVER — reads the existing pin (throwing on corruption) and returns the identity this
// checkout WOULD use, but NEVER writes a new pin. Persisting is a separate, deferred step
// (commitPublisherPin) so a publish that ABORTS after resolving (reconcile drift, conflict) does not
// leave a fallback pin behind that a later publish would adopt and orphan the real-id head (roborev).
export function resolvePublisherMachineId({ projectRoot, machineId }) {
  const f = publisherIdStatePath(projectRoot);
  // A pin that EXISTS but is unreadable/corrupt must NOT silently repin a fresh id — that breaks the
  // one-stable-identity-per-checkout invariant. Fail loudly so the operator repairs/removes it.
  if (fs.existsSync(f)) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (err) {
      throw new Error(`memory publish refused: pinned publisher id is unreadable/corrupt (${f}); refusing to mint a new identity and orphan the existing head — repair or remove it first: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof d?.id === 'string' && d.id) return d.id; // already pinned — never change identity
    throw new Error(`memory publish refused: pinned publisher id file has no usable id (${f}); repair or remove it first`);
  }
  return machineId || deterministicFallbackId(projectRoot); // computed, not yet persisted
}
// Persist the pin (idempotent). Call this ONLY when the operation is about to complete (a head write, or
// a refresh backfill) — never speculatively, so an aborted publish leaves no orphaning pin (roborev).
// The pin MUST persist for BOTH a real id and a deterministic fallback: a fallback is stable only while
// the checkout keeps choosing it, and with no pin a later real-id publish would mint a SECOND head.
export function commitPublisherPin({ projectRoot, machineId }) {
  const f = publisherIdStatePath(projectRoot);
  if (fs.existsSync(f)) return resolvePublisherMachineId({ projectRoot, machineId }); // already pinned (validates)
  const id = machineId || deterministicFallbackId(projectRoot);
  try {
    assertBrainDirSafe(projectRoot);
    fs.mkdirSync(path.join(checkoutRealRoot(projectRoot), '.brain'), { recursive: true });
    atomicWriteJson(f, { id, pinned_from_machine_id: machineId || null, created_at: new Date().toISOString() });
  } catch (err) {
    throw new Error(`memory publish refused: could not persist the publisher identity pin (${f}); refusing to publish with an unstable identity a later publish would orphan — fix .brain/ writability first: ${err instanceof Error ? err.message : String(err)}`);
  }
  return id;
}
// Whether this checkout has a usable pinned publisher identity (used by the CLI to decide if deletion
// detection can trust the prior head, or must refuse when machine identity is otherwise unavailable).
export function hasPinnedPublisherId({ projectRoot }) {
  try {
    const d = JSON.parse(fs.readFileSync(publisherIdStatePath(projectRoot), 'utf8'));
    return typeof d?.id === 'string' && !!d.id;
  } catch {
    return false;
  }
}
// Whether this checkout has a VALID, MATCHING sync baseline for the current store/agent — i.e. it has
// usable prior synced state to detect deletions against. A corrupt/truncated or cross-store baseline
// does NOT count (existence alone must not bypass the fail-closed publish guard; roborev).
export function hasSyncBaseline({ projectRoot, store, agentId }) {
  const b = loadSyncBaseline({ projectRoot, store, agentId });
  return b.valid && b.matches;
}

// Given the fleet's tombstones (page -> deleted-at ms) and the checkout's pre-reconcile local page set,
// return the pages that must be re-removed on publish so a fleet deletion converges: those ABSENT
// locally (reconcile re-added them from a stale latest.json) PLUS those PRESENT but STALE — a local copy
// older-or-equal to the tombstone that was never re-created after the deletion. A local copy STRICTLY
// NEWER than the tombstone is a genuine re-creation and is preserved (roborev). Floored-ms compare
// matches applyMergedSnapshot; mere local presence is not proof of re-creation.
export function staleFleetDeletions({ projectRoot, deleted, localBefore }) {
  const checkoutReal = fs.realpathSync(path.resolve(projectRoot));
  const strip = [];
  for (const [p, tMs] of deleted) {
    if (!localBefore.has(p)) { strip.push(p); continue; } // reconcile re-added an absent deleted page
    // Determine freshness with the SAME containment/symlink guards as removeLocalMemoryPages BEFORE any
    // stat — a symlinked memory/ would otherwise be FOLLOWED, stat-ing a file OUTSIDE the checkout (a
    // local-path escape; roborev). If the path is not safely a real in-checkout regular file, STRIP it:
    // removeLocalMemoryPages will refuse+report it and publish aborts (safe), rather than leaving a
    // fleet-deleted page on disk to be republished. lstat (not stat) so a symlinked FINAL page isn't
    // followed either.
    let mtime = -1;
    try {
      assertNoSymlinkedAncestor(checkoutReal, p); // rejects a symlinked memory/ (or any ancestor)
      const st = fs.lstatSync(path.join(checkoutReal, p));
      if (!st.isFile()) { strip.push(p); continue; } // symlink/dir at the path → not our real page
      mtime = Math.floor(st.mtimeMs);
    } catch {
      strip.push(p); // uncontained/symlinked/unreadable → strip so remove refuses and publish aborts
      continue;
    }
    if (mtime <= Number(tMs)) strip.push(p); // stale pre-delete copy → strip; strictly-newer → preserve
  }
  return strip;
}

/**
 * Safely remove local memory/ pages by relative path — validates each against the checkout root
 * (contained under memory/, non-symlink, realpath inside the checkout) before rmSync. The CLI uses
 * this to drop pages reconcile should not have (re)added; the paths come from untrusted store head
 * data, so they MUST be containment-checked (roborev). Returns the paths actually removed.
 */
export function removeLocalMemoryPages({ projectRoot, rels }) {
  const checkoutReal = fs.realpathSync(path.resolve(projectRoot));
  const removed = [];
  const failed = []; // requested pages that are STILL PRESENT after the attempt (rmSync failed, or a
  // containment/symlink refusal) — a caller that MUST converge a deletion has to treat these as fatal,
  // or publishMemoryToStore would re-include the file and writePublisherHead would suppress its tombstone
  // (present in currentSet), silently resurrecting content the user deleted (roborev).
  for (const relRaw of rels) {
    let rel;
    try {
      rel = assertContainedRelativePath(relRaw, 'local memory page');
    } catch {
      continue; // traversal / absolute / NUL → never our page, nothing on disk to converge
    }
    if (!rel.startsWith('memory/')) continue;
    const dst = path.join(checkoutReal, rel);
    let st = null;
    try { st = fs.lstatSync(dst); } catch { continue; } // absent → already converged (not a failure)
    if (!st.isFile()) continue; // a symlink/dir collision at the path → not our page, leave it
    try {
      assertWithinStore(dst, checkoutReal, `local ${rel}`); // rejects escapes-outside via realpath
      assertNoSymlinkedAncestor(checkoutReal, rel); // rejects IN-REPO symlinked ancestors too
    } catch {
      failed.push(rel); // present but cannot be SAFELY removed (uncontained/symlinked) → still on disk
      continue;
    }
    try {
      fs.rmSync(dst);
      removed.push(rel);
    } catch {
      failed.push(rel); // rmSync failed → still on disk
    }
  }
  return { removed, failed };
}

/**
 * Return the set of memory page paths this publisher has "known" — its prior head's present pages
 * (markers) UNION its still-active deletions (tombstones). The CLI uses this to detect pages that
 * must stay deleted through a publish-reconcile: a page absent locally but in EITHER set is a
 * deletion (fresh, from markers) or a carried-forward one (from tombstones). Including tombstones
 * is required so REPEATED publishes don't lose a still-deleted page when reconcile re-adds it from
 * another checkout's stale snapshot (roborev).
 */
export function getPublisherHeadPageSet({ projectRoot, store, machineId }) {
  if (!store || !machineId) return new Set();
  let headFile;
  let storeReal;
  try {
    assertFileStore(store);
    if (!fs.existsSync(store.root) || !fs.statSync(store.root).isDirectory()) return new Set();
    storeReal = fs.realpathSync(store.root);
    const agentId = storeAgentId(projectRoot);
    const checkoutReal = fs.realpathSync(path.resolve(projectRoot));
    headFile = path.join(storeReal, agentId, 'heads', `${publisherIdFor(machineId, checkoutReal)}.json`);
  } catch {
    return new Set(); // store-level issue (missing/unmounted) — not OUR head; treat as no prior head
  }
  if (!fs.existsSync(headFile)) return new Set(); // no prior head (fresh checkout) is legitimate
  // The head EXISTS, so it MUST be readable. A corrupt head here would ALSO make writePublisherHead
  // throw later — but only AFTER reconcile has mutated memory/ and deletions were mis-detected. Fail
  // NOW (before any mutation) with the same strict read, so the two head-read paths agree (roborev).
  assertWithinStore(headFile, storeReal, 'head');
  let h;
  try {
    h = JSON.parse(fs.readFileSync(headFile, 'utf8'));
  } catch (err) {
    throw new Error(`memory publish refused: existing publisher head is unreadable/corrupt (${headFile}); repair or remove it first: ${err instanceof Error ? err.message : String(err)}`);
  }
  const known = new Set();
  if (h?.markers && typeof h.markers === 'object') for (const k of Object.keys(h.markers)) known.add(k);
  if (h?.tombstones && typeof h.tombstones === 'object') for (const k of Object.keys(h.tombstones)) known.add(k);
  return known;
}

/**
 * Resolve the shared store target LAZILY (never at import — feedback_lazy_env_resolution).
 * @param {string} [storeArg] explicit --store value; falls back to AGENTBOOTUP_MEMORY_STORE.
 * @returns {{scheme:'file',root:string}|{scheme:'agentdrive',ref:string}|null} null = no store (local-only).
 */
export function resolveMemoryStore(storeArg) {
  const raw = (storeArg || process.env.AGENTBOOTUP_MEMORY_STORE || '').trim();
  if (!raw) return null;
  if (raw.startsWith('file://')) return { scheme: 'file', root: path.resolve(raw.slice('file://'.length)) };
  if (raw.startsWith('agentdrive://')) return { scheme: 'agentdrive', ref: raw.slice('agentdrive://'.length) };
  if (raw.startsWith('server://')) {
    const brainId = raw.slice('server://'.length).replace(/^\/+/, '').trim();
    return { scheme: 'server', brainId: brainId || null };
  }
  // Bare path is treated as a shared directory (mounted dir / network share).
  return { scheme: 'file', root: path.resolve(raw) };
}

// A file-store path that is absent or inaccessible is configuration, not an outage.
// Only errors observed after an existing directory was validated can be retried safely.
export function isDeferrableMemoryStoreError(error) {
  const transientCodes = new Set([
    'EIO',
    'ESTALE',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);
  const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  const codes = [
    error?.code,
    error?.cause?.code,
    error?.errno,
    error?.cause?.errno,
  ].map((value) => String(value || ''));
  if (codes.some((code) => transientCodes.has(code))) return true;
  const statuses = [
    Number(error?.status),
    Number(error?.statusCode),
    Number(error?.response?.status),
    Number(error?.cause?.status),
    Number(error?.cause?.statusCode),
    Number(error?.cause?.response?.status),
  ].filter(Number.isFinite);
  if (statuses.some((status) => transientStatuses.has(status))) return true;
  const names = [error?.name, error?.cause?.name].map((value) => String(value || ''));
  if (names.includes('AbortError') || names.includes('TimeoutError')) return true;
  const messages = [error?.message, error?.cause?.message]
    .map((value) => String(value || '').toLowerCase())
    .filter(Boolean);
  return messages.some((message) => (
    message.includes('fetch failed')
    || message.includes('network error')
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('socket')
    || message.includes('temporarily unavailable')
  ));
}

function assertFileStore(store) {
  if (store.scheme === 'file') return;
  // AgentDrive adapter is a follow-up within PRD-0051; fail loud rather than silently no-op.
  throw new Error(`memory store scheme not yet supported: ${store.scheme} (only file:// in PR-1)`);
}

// Atomic pointer write: unique temp name + rename. A shared/fixed .tmp is a publish
// race that silently ships a stale writer's bytes (feedback_fixed_temp_filename_is_a_publish_race).
let tmpCounter = 0;
function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const unique = `${process.pid}-${tmpCounter++}-${crypto.randomBytes(6).toString('hex')}`;
  const tmp = `${filePath}.${unique}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Publish memory/ to the shared store as a content-addressed snapshot bundle and
 * advance the latest pointer. Content-addressed version dirs (version_id embeds the
 * bundle hash) mean concurrent publishers of identical content never clobber.
 */
export function publishMemoryToStore({ projectRoot, store, snapshotId, machineId = null, deletedPages = [], deletedPageTimes = {}, authoritativePriorPages = [], sourceRoot = projectRoot, replayPayload = false, replayFiles = null, replayMtimes = null }) {
  if (!store) return { mode: 'local-only', published: false };
  assertFileStore(store);

  // Require the store root to already exist. Auto-creating it means a missing/mistyped
  // mount silently becomes a brand-new local dir and we advance latest.json into it — a
  // false-success split-brain (roborev 11600). Only subdirs under a verified root are ours
  // to create.
  if (!fs.existsSync(store.root) || !fs.statSync(store.root).isDirectory()) {
    throw new Error(`memory publish refused: store root does not exist or is not a directory: ${store.root} (mount missing or mistyped?)`);
  }

  // An EMPTY memory/ is a valid end state (all pages deleted). It must be publishable so the
  // deletion converges — but the bundle manifest schema requires >=1 file, so there is NO content
  // snapshot: we write a TOMBSTONE-ONLY head (bundle_hash null) carrying the deletions, and do NOT
  // advance latest.json. The merge collects tombstones from every head regardless of content
  // (roborev). (Was previously a hard failure, which blocked all-pages-delete convergence.)
  // A shared-store publish MUST record a per-publisher head or deletions never converge (merge is the
  // default), and it must use the SAME stable identity every time or it orphans a prior head. Resolve
  // via the PIN so a DIRECT caller of this exported helper — not just the CLI wrapper — is consistent:
  // an EXISTING pin wins (never change identity), else the real machine id, else the deterministic
  // fallback. It is PERSISTED only AFTER the store write succeeds (see commitPublisherPin calls below),
  // so a publish that fails partway never leaves a fallback pin that a later real-id publish would
  // orphan (roborev).
  const selection = resolveBrainBackupSelection(projectRoot);
  assertBrainBackupPolicyReady(selection, 'memory store publish');
  const publisherId = resolvePublisherMachineId({ projectRoot, machineId });
  // Preflight .brain/ writability BEFORE mutating the store, but only when a pin must be CREATED (an
  // existing pin makes commitPublisherPin a no-op). Otherwise a DIRECT caller of this helper would write
  // the head + latest.json and THEN throw on an un-persistable pin — a remote success reported as a
  // local failure (roborev). The CLI also preflights earlier (before its local reconcile); this covers
  // callers that bypass the CLI.
  if (!hasPinnedPublisherId({ projectRoot })) {
    assertPinPersistable({ projectRoot });
  }

  // Do NOT resurrect a fleet-deleted page: a local copy that the fleet has tombstoned AND that is STALE
  // (older-or-equal to the tombstone — not a genuine re-creation) must be EXCLUDED from the snapshot and
  // itself tombstoned, or its fresh head mtime would suppress the deletion and republish it fleet-wide.
  // This makes ANY DIRECT caller of this helper safe (the CLI already strips these locally first; a
  // caller that bypasses the CLI would otherwise republish a stale deleted file while touching unrelated
  // pages — roborev). A local copy STRICTLY NEWER than the tombstone is a real re-creation and is kept.
  const allFiles = replayPayload
    ? validateReplayPublicationFiles(replayFiles, replayMtimes)
    : collectMemoryFiles(sourceRoot, 'memory store publish');
  if (replayPayload) {
    assertHistoricalMemoryPathsSelected(selection, allFiles, 'memory store replay');
  }
  // Best-effort: if the merge can't be read (a corrupt/incomplete store), skip the stale-deletion filter
  // rather than block the publish — this is a safety net for DIRECT callers, and the CLI already strips
  // stale pages locally before calling. `deletedPages` (the caller's own detected deletions) still apply.
  let staleSet = new Set();
  if (replayPayload) {
    const fleetDeleted = fetchMergedFromStore({ projectRoot, store }).deleted || new Map();
    const staleQueuedPages = allFiles.filter((page) => {
      const tombstone = fleetDeleted.get(page);
      return tombstone !== undefined && Math.floor(Number(replayMtimes[page])) <= Number(tombstone);
    });
    if (staleQueuedPages.length > 0) {
      const error = new Error(`memory replay conflict: frozen payload would resurrect fleet-deleted page(s): ${staleQueuedPages.join(', ')}`);
      error.code = 'MEMORY_REPLAY_CONFLICT';
      error.conflict = createMemoryConflict(staleQueuedPages.map((path) => ({ path, reason_code: 'tombstone_resurrection' })));
      throw error;
    }
  } else {
    try {
      const fleetDeleted = fetchMergedFromStore({ projectRoot, store }).deleted || new Map();
      staleSet = new Set(staleFleetDeletions({ projectRoot, deleted: fleetDeleted, localBefore: new Set(allFiles) }));
    } catch { /* store not coherently readable — skip the stale filter, keep the caller's deletedPages */ }
  }
  const files = allFiles.filter((rel) => !staleSet.has(rel));
  const deletions = [...new Set([...deletedPages, ...staleSet])]; // tombstone the caller's + stale-fleet deletions
  if (files.length === 0) {
    // An EMPTY memory/ is an all-deleted end state: write a TOMBSTONE-ONLY head (bundle_hash null)
    // carrying the deletions so the delete converges (there is no content snapshot to advance).
    const headResult = writePublisherHead({
      storeReal: fs.realpathSync(store.root),
      agentId: storeAgentId(projectRoot),
      checkoutReal: fs.realpathSync(path.resolve(projectRoot)),
      machineId: publisherId,
      bundleHash: null,
      versionId: null,
      markers: {},
      // Fresh checkout that refreshed then deleted EVERYTHING has no prior head — record the caller's
      // detected deletions as tombstones so the all-pages delete converges (roborev).
      extraDeletions: deletions,
      extraDeletionTimes: deletedPageTimes,
      authoritativePriorPages,
      selection,
    });
    commitPublisherPin({ projectRoot, machineId: publisherId }); // persist identity AFTER the head write
    return { mode: 'store', published: true, version_id: null, store_path: null, pages: 0, unretired: headResult.unretired };
  }

  const manifest = createMemorySnapshotManifest({
    targetRoot: sourceRoot,
    snapshotId,
    files,
    sourceRepo: 'local-memory',
    agentId: storeAgentId(projectRoot),
  });
  const storeReal = fs.realpathSync(store.root);
  const checkoutReal = fs.realpathSync(path.resolve(projectRoot));
  const agentId = assertSafeSegment(manifest.bundle_name, 'agent_id');
  if (replayPayload) {
    const latest = fetchLatestFromStore({ projectRoot, store });
    const ownHeadPath = path.join(storeReal, agentId, 'heads', `${publisherIdFor(publisherId, checkoutReal)}.json`);
    let latestBelongsToThisPublisher = false;
    try {
      if (latest.manifest && fs.existsSync(ownHeadPath)) {
        assertWithinStore(ownHeadPath, storeReal, 'replay publisher head');
        const ownHead = JSON.parse(fs.readFileSync(ownHeadPath, 'utf8'));
        latestBelongsToThisPublisher = ownHead?.bundle_hash === latest.manifest.bundle_hash;
      }
    } catch {
      // A malformed local publisher head is handled by the normal write path below.
    }
    // A frozen item may advance this checkout's own prior head (FIFO retry), but a
    // differing latest snapshot from another publisher is explicit same-page drift.
    if (latest.manifest && !latestBelongsToThisPublisher) {
      const remoteByTarget = new Map(latest.manifest.files.map((file) => [file.target, file]));
      for (const file of manifest.files) {
        const remote = remoteByTarget.get(file.target);
        if (!remote) continue;
        const localBytes = fs.readFileSync(path.join(sourceRoot, file.source));
        const remoteBytes = fs.readFileSync(path.join(latest.payloadRoot, remote.source));
        if (!localBytes.equals(remoteBytes)) {
          const error = new Error(`memory replay conflict: frozen payload differs from shared page ${file.target}`);
          error.code = 'MEMORY_REPLAY_CONFLICT';
          error.conflict = createMemoryConflict([{ path: file.target, reason_code: 'shared_page_bytes_differ' }]);
          throw error;
        }
      }
    }
  }
  // Key the version dir on the FULL digest, not the truncated version_id (collision-safe).
  const versionDir = path.join(storeReal, agentId, hashDirKey(manifest.bundle_hash));
  const payloadRoot = path.join(versionDir, 'payload');
  const manifestPath = path.join(versionDir, 'manifest.json');

  // The version dir is IMMUTABLE per content hash. If a COMPLETE, integrity-valid publish of
  // identical payload already exists, do NOT rewrite it — re-publishing with a different
  // --snapshot-id must not mutate the shared manifest in place (that races latest.json and
  // desyncs pointer vs manifest — roborev 11606). Reuse the stored manifest's identity.
  let effective = manifest;
  const complete =
    fs.existsSync(manifestPath) &&
    (() => {
      try {
        assertWithinStore(manifestPath, storeReal, 'manifest.json');
        const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (existing.bundle_hash !== manifest.bundle_hash || !Array.isArray(existing.files)) return null;
        // Pre-scan the store-read side of the idempotency check too (the "fifth read path" —
        // Claude review #1): computeBundleHash → resolveSourcePath has no containment guard and
        // follows symlinks. Validate every payload entry is contained + non-symlink before
        // hashing; any failure means "not complete" → fall through to a fresh, trusted publish.
        for (const f of existing.files) {
          const rel = assertContainedRelativePath(f.source, 'manifest source');
          assertWithinStore(path.join(payloadRoot, rel), storeReal, `payload ${rel}`);
        }
        return computeBundleHash(existing, payloadRoot) === manifest.bundle_hash ? existing : null;
      } catch {
        return null;
      }
    })();

  // Per-page markers (page_path -> local mtime ms) computed from the LOCAL files EVERY publish —
  // including when the content-addressed dir is reused (complete). Markers ride on the per-publish
  // HEAD, not the immutable snapshot dir, so re-editing a page back to identical bytes still updates
  // its recency and can win the merge (roborev). markers.json in the dir is kept only as a
  // backward-compat fallback for snapshots published before head-markers existed.
  const sourceReal = fs.realpathSync(path.resolve(sourceRoot));
  const markers = {};
  for (const rel of files) {
    const relN = assertContainedRelativePath(rel, 'memory file');
    try {
      markers[relN] = replayPayload ? Number(replayMtimes?.[relN]) : fs.statSync(path.join(sourceReal, relN)).mtimeMs;
    } catch {
      /* file vanished between collect and stat — omit its marker (falls back to head ts) */
    }
  }

  if (complete) {
    effective = complete;
  } else {
    // Fresh publish (or recovery of a partial/interrupted one). Create the tree refusing any
    // symlinked component (write-path escape) — mkdirWithinStore tolerates existing real dirs.
    mkdirWithinStore(payloadRoot, storeReal);
    // Guard the LOCAL read side too: a symlinked memory/ page would otherwise be copied
    // through to the store from an arbitrary local path (symmetric to the fetch dest guard).
    for (const rel of files) {
      const relN = assertContainedRelativePath(rel, 'memory file');
      assertWithinStore(path.join(sourceReal, relN), sourceReal, `local ${relN}`);
      const src = path.join(sourceReal, relN);
      const dst = path.join(payloadRoot, relN);
      mkdirWithinStore(path.dirname(dst), storeReal);
      assertWritableTarget(dst);
      fs.copyFileSync(src, dst);
    }
    // Integrity self-check BEFORE publishing the manifest, so a partial dir never looks complete.
    const verify = computeBundleHash(manifest, payloadRoot);
    if (verify !== manifest.bundle_hash) {
      throw new Error(`memory publish failed: stored payload hash ${verify} != manifest ${manifest.bundle_hash}`);
    }
    // Atomic write (temp + rename), same rationale as latest.json — a concurrent fetcher or
    // identical-content publisher must never see a partially-written manifest (Claude review #2).
    assertWritableTarget(manifestPath);
    atomicWriteJson(manifestPath, manifest);
    // Per-page markers sidecar (not in bundle_hash) — the newest-wins signal for the merge.
    const markersPath = path.join(versionDir, 'markers.json');
    assertWritableTarget(markersPath);
    atomicWriteJson(markersPath, markers);
  }

  // agentId dir exists as a verified real dir (created above or by the prior publish).
  const latestFile = path.join(storeReal, agentId, 'latest.json');
  // Preserve the OUTGOING latest pointer as a head before overwriting it. A publisher that only
  // wrote latest.json (a pre-merge client during a mixed rollout) would otherwise be orphaned
  // when a newer client advances latest — its pages would vanish from the merge (roborev).
  // Keyed by content hash so it dedups and is bounded; the merge already dedups by bundle_hash.
  if (fs.existsSync(latestFile)) {
    try {
      assertWithinStore(latestFile, storeReal, 'latest.json');
      const prev = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      const headsDir = path.join(storeReal, agentId, 'heads');
      // Only preserve if the outgoing latest is NOT already covered by some publisher head — i.e.
      // it was written by a legacy client that never wrote a head. That avoids re-creating a head
      // for this publisher's OWN prior snapshot (which would accumulate on every re-publish).
      let coveredByHead = false;
      if (fs.existsSync(headsDir) && fs.statSync(headsDir).isDirectory()) {
        for (const name of fs.readdirSync(headsDir)) {
          if (!name.endsWith('.json')) continue;
          try {
            const hf = path.join(headsDir, name);
            assertWithinStore(hf, storeReal, `heads/${name}`); // contain untrusted head reads
            const h = JSON.parse(fs.readFileSync(hf, 'utf8'));
            if (h?.bundle_hash === prev?.bundle_hash) { coveredByHead = true; break; }
          } catch { /* skip malformed/uncontained */ }
        }
      }
      if (typeof prev?.bundle_hash === 'string' && prev.bundle_hash !== effective.bundle_hash && !coveredByHead) {
        // Capture the ORIGINAL latest.json's file mtime BEFORE writing the preserved head — the
        // merge ranks/falls back on head-file mtime, so a preserved legacy head must inherit the
        // original recency, not the fresh preservation time (roborev).
        const origMtime = fs.statSync(latestFile).mtime;
        mkdirWithinStore(headsDir, storeReal);
        const preserveFile = path.join(headsDir, `_latest_${hashDirKey(prev.bundle_hash).slice(0, 24)}.json`);
        if (!fs.existsSync(preserveFile)) {
          assertWritableTarget(preserveFile);
          atomicWriteJson(preserveFile, {
            bundle_hash: prev.bundle_hash,
            updated_at: prev.updated_at || new Date().toISOString(),
          });
          // Stamp the preserved head with the ORIGINAL recency so it never looks artificially new.
          try { fs.utimesSync(preserveFile, origMtime, origMtime); } catch { /* mtime is best-effort */ }
        }
      }
    } catch {
      /* best-effort preservation — never fail a publish because the prior pointer was odd */
    }
  }
  // Per-PUBLISHER head pointer — written BEFORE advancing latest.json so a crash can never leave
  // this snapshot reachable ONLY via latest.json (which the next publisher would overwrite,
  // orphaning it — roborev). Keyed by (machine, checkout) so two worktrees on the SAME machine
  // each keep their own head; a re-publish from the same checkout UPDATES its head in place.
  // ALWAYS write the head (publisherId is resolved above — real machine id or deterministic fallback)
  // so deletions converge for every publish, including direct (non-CLI) callers (roborev).
  // (checkoutReal was already resolved above for the markers loop.)
  const headResult = writePublisherHead({
    storeReal,
    agentId,
    checkoutReal,
    machineId: publisherId,
    bundleHash: effective.bundle_hash,
    versionId: effective.version_id,
    markers,
    extraDeletions: deletions,
    extraDeletionTimes: deletedPageTimes,
    authoritativePriorPages,
    selection,
  });

  assertWritableTarget(latestFile);
  atomicWriteJson(latestFile, {
    version_id: effective.version_id,
    bundle_hash: effective.bundle_hash,
    pages: effective.files.length,
    updated_at: new Date().toISOString(),
  });

  // Persist the pinned identity only NOW — after the head + latest.json writes succeeded — so a failure
  // partway through publishing never leaves a fallback pin that a later real-id publish would orphan
  // (roborev). The CLI pre-flights .brain/ writability, so this does not fail on the CLI path.
  commitPublisherPin({ projectRoot, machineId: publisherId });
  return { mode: 'store', published: true, version_id: effective.version_id, store_path: versionDir, pages: effective.files.length, unretired: headResult.unretired };
}

// Read + validate a snapshot's manifest SHAPE/IDENTITY/per-file gates (everything EXCEPT the payload
// re-hash). Shared by the full integrity load and the cheap uncapped content-marker pass so the two
// can never drift on which manifests are acceptable (a marker that suppresses a tombstone must pass
// the SAME identity/shape checks as content that gets materialized; roborev). Returns {manifest,
// versionDir, payloadRoot}; throws on any failed gate.
function loadManifestValidated({ storeReal, agentId, bundleHash, pointerLabel = 'pointer' }) {
  const versionDir = path.join(storeReal, agentId, hashDirKey(bundleHash, `${pointerLabel}.bundle_hash`));
  const payloadRoot = path.join(versionDir, 'payload');
  const manifestPath = path.join(versionDir, 'manifest.json');
  assertWithinStore(manifestPath, storeReal, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
    throw new Error('memory fetch refused: malformed manifest (expected an object with a files array)');
  }
  if (manifest.bundle_type !== 'memory_snapshot') {
    throw new Error(`memory fetch refused: not a memory_snapshot (bundle_type="${manifest.bundle_type}")`);
  }
  // Identity gate: bind the manifest's self-claimed identity to the trusted anchors used to
  // LOCATE it (agentId from the dir path, bundle_hash from the pointer). (roborev 11606.)
  if (
    manifest.bundle_name !== agentId ||
    manifest?.source?.agent_id !== agentId ||
    manifest.bundle_hash !== bundleHash
  ) {
    throw new Error(
      `memory fetch refused: snapshot identity (name="${manifest.bundle_name}", ` +
        `agent="${manifest?.source?.agent_id}", hash="${manifest.bundle_hash}") ` +
        `does not match the store pointer (agent="${agentId}", hash="${bundleHash}")`,
    );
  }
  // Pre-validate every payload file (non-symlink, contained, source===target).
  for (const file of manifest.files) {
    if (file.source !== file.target) {
      throw new Error(`memory fetch refused: snapshot requires source===target (source="${file.source}" target="${file.target}")`);
    }
    const rel = assertContainedRelativePath(file.source, 'manifest source');
    assertWithinStore(path.join(payloadRoot, rel), storeReal, `payload ${rel}`);
  }
  return { manifest, versionDir, payloadRoot };
}

// Validate + load ONE snapshot identified by its full bundle hash under agentId. Runs every
// untrusted-store gate (containment, symlink, shape, type, identity binding, integrity) so it
// can be reused by fetchLatest AND the per-page merge without weakening any check.
function loadSnapshotByPointer({ storeReal, agentId, bundleHash, pointerLabel = 'pointer' }) {
  const { manifest, versionDir, payloadRoot } = loadManifestValidated({ storeReal, agentId, bundleHash, pointerLabel });
  const verify = computeBundleHash(manifest, payloadRoot);
  if (verify !== manifest.bundle_hash) {
    throw new Error(`memory fetch failed: bundle integrity ${verify} != manifest ${manifest.bundle_hash}`);
  }
  return { manifest, payloadRoot, versionDir };
}

// Read a snapshot's per-page markers sidecar (page_path -> last-modified ms). Untrusted, so
// contained + symlink-checked; a missing/invalid file just means "no markers" (marker 0).
function readMarkers(versionDir, storeReal) {
  const f = path.join(versionDir, 'markers.json');
  try {
    assertWithinStore(f, storeReal, 'markers.json');
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the latest published snapshot for this project's agent from the shared store.
 * Validates the fetched bytes at the funnel BEFORE any caller applies them
 * (feedback_validate_bytes_you_apply_at_the_funnel).
 * @returns {{mode:'local-only',manifest:null}|{mode:'store',manifest:object|null,payloadRoot?:string}}
 */
export function fetchLatestFromStore({ projectRoot, store }) {
  if (!store) return { mode: 'local-only', manifest: null };
  assertFileStore(store);

  // A configured-but-missing store root is an OUTAGE, not "nothing published yet".
  if (!fs.existsSync(store.root) || !fs.statSync(store.root).isDirectory()) {
    return { mode: 'unreachable', manifest: null, store_root: store.root };
  }

  const agentId = storeAgentId(projectRoot);
  const latestFile = path.join(store.root, agentId, 'latest.json');
  if (!fs.existsSync(latestFile)) return { mode: 'store', manifest: null };

  const storeReal = fs.realpathSync(store.root);
  assertWithinStore(latestFile, storeReal, 'latest.json');
  const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  const { manifest, payloadRoot } = loadSnapshotByPointer({
    storeReal,
    agentId,
    bundleHash: latest.bundle_hash,
    pointerLabel: 'latest',
  });
  return { mode: 'store', manifest, payloadRoot, storeReal };
}

/**
 * Per-page merge across ALL per-machine heads (db-free reconciliation, PRD-0051 option b).
 * Every machine's publish persists its own content-addressed snapshot + a heads/<machineId>.json
 * pointer; this unions across them keeping the NEWEST-marker version of each page. Distinct
 * pages from different machines all appear (so they converge in ONE refresh round); a shared
 * page resolves to whichever machine last modified it (by mtime marker). Falls back to the
 * single latest.json snapshot when no per-machine heads exist (backward compatible).
 *
 * Deletions converge via per-page TOMBSTONES: publish records a page's deletion (prior head had
 * it, current publish doesn't) with a deleted-at marker; a page whose newest signal across heads
 * is a tombstone is dropped from the union and returned in `deleted` so apply removes it. This
 * makes the merge deletion-correct — safe as the default `refresh --from-store`.
 *
 * KNOWN LIMITATIONS (accepted tradeoffs of a db-free newest-wins design):
 *  - Clock skew: both content markers (file mtime) and tombstone markers (publish-time Date.now)
 *    come from the publisher's clock. A fast-clock machine's write/deletion can beat a slower
 *    machine's genuinely-later one; a future-skewed tombstone can transiently suppress a real
 *    re-creation until wall-clock passes it. Bounded — applyMergedSnapshot preserves local drift
 *    and a local re-creation newer than the tombstone, so a wrong winner only lands on a FRESH
 *    checkout or under --force.
 *  - Deletion propagation requires the deleter to publish (the tombstone rides on its head) — same
 *    as content; a delete that is never published never converges.
 *  - Tombstones are not GC'd: a publisher that deletes many pages over time accumulates tombstones
 *    on its head (small: path + ts). Bounded by pages-ever-deleted; a TTL GC is a follow-up.
 * @returns {{mode:string, pages: Map<string,object>|null, deleted?: Map<string,number>}}
 */
/**
 * Does local memory/ content EXACTLY match this checkout's own published head?
 * (PRD-0054 FR 7c — the daemon publish leg's change detection.)
 *
 * Compares CONTENT (page set + bytes) against the own-head snapshot payload,
 * never mtimes: applying merged remote pages rewrites local mtimes, and an
 * mtime-based check would make every idle machine republish after each
 * converge (head ping-pong). Read-only: never mints or persists a pin.
 *
 * @returns {{ matches: boolean, reason: string }}
 *   reasons: 'match' | 'never_published' | 'empty_both' | 'page_set_differs'
 *          | 'content_differs' | 'tombstone_only_head' | 'head_unreadable'
 */
export function localMemoryMatchesOwnHead({ projectRoot, store }) {
  if (!store) return { matches: true, reason: 'match' };
  assertFileStore(store);
  if (!fs.existsSync(store.root) || !fs.statSync(store.root).isDirectory()) {
    return { matches: false, reason: 'head_unreadable' };
  }
  const storeReal = fs.realpathSync(store.root);
  const agentId = storeAgentId(projectRoot);
  const checkoutReal = fs.realpathSync(path.resolve(projectRoot));
  const publisherId = resolvePublisherMachineId({ projectRoot, machineId: null });
  const headFile = path.join(storeReal, agentId, 'heads', `${publisherIdFor(publisherId, checkoutReal)}.json`);

  let head = null;
  try {
    if (fs.existsSync(headFile)) head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
  } catch {
    return { matches: false, reason: 'head_unreadable' };
  }
  const localFiles = collectMemoryFiles(projectRoot);
  if (!head) {
    // Never published: an empty local tree has nothing to publish either.
    return localFiles.length === 0
      ? { matches: true, reason: 'empty_both' }
      : { matches: false, reason: 'never_published' };
  }
  if (!head.bundle_hash) {
    // Tombstone-only head = all-deleted end state.
    return localFiles.length === 0
      ? { matches: true, reason: 'match' }
      : { matches: false, reason: 'tombstone_only_head' };
  }
  let snap;
  try {
    snap = loadSnapshotByPointer({ storeReal, agentId, bundleHash: head.bundle_hash, pointerLabel: 'own head' });
  } catch {
    return { matches: false, reason: 'head_unreadable' };
  }
  const remote = new Map(snap.manifest.files.map((f) => [f.target, f]));
  if (remote.size !== localFiles.length) return { matches: false, reason: 'page_set_differs' };
  for (const rel of localFiles) {
    const entry = remote.get(rel);
    if (!entry) return { matches: false, reason: 'page_set_differs' };
    try {
      const localBytes = fs.readFileSync(path.join(checkoutReal, rel));
      const remoteBytes = fs.readFileSync(path.join(snap.payloadRoot, rel));
      if (!localBytes.equals(remoteBytes)) return { matches: false, reason: 'content_differs' };
    } catch {
      return { matches: false, reason: 'content_differs' };
    }
  }
  return { matches: true, reason: 'match' };
}

export function fetchMergedFromStore({ projectRoot, store, maxHeads }) {
  if (!store) return { mode: 'local-only', pages: null };
  assertFileStore(store);
  if (!fs.existsSync(store.root) || !fs.statSync(store.root).isDirectory()) {
    return { mode: 'unreachable', pages: null, store_root: store.root };
  }

  const agentId = storeAgentId(projectRoot);
  const storeReal = fs.realpathSync(store.root);

  // Cap the CONTENT heads merged per round (env-overridable) to bound refresh cost against
  // pathological head accumulation (ephemeral worktrees). Truncation is LOGGED loudly — never
  // silent — and keeps the MOST RECENT heads. Tombstones are collected from EVERY head (uncapped,
  // cheap) so deletions always converge even from a truncated or tombstone-only (empty-publish)
  // head. Deletion convergence via tombstones makes this merge safe as the default refresh.
  const MAX_MERGE_HEADS = Math.max(1, Number(maxHeads) || Number(process.env.AGENTBOOTUP_MEMORY_MAX_HEADS) || 1024);

  // entries = CONTENT heads (bundle_hash-bearing). allTombstones = newest deletion per page across
  // ALL heads (content + tombstone-only). Markers ride on the head (fresh per publish).
  const entries = [];
  const allTombstones = new Map();
  // Count content POINTERS (heads/latest.json) that are present but could NOT be validated. If NOTHING
  // valid loads AND there are no tombstones, a store with such pointers is CORRUPT — surface it rather
  // than falsely reporting "nothing published yet" (a legacy latest.json-only store; roborev).
  let invalidContentPointers = 0;
  // Newest CONTENT marker per page across ALL heads (uncapped, cheap JSON reads). A tombstone must
  // be compared against this — not just the loaded/capped content — so a tombstone from a stale head
  // can't falsely delete a page whose newer content lives only in a truncated-away head (roborev).
  const allContentMarkers = new Map();
  // Validate every page KEY read from an untrusted head. A malformed/malicious tombstone key like
  // "../../x" must be dropped HERE, not survive the merge and then throw in applyMergedSnapshot's
  // assertContainedRelativePath — one bad head entry would otherwise abort the whole refresh (roborev).
  const safePageKey = (k) => {
    if (typeof k !== 'string') return null;
    try {
      const rel = assertContainedRelativePath(k, 'head page key');
      return rel.startsWith('memory/') ? rel : null;
    } catch {
      return null;
    }
  };
  const mergeInto = (map, obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      const rel = safePageKey(k);
      if (rel === null) continue; // skip uncontained/traversal/non-memory keys from untrusted heads
      const n = Number(v);
      // SKIP a non-finite value rather than coercing it to 0 — a garbage tombstone timestamp like
      // "oops" must NOT become a valid deletion at epoch 0 (roborev). A legitimate 0 is finite → kept.
      if (!Number.isFinite(n)) continue;
      map.set(rel, Math.max(finiteOr(map.get(rel), 0), n));
    }
  };
  // Load+integrity-validate a snapshot ONCE per bundle_hash (shared by the uncapped content-marker
  // pass below and the capped apply-load further down). Returns null if the snapshot is missing or
  // fails integrity. versionMarkers is FILTERED to the payload's actual file targets so a lying
  // markers.json cannot advertise recency for a page that isn't really in the validated content.
  // CHEAP per-bundle_hash authentication for the UNCAPPED content-recency pass — reads only the small
  // manifest.json (+ markers.json sidecar), NO payload re-hash, so the head cap stays a real cost bound
  // (full integrity hashing happens only for the capped heads actually materialized; roborev). Self-
  // consistency (manifest.bundle_hash === the dir key it lives under) + sanitizing markers to the
  // manifest's file targets is enough to drop a fabricated marker with no real snapshot behind it,
  // which is the resurrection vector; a corrupt PAYLOAD under a valid manifest still fails the full
  // integrity load at materialization time and is skipped there.
  const cheapCache = new Map(); // bundle_hash -> {targets:Set, versionMarkers} | null
  const loadValidatedCheap = (bundleHash) => {
    if (typeof bundleHash !== 'string' || !bundleHash) return null;
    if (cheapCache.has(bundleHash)) return cheapCache.get(bundleHash);
    let res = null;
    try {
      // SAME shape/identity/per-file gates as the full load (bundle_type, agent_id binding,
      // source===target, containment) — only the payload re-hash is skipped, so a crafted manifest
      // cannot slip a memory/ target + future marker past the cheap path that the full load would
      // reject (roborev). A corrupt PAYLOAD under an otherwise-valid manifest still fails the full
      // integrity load at materialization and is skipped there.
      const { manifest, versionDir } = loadManifestValidated({ storeReal, agentId, bundleHash, pointerLabel: 'head' });
      const targets = new Set();
      for (const f of manifest.files) { const t = safePageKey(f?.target); if (t) targets.add(t); }
      const raw = readMarkers(versionDir, storeReal) || {};
      const versionMarkers = {};
      for (const [k, v] of Object.entries(raw)) if (targets.has(k)) versionMarkers[k] = v;
      res = { targets, versionMarkers };
    } catch {
      res = null; // no valid snapshot at this hash → its markers cannot suppress a tombstone
    }
    cheapCache.set(bundleHash, res);
    return res;
  };
  // Merge a head's content recency into allContentMarkers, sanitized to the snapshot's real file set.
  // For each file that ACTUALLY EXISTS in the snapshot, prefer this head's FRESH per-page marker (an
  // identical-bytes republish reuses the immutable bundle_hash, so markers.json keeps the STALE time
  // while the fresh recency rides on the head) and fall back to markers.json when the head has none.
  // Sanitizing to the file set means a head can never advertise recency for a page not in its content —
  // closing the fabricated-marker resurrection while still honoring a fresh re-creation even when the
  // head is truncated out of the capped merge (roborev).
  // allContentMarkers: page -> {marker, hash} (the bundle providing the newest cheap-validated recency).
  // We keep the PROVIDING hash so the tombstone loop can do a TARGETED payload-integrity check before
  // letting a cheap-only marker suppress a deletion (a corrupt truncated-away snapshot can never be
  // materialized, so it must not keep a page alive; roborev).
  // TOMBSTONE-SUPPRESSION RECENCY: use ONLY the store-derived head/latest FILE mtime (`ts`), never the
  // publisher-supplied per-page markers (head.markers / markers.json) — neither is covered by bundle_hash,
  // so a writer could otherwise resurrect a fleet-deleted page by pointing at any valid OLD snapshot that
  // contains the page and forging a far-future per-page marker (roborev HIGH). The head file mtime is
  // stamped by the store at (re)publish time, so a page survives a deletion only if a valid content head
  // containing it was WRITTEN at/after the tombstone. (Per-page markers still drive content SELECTION —
  // which valid version wins — in the capped apply loop; that is not a resurrection vector.) A determined
  // store-writer can still `utimes` a head file; the complete fix is the deferred per-page logical clock
  // — this reduces the surface from "forge arbitrary JSON" to "forge a filesystem mtime".
  const mergeValidatedMarkers = (vs, bundleHash, ts) => {
    if (!vs) return;
    const recency = finiteOr(ts, NaN);
    if (!Number.isFinite(recency)) return;
    for (const rel of vs.targets) {
      const cur = allContentMarkers.get(rel);
      if (!cur || recency > cur.marker) allContentMarkers.set(rel, { marker: recency, hash: bundleHash });
    }
  };
  const headsDir = path.join(storeReal, agentId, 'heads');
  if (fs.existsSync(headsDir) && fs.statSync(headsDir).isDirectory()) {
    for (const name of fs.readdirSync(headsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const f = path.join(headsDir, name);
        assertWithinStore(f, storeReal, `heads/${name}`); // contain INSIDE try -> bad head skipped
        const h = JSON.parse(fs.readFileSync(f, 'utf8'));
        mergeInto(allTombstones, h?.tombstones); // from EVERY head, incl. tombstone-only heads
        const markers = h?.markers && typeof h.markers === 'object' && !Array.isArray(h.markers) ? h.markers : null;
        if (typeof h?.bundle_hash === 'string') {
          // Content recency that can SUPPRESS a tombstone must be backed by a self-consistent snapshot
          // — never trusted from head JSON for a page with no snapshot behind it (else a malformed head
          // advertises a far-future marker for a page whose snapshot does not exist and resurrects it;
          // roborev HIGH). CHEAP check (manifest only, no payload re-hash) keeps this uncapped pass
          // within the cost bound. Only enqueue a head whose snapshot passed the cheap gate — a
          // missing/malformed-manifest head must NOT consume a cap slot and evict valid content
          // (roborev). Tombstones were already collected above (from EVERY head, uncapped).
          const vs = loadValidatedCheap(h.bundle_hash);
          if (vs) {
            // Rank by store-derived FILE mtime, NOT publisher-supplied updated_at (anti-skew).
            const headTs = fs.statSync(f).mtimeMs;
            mergeValidatedMarkers(vs, h.bundle_hash, headTs); // store-derived head-file mtime only
            entries.push({ bundle_hash: h.bundle_hash, markers, ts: headTs });
          } else {
            invalidContentPointers++; // a head pointing at a missing/invalid snapshot
          }
        }
      } catch {
        // A malformed/unreadable/uncontained head file is skipped so ONE bad head can't fail the whole
        // merge — but it still counts as an invalid pointer so a heads/ dir containing ONLY corrupt
        // heads (e.g. a truncated write) surfaces as corruption instead of a false "nothing published"
        // (roborev). If any OTHER head/latest is valid, entries is non-empty and this never throws.
        invalidContentPointers++;
      }
    }
  }
  // ALWAYS consider latest.json too — during a rollout an older client updates only latest.json.
  const latestFile = path.join(storeReal, agentId, 'latest.json');
  if (fs.existsSync(latestFile)) {
    try {
      assertWithinStore(latestFile, storeReal, 'latest.json');
      const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      if (typeof latest?.bundle_hash === 'string') {
        // latest.json is markerless — recency comes from its validated markers.json. Same cheap gate
        // and same enqueue guard as heads (don't let an invalid latest pointer evict valid content).
        const vs = loadValidatedCheap(latest.bundle_hash);
        if (vs) {
          const latestTs = fs.statSync(latestFile).mtimeMs;
          mergeValidatedMarkers(vs, latest.bundle_hash, latestTs); // store-derived latest.json mtime only
          entries.push({ bundle_hash: latest.bundle_hash, markers: null, ts: latestTs });
        } else {
          invalidContentPointers++; // latest.json points at a missing/invalid snapshot
        }
      } else {
        invalidContentPointers++; // latest.json present but has no usable bundle_hash
      }
    } catch {
      invalidContentPointers++; // latest.json present but malformed/uncontained
    }
  }
  // A store with content POINTER(s) that ALL failed to validate is corrupt — surface it REGARDLESS of
  // whether tombstones exist. A tombstone must NOT mask the fact that every content pointer is
  // unreadable, or refresh would silently drop live pages (return empty content + deletions) instead of
  // failing (roborev). Only fires when NO valid content loaded but invalid pointers were seen.
  if (entries.length === 0 && invalidContentPointers > 0) {
    throw new Error('memory fetch failed: store has content pointer(s) but none are valid (store may be corrupt)');
  }
  // Nothing to merge at all — no content heads AND no tombstones AND no invalid pointers — is the
  // legitimate "nothing published yet" empty store.
  if (entries.length === 0 && allTombstones.size === 0) {
    return { mode: 'store', pages: null, deleted: new Map() };
  }

  // Dedup content by bundle_hash BEFORE truncation so a latest.json entry that duplicates a head
  // can't consume a cap slot and evict a distinct publisher (roborev). Keep newest ts + max markers.
  const byHash = new Map();
  for (const e of entries) {
    const prev = byHash.get(e.bundle_hash);
    if (!prev) {
      byHash.set(e.bundle_hash, { bundle_hash: e.bundle_hash, ts: e.ts, markers: e.markers ? { ...e.markers } : null });
      continue;
    }
    prev.ts = Math.max(prev.ts, e.ts);
    if (e.markers) {
      prev.markers = prev.markers || {};
      for (const [k, v] of Object.entries(e.markers)) {
        const n = Number(v);
        // SKIP a non-finite marker rather than coercing it to 0 — a malformed value in one duplicate
        // pointer must NOT overwrite a valid recency or force a fall-through that makes the page look
        // artificially old and lets an older page/tombstone win (roborev). A legitimate 0 is kept.
        if (!Number.isFinite(n)) continue;
        prev.markers[k] = Math.max(finiteOr(prev.markers[k], 0), n);
      }
    }
  }
  const deduped = [...byHash.values()];
  deduped.sort((a, b) => b.ts - a.ts);

  const perPage = new Map();
  const fullCache = new Map(); // bundle_hash -> {payloadRoot, files, versionMarkers} | null (failed)
  // FULL integrity load (payload re-hash). Bounded by the head cap — but the cap counts SUCCESSFUL
  // loads, so a corrupt/missing snapshot never consumes a slot and evicts a valid older one (which
  // could otherwise make refresh throw "no readable snapshot" while recoverable content still exists;
  // roborev). Also reused by the tombstone loop's targeted integrity check.
  const loadFull = (bundleHash) => {
    if (fullCache.has(bundleHash)) return fullCache.get(bundleHash);
    let snap = null;
    try {
      const s = loadSnapshotByPointer({ storeReal, agentId, bundleHash, pointerLabel: 'head' });
      const raw = readMarkers(s.versionDir, storeReal) || {};
      const targets = new Set(s.manifest.files.map((f) => f.target));
      const versionMarkers = {};
      for (const [k, v] of Object.entries(raw)) if (targets.has(k)) versionMarkers[k] = v;
      snap = { payloadRoot: s.payloadRoot, files: s.manifest.files, versionMarkers };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`memory refresh: skipping unreadable snapshot ${String(bundleHash).slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      snap = null;
    }
    fullCache.set(bundleHash, snap);
    return snap;
  };
  let anyLoaded = false;
  let loadedCount = 0;
  let attempted = 0;
  for (const e of deduped) {
    if (loadedCount >= MAX_MERGE_HEADS) break; // cap the MATERIALIZED (successfully loaded) set
    attempted++;
    const snap = loadFull(e.bundle_hash);
    if (!snap) continue; // corrupt/missing → does not consume a cap slot
    loadedCount++;
    anyLoaded = true;
    for (const file of snap.files) {
      const rel = file.target; // == source (validated in loadSnapshotByPointer)
      // Recency: this head's fresh per-page marker; else the snapshot's own markers.json
      // (backward compat); else the head's file mtime (publish recency, not bundle-hash order).
      // First FINITE recency signal (a legitimate marker of 0 must win, not fall through — the
      // `||` chain would treat 0 as absent; use nullish selection over finite values).
      const marker = finiteOr(e.markers?.[rel], finiteOr(snap.versionMarkers[rel], finiteOr(e.ts, 0)));
      const cur = perPage.get(rel);
      // Newest marker wins; ties break deterministically on the (full) bundle hash so all
      // machines converge on the same winner regardless of iteration order.
      if (!cur || marker > cur.marker || (marker === cur.marker && e.bundle_hash > cur.hash)) {
        perPage.set(rel, { srcFile: path.join(snap.payloadRoot, rel), marker, hash: e.bundle_hash });
      }
    }
  }
  if (loadedCount >= MAX_MERGE_HEADS && attempted < deduped.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `memory refresh: content heads exceed cap ${MAX_MERGE_HEADS}; merged the ${MAX_MERGE_HEADS} most recent loadable (raise AGENTBOOTUP_MEMORY_MAX_HEADS to include all)`,
    );
  }
  // Only fail if there WERE content pointers and none loaded (corrupt store). A store with only
  // tombstone-only heads (all pages deleted fleet-wide) legitimately loads no snapshot — that's an
  // empty union + deletions, not a corruption.
  if (entries.length > 0 && !anyLoaded) {
    throw new Error('memory fetch failed: no readable snapshot among the store pointers (store may be corrupt)');
  }

  // Resolve tombstones vs content: a page whose NEWEST signal is a deletion is deleted — drop it
  // from the union (superseded content is a resurrection) and return it so apply can remove any
  // local copy. Content newer-or-equal to the tombstone (re-created after deletion) survives.
  const deleted = new Map();
  for (const [p, tMs] of allTombstones) {
    // A page survives a deletion ONLY if a VALID content head containing it was WRITTEN to the store
    // at/after the tombstone. Recency is the STORE-DERIVED head-file mtime (allContentMarkers, built
    // uncapped from EVERY head in the pass above) — NOT publisher per-page markers, which are forgeable
    // and must never suppress a deletion (roborev HIGH). Integrity-verify the providing snapshot before
    // trusting it: a corrupt snapshot can never be materialized, so it cannot keep the page alive. The
    // loadFull is memoized (cache hit for a page already loaded into perPage; a targeted load for a
    // truncated head). tie (mtime == tMs) favors content, consistent with the apply-side rule.
    // Compare at INTEGER-MS granularity (floor the sub-ms file mtime to match the integer-ms tombstone)
    // with strict `>` — a page survives only if a valid content head was written in a STRICTLY LATER ms
    // than the deletion; ties (same integer ms) favor the DELETION so convergence terminates, consistent
    // with the apply-side rule (roborev). A same-ms re-publish-vs-delete is the rare accepted loss.
    const rec = allContentMarkers.get(p);
    if (rec && Math.floor(rec.marker) > Number(tMs) && loadFull(rec.hash)) continue;
    perPage.delete(p);
    deleted.set(p, tMs);
  }
  return { mode: 'store', pages: perPage, deleted, storeReal };
}

/**
 * Apply a fetched snapshot into memory/ non-destructively. Fill gaps, skip in-sync
 * pages, and leave drifted local edits untouched unless force.
 */
export function applyFetchedSnapshot({ projectRoot, manifest, payloadRoot, force = false }) {
  const restored = [];
  const overwritten = [];
  const drifted = [];
  const unchanged = [];

  // Anchor payload reads on the real payload root and refuse symlinks — this function is
  // exported and may run without fetchLatestFromStore's pre-scan (roborev 11596 finding 2).
  const payloadReal = fs.realpathSync(payloadRoot);
  const storeHashes = {}; // PR-2a: validated store bytes per page
  // Anchor local WRITES on the checkout's real root and refuse symlinked memory/ components
  // or symlinked destination pages — a memory/ (or memory/foo.md) symlinked outside the repo
  // must not let refresh read/write/--force arbitrary local paths (roborev 11602).
  const checkoutReal = fs.realpathSync(path.resolve(projectRoot));
  for (const file of manifest.files) {
    const rel = assertContainedRelativePath(file.target, 'manifest target');
    if (!rel.startsWith('memory/')) throw new Error(`memory fetch refused: target escapes memory/: ${rel}`);
    const src = path.join(payloadRoot, rel);
    assertWithinStore(src, payloadReal, `payload ${rel}`);
    const dst = path.join(checkoutReal, rel);
    // Create parent dirs refusing symlinked components, and refuse a symlinked dest file,
    // BEFORE any read (drift compare) or write to dst.
    mkdirWithinStore(path.dirname(dst), checkoutReal);
    assertWritableTarget(dst);
    const incoming = fs.readFileSync(src);
    storeHashes[rel] = sha256Hex(incoming); // PR-2a: validated store bytes

    if (fs.existsSync(dst)) {
      const current = fs.readFileSync(dst);
      if (current.equals(incoming)) {
        unchanged.push(rel);
        continue;
      }
      if (!force) {
        drifted.push(rel);
        continue;
      }
      fs.writeFileSync(dst, incoming);
      overwritten.push(rel);
      continue;
    }
    fs.writeFileSync(dst, incoming);
    restored.push(rel);
  }

  return { available_pages: manifest.files.length, restored, overwritten, drifted, unchanged, storeHashes };
}

/**
 * Apply a per-page MERGED result (from fetchMergedFromStore) into memory/ non-destructively.
 * Same drift semantics as applyFetchedSnapshot, but each winning page is read from its own
 * source snapshot (pages may come from different machines' snapshots).
 */
export function applyMergedSnapshot({ projectRoot, pages, deleted = null, storeReal, force = false }) {
  const restored = [];
  const overwritten = [];
  const drifted = [];
  const unchanged = [];
  const removed = [];
  // PR-2a: sha256 of the VALIDATED store bytes per applied/verified page —
  // recorded into the sync baseline as the fast-forward CAS reference.
  const storeHashes = {};
  const checkoutReal = fs.realpathSync(path.resolve(projectRoot));
  // Anchor EVERY source read on the trusted store root, not on the file's own dirname (which is
  // self-referential and validates nothing). This function is exported, so it must enforce
  // containment itself rather than trust the caller's pages (roborev).
  if (!storeReal) throw new Error('applyMergedSnapshot: storeReal (trusted store root) is required');
  const trustedRoot = fs.realpathSync(storeReal);

  for (const [relRaw, entry] of pages) {
    // Tolerate a malformed page KEY (defense-in-depth; the merge pre-validates its keys) — skip it.
    let rel;
    try {
      rel = assertContainedRelativePath(relRaw, 'merged page');
    } catch {
      drifted.push(String(relRaw));
      continue;
    }
    if (!rel.startsWith('memory/')) { drifted.push(rel); continue; }
    // STORE-SIDE validation + read. A failure here is shared-store CORRUPTION (uncontained/missing
    // payload) and MUST fail the refresh — do NOT mask it as benign drift, or refresh would report
    // success and advance the sync baseline over an incomplete store (roborev). Kept OUTSIDE the
    // local-write try below so it rethrows.
    assertWithinStore(entry.srcFile, trustedRoot, `merged src ${rel}`);
    const incoming = fs.readFileSync(entry.srcFile);
    storeHashes[rel] = sha256Hex(incoming);
    const dst = path.join(checkoutReal, rel);
    // LOCAL write path only: a refused/un-writable target (a symlinked memory/, a permission error) is
    // skipped -> drifted so ONE bad local page can't abort the whole refresh (roborev). VALIDATE the
    // destination path (symlink-safe parent + non-symlink target) BEFORE any read of dst — reading a
    // symlinked memory/ page would otherwise follow the link OUTSIDE the checkout during drift detection
    // (a local read escape; roborev). mkdirWithinStore + assertWritableTarget must precede fs.readFileSync.
    try {
      mkdirWithinStore(path.dirname(dst), checkoutReal); // symlink-safe parent path
      assertWritableTarget(dst); // reject a symlinked destination FILE before we ever read it
      if (fs.existsSync(dst)) {
        const current = fs.readFileSync(dst); // safe now: dst is validated contained + non-symlink
        if (current.equals(incoming)) {
          unchanged.push(rel);
          continue;
        }
        if (!force) {
          drifted.push(rel);
          continue;
        }
        fs.writeFileSync(dst, incoming);
        overwritten.push(rel);
        continue;
      }
      fs.writeFileSync(dst, incoming);
      restored.push(rel);
    } catch {
      drifted.push(rel); // local write refused/un-writable — left untouched, not fatal
    }
  }

  // Apply deletions (tombstones): remove a locally-present page whose newest fleet signal is a
  // deletion — NON-DESTRUCTIVELY. A local page edited AFTER the tombstone (mtime > deleted-at) is a
  // re-creation and is preserved (it will re-publish and un-tombstone). Only a regular file is
  // removed; a symlink/dir at the path is left (a collision, not our page).
  if (deleted && typeof deleted[Symbol.iterator] === 'function') {
    for (const [relRaw, tMs] of deleted) {
      // Defense-in-depth: fetchMergedFromStore already filters uncontained keys, but never let a
      // stray bad key ABORT the whole apply — skip it (roborev). A refresh must survive one bad head.
      let rel;
      try {
        rel = assertContainedRelativePath(relRaw, 'tombstone page');
      } catch {
        continue;
      }
      if (!rel.startsWith('memory/')) continue;
      const dst = path.join(checkoutReal, rel);
      let st = null;
      try { st = fs.lstatSync(dst); } catch { st = null; }
      if (!st || !st.isFile()) continue; // absent, or a symlink/dir collision → leave it
      // Containment before delete: a symlinked memory/ must NOT let a tombstone rmSync a file
      // outside the repo, NOR through an in-repo symlink like memory -> .git (roborev).
      // assertWithinStore catches escapes; assertNoSymlinkedAncestor catches in-repo symlinks.
      try {
        assertWithinStore(dst, checkoutReal, `tombstone target ${rel}`);
        assertNoSymlinkedAncestor(checkoutReal, rel);
      } catch {
        continue; // uncontained/symlinked → never delete through it
      }
      // Compare at INTEGER-MS granularity: tombstones are Date.now() (integer ms) but file mtimeMs
      // carries SUB-ms precision, so a page written in the SAME integer-ms as the tombstone would have
      // a fractional mtimeMs > tMs and be falsely preserved — the deletion would never converge (this
      // reproduced only on fast/Linux CI, not macOS; a real bug, not test flake). Floor the local
      // mtime to align the granularity. Strict `>` after flooring: preserve only a local copy in a
      // STRICTLY LATER ms than the deletion. Ties (same integer ms) favor the DELETION so convergence
      // terminates — `>=` was tried and breaks that contract (proven by the empty-publish convergence
      // test). A genuine re-creation still wins once PUBLISHED: the merge side keeps content unless the
      // tombstone is strictly newer than the content marker, so ties there favor content. True
      // resolution needs a logical clock (per-page rev) — deferred; mtime is not a logical clock.
      if (!force && Math.floor(st.mtimeMs) > Number(tMs)) {
        drifted.push(rel); // local re-creation in a later ms than the deletion → preserve
        continue;
      }
      // A single undeletable local file (read-only, locked, permission) must NOT abort the whole
      // refresh — skip+record it as drifted, the same way the content-write path skips a refused write
      // (roborev). The deletion simply doesn't converge on this checkout this pass.
      try {
        fs.rmSync(dst);
        removed.push(rel);
      } catch {
        drifted.push(rel);
      }
    }
  }

  return { available_pages: pages.size, restored, overwritten, drifted, unchanged, removed, storeHashes };
}
