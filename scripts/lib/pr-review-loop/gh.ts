import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "../../..");

export function parseGithubRemote(url: string): string | null {
  const s = url.trim();
  const m = s.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
}

export function detectRepoFromGit(): string {
  const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error("Could not read git remote origin; pass --repo OWNER/NAME");
  }
  const url = new TextDecoder().decode(proc.stdout);
  const parsed = parseGithubRemote(url);
  if (!parsed) throw new Error(`Could not parse GitHub repo from remote: ${url.trim()}`);
  return parsed;
}

export function splitRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error(`Invalid repo: ${repo} (expected OWNER/NAME)`);
  return { owner: parts[0]!, name: parts[1]! };
}

export async function gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

export function ghRepoArgs(repo: string): string[] {
  return ["-R", repo];
}
