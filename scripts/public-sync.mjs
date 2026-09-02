#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    command: 'check',
    policyPath: path.join(repoRoot, 'config', 'public-release-policy.json'),
    target: '',
    clean: false,
    verbose: false
  };

  if (argv[0] && !argv[0].startsWith('--')) args.command = argv[0];

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policy' && argv[i + 1]) args.policyPath = path.resolve(argv[++i]);
    else if (a === '--target' && argv[i + 1]) args.target = path.resolve(argv[++i]);
    else if (a === '--clean') args.clean = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--help' || a === '-h') printHelpAndExit(0);
  }

  if (!['check', 'export'].includes(args.command)) {
    console.error(`Unknown command: ${args.command}`);
    printHelpAndExit(1);
  }
  if (args.command === 'export' && !args.target) {
    console.error('Missing --target for export command');
    printHelpAndExit(1);
  }
  return args;
}

function printHelpAndExit(code) {
  console.log(`public-sync.mjs

Usage:
  node scripts/public-sync.mjs check [--policy <path>] [--verbose]
  node scripts/public-sync.mjs export --target <dir> [--clean] [--policy <path>] [--verbose]
`);
  process.exit(code);
}

export function loadPolicy(policyPath) {
  const raw = fs.readFileSync(policyPath, 'utf8');
  const policy = JSON.parse(raw);

  const requiredKeys = ['include_roots', 'include_files', 'exclude_roots', 'exclude_globs', 'required_files'];
  for (const key of requiredKeys) {
    if (!Array.isArray(policy[key])) {
      throw new Error(`Policy key "${key}" must be an array`);
    }
  }
  if (policy.exclude_exceptions !== undefined && !Array.isArray(policy.exclude_exceptions)) {
    throw new Error('Policy key "exclude_exceptions" must be an array when present');
  }
  return policy;
}

function gitTrackedFiles() {
  const out = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob) {
  const normalized = glob.replaceAll('\\', '/');
  const tokenized = normalized
    .replaceAll('**/', '__GLOBSTAR_SLASH__')
    .replaceAll('/**', '__SLASH_GLOBSTAR__')
    .replaceAll('**', '__GLOBSTAR__')
    .replaceAll('*', '__STAR__');

  const escaped = escapeRegex(tokenized)
    .replaceAll('__GLOBSTAR_SLASH__', '(?:.*/)?')
    .replaceAll('__SLASH_GLOBSTAR__', '(?:/.*)?')
    .replaceAll('__GLOBSTAR__', '.*')
    .replaceAll('__STAR__', '[^/]*');

  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- escapeRegex constrains policy globs to the fixed token grammar above.
  return new RegExp(`^${escaped}$`);
}

function startsWithRoot(file, root) {
  return file === root || file.startsWith(`${root}/`);
}

export function classifyFiles(files, policy) {
  const includeRootSet = new Set(policy.include_roots);
  const includeFileSet = new Set(policy.include_files);
  const excludeRootSet = new Set(policy.exclude_roots);
  const excludeExceptionSet = new Set(policy.exclude_exceptions || []);
  const excludeMatchers = policy.exclude_globs.map(globToRegex);

  const selected = [];
  const excluded = [];

  for (const file of files) {
    const inIncludedRoot = [...includeRootSet].some((root) => startsWithRoot(file, root));
    const inIncludedFile = includeFileSet.has(file);
    if (!inIncludedRoot && !inIncludedFile) continue;

    const excludedByRoot = [...excludeRootSet].some((root) => startsWithRoot(file, root));
    const excludedByGlob = excludeMatchers.some((re) => re.test(file));

    if (excludedByRoot || (excludedByGlob && !excludeExceptionSet.has(file))) {
      excluded.push(file);
      continue;
    }

    selected.push(file);
  }

  return { selected, excluded };
}

export function validateExcludeExceptions(files, policy) {
  const tracked = new Set(files);
  for (const file of policy.exclude_exceptions || []) {
    if (!tracked.has(file)) throw new Error(`Excluded-file exception is not tracked: ${file}`);
    const body = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    if (/(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|:\/\/[^\s:@]+:[^\s@]+@/u.test(body)) {
      throw new Error(`Excluded-file exception contains credential-shaped content: ${file}`);
    }
  }
}

function ensureRequiredFilesPresent(selected, policy) {
  const selectedSet = new Set(selected);
  return policy.required_files.filter((file) => !selectedSet.has(file));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanDirectory(target) {
  if (!fs.existsSync(target)) return;
  const entries = fs.readdirSync(target);
  for (const entry of entries) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
}

function copyFiles(files, target, verbose) {
  for (const rel of files) {
    const src = path.join(repoRoot, rel);
    const dest = path.join(target, rel);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    if (verbose) console.log(`copied ${rel}`);
  }
}

function writeManifest(files, target) {
  const manifestPath = path.join(target, '.public-export-manifest.txt');
  fs.writeFileSync(manifestPath, files.join('\n') + '\n', 'utf8');
}

function runCheck(policy, verbose) {
  const files = gitTrackedFiles();
  validateExcludeExceptions(files, policy);
  const { selected, excluded } = classifyFiles(files, policy);
  const missingRequired = ensureRequiredFilesPresent(selected, policy);

  console.log(`Public export candidate files: ${selected.length}`);
  if (verbose) {
    for (const file of selected) console.log(`  include: ${file}`);
  }

  if (excluded.length > 0) {
    console.log('\nExcluded by policy:');
    for (const file of excluded) console.log(`  - ${file}`);
  }
  if (missingRequired.length > 0) {
    console.error('\nMissing required public files:');
    for (const file of missingRequired) console.error(`  - ${file}`);
  }

  if (missingRequired.length > 0) process.exit(1);
  console.log('Public sync policy check passed.');
}

function runExport(policy, target, clean, verbose) {
  const files = gitTrackedFiles();
  validateExcludeExceptions(files, policy);
  const { selected, excluded } = classifyFiles(files, policy);
  const missingRequired = ensureRequiredFilesPresent(selected, policy);

  if (missingRequired.length > 0) {
    console.error('Policy validation failed before export. Run `check` and fix issues first.');
    process.exit(1);
  }

  ensureDir(target);
  if (clean) cleanDirectory(target);
  copyFiles(selected, target, verbose);
  writeManifest(selected, target);

  if (excluded.length > 0) {
    const excludedPath = path.join(target, '.public-excluded.txt');
    fs.writeFileSync(excludedPath, excluded.join('\n') + '\n', 'utf8');
  }

  console.log(`Exported ${selected.length} files to ${target}`);
  console.log('Next: review diff in the public repo and open a PR.');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy(args.policyPath);

  if (args.command === 'check') {
    runCheck(policy, args.verbose);
    return;
  }
  runExport(policy, args.target, args.clean, args.verbose);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`public-sync failed: ${err.message}`);
    process.exit(1);
  }
}
