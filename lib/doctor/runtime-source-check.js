/**
 * FR `runtime_source_matches` (PRD-0063) — machine-tier doctor check.
 *
 * Detects, per host, every `com.dundas.agentbootup-*` LaunchAgent whose executed code
 * does not come from the declared runtime source — the read-only detection half of
 * finding 0061 (the fleet's daemons run from a git working checkout, not a release).
 * Reports only; it changes nothing (PRD-0063 FR-5: read-only).
 *
 * WHY THIS CHECK EXISTS (finding 0061): 96 of 101 daemons on the main machine execute a
 * git working checkout — an unmerged branch, 62 commits behind main, 24 uncommitted
 * files. `agentbootup --version` reports the installed package while the daemons run
 * something else. A `git checkout` in that repo silently re-points 96 daemons with no
 * restart and no version change. This check makes that drift visible, once per host.
 *
 * VERDICT PRECEDENCE (exactly one per label — FR-3):
 *   plist_invalid > path_missing > source_mismatch > process_mismatch > ok
 * A healthy sibling must never mask a dead one, so verdicts are keyed by LABEL, not
 * brain (one brain owns several labels). `not_loaded`/`last_exit_nonzero` are DEFERRED
 * (PRD-0063 Task 3.7): the `launchctl list` exit-status semantics are under-specified,
 * they do not affect the acceptance number, and `path_missing` already catches the
 * motivating exit-78 incident with no `launchctl` at all.
 *
 * PATH NORMALIZATION (the load-bearing detail — PRD-0063 "THE PATH-NORMALIZATION
 * CONTRACT"): resolve both the plist `ProgramArguments` and the live process argv
 * through `resolveDaemonScriptPath` (the ungated core of `daemonScriptFromArgv`), then
 * resolve each to a canonical runtime root and compare by path SEGMENTS — never
 * `string.startsWith` (`/x/agentbootup-2` must not match `/x/agentbootup`). A root-shaped
 * plist (ProgramArguments[1] is the package dir) and a file-shaped plist (a script under
 * it) resolve to the SAME root. Realpath collapses symlinked roots.
 *
 * READ-ONLY (FR-5 / Task 4.5): the only shell-outs are `ps` (process listing) and
 * `launchctl list` (label→PID; it returns PID+exit only, never argv — argv comes from
 * `ps`). The `safeCommandRunner` rejects any command that is not a read. No plist writes,
 * no `launchctl` mutations. A migration command is out of scope (finding 0061 Move 1).
 *
 * MACHINE-TIER (FR-4): one record per host carrying `machine_id` (the stable UUID from
 * `lib/machine-id`, never `os.hostname()`). Brain rows may inherit a badge; they must
 * not re-derive the finding, so this is NOT wired into the per-agent `live-runners`.
 *
 * Aggregation (FR-6): any `plist_invalid`/`path_missing`/`source_mismatch`/`process_mismatch`
 * ⇒ `fail`; missing OR invalid declaration ⇒ `unknown` (never `pass`); all `ok` ⇒ `pass`.
 * The result carries COUNTS BY VERDICT and the LIST OF OFFENDING LABELS — not a boolean,
 * so the acceptance output cannot be faked (`sum(verdicts) == total_labels`).
 */

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { readJsonFile } from '../util/read-file.js';
import { resolveAgentbootupRoot, resolveDaemonScriptPath, parseProcessLine } from './install-inventory.js';
import { readLaunchAgentPlist } from './plist-reader.js';
import { readMachineIdState } from '../machine-id/machine-id.js';

const execFile = promisify(execFileCallback);

/** The five per-label verdicts, in precedence order (highest first). */
export const VERDICTS = Object.freeze(['plist_invalid', 'path_missing', 'source_mismatch', 'process_mismatch', 'ok']);

const AGENTBOOTUP_PLIST_PREFIX = 'com.dundas.agentbootup-';
const DEFAULT_PLIST_DIR = () => path.join(os.homedir(), 'Library', 'LaunchAgents');
const DEFAULT_DECLARATION_FILE = () => path.join(os.homedir(), '.agentbootup', 'runtime-source.json');

/** `launchctl` subcommands that are pure reads. Everything else is refused. */
const LAUNCHCTL_READ_SUBCOMMANDS = new Set(['list', 'print', 'plist']);

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** Error code prefix for diagnostics, e.g. "EACCES: ". Empty when no code is set. */
function errCode(err) {
  return err && typeof err === 'object' && typeof err.code === 'string' && err.code ? `${err.code}: ` : '';
}

