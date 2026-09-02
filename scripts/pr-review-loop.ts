#!/usr/bin/env bun
/**
 * Mechanical companion for `.claude/skills/pr-review-loop` — prints manifest/pipeline/remind
 * and shells out to `gh` for PR-scoped commands. Judgment steps stay in skills (adversarial, pre-push).
 *
 * Usage:
 *   bun scripts/pr-review-loop.ts manifest [--json]
 *   bun scripts/pr-review-loop.ts pipeline
 *   bun scripts/pr-review-loop.ts reference [--json]
 *   bun scripts/pr-review-loop.ts remind
 *   bun scripts/pr-review-loop.ts <PR> status|fetch|diff|watch|init|sync|poll-reviews [...]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(path.join(scriptDir, '..'));
const skillDir = path.join(repoRoot, '.claude/skills/pr-review-loop');
const checkpointDir = path.join(repoRoot, '.pr-review-loop');

function gh(args: string[], json = false): { ok: boolean; out: string; err: string } {
  const r = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    cwd: repoRoot,
  });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function printHelp(): void {
  console.log(`pr-review-loop — gh helpers + skill artifacts

  bun scripts/pr-review-loop.ts manifest [--json]
  bun scripts/pr-review-loop.ts pipeline
  bun scripts/pr-review-loop.ts reference [--json]
  bun scripts/pr-review-loop.ts remind
  bun scripts/pr-review-loop.ts <PR> status | fetch | diff | watch | remind
`);
}

function readSkillFile(name: string): string {
  const p = path.join(skillDir, name);
  if (!existsSync(p)) {
    console.error(`pr-review-loop: missing ${p}`);
    process.exit(1);
  }
  return readFileSync(p, 'utf8');
}

function cmdRemind(): void {
  const p = path.join(repoRoot, '.ai', 'code-reviewers.json');
  const ref = path.join(skillDir, 'references', 'code-reviewers.json');
  const src = existsSync(p) ? readFileSync(p, 'utf8') : existsSync(ref) ? readFileSync(ref, 'utf8') : '{}';
  const j = JSON.parse(src) as {
    solicit_review?: { reviewers?: Array<{ mention?: string; command?: string }> };
  };
  const lines =
    j.solicit_review?.reviewers
      ?.map((r) => (r.mention && r.command ? `${r.mention} ${r.command}` : r.mention ?? ''))
      .filter(Boolean) ?? [];
  if (lines.length === 0) {
    console.log('(no reviewers in .ai/code-reviewers.json)');
    return;
  }
  console.log('Paste on PR when soliciting review:\n');
  for (const line of lines) console.log(line);
}

function cmdPr(pr: string, sub: string, rest: string[]): void {
  const { out, err, ok } = (() => {
    switch (sub) {
      case 'status':
        return gh([
          'pr',
          'view',
          pr,
          '--json',
          'number,state,title,headRefName,baseRefName,mergeable,mergeStateStatus,url',
        ]);
      case 'fetch': {
        const r = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
          encoding: 'utf8',
          cwd: repoRoot,
        });
        const ownerRepo = (r.stdout ?? '').trim();
        if (!ownerRepo || r.status !== 0) {
          return { out: '', err: 'gh repo view failed — is gh authenticated?', ok: false };
        }
        const reviews = gh(['api', `repos/${ownerRepo}/pulls/${pr}/reviews`]);
        const comments = gh(['api', `repos/${ownerRepo}/pulls/${pr}/comments`]);
        const issueComments = gh(['pr', 'view', pr, '--json', 'comments']);
        const body = [
          '=== reviews ===',
          reviews.out || reviews.err,
          '\n=== review comments (inline) ===',
          comments.out || comments.err,
          '\n=== issue comments ===',
          issueComments.out || issueComments.err,
        ].join('\n');
        return { out: body, err: '', ok: reviews.ok && comments.ok && issueComments.ok };
      }
      case 'diff':
        return gh(['pr', 'diff', pr, ...rest.filter((x) => x !== '-o')]);
      case 'watch':
        return gh(['pr', 'checks', pr, '--watch', ...rest]);
      case 'init': {
        if (!existsSync(checkpointDir)) mkdirSync(checkpointDir, { recursive: true });
        const f = path.join(checkpointDir, `pr-${pr}.json`);
        writeFileSync(
          f,
          JSON.stringify({ pr, created: new Date().toISOString(), note: 'update via sync' }, null, 2),
        );
        return { out: `checkpoint: ${f}\n`, err: '', ok: true };
      }
      case 'sync':
        return { out: 'sync: re-run fetch and merge state locally (minimal stub — use fetch)\n', err: '', ok: true };
      case 'poll-reviews':
        return gh(['pr', 'checks', pr]);
      default:
        return { out: '', err: `unknown subcommand: ${sub}`, ok: false };
    }
  })();
  if (!ok) {
    console.error(err || out);
    process.exit(1);
  }
  console.log(out);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
  printHelp();
  process.exit(0);
}

const first = argv[0];
if (/^\d+$/.test(first ?? '')) {
  const sub = argv[1];
  if (!sub) {
    printHelp();
    process.exit(1);
  }
  cmdPr(first!, sub, argv.slice(2));
  process.exit(0);
}

switch (first) {
  case 'manifest': {
    const json = readSkillFile('pr-review-loop.manifest.json');
    if (argv.includes('--json')) console.log(JSON.stringify(JSON.parse(json), null, 2));
    else console.log(json);
    break;
  }
  case 'pipeline':
    console.log(readSkillFile('pr-review-loop.pipeline.yml'));
    break;
  case 'reference': {
    const json = readSkillFile('pr-review-loop.reference.json');
    if (argv.includes('--json')) console.log(JSON.stringify(JSON.parse(json), null, 2));
    else console.log(json);
    break;
  }
  case 'remind':
    cmdRemind();
    break;
  default:
    printHelp();
    process.exit(1);
}
