#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;

  const args = {
    publicRepoPath: '',
    base: 'main',
    branch: `codex/public-sync-${stamp}`,
    commitMessage: 'chore: promote internal approved changes to public',
    prTitle: 'chore: promote internal approved changes to public',
    prBody: 'Automated promotion from internal repository export policy.',
    noPr: false,
    dryRun: false,
    verbose: false
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--public-repo' && argv[i + 1]) args.publicRepoPath = path.resolve(argv[++i]);
    else if (a === '--base' && argv[i + 1]) args.base = argv[++i];
    else if (a === '--branch' && argv[i + 1]) args.branch = argv[++i];
    else if (a === '--commit-message' && argv[i + 1]) args.commitMessage = argv[++i];
    else if (a === '--pr-title' && argv[i + 1]) args.prTitle = argv[++i];
    else if (a === '--pr-body' && argv[i + 1]) args.prBody = argv[++i];
    else if (a === '--no-pr') args.noPr = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--help' || a === '-h') printHelpAndExit(0);
  }

  if (!args.publicRepoPath) {
    console.error('Missing required argument: --public-repo <path>');
    printHelpAndExit(1);
  }

  return args;
}

function printHelpAndExit(code) {
  console.log(`public-promote.mjs

Usage:
  node scripts/public-promote.mjs --public-repo <path> [options]

Options:
  --base <branch>             Base branch in public repo (default: main)
  --branch <name>             Promotion branch name
  --commit-message <msg>      Commit message for promotion branch
  --pr-title <title>          Pull request title
  --pr-body <body>            Pull request body
  --no-pr                     Skip gh pr create
  --dry-run                   Print commands only
  --verbose                   Verbose output
`);
  process.exit(code);
}

function run(cmd, cwd, dryRun, verbose) {
  if (verbose || dryRun) console.log(`$ (${cwd}) ${cmd}`);
  if (dryRun) return '';
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ensureGitRepo(repoPath) {
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`Target is not a git repo: ${repoPath}`);
  }
}

function ensureCleanWorkingTree(repoPath) {
  const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8' }).trim();
  if (status) {
    throw new Error(`Public repo working tree is dirty (${repoPath}). Commit/stash changes first.`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanDirectory(target) {
  const entries = fs.readdirSync(target);
  for (const entry of entries) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
}

function copyDir(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
  }
}

function ghAvailable(repoPath) {
  try {
    execSync('gh --version', { cwd: repoPath, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const publicRepo = args.publicRepoPath;
  ensureGitRepo(publicRepo);
  ensureCleanWorkingTree(publicRepo);

  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-public-export-'));
  run(`node ${path.join(repoRoot, 'scripts', 'public-sync.mjs')} export --target ${exportDir} --clean`, repoRoot, args.dryRun, args.verbose);

  run(`git fetch origin ${args.base}`, publicRepo, args.dryRun, args.verbose);
  run(`git checkout -B ${args.branch} origin/${args.base}`, publicRepo, args.dryRun, args.verbose);

  if (!args.dryRun) cleanDirectory(publicRepo);
  if (args.verbose || args.dryRun) console.log(`Syncing export into ${publicRepo}`);
  if (!args.dryRun) copyDir(exportDir, publicRepo);

  run('git add -A', publicRepo, args.dryRun, args.verbose);
  const diffExitCode = args.dryRun
    ? 1
    : execSync('git diff --cached --quiet; echo $?', { cwd: publicRepo, encoding: 'utf8', shell: '/bin/bash' }).trim();

  if (diffExitCode === '0') {
    console.log('No public changes to promote.');
    return;
  }

  run(`git commit -m "${args.commitMessage.replaceAll('"', '\\"')}"`, publicRepo, args.dryRun, args.verbose);
  run(`git push -u origin ${args.branch}`, publicRepo, args.dryRun, args.verbose);

  if (args.noPr) {
    console.log(`Branch pushed: ${args.branch}. Create PR manually.`);
    return;
  }

  if (!ghAvailable(publicRepo)) {
    console.log('gh CLI not available. Create PR manually.');
    return;
  }

  run(
    `gh pr create --base ${args.base} --head ${args.branch} --title "${args.prTitle.replaceAll('"', '\\"')}" --body "${args.prBody.replaceAll('"', '\\"')}"`,
    publicRepo,
    args.dryRun,
    args.verbose
  );
  console.log('Promotion PR created.');
}

try {
  main();
} catch (err) {
  console.error(`public-promote failed: ${err.message}`);
  process.exit(1);
}