/**
 * Pure allowlist decision (PRD-0063 Task 4.5): is `command args` a read this check is
 * permitted to run? The ONLY allowed commands are `ps` (process listing) and a
 * read-only `launchctl` subcommand (`list`/`print`/`plist`). Everything else —
 * `launchctl bootout`/`kickstart`/`load`/`unload`/`bootstrap`, plist writers
 * (`plutil -insert`, `defaults write`), or any other binary — is REFUSED.
 *
 * Pure so it is testable hermetically WITHOUT a host that has `ps`/`launchctl`
 * (CI is Linux; `launchctl` does not exist there). `safeCommandRunner` calls this
 * and then executes; the allowlist itself never shells out.
 * @returns {boolean}
 */
export function isPermittedReadCommand(command, args = []) {
  const cmdName = path.basename(String(command));
  if (cmdName === 'ps') return true;
  if (cmdName === 'launchctl') {
    return LAUNCHCTL_READ_SUBCOMMANDS.has(String(args[0] ?? ''));
  }
  return false;
}

/**
 * Read-only command runner. The ONLY shell-out path in this check, and it is allowlisted
 * so the check cannot be repurposed to mutate (PRD-0063 Task 4.5). A `launchctl bootout` /
 * `kickstart` / `load` / `unload` / `bootstrap`, or any non-`ps`/read-`launchctl` command
 * (including plist writers like `plutil -insert` or `defaults write`), is REFUSED.
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string>} stdout (trimmed)
 */
export async function safeCommandRunner(command, args = []) {
  if (!isPermittedReadCommand(command, args)) {
    const cmdName = path.basename(String(command));
    const sub = cmdName === 'launchctl' ? ` ${JSON.stringify(args[0] ?? '')}` : '';
    throw new Error(`runtime_source_matches: refused command ${JSON.stringify(command)}${sub} (only ps / read-only launchctl are permitted)`);
  }
  const { stdout } = await execFile(command, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Containment by path SEGMENTS — never `string.startsWith` (PRD-0063 contract).
 * `/x/agentbootup-2` must not match `/x/agentbootup`. Both inputs must be realpaths.
 * @param {string} root  the declared runtime root
 * @param {string} candidate  the daemon's resolved runtime root
 * @returns {boolean} candidate is within or equal to root
 */
export function isWithin(root, candidate) {
  const rootSegs = path.resolve(root).split(path.sep).filter(Boolean);
  const candSegs = path.resolve(candidate).split(path.sep).filter(Boolean);
  if (candSegs.length < rootSegs.length) return false;
  for (let i = 0; i < rootSegs.length; i++) {
    if (candSegs[i] !== rootSegs[i]) return false;
  }
  return true;
}

/**
 * Validate and normalize a runtime-source declaration object.
 * @returns {{ valid: true, kind: string, path: string, commit: string|null } | { valid: false, reason: string }}
 */
function validateDeclarationShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'declaration is not a JSON object' };
  }
  const { kind, path: declPath, commit } = value;
  if (kind !== 'package' && kind !== 'pinned_checkout') {
    return { valid: false, reason: `kind must be 'package' or 'pinned_checkout' (got ${JSON.stringify(kind)})` };
  }
  if (typeof declPath !== 'string' || declPath.length === 0) {
    return { valid: false, reason: 'path must be a non-empty string' };
  }
  if (!path.isAbsolute(declPath)) {
    return { valid: false, reason: 'path must be absolute' };
  }
  if (commit !== undefined && commit !== null && typeof commit !== 'string') {
    return { valid: false, reason: 'commit must be a string or null' };
  }
  return { valid: true, kind, path: declPath, commit: commit ?? null };
}

/**
 * Load and resolve the declared runtime source (PRD-0063 Task 1.0 / FR-1).
 * Absent OR invalid (file or schema) ⇒ `{ state: 'unknown' }` — never pass.
 * @returns {Promise<{ state: 'ok', kind, path, commit, root } | { state: 'unknown', reason }>}
 */
