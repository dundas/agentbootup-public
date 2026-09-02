/**
 * FR-1 `runtime_resolves` check + install-verify (PRD-0038 Task 3).
 *
 * Two fail-closed capabilities, both emitting a health-record check result:
 *  - checkRuntimeResolves: agent-host `GET /agents/:id/readyz` reports ready AND the
 *    runtime lease actually answers (don't trust `chat_ready` — probe it).
 *  - verifyRuntimeInstall: a distributed runtime is genuinely runnable — the manifest
 *    declares it, `--help` runs, and the empty-env `--read-only` smoke exits 10. Closes
 *    the "provisioned ≠ runnable" class (Bug sh49xw): missing/empty/non-runnable = fail.
 *    SCOPE: this proves the runtime RUNS and FAILS CLOSED on empty env — it does NOT
 *    prove `--read-only` avoids out-of-repo writes. Write-safety is the conformance
 *    gate's job (Task 6.3 `inbox-read-only-no-write`); do not over-trust install-verify.
 *
 * Both readyz/probe/run are injectable so the check is exercised mock-first without a
 * live agent-host or a real runtime process.
 */

import fs from 'fs';
import path from 'path';
import {
  isRuntimeFileEntry,
  isVersionInstalled,
  loadBundleManifest,
  readBundleInstallState,
  verifyRequiredTargets,
} from '../bundle/installer.js';

function fail(category, message) {
  return { state: 'fail', severity: 'error', category, message };
}
function pass(category, message) {
  return { state: 'pass', severity: 'info', category, message };
}
// Source-unreachable / could-not-determine → `unknown` (the reducer maps required-unknown to
// Degraded, never Stuck). This is the PRD-0039 FR-3 contract: a probe that THREW or was not
// wired is an infra/wiring condition, NOT proven-bad — only a probe that ANSWERED with a bad
// result is a `fail`. Mirrors the already-correct identity-check.js (registry-unreachable →
// unknown). Getting this wrong false-Stucks the whole fleet on any agent-host blip.
function unknown(category, message) {
  return { state: 'unknown', severity: 'warning', category, message };
}
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function discoverDoctorBundleManifestPaths(repoRoot) {
  // nosemgrep: path-join-resolve-traversal -- repoRoot is the operator-selected repo checkout being audited by doctor; the joined locations are fixed canonical manifest paths beneath it.
  const manifests = [];
  // nosemgrep: path-join-resolve-traversal -- fixed canonical skills root under the audited repo root.
  const skillsDir = path.join(repoRoot, '.claude', 'skills');
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // nosemgrep: path-join-resolve-traversal -- entry.name comes from readdirSync on the canonical skills dir, so this only addresses direct child skill directories in the current repo.
    const manifestPath = path.join(skillsDir, entry.name, 'skill-bundle-manifest.json');
    if (fs.existsSync(manifestPath)) manifests.push(manifestPath);
  }

  // nosemgrep: path-join-resolve-traversal -- fixed canonical protocol manifest path under the audited repo root.
  const canonicalProtocolManifest = path.join(repoRoot, '.ai', 'protocols', 'protocol-bundle-manifest.json');
  if (fs.existsSync(canonicalProtocolManifest)) manifests.push(canonicalProtocolManifest);

  return manifests.sort((a, b) => a.localeCompare(b));
}

/**
 * FR-1 runtime resolves: readyz ready + the lease actually answers.
 * @param {object} input
 * @param {() => Promise<{ok?: boolean, runtimeTarget?: string, runtimeSource?: string}>} input.readyz
 * @param {() => Promise<boolean>} input.probeLease  Does the runtime_address actually answer?
 * @returns {Promise<{state:'pass'|'fail'|'unknown', severity, category:'runtime', message:string}>}
 *   `unknown` when the source is unreachable (probe threw / missing accessor) — PRD-0039 FR-3.
 */
