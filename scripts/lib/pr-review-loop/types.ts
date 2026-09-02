/** Types shared by scripts/pr-review-loop.ts and checkpoint logic. */

export type ManifestJson = {
  version: number;
  title: string;
  description?: string;
  references: Record<string, string>;
  sequence: ManifestPhase[];
};

export type ManifestPhase = {
  id: string;
  skill_phase: string;
  title: string;
  order_locked?: boolean;
  max_rounds?: number;
  steps: ManifestStep[];
};

export type ManifestStep = {
  id: string;
  kind: "skill" | "cli" | "smoke" | "human" | "agent" | "sequence_ref";
  ref?: string;
  command?: string;
  focus?: string;
  note?: string;
  skip_when?: string[];
};

export type PrReviewLoopCheckpoint = {
  /** Must match manifest `version` */
  manifest_version: number;
  pr: number;
  repo: string;
  /** Current automated fix round (0..max_fix_rounds); agent-maintained */
  fix_round: number;
  max_fix_rounds: number;
  /** Stable IDs from GitHub JSON for reviews + comments + inline comments */
  seen_comment_ids: string[];
  last_sync_at: string | null;
  /** Optional agent note, e.g. "awaiting_human" */
  status_note: string | null;
};
