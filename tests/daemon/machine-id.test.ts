import { test, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agentbootup-machine-id-test-')
);

const { getMachineId, getMachineInfo, _withMintLock } = await import('../../lib/machine-id/machine-id.js');

function idFile() {
  return process.env.AGENTBOOTUP_MACHINE_ID_FILE!;
}

beforeEach(async () => {
  const f = path.join(tmpDir, `machine-id-${Date.now()}`);
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = f;
  await fsp.unlink(f).catch(() => {});
});

// Restore, don't delete: the test preload (tests/setup/hermetic-machine-id.ts) sets a
// hermetic default, and clearing it would let a later file mint the host's real id.
const preloadedIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;

afterAll(async () => {
  if (preloadedIdFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  else process.env.AGENTBOOTUP_MACHINE_ID_FILE = preloadedIdFile;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('getMachineId creates a UUID on first call', async () => {
  const id = await getMachineId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('getMachineId returns the same ID on subsequent calls', async () => {
  const id1 = await getMachineId();
  const id2 = await getMachineId();
  expect(id1).toBe(id2);
});

test('getMachineId persists the ID to disk', async () => {
  const id = await getMachineId();
  const content = (await fsp.readFile(idFile(), 'utf-8')).trim();
  expect(content).toBe(id);
});

test('getMachineId machine-id file has mode 0o600', async () => {
  await getMachineId();
  const stat = await fsp.stat(idFile());
  expect(stat.mode & 0o777).toBe(0o600);
});

test('getMachineId parent directory has mode 0o700', async () => {
  const nestedDir = path.join(tmpDir, `nested-mid-${Date.now()}`);
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(nestedDir, 'machine-id');
  await getMachineId();
  const stat = await fsp.stat(nestedDir);
  expect(stat.mode & 0o777).toBe(0o700);
});

test('getMachineId returns existing ID from file', async () => {
  const customId = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
  const dir = path.dirname(idFile());
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(idFile(), customId + '\n', 'utf-8');
  const id = await getMachineId();
  expect(id).toBe(customId);
});

test('getMachineId regenerates when file contains invalid (non-UUID) content', async () => {
  const dir = path.dirname(idFile());
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(idFile(), 'not-a-uuid\n', 'utf-8');
  const id = await getMachineId();
  // Should generate a fresh UUID, not return the invalid string.
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  expect(id).not.toBe('not-a-uuid');
});

// ── getMachineInfo tests ───────────────────────────────────────────────────────

test('getMachineInfo returns correct shape without ip field', () => {
  const info = getMachineInfo();

  // Must have the four required string fields
  expect(typeof info.hostname).toBe('string');
  expect(typeof info.os_type).toBe('string');
  expect(typeof info.os_release).toBe('string');
  expect(typeof info.platform).toBe('string');

  // ip field must NOT be present (intentionally excluded — PII)
  expect('ip' in info).toBe(false);
});

test('getMachineInfo degrades gracefully when OS calls fail', () => {
  // Spy on os methods and make them throw
  const hostnamespy = spyOn(os, 'hostname').mockImplementation(() => { throw new Error('sandbox'); });
  const typespy = spyOn(os, 'type').mockImplementation(() => { throw new Error('sandbox'); });
  const releasespy = spyOn(os, 'release').mockImplementation(() => { throw new Error('sandbox'); });
  const platformspy = spyOn(os, 'platform').mockImplementation(() => { throw new Error('sandbox'); });

  let result: ReturnType<typeof getMachineInfo> | undefined;
  let threw = false;
  try {
    result = getMachineInfo();
  } catch {
    threw = true;
  }

  // Restore mocks before asserting (in case assertions throw)
  hostnamespy.mockRestore();
  typespy.mockRestore();
  releasespy.mockRestore();
  platformspy.mockRestore();

  expect(threw).toBe(false);
  expect(result).toEqual({ hostname: '', os_type: '', os_release: '', platform: '' });
});

// ── First-run exclusivity ────────────────────────────────────────────────────
//
// Credentials are encrypted against this id. If two processes each mint a different
// UUID on a fresh host and the last writer wins, the loser has already encrypted a
// credentials file against an id that is no longer on disk — permanently orphaned,
// which is the exact failure the machine-id binding exists to prevent.

test('concurrent in-process callers all agree on one id', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => getMachineId()));
  const unique = new Set(results);
  expect(unique.size).toBe(1);

  const onDisk = (await fsp.readFile(idFile(), 'utf-8')).trim();
  expect(onDisk).toBe(results[0]);
});

test('concurrent processes all agree on the id that is persisted', async () => {
  const f = idFile();
  const script = `
    const { getMachineId } = await import(${JSON.stringify(path.resolve('lib/machine-id/machine-id.js'))});
    process.stdout.write(await getMachineId());
  `;
  // Bun snapshots env at process start: mutations here are not inherited by children
  // unless spread explicitly. Passing process.env by omission would send the child to
  // the real ~/.agentbootup/machine-id.
  const procs = Array.from({ length: 8 }, () =>
    Bun.spawn(['bun', '-e', script], {
      env: { ...process.env, AGENTBOOTUP_MACHINE_ID_FILE: f },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  const ids = await Promise.all(procs.map((p) => new Response(p.stdout).text()));

  const onDisk = (await fsp.readFile(f, 'utf-8')).trim();
  expect(new Set(ids).size).toBe(1);
  expect(ids[0]).toBe(onDisk);
});

test('corrupt content is still regenerated in place', async () => {
  await fsp.writeFile(idFile(), 'not-a-uuid\n');
  const id = await getMachineId();
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  expect((await fsp.readFile(idFile(), 'utf-8')).trim()).toBe(id);
});

test('no temp files are left behind', async () => {
  await getMachineId();
  const dir = path.dirname(idFile());
  const leftovers = (await fsp.readdir(dir)).filter((n) => n.endsWith('.tmp'));
  expect(leftovers).toEqual([]);
});

// A single round of this passed even against a racy implementation — the interleaving
// that diverges does not occur every time. Loop until it would.
async function concurrentRound(seedCorrupt: boolean): Promise<{ diverged: boolean; junk: number }> {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'round-'));
  const f = path.join(dir, 'machine-id');
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = f;
  if (seedCorrupt) await fsp.writeFile(f, 'not-a-uuid\n');

  const results = await Promise.all(Array.from({ length: 8 }, () => getMachineId()));
  const onDisk = (await fsp.readFile(f, 'utf-8')).trim();
  const junk = (await fsp.readdir(dir)).filter((n) => n !== 'machine-id').length;
  await fsp.rm(dir, { recursive: true, force: true });

  // A caller that returns an id the file no longer holds has encrypted credentials
  // against nothing.
  return { diverged: new Set(results).size !== 1 || results[0] !== onDisk, junk };
}

test('concurrent regeneration over corrupt content converges on one id', async () => {
  let diverged = 0;
  let junk = 0;
  for (let i = 0; i < 20; i++) {
    const r = await concurrentRound(true);
    if (r.diverged) diverged++;
    junk += r.junk;
  }
  expect(diverged).toBe(0);
  expect(junk).toBe(0); // no stray .tmp or .lock left behind
});

test('concurrent first-run creation converges on one id', async () => {
  let diverged = 0;
  for (let i = 0; i < 20; i++) if ((await concurrentRound(false)).diverged) diverged++;
  expect(diverged).toBe(0);
});

test('a stale lock left by a killed process is stolen, not waited on forever', async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'stale-'));
  const f = path.join(dir, 'machine-id');
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = f;

  await fsp.writeFile(`${f}.lock`, '');
  const stale = new Date(Date.now() - 60_000);
  await fsp.utimes(`${f}.lock`, stale, stale);

  const id = await getMachineId();
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  expect((await fsp.readFile(f, 'utf-8')).trim()).toBe(id);
  await fsp.rm(dir, { recursive: true, force: true });
});

