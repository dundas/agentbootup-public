import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { StaticBackend } from "../../lib/skill-projection/backends/static.js";

const TMP_DIR = join(tmpdir(), `static-backend-test-${Math.random().toString(36).slice(2)}`);
const SKILLS_DIR = join(TMP_DIR, ".claude", "skills");
const CLAUDE_MD = join(TMP_DIR, ".claude", "CLAUDE.md");

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

beforeAll(async () => {
  // Create .claude/skills/skill-alpha/SKILL.md
  await mkdir(join(SKILLS_DIR, "skill-alpha"), { recursive: true });
  await writeFile(join(SKILLS_DIR, "skill-alpha", "SKILL.md"), "# Alpha\nAlpha content.", "utf-8");

  // Create .claude/skills/skill-beta/SKILL.md
  await mkdir(join(SKILLS_DIR, "skill-beta"), { recursive: true });
  await writeFile(join(SKILLS_DIR, "skill-beta", "SKILL.md"), "# Beta\nBeta content.", "utf-8");

  // Create a skill dir with NO SKILL.md — should be skipped
  await mkdir(join(SKILLS_DIR, "skill-no-md"), { recursive: true });

  // Create .claude/CLAUDE.md
  await writeFile(CLAUDE_MD, "Agent config content here.", "utf-8");
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("StaticBackend — loadSkills", () => {
  test("returns Skill[] from .claude/skills/ directory structure", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    const skills = await backend.loadSkills("master");
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBe(2); // skill-alpha and skill-beta only
  });

  test("skill name matches directory name", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    const skills = await backend.loadSkills("master");
    const names = skills.map((s: any) => s.name).sort();
    expect(names).toEqual(["skill-alpha", "skill-beta"]);
  });

  test("skill content is read from SKILL.md", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    const skills = await backend.loadSkills("master");
    const alpha = skills.find((s: any) => s.name === "skill-alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.content).toBe("# Alpha\nAlpha content.");
  });

  test("skill id is deterministic SHA-256 of projectRoot\\0skillName", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    const skills = await backend.loadSkills("master");
    const alpha = skills.find((s: any) => s.name === "skill-alpha");
    const expectedId = sha256(`${TMP_DIR}\0skill-alpha`);
    expect(alpha!.id).toBe(expectedId);
  });

  test("skill is master-scoped and tenantId is null", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    const skills = await backend.loadSkills("master");
    for (const skill of skills) {
      expect((skill as any).scope).toBe("master");
      expect((skill as any).tenantId).toBeNull();
    }
  });

  test("ignores scope/tenantId params — always returns all static skills", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    const masterSkills = await backend.loadSkills("master");
    const tenantSkills = await backend.loadSkills("tenant", "some-tenant-id");
    expect(masterSkills.length).toBe(tenantSkills.length);
    expect(masterSkills.map((s: any) => s.name).sort()).toEqual(
      tenantSkills.map((s: any) => s.name).sort()
    );
  });

  test("returns [] when .claude/skills/ does not exist", async () => {
    const emptyRoot = join(tmpdir(), `static-backend-empty-${Math.random().toString(36).slice(2)}`);
    await mkdir(emptyRoot, { recursive: true });
    try {
      const backend = new StaticBackend({ projectRoot: emptyRoot });
      const skills = await backend.loadSkills("master");
      expect(skills).toEqual([]);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  test("skill has createdAt and updatedAt as ISO strings", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    const skills = await backend.loadSkills("master");
    for (const skill of skills) {
      expect(typeof (skill as any).createdAt).toBe("string");
      expect(typeof (skill as any).updatedAt).toBe("string");
      // Must parse as valid ISO date
      expect(isNaN(new Date((skill as any).createdAt).getTime())).toBe(false);
      expect(isNaN(new Date((skill as any).updatedAt).getTime())).toBe(false);
    }
  });
});

describe("StaticBackend — loadAgentConfig", () => {
  test("returns content string when .claude/CLAUDE.md exists", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    const content = await backend.loadAgentConfig("master");
    expect(content).toBe("Agent config content here.");
  });

  test("returns null when .claude/CLAUDE.md does not exist", async () => {
    const emptyRoot = join(tmpdir(), `static-backend-nomd-${Math.random().toString(36).slice(2)}`);
    await mkdir(emptyRoot, { recursive: true });
    try {
      const backend = new StaticBackend({ projectRoot: emptyRoot });
      const content = await backend.loadAgentConfig("master");
      expect(content).toBeNull();
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("StaticBackend — write methods throw (read-only)", () => {
  test("saveSkill throws 'StaticBackend is read-only'", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    await expect(backend.saveSkill({ name: "x", content: "y", scope: "master", tenantId: null } as any)).rejects.toThrow("StaticBackend is read-only");
  });

  test("deleteSkill throws 'StaticBackend is read-only'", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    await expect(backend.deleteSkill("some-id")).rejects.toThrow("StaticBackend is read-only");
  });

  test("saveVersion throws 'StaticBackend is read-only'", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    await expect(backend.saveVersion("some-id", "name", "content")).rejects.toThrow("StaticBackend is read-only");
  });

  test("restoreVersion throws 'StaticBackend is read-only'", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    await expect(backend.restoreVersion("some-id", 1, "agent-x")).rejects.toThrow("StaticBackend is read-only");
  });
});

describe("StaticBackend — loadVersions", () => {
  test("returns [] (no version history for static backend)", async () => {
    const backend = new StaticBackend({ projectRoot: TMP_DIR });
    const versions = await backend.loadVersions("any-skill-id");
    expect(versions).toEqual([]);
  });
});
