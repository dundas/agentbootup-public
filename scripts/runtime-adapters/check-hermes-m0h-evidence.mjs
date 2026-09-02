#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRawSecretViolations } from '../../lib/runtime-adapters/security.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const POLICY_PATH = path.join(REPO_ROOT, 'config/hermes-m0h-evidence-policy-v1.json');
const FORBIDDEN_TEXT_SOURCES = [
  '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
  'SYNTHETIC_SECRET_DO_NOT_USE_',
  '(?:^|[^A-Za-z0-9_])(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}',
  '(?:^|[^A-Za-z0-9_])(?:\\.env|auth\\.json)(?:$|[^A-Za-z0-9_])',
  '(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis)://[^\\s"\']+',
  '(?:/home/runner|/private/tmp|/var/tmp/hermes-m0h\\.|[A-Za-z]:\\\\Users\\\\)',
];
const FORBIDDEN_TEXT_REGEXES = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/imu,
  /SYNTHETIC_SECRET_DO_NOT_USE_/imu,
  /(?:^|[^A-Za-z0-9_])(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}/imu,
  /(?:^|[^A-Za-z0-9_])(?:\.env|auth\.json)(?:$|[^A-Za-z0-9_])/imu,
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"']+/imu,
  /(?:\/home\/runner|\/private\/tmp|\/var\/tmp\/hermes-m0h\.|[A-Za-z]:\\Users\\)/imu,
];
const TRACKED_FORBIDDEN_TEXT_SOURCES = [
  '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
  '(?:^|[^A-Za-z0-9_])(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{32,}',
  '(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis)://[^\\s"\']+',
];
const TRACKED_FORBIDDEN_TEXT_REGEXES = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/imu,
  /(?:^|[^A-Za-z0-9_])(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{32,}/imu,
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"']+/imu,
];

