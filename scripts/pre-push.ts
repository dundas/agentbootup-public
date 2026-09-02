#!/usr/bin/env bun
/**
 * SO-6 pre-push gate: semgrep (--config=auto) on changed paths + roborev (unless skipped).
 * Fails closed if required tools are missing (no silent partial checks).
 *
 * Env:
 *   MECH_SKIP_ROBOREV=1  — run semgrep only (still requires semgrep unless allow-missing).
 *   MECH_PRE_PUSH_ALLOW_MISSING_TOOLS=1 — warn and exit 0 if semgrep/roborev absent (CI escape hatch only).
 */

import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

function haveCmd(name: string): boolean {
  const r = spawnSync('command', ['-v', name], { shell: true, encoding: 'utf8' });
  return r.status === 0;
}

function gitMaybe(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) return '';
  return (r.stdout ?? '').trim();
}

/** Files differing from remote push ref, else merge-base with @{u}, else last commit + working tree. */
function getScanPaths(repoRoot: string): string[] {
  const files = new Set<string>();
  const addLines = (s: string) => {
    for (const line of s.split('\n')) {
      const f = line.trim();
      if (f) files.add(f);
    }
  };

  const pushRef = gitMaybe(['rev-parse', '@{push}']);
  const head = gitMaybe(['rev-parse', 'HEAD']);
  if (pushRef && head) {
    const mb = gitMaybe(['merge-base', pushRef, head]);
    if (mb) addLines(gitMaybe(['diff', '--name-only', `${mb}...HEAD`]));
  }

  if (files.size === 0) {
    const mb = gitMaybe(['merge-base', 'HEAD', '@{upstream}']);
    if (mb) addLines(gitMaybe(['diff', '--name-only', `${mb}...HEAD`]));
  }

  if (files.size === 0) {
    addLines(gitMaybe(['diff', '--name-only', 'HEAD~1..HEAD']));
  }

  addLines(gitMaybe(['diff', '--name-only', '--cached']));
  addLines(gitMaybe(['diff', '--name-only', 'HEAD']));

  const out: string[] = [];
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(repoRoot, f);
    if (existsSync(abs) && !f.startsWith('node_modules/') && !f.startsWith('.git/')) {
      out.push(f);
    }
  }
  return [...new Set(out)].sort();
}

interface SemgrepJson {
  results?: Array<{
    check_id?: string;
    path?: string;
    start?: { line?: number };
    extra?: { metadata?: { category?: string; [k: string]: unknown } };
  }>;
}

/**
 * Semgrep finding that should block push. Do not match on the substring "security" in
 * `javascript.lang.security.audit.*` — that is the rule namespace, not proof of a secret leak.
 */
function isSecurityFinding(r: NonNullable<SemgrepJson['results']>[0]): boolean {
  const cat = r.extra?.metadata?.category;
  if (cat === 'security') return true;
  const id = (r.check_id ?? '').toLowerCase();
  return id.includes('secret') || id.includes('owasp');
}

/** Audit rules that are often false positives on reviewed code — WARN only (SO-6: secrets BLOCK, other WARN). */
function isSemgrepAuditNoise(r: NonNullable<SemgrepJson['results']>[0]): boolean {
  const id = (r.check_id ?? '').toLowerCase();
  return id.includes('path-join-resolve-traversal') || id.includes('spawn-shell-true');
}

function isBlockingSemgrepFinding(r: NonNullable<SemgrepJson['results']>[0]): boolean {
  return isSecurityFinding(r) && !isSemgrepAuditNoise(r);
}

