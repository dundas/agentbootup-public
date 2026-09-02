import { describe, expect, test, afterEach } from 'bun:test';
import { checkIdentityTrackingPolicy, IDENTITY_POLICY_CATEGORY } from '../../lib/doctor/identity-policy-check.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoots = [];
afterEach(() => { for (const r of tmpRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'id-pol-')); tmpRoots.push(d); return d; }

// Fake git: a map of relPath -> tracked?. execGit returns stdout = the path if tracked.
function fakeGit(trackedMap) {
  return (args, opts) => {
    // match `git ls-files -- <path>`: args = ['ls-files', '--', '<path>']
    const rel = args[args.length - 1];
    if (rel in trackedMap) return { stdout: trackedMap[rel] ? `${rel}\n` : '', status: 0 };
    return { stdout: '', status: 0 };
  };
}
function fakeGitUnavailable() {
  return () => ({ error: new Error('git not found'), stdout: '', status: 1 });
}
function exists(files) {
  return (p) => files.has(p);
}

describe('identity-policy check — advisory severity (never fail)', () => {
  test('compliant: agentbootup.json tracked, brain/config.json gitignored → no issues', () => {
    const root = tmp();
    const files = new Set([`${root}/agentbootup.json`, `${root}/brain/config.json`]);
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGit({ 'agentbootup.json': true, 'brain/config.json': false }),
    });
    expect(issues).toEqual([]);
  });

  test('drift: brain/config.json tracked in git → WARNING (advisory, not error)', () => {
    const root = tmp();
    const files = new Set([`${root}/agentbootup.json`, `${root}/brain/config.json`]);
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGit({ 'agentbootup.json': true, 'brain/config.json': true }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].category).toBe(IDENTITY_POLICY_CATEGORY);
    expect(issues[0].message).toMatch(/brain\/config\.json.*tracked.*gitignored/i);
  });

  test('drift: tracked-but-deleted brain/config.json still warns from the Git index', () => {
    const root = tmp();
    const files = new Set([`${root}/agentbootup.json`]);
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGit({ 'agentbootup.json': true, 'brain/config.json': true }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toMatch(/brain\/config\.json.*tracked/i);
  });

  test('drift: agentbootup.json missing → WARNING', () => {
    const root = tmp();
    const files = new Set([`${root}/brain/config.json`]);
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGit({ 'brain/config.json': false }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toMatch(/agentbootup\.json is missing/i);
  });

  test('drift: tracked-but-deleted agentbootup.json warns with restore guidance', () => {
    const root = tmp();
    const files = new Set();
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGit({ 'agentbootup.json': true, 'brain/config.json': false }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toMatch(/tracked.*missing.*worktree.*restore/i);
  });

  test('drift: agentbootup.json exists but untracked → WARNING', () => {
    const root = tmp();
    const files = new Set([`${root}/agentbootup.json`]);
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGit({ 'agentbootup.json': false }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toMatch(/agentbootup\.json.*not tracked/i);
  });

  test('both drifts surface as two separate advisory warnings', () => {
    const root = tmp();
    const files = new Set([`${root}/agentbootup.json`, `${root}/brain/config.json`]);
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGit({ 'agentbootup.json': false, 'brain/config.json': true }),
    });
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  test('git unavailable → no issues (unverifiable is not a violation; never fail)', () => {
    const root = tmp();
    const files = new Set([`${root}/agentbootup.json`, `${root}/brain/config.json`]);
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGitUnavailable(),
    });
    // agentbootup.json exists (no "missing" warning); tracking unverifiable → skip. No issues.
    expect(issues).toEqual([]);
  });

  test('outside a git repo (non-zero ls-files status, empty stdout) → skip, no false "not tracked" warning', () => {
    const root = tmp();
    const files = new Set([`${root}/agentbootup.json`, `${root}/brain/config.json`]);
    // `git ls-files` outside a repo returns status=128, empty stdout. Must NOT warn "not tracked".
    const notARepo = () => ({ stdout: '', status: 128 });
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: notARepo,
    });
    // agentbootup.json exists (no "missing"); tracking unverifiable → skip. brain/config.json unverifiable → skip.
    expect(issues).toEqual([]);
  });

  test('no brain/config.json present → no issue (absent is compliant with the new policy)', () => {
    const root = tmp();
    const files = new Set([`${root}/agentbootup.json`]);
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGit({ 'agentbootup.json': true }),
    });
    expect(issues).toEqual([]);
  });

  test('no projectRoot → empty (defensive)', () => {
    expect(checkIdentityTrackingPolicy({})).toEqual([]);
    expect(checkIdentityTrackingPolicy()).toEqual([]);
  });

  test('all issues are advisory: severity is never "error" (enforcement deferred)', () => {
    const root = tmp();
    const files = new Set([`${root}/agentbootup.json`, `${root}/brain/config.json`]);
    const issues = checkIdentityTrackingPolicy({
      projectRoot: root,
      existsFile: exists(files),
      execGit: fakeGit({ 'agentbootup.json': false, 'brain/config.json': true }),
    });
    expect(issues.every((i) => i.severity !== 'error')).toBe(true);
  });
});
