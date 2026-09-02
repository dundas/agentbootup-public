import { test, expect, describe, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { SkillProjector } from "../../lib/skill-projection/projector.js";

// ── helpers ────────────────────────────────────────────────────────────────

const TMP_DIR = join(tmpdir(), `projector-test-${Math.random().toString(36).slice(2)}`);

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

type ScopeArg = "master" | "tenant";

const makeBackend = (skills: any[] = [], config: string | null = null) => ({
  loadSkills: async (scope: ScopeArg, _tenantId?: string) =>
    skills.filter((s) => s.scope === scope),
  loadAgentConfig: async (_scope: ScopeArg, _tenantId?: string) => config,
  saveSkill: async (skill: any) => ({ ...skill, id: "id-1" }),
  deleteSkill: async () => {},
  loadVersions: async () => [],
  restoreVersion: async () => {},
  saveVersion: async () => {},
});

const skill = (name: string, scope: ScopeArg, content: string) => ({
  id: `id-${name}`,
  name,
  scope,
  content,
  tenantId: scope === "tenant" ? "tenant-1" : null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

let testDirCounter = 0;
const nextDir = () => join(TMP_DIR, `run-${++testDirCounter}`);

// ── generateClaudeMd ───────────────────────────────────────────────────────

describe("generateClaudeMd", () => {
  test("empty DB → minimal doc with just header + trailing newline", async () => {
    const p = new SkillProjector({
      backend: makeBackend(),
      baseDir: TMP_DIR,
      tenants: [],
    });
    const doc = await p.generateClaudeMd("acme");
    expect(doc).toBe("# Agent Instructions — acme\n\n");
  });

  test("master skills appear in the doc", async () => {
    const p = new SkillProjector({
      backend: makeBackend([skill("alpha", "master", "alpha content")]),
      baseDir: TMP_DIR,
      tenants: ["acme"],
    });
    const doc = await p.generateClaudeMd("acme");
    expect(doc).toContain("### alpha");
    expect(doc).toContain("alpha content");
  });

  test("tenant skills appear in the doc", async () => {
    const p = new SkillProjector({
      backend: makeBackend([skill("beta", "tenant", "beta content")]),
      baseDir: TMP_DIR,
      tenants: ["acme"],
    });
    const doc = await p.generateClaudeMd("acme");
    expect(doc).toContain("### beta");
    expect(doc).toContain("beta content");
  });

  test("master skills appear before tenant skills", async () => {
    const p = new SkillProjector({
      backend: makeBackend([
        skill("zzz-master", "master", "master content"),
        skill("aaa-tenant", "tenant", "tenant content"),
      ]),
      baseDir: TMP_DIR,
      tenants: ["acme"],
    });
    const doc = await p.generateClaudeMd("acme");
    const masterIdx = doc.indexOf("### zzz-master");
    const tenantIdx = doc.indexOf("### aaa-tenant");
    expect(masterIdx).toBeGreaterThanOrEqual(0);
    expect(tenantIdx).toBeGreaterThanOrEqual(0);
    expect(masterIdx).toBeLessThan(tenantIdx);
  });

  test("skills are sorted alphabetically by name within each group", async () => {
    const p = new SkillProjector({
      backend: makeBackend([
        skill("zebra", "master", "z"),
        skill("alpha", "master", "a"),
        skill("mango", "master", "m"),
      ]),
      baseDir: TMP_DIR,
      tenants: ["acme"],
    });
    const doc = await p.generateClaudeMd("acme");
    const alphaIdx = doc.indexOf("### alpha");
    const mangoIdx = doc.indexOf("### mango");
    const zebraIdx = doc.indexOf("### zebra");
    expect(alphaIdx).toBeLessThan(mangoIdx);
    expect(mangoIdx).toBeLessThan(zebraIdx);
  });

  test("agent config section is included when config is present", async () => {
    const p = new SkillProjector({
      backend: makeBackend([], "model: claude-3-5-sonnet"),
      baseDir: TMP_DIR,
      tenants: ["acme"],
    });
    const doc = await p.generateClaudeMd("acme");
    expect(doc).toContain("## Agent Config");
    expect(doc).toContain("model: claude-3-5-sonnet");
  });

  test("falls back to master agent config when no tenant config", async () => {
    const backend = {
      ...makeBackend(),
      loadAgentConfig: async (scope: ScopeArg, _tenantId?: string) => {
        if (scope === "master") return "master-config-content";
        return null;
      },
    };
    const p = new SkillProjector({ backend, baseDir: TMP_DIR, tenants: ["acme"] });
    const doc = await p.generateClaudeMd("acme");
    expect(doc).toContain("## Agent Config");
    expect(doc).toContain("master-config-content");
  });

  test("no Agent Config section when config is null for both scopes", async () => {
    const p = new SkillProjector({
      backend: makeBackend([], null),
      baseDir: TMP_DIR,
      tenants: ["acme"],
    });
    const doc = await p.generateClaudeMd("acme");
    expect(doc).not.toContain("## Agent Config");
  });
});

// ── syncTenantToDisk ───────────────────────────────────────────────────────

describe("syncTenantToDisk", () => {
  test("creates CLAUDE.md on first call", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });
    const p = new SkillProjector({ backend: makeBackend(), baseDir, tenants: ["acme"] });

    await p.syncTenantToDisk("acme");
    const content = await readFile(join(baseDir, "acme", "CLAUDE.md"), "utf-8");
    expect(content).toBe("# Agent Instructions — acme\n\n");
  });

  test("returns { skipped: false } on first write", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });
    const p = new SkillProjector({ backend: makeBackend(), baseDir, tenants: ["acme"] });

    const result = await p.syncTenantToDisk("acme");
    expect(result.skipped).toBe(false);
  });

  test("returns { skipped: true } on second call with unchanged content", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });
    const p = new SkillProjector({ backend: makeBackend(), baseDir, tenants: ["acme"] });

    await p.syncTenantToDisk("acme");
    const result = await p.syncTenantToDisk("acme");
    expect(result.skipped).toBe(true);
  });

  test("returns { skipped: false } after backend content changes", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });

    let configValue: string | null = null;
    const backend = {
      ...makeBackend(),
      loadAgentConfig: async (_scope: ScopeArg) => configValue,
    };
    const p = new SkillProjector({ backend, baseDir, tenants: ["acme"] });

    await p.syncTenantToDisk("acme");

    configValue = "updated-config";
    const result = await p.syncTenantToDisk("acme");
    expect(result.skipped).toBe(false);
  });

  test("testMode skips filesystem entirely and returns { skipped: true }", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });
    const p = new SkillProjector({
      backend: makeBackend(),
      baseDir,
      tenants: ["acme"],
      testMode: true,
    });

    const result = await p.syncTenantToDisk("acme");
    expect(result.skipped).toBe(true);

    // File should NOT exist
    let fileExists = false;
    try {
      await stat(join(baseDir, "acme", "CLAUDE.md"));
      fileExists = true;
    } catch {}
    expect(fileExists).toBe(false);
  });

  test("no lingering .CLAUDE.md.tmp file after atomic write", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });
    const p = new SkillProjector({ backend: makeBackend(), baseDir, tenants: ["acme"] });

    await p.syncTenantToDisk("acme");

    let tmpExists = false;
    try {
      await stat(join(baseDir, "acme", ".CLAUDE.md.tmp"));
      tmpExists = true;
    } catch {}
    expect(tmpExists).toBe(false);
  });
});