async function loadDeclaration(declarationFile, deps) {
  const readFile = deps.readDeclarationFile ?? readJsonFile;
  let read;
  try {
    read = await readFile(declarationFile);
  } catch (err) {
    return { state: 'unknown', reason: `declaration unreadable: ${errMessage(err)}` };
  }
  if (read.state === 'absent') {
    return { state: 'unknown', reason: `no runtime-source declaration at ${declarationFile}` };
  }
  if (read.state === 'invalid') {
    return { state: 'unknown', reason: `declaration invalid JSON (${read.detail}) at ${declarationFile}` };
  }
  const shape = validateDeclarationShape(read.value);
  if (!shape.valid) {
    return { state: 'unknown', reason: `declaration invalid: ${shape.reason} (${declarationFile})` };
  }
  const realpath = deps.realpath ?? fsp.realpath;
  const stat = deps.stat ?? fsp.stat;
  // The declared path must resolve to an existing directory (PRD contract: "realpath; must be a directory").
  let root;
  try {
    root = await realpath(shape.path);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { state: 'unknown', reason: `declared path does not exist: ${shape.path}` };
    }
    return { state: 'unknown', reason: `declared path unresolvable: ${errMessage(err)}` };
  }
  let st;
  try {
    st = await stat(root);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { state: 'unknown', reason: `declared path does not exist: ${shape.path}` };
    }
    return { state: 'unknown', reason: `declared path unstatable: ${errMessage(err)}` };
  }
  if (!st.isDirectory()) {
    return { state: 'unknown', reason: `declared path is not a directory: ${shape.path}` };
  }
  return { state: 'ok', kind: shape.kind, path: shape.path, commit: shape.commit, root };
}

/**
 * Resolve a daemon script path to its runtime root (PRD-0063 contract).
 *   - directory  -> the directory IS the root (no walk-up: a root-shaped plist pointing
 *     at `/x/agentbootup-2` resolves to `/x/agentbootup-2`, never a sibling `/x/agentbootup`)
 *   - file       -> walk up to the nearest ancestor whose package.json name is 'agentbootup'
 *   - missing    -> { missing: true }; the caller emits `path_missing` and keeps the lexical
 *     path for diagnostics. Do NOT resolve a missing path (realpath would throw / invent).
 *   - unreadable -> { unresolved: true, reason } (EACCES / ENOTDIR / ELOOP / other non-ENOENT
 *     stat or realpath error). The caller demotes that ONE label to `plist_invalid` rather
 *     than crashing the whole 101-label check — same discipline as the readdir ENOENT-vs-other
 *     split and the plist_invalid verdict: one bad label must not take down the other 100.
 * @returns {Promise<{ root: string|null, missing: boolean, unresolved?: boolean, reason?: string, lexical: string }>}
 */
async function resolveRuntimeRoot(scriptPath, deps) {
  const realpath = deps.realpath ?? fsp.realpath;
  const stat = deps.stat ?? fsp.stat;
  let st;
  try {
    st = await stat(scriptPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { root: null, missing: true, lexical: scriptPath };
    // Non-ENOENT (EACCES / ENOTDIR / ELOOP / EIO): demote this label, never crash the check.
    return { root: null, missing: false, unresolved: true, reason: `stat ${scriptPath}: ${errCode(err)}${errMessage(err)}`, lexical: scriptPath };
  }
  let resolvedRoot;
  if (st.isDirectory()) {
    try {
      resolvedRoot = await realpath(scriptPath);
    } catch (err) {
      if (err?.code === 'ENOENT') return { root: null, missing: true, lexical: scriptPath };
      return { root: null, missing: false, unresolved: true, reason: `realpath ${scriptPath}: ${errCode(err)}${errMessage(err)}`, lexical: scriptPath };
    }
    return { root: resolvedRoot, missing: false, lexical: scriptPath };
  }
  // file (or other) — walk up to the nearest agentbootup package root (reuses the hardened resolver).
  try {
    resolvedRoot = await resolveAgentbootupRoot(scriptPath, deps);
  } catch (err) {
    return { root: null, missing: false, unresolved: true, reason: `resolveAgentbootupRoot ${scriptPath}: ${errCode(err)}${errMessage(err)}`, lexical: scriptPath };
  }
  return { root: resolvedRoot, missing: false, lexical: scriptPath };
}

function parseLaunchctlList(output) {
  const map = new Map();
  if (!output) return map;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const label = parts.slice(2).join(' ');
    if (!label.startsWith(AGENTBOOTUP_PLIST_PREFIX)) continue;
    const pidStr = parts[0];
    if (pidStr === '-') continue; // not loaded — deferred (PRD Task 3.7); no process_mismatch evidence
    const pid = Number(pidStr);
    if (Number.isFinite(pid) && pid > 0) map.set(label, pid);
  }
  return map;
}

function emptyCounts() {
  return { ok: 0, source_mismatch: 0, path_missing: 0, plist_invalid: 0, process_mismatch: 0 };
}