function main(): void {
  const allowMissing = process.env.MECH_PRE_PUSH_ALLOW_MISSING_TOOLS === '1';
  const skipRoborev = process.env.MECH_SKIP_ROBOREV === '1';
  const roborevModel = process.env.MECH_ROBOREV_MODEL || 'claude-sonnet-5';
  const roborevReasoning = process.env.MECH_ROBOREV_REASONING || 'medium';

  // Resolve the repository from the caller's working directory so a shared
  // hook also reviews the correct isolated git worktree.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = gitMaybe(['rev-parse', '--show-toplevel']) || path.resolve(path.join(scriptDir, '..'));
  process.chdir(repoRoot);

  const semgrepOk = haveCmd('semgrep');
  const roborevOk = haveCmd('roborev');

  if (!semgrepOk) {
    console.error('pre-push: semgrep not found (pipx install semgrep)');
    if (!allowMissing) process.exit(1);
    console.error('pre-push: MECH_PRE_PUSH_ALLOW_MISSING_TOOLS=1 — continuing without semgrep');
  }

  if (!skipRoborev && !roborevOk) {
    console.error('pre-push: roborev not found (npm i -g roborev). Set MECH_SKIP_ROBOREV=1 to skip AI review.');
    if (!allowMissing) process.exit(1);
    console.error('pre-push: MECH_PRE_PUSH_ALLOW_MISSING_TOOLS=1 — continuing without roborev');
  }

  const paths = getScanPaths(repoRoot);
  if (paths.length === 0) {
    console.error('pre-push: no tracked file changes to scan — OK (semgrep skipped)');
  } else if (semgrepOk) {
    const tmp = `/tmp/semgrep-pre-push-${process.pid}.json`;
    const scan = spawnSync('semgrep', ['scan', '--config=auto', '--json', '-o', tmp, ...paths], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (scan.status !== 0 && scan.status !== 1) {
      console.error(scan.stderr || scan.stdout || 'semgrep failed');
      process.exit(1);
    }
    let data: SemgrepJson = {};
    try {
      data = JSON.parse(readFileSync(tmp, 'utf8')) as SemgrepJson;
    } catch {
      console.error('pre-push: could not read semgrep JSON');
      process.exit(1);
    }

    const results = data.results ?? [];
    const blocking = results.filter(isBlockingSemgrepFinding);
    const auditNoise = results.filter((r) => isSecurityFinding(r) && isSemgrepAuditNoise(r));
    if (blocking.length > 0) {
      console.error(`pre-push: BLOCK — semgrep blocking findings: ${blocking.length}`);
      for (const r of blocking) {
        console.error(`  - ${r.check_id ?? '?'} ${r.path}:${r.start?.line ?? '?'}`);
      }
      process.exit(1);
    }
    if (auditNoise.length > 0) {
      console.error(
        `pre-push: WARN — semgrep audit rules (non-blocking): ${auditNoise.length} — review path.join / spawn usage`,
      );
      for (const r of auditNoise.slice(0, 15)) {
        console.error(`  - ${r.check_id ?? '?'} ${r.path}:${r.start?.line ?? '?'}`);
      }
      if (auditNoise.length > 15) console.error(`  ... and ${auditNoise.length - 15} more`);
    }
    const nonSecurity = results.filter((r) => !isSecurityFinding(r));
    if (nonSecurity.length > 0) {
      console.error(`pre-push: WARN — semgrep non-security findings: ${nonSecurity.length} (review before merge)`);
      for (const r of nonSecurity.slice(0, 20)) {
        console.error(`  - ${r.check_id ?? '?'} ${r.path}:${r.start?.line ?? '?'}`);
      }
      if (nonSecurity.length > 20) console.error(`  ... and ${nonSecurity.length - 20} more`);
    } else if (results.length === 0) {
      console.error('pre-push: semgrep — no findings');
    } else if (auditNoise.length === results.length) {
      console.error('pre-push: semgrep — only non-blocking audit noise (see WARN above)');
    }
  }

  if (!skipRoborev && roborevOk) {
    console.error(`pre-push: running roborev review HEAD with claude-code (${roborevModel}, ${roborevReasoning}) …`);
    const rr = spawnSync('roborev', ['review', 'HEAD', '--agent', 'claude-code', '--model', roborevModel, '--reasoning', roborevReasoning, '--wait'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env },
    });
    const out = `${rr.stdout ?? ''}${rr.stderr ?? ''}`;
    if (rr.status !== 0) {
      console.error('pre-push: BLOCK — roborev exited non-zero');
      console.error(out);
      process.exit(1);
    }
    console.error('pre-push: roborev — clean');
  } else if (skipRoborev) {
    console.error('pre-push: roborev skipped (MECH_SKIP_ROBOREV=1)');
  }

  console.log(
    JSON.stringify({
      status: 'passed',
      scanned_files: paths.length,
      semgrep: semgrepOk ? 'ran' : allowMissing ? 'skipped' : 'n/a',
      roborev: skipRoborev ? 'skipped' : roborevOk ? 'ran' : allowMissing ? 'skipped' : 'n/a',
    }),
  );
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
