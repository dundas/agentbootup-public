import fsp from 'fs/promises';
import path from 'path';
import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { isPlausibleServerUrl, isValidServerUrl, apiUrl } from '../auth/validate.js';

const REQUIRED_ENV_FIELDS = [
  'BRAIN_ID',
  'BRANCH_ID',
  'BRAIN_VOLUME',
  'BRAIN_SHARED',
  'BRAIN_BUNDLE_VERSION',
  'BRAIN_BASE_IMAGE_SHA',
  'BRAIN_DB_PATH',
  'VAULT_NAMESPACE',
];

const RO_REQUIRED_ENTRIES = ['skills', 'scripts', 'protocols', 'bin'];
const RW_REQUIRED_DIRECTORIES = ['memory', 'transcripts', 'sessions', 'state', 'cache'];
const RW_REQUIRED_FILES = ['brain.db', 'manifest.json'];
const MANIFEST_REQUIRED_FIELDS = [
  'brain_id',
  'branch_id',
  'bundle_version',
  'base_image_sha',
  'brain_db_path',
  'rw_root',
  'generated_at',
];
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;

function pushIssue(issues, severity, category, message) {
  issues.push({ severity, category, message });
}

function normalizeBranchModeOptions(options = {}) {
  return {
    brainId: typeof options.brainId === 'string' ? options.brainId.trim() : '',
    branchId: typeof options.branchId === 'string' ? options.branchId.trim() : '',
    env: options.env ?? process.env,
    fetchBranchRecord: options.fetchBranchRecord ?? fetchBranchRecordFromServer,
  };
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function statPath(targetPath) {
  try {
    return await fsp.stat(targetPath);
  } catch {
    return null;
  }
}

async function realpathIfExists(targetPath) {
  try {
    return await fsp.realpath(targetPath);
  } catch {
    return null;
  }
}

function parseDotEnv(raw) {
  const parsed = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      // This parser is intentionally minimal: outer quotes are removed, but
      // shell-style escaping is not interpreted because branch runtime files
      // only need simple key/value contract fields in v0.1.
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function isWithinRoot(candidatePath, rootPath) {
  const rel = path.relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateIsoUtc(value) {
  return typeof value === 'string' && ISO_UTC_RE.test(value);
}

async function fetchBranchRecordFromServer({ brainId, branchId }) {
  const credentialState = await inspectCredentials();
  if (credentialState.state !== CREDS_STATE_OK) {
    throw new Error(formatCredentialsRecoveryMessage(credentialState, { includeErrorDetail: true }));
  }
  const creds = credentialState.creds;
  if (!isValidServerUrl(creds.serverUrl) || !isPlausibleServerUrl(creds.serverUrl)) {
    throw new Error(`Invalid serverUrl in credentials: "${creds.serverUrl}"`);
  }

  const response = await fetch(
    apiUrl(creds.serverUrl, `/v1/brains/${encodeURIComponent(brainId)}/branches/${encodeURIComponent(branchId)}`),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
      },
      signal: AbortSignal.timeout(5_000),
    },
  );

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body?.error?.message || message;
    } catch {
      // Ignore non-JSON bodies.
    }
    throw new Error(message);
  }

  const body = await response.json();
  return body?.data ?? null;
}

