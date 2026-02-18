#!/usr/bin/env node
// Portable bootup script to seed Claude Code assets, OpenAI Codex skills,
// Gemini CLI assets, Windsurf workflows, AI Dev Tasks, and autonomous agent
// templates (memory, automation) into any project.
// Usage:
//   node bootstrap/bootup.mjs [--target <dir>] [--subset <csv>] [--platform <claude|gemini|both>] [--force] [--dry-run] [--verbose]
//   subsets: agents,skills,commands,workflows,docs,scripts,gemini,codex,memory,automation (default: all)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatesRoot = path.join(__dirname, 'templates');

function parseArgs(argv) {
  const args = {
    target: process.cwd(),
    subset: ['agents','skills','commands','workflows','docs','scripts','gemini','codex','memory','automation','hooks'],
    platform: 'both',
    force: false,
    dryRun: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' && argv[i+1]) { args.target = path.resolve(argv[++i]); }
    else if (a === '--subset' && argv[i+1]) {
      args.subset = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    }
    else if (a === '--platform' && argv[i+1]) {
      args.platform = argv[++i].trim().toLowerCase();
    }
    else if (a === '--force') { args.force = true; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--verbose') { args.verbose = true; }
    else if (a === '--help' || a === '-h') { printHelpAndExit(); }
  }
  if (!['claude', 'gemini', 'both'].includes(args.platform)) {
    console.error(`❌ Invalid --platform "${args.platform}". Expected one of: claude, gemini, both.`);
    printHelpAndExit(1);
  }
  return args;
}

function printHelpAndExit(code = 0) {
  console.log(`\nBootup - Seed Claude Code + Windsurf + Gemini + Codex + Autonomous Agent templates into any project\n\n` +
`Options:\n` +
`  --target <dir>     Target project directory (default: CWD)\n` +
`  --subset <csv>     Which templates to install:\n` +
`                     agents,skills,commands,workflows,docs,scripts,gemini,codex,memory,automation,hooks\n` +
`                     (default: all)\n` +
`  --platform <name>  Runtime target: claude, gemini, both (default: both)\n` +
`  --force            Overwrite existing files\n` +
`  --dry-run          Preview actions without writing\n` +
`  --verbose          Print each file action\n\n` +
`Autonomous Agent Mode:\n` +
`  --subset memory,automation    Install only memory and heartbeat templates\n` +
`  --subset skills,memory        Install skills with persistent memory\n`);
  process.exit(code);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function relToCategory(relPath) {
  if (relPath.startsWith('.claude/agents/')) return 'agents';
  if (relPath.startsWith('.claude/skills/')) return 'skills';
  if (relPath.startsWith('.claude/commands/')) return 'commands';
  if (relPath.startsWith('.claude/hooks/')) return 'hooks';
  if (relPath.startsWith('.claude/fragments/')) return 'fragments';
  if (relPath.startsWith('.gemini/')) return 'gemini';
  if (relPath.startsWith('.gemini/fragments/')) return 'fragments';
  if (relPath.startsWith('.codex/')) return 'codex';
  if (relPath.startsWith('.windsurf/workflows/')) return 'workflows';
  if (relPath.startsWith('ai-dev-tasks/')) return 'docs';
  if (relPath.startsWith('tasks/')) return 'docs';
  if (relPath.startsWith('docs/')) return 'docs';
  if (relPath.startsWith('scripts/')) return 'scripts';
  if (relPath.startsWith('memory/')) return 'memory';
  if (relPath.startsWith('.ai/')) return 'memory';
  if (relPath.startsWith('automation/')) return 'automation';
  return 'other';
}

function listTemplateFiles(root) {
  const files = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  return files;
}

function shouldIncludeByPlatform(relPath, platform) {
  if (platform === 'claude' && relPath.startsWith('.gemini/')) return false;
  if (platform === 'gemini' && relPath.startsWith('.claude/')) return false;
  return true;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(templatesRoot)) {
    console.error('❌ Templates directory not found:', templatesRoot);
    process.exit(1);
  }

  const allFiles = listTemplateFiles(templatesRoot);
  const actions = [];
  const fragmentsToAppend = [];

  for (const src of allFiles) {
    const rel = path.relative(templatesRoot, src).replaceAll('\\', '/');
    const category = relToCategory(rel);

    if (!shouldIncludeByPlatform(rel, args.platform)) continue;

    // Skip fragments if memory category not selected
    if (category === 'fragments' && !args.subset.includes('memory')) continue;
    // Skip other categories if not selected
    if (!args.subset.includes(category) && category !== 'fragments') continue;

    // Handle fragments specially - they get appended to CLAUDE.md or GEMINI.md
    if (category === 'fragments') {
      fragmentsToAppend.push({ src, rel });
      continue;
    }

    const dest = path.join(args.target, rel);
    const destDir = path.dirname(dest);
    const exists = fs.existsSync(dest);

    if (exists && !args.force) {
      actions.push({ type: 'skip', rel, reason: 'exists' });
      if (args.verbose) console.log('↷ skip (exists):', rel);
      continue;
    }

    if (!args.dryRun) {
      ensureDir(destDir);
      fs.copyFileSync(src, dest);
    }
    actions.push({ type: args.dryRun ? 'wouldWrite' : (exists ? 'overwritten' : 'written'), rel });
    if (args.verbose) console.log(args.dryRun ? '● would write:' : '✓ wrote:', rel);
  }

  // Handle fragments - append to CLAUDE.md or GEMINI.md
  if (args.subset.includes('memory') && fragmentsToAppend.length > 0) {
    for (const { src, rel } of fragmentsToAppend) {
      const fragmentContent = fs.readFileSync(src, 'utf-8');
      let targetFile;

      if (rel.includes('.claude/')) {
        targetFile = path.join(args.target, 'CLAUDE.md');
      } else if (rel.includes('.gemini/')) {
        targetFile = path.join(args.target, 'GEMINI.md');
      }

      if (targetFile) {
        const exists = fs.existsSync(targetFile);

        if (!args.dryRun) {
          if (exists) {
            // Check if fragment already appended
            const current = fs.readFileSync(targetFile, 'utf-8');
            if (!current.includes('## Autonomous Memory System')) {
              fs.appendFileSync(targetFile, '\n\n' + fragmentContent);
              actions.push({ type: 'appended', rel: `${path.basename(targetFile)} ← ${rel}` });
              if (args.verbose) console.log('✓ appended:', rel, '→', targetFile);
            } else {
              actions.push({ type: 'skip', rel: `${path.basename(targetFile)} ← ${rel}`, reason: 'already present' });
              if (args.verbose) console.log('↷ skip (already present):', rel);
            }
          } else {
            // Create new file with fragment
            fs.writeFileSync(targetFile, `# ${path.basename(args.target)}\n\n${fragmentContent}`);
            actions.push({ type: 'created', rel: targetFile });
            if (args.verbose) console.log('✓ created:', targetFile);
          }
        } else {
          actions.push({ type: 'wouldAppend', rel: `${path.basename(targetFile)} ← ${rel}` });
          if (args.verbose) console.log('● would append:', rel, '→', targetFile);
        }
      }
    }
  }

  // Ensure tasks/ exists
  if (args.subset.includes('docs')) {
    const tasksDir = path.join(args.target, 'tasks');
    ensureDir(tasksDir);
    const gitkeep = path.join(tasksDir, '.gitkeep');
    if (!fs.existsSync(gitkeep) && !args.dryRun) fs.writeFileSync(gitkeep, '');
  }

  // Ensure memory/daily/ exists for autonomous mode
  if (args.subset.includes('memory')) {
    const dailyDir = path.join(args.target, 'memory', 'daily');
    ensureDir(dailyDir);

    // Create today's daily note if it doesn't exist
    const today = new Date().toISOString().split('T')[0];
    const dailyNote = path.join(dailyDir, `${today}.md`);
    if (!fs.existsSync(dailyNote) && !args.dryRun) {
      const template = `# ${today}\n\n## Sessions\n\n*No sessions recorded yet*\n`;
      fs.writeFileSync(dailyNote, template);
    }
  }

  // Summary
  const summary = actions.reduce((acc, a) => { acc[a.type] = (acc[a.type]||0)+1; return acc; }, {});
  console.log('\nBootup summary:');
  for (const [k,v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
  console.log('\nInstalled categories:', args.subset.join(','));
  console.log('Platform:', args.platform);
  console.log('Target:', args.target);
  console.log('\nNext steps:');
  if (args.platform !== 'gemini') {
    console.log('  - Restart Claude Code if running to reload agents/skills/commands');
  }
  console.log('  - Restart Codex if running to reload skills');
  console.log('  - In Windsurf, use /dev-pipeline or individual workflows');
  if (args.platform !== 'claude') {
    console.log('  - In Gemini CLI, skills will be auto-discovered; use /skills list to verify');
  }
  console.log('  - In Codex CLI/IDE, run /skills (or type $) to invoke skills');

  if (args.subset.includes('memory') || args.subset.includes('automation')) {
    console.log('\n🤖 Autonomous Agent Mode:');
    console.log('  - Memory system initialized in memory/');
    console.log('  - Heartbeat configuration in automation/HEARTBEAT.md');
    console.log('  - Use /autonomous-bootup command to activate autonomous mode');
    console.log('  - New skills: skill-creator, memory-manager, heartbeat-manager, api-integrator, self-replicator');
  }
}

try {
  run();
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}
