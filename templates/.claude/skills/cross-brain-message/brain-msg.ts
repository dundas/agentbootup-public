#!/usr/bin/env bun

import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const WRAPPER_CHAIN_ENV = 'BRAIN_MSG_WRAPPER_CHAIN';
const WRAPPER_CHAIN_SEPARATOR = '\u001f';

function safeRealpath(pathValue) {
  try {
    return realpathSync(pathValue);
  } catch {
    return pathValue;
  }
}

const CURRENT_SCRIPT = safeRealpath(import.meta.path);

const CANONICAL_INBOX_ROOT = join(homedir(), '.brain', 'brain-inbox');
const LEGACY_INBOX_ROOTS = [
  { source: 'legacy-claude', path: join(homedir(), '.claude', 'brain-inbox') },
  { source: 'legacy-codex', path: join(homedir(), '.codex', 'brain-inbox') },
];

const SHARED_IMPLEMENTATION_CANDIDATES = [
  { source: 'explicit-env', path: process.env.BRAIN_MSG_SHARED_PATH || null },
  // Prefer the host-level shared script before any repo-local copy so restored
  // repos follow the canonical machine path when both are present.
  { source: 'user-home', path: join(homedir(), '.brain', 'brain-msg.ts') },
  { source: 'repo-local', path: fileURLToPath(new URL('../../../brain/brain-msg.ts', import.meta.url)) },
  { source: 'fallback-env', path: process.env.BRAIN_MSG_FALLBACK_PATH || null },
].filter((entry) => typeof entry.path === 'string' && entry.path.length > 0);

