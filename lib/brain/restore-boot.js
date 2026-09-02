/**
 * `agentbootup brain restore --boot` — non-interactive, env-sourced boot-time restore.
 *
 * Designed for CI / container / orchestrator contexts where no operator is
 * present to supply credentials interactively. All inputs come from environment
 * variables. The restore is atomic (temp-dir staging → validate → promote),
 * fail-closed (non-zero exit on any error, never a partial brain), and
 * local-first for brain.db (sync is optional, never required for boot).
 *
 * Required env vars:
 *   AGENTBOOTUP_API_KEY   — API key for the agentbootup server
 *   AGENTBOOTUP_SERVER_URL — server URL (https://...)
 *   AGENTBOOTUP_BRAIN_ID  — brain ID to restore
 *
 * Optional env vars for brain.db sync (local-first; sync is never required):
 *   BRAIN_DB_URL   — libSQL remote sync URL
 *   BRAIN_DB_TOKEN — libSQL auth token
 *
 * Reuses from lib/brain/restore.js:
 *   writeAssets()            — core asset writing with subset filtering + traversal guard
 *   formatRestoreFailureLine() — HTTP error message formatting
 *
 * Usage (called by bootup.mjs when --boot flag is present):
 *   agentbootup brain restore --boot [--target <dir>] [--branch <id>]
 *                                     [--verbose] [--subset <csv>]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {
  writeAssets,
  assertRestoreMemorySelection,
  formatRestoreFailureLine,
  buildRestoreBundleRequest,
} from './restore.js';
import { isValidServerUrl, apiUrl } from '../auth/validate.js';
import { provisionBrainDbBoot } from './brain-db.js';
import { loadBrainMap, verifyAgainstMap } from '../memory/brain-map.js';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const RESTORE_TIMEOUT_MS = 30_000;

/** HTTP status codes that warrant a retry (transient server errors and rate-limits). */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

const DEFAULT_SUBSET = ['memory', 'skills', 'agents', 'commands', 'protocols', 'config', 'scripts', 'runtime'];

// ─────────────────────────────────────────────────────────────────────────────
// Env sourcing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read boot credentials exclusively from environment variables.
 * No file reads, no interactive prompts, no host operator involvement.
 *
 * @returns {{ ok: true, apiKey: string, serverUrl: string, brainId: string }
 *          | { ok: false, missing: string[] }}
 */
export function readBootEnv() {
  const apiKey = process.env.AGENTBOOTUP_API_KEY ?? '';
  const serverUrl = process.env.AGENTBOOTUP_SERVER_URL ?? '';
  const brainId = process.env.AGENTBOOTUP_BRAIN_ID ?? '';

  const missing = [];
  if (!apiKey) missing.push('AGENTBOOTUP_API_KEY');
  if (!serverUrl) missing.push('AGENTBOOTUP_SERVER_URL');
  if (!brainId) missing.push('AGENTBOOTUP_BRAIN_ID');

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, apiKey, serverUrl, brainId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle fetch with bounded retries + exponential backoff
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the boot bundle from POST /v1/boot-bundle with bounded retries.
 *
 * Retries on:
 *   - network errors (TypeError, AbortError, TimeoutError)
 *   - HTTP 429, 502, 503, 504 (transient server errors)
 *
 * Fails immediately on:
 *   - any other 4xx (client error — retrying won't help)
 *   - exhausted retries
 *
 * @param {{ apiKey: string, serverUrl: string, brainId: string, branchId?: string }} creds
 * @param {{ maxRetries?: number, baseBackoffMs?: number,
 *            sleep?: (ms:number) => Promise<void>,
 *            fetchFn?: typeof fetch }} [opts]
 * @returns {Promise<Array<{ asset_type: string, path: string, content_base64: string }>>}
 * @throws {Error} on unrecoverable failure (4xx, malformed response, exhausted retries)
 */
export async function fetchBootBundle(
  { apiKey, serverUrl, brainId, branchId = 'default' },
  {
    maxRetries = MAX_RETRIES,
    baseBackoffMs = BASE_BACKOFF_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchFn = globalThis.fetch,
  } = {},
) {
  const bundleUrl = apiUrl(serverUrl, '/v1/boot-bundle');
  const body = JSON.stringify(buildRestoreBundleRequest(brainId, branchId));

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = baseBackoffMs * Math.pow(2, attempt - 1);
      await sleep(backoff);
    }

    try {
      const resp = await fetchFn(bundleUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS),
      });

      if (!resp.ok) {
        let bodyData;
        try { bodyData = await resp.json(); } catch { bodyData = undefined; }
        const line = formatRestoreFailureLine(resp.status, bodyData, brainId);

        if (RETRYABLE_STATUS.has(resp.status) && attempt < maxRetries) {
          lastErr = new Error(line);
          continue;
        }
        throw new Error(line);
      }

      const bundle = await resp.json();
      const raw = bundle?.data?.brain_assets;

      if (raw === null || raw === undefined) {
        throw new Error(
          'Server returned no brain_assets. The server may not have brain asset support enabled.',
        );
      }
      if (!Array.isArray(raw)) {
        throw new Error('Server returned malformed brain_assets: expected an array.');
      }

      return raw;
    } catch (err) {
      // Retry on network-level failures (DNS failure, TCP refused, timeout).
      const isNetworkError =
        err.name === 'TimeoutError' ||
        err.name === 'AbortError' ||
        (err.name === 'TypeError' && err.message.includes('fetch'));
      if (isNetworkError && attempt < maxRetries) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error('fetch failed after retries');
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic promote helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively yield all regular file paths under `dir`.
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(entryPath);
    else if (entry.isFile()) yield entryPath;
  }
}