// ── syncAllTenantsToDisk ──────────────────────────────────────────────────

describe("syncAllTenantsToDisk", () => {
  test("syncs all tenants and returns correct lists", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });
    const p = new SkillProjector({
      backend: makeBackend(),
      baseDir,
      tenants: ["tenant-a", "tenant-b"],
    });

    const result = await p.syncAllTenantsToDisk();
    expect(result.synced.sort()).toEqual(["tenant-a", "tenant-b"]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("removes orphan directories not in tenants list", async () => {
    const baseDir = nextDir();
    await mkdir(join(baseDir, "orphan"), { recursive: true });
    const p = new SkillProjector({
      backend: makeBackend(),
      baseDir,
      tenants: ["active"],
    });

    await p.syncAllTenantsToDisk();

    let orphanExists = false;
    try {
      await stat(join(baseDir, "orphan"));
      orphanExists = true;
    } catch {}
    expect(orphanExists).toBe(false);
  });

  test("tenantId containing path traversal escapes throws and is reported as failed", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });
    const p = new SkillProjector({
      backend: makeBackend(),
      baseDir,
      tenants: ["../escape"],
    });

    const result = await p.syncAllTenantsToDisk();
    expect(result.failed).toContain("../escape");
    expect(result.synced).not.toContain("../escape");
  });

  test("syncTenantToDisk throws for traversal tenantId", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });
    const p = new SkillProjector({ backend: makeBackend(), baseDir, tenants: [] });

    await expect(p.syncTenantToDisk("../escape")).rejects.toThrow('escapes baseDir');
  });

  test("per-tenant errors do not abort syncAll and are reported in failed[]", async () => {
    const baseDir = nextDir();
    await mkdir(baseDir, { recursive: true });

    const failingBackend = {
      ...makeBackend(),
      loadSkills: async (scope: ScopeArg, tenantId?: string) => {
        if (tenantId === "bad-tenant") throw new Error("backend exploded");
        return [];
      },
    };
    const p = new SkillProjector({
      backend: failingBackend,
      baseDir,
      tenants: ["good-tenant", "bad-tenant"],
    });

    const result = await p.syncAllTenantsToDisk();
    expect(result.failed).toContain("bad-tenant");
    // good-tenant must still succeed
    expect(result.synced.concat(result.skipped)).toContain("good-tenant");
  });
});