// A lock orphaned *just now* is not yet stale. The retry window has to outlast the
// staleness threshold, or every caller gives up before the lock becomes stealable.
test('a lock orphaned moments ago is waited out, not surrendered to', async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'fresh-orphan-'));
  const f = path.join(dir, 'machine-id');
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = f;

  // Nobody holds it, and it was created *just now* — it is not yet stale. A caller must
  // wait through LOCK_STALE_MS and then steal it. An attempt-capped window that expires
  // before the staleness threshold would throw here instead.
  await fsp.writeFile(`${f}.lock`, 'dead-holder-token');

  const started = Date.now();
  const id = await getMachineId();
  const waited = Date.now() - started;

  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  expect((await fsp.readFile(f, 'utf-8')).trim()).toBe(id);
  expect(waited).toBeGreaterThan(9_000);  // it really waited out the staleness threshold
  expect(fs.existsSync(`${f}.lock`)).toBe(false);
  await fsp.rm(dir, { recursive: true, force: true });
}, 30_000);

// A holder revived after its lock was stolen must not delete its successor's lock.
// This has to drive the holder's real `finally` block: asserting that a file we just
// wrote still exists would pass even if the release path deleted it.
test("releasing a stolen lock does not remove the new holder's lock", async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'ownership-'));
  const f = path.join(dir, 'machine-id');
  const lock = `${f}.lock`;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = f;

  let finish: (v: string) => void;
  const blocked = new Promise<string>((resolve) => { finish = resolve; });

  // Hold the lock. The callback parks until we release it, so we control the window.
  const holder = _withMintLock(f, () => blocked);

  // Wait for the holder to actually own the lock.
  for (let i = 0; i < 200 && !fs.existsSync(lock); i++) await Bun.sleep(5);
  expect(fs.existsSync(lock)).toBe(true);
  const holderToken = fs.readFileSync(lock, 'utf-8').trim();
  expect(holderToken).not.toBe('');

  // Simulate the theft: a successor now owns the lock file.
  fs.writeFileSync(lock, 'successor-token');

  // Let the original holder run through its finally block.
  finish!('done');
  await holder;

  // Its token no longer matches, so it must have left the successor's lock alone.
  expect(fs.existsSync(lock)).toBe(true);
  expect(fs.readFileSync(lock, 'utf-8').trim()).toBe('successor-token');

  fs.rmSync(lock, { force: true });
  await fsp.rm(dir, { recursive: true, force: true });
});

