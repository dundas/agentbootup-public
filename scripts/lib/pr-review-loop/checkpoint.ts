import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrReviewLoopCheckpoint } from "./types.ts";
import { loadManifest } from "./manifest.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const STATE_DIR = join(REPO_ROOT, ".pr-review-loop");

export function checkpointPath(repo: string, pr: number): string {
  const safe = repo.replace(/\//g, "_");
  return join(STATE_DIR, `${safe}_pr_${pr}.json`);
}

export async function readCheckpoint(repo: string, pr: number): Promise<PrReviewLoopCheckpoint | null> {
  const p = checkpointPath(repo, pr);
  let raw: string;
  try {
    raw = await readFile(p, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as PrReviewLoopCheckpoint;
  } catch (e) {
    throw new Error(`Checkpoint JSON invalid (${p}): ${(e as Error).message}`);
  }
}

export function defaultCheckpoint(repo: string, pr: number): PrReviewLoopCheckpoint {
  const manifest_version = loadManifest().version;
  return {
    manifest_version,
    pr,
    repo,
    fix_round: 0,
    max_fix_rounds: 3,
    seen_comment_ids: [],
    last_sync_at: null,
    status_note: null,
  };
}

export async function writeCheckpoint(c: PrReviewLoopCheckpoint): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const p = checkpointPath(c.repo, c.pr);
  await writeFile(p, JSON.stringify(c, null, 2) + "\n", "utf-8");
}

/** Merge new IDs into seen set; returns newly seen IDs (stable order). */
export function mergeSeenIds(
  checkpoint: PrReviewLoopCheckpoint,
  allIds: string[],
): { newIds: string[]; updated: PrReviewLoopCheckpoint } {
  const set = new Set(checkpoint.seen_comment_ids);
  const newIds: string[] = [];
  for (const id of allIds) {
    if (!set.has(id)) {
      set.add(id);
      newIds.push(id);
    }
  }
  return {
    newIds,
    updated: {
      ...checkpoint,
      seen_comment_ids: [...set].sort(),
    },
  };
}
