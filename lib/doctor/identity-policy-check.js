/**
 * Advisory identity-tracking policy check (secrets transport work order, decision #3:
 * "agentbootup.json is the tracked canonical repo/fleet identity manifest; brain/config.json
 * is ignored runtime-local brain state restored by AgentBootup. Publish the policy and add a
 * fleet doctor check, but do not enforce fleet-wide until secrets transport is live-verified.")
 *
 * This check is DELIBERATELY ADVISORY: it surfaces drift from the policy as a `warning`, never
 * an `error`. It must not fail the doctor or block fleet operations — enforcement is deferred
 * until the secrets transport contract is live-verified. See docs/BRAIN_IDENTITY_POLICY.md.
 *
 * Drift it surfaces:
 *  - `brain/config.json` is tracked in git → should be gitignored (runtime-local state).
 *  - `agentbootup.json` is missing or not tracked in git → should be the committed identity.
 *
 * Pure + injectable: `execGit` and `existsFile` are seams so the policy logic is hermetically
 * testable without a real git repo. Degrades to no-issue (skip) when git is unavailable or the
 * project is not a git repo — an absent tool/repo is not a policy violation.
 */

import fs from 'fs';
import { spawnSync } from 'child_process';

/** @typedef {{ severity: 'warning'|'info', category: string, message: string }} Issue */

export const IDENTITY_POLICY_CATEGORY = 'identity-policy';

function result(severity, message) {
  return { severity, category: IDENTITY_POLICY_CATEGORY, message };
}

/**
 * Is `relPath` tracked in git? Returns true/false, or null if git is unavailable / not a repo.
 * @param {string} projectRoot
 * @param {string} relPath
 * @param {(args: string[], opts: {cwd: string}) => {stdout: string, status: number, error?: Error}} execGit
 * @returns {boolean | null}
 */
function isGitTracked(projectRoot, relPath, execGit) {
  try {
    // `git ls-files -- <path>` lists the path iff it is tracked; empty stdout = untracked.
    // A non-zero exit (e.g. outside a git repo) means unverifiable — return null so the
    // caller skips rather than false-warning (an absent repo is not a policy violation).
    const r = execGit(['ls-files', '--', relPath], { cwd: projectRoot });
    if (r.error || (typeof r.status === 'number' && r.status !== 0)) return null;
    return typeof r.stdout === 'string' && r.stdout.trim() !== '';
  } catch {
    return null;
  }
}

/**
 * Advisory check: does the project's identity tracking match the canonical policy?
 * @param {{ projectRoot: string, execGit?: Function, existsFile?: Function }} input
 * @returns {Issue[]} advisory issues (warning = drift; empty = compliant or unverifiable)
 */
export function checkIdentityTrackingPolicy(input = {}) {
  const { projectRoot } = input;
  if (!projectRoot || typeof projectRoot !== 'string') return [];
  const existsFile = input.existsFile ?? ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const execGit = input.execGit ?? ((args, opts) => {
    try {
      return spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8' });
    } catch (e) {
      return { error: e, stdout: '', status: 1 };
    }
  });

  const issues = [];
  const agentbootupPath = `${projectRoot}/agentbootup.json`;
  const brainConfigRel = 'brain/config.json';

  // 1. agentbootup.json should be present AND tracked in git (the committed canonical identity).
  const agentbootupExists = existsFile(agentbootupPath);
  if (!agentbootupExists) {
    const tracked = isGitTracked(projectRoot, 'agentbootup.json', execGit);
    if (tracked === true) {
      issues.push(result('warning', 'identity-policy: agentbootup.json is tracked in git but missing from the worktree — restore it before using this checkout as canonical identity (see docs/BRAIN_IDENTITY_POLICY.md)'));
    } else if (tracked === false) {
      issues.push(result('warning', 'identity-policy: agentbootup.json is missing — it should be the committed canonical brain identity manifest (see docs/BRAIN_IDENTITY_POLICY.md)'));
    }
    // tracked === null (git unavailable): skip — unverifiable is not a violation.
  } else {
    const tracked = isGitTracked(projectRoot, 'agentbootup.json', execGit);
    if (tracked === false) {
      issues.push(result('warning', 'identity-policy: agentbootup.json exists but is not tracked in git — it should be committed as the canonical brain identity (see docs/BRAIN_IDENTITY_POLICY.md)'));
    }
    // tracked === null (git unavailable): skip — unverifiable is not a violation.
  }

  // 2. brain/config.json should be gitignored runtime-local state. If it is tracked in git,
  //    that is drift from the policy (advisory — enforcement deferred until secrets transport
  //    is live-verified). Consult the Git index even if the worktree copy was
  //    manually deleted: tracked-but-deleted is a half-migration that must remain
  //    visible. An absent untracked path remains compliant.
  const tracked = isGitTracked(projectRoot, brainConfigRel, execGit);
  if (tracked === true) {
    issues.push(result('warning', `identity-policy: ${brainConfigRel} is tracked in git — it should be gitignored runtime-local state restored by AgentBootup (enforcement deferred until secrets transport is live-verified; see docs/BRAIN_IDENTITY_POLICY.md)`));
  }
  // tracked === false → compliant. tracked === null → unverifiable, skip.

  return issues;
}
