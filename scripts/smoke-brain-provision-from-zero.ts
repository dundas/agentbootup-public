#!/usr/bin/env bun
/**
 * AC-1 (PRD-0040): Simulate provision-from-zero — materialize brain runtime assets
 * via discoverAssets + writeAssets without git clone or live server pull.
 *
 * Usage:
 *   bun scripts/smoke-brain-provision-from-zero.ts [--cwd <repo-root>]
 *
 * Exit 0 = PASS, 1 = FAIL. Does not require AGENTBOOTUP_SERVER_URL.
 */

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { discoverAssets } from "../lib/network/commands/brain.js";
import { writeAssets } from "../lib/brain/restore.js";

const REQUIRED_RELS = [
  "brain/brain-msg.ts",
  "brain/brain-schema.sql",
  "brain/lib/bootstrap.ts",
  "brain/scripts/brain-message-inbox.ts",
];

function die(msg: string): never {
  console.error(`[smoke-brain-provision-from-zero] FAIL: ${msg}`);
  process.exit(1);
}

function parseCwd(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && argv[i + 1]) return argv[++i];
    if (argv[i]?.startsWith("--cwd=")) return argv[i].slice("--cwd=".length);
  }
  return process.cwd();
}

function materializeSourceFixture(repoRoot: string, fixtureRoot: string): void {
  const tmpl = join(repoRoot, "templates", "brain");
  mkdirSync(join(fixtureRoot, "brain", "lib"), { recursive: true });
  mkdirSync(join(fixtureRoot, "brain", "scripts"), { recursive: true });
  for (const rel of ["brain-msg.ts", "brain-schema.sql"]) {
    cpSync(join(tmpl, rel), join(fixtureRoot, "brain", rel));
  }
  cpSync(join(tmpl, "lib", "bootstrap.ts"), join(fixtureRoot, "brain", "lib", "bootstrap.ts"));
  cpSync(
    join(tmpl, "scripts", "brain-message-inbox.ts"),
    join(fixtureRoot, "brain", "scripts", "brain-message-inbox.ts"),
  );
}

const repoRoot = parseCwd(process.argv.slice(2));
const fixtureRoot = mkdtempSync(join(tmpdir(), "smoke-provision-src-"));
const targetRoot = mkdtempSync(join(tmpdir(), "smoke-provision-tgt-"));

try {
  materializeSourceFixture(repoRoot, fixtureRoot);

  const discovered = discoverAssets(fixtureRoot, new Set(["runtime"]), { honorGitignore: false });
  const rels = new Set(discovered.map((a) => a.relFromProject));
  for (const required of REQUIRED_RELS) {
    if (!rels.has(required)) die(`discoverAssets missing ${required}`);
  }

  const assets = discovered.map((a) => ({
    asset_type: "runtime",
    path: a.relFromProject,
    content_base64: Buffer.from(readFileSync(a.filePath)).toString("base64"),
  }));

  const { written, errors } = writeAssets(assets, {
    target: targetRoot,
    force: true,
    dryRun: false,
    verbose: false,
    subset: ["runtime"],
  });
  if (errors.length) die(errors.join("; "));
  if (written < REQUIRED_RELS.length) {
    die(`writeAssets wrote ${written} files; expected at least ${REQUIRED_RELS.length}`);
  }

  for (const required of REQUIRED_RELS) {
    const dest = join(targetRoot, required);
    if (!existsSync(dest)) die(`after writeAssets, missing ${required}`);
  }

  console.log(
    `[smoke-brain-provision-from-zero] PASS — ${written} runtime files materialized (no git clone)`,
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(targetRoot, { recursive: true, force: true });
}
