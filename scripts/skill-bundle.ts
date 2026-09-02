#!/usr/bin/env bun
/**
 * Build a local skill .tar.gz using the same logic as `agentbootup skills push` (PRD-0014 FR-21).
 * Also exposes manifest-aware bundle publish/report/status/rehash/install/rollback commands.
 *
 * Usage:
 *   bun scripts/skill-bundle.ts [--cwd <dir>] [--out <file|-]
 *   bun scripts/skill-bundle.ts report --manifest <path> [--source-root <dir>]
 *   bun scripts/skill-bundle.ts status --manifest <path>
 *   bun scripts/skill-bundle.ts rehash --manifest <path> [--source-root <dir>] [--dry-run]
 *   bun scripts/skill-bundle.ts install --manifest <path> [--target-root <dir>] [--skip-validation|--no-validate]
 *   bun scripts/skill-bundle.ts rollback --manifest <path> [--target-root <dir>]
 *   bun scripts/skill-bundle.ts publish --manifest <path>
 *
 * Default: writes skill-bundle-<YYYY-MM-DD-HHmmss>.tar.gz under --cwd (or cwd).
 * Use --out - to write the archive bytes to stdout.
 */

import { writeFileSync } from 'fs';
import path from 'path';
import { buildSkillBundleTarGz, formatSkillBundleTimestamp } from '../lib/brain/skill-bundle-transport.js';
import { runBundleCommand } from '../lib/bundle/cli.js';

function printHelp(): void {
  console.log(`skill-bundle — build local skill tree archive or operate manifest-aware bundles

Usage:
  bun scripts/skill-bundle.ts [--cwd <dir>] [--out <path>]
  bun scripts/skill-bundle.ts publish --manifest <path> [--source-root <dir>] [--dry-run]
  bun scripts/skill-bundle.ts report --manifest <path> [--source-root <dir>]
  bun scripts/skill-bundle.ts status --manifest <path> [--source-root <dir>] [--target-root <dir>]
  bun scripts/skill-bundle.ts rehash --manifest <path> [--source-root <dir>] [--dry-run]
  bun scripts/skill-bundle.ts install --manifest <path> [--source-root <dir>] [--target-root <dir>] [--force] [--dry-run] [--skip-validation|--no-validate]
  bun scripts/skill-bundle.ts rollback --manifest <path> [--target-root <dir>] [--dry-run]

Options:
  --cwd <dir>   Project root (default: current directory)
  --out <path>  Output file, or "-" for stdout (default: skill-bundle-<ts>.tar.gz in cwd)
  -h, --help    Show this help
`);
}

function parseArgs(argv: string[]): { cwd: string; out: string | null; help: boolean } {
  let cwd = process.cwd();
  let out: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--cwd' && argv[i + 1]) {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      cwd = path.resolve(argv[++i]);
    } else if (a === '--out' && argv[i + 1]) out = argv[++i];
  }
  return { cwd, out, help };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  if (
    subcommand === 'publish' ||
    subcommand === 'report' ||
    subcommand === 'status' ||
    subcommand === 'rehash' ||
    subcommand === 'install' ||
    subcommand === 'rollback'
  ) {
    const exitCode = await runBundleCommand(argv, {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });
    if (exitCode) process.exit(exitCode);
    return;
  }

  const { cwd, out, help } = parseArgs(argv);
  if (help) {
    printHelp();
    process.exit(0);
  }

  const { buffer, roots, fileCount } = await buildSkillBundleTarGz(cwd);

  if (out === '-') {
    process.stdout.write(buffer);
    return;
  }

  const dest =
    out != null && out !== ''
      ? // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        path.resolve(cwd, out)
      : path.join(cwd, `skill-bundle-${formatSkillBundleTimestamp()}.tar.gz`);

  writeFileSync(dest, buffer);
  console.error(
    `skill-bundle: wrote ${dest} (${fileCount} files; roots: ${roots.join(', ')})`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`skill-bundle: ${msg}`);
  process.exit(1);
});
