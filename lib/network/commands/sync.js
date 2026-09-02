import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { loadNetworkConfig } from '../config.js';
import { extractCwd, getPositionalArgs, hasFlag } from '../args.js';

function copyDir(fromDir, toDir, dryRun, force = false) {
  if (!fs.existsSync(fromDir)) {
    return { status: 'skip', reason: `missing source ${fromDir}`, target: '' };
  }
  let copied = 0;
  let skipped = 0;
  let blocked = 0;

  const walk = (srcDir, destDir) => {
    if (fs.existsSync(destDir) && !fs.statSync(destDir).isDirectory()) {
      blocked += 1;
      return;
    }
    if (!dryRun) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, destPath);
        continue;
      }

      if (fs.existsSync(destPath) && !force) {
        skipped += 1;
        continue;
      }

      copied += 1;
      if (!dryRun) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };

  walk(fromDir, toDir);

  if (copied === 0) {
    const reason = blocked > 0
      ? `${fromDir} -> ${toDir} (blocked by ${blocked} file path conflict${blocked === 1 ? '' : 's'})`
      : skipped > 0
      ? `${fromDir} -> ${toDir} (preserved ${skipped} existing file${skipped === 1 ? '' : 's'})`
      : `${fromDir} -> ${toDir} (no files to sync)`;
    return { status: 'skip', reason, target: toDir };
  }

  const status = dryRun ? 'would-copy' : 'copied';
  const details = [`${copied} file${copied === 1 ? '' : 's'} synced`];
  if (skipped > 0) details.push(`${skipped} preserved`);
  if (blocked > 0) details.push(`${blocked} blocked`);
  const summary = details.join(', ');
  return { status, reason: `${fromDir} -> ${toDir} (${summary})`, target: toDir };
}

function copyFile(fromFile, toFile, dryRun, force = false) {
  if (!fs.existsSync(fromFile)) {
    return { status: 'skip', reason: `missing source ${fromFile}`, target: '' };
  }
  if (fs.existsSync(toFile) && !force) {
    return { status: 'skip', reason: `target exists ${toFile} (use --force to overwrite)`, target: toFile };
  }

  if (dryRun) {
    return { status: 'would-copy', reason: `${fromFile} -> ${toFile}`, target: toFile };
  }

  fs.mkdirSync(path.dirname(toFile), { recursive: true });
  fs.copyFileSync(fromFile, toFile);
  return { status: 'copied', reason: `${fromFile} -> ${toFile}`, target: toFile };
}

function syncProject(project, sourceRoot, dryRun, force = false) {
  const results = [];

  const dirPairs = [
    ['.claude/skills', '.claude/skills'],
    ['.agents/skills', '.agents/skills'],
    ['.agents/agents', '.agents/agents'],
    ['.agents/commands', '.agents/commands'],
  ];

  for (const [srcRel, destRel] of dirPairs) {
    results.push(copyDir(path.join(sourceRoot, srcRel), path.join(project.path, destRel), dryRun, force));
  }

  const filePairs = [
    ['AGENTS.md', 'AGENTS.md'],
    ['GEMINI.md', 'GEMINI.md'],
  ];

  for (const [srcRel, destRel] of filePairs) {
    results.push(copyFile(path.join(sourceRoot, srcRel), path.join(project.path, destRel), dryRun, force));
  }

  return results;
}

export function runSyncCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;
  const dryRun = extracted.args.includes('--dry-run');
  const force = hasFlag(extracted.args, '--force');
  const commit = hasFlag(extracted.args, '--commit');
  const [targetId = ''] = getPositionalArgs(extracted.args);

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`sync failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  const sourceRoot = path.resolve(cwd, config.skills_source || '.');

  if (config.role !== 'network') {
    io.stdout('sync project mode: not implemented for standalone project role');
    return 0;
  }

  let projects = config.projects || [];
  if (targetId) {
    projects = projects.filter((project) => project.id === targetId);
    if (projects.length === 0) {
      io.stderr(`sync failed: unknown project ${targetId}`);
      return 1;
    }
  }

  io.stdout(dryRun ? 'Sync dry run' : 'Sync execution');
  io.stdout(`Source: ${sourceRoot}`);
  if (force) {
    io.stdout('Overwrite mode: enabled');
  }
  if (commit) {
    io.stdout('Commit mode: enabled');
  }

  let syncFailures = 0;
  for (const project of projects) {
    if (!project.path) {
      io.stdout(`Project: ${project.id} — skipped (not linked)`);
      continue;
    }
    io.stdout(`Project: ${project.id}`);
    const results = syncProject(project, sourceRoot, dryRun, force);
    const changedTargets = [];
    for (const result of results) {
      io.stdout(`  - ${result.status}: ${result.reason}`);
      if ((result.status === 'copied' || result.status === 'would-copy') && result.target) {
        changedTargets.push(result.target);
      }
    }

    if (commit && !dryRun && changedTargets.length > 0) {
      const add = spawnSync('git', ['add', '--', ...changedTargets], { cwd: project.path, encoding: 'utf-8' });
      if ((add.status ?? 1) !== 0) {
        io.stderr(`  - commit failed: git add error (${(add.stderr || add.stdout || '').trim()})`);
        syncFailures += 1;
        continue;
      }

      const hasStaged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: project.path, encoding: 'utf-8' });
      if ((hasStaged.status ?? 1) === 0) {
        io.stdout('  - commit skipped: no staged changes after sync');
        continue;
      }

      const commitProc = spawnSync(
        'git',
        ['commit', '-m', 'chore(agentbootup): sync skills from network root'],
        { cwd: project.path, encoding: 'utf-8' }
      );
      if ((commitProc.status ?? 1) !== 0) {
        io.stderr(`  - commit failed: ${(commitProc.stderr || commitProc.stdout || '').trim()}`);
        syncFailures += 1;
      } else {
        io.stdout('  - committed synced files');
      }
    }
  }

  return syncFailures > 0 ? 1 : 0;
}
