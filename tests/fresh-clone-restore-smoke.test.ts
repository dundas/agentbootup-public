// WO msg-1784803031106-5b7jf2 §1: fresh-clone restore smoke test + dry-run↔restore parity.
//
// The whole point: a restore that reports success while shipping nothing is the
// exact defect being fixed (2026-07-22 incident 4: dry-run claimed assets the
// matcher never restored). This test restores a fixture brain into a temp dir and
// asserts:
//   (A) PRESENCE of every file class a session needs (AGENTS.md, SKILL.md,
//       brain/role-engine/**, memory bootstrap) — the fresh-clone smoke.
//   (B) PARITY — every file discoverAssets reports (what `brain push --dry-run`
//       shows) is present on disk after writeAssets (what `brain restore` writes).
//       Zero omissions. Any discovered file absent from the restore = test failure.
//
// No real server needed: discoverAssets runs locally; writeAssets writes a bundle
// built from the discovered files. The parity surface is the ASSET_TYPE_TO_SUBSET
// filter in writeAssets — if a discovered asset_type maps to a subset not in the
// default subset, the file is silently dropped (the defect).

import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';

import { discoverAssets } from '../lib/network/commands/brain.js';
import { parseBootArgs, writeAndPromote } from '../lib/brain/restore-boot.js';

// Derive the default subset from the PRODUCTION parser (roborev: hardcoding it here
// would let the test go stale if the restore default changes). parseBootArgs([])
// returns the real boot-restore default subset — the test tracks runtime behavior.
const DEFAULT_SUBSET = parseBootArgs([]).subset;

// Independent expected manifest — the file classes a session NEEDS,
// hardcoded so a discovery regression is caught independently of the
// self-generated bundle (roborev: the parity test alone is tautological if
// the only source of truth is discoverAssets output).
// NOTE: keep this in sync with buildFixtureBrain() below — when adding a new file
// class, add it to BOTH the fixture and this manifest. Nothing enforces the sync
// except the test passing; the independent manifest is what catches discovery
// regressions the self-generated parity check would miss.
const EXPECTED_MANIFEST = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'brain-backup.json',
  '.agents/skills/task-processor/SKILL.md',
  '.agents/skills/task-processor/scripts/entry.ts',
  '.agents/agents/reviewer.md',
  '.agents/commands/run.md',
  // .claude/* surface (first-class restore roots — roborev)
  '.claude/skills/task-processor/SKILL.md',
  '.claude/skills/task-processor/scripts/entry.ts',
  '.claude/agents/reviewer.md',
  '.claude/commands/run.md',
  '.ai/protocols/STANDARD_DEV_WORKFLOW.md',
  'scripts/helper.ts',
  'brain/config.json',
  'brain/brain-msg.ts',
  'brain/brain-schema.sql',
  'brain/lib/bootstrap.ts',
  'brain/scripts/inbox-runtime.ts',
  'brain/role-engine/resolve.ts',
  'brain/role-engine/schema.ts',
  'brain/role-engine/SPEC.md',
  'brain/role-engine/.pi/roles/code-reviewer/SYSTEM.md',
  'brain/roles/_classes/general.class.json',
  'brain/roles/researcher.role.json',
  'brain/personas/decisive-gm/SYSTEM.md',
  'memory/MEMORY.md',
  'memory/SCHEMA.md',
];

