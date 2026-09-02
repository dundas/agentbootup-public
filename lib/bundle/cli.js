import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractCwd, getFlagValue, hasFlag } from '../network/args.js';
import { getAgentId } from '../project-config.js';
import { loadNetworkConfig, resolveProjectPath } from '../network/config.js';
import { loadEnvManifest } from '../network/env-manifest.js';
import {
  bundleStatus,
  buildEffectiveInstallManifest,
  installBundle,
  loadBundleManifest,
  publishBundle,
  rehashBundleManifest,
  rollbackBundle,
} from './installer.js';
import { collectDeclaredBundleEntries, reportBundleManifest } from './report.js';
import { runHostedBundleSync } from './remote-sync.js';
import {
  enableSelfManaged,
  disableSelfManaged,
  readSelfManaged,
  isSelfManaged,
  SELF_MANAGED_MARKER_RELATIVE,
} from './self-managed.js';

const DOCS_URL = 'https://registry.mechdna.net/agentbootup';
const BUNDLE_EXIT_CODES = Object.freeze({
  INTERNAL: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  UPSTREAM: 6,
  VERIFICATION: 7,
  TIMEOUT: 124,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readPackageVersion() {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function usage() {
  return [
    'Usage: agentbootup bundle <subcommand> [options]',
    `Version: ${readPackageVersion()}`,
    `Docs: ${DOCS_URL}`,
    'Source: agentbootup bundle CLI',
    '',
    'Subcommands:',
    '  publish --manifest <path> [--source-root <dir>] [--dry-run] [--json]',
    '  report --manifest <path> [--source-root <dir>] [--target-root <dir>] [--roots-config <path>] [--json]',
    '  status --manifest <path> [--source-root <dir>] [--target-root <dir>] [--json]',
    '  rehash --manifest <path> [--source-root <dir>] [--dry-run] [--json]',
    '  install --manifest <path> [--source-root <dir>] [--target-root <dir>] [--force] [--dry-run] [--skip-validation|--no-validate] [--materialize-agents] [--json]',
    '  rollback --manifest <path> [--target-root <dir>] [--dry-run] [--json]',
    '  sync <selector> [--target-root <dir>] [--cli <csv>] [--force] [--dry-run] [--no-reindex] [--materialize-agents] [--json]',
    '  rollout <selector> [--source-root <dir>] [--all | --env <name> | --project <id[,id]> | --brain <id[,id]>] [--dry-run] [--skip-validation|--no-validate] [--materialize-agents] [--json]',
    '  rollout telemetry [--source-root <dir>] [--all | --env <name> | --project <id[,id]> | --brain <id[,id]>] [--dry-run] [--skip-validation|--no-validate] [--materialize-agents] [--json]',
    '  self-manage enable|disable|status [--target-root <dir>] [--reason <text>] [--json]  pin a repo against canonical protocol sync',
    '',
    'Selectors:',
    '  all         install all discovered skill/protocol bundle manifests',
    '  all-core    alias for broad shared rollout (uses all manifests when no skills-manifest exists)',
    '  telemetry   per-brain rollout: fetch each brain skill-usage telemetry from the server,',
    '              install only skills the brain actually uses (use_count > 0) plus core infra',
    '  a,b,c       targeted rollout of explicit bundle_name entries',
  ].join('\n');
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function manifestArgOrThrow(args) {
  const manifestPath = getFlagValue(args, '--manifest');
  if (!manifestPath) throw new Error('Missing required --manifest');
  return manifestPath;
}

function sourceRootFromArgs(args, cwd) {
  const explicit = getFlagValue(args, '--source-root');
  return path.resolve(explicit || cwd);
}

function targetRootFromArgs(args, cwd) {
  const explicit = getFlagValue(args, '--target-root');
  return path.resolve(explicit || cwd);
}

function configPathFromArgs(args) {
  return getFlagValue(args, '--roots-config') || undefined;
}

function printBundleStatus(io, status) {
  io.stdout(`bundle_type:   ${status.bundle_type}`);
  io.stdout(`bundle_name:   ${status.bundle_name}`);
  io.stdout(`version:       ${status.bundle_version}`);
  io.stdout(`version_id:    ${status.version_id}`);
  io.stdout(`distribution:  ${status.distribution_mode}`);
  io.stdout(`source_root:   ${status.source_root}`);
  io.stdout(`target_root:   ${status.target_root}`);
  io.stdout(`file_count:    ${status.file_count}`);
  io.stdout(`manifest_hash: ${status.manifest_hash}`);
  io.stdout(`actual_hash:   ${status.actual_hash}`);
  io.stdout(`hash_status:   ${status.hash_status}`);
  if (status.self_managed) {
    io.stdout(`self_managed:  yes${status.self_managed_reason ? ` — ${status.self_managed_reason}` : ''}`);
  }
  io.stdout(`agent_id:      ${status.agent_id}`);
  io.stdout(`state_path:    ${status.installed_state_path}`);
  io.stdout(`installed:     ${status.installed ? 'yes' : 'no'}`);
  if (status.installed_state) {
    io.stdout(`state.status:  ${status.installed_state.status}`);
    io.stdout(`state.id:      ${status.installed_state.version_id ?? '(none)'}`);
    io.stdout(`backup_path:   ${status.installed_state.backup_path ?? '(none)'}`);
  }
  io.stdout(`target_status: ${status.target_status}`);
  io.stdout(`installed_payload_hash: ${status.installed_payload_hash ?? '(not applied)'}`);
  io.stdout(`installed_payload_hash_status: ${status.installed_payload_hash_status ?? 'UNKNOWN'}`);
  for (const target of status.missing_required_targets ?? []) {
    io.stdout(`  missing:     ${target}`);
  }
}

function printBundleReport(io, manifest, status, findings, report, statusError = null) {
  const payloadTargets = manifestPayloadRoots(manifest);
  const declaredTargets = manifestPayloadRoots({ files: findings.entries });
  io.stdout(`bundle_name:   ${status.bundle_name}`);
  io.stdout(`manifest:      ${status.bundle_name} (${status.version_id})`);
  io.stdout(`config_path:   ${findings.configPath}`);
  io.stdout(`config_mode:   ${findings.configMode}`);
  io.stdout(`hash_status:   ${status.hash_status}`);
  io.stdout(`manifest_files: ${status.file_count}`);
  io.stdout(`declared_files: ${findings.entries.length}`);
  io.stdout(`payload_targets: ${payloadTargets.join(', ') || '(none)'}`);
  if (JSON.stringify(payloadTargets) !== JSON.stringify(declaredTargets)) {
    io.stdout(`declared_targets: ${declaredTargets.join(', ') || '(none)'}`);
  }
  io.stdout(`target_status: ${status.target_status}`);
  io.stdout(`installed_payload_hash_status: ${status.installed_payload_hash_status ?? 'UNKNOWN'}`);

  if (statusError) {
    io.stderr(`warning: unable to fully recompute bundle hash: ${statusError}`);
  }
  for (const warning of report.warnings) {
    io.stderr(`warning: ${warning}`);
  }
  if (report.asymmetry) {
    io.stderr(
      `advisory: skill tree asymmetry for ${status.bundle_name}; present=${report.asymmetry.present.join(', ') || '(none)'} missing=${report.asymmetry.missing.join(', ') || '(none)'}`,
    );
  }
  if (report.missingFiles.length > 0) {
    io.stderr('drift: declared source files missing from manifest files[]');
    for (const entry of report.missingFiles) {
      io.stderr(`  - ${entry.source} -> ${entry.target}`);
    }
  }
  if (report.undeclaredManifestFiles.length > 0) {
    io.stderr('drift: manifest files[] includes entries not currently present under declared roots');
    for (const file of report.undeclaredManifestFiles) {
      io.stderr(`  - ${file.source} -> ${file.target}`);
    }
  }
}

function payloadRootForTarget(target) {
  const normalized = String(target || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments[0] === 'memory') return 'memory';
  if (segments[0] === 'brain') {
    if (segments.length === 1) return 'brain';
    if (segments[1] === 'scripts') return 'brain/scripts';
  }
  if (segments[0].startsWith('.')) {
    if (segments.length === 1) return segments[0];
    return `${segments[0]}/${segments[1]}`;
  }
  if (segments.length === 1) return segments[0];
  // Generic fallback for novel non-dot target layouts. Two-segment paths return the
  // first segment (`docs/LICENSE` -> `docs`), while deeper trees keep the first two
  // segments as the displayed payload surface (`docs/api/openapi.json` -> `docs/api`).
  if (segments.length === 2) return segments[0];
  return `${segments[0]}/${segments[1]}`;
}

function manifestPayloadRoots({ files }) {
  const roots = [];
  for (const file of files) {
    const root = payloadRootForTarget(file.target);
    if (root) roots.push(root);
  }
  return [...new Set(roots)].sort();
}

function mergePayloadTargets(manifest, extraTargets = []) {
  return [...new Set([...manifestPayloadRoots(manifest), ...extraTargets])].sort();
}

function payloadTargetsForInstallResult(manifest, result, options = {}) {
  if (result?.noop) return mergePayloadTargets(manifest, result.materialized_targets ?? []);
  if (result?.effective_manifest) return manifestPayloadRoots(result.effective_manifest);
  return manifestPayloadRoots(buildEffectiveInstallManifest(manifest, options));
}

function discoverBundleManifests(sourceRoot) {
  const manifests = [];
  const skillRoot = path.join(sourceRoot, '.claude', 'skills');
  if (fs.existsSync(skillRoot)) {
    for (const name of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const manifestPath = path.join(skillRoot, name.name, 'skill-bundle-manifest.json');
      if (fs.existsSync(manifestPath)) manifests.push(manifestPath);
    }
  }

  const protocolRoot = path.join(sourceRoot, '.ai', 'protocols');
  if (fs.existsSync(protocolRoot)) {
    const stack = [protocolRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(abs);
        else if (entry.isFile() && entry.name === 'protocol-bundle-manifest.json') manifests.push(abs);
      }
    }
  }

  return manifests.sort();
}

function selectManifestPaths(sourceRoot, selector) {
  const all = discoverBundleManifests(sourceRoot);
  if (selector === 'all' || selector === 'all-core') {
    return all;
  }
  const requested = new Set(splitCsv(selector));
  return all.filter((manifestPath) => {
    const { manifest } = loadBundleManifest(manifestPath);
    return requested.has(manifest.bundle_name);
  });
}

function resolveRolloutTargets(cwd, args) {
  const { config } = loadNetworkConfig(cwd);
  let projects = [...(config.projects || [])];

  const envName = getFlagValue(args, '--env');
  if (envName) {
    const envManifest = loadEnvManifest(cwd, envName, config);
    const allow = new Set(envManifest.orderedProjectIds);
    projects = projects.filter((project) => allow.has(project.id));
  } else if (hasFlag(args, '--all')) {
    projects = [...projects];
  } else if (getFlagValue(args, '--project')) {
    const allow = new Set(splitCsv(getFlagValue(args, '--project')));
    projects = projects.filter((project) => allow.has(project.id));
  } else if (getFlagValue(args, '--brain')) {
    const allow = new Set(splitCsv(getFlagValue(args, '--brain')));
    projects = projects.filter((project) => allow.has(project.agent_id));
  } else {
    throw new Error('bundle rollout requires one of --all, --env, --project, or --brain');
  }

  return projects
    .map((project) => ({
      ...project,
      resolvedPath: resolveProjectPath(project.path, cwd),
    }))
    .filter((project) => Boolean(project.resolvedPath));
}

function stripJsonFlag(args) {
  return args.filter((arg) => arg !== '--json');
}

function createModeIo(io, jsonMode) {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line) => {
        stdout.push(line);
        if (!jsonMode) io.stdout(line);
      },
      stderr: (line) => {
        stderr.push(line);
        io.stderr(line);
      },
    },
  };
}