// Staleness must mean "the holder is dead", not "the holder is slow": an active holder
// heartbeats its lock, so a mint that outruns LOCK_STALE_MS is not robbed mid-section.
test('a slow but live holder is not treated as stale', async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'slow-holder-'));
  const f = path.join(dir, 'machine-id');
  const lock = `${f}.lock`;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = f;

  let finish: (v: string) => void;
  const blocked = new Promise<string>((resolve) => { finish = resolve; });
  const holder = _withMintLock(f, () => blocked);

  let token = '';
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(lock)) {
      token = fs.readFileSync(lock, 'utf-8').trim();
      if (token) break;
    }
    await Bun.sleep(5);
  }
  expect(token).not.toBe('');

  // Age past the staleness threshold. The heartbeat must push mtime forward again.
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(lock, old, old);
  await Bun.sleep(Math.floor(10_000 / 3) + 400);

  const age = Date.now() - (await fsp.stat(lock)).mtimeMs;
  expect(age).toBeLessThan(10_000);                       // refreshed, so not stealable
  expect(fs.readFileSync(lock, 'utf-8').trim()).toBe(token); // still the same holder

  finish!('done');
  await holder;
  expect(fs.existsSync(lock)).toBe(false);               // released by its owner
  await fsp.rm(dir, { recursive: true, force: true });
}, 20_000);


// getMachineId()'s one contract: the value it returns is the value on disk. If a racer's
// write lands last, the caller must learn the racer's id, not its own.
test('returns the persisted id, not the one it intended to write', async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'persisted-'));
  const f = path.join(dir, 'machine-id');
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = f;
  await fsp.writeFile(f, 'not-a-uuid\n');

  const id = await getMachineId();
  expect((await fsp.readFile(f, 'utf-8')).trim()).toBe(id);

  await fsp.rm(dir, { recursive: true, force: true });
});
