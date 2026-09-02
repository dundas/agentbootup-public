/**
 * PR-2a: only-local-moved (fast-forward) publish semantics — decisive ruling
 * msg-1784305375296-0g2v51, five binding conditions. Red-first.
 *
 * MEMORY_SYNC_SAFETY coverage: resurrection (T5), trust-boundary/forged
 * metadata (T4), stale-clobber by construction (T3).
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { runMemoryCommand } = await import('../lib/memory/cli.js');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ff-'));
const noop = () => {};
const io = { stdout: noop, stderr: noop };

let storeRoot: string;
let A: string;
let B: string;
let storeUrl: string;
let previousMachineIdFile: string | undefined;

function makeCheckout(name: string): string {
  const dir = fs.mkdtempSync(path.join(tmpBase, name));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'ff-test.gm' }));
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'ff-test.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  return dir;
}

/** Bump a file's mtime strictly past every store marker (normalized ms). */
function touchNewer(file: string) {
  const t = new Date(Date.now() + 5_000);
  fs.utimesSync(file, t, t);
}

beforeEach(() => {
  storeRoot = fs.mkdtempSync(path.join(tmpBase, 'store-'));
  storeUrl = `file://${storeRoot}`;
  A = makeCheckout('A-');
  B = makeCheckout('B-');
  previousMachineIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(tmpBase, 'no-such-machine-id');
});

afterEach(() => {
  if (previousMachineIdFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  else process.env.AGENTBOOTUP_MACHINE_ID_FILE = previousMachineIdFile;
});

test('T1 only-local-moved: editing your own page fast-forwards (exit 0) and content propagates', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v1\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);

  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v2\n');
  touchNewer(path.join(A, 'memory', 'MEMORY.md'));
  // Store content == A's baseline (A last synced v1) AND local strictly newer
  // => fast-forward publish (was exit 3 before PR-2a).
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);

  // The edit propagates: B refresh materializes v2.
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', B, '--store', storeUrl], io)).toBe(0);
  expect(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'), 'utf8')).toBe('v2\n');
});

test('T2 both-sides-moved stays exit 3 — no auto-resolve', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v1\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', B, '--store', storeUrl], io)).toBe(0);

  // A moves the store forward…
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'A v2\n');
  touchNewer(path.join(A, 'memory', 'MEMORY.md'));
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  // …and B edits the same page: store != B's baseline => both moved => 3.
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'B v2\n');
  touchNewer(path.join(B, 'memory', 'MEMORY.md'));
  expect(await runMemoryCommand(['publish', '--cwd', B, '--store', storeUrl], io)).toBe(3);
  // Local edit untouched.
  expect(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'), 'utf8')).toBe('B v2\n');
});

test('T3 stale-baseline same-page edit is REFUSED — stale-clobber impossible by construction', async () => {
  // B syncs at v1, goes dark; A advances the fleet to v2.
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v1\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', B, '--store', storeUrl], io)).toBe(0);
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v2\n');
  touchNewer(path.join(A, 'memory', 'MEMORY.md'));
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);

  // Stale B edits the page with an even NEWER mtime — strictly-newer alone
  // must NOT suffice: store (v2) != B baseline (v1) => exit 3, merge-first.
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'stale clobber attempt\n');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(B, 'memory', 'MEMORY.md'), later, later);
  expect(await runMemoryCommand(['publish', '--cwd', B, '--store', storeUrl], io)).toBe(3);
});

test('T4 forged markers cannot satisfy the gate — baseline equality uses validated store BYTES', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v1\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', B, '--store', storeUrl], io)).toBe(0);
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v2\n');
  touchNewer(path.join(A, 'memory', 'MEMORY.md'));
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);

  // Attacker rewrites every head marker to epoch 1 so ANY local edit looks
  // strictly newer. The gate must still refuse: store bytes (v2) != B's
  // baseline bytes (v1) — content, not publisher-advertised markers, decides.
  const headsDir = path.join(storeRoot, 'ff-test.gm', 'heads');
  for (const f of fs.readdirSync(headsDir)) {
    const head = JSON.parse(fs.readFileSync(path.join(headsDir, f), 'utf8'));
    if (head.markers) for (const k of Object.keys(head.markers)) head.markers[k] = 1;
    fs.writeFileSync(path.join(headsDir, f), JSON.stringify(head));
  }
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'forged-marker clobber\n');
  touchNewer(path.join(B, 'memory', 'MEMORY.md'));
  expect(await runMemoryCommand(['publish', '--cwd', B, '--store', storeUrl], io)).toBe(3);
});

test('T5 empty/fresh-clone never publishes-as-delete — rule unaffected by fast-forward', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'survives\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);

  // Fresh empty checkout publishes (tombstone-only head, but with NO
  // deletions — it has no baseline proving it ever held the fleet's pages).
  const fresh = makeCheckout('fresh-');
  await runMemoryCommand(['publish', '--cwd', fresh, '--store', storeUrl], io);

  // A's content must survive the merge on a third checkout.
  const C = makeCheckout('C-');
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', C, '--store', storeUrl], io)).toBe(0);
  expect(fs.readFileSync(path.join(C, 'memory', 'MEMORY.md'), 'utf8')).toBe('survives\n');
});

