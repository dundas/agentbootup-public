/**
 * Where is this checkout's git directory?
 *
 * This is a shared helper because `.git` being a FILE rather than a directory has
 * now bitten twice in one change set:
 *
 *   1. `runtime-manifest.js` resolved provenance by reading `.git/HEAD`, which
 *      returned null in every linked worktree — the environment this repo is
 *      actually developed in.
 *   2. `canonical-write.js` then placed its isolated worktree at
 *      `<root>/.git/agentbootup-canonical-write`, which cannot exist when `.git` is
 *      a file, breaking canonical writes for exactly the multi-checkout workflow
 *      the feature exists to support.
 *
 * Knowing about a trap does not confer immunity to it. One helper, asked once.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 10_000;

function git(args, cwd) {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_CONFIG_GLOBAL: undefined },
  });
  if (proc.status !== 0) return null;
  const out = (proc.stdout || '').trim();
  return out || null;
}

/**
 * The git directory for `root`, following the `gitdir:` pointer that a linked
 * worktree writes into `.git`. Returns null when there is no git directory.
 *
 * Filesystem-only: usable when `git` is unavailable, and never shells out.
 */
export function resolveGitDir(root) {
  const dotGit = path.join(root, '.git'); // nosemgrep: path-join-resolve-traversal -- root is a caller-supplied checkout root and ".git" is a literal
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  let pointer;
  try {
    pointer = fs.readFileSync(dotGit, 'utf8').trim();
  } catch {
    return null;
  }
  if (!pointer.startsWith('gitdir:')) return null;
  const target = pointer.slice('gitdir:'.length).trim();
  if (!target) return null;
  return path.isAbsolute(target) ? target : path.resolve(root, target); // nosemgrep: path-join-resolve-traversal -- a linked worktree's gitdir legitimately points outside the checkout
}

/**
 * The shared git directory — where refs and packed-refs live. For a linked
 * worktree this differs from its own git dir.
 */
export function resolveGitCommonDir(root) {
  const gitDir = resolveGitDir(root);
  if (!gitDir) return null;
  try {
    const value = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim(); // nosemgrep: path-join-resolve-traversal -- gitDir is resolved above; "commondir" is a literal
    if (value) return path.resolve(gitDir, value); // nosemgrep: path-join-resolve-traversal -- git's own commondir pointer legitimately points outside the worktree git dir
  } catch {
    // No commondir file means this IS the common dir.
  }
  return gitDir;
}

/**
 * A directory AgentBootup may create scratch worktrees under.
 *
 * Asks git first, because git knows where its own metadata lives regardless of how
 * this checkout was created. Falls back to the filesystem answer so a missing `git`
 * binary degrades rather than breaks.
 */
export function resolveWorktreeParent(root) {
  const fromGit = git(['rev-parse', '--git-common-dir'], root);
  if (fromGit) return path.isAbsolute(fromGit) ? fromGit : path.resolve(root, fromGit); // nosemgrep: path-join-resolve-traversal -- git's own answer about its metadata location
  return resolveGitCommonDir(root);
}