export async function checkRuntimeResolves(input = {}) {
  const { readyz, probeLease } = input;
  // Missing accessor = we cannot reach the source to determine anything → unknown (not a
  // proven failure). Same discipline as identity-check's missing-fetchRegistry → unknown.
  if (typeof readyz !== 'function') return unknown('runtime', 'no readyz probe provided — cannot resolve runtime');
  if (typeof probeLease !== 'function') return unknown('runtime', 'no lease probe provided — cannot confirm the runtime answers');

  let ready;
  try {
    ready = await readyz();
  } catch (err) {
    // agent-host unreachable (throw) → infra blip, not proven-dead runtime → unknown.
    return unknown('runtime', `readyz probe unreachable: ${errMessage(err)}`);
  }
  if (!ready || ready.ok !== true) {
    // readyz ANSWERED and said not-ready → proven not-ready → fail (→ Stuck).
    return fail('runtime', `agent-host readyz not ready${ready?.runtimeSource ? ` (source: ${ready.runtimeSource})` : ''}`);
  }

  // Don't trust readyz alone — confirm the resolved runtime address actually answers.
  let answers;
  try {
    answers = await probeLease();
  } catch (err) {
    // Probe could not reach the runtime address (throw) → unknown, not fail.
    return unknown('runtime', `runtime lease probe unreachable: ${errMessage(err)}`);
  }
  if (answers !== true) {
    // Probe ANSWERED false → runtime address resolved but is dead → proven fail (→ Stuck).
    return fail('runtime', 'runtime address resolved but did not answer (lease present, runtime dead)');
  }
  return pass('runtime', `runtime resolves and answers${ready.runtimeSource ? ` (source: ${ready.runtimeSource})` : ''}`);
}

/**
 * Install-verify a distributed runtime is genuinely runnable (FR-1 / Bug sh49xw).
 * @param {object} input
 * @param {{files?: Array<{target?: string, role?: string, required?: boolean}>}} input.manifest
 * @param {string} input.runtimePath  Expected runtime target path, e.g. brain/scripts/<skill>.ts
 * @param {(args: string[], opts: {emptyEnv?: boolean}) => Promise<{code: number}>} input.run
 *        Runs the installed runtime; injectable (live = spawn `bun <runtimePath> <args>`).
 * @param {number} [input.expectedReadOnlyExit]  Exit code the empty-env --read-only smoke must return (default 10).
 * @returns {Promise<{state:'pass'|'fail', severity, category:'install', message:string}>}
 */
export async function verifyRuntimeInstall(input = {}) {
  const { manifest, runtimePath, run, expectedReadOnlyExit = 10 } = input;
  if (!runtimePath) return fail('install', 'no runtimePath provided');
  if (typeof run !== 'function') return fail('install', 'no run() provided — cannot verify the runtime executes');

  // 1. The manifest must DECLARE this runtime (provisioned ≠ runnable — Bug sh49xw).
  // Match on the widened runtime taxonomy: fleet manifests use five kind/role combos
  // (repo|runtime, runtime|null, runtime|canonical-runtime, script|runtime,
  // runtime|runtime-library); the old role === 'runtime' match skipped most of them.
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const declared = files.find((f) => f && isRuntimeFileEntry(f) && f.target === runtimePath);
  if (!declared) {
    return fail('install', `runtime '${runtimePath}' is not declared as a runtime file in the manifest`);
  }

  // 2. --help must run cleanly (exit 0) under EMPTY env — help must never require creds;
  //    running it empty-env catches runtimes that incorrectly gate help behind env.
  let help;
  try {
    help = await run(['--help'], { emptyEnv: true });
  } catch (err) {
    return fail('install', `runtime '${runtimePath}' --help did not execute: ${errMessage(err)}`);
  }
  if (!help || help.code !== 0) {
    return fail('install', `runtime '${runtimePath}' --help exited ${help ? help.code : 'no-result'} (expected 0)`);
  }

  // 3. The empty-env --read-only smoke must exit with the credential-missing code (10),
  //    proving the runtime fails closed on missing env rather than silently "working".
  let smoke;
  try {
    smoke = await run(['--read-only'], { emptyEnv: true });
  } catch (err) {
    return fail('install', `runtime '${runtimePath}' empty-env --read-only did not execute: ${errMessage(err)}`);
  }
  if (!smoke || smoke.code !== expectedReadOnlyExit) {
    return fail('install', `runtime '${runtimePath}' empty-env --read-only exited ${smoke ? smoke.code : 'no-result'} (expected ${expectedReadOnlyExit})`);
  }

  return pass('install', `runtime '${runtimePath}' is declared, runnable, and fails closed on empty env`);
}

