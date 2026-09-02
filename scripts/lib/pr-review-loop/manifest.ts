import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ManifestJson } from "./types.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");

/** Coupled skill artifacts: manifest (SSOT), YAML scan, JSON reference — see `.claude/skills/pr-review-loop/`. */
export const SKILL_PR_REVIEW_LOOP_DIR = join(REPO_ROOT, ".claude/skills/pr-review-loop");

export function manifestPath(): string {
  return join(SKILL_PR_REVIEW_LOOP_DIR, "pr-review-loop.manifest.json");
}

export function pipelineYmlPath(): string {
  return join(SKILL_PR_REVIEW_LOOP_DIR, "pr-review-loop.pipeline.yml");
}

export function referenceJsonPath(): string {
  return join(SKILL_PR_REVIEW_LOOP_DIR, "pr-review-loop.reference.json");
}

export function readPipelineYml(): string {
  return readFileSync(pipelineYmlPath(), "utf-8");
}

export function readReferenceJsonText(): string {
  return readFileSync(referenceJsonPath(), "utf-8");
}

export function loadManifest(): ManifestJson {
  const raw = readFileSync(manifestPath(), "utf-8");
  return JSON.parse(raw) as ManifestJson;
}

export function printManifestHuman(pr: string): void {
  const m = loadManifest();
  console.log(`${m.title} (v${m.version})\n`);
  console.log(m.description ?? "");
  console.log("\nReferences:");
  for (const [k, v] of Object.entries(m.references)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log("\n--- Sequence (do not reorder) ---\n");
  for (const ph of m.sequence) {
    const lock = ph.order_locked ? " [order locked]" : "";
    console.log(`## ${ph.skill_phase}: ${ph.title}${lock}`);
    if (ph.max_rounds != null) console.log(`   (max ${ph.max_rounds} rounds where applicable)`);
    for (const st of ph.steps) {
      const cmd = st.command?.replace(/\{PR\}/g, pr) ?? "";
      const line = [
        `  - [${st.id}] ${st.kind}`,
        st.ref ? `→ ${st.ref}` : "",
        cmd ? `→ ${cmd}` : "",
        st.focus ? ` — ${st.focus}` : "",
        st.note ? ` (${st.note})` : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(line);
    }
    console.log("");
  }
}

export function printManifestJson(): void {
  console.log(JSON.stringify(loadManifest(), null, 2));
}