function fail(message) {
  throw new Error(`Hermes M0-H evidence policy rejected: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) fail(`${label} fields drifted`);
}

function sortedUnique(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    fail(`${label} must be a string array`);
  }
  if (new Set(values).size !== values.length || values.join('\0') !== [...values].sort().join('\0')) {
    fail(`${label} must be sorted and unique`);
  }
}

export function validatePolicy(policy) {
  exactKeys(policy, ['artifacts', 'content', 'dependencies', 'retentionMaxDays', 'schema', 'tracked'], 'policy');
  if (policy.schema !== 'agentbootup.hermes-m0h-evidence-policy/v1') fail('policy schema drifted');
  if (!Number.isInteger(policy.retentionMaxDays) || policy.retentionMaxDays < 1 || policy.retentionMaxDays > 7) {
    fail('retention maximum must be an integer from one through seven');
  }
  sortedUnique(policy.dependencies, 'policy dependencies');
  for (const dependency of policy.dependencies) {
    if (path.posix.normalize(dependency) !== dependency || path.posix.isAbsolute(dependency) ||
        dependency.startsWith('../') || dependency.includes('\\') || dependency.includes('\0')) {
      fail('policy dependency is not a normalized repository-relative path');
    }
  }
  for (const [label, section, key] of [
    ['tracked', policy.tracked, 'path'],
    ['artifacts', policy.artifacts, 'name'],
  ]) {
    exactKeys(section, ['maxFileBytes', 'maxTotalBytes', 'members'], `${label} policy`);
    if (!Array.isArray(section.members) ||
        !Number.isInteger(section.maxFileBytes) || section.maxFileBytes < 1 ||
        !Number.isInteger(section.maxTotalBytes) || section.maxTotalBytes < section.maxFileBytes) {
      fail(`${label} budgets or cardinality drifted`);
    }
    const names = section.members.map((row) => {
      exactKeys(row, label === 'tracked' ? ['path', 'redistribution'] : ['name', 'schema'], `${label} member`);
      const name = row[key];
      if (typeof name !== 'string' || path.posix.normalize(name) !== name || path.posix.isAbsolute(name) ||
          name.startsWith('../') || name.includes('\\') || name.includes('\0')) {
        fail(`${label} member name is not a normalized repository-relative path`);
      }
      if (label === 'tracked' &&
          !['source_repository_only', 'npm_package_metadata', 'project_authored_facts_only'].includes(row.redistribution)) {
        fail('tracked redistribution classification is invalid');
      }
      if (label === 'artifacts' &&
          (typeof row.schema !== 'string' || !row.schema.startsWith('agentbootup.'))) {
        fail('artifact schema must be explicit');
      }
      return name;
    });
    sortedUnique(names, `${label} members`);
  }
  exactKeys(policy.content, [
    'forbiddenExtensions', 'forbiddenMagicHex', 'forbiddenTextPatterns', 'json',
    'trackedForbiddenTextPatterns',
  ], 'content policy');
  sortedUnique(policy.content.forbiddenExtensions, 'forbidden extensions');
  sortedUnique(policy.content.forbiddenMagicHex, 'forbidden magic');
  if (policy.content.forbiddenTextPatterns?.join('\0') !== FORBIDDEN_TEXT_SOURCES.join('\0')) {
    fail('forbidden text patterns drifted from reviewed literals');
  }
  if (policy.content.trackedForbiddenTextPatterns?.join('\0') !==
      TRACKED_FORBIDDEN_TEXT_SOURCES.join('\0')) {
    fail('tracked forbidden text patterns drifted from reviewed literals');
  }
  exactKeys(policy.content.json, ['maxDepth', 'maxKeys', 'maxStringBytes'], 'JSON limits');
  for (const value of Object.values(policy.content.json)) {
    if (!Number.isInteger(value) || value < 1) fail('JSON limits must be positive integers');
  }
  return policy;
}

export function loadPolicy(policyPath = POLICY_PATH) {
  const text = fs.readFileSync(policyPath, 'utf8');
  rejectDuplicateJsonKeys(text);
  return validatePolicy(JSON.parse(text));
}

function regularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`${label} must be one regular, non-linked file`);
  return stat;
}

function forbiddenExtension(name, policy) {
  const lower = name.toLowerCase();
  return policy.content.forbiddenExtensions.some((extension) => lower.endsWith(extension));
}

function forbiddenMagic(bytes, policy) {
  const hex = bytes.subarray(0, 32).toString('hex');
  return policy.content.forbiddenMagicHex.some((magic) => hex.startsWith(magic)) ||
    bytes.subarray(257, 262).toString('ascii') === 'ustar';
}

function inspectJsonShape(value, limits, state, depth = 0) {
  if (depth > limits.maxDepth) fail('JSON depth budget exceeded');
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > limits.maxStringBytes) fail('JSON string budget exceeded');
    if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) ||
        /^\\\\[^\\]+\\[^\\]+/u.test(value)) {
      fail('JSON contains an absolute host path');
    }
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('JSON contains a non-finite number');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectJsonShape(item, limits, state, depth + 1);
    return;
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('JSON contains a non-plain object');
  const keys = Object.keys(value);
  state.keys += keys.length;
  if (state.keys > limits.maxKeys) fail('JSON key budget exceeded');
  for (const key of keys) {
    if (Buffer.byteLength(key) > limits.maxStringBytes) fail('JSON key budget exceeded');
    inspectJsonShape(value[key], limits, state, depth + 1);
  }
}

function rejectDuplicateJsonKeys(text) {
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === '"') break;
        index += 1;
      }
      if (index >= text.length) return;
      const top = stack.at(-1);
      if (top?.type === 'object' && top.expectKey) {
        let key;
        try {
          key = JSON.parse(text.slice(start, index + 1));
        } catch {
          return;
        }
        if (top.keys.has(key)) fail('JSON contains a duplicate object key');
        top.keys.add(key);
        top.expectKey = false;
      }
      continue;
    }
    if (char === '{') stack.push({ type: 'object', keys: new Set(), expectKey: true });
    else if (char === '[') stack.push({ type: 'array' });
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && stack.at(-1)?.type === 'object') stack.at(-1).expectKey = true;
  }
}

function scanText(text, label) {
  for (const pattern of FORBIDDEN_TEXT_REGEXES) {
    if (pattern.test(text)) fail(`${label} contains forbidden secret or host-path material`);
  }
}

export function validateArtifactDirectory(artifactRoot, policy = loadPolicy()) {
  validatePolicy(policy);
  const root = path.resolve(artifactRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('artifact root must be a non-symlink directory');
  if ((rootStat.mode & 0o077) !== 0) fail('artifact root permissions exceed 0700');
  const actual = fs.readdirSync(root).sort();
  const expected = policy.artifacts.members.map((row) => row.name);
  if (actual.join('\0') !== expected.join('\0')) fail('artifact member allowlist drifted');
  let totalBytes = 0;
  for (const member of policy.artifacts.members) {
    if (forbiddenExtension(member.name, policy)) fail(`artifact ${member.name} has a forbidden extension`);
    const file = path.join(root, member.name);
    const stat = regularFile(file, `artifact ${member.name}`);
    if (stat.size > policy.artifacts.maxFileBytes) fail(`artifact ${member.name} exceeds its byte budget`);
    totalBytes += stat.size;
    const bytes = fs.readFileSync(file);
    if (forbiddenMagic(bytes, policy)) fail(`artifact ${member.name} has forbidden binary/archive magic`);
    let value;
    const text = bytes.toString('utf8');
    rejectDuplicateJsonKeys(text);
    try {
      value = JSON.parse(text);
    } catch {
      fail(`artifact ${member.name} is not valid JSON`);
    }
    inspectJsonShape(value, policy.content.json, { keys: 0 });
    if (!value || value.schema !== member.schema) fail(`artifact ${member.name} schema drifted`);
    if (findRawSecretViolations(value).length > 0) {
      fail(`artifact ${member.name} contains raw secret-shaped material`);
    }
    scanText(text, `artifact ${member.name}`);
    if ((stat.mode & 0o077) !== 0) fail(`artifact ${member.name} permissions exceed 0600`);
  }
  if (totalBytes > policy.artifacts.maxTotalBytes) {
    fail('artifact total-byte budget exceeded');
  }
  return { files: actual.length, totalBytes };
}

function git(root, args, options = {}) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', ...options });
  if (result.error) fail(`git invocation failed: ${result.error.message}`);
  return result;
}

export function validateTrackedRepository(repoRoot, policy = loadPolicy()) {
  validatePolicy(policy);
  const root = path.resolve(repoRoot);
  const declared = policy.tracked.members.map((row) => row.path);
  const discoveredResult = git(root, [
    'ls-files', '-z', '--',
    '.github/workflows/hermes-m0h-qualification.yml',
    'config/hermes-m0h-*',
    'config/runtime-adapter-support-matrix-v1.json',
    'lib/runtime-adapters/fixture-drift.js',
    'lib/runtime-adapters/registry.js',
    'package.json',
    'scripts/runtime-adapters/check-hermes-m0h-evidence.mjs',
    'scripts/runtime-adapters/hermes-m0h-*',
    'tasks/0052e-hermes-*',
    'tasks/0052e-prd-hermes-runtime-adapter.md',
    'tasks/tasks-0052e-prd-hermes-runtime-adapter.md',
    'tests/runtime-adapters/fixture-drift.test.ts',
    'tests/runtime-adapters/fixtures/hermes-m0h-evidence-forbidden.json',
    'tests/runtime-adapters/hermes-m0h-*',
    'tests/runtime-adapters/support-matrix.test.ts',
  ]);
  if (discoveredResult.status !== 0) fail('cannot enumerate tracked M0-H policy dependencies');
  const discovered = discoveredResult.stdout.split('\0').filter(Boolean).sort();
  if (discovered.join('\0') !== declared.join('\0')) fail('tracked M0-H member allowlist drifted');
  let totalBytes = 0;
  for (const relative of declared) {
    const tracked = git(root, ['ls-files', '--error-unmatch', '--', relative]);
    if (tracked.status !== 0) fail(`policy dependency ${relative} is not tracked`);
    const ignored = git(root, ['check-ignore', '--no-index', '-q', '--', relative]);
    if (ignored.status === 0 || ![1].includes(ignored.status)) fail(`policy dependency ${relative} is ignored or cannot be checked`);
    if (forbiddenExtension(relative, policy)) fail(`tracked member ${relative} has a forbidden extension`);
    const file = path.join(root, relative);
    const stat = regularFile(file, `tracked member ${relative}`);
    if (stat.size > policy.tracked.maxFileBytes) fail(`tracked member ${relative} exceeds its byte budget`);
    totalBytes += stat.size;
    const bytes = fs.readFileSync(file);
    if (forbiddenMagic(bytes, policy)) fail(`tracked member ${relative} has forbidden binary/archive magic`);
    const text = bytes.toString('utf8');
    for (const pattern of TRACKED_FORBIDDEN_TEXT_REGEXES) {
      if (pattern.test(text)) {
        fail(`tracked member ${relative} contains credential-shaped material`);
      }
    }
  }
  if (totalBytes > policy.tracked.maxTotalBytes) {
    fail('tracked total-byte budget exceeded');
  }
  for (const relative of policy.dependencies) {
    const tracked = git(root, ['ls-files', '--error-unmatch', '--', relative]);
    if (tracked.status !== 0) fail(`policy dependency ${relative} is not tracked`);
    const ignored = git(root, ['check-ignore', '--no-index', '-q', '--', relative]);
    if (ignored.status === 0 || ignored.status !== 1) {
      fail(`policy dependency ${relative} is ignored or cannot be checked`);
    }
    regularFile(path.join(root, relative), `policy dependency ${relative}`);
  }
  const allowedDependencies = new Set([...declared, ...policy.dependencies]);
  for (const relative of declared) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    if (/\.(?:[cm]?js|ts)$/u.test(relative)) {
      for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/gu)) {
        const resolved = path.relative(
          root,
          path.resolve(root, path.dirname(relative), match[1]),
        ).split(path.sep).join('/');
        if (!allowedDependencies.has(resolved)) {
          fail(`tracked member ${relative} imports undeclared dependency ${resolved}`);
        }
      }
    }
    for (const match of source.matchAll(
      /scripts\/runtime-adapters\/(?:check-hermes-m0h-evidence\.mjs|hermes-m0h-[A-Za-z0-9.-]+)/gu,
    )) {
      if (!allowedDependencies.has(match[0])) {
        fail(`tracked member ${relative} references undeclared dependency ${match[0]}`);
      }
    }
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.scripts?.['check:hermes-m0h-evidence'] !==
      'node scripts/runtime-adapters/check-hermes-m0h-evidence.mjs') {
    fail('package validator command drifted');
  }
  if (packageJson.scripts?.['project:hermes-m0h-evidence'] !==
      'node scripts/runtime-adapters/hermes-m0h-project-evidence.mjs') {
    fail('package projector command drifted');
  }
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/hermes-m0h-qualification.yml'), 'utf8');
  const retention = [...workflow.matchAll(/retention-days:\s*(\d+)/g)].map((match) => Number(match[1]));
  if (retention.length !== 1 || retention[0] > policy.retentionMaxDays) fail('workflow retention exceeds policy');
  if (/^\s+push:\s*(?:$|[\[{])/mu.test(workflow)) fail('workflow must not have a push trigger');
  const requestBoundary = workflow.match(
    /- name: Create private evidence requests[\s\S]*?env -i \\\n([\s\S]*?)"\$bun_bin" --eval/u,
  )?.[1];
  if (!requestBoundary || /\b(?:HOME|PATH)=/u.test(requestBoundary)) {
    fail('clean request boundary contains unused environment inputs');
  }
  const projectorBoundary = workflow.match(
    /trap 'rm -f "\$request"' EXIT\n\s+env -i \\\n([\s\S]*?)"\$bun_bin" "\$GITHUB_WORKSPACE\/scripts\/runtime-adapters\/hermes-m0h-project-evidence\.mjs"/u,
  )?.[1];
  if (projectorBoundary == null || /\b[A-Z][A-Z0-9_]*=/u.test(projectorBoundary)) {
    fail('clean projector boundary contains unused environment inputs');
  }
  return { files: declared.length, totalBytes };
}

function usage() {
  fail('usage: check-hermes-m0h-evidence.mjs (--tracked [repo-root] | --artifact-root directory)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const policy = loadPolicy();
    let result;
    let mode;
    if (args[0] === '--tracked' && args.length <= 2) {
      mode = 'tracked';
      result = validateTrackedRepository(args[1] ?? REPO_ROOT, policy);
    } else if (args[0] === '--artifact-root' && args.length === 2) {
      mode = 'artifact';
      result = validateArtifactDirectory(args[1], policy);
    } else {
      usage();
    }
    process.stdout.write(`${JSON.stringify({ mode, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