let tmpDir: string;
let restoreDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `fresh-clone-${crypto.randomBytes(8).toString('hex')}`);
  restoreDir = path.join(os.tmpdir(), `fresh-clone-restore-${crypto.randomBytes(8).toString('hex')}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(restoreDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.rm(restoreDir, { recursive: true, force: true });
});

/** Write a fixture file inside the fixture brain (tmpDir). */
function fixture(rel: string, content = 'fixture'): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** Build the canonical fixture brain with every file class a session needs. */
function buildFixtureBrain(): void {
  // config files (asset_type: config)
  fixture('AGENTS.md', '# agents\n');
  fixture('CLAUDE.md', '# claude\n');
  fixture('GEMINI.md', '# gemini\n');  // also a supported root-level config (roborev)

  // skills (asset_type: skill) — manifest + runtime script
  fixture('.agents/skills/task-processor/SKILL.md', '# task-processor\n');
  fixture('.agents/skills/task-processor/scripts/entry.ts', 'export {};\n');

  // agents (asset_type: agent)
  fixture('.agents/agents/reviewer.md', '# reviewer agent\n');

  // .agents/* surface (portable, harness-neutral)
  fixture('.agents/commands/run.md', '# run command\n');

  // .claude/* surface (Claude CLI — also first-class restore roots, roborev)
  fixture('.claude/skills/task-processor/SKILL.md', '# task-processor (claude)\n');
  fixture('.claude/skills/task-processor/scripts/entry.ts', 'export {};\n');
  fixture('.claude/agents/reviewer.md', '# reviewer agent (claude)\n');
  fixture('.claude/commands/run.md', '# run command (claude)\n');

  // protocols (asset_type: protocol)
  fixture('.ai/protocols/STANDARD_DEV_WORKFLOW.md', '# workflow\n');

  // scripts (asset_type: script) — top-level only
  fixture('scripts/helper.ts', 'export {};\n');

  // brain config (asset_type: config)
  fixture('brain/config.json', '{"agent_id":"fixture-brain"}\n');
  fixture('brain-backup.json', JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'fixture-brain',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));

  // brain runtime substrate (asset_type: runtime) — lib + scripts
  fixture('brain/brain-msg.ts', 'export {};\n');
  fixture('brain/brain-schema.sql', 'SELECT 1;\n');
  fixture('brain/lib/bootstrap.ts', 'export {};\n');
  fixture('brain/scripts/inbox-runtime.ts', 'export {};\n');

  // brain role runtime (asset_type: runtime) — role-engine, roles, personas
  // (shipped in 0.8.29, PR #365)
  fixture('brain/role-engine/resolve.ts', 'export {};\n');
  fixture('brain/role-engine/schema.ts', 'export {};\n');
  fixture('brain/role-engine/SPEC.md', '# role engine spec\n');
  fixture('brain/role-engine/.pi/roles/code-reviewer/SYSTEM.md', '# system\n');
  fixture('brain/roles/_classes/general.class.json', '{}\n');
  fixture('brain/roles/researcher.role.json', '{}\n');
  fixture('brain/personas/decisive-gm/SYSTEM.md', '# persona\n');

  // memory bootstrap (asset_type: memory)
  fixture('memory/MEMORY.md', '# memory\n');
  fixture('memory/SCHEMA.md', '# schema\n');
}

/** Build a server-style bundle from discovered assets: { asset_type, path, content_base64 }. */
function buildBundleFromDiscovery(discovered: ReturnType<typeof discoverAssets>): Array<{ asset_type: string; path: string; content_base64: string }> {
  return discovered.map((a) => ({
    asset_type: a.asset_type,
    path: a.relFromProject,
    content_base64: fs.readFileSync(a.filePath).toString('base64'),
  }));
}

// ── §1.A: Fresh-clone restore smoke (presence of every file class) ────────────

test('fresh-clone restore materializes every file class a session needs', () => {
  buildFixtureBrain();

  // Discover (what dry-run shows) and build a bundle.
  const discovered = discoverAssets(tmpDir, null, { honorGitignore: false });
  expect(discovered.length).toBeGreaterThan(0);
  const bundle = buildBundleFromDiscovery(discovered);

  // Restore into a clean dir with the default boot subset.
  const result = writeAndPromote(bundle, {
    target: restoreDir,
    verbose: false,
    subset: DEFAULT_SUBSET,
    preserveExisting: undefined,
  });
  // writeAndPromote throws on errors/dropped; reaching here means clean staging+promote.
  expect(result.written).toBeGreaterThan(0);

  // Assert PRESENCE of every file class.
  // Check against the INDEPENDENT expected manifest (catches discovery regressions
  // that a self-generated bundle would miss — roborev).
  const missing = EXPECTED_MANIFEST.filter((rel) => !fs.existsSync(path.join(restoreDir, rel)));
  expect(missing).toEqual([]);  // any missing file = test failure

  // CONTENT VERIFICATION (roborev): presence alone doesn't prove integrity — a
  // regression that truncates or writes wrong bytes would pass. Assert restored
  // bytes match fixture bytes for a representative sample of each file class.
  const contentChecks = [
    'AGENTS.md',
    '.agents/skills/task-processor/SKILL.md',
    'brain/role-engine/resolve.ts',
    'brain/roles/_classes/general.class.json',
    'brain/personas/decisive-gm/SYSTEM.md',
    'memory/MEMORY.md',
  ];
  for (const rel of contentChecks) {
    const original = fs.readFileSync(path.join(tmpDir, rel), 'utf-8');
    const restored = fs.readFileSync(path.join(restoreDir, rel), 'utf-8');
    expect(restored).toBe(original);  // byte-equal, not just present
  }
});

test('fresh-clone restore does NOT materialize config.secret.json', () => {
  buildFixtureBrain();
  fixture('brain/config.secret.json', '{"admp_key":"secret"}\n');  // must never be restored

  const discovered = discoverAssets(tmpDir, null, { honorGitignore: false });
  const bundle = buildBundleFromDiscovery(discovered);
  writeAndPromote(bundle, { target: restoreDir, verbose: false, subset: DEFAULT_SUBSET, preserveExisting: undefined });

  // config.secret.json must never be discovered OR restored
  expect(discovered.map((a) => a.relFromProject)).not.toContain('brain/config.secret.json');
  expect(fs.existsSync(path.join(restoreDir, 'brain/config.secret.json'))).toBe(false);
});

// ── §1.B: Dry-run ↔ restore parity (the load-bearing gate) ────────────────────

test('dry-run ↔ restore parity: every discovered file is present after restore (zero omissions)', () => {
  buildFixtureBrain();

  const discovered = discoverAssets(tmpDir, null, { honorGitignore: false });
  const discoveredPaths = discovered.map((a) => a.relFromProject);
  expect(discoveredPaths.length).toBeGreaterThan(10);  // sanity: a real fixture, not empty

  const bundle = buildBundleFromDiscovery(discovered);
  const result = writeAndPromote(bundle, {
    target: restoreDir,
    verbose: false,
    subset: DEFAULT_SUBSET,
    preserveExisting: undefined,
  });
  expect(result.written).toBeGreaterThan(0);

  // PARITY: every file discoverAssets reported must be on disk after restore.
  // Any omission is the exact defect (incident 4: dry-run claimed, matcher omitted).
  const omitted = discoveredPaths.filter((rel) => !fs.existsSync(path.join(restoreDir, rel)));
  expect(omitted).toEqual([]);  // zero omissions = parity holds

  // INDEPENDENT MANIFEST CHECK (roborev): also assert the independent expected
  // manifest is present — a discovery regression (e.g. role-engine stops being
  // discovered) would pass the parity check (discoverAssets found nothing to omit)
  // but fail here, because the expected file is absent from BOTH the discovery
  // and the restore. This closes the tautological gap.
  const missingExpected = EXPECTED_MANIFEST.filter((rel) => !fs.existsSync(path.join(restoreDir, rel)));
  expect(missingExpected).toEqual([]);
  // And every expected file was actually discovered (not silently dropped by discovery).
  const undiscovered = EXPECTED_MANIFEST.filter((rel) => !discoveredPaths.includes(rel));
  expect(undiscovered).toEqual([]);
});

test('dry-run ↔ restore parity FAILS when a discovered asset is silently dropped by the subset filter (negative fixture)', () => {
  // NEGATIVE FIXTURE (per C1 — every gate ships with a negative fixture that proves
  // the gate CAN fail). This exercises the REAL discover->bundle->restore pipeline:
  // take a real discovered runtime asset, omit the runtime subset, and verify the
  // parity check catches the omission. This simulates the production regression:
  // a discovered file that the restore subset filter silently drops (incident 4)
  // without disguising a generic asset as a secret (generic restore correctly
  // rejects secret-typed assets before subset filtering).
  buildFixtureBrain();

  const discovered = discoverAssets(tmpDir, null, { honorGitignore: false });
  expect(discovered.length).toBeGreaterThan(0);

  // Build the bundle from REAL discovered assets and remove the real runtime
  // subset from this negative invocation.
  // Deterministic target (roborev: no fallback to discovered[0] — that would make the
  // test non-deterministic and let it pass exercising an unrelated asset). Assert the
  // role-engine file IS discovered before mutating it.
  const realTarget = discovered.find((a) => a.relFromProject === 'brain/role-engine/resolve.ts');
  expect(realTarget).toBeDefined();  // fail if role-engine was not discovered — that's its own regression
  const bundle = discovered.map((a) => ({
    asset_type: a.asset_type,
    path: a.relFromProject,
    content_base64: fs.readFileSync(a.filePath).toString('base64'),
  }));
  const subsetWithoutRuntime = DEFAULT_SUBSET.filter((entry) => entry !== 'runtime');

  const result = writeAndPromote(bundle, {
    target: restoreDir,
    verbose: false,
    subset: subsetWithoutRuntime,
    preserveExisting: undefined,
  });
  // writeAndPromote doesn't throw: the subset filter skips the runtime asset.
  // The runtime asset was in the "dry-run" (bundle) but NOT restored because
  // this negative invocation omitted runtime from its subset.
  expect(fs.existsSync(path.join(restoreDir, realTarget.relFromProject))).toBe(false);

  // The parity check catches the omission: the file was reported but is absent on disk.
  const allReported = bundle.map((a) => a.path);
  const omitted = allReported.filter((rel) => !fs.existsSync(path.join(restoreDir, rel)));
  expect(omitted).toContain(realTarget.relFromProject);  // the gate detects the omission
  // This proves the parity gate is not inert — it fails when dry-run claims exceed restore output.
});
