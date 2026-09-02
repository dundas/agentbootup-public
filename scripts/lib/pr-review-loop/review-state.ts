import type { FetchPayload } from "./fetch-payload.ts";

export type PollUntilMode = "once" | "new" | "quiet" | "ready";

export type DerivedReviewState = {
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  prState: string | null;
  counts: { formal: number; issue: number; inline: number };
  hasFormalReview: boolean;
  headline: string;
  suggestedNext: string;
};

/** Summarize PR for agents after a fetch/poll (Phase 2 triage). */
export function deriveReviewState(p: FetchPayload): DerivedReviewState {
  const formal = p.formalReviews?.length ?? 0;
  const issue = p.issueComments?.length ?? 0;
  const inline = p.inlineReviewComments?.length ?? 0;
  const rd = p.reviewDecision ?? null;
  const ms = p.mergeStateStatus ?? null;
  const st = p.prState ?? null;

  let headline = `PR #${p.pr} — decision: ${rd ?? "none"} | merge: ${ms ?? "?"} | ${formal} formal / ${issue} issue / ${inline} inline`;
  let suggestedNext =
    "Classify comments (Phase 3). On NEW thread text, run /adversarial-reviewer before implementing.";

  if (rd === "APPROVED") {
    suggestedNext = "Approved — verify CI (watch), then Phase 5.5 merge-time adversarial if policy requires.";
  } else if (rd === "CHANGES_REQUESTED") {
    suggestedNext = "Changes requested — Phase 4 fix rounds (max 3), Phase 0 before each push.";
  } else if (formal === 0 && issue === 0 && inline === 0) {
    headline = `PR #${p.pr} — no reviews or comments yet | merge: ${ms ?? "?"}`;
    suggestedNext = "No activity yet — consider SO-14 remind (bun scripts/pr-review-loop.ts remind).";
  }

  return {
    reviewDecision: rd,
    mergeStateStatus: ms,
    prState: st,
    counts: { formal, issue, inline },
    hasFormalReview: formal > 0,
    headline,
    suggestedNext,
  };
}

export function sortedIdsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** New IDs present compared to baseline set. */
export function newIdsSince(baseline: Set<string>, current: string[]): string[] {
  return current.filter((id) => !baseline.has(id));
}

/** Stop when a formal review exists or GitHub sets an explicit decision (not only REVIEW_REQUIRED). */
export function isReadyForTriage(p: FetchPayload): boolean {
  if ((p.formalReviews?.length ?? 0) > 0) return true;
  const rd = p.reviewDecision;
  if (rd === "APPROVED" || rd === "CHANGES_REQUESTED") return true;
  return false;
}