/**
 * The machine-tier runtime-source doctor check. Pure at the boundary — every host I/O is
 * injectable, so the suite is hermetic and runs in CI without a LaunchAgents directory, a
 * declaration, `launchctl`, or `ps`.
 *
 * @param {object} input
 * @param {string} [input.plistDir]            default `~/Library/LaunchAgents`
 * @param {string} [input.declarationFile]    default `~/.agentbootup/runtime-source.json`
 * @param {string|(() => Promise<string>)} [input.machineId]  default: the persisted
 *        machine UUID read NON-creatingly via `readMachineIdState()` (never `getMachineId()`,
 *        which mints — FR-5 read-only). `null` when no machine id is persisted.
 * @param {object} [input.deps]
 * @param {(dir: string) => Promise<string[]>} [input.deps.readdir]
 * @param {(filePath: string) => Promise<object>} [input.deps.readPlistFile]  default readLaunchAgentPlist
 * @param {(filePath: string) => object} [input.deps.readDeclarationFile]     default readJsonFile
 * @param {(command: string, args: string[]) => Promise<string>} [input.deps.runCommand]  default safeCommandRunner
 * @param {typeof fsp.realpath} [input.deps.realpath]
 * @param {typeof fsp.stat} [input.deps.stat]
 * @param {(file: string) => Promise<object>} [input.deps.readPackage]
 * @param {boolean} [input.deps.includeLiveProcess=true]  skip the launchctl/ps step (pure-plist verdicts)
 * @returns {Promise<object>} a health-record check result:
 *   { state:'pass'|'fail'|'unknown', severity, category:'runtime_source', required:true, message, machine_id,
 *     declaration, total_labels, counts, offending_labels, labels }  where `machine_id` may be `null`
 *     when no machine id is persisted (read-only: never minted).
 */