/**
 * Move all files from `srcDir` into `destDir`, creating parent directories as
 * needed. Each file rename is POSIX-atomic on the same device; cross-device
 * moves fall back to copy-then-unlink.
 *
 * @param {string} srcDir  Absolute path to source directory
 * @param {string} destDir Absolute path to destination directory
 */
/** Walk up from `p` to the nearest ancestor that exists on disk. */
function nearestExisting(p) {
  let cur = path.resolve(p);
  for (;;) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur; // filesystem root
    cur = parent;
  }
}

/**
 * PURE validation — NO filesystem mutation. Checks lexical containment and, via
 * realpath of the nearest EXISTING ancestor, that no pre-existing symlink would
 * carry the write outside the target. Returns the planned dest path. New (not-yet-
 * created) directories can't be symlinks, so validating existing ancestors is
 * sufficient. Throwing here leaves the target completely untouched.
 */
function planPromote(srcFile, srcDir, destDir) {
  const rel = path.relative(srcDir, srcFile);
  const destFile = path.join(destDir, rel);
  const resolvedDest = path.resolve(destFile);
  const resolvedTarget = path.resolve(destDir);
  // Belt-and-suspenders: rel comes from path.relative over our own walk so it
  // never contains '..', but guard anyway; the realpath/symlink check below is the real guard.
  if (resolvedDest !== resolvedTarget && !resolvedDest.startsWith(resolvedTarget + path.sep)) {
    throw new Error(`Promote refused: asset path escapes target dir: ${rel}`);
  }
  // Symlink safety against the nearest existing ancestor of the dest file, checked
  // against the nearest existing ancestor of the target (destDir may not exist yet).
  const realAncestor = fs.realpathSync(nearestExisting(path.dirname(destFile)));
  const realTargetAnc = fs.realpathSync(nearestExisting(destDir));
  if (realAncestor !== realTargetAnc && !realAncestor.startsWith(realTargetAnc + path.sep)) {
    throw new Error(`Promote refused: destination resolves outside target (symlink?): ${rel}`);
  }
  return { rel, destFile };
}

