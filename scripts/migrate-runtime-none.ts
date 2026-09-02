/**
 * migrate-runtime-none.ts
 *
 * Scans .claude/skills/ for skills whose SKILL.md lacks a `runtime` frontmatter field
 * and for which no scripts/<name>.ts exists, then inserts `runtime: none` into the
 * frontmatter so that `agentbootup brain verify --full` stops flagging them.
 *
 * Usage:
 *   bun scripts/migrate-runtime-none.ts [--dry-run] [--path <project-root>]
 */

import fs from 'fs';
import path from 'path';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function parseFrontmatter(content: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!content.startsWith('---')) return result;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return result;
  const block = content.slice(3, end);
  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) result.set(key, value);
  }
  return result;
}

function insertRuntimeNone(content: string): string {
  if (!content.startsWith('---')) {
    // No frontmatter — prepend one.
    return `---\nruntime: none\n---\n\n${content}`;
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    // Malformed frontmatter — prepend a fresh block.
    return `---\nruntime: none\n---\n\n${content}`;
  }
  // Insert `runtime: none` as the last line of the existing frontmatter block.
  const before = content.slice(0, end);
  const after = content.slice(end);
  return `${before}\nruntime: none${after}`;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = hasFlag(args, '--dry-run');
  const projectRoot = path.resolve(getFlagValue(args, '--path') ?? '.');

  const skillsRoot = path.join(projectRoot, '.claude', 'skills');
  const scriptsRoot = path.join(projectRoot, 'scripts');

  let skillDirs: string[] = [];
  try {
    skillDirs = fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    console.error(`No .claude/skills/ directory found at ${skillsRoot}`);
    process.exit(1);
  }

  let patched = 0;
  let skipped = 0;

  for (const skillName of skillDirs) {
    const skillMdPath = path.join(skillsRoot, skillName, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8');
    } catch {
      console.log(`  skip  ${skillName}  (no SKILL.md)`);
      skipped++;
      continue;
    }

    const fm = parseFrontmatter(content);
    if (fm.has('runtime')) {
      // Already declares a runtime — leave it alone.
      skipped++;
      continue;
    }

    const runtimePath = path.join(scriptsRoot, `${skillName}.ts`);
    if (fs.existsSync(runtimePath)) {
      // Has a runtime script — no need to add `runtime: none`.
      skipped++;
      continue;
    }

    const newContent = insertRuntimeNone(content);
    if (dryRun) {
      console.log(`  [dry-run] would patch ${path.relative(projectRoot, skillMdPath)}`);
    } else {
      fs.writeFileSync(skillMdPath, newContent, 'utf-8');
      console.log(`  patched ${path.relative(projectRoot, skillMdPath)}`);
    }
    patched++;
  }

  const verb = dryRun ? 'would patch' : 'patched';
  console.log(`\nDone: ${verb} ${patched} skill(s), skipped ${skipped}`);

  if (dryRun && patched > 0) {
    console.log('\nRun without --dry-run to apply changes.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