export async function checkRuntimeSourceMatches(input = {}) {
  const plistDir = input.plistDir ?? DEFAULT_PLIST_DIR();
  const declarationFile = input.declarationFile ?? DEFAULT_DECLARATION_FILE();
  const deps = input.deps ?? {};
  const includeLiveProcess = deps.includeLiveProcess !== false;

  const realpath = deps.realpath ?? fsp.realpath;
  const stat = deps.stat ?? fsp.stat;
  const readPackage = deps.readPackage;
  const rootDeps = { realpath, stat, ...(readPackage ? { readPackage } : {}) };

  // machine_id: the stable UUID from lib/machine-id — READ-ONLY (PRD Task 4.4). Never
  // `os.hostname()`, and never MINT a fresh id: `getMachineId()` creates
  // `~/.agentbootup/machine-id` (and its parent dir) when absent, which would violate this
  // check's read-only contract (FR-5). `readMachineIdState()` reads without creating; a
  // machine with no id reports `machine_id: null` (honest) rather than minting one.
  let machineId = input.machineId;
  if (machineId === undefined) {
    const idState = await readMachineIdState();
    machineId = idState.state === 'ok' ? idState.id : null;
  } else if (typeof machineId === 'function') {
    machineId = await machineId();
  }

  const declaration = await loadDeclaration(declarationFile, deps);

  // Enumerate plists (always — gives total_labels for context even when declaration is unknown).
  const readdir = deps.readdir ?? fsp.readdir;
  let plistNames = [];
  try {
    plistNames = (await readdir(plistDir)).filter(
      (name) => name.startsWith(AGENTBOOTUP_PLIST_PREFIX) && name.endsWith('.plist'),
    );
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // No LaunchAgents directory (e.g. non-macOS, or a fresh host). With a valid
      // declaration that is vacuously `pass`; with no/invalid declaration it stays `unknown`.
      const state = declaration.state === 'ok' ? 'pass' : 'unknown';
      return {
        state,
        severity: state === 'pass' ? 'info' : 'warning',
        category: 'runtime_source',
        required: true,
        message: `runtime_source_matches: no agentbootup LaunchAgents directory at ${plistDir}`,
        machine_id: machineId,
        declaration,
        total_labels: 0,
        counts: emptyCounts(),
        offending_labels: {},
        labels: [],
      };
    }
    // Unreadable / I/O error — cannot enumerate; NEVER a false pass (PRD-0063: unknown, not pass).
    return {
      state: 'unknown',
      severity: 'warning',
      category: 'runtime_source',
      required: true,
      message: `runtime_source_matches: could not enumerate ${plistDir}: ${errMessage(err)}`,
      machine_id: machineId,
      declaration,
      total_labels: 0,
      counts: emptyCounts(),
      offending_labels: {},
      labels: [],
    };
  }
  plistNames.sort();

  // Declaration missing/invalid ⇒ unknown, NEVER pass (PRD-0063 FR-1 / AC-5). We still report
  // total_labels for context but do not compute source-match verdicts (no declared root to
  // compare against); the invariant `sum(verdicts) == total_labels` is only claimed when the
  // declaration is ok (AC-2).
  if (declaration.state !== 'ok') {
    return {
      state: 'unknown',
      severity: 'warning',
      category: 'runtime_source',
      required: true,
      message: `runtime_source_matches: ${declaration.reason} — cannot assess source match for ${plistNames.length} agentbootup LaunchAgent(s)`,
      machine_id: machineId,
      declaration,
      total_labels: plistNames.length,
      counts: emptyCounts(),
      offending_labels: {},
      labels: [],
    };
  }

  const declaredRoot = declaration.root;
  const readPlistFile = deps.readPlistFile ?? ((filePath) => readLaunchAgentPlist(filePath, { readFile: deps.readPlistRaw }));

  // Lazily fetch the live label→PID / pid→argv maps only if a label reaches the
  // process_mismatch check (plist root == declared root). On the main machine that is 1 of
  // 101 labels, so launchctl/ps run at most once each.
  let liveCache = null;
  async function getLive() {
    if (liveCache !== null) return liveCache;
    const runCommand = deps.runCommand ?? safeCommandRunner;
    let labelToPid = new Map();
    let pidToArgv = new Map();
    if (includeLiveProcess) {
      try {
        const lcOut = await runCommand('launchctl', ['list']);
        labelToPid = parseLaunchctlList(lcOut);
      } catch (err) {
        // launchctl unavailable (non-macOS / restricted) ⇒ no process_mismatch evidence; fall
        // through to source-mismatch/ok. NOT a check failure — source match is still assessable.
        liveCache = { labelToPid, pidToArgv, launchctlError: errMessage(err) };
        return liveCache;
      }
      try {
        const psOut = await runCommand('ps', ['-axo', 'pid=,command=']);
        for (const line of psOut.split('\n')) {
          const row = parseProcessLine(line);
          if (row) pidToArgv.set(row.pid, row.argv);
        }
      } catch {
        // ps unavailable ⇒ no argv to compare; process_mismatch cannot fire.
      }
    }
    liveCache = { labelToPid, pidToArgv, launchctlError: null };
    return liveCache;
  }

  const counts = emptyCounts();
  const offendingLabels = {
    plist_invalid: [],
    path_missing: [],
    source_mismatch: [],
    process_mismatch: [],
    ok: [],
  };
  const labels = [];

  for (const name of plistNames) {
    const filePath = path.join(plistDir, name);
    // Belt-and-suspenders: any UNEXPECTED error for one label demotes just that label to
    // plist_invalid (with the error) rather than aborting the whole 101-label check — the
    // same 'one bad label must not take down the other 100' discipline as plist_invalid and
    // the readdir ENOENT-vs-other split. The load-bearing per-label resolution errors are
    // already returned (not thrown) by resolveRuntimeRoot; this catch is the outer guard.
    try {
      const parsed = await readPlistFile(filePath);

      // 1. plist_invalid — unparseable plist or no resolvable script path (must NOT vanish).
      if (parsed && parsed.invalid) {
        recordVerdict(name, 'plist_invalid', { reason: parsed.reason }, labels, counts, offendingLabels);
        continue;
      }
      const resolved = resolveDaemonScriptPath(parsed.programArguments);
      if (!resolved) {
        recordVerdict(
          name,
          'plist_invalid',
          { reason: 'ProgramArguments did not resolve to a daemon script path', programArguments: parsed.programArguments },
          labels,
          counts,
          offendingLabels,
        );
        continue;
      }

      // 2. path_missing — resolved script path does not exist on disk. resolveRuntimeRoot
      //    also returns `unresolved` for a non-ENOENT stat/realpath error (EACCES/ENOTDIR/
      //    ELOOP); demote that ONE label to plist_invalid rather than crashing the check.
      const runtime = await resolveRuntimeRoot(resolved.scriptPath, rootDeps);
      if (runtime.unresolved) {
        recordVerdict(name, 'plist_invalid', { reason: runtime.reason, scriptPath: resolved.scriptPath }, labels, counts, offendingLabels);
        continue;
      }
      if (runtime.missing) {
        recordVerdict(name, 'path_missing', { scriptPath: resolved.scriptPath }, labels, counts, offendingLabels);
        continue;
      }

      // 3. source_mismatch — exists, but its runtime root is not contained by the declared root.
      if (!runtime.root || !isWithin(declaredRoot, runtime.root)) {
        recordVerdict(
          name,
          'source_mismatch',
          { scriptPath: resolved.scriptPath, runtimeRoot: runtime.root, declaredRoot },
          labels,
          counts,
          offendingLabels,
        );
        continue;
      }

      // 4. process_mismatch — the live process's runtime root differs from the plist's. Catches
      //    a daemon still running old code after its plist was corrected (Move 1's mid-rollout).
      const plistRoot = runtime.root;
      const live = await getLive();
      const pid = live.labelToPid.get(parsed.label);
      const liveArgv = pid != null ? live.pidToArgv.get(pid) : undefined;
      let liveRoot = null;
      if (liveArgv) {
        const liveResolved = resolveDaemonScriptPath(liveArgv);
        if (liveResolved) {
          const liveRuntime = await resolveRuntimeRoot(liveResolved.scriptPath, rootDeps);
          if (liveRuntime.unresolved) {
            // Live-process root unresolvable: no process_mismatch evidence (can't compare),
            // and the plist root already matched (ok). Fall through to ok.
          } else if (!liveRuntime.missing) {
            liveRoot = liveRuntime.root;
          }
        }
      }
      if (liveRoot && liveRoot !== plistRoot) {
        recordVerdict(
          name,
          'process_mismatch',
          { scriptPath: resolved.scriptPath, plistRoot, liveRoot, pid },
          labels,
          counts,
          offendingLabels,
        );
        continue;
      }

      // 5. ok.
      recordVerdict(name, 'ok', { scriptPath: resolved.scriptPath, runtimeRoot: runtime.root }, labels, counts, offendingLabels);
    } catch (err) {
      // Outer guard: an unexpected error for this one label demotes it (plist_invalid with
      // the error) instead of aborting the check — so the other labels still report.
      recordVerdict(name, 'plist_invalid', { reason: `unexpected error: ${errMessage(err)}` }, labels, counts, offendingLabels);
    }
  }

  const anyFail = counts.plist_invalid + counts.path_missing + counts.source_mismatch + counts.process_mismatch > 0;
  const state = anyFail ? 'fail' : 'pass';
  const sum = counts.ok + counts.source_mismatch + counts.path_missing + counts.plist_invalid + counts.process_mismatch;
  // The invariant that proves nothing was silently skipped (PRD-0063 AC-2). An internal
  // assertion, not a test: if this ever fails, a verdict branch dropped a label.
  if (sum !== plistNames.length) {
    throw new Error(
      `runtime_source_matches invariant violated: sum(verdicts)=${sum} != total_labels=${plistNames.length}`,
    );
  }

  const message = formatMessage(declaration, counts, plistNames.length);

  return {
    state,
    severity: state === 'pass' ? 'info' : 'error',
    category: 'runtime_source',
    required: true,
    message,
    machine_id: machineId,
    declaration: { state: 'ok', kind: declaration.kind, path: declaration.path, commit: declaration.commit, root: declaration.root },
    total_labels: plistNames.length,
    counts,
    offending_labels: offendingLabels,
    labels,
  };
}

function recordVerdict(name, verdict, details, labels, counts, offendingLabels) {
  counts[verdict] += 1;
  offendingLabels[verdict].push(name);
  labels.push({ label: name, verdict, ...details });
}

function formatMessage(declaration, counts, total) {
  const parts = VERDICTS.filter((v) => counts[v] > 0).map((v) => `${counts[v]} ${v}`);
  const summary = parts.length ? parts.join(', ') : `${total} ok`;
  const decl = `declared ${declaration.kind} @ ${declaration.path}`;
  return `runtime_source_matches: ${summary} (${total} label(s); ${decl})`;
}

/**
 * A runner factory for `aggregateHealthRecord`'s extra-runner path (PRD-0063 Task 4.3).
 * Registers the check as `runtime_source_matches` WITHOUT modifying `CHECK_NAMES`:
 *   aggregateHealthRecord({ runners: { runtime_source_matches: runtimeSourceRunner(deps) }, ... })
 * @returns {() => Promise<object>}
 */
export function runtimeSourceRunner(input = {}) {
  return async () => checkRuntimeSourceMatches(input);
}