function buildJsonEnvelope(command, startedAt, success, modeCapture, extra = {}) {
  const envelope = {
    success,
    command,
    durationMs: Date.now() - startedAt,
    mode: 'json',
  };
  if (success) {
    envelope.data = {
      stdout: modeCapture.stdout,
      stderr: modeCapture.stderr,
      ...(extra.data ?? {}),
    };
  } else {
    envelope.error = extra.error;
    envelope.data = {
      stdout: modeCapture.stdout,
      stderr: modeCapture.stderr,
      ...(extra.data ?? {}),
    };
  }
  return envelope;
}

function emitJsonEnvelope(io, envelope) {
  io.stdout(JSON.stringify(envelope));
}

function classifyBundleError(error, fallbackMessage = 'bundle failed') {
  const message = error instanceof Error ? error.message : String(error ?? fallbackMessage);
  if (
    /Missing required --|requires one of|requires a selector|does not support --skip-validation|must be a non-empty|must include|must be an object|must be a file|must be a repo-relative path|must stay within the repo|Invalid bundle roots config|Unsupported bundle mutation type/i
      .test(message)
  ) {
    return { message, code: 'USAGE_ERROR', exitCode: BUNDLE_EXIT_CODES.USAGE, retryable: false };
  }
  if (/No bundle manifests matched|No rollout targets matched/i.test(message)) {
    return { message, code: 'NOT_FOUND', exitCode: BUNDLE_EXIT_CODES.NOT_FOUND, retryable: false };
  }
  if (/no credentials|auth login|HTTP 401|HTTP 403|unauthorized|forbidden/i.test(message)) {
    return { message, code: 'AUTH_ERROR', exitCode: BUNDLE_EXIT_CODES.AUTH, retryable: false };
  }
  if (/timed out after \d+ms/i.test(message)) {
    return { message, code: 'TIMEOUT', exitCode: BUNDLE_EXIT_CODES.TIMEOUT, retryable: true };
  }
  if (
    /Bundle hash mismatch|Required source file missing|Validation failed|missing dependency|unable to fully recompute bundle hash|Backup file missing during rollback|Backup metadata missing|No backup_path recorded|target file\(s\) are missing \(eroded\)|Install verification failed/i
      .test(message)
  ) {
    return { message, code: 'VERIFICATION_FAILED', exitCode: BUNDLE_EXIT_CODES.VERIFICATION, retryable: false };
  }
  if (/credential|network|fetch|upstream|HTTP \d+/i.test(message)) {
    return { message, code: 'UPSTREAM_ERROR', exitCode: BUNDLE_EXIT_CODES.UPSTREAM, retryable: true };
  }
  return { message, code: 'INTERNAL_ERROR', exitCode: BUNDLE_EXIT_CODES.INTERNAL, retryable: false };
}