test('T6 refresh must NOT advance the CAS reference for drifted pages (no delayed auto-resolve)', async () => {
  // Both sides move; B then runs refresh (drift reported, local kept) and
  // publishes. The refresh's baseline write must preserve B's OLD reference
  // for the drifted page — otherwise the very next publish fast-forwards a
  // genuine both-sides conflict (caught by the daemon hermetic tests).
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v1\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', B, '--store', storeUrl], io)).toBe(0);
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'A v2\n');
  touchNewer(path.join(A, 'memory', 'MEMORY.md'));
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), 'B v2\n');
  touchNewer(path.join(B, 'memory', 'MEMORY.md'));

  // The poisoning step: refresh sees the drift, leaves local alone…
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', B, '--store', storeUrl], io)).toBe(0);
  // …and publish must STILL refuse (store A-v2 != what B last accepted, v1).
  expect(await runMemoryCommand(['publish', '--cwd', B, '--store', storeUrl], io)).toBe(3);
  expect(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'), 'utf8')).toBe('B v2\n');
});

test('T7 flush/replay -> same-page edit fast-forwards (replayed publish maintains the CAS reference)', async () => {
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v1\n');
  // flush = capture + queue + replay (deferred-publish delivery path).
  expect(await runMemoryCommand(['flush', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  // The next same-page edit must be only-local-moved => fast-forward 0,
  // not "no baseline content reference" => 3 (roborev regression).
  fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), 'v2 after replay\n');
  touchNewer(path.join(A, 'memory', 'MEMORY.md'));
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);
});

test('T8 replayed deletions leave the baseline — a recreated page is not re-deleted by a later publish', async () => {
  // A holds two pages, syncs; then deletes one and flushes (replayed delete).
  fs.writeFileSync(path.join(A, 'memory', 'KEEP.md'), 'keep\n');
  fs.writeFileSync(path.join(A, 'memory', 'GONE.md'), 'gone soon\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  fs.rmSync(path.join(A, 'memory', 'GONE.md'));
  expect(await runMemoryCommand(['flush', '--cwd', A, '--store', storeUrl], io)).toBe(0);

  // B recreates the page (strictly newer than the tombstone) and publishes.
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', B, '--store', storeUrl], io)).toBe(0);
  await new Promise((r) => setTimeout(r, 5));
  fs.writeFileSync(path.join(B, 'memory', 'GONE.md'), 'recreated\n');
  touchNewer(path.join(B, 'memory', 'GONE.md'));
  expect(await runMemoryCommand(['publish', '--cwd', B, '--store', storeUrl], io)).toBe(0);

  // A makes an UNRELATED edit and publishes. A's baseline must not still
  // claim GONE.md as last-synced state — that would re-delete B's
  // recreation (stale-deletion resurrection, roborev High).
  fs.writeFileSync(path.join(A, 'memory', 'KEEP.md'), 'keep v2\n');
  touchNewer(path.join(A, 'memory', 'KEEP.md'));
  const rc = await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io);
  expect([0, 3]).toContain(rc); // fast-forward or merge-first — either is honest
  const C = makeCheckout('C8-');
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', C, '--store', storeUrl], io)).toBe(0);
  expect(fs.existsSync(path.join(C, 'memory', 'GONE.md'))).toBe(true); // recreation SURVIVES
  expect(fs.readFileSync(path.join(C, 'memory', 'GONE.md'), 'utf8')).toBe('recreated\n');
});

test('T9 baseline pages added between queue and replay survive (no false tombstone, no lost delete-detection)', async () => {
  // Reviewer scenario: queue a replay for {A-page}, then the baseline grows
  // via refresh (B publishes NEW.md; A refreshes and materializes it), then
  // the old replay lands. A later unrelated publish must NOT tombstone
  // NEW.md (it is locally present) — and conversely, keeping it in the
  // baseline preserves delete-detection if the user later deletes it.
  fs.writeFileSync(path.join(A, 'memory', 'KEEP.md'), 'keep\n');
  expect(await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io)).toBe(0);

  // Queue (but do not deliver) a replay item against the REAL store
  // identity, using the direct enqueue API (the established daemon-health
  // test pattern) so nothing drains it yet.
  const { enqueueReplayItem } = await import('../lib/memory/replay-queue.js');
  const { resolveMemoryStore } = await import('../lib/memory/store.js');
  enqueueReplayItem({ projectRoot: A, store: resolveMemoryStore(storeUrl), snapshotId: 't9-frozen' });

  // Baseline grows: B publishes NEW.md; A refreshes (materializes + baselines it).
  fs.writeFileSync(path.join(B, 'memory', 'NEW.md'), 'from B\n');
  expect(await runMemoryCommand(['publish', '--cwd', B, '--store', storeUrl], io)).toBe(0);
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  expect(fs.existsSync(path.join(A, 'memory', 'NEW.md'))).toBe(true);

  // NOW the old item genuinely replays against the same store identity —
  // the exact queue-then-baseline-grows-then-replay interleaving.
  expect(await runMemoryCommand(['replay', '--cwd', A, '--store', storeUrl], io)).toBe(0);
  // Then an unrelated publish:
  fs.writeFileSync(path.join(A, 'memory', 'KEEP.md'), 'keep v2\n');
  touchNewer(path.join(A, 'memory', 'KEEP.md'));
  const rc = await runMemoryCommand(['publish', '--cwd', A, '--store', storeUrl], io);
  expect([0, 3]).toContain(rc);

  // NEW.md survives fleet-wide (never tombstoned by A's publish).
  const C = makeCheckout('C9-');
  expect(await runMemoryCommand(['refresh', '--from-store', '--cwd', C, '--store', storeUrl], io)).toBe(0);
  expect(fs.existsSync(path.join(C, 'memory', 'NEW.md'))).toBe(true);
});
