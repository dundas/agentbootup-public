import { test, expect, describe, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashContent, readFileHash } from "../../lib/skill-projection/hash.js";

const TMP_DIR = join(tmpdir(), `hash-test-${Math.random().toString(36).slice(2)}`);

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("hashContent", () => {
  test("returns a 64-character hex string", () => {
    const result = hashContent("hello world");
    expect(typeof result).toBe("string");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic — same input yields same hash", () => {
    const a = hashContent("deterministic content");
    const b = hashContent("deterministic content");
    expect(a).toBe(b);
  });

  test("matches Node crypto SHA-256 directly", () => {
    const input = "cross-check content";
    const expected = createHash("sha256").update(input).digest("hex");
    expect(hashContent(input)).toBe(expected);
  });

  test("different content produces different hashes", () => {
    const h1 = hashContent("content A");
    const h2 = hashContent("content B");
    expect(h1).not.toBe(h2);
  });

  test("empty string produces a valid hash", () => {
    const result = hashContent("");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readFileHash", () => {
  test("returns null for a missing file (ENOENT)", async () => {
    const result = await readFileHash(join(TMP_DIR, "nonexistent.txt"));
    expect(result).toBeNull();
  });

  test("returns the correct SHA-256 hash of an existing file", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const filePath = join(TMP_DIR, "test.txt");
    const content = "file content for hash test";
    await writeFile(filePath, content, "utf-8");

    const result = await readFileHash(filePath);
    const expected = hashContent(content);
    expect(result).toBe(expected);
  });

  test("hash is consistent across multiple reads", async () => {
    const filePath = join(TMP_DIR, "consistent.txt");
    await writeFile(filePath, "consistent content", "utf-8");

    const h1 = await readFileHash(filePath);
    const h2 = await readFileHash(filePath);
    expect(h1).toBe(h2);
  });
});
