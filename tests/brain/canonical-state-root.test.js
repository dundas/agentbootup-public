import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import {
  STATE_CONFLICTS,
  StateRootError,
  acquireLease,
  collectIgnoredState,
  createLocalStore,
  drainReplay,
  PER_MACHINE_STATE_ROOTS,
  materializeState,
  publishState,
  queueReplay,
  releaseLease,
  rollbackState,
  stateKey,
} from '../../lib/brain/canonical-state-root.js';

function git(args, cwd) {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (proc.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr}`);
  return (proc.stdout || '').trim();
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); // nosemgrep: path-join-resolve-traversal -- test fixture path from mkdtemp and a literal prefix
}

function reason(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof StateRootError, `expected StateRootError, got ${err}`);
    return err.reason;
  }
}

function setup() {
  const base = tempDir('state-root-');
  const store = createLocalStore(path.join(base, 'canonical'));
  const key = stateKey('seedid');
  return { base, store, key };
}

function lease(store, key, machineId, now = 1_000) {
  return acquireLease(store, key, machineId, { now });
}

test('state is keyed by brain, and by branch only when explicitly branched', () => {
  assert.equal(stateKey('seedid'), 'seedid');
  assert.equal(stateKey('seedid', 'overlay-a'), 'seedid/overlay-a');
  // Never keyed by a Git branch — that is the defect, not the design.
  assert.throws(() => stateKey('../escape'), /repo-relative path/);
  assert.throws(() => stateKey('seedid', '../escape'), /repo-relative path/);
});

test('WO 4: ignored memory survives a Git branch switch and is never force-added', () => {
  const { base, store, key } = setup();
  const work = path.join(base, 'work');
  git(['init', '--initial-branch=trunk', work], base);
  git(['config', 'user.email', 't@e.com'], work);
  git(['config', 'user.name', 'T'], work);
  // The managed ignore block: memory/ is ignored mutable state.
  fs.writeFileSync(path.join(work, '.gitignore'), 'memory/\n');
  fs.writeFileSync(path.join(work, 'tracked.txt'), 'tracked');
  git(['add', '.'], work);
  git(['commit', '-m', 'init'], work);

  fs.mkdirSync(path.join(work, 'memory', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(work, 'memory', 'MEMORY.md'), '# core');
  fs.writeFileSync(path.join(work, 'memory', 'daily', '2026-08-05.md'), '# today');

  const collected = collectIgnoredState(work);
  assert.deepEqual(Object.keys(collected).sort(), ['memory/MEMORY.md', 'memory/daily/2026-08-05.md']);

  const held = lease(store, key, 'machine-a');
  publishState(store, key, { machineId: 'machine-a', contents: collected, baseRevision: 0, lease: held });

  // Switch branches and wipe the working copy of ignored state, as a fresh
  // checkout of another branch would.
  git(['checkout', '-b', 'feature-x'], work);
  fs.rmSync(path.join(work, 'memory'), { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(work, 'memory', 'MEMORY.md')), false);

  const result = materializeState(store, key, work);
  assert.deepEqual(result.written, ['memory/MEMORY.md', 'memory/daily/2026-08-05.md']);
  assert.equal(fs.readFileSync(path.join(work, 'memory', 'MEMORY.md'), 'utf8'), '# core');

  // The ignore contract holds: restored state is still ignored, still untracked,
  // and was never force-added.
  assert.equal(git(['status', '--porcelain'], work), '');
  const tracked = git(['ls-files'], work).split('\n');
  assert.ok(!tracked.some((entry) => entry.startsWith('memory/')), 'memory must never enter the index');
  fs.rmSync(base, { recursive: true, force: true });
});

test('collectIgnoredState refuses a dangling allowed-root symlink', () => {
  const base = tempDir('state-root-dangling-');
  try {
    fs.symlinkSync(path.join(base, 'missing-external-root'), path.join(base, 'memory'));
    assert.equal(reason(() => collectIgnoredState(base)), 'STATE_ROOT_SYMLINK_DENIED');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('collectIgnoredState refuses an unreadable subtree rather than silently omitting it', () => {
  const base = tempDir('state-root-unreadable-');
  const unreadable = path.join(base, 'memory', 'private');
  try {
    fs.mkdirSync(unreadable, { recursive: true });
    fs.writeFileSync(path.join(unreadable, 'note.md'), 'not partially collected');
    fs.chmodSync(unreadable, 0o000);
    assert.equal(reason(() => collectIgnoredState(base)), 'STATE_ROOT_READ_FAILED');
  } finally {
    try { fs.chmodSync(unreadable, 0o700); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('WO 5: two divergent writers cannot silently overwrite each other', () => {
  const { base, store, key } = setup();
  const a = lease(store, key, 'machine-a', 1_000);
  const afterA = publishState(store, key, {
    machineId: 'machine-a',
    contents: { 'memory/MEMORY.md': 'from A' },
    baseRevision: 0,
    lease: a,
  });
  assert.equal(afterA.revision, 1);

  // Machine B still holds a lease it never had.
  assert.equal(
    reason(() => acquireLease(store, key, 'machine-b', { now: 1_100 })),
    STATE_CONFLICTS.LEASE_HELD,
    'a live lease fences a second writer',
  );

  // Even once the lease expires, B publishing from a stale base is refused: it
  // must converge before it can publish.
  const b = acquireLease(store, key, 'machine-b', { now: 999_999 });
  assert.equal(
    reason(() => publishState(store, key, {
      machineId: 'machine-b',
      contents: { 'memory/MEMORY.md': 'from B' },
      baseRevision: 0,
      lease: b,
    })),
    STATE_CONFLICTS.STALE_WRITER,
  );

  // A's content is intact — no silent last-writer-win.
  const index = store.readIndex(key);
  assert.equal(index.revision, 1);
  assert.equal(store.readBlob(key, index.entries['memory/MEMORY.md'].sha256).toString(), 'from A');

  // After converging to the current revision, B may publish.
  const converged = publishState(store, key, {
    machineId: 'machine-b',
    contents: { 'memory/MEMORY.md': 'from B' },
    baseRevision: index.revision,
    lease: b,
  });
  assert.equal(converged.revision, 2);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a resumed writer holding an old fencing token cannot publish', () => {
  const { base, store, key } = setup();
  const stale = lease(store, key, 'machine-a', 1_000);
  // The lease lapses and is taken over, then returns to A with a new token.
  acquireLease(store, key, 'machine-b', { now: 999_999 });
  const fresh = acquireLease(store, key, 'machine-a', { now: 2_000_000 });
  assert.ok(fresh.fencing_token > stale.fencing_token);

  assert.equal(
    reason(() => publishState(store, key, {
      machineId: 'machine-a',
      contents: { 'memory/x.md': 'x' },
      baseRevision: 0,
      lease: stale,
    })),
    STATE_CONFLICTS.LEASE_HELD,
    'an old token must not pass as current',
  );
  fs.rmSync(base, { recursive: true, force: true });
});

test('secrets never enter the canonical root', () => {
  const { base } = setup();
  const work = path.join(base, 'work');
  fs.mkdirSync(path.join(work, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(work, 'memory', 'MEMORY.md'), 'safe');
  // Blocked by the EXTENSION allowlist.
  fs.writeFileSync(path.join(work, 'memory', '.env'), 'API_KEY=leak');
  fs.writeFileSync(path.join(work, 'memory', 'my.key'), 'PRIVATE');
  fs.writeFileSync(path.join(work, 'memory', 'creds.pem'), 'PRIVATE');
  // Blocked by the SECRET GUARD specifically: `.json` and `.md` both pass the
  // extension allowlist, so only the guard can stop these. Without such a fixture
  // this test passes with the guard deleted — it names a guard it never exercises.
  fs.writeFileSync(path.join(work, 'memory', 'config.secret.json'), '{"token":"leak"}');
  fs.writeFileSync(path.join(work, 'memory', 'my-credentials.md'), 'password: leak');

  const collected = collectIgnoredState(work);
  // Excluded at collection, not on the way out — filtering later would leave a
  // secret at rest in a store that then syncs between machines.
  assert.deepEqual(Object.keys(collected), ['memory/MEMORY.md']);
  fs.rmSync(base, { recursive: true, force: true });
});

test('per-machine state never converges, however ignored it is', () => {
  const { base, store, key } = setup();
  const work = path.join(base, 'work');
  fs.mkdirSync(path.join(work, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(work, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(work, 'memory', 'MEMORY.md'), 'brain state');
  // `.brain/source-descriptor.json` describes THIS machine — its source_root is a
  // path that may not exist elsewhere. Converging it would push one machine's
  // descriptor onto another and point it at a path it does not have, recreating
  // the exact source ambiguity this work order removes.
  fs.writeFileSync(path.join(work, '.brain', 'source-descriptor.json'), '{"source_root":"/Users/a/dev/seedid"}');
  fs.writeFileSync(path.join(work, '.brain', 'share-state.json'), '{"pid":1234}');

  const collected = collectIgnoredState(work);
  assert.deepEqual(Object.keys(collected), ['memory/MEMORY.md']);
  assert.ok(!Object.keys(collected).some((p) => p.startsWith('.brain/')), '.brain must never converge');
  assert.deepEqual(PER_MACHINE_STATE_ROOTS, ['.brain']);

  // And it never reaches another checkout via materialization either.
  const held = lease(store, key, 'machine-a');
  publishState(store, key, { machineId: 'machine-a', contents: collected, baseRevision: 0, lease: held });
  const other = path.join(base, 'other-machine');
  const result = materializeState(store, key, other);
  assert.deepEqual(result.written, ['memory/MEMORY.md']);
  assert.equal(fs.existsSync(path.join(other, '.brain', 'source-descriptor.json')), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('deletions travel as tombstones so an offline machine cannot resurrect them', () => {
  const { base, store, key } = setup();
  const work = path.join(base, 'work');
  const held = lease(store, key, 'machine-a');
  publishState(store, key, {
    machineId: 'machine-a',
    contents: { 'memory/keep.md': 'keep', 'memory/gone.md': 'gone' },
    baseRevision: 0,
    lease: held,
  });
  publishState(store, key, {
    machineId: 'machine-a',
    contents: {},
    deletions: ['memory/gone.md'],
    baseRevision: 1,
    lease: held,
  });

  // A machine that still has the deleted file locally.
  fs.mkdirSync(path.join(work, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(work, 'memory', 'gone.md'), 'stale local copy');
  const result = materializeState(store, key, work);
  assert.deepEqual(result.removed, ['memory/gone.md']);
  assert.equal(fs.existsSync(path.join(work, 'memory', 'gone.md')), false);
  assert.equal(fs.readFileSync(path.join(work, 'memory', 'keep.md'), 'utf8'), 'keep');
  fs.rmSync(base, { recursive: true, force: true });
});

test('rollback restores a previous index without deleting content', () => {
  const { base, store, key } = setup();
  const held = lease(store, key, 'machine-a');
  publishState(store, key, { machineId: 'machine-a', contents: { 'memory/a.md': 'v1' }, baseRevision: 0, lease: held });
  const snapshot = store.readIndex(key);
  publishState(store, key, { machineId: 'machine-a', contents: { 'memory/a.md': 'v2' }, baseRevision: 1, lease: held });

  const rolled = rollbackState(store, key, snapshot, { machineId: 'machine-a', lease: held });
  assert.equal(rolled.revision, 3, 'rollback moves forward, it does not rewrite history');

  const work = path.join(base, 'work');
  materializeState(store, key, work);
  assert.equal(fs.readFileSync(path.join(work, 'memory', 'a.md'), 'utf8'), 'v1');
  fs.rmSync(base, { recursive: true, force: true });
});

test('offline replay re-bases and converges, and drops tombstoned work', () => {
  const { base, store, key } = setup();
  const a = lease(store, key, 'machine-a');
  publishState(store, key, { machineId: 'machine-a', contents: { 'memory/base.md': 'base' }, baseRevision: 0, lease: a });
  publishState(store, key, { machineId: 'machine-a', contents: {}, deletions: ['memory/deleted-elsewhere.md'], baseRevision: 1, lease: a });

  // Work produced offline against revision 0.
  let queue = [];
  queue = queueReplay(queue, { key, contents: { 'memory/offline.md': 'offline work' }, baseRevision: 0, machineId: 'machine-a' });
  queue = queueReplay(queue, { key, contents: { 'memory/deleted-elsewhere.md': 'resurrect me' }, baseRevision: 0, machineId: 'machine-a' });

  const { applied, remaining } = drainReplay(store, queue, { machineId: 'machine-a', lease: a });
  assert.equal(remaining.length, 0);
  assert.equal(applied.length, 1, 'the tombstoned entry is dropped, not resurrected');

  const index = store.readIndex(key);
  assert.ok(index.entries['memory/offline.md'], 'offline work is not lost');
  assert.ok(!index.entries['memory/deleted-elsewhere.md'], 'a deletion is not undone by replay');
  fs.rmSync(base, { recursive: true, force: true });
});

test('materialize refuses corrupt or missing content rather than writing it', () => {
  const { base, store, key } = setup();
  const work = path.join(base, 'work');
  const held = lease(store, key, 'machine-a');
  publishState(store, key, { machineId: 'machine-a', contents: { 'memory/a.md': 'body' }, baseRevision: 0, lease: held });

  const index = store.readIndex(key);
  const blobPath = path.join(base, 'canonical', 'seedid', 'blobs', index.entries['memory/a.md'].sha256);
  fs.writeFileSync(blobPath, 'TAMPERED');
  assert.equal(reason(() => materializeState(store, key, work)), 'STATE_BLOB_CORRUPT');

  fs.rmSync(blobPath);
  assert.equal(reason(() => materializeState(store, key, work)), 'STATE_BLOB_MISSING');
  fs.rmSync(base, { recursive: true, force: true });
});

test('a corrupt index or lease fails closed instead of reading as absent', () => {
  const { base, store, key } = setup();
  const held = lease(store, key, 'machine-a');
  publishState(store, key, { machineId: 'machine-a', contents: { 'memory/a.md': 'v1' }, baseRevision: 0, lease: held });

  const keyDir = path.join(base, 'canonical', 'seedid');

  // A malformed index must NOT read as revision 0 — that would let a writer
  // publish against an empty base and discard every prior entry and tombstone.
  const indexPath = path.join(keyDir, 'index.json');
  const goodIndex = fs.readFileSync(indexPath, 'utf8');
  fs.writeFileSync(indexPath, '{ truncated');
  assert.equal(reason(() => store.readIndex(key)), 'STATE_CORRUPT');
  assert.equal(
    reason(() => publishState(store, key, { machineId: 'machine-a', contents: {}, baseRevision: 0, lease: held })),
    'STATE_CORRUPT',
    'a corrupt index must never present itself as an empty store',
  );
  fs.writeFileSync(indexPath, goodIndex);

  // An unreadable lease must NOT read as "no lease" — that would hand the fence to
  // a second machine while the first still believes it holds it.
  fs.writeFileSync(path.join(keyDir, 'lease.json'), 'not json');
  assert.equal(reason(() => store.readLease(key)), 'STATE_CORRUPT');
  assert.equal(
    reason(() => acquireLease(store, key, 'machine-b', { now: 999_999 })),
    'STATE_CORRUPT',
    'a corrupt lease must not be mistaken for an unheld fence',
  );
  fs.rmSync(base, { recursive: true, force: true });
});

test('the lease requires an injected clock', () => {
  const { base, store, key } = setup();
  // Two machines must never depend on agreeing about wall time.
  assert.equal(reason(() => acquireLease(store, key, 'machine-a', {})), 'LEASE_CLOCK_REQUIRED');
  const held = lease(store, key, 'machine-a');
  assert.equal(reason(() => releaseLease(store, key, 'machine-b')), STATE_CONFLICTS.LEASE_HELD);
  releaseLease(store, key, 'machine-a');
  assert.equal(store.readLease(key), null);
  assert.ok(held.fencing_token >= 1);
  fs.rmSync(base, { recursive: true, force: true });
});