// Load shared brain credentials from ~/.brain/credentials as fallback.
// This makes BRAIN_API_KEY available in any repo without per-project .env setup.
const credentialsFile = join(homedir(), '.brain', 'credentials');
if (existsSync(credentialsFile)) {
  const lines = readFileSync(credentialsFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function resolveInboxRoot() {
  if (process.env.BRAIN_MSG_INBOX_ROOT) {
    return {
      source: 'explicit-env',
      path: resolve(process.env.BRAIN_MSG_INBOX_ROOT),
    };
  }
  if (existsSync(CANONICAL_INBOX_ROOT)) {
    return {
      source: 'canonical',
      path: CANONICAL_INBOX_ROOT,
    };
  }
  for (const legacy of LEGACY_INBOX_ROOTS) {
    if (existsSync(legacy.path)) {
      return legacy;
    }
  }
  return {
    source: 'canonical-default',
    path: CANONICAL_INBOX_ROOT,
  };
}

function findSharedImplementation() {
  const wrapperChain = new Set(
    (process.env[WRAPPER_CHAIN_ENV] || '')
      .split(WRAPPER_CHAIN_SEPARATOR)
      .filter((value) => value.length > 0)
  );
  return SHARED_IMPLEMENTATION_CANDIDATES.find((entry) => {
    if (!entry.path || !existsSync(entry.path)) return false;
    const resolved = safeRealpath(entry.path);
    return resolved !== CURRENT_SCRIPT && !wrapperChain.has(resolved);
  }) || null;
}

function isFallbackUsable(sharedScriptPath) {
  const projectRoot = dirname(dirname(sharedScriptPath));
  // Standalone script fallbacks are allowed; without a surrounding package.json
  // there is no reliable local dependency root for a doctor-time package probe.
  if (!existsSync(join(projectRoot, 'package.json'))) {
    return true;
  }
  return existsSync(join(projectRoot, 'node_modules', '@agentdispatch', 'cli', 'package.json'));
}

function buildDoctorReport() {
  const sharedImplementation = findSharedImplementation();
  const inboxRoot = resolveInboxRoot();
  const errors = [];
  const warnings = [];

  if (!sharedImplementation) {
    errors.push({
      code: 'SHARED_IMPLEMENTATION_MISSING',
      message:
        'Shared brain-msg implementation not found. Set BRAIN_MSG_SHARED_PATH, add ~/.brain/brain-msg.ts, or add brain/brain-msg.ts in this repo.',
    });
  } else if (sharedImplementation.source === 'repo-local') {
    warnings.push({
      code: 'REPO_LOCAL_IMPLEMENTATION_SELECTED',
      message:
        'Using repo-local brain/brain-msg.ts (Channel B canonical). Prefer BRAIN_MSG_SHARED_PATH or ~/.brain/brain-msg.ts for host parity when available.',
    });
  } else if (sharedImplementation.source === 'fallback-env' && !isFallbackUsable(sharedImplementation.path)) {
    errors.push({
      code: 'SHARED_DEPENDENCY_MISSING',
      message:
        'Configured fallback brain-msg implementation was found, but its @agentdispatch/cli dependency is missing. Install that shared checkout before using BRAIN_MSG_FALLBACK_PATH.',
    });
  }

  if (!existsSync(join(inboxRoot.path, '_registry.json'))) {
    errors.push({
      code: 'REGISTRY_MISSING',
      message: `Missing ${join(inboxRoot.path, '_registry.json')}.`,
    });
  }

  if (!existsSync(join(inboxRoot.path, '_admp.json'))) {
    errors.push({
      code: 'ADMP_CONFIG_MISSING',
      message: `Missing ${join(inboxRoot.path, '_admp.json')}.`,
    });
  }

  if (inboxRoot.source.startsWith('legacy-')) {
    warnings.push({
      code: 'LEGACY_INBOX_ROOT',
      message: `Using legacy inbox root ${inboxRoot.path}. Prefer ${CANONICAL_INBOX_ROOT}.`,
    });
  }

  return {
    status: errors.length > 0 ? 'degraded' : 'ready',
    shared_implementation: sharedImplementation
      ? { source: sharedImplementation.source, path: sharedImplementation.path }
      : null,
    inbox_root: inboxRoot,
    errors,
    warnings,
  };
}

function runDoctor(args) {
  const report = buildDoctorReport();
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[brain-msg] status: ${report.status}`);
    if (report.shared_implementation) {
      console.log(
        `[brain-msg] shared implementation: ${report.shared_implementation.source} (${report.shared_implementation.path})`
      );
    }
    console.log(`[brain-msg] inbox root: ${report.inbox_root.source} (${report.inbox_root.path})`);
    for (const entry of report.errors) {
      console.log(`[brain-msg] error ${entry.code}: ${entry.message}`);
    }
    for (const entry of report.warnings) {
      console.log(`[brain-msg] warning ${entry.code}: ${entry.message}`);
    }
  }
  process.exit(report.status === 'ready' ? 0 : 1);
}

if (process.argv[2] === 'doctor') {
  runDoctor(process.argv.slice(3));
}

const sharedImplementation = findSharedImplementation();
const sharedScript = sharedImplementation?.path;

if (!sharedScript) {
  console.error(
    '[brain-msg] shared implementation not found.\n' +
    'Options:\n' +
    '  1. Set BRAIN_MSG_SHARED_PATH=/path/to/brain-msg.ts in your environment\n' +
    '  2. Add ~/.brain/brain-msg.ts on this host\n' +
    '  3. Set BRAIN_MSG_FALLBACK_PATH=/path/to/brain-msg.ts in your environment\n' +
    '  4. Add a brain/brain-msg.ts implementation to this repo\n' +
    'See skills/cross-brain-message/SKILL.md for setup instructions.'
  );
  process.exit(1);
}

const proc = Bun.spawn({
  cmd: ['bun', sharedScript, ...process.argv.slice(2)],
  cwd: process.cwd(),
  env: {
    ...process.env,
    [WRAPPER_CHAIN_ENV]: [process.env[WRAPPER_CHAIN_ENV], CURRENT_SCRIPT]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .join(WRAPPER_CHAIN_SEPARATOR),
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

const exitCode = await proc.exited;
process.exit(exitCode);