export function promoteDir(srcDir, destDir, { preserveExisting } = {}) {
  // PHASE 1 — PURE VALIDATION: validate every staged destination with NO
  // filesystem mutation. A validation failure aborts with the target completely
  // untouched (no dirs created, no files moved) — the fail-closed contract.
  // (Genuine mid-loop I/O errors like ENOSPC in phase 2 remain non-atomic in
  // userland; boot restore treats a failed restore as fail-closed + re-provisions,
  // so a half-written target never serves.)
  const planned = [];
  for (const srcFile of walkFiles(srcDir)) {
    planned.push({ srcFile, ...planPromote(srcFile, srcDir, destDir) });
  }
  // No-op restore: nothing staged → leave the target completely untouched
  // (don't even create destDir).
  if (planned.length === 0) return { moved: 0, preserved: 0 };
  // PHASE 2 — MUTATION: only now create dirs and move files.
  fs.mkdirSync(destDir, { recursive: true });
  let moved = 0;
  let preserved = 0;
  for (const { srcFile, destFile, rel } of planned) {
    // Non-destructive per-file (memory): a page already on disk is a local edit that may not
    // yet be pushed — fill gaps only, never clobber. preserveExisting(rel) decides per file so
    // ALL assets stage together (single atomic staging) while only memory is preserved. Phase-1
    // validation still ran on every file, so the fail-closed traversal guard is unchanged.
    // Only preserve a REGULAR FILE — a directory/symlink/special file where a page should be is
    // a collision, not a local edit: fall through to the move so it surfaces (rename overwrites a
    // symlink, throws on a dir) rather than silently skipping the server page (roborev).
    if (typeof preserveExisting === 'function' && preserveExisting(rel)) {
      let existing = null;
      try { existing = fs.lstatSync(destFile); } catch { existing = null; }
      if (existing && existing.isFile()) {
        preserved += 1;
        continue;
      }
    }
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    try {
      fs.renameSync(srcFile, destFile);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EXDEV') {
        // Cross-device: copy then unlink (still atomic per file on destination).
        fs.copyFileSync(srcFile, destFile);
        fs.unlinkSync(srcFile);
      } else {
        throw err;
      }
    }
    moved += 1;
  }
  return { moved, preserved };
}

/**
 * Write `assets` to a temp directory, validate that all writes succeeded, then
 * atomically promote the files into `target`. If any step fails the target is
 * left untouched.
 *
 * Reuses {@link writeAssets} from restore.js for the actual file writing —
 * no reimplementation of subset filtering, path traversal guards, or base64
 * decoding.
 *
 * @param {Array<{ asset_type: string, path: string, content_base64: string }>} assets
 * @param {{ target: string, verbose: boolean, subset: string[] }} opts
 * @returns {{ written: number, skipped: number }}
 * @throws {Error} if assets had write errors or the promote step failed
 */