/**
 * Offline bundle-target integrity sweep for `agentbootup doctor`. For every
 * canonical installed skill or protocol bundle manifest in the repo, verify the
 * required target files actually exist on disk. The install ledger records that
 * a bundle was applied — it says nothing about whether the payload survived
 * (untracked runtime files are one destructive `git clean` away from silent
 * erosion while the ledger keeps claiming success). Pure fs, no network, no
 * subprocess.
 *
 * @param {string} [repoRoot]
 * @returns {Array<{severity: string, message: string}>} doctor-style issues
 */
export function checkBundleTargetIntegrity(repoRoot = process.cwd()) {
  const issues = [];
  const manifestPaths = discoverDoctorBundleManifestPaths(repoRoot);
  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      ({ manifest } = loadBundleManifest(manifestPath));
    } catch (err) {
      issues.push({
        severity: 'warning',
        message: `bundle manifest unreadable: ${manifestPath} (${err instanceof Error ? err.message : String(err)})`,
      });
      continue;
    }
    const result = verifyRequiredTargets(manifest, repoRoot);
    if (result.ok) continue;

    const rel = path.relative(repoRoot, manifestPath);
    const missing = result.missing.map((m) => m.target).join(', ');
    const runtimeNote = result.missing.some((m) => m.runtime) ? ' (includes runtime payload)' : '';

    // Missing targets mean two different things, and conflating them sends a debugger
    // hunting a destructive clean that never happened:
    //  - the ledger records this version as installed  -> the payload eroded (error)
    //  - no ledger entry for this version              -> it was never installed here,
    //    e.g. a wholesale copy of .claude/skills/ that produced wrappers pointing at
    //    nothing. Actionable, but not erosion.
    //  - the ledger cannot be read                    -> we do not know which of the two
    //    this is; say so rather than guessing (a corrupt ledger silently reading as
    //    "never installed" would send the operator to a remedy that cannot work).
    let state = null;
    try {
      state = readBundleInstallState(manifest, repoRoot);
    } catch (err) {
      issues.push({
        severity: 'error',
        message:
          `bundle ${manifest.bundle_name}: required target file(s) absent${runtimeNote} (${missing}), ` +
          `and the install ledger is unreadable (${err instanceof Error ? err.message : String(err)}) — ` +
          `cannot tell erosion from never-installed. Repair or remove the ledger entry, then re-run: ` +
          `agentbootup bundle install --manifest ${rel}`,
      });
      continue;
    }

    if (isVersionInstalled(state, manifest)) {
      issues.push({
        severity: 'error',
        message:
          `bundle ${manifest.bundle_name}: required target file(s) missing${runtimeNote}: ${missing} — ` +
          `ledger records this version as installed, so the payload eroded. ` +
          `Repair with: agentbootup bundle install --manifest ${rel} --force`,
      });
    } else {
      issues.push({
        severity: 'warning',
        message:
          `bundle ${manifest.bundle_name}: declared but never installed here (no ledger entry for ${manifest.version_id}); ` +
          `required target file(s) absent${runtimeNote}: ${missing} — ` +
          `install with: agentbootup bundle install --manifest ${rel}`,
      });
    }
  }
  return issues;
}
