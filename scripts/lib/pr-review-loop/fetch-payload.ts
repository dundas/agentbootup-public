/**
 * Shared PR fetch payload + ID extraction for checkpoint sync.
 * IDs must be stable strings from GitHub JSON.
 */
import type { PrReviewLoopCheckpoint } from "./types.ts";

export type FetchPayload = {
  pr: number;
  title: string;
  url: string;
  formalReviews: unknown[];
  issueComments: unknown[];
  inlineReviewComments: unknown[];
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
  prState?: string | null;
};

export function collectCommentIds(payload: FetchPayload): string[] {
  const ids: string[] = [];

  for (const r of payload.formalReviews) {
    const id = (r as { id?: string | number }).id;
    if (id != null) ids.push(`review:${id}`);
  }
  for (const c of payload.issueComments) {
    const id = (c as { id?: string | number }).id;
    if (id != null) ids.push(`issue:${id}`);
  }
  for (const c of payload.inlineReviewComments) {
    const id = (c as { id?: string | number }).id;
    if (id != null) ids.push(`inline:${id}`);
  }

  return [...new Set(ids)].sort();
}

export function summarizeNewForAgent(newIds: string[], checkpoint: PrReviewLoopCheckpoint): string {
  if (newIds.length === 0) {
    return "No new comment/review IDs since last sync — Phase 2.5 adversarial on NEW text may skip unless content changed.";
  }
  return (
    `${newIds.length} new thread(s) / review object(s) since last sync — run /adversarial-reviewer on NEW comment bodies before implementing.\n` +
    `IDs: ${newIds.join(", ")}`
  );
}
