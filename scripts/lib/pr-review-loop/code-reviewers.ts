import { readFileSync } from "node:fs";
import path from "node:path";

const FALLBACK = ["@coderabbitai review"];

export type CodeReviewersFile = {
  version?: number;
  solicit_review?: {
    reviewers?: Array<{
      id?: string;
      mention: string;
      command?: string;
    }>;
  };
};

/** Repo-root `.ai/code-reviewers.json` → lines to paste into PR comments (e.g. `@coderabbitai review`). */
export function getSolicitReviewInvocations(): string[] {
  const file = path.join(import.meta.dir, "..", "..", "..", ".ai", "code-reviewers.json");
  try {
    const raw = readFileSync(file, "utf8");
    const j = JSON.parse(raw) as CodeReviewersFile;
    const reviewers = j.solicit_review?.reviewers;
    if (!reviewers?.length) return [...FALLBACK];
    const lines = reviewers
      .map((r) => {
        const m = String(r.mention ?? "").trim();
        if (!/^@[A-Za-z0-9-]+$/.test(m)) return "";
        const c = String(r.command ?? "review").trim();
        return `${m} ${c}`.trim();
      })
      .filter(Boolean);
    return lines.length ? lines : [...FALLBACK];
  } catch {
    return [...FALLBACK];
  }
}

export function codeReviewersConfigPathForDocs(): string {
  return ".ai/code-reviewers.json";
}
