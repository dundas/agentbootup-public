#!/usr/bin/env bun
/**
 * FR-1b: Guard the brain-msg resolution contract (Channel B resolver + skill shim).
 *
 * Neither tracked file is the implementation. The ~3000-line implementation is owned
 * upstream and arrives as an untracked runtime copy at brain/brain-msg.ts. What this
 * repo ships are two wrappers that must *resolve and delegate* to it:
 *
 *   templates/brain/brain-msg.ts                               Channel B resolver
 *   templates/.claude/skills/cross-brain-message/brain-msg.ts  skill shim
 *
 * This guard executes each wrapper against a fake implementation and asserts the fake
 * actually ran. A substring check cannot do that: a wrapper reduced to `process.exit(0)`,
 * or one whose resolution path survives only inside a comment, still contains every
 * string worth grepping for. The previous version of this file made exactly that mistake
 * and could not fail.
 *
 * Usage: bun scripts/check-brain-msg-drift.ts
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const channelB = join(repoRoot, "templates/brain/brain-msg.ts");
const skillShim = join(repoRoot, "templates/.claude/skills/cross-brain-message/brain-msg.ts");

const SENTINEL = "__BRAIN_MSG_FAKE_IMPL_INVOKED__";

function die(msg: string): never {
  console.error(`check-brain-msg-drift: FAIL — ${msg}`);
  process.exit(1);
}

function write(filePath: string, content: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * Stage the wrapper in a throwaway repo beside a fake implementation, run it, and report
 * whether the fake was reached. HOME is isolated so an operator's real ~/.brain/brain-msg.ts
 * can never satisfy the resolution under test.
 */
export function delegatesToImplementation(wrapperSource: string, wrapperRelPath: string): { ok: boolean; detail: string } {
  const root = mkdtempSync(join(tmpdir(), "brain-msg-drift-"));
  try {
    const home = join(root, "home");
    const wrapper = join(root, "repo", wrapperRelPath);
    const fakeImpl = join(root, "impl", "brain-msg.ts");

    write(wrapper, wrapperSource);
    write(fakeImpl, `console.log(${JSON.stringify(SENTINEL)});\n`);
    mkdirSync(join(home, ".brain", "brain-inbox"), { recursive: true });

    const result = spawnSync("bun", [wrapper, "help"], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        HOME: home,
        BRAIN_MSG_SHARED_PATH: fakeImpl,
      },
    });

    if (result.signal) {
      return { ok: false, detail: `killed by signal ${result.signal} — wrapper hung or looped instead of delegating` };
    }

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (!output.includes(SENTINEL)) {
      const shown = output.trim().slice(0, 300) || "<no output>";
      return { ok: false, detail: `did not delegate to the resolved implementation (exit ${result.status}). Output: ${shown}` };
    }

    return { ok: true, detail: "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface Wrapper {
  label: string;
  source: string;
  relPath: string;
}

export const WRAPPERS = [
  { label: "Channel B resolver", path: channelB, relPath: "brain/brain-msg.ts" },
  { label: "skill shim", path: skillShim, relPath: ".claude/skills/cross-brain-message/brain-msg.ts" },
];

/**
 * Evaluate EVERY wrapper and return one failure string per non-delegating wrapper.
 *
 * main() delegates to this so tests can drive the real loop. A test that only asserts the
 * contents of WRAPPERS would pass while a refactor quietly checked just the first entry.
 */
export function checkWrappers(wrappers: Wrapper[]): string[] {
  const failures: string[] = [];
  for (const { label, source, relPath } of wrappers) {
    const { ok, detail } = delegatesToImplementation(source, relPath);
    if (!ok) failures.push(`${label} ${detail}`);
  }
  return failures;
}

function main(): void {
  if (!existsSync(channelB)) die(`missing Channel B resolver: ${channelB}`);
  if (!existsSync(skillShim)) die(`missing skill shim: ${skillShim}`);

  const failures = checkWrappers(
    WRAPPERS.map(({ label, path, relPath }) => ({
      label: `${label} (${path})`,
      source: readFileSync(path, "utf8"),
      relPath,
    }))
  );

  if (failures.length > 0) die(failures.join("; "));

  console.log("check-brain-msg-drift: OK — both wrappers resolve and delegate to the shared implementation");
}

// Guarded so tests/check-brain-msg-drift.test.ts can import the checks and pin their
// mutation-catching behaviour. CI still invokes this file directly.
if (import.meta.main) main();