export function writeAndPromote(assets, { target, verbose, subset, preserveExisting }) {
  assertRestoreMemorySelection(assets, target, subset);
  const tmpDir = path.join(
    os.tmpdir(),
    `brain-boot-tmp-${crypto.randomBytes(8).toString('hex')}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  let result;
  try {
    // force:true writes into the (empty) staging dir; non-destructiveness is enforced at
    // PROMOTE time against the real target (per-file via preserveExisting), so a populated
    // local memory/ is never clobbered — and ALL assets still stage in one atomic pass.
    result = writeAssets(assets, {
      target: tmpDir,
      force: true,
      dryRun: false,
      verbose,
      subset,
    });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }

  // FAIL CLOSED: any write error OR traversal-detected drop aborts the promote; target is never touched.
  // Treating dropped > 0 as fatal prevents a hostile bundle from smuggling a traversal asset alongside
  // good assets to force a partial restore of the good ones while the bad one is silently skipped.
  if (result.errors > 0 || result.dropped > 0) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    const reason = result.dropped > 0
      ? `${result.dropped} asset(s) attempted path traversal`
      : `${result.errors} asset(s) failed to write`;
    throw new Error(`Brain restore aborted: ${reason}. Target is unchanged.`);
  }

  // Promote: move every staged file into target (skipping existing files that preserveExisting matches).
  let promoteResult;
  try {
    // Backup policy is operator-owned local state. Incoming policy assets are
    // intentionally counted as preserved by promoteDir instead of replacing
    // the target's selection contract.
    const preserveLocalPolicy = (rel) =>
      typeof rel === 'string' && (
        rel === 'brain-backup.json' ||
        rel === '.brainignore' ||
        (typeof preserveExisting === 'function'
          ? preserveExisting(rel)
          : Boolean(preserveExisting))
      );
    promoteResult = promoteDir(tmpDir, target, { preserveExisting: preserveLocalPolicy });
  } catch (err) {
    // Promote failed; clean up whatever is left in tmpDir but do NOT touch target.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`Promote failed: ${err.message}. Target may be partially updated.`);
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }

  return { written: result.written, skipped: result.skipped, preserved: promoteResult.preserved };
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot arg parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse boot-specific args from argv (the slice AFTER `brain restore --boot`).
 * @param {string[]} argv
 * @returns {{ target: string, branchId: string, verbose: boolean, subset: string[] }}
 */
export function parseBootArgs(argv) {
  let target = process.cwd();
  let branchId = 'default';
  let verbose = false;
  let subset = DEFAULT_SUBSET;
  // Default: memory restore is NON-destructive (preserve unpushed local edits). --force-memory
  // is the explicit, deliberate opt-in to overwrite local memory with the server copy.
  let forceMemory = false;

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--target' || argv[i] === '--to') && argv[i + 1] !== undefined) {
      target = path.resolve(argv[++i]); // nosemgrep: path-join-resolve-traversal -- operator-supplied local target path
    } else if (argv[i] === '--branch' && argv[i + 1] !== undefined) {
      branchId = argv[++i].trim();
    } else if (argv[i] === '--verbose') {
      verbose = true;
    } else if (argv[i] === '--force-memory') {
      forceMemory = true;
    } else if (argv[i] === '--subset' && argv[i + 1] !== undefined) {
      subset = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    }
    // --boot is consumed by the caller; positional brain-id args are ignored
    // (brain ID must come from env in boot mode, not CLI args).
  }

  return { target, branchId, verbose, subset, forceMemory };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle `agentbootup brain restore --boot [...argv]`.
 *
 * @param {string[]} argv  Args after `brain restore` (including `--boot`)
 * @param {{
 *   maxRetries?: number,
 *   baseBackoffMs?: number,
 *   _sleep?: (ms: number) => Promise<void>,
 *   _fetch?: typeof fetch,
 * }} [testOpts]  Injected for testing only (sleep and fetch mocks)
 */
export async function runBrainRestoreBoot(argv = [], testOpts = {}) {
  const { maxRetries = MAX_RETRIES, baseBackoffMs = BASE_BACKOFF_MS, _sleep, _fetch } = testOpts;

  // 1. Parse CLI args (subset, target, branch — everything else comes from env).
  const { target, branchId, verbose, subset, forceMemory } = parseBootArgs(
    argv.filter((a) => a !== '--boot'),
  );

  // 2. Read credentials from env — no prompts, no file reads, no host operator.
  const envResult = readBootEnv();
  if (!envResult.ok) {
    console.error(
      `brain restore --boot: missing required environment variables: ${envResult.missing.join(', ')}\n` +
      'Set AGENTBOOTUP_API_KEY, AGENTBOOTUP_SERVER_URL, and AGENTBOOTUP_BRAIN_ID before running.',
    );
    process.exit(1);
  }
  const { apiKey, serverUrl, brainId } = envResult;

  // 3. Validate server URL eagerly — fail fast with a clear message.
  if (!isValidServerUrl(serverUrl)) {
    console.error(
      `brain restore --boot: AGENTBOOTUP_SERVER_URL="${serverUrl}" is not a valid server URL.`,
    );
    process.exit(1);
  }

  if (verbose) {
    console.log(`brain restore --boot: brain=${brainId}, branch=${branchId}, target=${target}`);
  }

  // 4. Fetch boot bundle with bounded retries and exponential backoff.
  let assets;
  try {
    assets = await fetchBootBundle(
      { apiKey, serverUrl, brainId, branchId },
      {
        maxRetries,
        baseBackoffMs,
        ...(typeof _sleep === 'function' ? { sleep: _sleep } : {}),
        ...(typeof _fetch === 'function' ? { fetchFn: _fetch } : {}),
      },
    );
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error(
        `brain restore --boot: request timed out after ${RESTORE_TIMEOUT_MS / 1000}s. ` +
        'Check network and AGENTBOOTUP_SERVER_URL.',
      );
    } else {
      console.error(`brain restore --boot: failed to fetch brain bundle: ${err.message}`);
    }
    process.exit(1);
  }

  if (verbose) {
    console.log(`brain restore --boot: fetched ${assets.length} asset(s)`);
  }

  // 5. Write assets atomically: stage ALL in one temp dir → validate → promote to target.
  //    FAIL CLOSED: any error here calls process.exit(1); the target is never partial.
  //    A single staging/promote pass keeps the all-or-nothing atomicity; the memory-loss
  //    guarantee is enforced PER FILE at promote time: memory pages are non-destructive (fill
  //    gaps, preserve unpushed local edits) unless --force-memory, while all other managed
  //    assets (skills/agents/protocols/config) overwrite as before.
  // Normalize the relative path to POSIX separators before matching — `rel` comes from
  // path.relative() and would be `memory\\...` on Windows, silently disabling preserve (roborev).
  // Blast-radius note (intentional): staging is a SINGLE atomic pass across all asset types, so
  // a dir/symlink colliding with a memory page path throws in promote and fail-closes the WHOLE
  // boot (not just that page). This is the deliberate "surface the collision, never silently
  // skip the server's page" tradeoff — a stray local directory under memory/ blocks the run.
  const preserveExisting = forceMemory
    ? undefined
    : (rel) => {
        const p = rel.split(path.sep).join('/');
        return p === 'memory' || p.startsWith('memory/');
      };
  let writeResult;
  try {
    writeResult = writeAndPromote(assets, { target, verbose, subset, preserveExisting });
  } catch (err) {
    console.error(`brain restore --boot: ${err.message}`);
    process.exit(1);
  }

  // 6. Provision brain.db — LOCAL-FIRST.
  //    Materializes .brain/db.ts + brain-schema.sql with no server call.
  //    The generated db.ts reads BRAIN_DB_URL / BRAIN_DB_TOKEN from env at
  //    runtime; sync is configured automatically if those env vars are present.
  //    A provisioning failure is non-fatal: the brain assets are already on disk.
  try {
    await provisionBrainDbBoot({ brainId, target, verbose });
  } catch (err) {
    if (verbose) {
      console.warn(`brain restore --boot: brain.db local provisioning failed (non-fatal): ${err.message}`);
    }
  }

  // 6.5. Verify restored memory against the committed brain-map (if present). Report present/
  //      missing so a fresh boot is VERIFIABLE against the git-committed inventory. A gap is
  //      surfaced (not fatal to boot — the assets already on disk are the best available copy).
  // Only verify against the brain-map when memory was actually in scope — a subset that excludes
  // memory would otherwise report a "gap" for pages it never tried to restore (roborev).
  let mapGap = 0;
  try {
    const map = subset.includes('memory') ? loadBrainMap(target) : null;
    if (map) {
      const v = verifyAgainstMap(target, map);
      mapGap = v.missing.length;
      console.log(`  brain-map: ${v.present.length}/${v.expected} expected memory pages present`);
      if (v.missing.length && verbose) {
        for (const rel of v.missing.slice(0, 20)) console.warn(`    MISSING ${rel}`);
      }
    }
  } catch (err) {
    console.warn(`brain restore --boot: brain-map present but invalid (non-fatal): ${err.message}`);
  }

  // 7. Summary — always printed so callers can parse it in logs.
  console.log(`\nbrain restore --boot complete (brain: ${brainId}, branch: ${branchId})`);
  console.log(`  written:   ${writeResult.written}`);
  console.log(`  skipped:   ${writeResult.skipped}`);
  if (forceMemory) {
    console.log(`  preserved: 0 (--force-memory: local memory overwritten with server copy)`);
  } else {
    console.log(`  preserved: ${writeResult.preserved} (local memory edits kept; --force-memory to overwrite)`);
  }
  console.log(`  target:    ${target}`);
  if (mapGap > 0) console.log(`  brain-map gap: ${mapGap} page(s) not recovered (see backup/store)`);
  console.log('\nNext steps:');
  console.log('  - Restart Claude Code to reload agents, skills, and commands');
}