export async function runBranchModeDoctor(rawOptions = {}) {
  const issues = [];
  const options = normalizeBranchModeOptions(rawOptions);

  if (!options.brainId) {
    pushIssue(issues, 'error', 'provisioning', 'branch-mode doctor requires --brain <id>.');
  }
  if (!options.branchId) {
    pushIssue(issues, 'error', 'provisioning', 'branch-mode doctor requires --branch <id>.');
  }
  if (issues.length > 0) {
    return issues;
  }

  const runtimeEnv = { ...options.env };
  let rwRoot = null;
  if (hasNonEmptyString(runtimeEnv.BRAIN_DB_PATH)) {
    rwRoot = path.dirname(path.resolve(runtimeEnv.BRAIN_DB_PATH)); // nosemgrep: path-join-resolve-traversal -- branch-mode doctor resolves operator-provided runtime mount paths locally, then validates they stay within the declared RW root
    const envFilePath = path.join(rwRoot, '.env'); // nosemgrep: path-join-resolve-traversal -- fixed contract filename under the already-resolved RW root for local validation only
    if (await pathExists(envFilePath)) {
      try {
        const envFile = parseDotEnv(await fsp.readFile(envFilePath, 'utf-8'));
        Object.assign(runtimeEnv, envFile, { ...runtimeEnv });
      } catch (err) {
        pushIssue(
          issues,
          'error',
          'provisioning',
          `Could not parse branch runtime env file at ${envFilePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  for (const field of REQUIRED_ENV_FIELDS) {
    if (!hasNonEmptyString(runtimeEnv[field])) {
      pushIssue(issues, 'error', 'provisioning', `Missing required branch runtime env var: ${field}`);
    }
  }
  if (issues.some((issue) => issue.category === 'provisioning')) {
    return issues;
  }

  const brainId = options.brainId;
  const branchId = options.branchId;
  const brainDbPath = path.resolve(runtimeEnv.BRAIN_DB_PATH); // nosemgrep: path-join-resolve-traversal -- branch-mode doctor validates an explicit local runtime path before any further file access
  rwRoot = path.dirname(brainDbPath);
  const roRoot = path.resolve(runtimeEnv.BRAIN_SHARED); // nosemgrep: path-join-resolve-traversal -- shared-root path comes from the runtime contract and is checked as a local absolute path before traversal-sensitive reads
  const manifestPath = path.join(rwRoot, 'manifest.json'); // nosemgrep: path-join-resolve-traversal -- fixed contract filename under the validated RW root
  const envFilePath = path.join(rwRoot, '.env'); // nosemgrep: path-join-resolve-traversal -- fixed contract filename under the validated RW root

  if (runtimeEnv.BRAIN_ID !== brainId) {
    pushIssue(issues, 'error', 'drift', `Runtime BRAIN_ID '${runtimeEnv.BRAIN_ID}' does not match requested brain '${brainId}'.`);
  }
  if (runtimeEnv.BRANCH_ID !== branchId) {
    pushIssue(issues, 'error', 'drift', `Runtime BRANCH_ID '${runtimeEnv.BRANCH_ID}' does not match requested branch '${branchId}'.`);
  }

  if (!path.isAbsolute(runtimeEnv.BRAIN_SHARED)) {
    pushIssue(issues, 'error', 'contract', `BRAIN_SHARED must be an absolute path; got '${runtimeEnv.BRAIN_SHARED}'.`);
  }
  if (!path.isAbsolute(runtimeEnv.BRAIN_DB_PATH)) {
    pushIssue(issues, 'error', 'contract', `BRAIN_DB_PATH must be an absolute path; got '${runtimeEnv.BRAIN_DB_PATH}'.`);
  }
  if (path.basename(brainDbPath) !== 'brain.db') {
    pushIssue(issues, 'error', 'contract', `BRAIN_DB_PATH must point to brain.db; got '${runtimeEnv.BRAIN_DB_PATH}'.`);
  }
  if (!isWithinRoot(brainDbPath, rwRoot)) {
    pushIssue(issues, 'error', 'contract', `BRAIN_DB_PATH '${runtimeEnv.BRAIN_DB_PATH}' must resolve inside the RW root '${rwRoot}'.`);
  }

  const roRootStat = await statPath(roRoot);
  if (!roRootStat?.isDirectory()) {
    pushIssue(issues, 'error', 'contract', `Shared RO root not found or not a directory: ${roRoot}`);
  } else {
    const resolvedRoRoot = await realpathIfExists(roRoot);
    const resolvedRwRoot = await realpathIfExists(rwRoot);
    for (const entry of RO_REQUIRED_ENTRIES) {
      const entryPath = path.join(roRoot, entry); // nosemgrep: path-join-resolve-traversal -- entry is selected from a fixed allowlist of required RO directories
      const entryStat = await statPath(entryPath);
      if (!entryStat?.isDirectory()) {
        pushIssue(issues, 'error', 'contract', `Shared RO root is missing required directory: ${entryPath}`);
      }
    }
    const roSkillsPath = path.join(roRoot, 'skills'); // nosemgrep: path-join-resolve-traversal -- fixed RO contract path
    const resolvedRoSkillsPath = await realpathIfExists(roSkillsPath);
    if (
      resolvedRoSkillsPath &&
      resolvedRwRoot &&
      isWithinRoot(resolvedRoSkillsPath, resolvedRwRoot)
    ) {
      pushIssue(issues, 'error', 'contract', `Skills path '${roSkillsPath}' must resolve from the RO root, not inside '${rwRoot}'.`);
    }
    if (
      resolvedRoSkillsPath &&
      resolvedRoRoot &&
      !isWithinRoot(resolvedRoSkillsPath, resolvedRoRoot)
    ) {
      pushIssue(issues, 'error', 'contract', `Skills path '${roSkillsPath}' must resolve inside the RO root '${roRoot}'.`);
    }
  }

  const rwRootStat = await statPath(rwRoot);
  if (!rwRootStat?.isDirectory()) {
    pushIssue(issues, 'error', 'contract', `RW root not found or not a directory: ${rwRoot}`);
  } else {
    for (const entry of RW_REQUIRED_DIRECTORIES) {
      const entryPath = path.join(rwRoot, entry); // nosemgrep: path-join-resolve-traversal -- entry is selected from a fixed allowlist of required RW directories
      const entryStat = await statPath(entryPath);
      if (!entryStat?.isDirectory()) {
        pushIssue(issues, 'error', 'contract', `RW root is missing required directory: ${entryPath}`);
      }
    }
    for (const entry of RW_REQUIRED_FILES) {
      const entryPath = path.join(rwRoot, entry); // nosemgrep: path-join-resolve-traversal -- entry is selected from a fixed allowlist of required RW files
      const entryStat = await statPath(entryPath);
      if (!entryStat?.isFile()) {
        pushIssue(issues, 'error', 'contract', `RW root is missing required file: ${entryPath}`);
      }
    }
    if (!await pathExists(envFilePath)) {
      pushIssue(issues, 'error', 'provisioning', `RW root is missing required env file: ${envFilePath}`);
    }
  }

  let manifest = null;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
  } catch (err) {
    pushIssue(
      issues,
      'error',
      'contract',
      `manifest.json is missing or invalid at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (manifest && typeof manifest === 'object') {
    for (const field of MANIFEST_REQUIRED_FIELDS) {
      if (!hasNonEmptyString(manifest[field])) {
        pushIssue(issues, 'error', 'contract', `manifest.json is missing required field '${field}'.`);
      }
    }

    if (hasNonEmptyString(manifest.generated_at) && !validateIsoUtc(manifest.generated_at)) {
      pushIssue(issues, 'error', 'contract', `manifest.json field 'generated_at' must be an ISO-8601 UTC timestamp; got '${manifest.generated_at}'.`);
    }

    if (hasNonEmptyString(manifest.brain_id) && manifest.brain_id !== brainId) {
      pushIssue(issues, 'error', 'drift', `manifest.json brain_id '${manifest.brain_id}' does not match requested brain '${brainId}'.`);
    }
    if (hasNonEmptyString(manifest.branch_id) && manifest.branch_id !== branchId) {
      pushIssue(issues, 'error', 'drift', `manifest.json branch_id '${manifest.branch_id}' does not match requested branch '${branchId}'.`);
    }
    if (hasNonEmptyString(manifest.brain_id) && manifest.brain_id !== runtimeEnv.BRAIN_ID) {
      pushIssue(issues, 'error', 'drift', `manifest.json brain_id '${manifest.brain_id}' does not match runtime BRAIN_ID '${runtimeEnv.BRAIN_ID}'.`);
    }
    if (hasNonEmptyString(manifest.branch_id) && manifest.branch_id !== runtimeEnv.BRANCH_ID) {
      pushIssue(issues, 'error', 'drift', `manifest.json branch_id '${manifest.branch_id}' does not match runtime BRANCH_ID '${runtimeEnv.BRANCH_ID}'.`);
    }
    if (hasNonEmptyString(manifest.bundle_version) && manifest.bundle_version !== runtimeEnv.BRAIN_BUNDLE_VERSION) {
      pushIssue(issues, 'error', 'drift', `manifest.json bundle_version '${manifest.bundle_version}' does not match runtime BRAIN_BUNDLE_VERSION '${runtimeEnv.BRAIN_BUNDLE_VERSION}'.`);
    }
    if (hasNonEmptyString(manifest.base_image_sha) && manifest.base_image_sha !== runtimeEnv.BRAIN_BASE_IMAGE_SHA) {
      pushIssue(issues, 'error', 'drift', `manifest.json base_image_sha '${manifest.base_image_sha}' does not match runtime BRAIN_BASE_IMAGE_SHA '${runtimeEnv.BRAIN_BASE_IMAGE_SHA}'.`);
    }

    const manifestRwRoot = hasNonEmptyString(manifest.rw_root)
      ? path.resolve(manifest.rw_root) // nosemgrep: path-join-resolve-traversal -- manifest rw_root is resolved only to compare against the already-validated runtime RW root
      : null;
    if (manifestRwRoot && manifestRwRoot !== rwRoot) {
      pushIssue(issues, 'error', 'contract', `manifest.json rw_root '${manifest.rw_root}' does not match resolved RW root '${rwRoot}'.`);
    }

    if (hasNonEmptyString(manifest.brain_db_path)) {
      const manifestBrainDbPath = path.resolve(manifest.brain_db_path); // nosemgrep: path-join-resolve-traversal -- manifest brain_db_path is resolved only for local containment comparison against the RW root
      if (!isWithinRoot(manifestBrainDbPath, rwRoot)) {
        pushIssue(issues, 'error', 'contract', `manifest.json brain_db_path '${manifest.brain_db_path}' must resolve inside the RW root '${rwRoot}'.`);
      }
      if (manifestBrainDbPath !== brainDbPath) {
        pushIssue(issues, 'error', 'drift', `manifest.json brain_db_path '${manifest.brain_db_path}' does not match runtime BRAIN_DB_PATH '${runtimeEnv.BRAIN_DB_PATH}'.`);
      }
    }
  }

  try {
    const branch = await options.fetchBranchRecord({ brainId, branchId });
    if (!branch) {
      pushIssue(issues, 'error', 'drift', `Branch '${branchId}' for brain '${brainId}' is missing from the registry.`);
      return issues;
    }

    if (branch.status === 'deleted') {
      pushIssue(issues, 'error', 'drift', `Registry branch '${branchId}' for brain '${brainId}' is marked deleted.`);
      return issues;
    }
    if (hasNonEmptyString(branch.base_image_sha) && branch.base_image_sha !== runtimeEnv.BRAIN_BASE_IMAGE_SHA) {
      pushIssue(issues, 'error', 'drift', `Registry base_image_sha '${branch.base_image_sha}' does not match runtime BRAIN_BASE_IMAGE_SHA '${runtimeEnv.BRAIN_BASE_IMAGE_SHA}'.`);
    }
    if (hasNonEmptyString(branch.bundle_version) && branch.bundle_version !== runtimeEnv.BRAIN_BUNDLE_VERSION) {
      pushIssue(issues, 'error', 'drift', `Registry bundle_version '${branch.bundle_version}' does not match runtime BRAIN_BUNDLE_VERSION '${runtimeEnv.BRAIN_BUNDLE_VERSION}'.`);
    }
    if (manifest && hasNonEmptyString(branch.base_image_sha) && hasNonEmptyString(manifest.base_image_sha) && branch.base_image_sha !== manifest.base_image_sha) {
      pushIssue(issues, 'error', 'drift', `Registry base_image_sha '${branch.base_image_sha}' does not match manifest.json base_image_sha '${manifest.base_image_sha}'.`);
    }
  } catch (err) {
    pushIssue(
      issues,
      'warning',
      'general',
      `Could not load branch registry record for (${brainId}, ${branchId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return issues;
}