export function summarizeFailureExit(errors, fallbackMessage) {
  if (!Array.isArray(errors) || errors.length === 0) {
    throw new Error('bundle failure summary requires at least one concrete error');
  }
  const normalized = errors.map((error) => classifyBundleError(error, fallbackMessage));
  // Prefer the most operator-actionable failure class when a multi-target sync/rollout
  // mixes causes. Drift/verification remains last so a concurrent auth/upstream failure
  // surfaces the reason an operator must resolve before any verification can succeed.
  const precedence = [
    'AUTH_ERROR',
    'TIMEOUT',
    'UPSTREAM_ERROR',
    'NOT_FOUND',
    'INTERNAL_ERROR',
    'USAGE_ERROR',
    'VERIFICATION_FAILED',
  ];
  for (const code of precedence) {
    const match = normalized.find((item) => item.code === code);
    if (!match) continue;
    return {
      ...match,
      message: fallbackMessage,
      retryable: normalized.some((item) => item.code === code && item.retryable),
    };
  }
  throw new Error('bundle failure summary could not classify any error result');
}

export async function runBundleCommand(args, io, deps = {}) {
  const extracted = extractCwd(args);
  const cwd = path.resolve(extracted.cwd);
  const jsonMode = hasFlag(extracted.args, '--json');
  const rest = stripJsonFlag(extracted.args);
  const subcommand = rest[0];
  const command = `agentbootup bundle${subcommand ? ` ${subcommand}` : ''}`;
  const startedAt = Date.now();
  const capture = createModeIo(io, jsonMode);

  const finishSuccess = (data = {}) => {
    if (jsonMode) {
      emitJsonEnvelope(io, buildJsonEnvelope(command, startedAt, true, capture, { data }));
    }
    return 0;
  };

  const finishFailure = (error, opts = {}) => {
    const normalized =
      error && typeof error === 'object' && 'exitCode' in error && 'code' in error
        ? error
        : classifyBundleError(error, opts.fallbackMessage);
    if (opts.printHuman !== false && !jsonMode) {
      capture.io.stderr(`bundle failed: ${normalized.message}`);
    }
    if (jsonMode) {
      emitJsonEnvelope(
        io,
        buildJsonEnvelope(command, startedAt, false, capture, {
          error: {
            message: normalized.message,
            code: normalized.code,
            exitCode: normalized.exitCode,
            retryable: Boolean(normalized.retryable),
            ...(normalized.hint ? { hint: normalized.hint } : {}),
          },
          data: opts.data ?? {},
        }),
      );
    }
    return normalized.exitCode;
  };

  try {
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      capture.io.stdout(usage());
      return finishSuccess({ help: true });
    }

    if (subcommand === 'publish') {
      const manifestPath = manifestArgOrThrow(rest);
      const sourceRoot = sourceRootFromArgs(rest, cwd);
      const { manifest, raw, schemaWarnings } = loadBundleManifest(path.resolve(sourceRoot, manifestPath));
      const published = publishBundle({
        manifest,
        rawManifest: raw,
        sourceRoot,
        dryRun: hasFlag(rest, '--dry-run'),
      });
      capture.io.stdout(
        `${published.dry_run ? 'Would publish' : 'Published'} ${manifest.bundle_type} ${manifest.bundle_name} → ${published.publish_root}`,
      );
      // Deprecation warnings come from the raw manifest (aliases are resolved away by
      // normalization), so surface them at publish — the moment to fix them.
      for (const warning of schemaWarnings ?? []) {
        capture.io.stderr(`deprecation: ${warning}`);
      }
      for (const warning of published.taxonomy_warnings ?? []) {
        capture.io.stderr(`taxonomy warning: ${warning}`);
      }
      return finishSuccess({
        bundleName: manifest.bundle_name,
        bundleType: manifest.bundle_type,
        versionId: manifest.version_id,
        publishRoot: published.publish_root,
        dryRun: Boolean(published.dry_run),
      });
    }

    if (subcommand === 'status') {
      const manifestPath = manifestArgOrThrow(rest);
      const sourceRoot = sourceRootFromArgs(rest, cwd);
      const targetRoot = targetRootFromArgs(rest, cwd);
      const { manifest } = loadBundleManifest(path.resolve(sourceRoot, manifestPath));
      const status = bundleStatus({ manifest, sourceRoot, targetRoot });
      printBundleStatus(capture.io, status);
      return finishSuccess({ status });
    }

    if (subcommand === 'report') {
      const manifestPath = manifestArgOrThrow(rest);
      const sourceRoot = sourceRootFromArgs(rest, cwd);
      const targetRoot = targetRootFromArgs(rest, cwd);
      const configPath = configPathFromArgs(rest);
      const { manifest } = loadBundleManifest(path.resolve(sourceRoot, manifestPath));
      let statusError = null;
      let status;
      try {
        status = bundleStatus({ manifest, sourceRoot, targetRoot });
      } catch (error) {
        statusError = error instanceof Error ? error.message : String(error);
        status = {
          bundle_type: manifest.bundle_type,
          bundle_name: manifest.bundle_name,
          bundle_version: manifest.bundle_version,
          version_id: manifest.version_id,
          distribution_mode: manifest.distribution?.mode ?? 'unknown',
          source_root: sourceRoot,
          target_root: targetRoot,
          file_count: manifest.files.length,
          manifest_hash: manifest.bundle_hash,
          actual_hash: '(unavailable)',
          hash_status: 'DRIFT',
          installed: false,
          installed_state_path: '(unavailable)',
          installed_state: null,
          agent_id: '(unknown)',
          // Target state is genuinely unknown here: bundleStatus threw on a source-side
          // error, so no target verification ran. Do not claim NOT_APPLIED — that would
          // read as "nothing was installed" when we simply did not look.
          target_status: 'UNKNOWN',
          missing_required_targets: [],
          installed_payload_hash: null,
          installed_payload_hash_status: 'UNKNOWN',
          missing_payload_targets: [],
        };
      }
      const findings = collectDeclaredBundleEntries(sourceRoot, manifest.bundle_name, { configPath });
      const report = reportBundleManifest({ manifest, findings });
      printBundleReport(capture.io, manifest, status, findings, report, statusError);
      const hasMissingRequiredTargets = status.target_status === 'MISSING_REQUIRED';
      const hasDrift = status.hash_status !== 'OK' || status.installed_payload_hash_status === 'DRIFT' || report.drift;
      if (hasMissingRequiredTargets) {
        for (const target of status.missing_required_targets) {
          capture.io.stderr(`missing required target: ${target}`);
        }
        return finishFailure(
          {
            message: hasDrift
              ? 'bundle report detected missing required target file(s) and drift — ledger says this bundle was applied but payload is eroded'
              : 'bundle report detected missing required target file(s) — ledger says this bundle was applied but payload is eroded',
            code: 'VERIFICATION_FAILED',
            exitCode: BUNDLE_EXIT_CODES.VERIFICATION,
            retryable: false,
          },
          {
            printHuman: false,
            data: { status, findings, report },
          },
        );
      }
      if (hasDrift) {
        return finishFailure(
          {
            message: 'bundle report detected drift',
            code: 'VERIFICATION_FAILED',
            exitCode: BUNDLE_EXIT_CODES.VERIFICATION,
            retryable: false,
          },
          {
            printHuman: false,
            data: { status, findings, report },
          },
        );
      }
      // A self-managed protocol bundle intentionally diverges from canonical; it is NOT
      // drift (the operator declared it). Exit success — but surface it explicitly so the
      // divergence is visible and not a silent canonical-OK. Automation that cares can check
      // status.target_status === 'SELF_MANAGED' in the JSON payload.
      if (status.self_managed && status.target_status === 'SELF_MANAGED') {
        capture.io.stdout(`self-managed: intentionally diverged from canonical${status.self_managed_reason ? ` (${status.self_managed_reason})` : ''}; not flagged as drift`);
      }
      return finishSuccess({ status, findings, report });
    }

    if (subcommand === 'rehash') {
      const manifestArg = manifestArgOrThrow(rest);
      const sourceRoot = sourceRootFromArgs(rest, cwd);
      const { manifest, manifestPath } = loadBundleManifest(path.resolve(sourceRoot, manifestArg));
      const updated = rehashBundleManifest(manifest, sourceRoot, { manifestPath });
      const changed = manifest.bundle_hash !== updated.bundle_hash || manifest.version_id !== updated.version_id;
      const dryRun = hasFlag(rest, '--dry-run');
      if (!dryRun) {
        fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
      }
      capture.io.stdout(
        changed
          ? `${dryRun ? 'Would rehash' : 'Rehashed'} ${updated.bundle_name} (${updated.version_id})`
          : `${dryRun ? 'Would keep' : 'Kept'} ${updated.bundle_name} (${updated.version_id})`,
      );
      capture.io.stdout(`manifest:     ${manifestPath}`);
      capture.io.stdout(`old_hash:     ${manifest.bundle_hash}`);
      capture.io.stdout(`new_hash:     ${updated.bundle_hash}`);
      return finishSuccess({ manifestPath, updated, changed, dryRun });
    }

    if (subcommand === 'install') {
      const manifestPath = manifestArgOrThrow(rest);
      const sourceRoot = sourceRootFromArgs(rest, cwd);
      const targetRoot = targetRootFromArgs(rest, cwd);
      const { manifest, raw } = loadBundleManifest(path.resolve(sourceRoot, manifestPath));
      const skipValidation = hasFlag(rest, '--skip-validation') || hasFlag(rest, '--no-validate');
      const materializeAgents = hasFlag(rest, '--materialize-agents');
      if (skipValidation) {
        capture.io.stderr('Warning: validation will be skipped for applied installs; runtime verification will not run.');
      }
      const result = installBundle({
        manifest,
        rawManifest: raw,
        sourceRoot,
        targetRoot,
        force: hasFlag(rest, '--force'),
        dryRun: hasFlag(rest, '--dry-run'),
        skipValidation,
        materializeAgents,
      });
      capture.io.stdout(
        result.noop
          ? result.reason
          : `${result.dry_run ? 'Dry-run installed' : 'Installed'} ${manifest.bundle_name} (${manifest.version_id})`,
      );
      if (result.repaired_drift) {
        const actual = result.repaired_drift.actual_hash ?? 'unverifiable';
        const missing = result.repaired_drift.missing_targets.length > 0
          ? `; missing: ${result.repaired_drift.missing_targets.join(', ')}`
          : '';
        capture.io.stderr(
          `drift detected: installed payload hash ${actual} does not match ${result.repaired_drift.expected_hash}${missing}; ${result.dry_run ? 'would repair' : 'repairing'}`,
        );
      }
      if (!result.noop || hasFlag(rest, '--dry-run')) {
        capture.io.stdout(`payload_targets: ${payloadTargetsForInstallResult(manifest, result, { materializeAgents }).join(', ') || '(none)'}`);
      }
      if (!result.noop) {
        capture.io.stdout(`agent_id:   ${result.agent_id}`);
        capture.io.stdout(`backup:     ${result.backup_path}`);
        capture.io.stdout(`state_path: ${result.state_path}`);
      }
      return finishSuccess({ result, bundleName: manifest.bundle_name, versionId: manifest.version_id });
    }

    if (subcommand === 'rollback') {
      const manifestPath = manifestArgOrThrow(rest);
      const targetRoot = targetRootFromArgs(rest, cwd);
      const { manifest } = loadBundleManifest(path.resolve(cwd, manifestPath));
      const result = rollbackBundle({
        manifest,
        targetRoot,
        dryRun: hasFlag(rest, '--dry-run'),
      });
      capture.io.stdout(`${result.dry_run ? 'Dry-run rollback complete' : 'Rollback complete'} for ${manifest.bundle_name}`);
      capture.io.stdout(`state_path: ${result.state_path}`);
      return finishSuccess({ result, bundleName: manifest.bundle_name, versionId: manifest.version_id });
    }

    if (subcommand === 'sync') {
      if (hasFlag(rest, '--skip-validation') || hasFlag(rest, '--no-validate')) {
        throw new Error('bundle sync does not support --skip-validation or --no-validate; hosted sync strips validation commands before install');
      }
      const selector = rest[1];
      const targetRoot = targetRootFromArgs(rest, cwd);
      const summary = await runHostedBundleSync({
        selector,
        cwd,
        targetRoot,
        force: hasFlag(rest, '--force'),
        dryRun: hasFlag(rest, '--dry-run'),
        noReindex: hasFlag(rest, '--no-reindex'),
        materializeAgents: hasFlag(rest, '--materialize-agents'),
        cliCsv: getFlagValue(rest, '--cli'),
        io: capture.io,
        ...(deps.requestSyncFn ? { requestSyncFn: deps.requestSyncFn } : {}),
        ...(deps.credentialsReader ? { credentialsReader: deps.credentialsReader } : {}),
      });

      capture.io.stdout(`bundle sync: ${summary.results.length} bundle result(s), ${summary.skipped.length} skipped${summary.self_managed_skipped ? `, ${summary.self_managed_skipped} self-managed` : ''}`);
      for (const result of summary.results) {
        if (result.status === 'installed') {
          capture.io.stdout(`  + ${result.bundle_name} ${result.version_id}`);
        } else if (result.status === 'noop') {
          capture.io.stdout(`  = ${result.bundle_name} ${result.version_id}`);
        } else if (result.status === 'skipped_self_managed') {
          capture.io.stdout(`  ~ ${result.bundle_name} ${result.version_id} (self-managed — protocol skipped)`);
        } else {
          capture.io.stderr(`  x ${result.bundle_name}: ${result.error}`);
        }
      }
      for (const skipped of summary.skipped) {
        capture.io.stdout(`  - ${skipped.id}: ${skipped.reason}`);
      }
      if (summary.reindexed) {
        capture.io.stdout('bundle sync: reindexed local skills');
      }
      if (summary.failures > 0) {
        capture.io.stderr(`bundle sync failed for ${summary.failures} bundle(s)`);
        return finishFailure(
          summarizeFailureExit(
            summary.results.filter((result) => result.status === 'failed').map((result) => result.error),
            `bundle sync failed for ${summary.failures} bundle(s)`,
          ),
          { printHuman: false, data: { summary } },
        );
      }
      capture.io.stdout(`${summary.dryRun ? 'Dry-run sync complete' : 'Sync complete'}.`);
      return finishSuccess({ summary });
    }

    if (subcommand === 'rollout') {
      const selector = rest[1];
      if (!selector) throw new Error('bundle rollout requires a selector (all | all-core | telemetry | comma-separated bundle names)');
      const sourceRoot = sourceRootFromArgs(rest, cwd);
      const targets = resolveRolloutTargets(cwd, rest);
      const dryRun = hasFlag(rest, '--dry-run');
      const skipValidation = hasFlag(rest, '--skip-validation') || hasFlag(rest, '--no-validate');
      const materializeAgents = hasFlag(rest, '--materialize-agents');
      if (skipValidation) {
        capture.io.stderr('Warning: validation will be skipped for applied rollout installs; runtime verification will not run.');
      }

      if (targets.length === 0) {
        throw new Error('No rollout targets matched the provided selector');
      }

      let failures = 0;
      const rolloutErrors = [];

      if (selector === 'telemetry') {
        // Telemetry-driven rollout: each target brain gets a different set of
        // manifests, selected from its skill-usage telemetry on the hosted
        // server. The selection happens per-target, not once for all.
        const { resolveTelemetrySkills, filterManifestsBySkillNames } = await import('./skill-usage-selector.js');
        const allManifestPaths = discoverBundleManifests(sourceRoot);
        if (allManifestPaths.length === 0) {
          throw new Error(`No bundle manifests discovered under ${sourceRoot}`);
        }
        // Cache loaded manifests once — avoids O(targets × manifests) redundant file I/O
        // (loadBundleManifest does readFileSync + JSON.parse + schema scan each call).
        const manifestCache = new Map();
        const cachedLoad = (p) => {
          if (!manifestCache.has(p)) manifestCache.set(p, loadBundleManifest(p));
          return manifestCache.get(p);
        };
        capture.io.stdout(`bundle rollout: telemetry-driven → ${targets.length} target(s)`);
        for (const target of targets) {
          const { skills, source: telemetrySource } = await resolveTelemetrySkills(target.agent_id);
          const targetManifestPaths = filterManifestsBySkillNames(allManifestPaths, skills, cachedLoad);
          const targetManifests = targetManifestPaths.map(cachedLoad);
          capture.io.stdout(`target ${target.id} (${target.agent_id}) → ${target.resolvedPath} [${telemetrySource}, ${targetManifests.length} bundle(s)]`);
          for (const { manifest, raw } of targetManifests) {
            try {
              const result = installBundle({
                manifest,
                rawManifest: raw,
                sourceRoot,
                targetRoot: target.resolvedPath,
                dryRun,
                agentId: target.agent_id,
                skipValidation,
                materializeAgents,
              });
              capture.io.stdout(`  ${result.noop ? '=' : '+'} ${manifest.bundle_name} ${manifest.version_id}`);
            } catch (error) {
              failures += 1;
              const message = error instanceof Error ? error.message : String(error);
              rolloutErrors.push(message);
              capture.io.stderr(`  x ${manifest.bundle_name}: ${message}`);
            }
          }
        }
      } else {
        const manifestPaths = selectManifestPaths(sourceRoot, selector);
        if (manifestPaths.length === 0) {
          throw new Error(`No bundle manifests matched selector "${selector}" under ${sourceRoot}`);
        }
        capture.io.stdout(`bundle rollout: ${manifestPaths.length} bundle(s) → ${targets.length} target(s)`);
        // Load + normalize each manifest once; it does not depend on the target, so there
        // is no need to re-read and re-validate it N times across the target loop.
        const loadedManifests = manifestPaths.map((manifestPath) => loadBundleManifest(manifestPath));
        for (const target of targets) {
          capture.io.stdout(`target ${target.id} (${target.agent_id}) → ${target.resolvedPath}`);
          for (const { manifest, raw } of loadedManifests) {
            try {
              const result = installBundle({
                manifest,
                rawManifest: raw,
                sourceRoot,
                targetRoot: target.resolvedPath,
                dryRun,
                agentId: target.agent_id,
                skipValidation,
                materializeAgents,
              });
              capture.io.stdout(`  ${result.noop ? '=' : '+'} ${manifest.bundle_name} ${manifest.version_id}`);
            } catch (error) {
              failures += 1;
              const message = error instanceof Error ? error.message : String(error);
              rolloutErrors.push(message);
              capture.io.stderr(`  x ${manifest.bundle_name}: ${message}`);
            }
          }
        }
        if (failures > 0) {
          capture.io.stderr(`bundle rollout failed for ${failures} install(s)`);
          return finishFailure(
            summarizeFailureExit(
              rolloutErrors,
              `bundle rollout failed for ${failures} install(s)`,
            ),
            { printHuman: false, data: { selector, manifestPaths, targets, failures, dryRun } },
          );
        }
        capture.io.stdout(`${dryRun ? 'Dry-run rollout complete' : 'Rollout complete'}.`);
        return finishSuccess({ selector, manifestPaths, targets, dryRun, skipValidation });
      }
      if (failures > 0) {
        capture.io.stderr(`bundle rollout failed for ${failures} install(s)`);
        return finishFailure(
          summarizeFailureExit(
            rolloutErrors,
            `bundle rollout failed for ${failures} install(s)`,
          ),
          { printHuman: false, data: { selector, targets, failures, dryRun } },
        );
      }
      capture.io.stdout(`${dryRun ? 'Dry-run rollout complete' : 'Rollout complete'}.`);
      return finishSuccess({ selector, targets, dryRun, skipValidation });
    }

    if (subcommand === 'self-manage') {
      // `agentbootup bundle self-manage enable|disable|status [--target-root <dir>] [--reason <text>]`
      // Per-brain pin against canonical protocol sync. A self-managed repo's committed
      // protocol amendment is NOT overwritten by `bundle sync` (the clobber that wipes a
      // local amendment like circle_computer's 0f) and `bundle status` reports
      // SELF_MANAGED instead of DRIFT. Read/write the marker at .ai/protocols/self-managed.json
      // (NOT a bundle target, so it cannot itself drift). See lib/bundle/self-managed.js.
      const action = rest[1];
      const targetRoot = targetRootFromArgs(rest, cwd);
      const reason = getFlagValue(rest, '--reason');

      if (action === 'enable') {
        // pinned_by is best-effort audit metadata: a repo with a broken agentbootup.json must
        // still be able to pin itself (the pin is a safety mechanism, and broken config is
        // exactly when local protocol changes need protection). Do not let getAgentId throw
        // block the enable.
        let pinnedBy;
        try {
          pinnedBy = getAgentId(targetRoot) || undefined;
        } catch {
          pinnedBy = undefined;
        }
        const marker = enableSelfManaged(targetRoot, { reason, pinned_by: pinnedBy });
        capture.io.stdout(`bundle self-manage: enabled for ${targetRoot}`);
        capture.io.stdout(`  marker:  ${SELF_MANAGED_MARKER_RELATIVE}`);
        capture.io.stdout(`  reason:  ${marker.reason}`);
        capture.io.stdout(`  pinned:  ${marker.pinned_at}${marker.pinned_by ? ` by ${marker.pinned_by}` : ''}`);
        capture.io.stdout('  bundle sync will skip protocol bundles for this repo; non-protocol bundles still sync.');
        capture.io.stdout('  bundle status reports SELF_MANAGED on target fields for protocol bundles.');
        return finishSuccess({ action: 'enable', target_root: targetRoot, marker });
      }

      if (action === 'disable') {
        const removed = disableSelfManaged(targetRoot);
        capture.io.stdout(`bundle self-manage: ${removed ? 'disabled' : 'already disabled'} for ${targetRoot}`);
        return finishSuccess({ action: 'disable', target_root: targetRoot, removed });
      }

      if (action === 'status' || !action) {
        const marker = readSelfManaged(targetRoot);
        const enabled = marker?.enabled === true;
        capture.io.stdout(`bundle self-manage: ${enabled ? 'ENABLED' : 'disabled'} for ${targetRoot}`);
        if (enabled) {
          capture.io.stdout(`  reason:  ${marker.reason}`);
          capture.io.stdout(`  pinned:  ${marker.pinned_at}${marker.pinned_by ? ` by ${marker.pinned_by}` : ''}`);
        } else if (marker && 'malformed' in marker && marker.malformed) {
          capture.io.stderr(`  warning: marker present but malformed — ${marker.malformed}; not pinning (DRIFT will surface)`);
        }
        return finishSuccess({ action: 'status', target_root: targetRoot, self_managed: enabled, marker });
      }

      return finishFailure(
        { message: `bundle self-manage: unknown action '${action}' (expected enable|disable|status)`, code: 'USAGE_ERROR', exitCode: BUNDLE_EXIT_CODES.USAGE, retryable: false },
        { printHuman: false, data: { help: true } },
      );
    }

    capture.io.stdout(usage());
    return finishFailure(
      {
        message: `Unknown bundle subcommand: ${subcommand}`,
        code: 'USAGE_ERROR',
        exitCode: BUNDLE_EXIT_CODES.USAGE,
        retryable: false,
      },
      { printHuman: false, data: { help: true } },
    );
  } catch (error) {
    return finishFailure(error);
  }
}
