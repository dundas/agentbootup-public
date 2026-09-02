import { gh, ghRepoArgs, splitRepo } from "./gh.ts";
import type { FetchPayload } from "./fetch-payload.ts";

/** `gh api --paginate` can emit multiple JSON arrays; merge into one array (needs `jq` in PATH). */
async function fetchInlineReviewCommentsMerged(owner: string, name: string, pr: string): Promise<unknown[]> {
  const path = `repos/${owner}/${name}/pulls/${pr}/comments`;
  const ghProc = Bun.spawn(["gh", "api", path, "--paginate"], { stdout: "pipe", stderr: "pipe" });
  const jqProc = Bun.spawn(["jq", "-s", "add"], { stdin: ghProc.stdout, stdout: "pipe", stderr: "pipe" });
  const codeJq = await jqProc.exited;
  const codeGh = await ghProc.exited;
  const outJq = await new Response(jqProc.stdout).text();
  const errJq = await new Response(jqProc.stderr).text();
  const errGh = await new Response(ghProc.stderr).text();
  if (codeGh !== 0) {
    throw new Error(errGh || "gh api inline comments failed");
  }
  if (codeJq === 0) {
    try {
      const merged = JSON.parse(outJq.trim() || "[]") as unknown;
      return Array.isArray(merged) ? merged : [];
    } catch {
      throw new Error(`jq output invalid JSON: ${errJq || outJq.slice(0, 200)}`);
    }
  }
  // Fallback when jq missing or failed: single-page parse (may truncate very large threads)
  const inline = await gh(["api", path, "-F", "per_page=100"]);
  if (inline.code !== 0) {
    throw new Error(inline.stderr || inline.stdout || "gh api inline comments (fallback) failed");
  }
  try {
    const parsed = JSON.parse(inline.stdout) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("Failed to parse inline comments JSON (fallback)");
  }
}

export async function fetchPrPayload(repo: string, pr: string): Promise<FetchPayload> {
  const r = ghRepoArgs(repo);
  const { owner, name } = splitRepo(repo);

  const view = await gh([
    "pr",
    "view",
    pr,
    ...r,
    "--json",
    "number,title,url,reviews,comments",
  ]);
  if (view.code !== 0) {
    throw new Error(view.stderr || view.stdout || "gh pr view failed");
  }

  const inlineComments = await fetchInlineReviewCommentsMerged(owner, name, pr);

  let parsed: {
    number: number;
    title: string;
    url: string;
    reviews: unknown[];
    comments: unknown[];
  };
  try {
    parsed = JSON.parse(view.stdout) as typeof parsed;
  } catch (e) {
    throw new Error(`Failed to parse gh pr view JSON: ${(e as Error).message}`);
  }

  return {
    pr: parsed.number,
    title: parsed.title,
    url: parsed.url,
    formalReviews: parsed.reviews ?? [],
    issueComments: parsed.comments ?? [],
    inlineReviewComments: inlineComments,
  };
}
