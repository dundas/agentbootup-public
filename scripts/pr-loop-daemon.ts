#!/usr/bin/env bun
/**
 * PR automation loop daemon.
 *
 * Polls open PRs across agentbootup + agentanything every 30 minutes.
 * For each open PR, spawns a Claude Code session via mech-run to run the
 * pr-review-loop skill (Phase 2 → 3 → 4 → 5.5 → 6).
 *
 * Run once to start:
 *   bun scripts/pr-loop-daemon.ts
 *
 * Override repo paths via env vars (use absolute paths — tilde is not expanded):
 *   AGENTBOOTUP_DIR=/absolute/path/to/agentbootup
 *   AGENTANYTHING_DIR=/absolute/path/to/agentanything
 *
 * Lifecycle managed by agent-process; launchd/systemd wrapping via
 * `agentbootup daemon install pr-loop` (macOS/Linux).
 */

import { createAgent, HeartbeatService } from '@derivativelabs/agent-process';
import { $ } from 'bun';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'os';
import path from 'path';

const HOME = process.env.HOME;
if (!HOME) {
  console.error('[pr-loop] FATAL: HOME env var is not set');
  process.exit(1);
}

const REPOS = [
  {
    owner: 'dundas',
    name: 'agentbootup',
    dir: process.env.AGENTBOOTUP_DIR ?? path.join(HOME, 'dev_env', 'agentbootup'),
  },
  {
    owner: 'dundas',
    name: 'agentanything',
    dir: process.env.AGENTANYTHING_DIR ?? path.join(HOME, 'dev_env', 'agentanything'),
  },
];

// Session timeout must be strictly less than poll interval to prevent overlap.
const POLL_INTERVAL_MS = 30 * 60 * 1000;   // 30 min
const SESSION_TIMEOUT_MS = 25 * 60 * 1000; // 25 min

// Concurrency limit per repo to prevent resource exhaustion.
const CONCURRENCY_LIMIT = 3;

// Track in-flight sessions per "owner/repo#number" to prevent duplicate spawns.
const inFlight = new Set<string>();

// Simple async semaphore for limiting concurrent operations.
function createSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active++;
      return;
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }

  return { acquire, release };
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

interface PrEntry {
  number: number;
  title: string;
  headRefName: string;
}

async function listOpenPrs(owner: string, repo: string): Promise<PrEntry[]> {
  const result = await $`gh pr list -R ${owner}/${repo} --json number,title,headRefName --state open`.quiet().nothrow();
  if (result.exitCode !== 0) {
    console.error(`[pr-loop] gh pr list failed for ${owner}/${repo}: ${result.stderr.toString()}`);
    return [];
  }
  try {
    return JSON.parse(result.stdout.toString()) as PrEntry[];
  } catch (err) {
    console.error(`[pr-loop] JSON parse failed for ${owner}/${repo}: ${err}`);
    return [];
  }
}

async function runPrReviewLoop(pr: PrEntry, repoOwner: string, repoName: string, repoDir: string) {
  const key = `${repoOwner}/${repoName}#${pr.number}`;
  if (inFlight.has(key)) {
    console.log(`[pr-loop] skipping ${key} — session already in flight`);
    return;
  }

  // Validate PR number is a safe integer before use.
  const prNumber = Number(pr.number);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`[pr-loop] invalid PR number for ${key}: ${pr.number}`);
    return;
  }

  // Create isolated temp directory before marking in-flight to avoid leak on failure.
  let tmpDir: string;
  try {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'pr-loop-'));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[pr-loop] failed to create temp dir for ${key}: ${errorMessage}`);
    return;
  }

  inFlight.add(key);
  console.log(`[pr-loop] processing ${key} "${pr.title}"`);

  const tmpFile = path.join(tmpDir, 'prompt.txt');
  try {
    const prompt = [
      `Run the pr-review-loop skill on PR #${prNumber} in ${repoOwner}/${repoName}.`,
      'Follow all phases: poll reviews, classify, implement fixes (max 3 rounds),',
      'run pre-push gates (adversarial + roborev), post fix pushes with SO-14 reviewer',
      'solicitation, merge-time adversarial (Phase 5.5), then merge if all gates pass.',
      'Standing orders SO-6, SO-9, SO-14, SO-16 apply.',
    ].join(' ');
    writeFileSync(tmpFile, prompt, { mode: 0o600 });

    await $`mech-run spawn \
      --provider claude-code \
      --project ${repoDir} \
      --auto-approve \
      --timeout ${SESSION_TIMEOUT_MS} \
      --prompt-file ${tmpFile}`.quiet();

    console.log(`[pr-loop] done: ${key}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[pr-loop] mech-run failed for ${key}: ${errorMessage}`);
  } finally {
    inFlight.delete(key);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

async function pollAndProcess() {
  const timestamp = new Date().toISOString();
  console.log(`[pr-loop] tick at ${timestamp}`);

  for (const repo of REPOS) {
    if (!isDir(repo.dir)) {
      console.warn(`[pr-loop] repo dir not found, skipping: ${repo.dir}`);
      continue;
    }

    const prs = await listOpenPrs(repo.owner, repo.name);
    if (prs.length === 0) {
      console.log(`[pr-loop] ${repo.owner}/${repo.name}: no open PRs`);
      continue;
    }
    console.log(`[pr-loop] ${repo.owner}/${repo.name}: ${prs.length} open PR(s)`);

    // Process with bounded concurrency to prevent resource exhaustion.
    const sem = createSemaphore(CONCURRENCY_LIMIT);
    await Promise.all(prs.map(async (pr) => {
      await sem.acquire();
      try {
        await runPrReviewLoop(pr, repo.owner, repo.name, repo.dir);
      } finally {
        sem.release();
      }
    }));
  }
}

const agent = createAgent({
  name: 'pr-loop',
  port: 8780,
  services: [
    new HeartbeatService({
      name: 'pr-loop-poll',
      interval: POLL_INTERVAL_MS,
      runOnStart: true,
      handler: async () => {
        await pollAndProcess();
      },
    }),
  ],
});

console.log('[pr-loop] starting daemon (port 8780, poll interval 30min, session timeout 25min)');
await agent.start();
