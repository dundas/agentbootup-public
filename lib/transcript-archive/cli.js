import fsp from 'fs/promises';
import path from 'path';
import readline from 'readline/promises';
import { createHash, randomUUID } from 'crypto';
import { inspectCredentials, CREDS_STATE_OK, formatCredentialsRecoveryMessage } from '../auth/credentials.js';
import { readConfig, getBrainId, writeConfig } from '../config/config.js';
import { getMachineId } from '../machine-id/machine-id.js';
import { getAgentId } from '../project-config.js';
import { discoverTranscriptInventory } from '../brain/transcript-discovery.js';
import { getNetworkProjects } from '../daemon/daemon-registry.js';
import { buildTranscriptProjectIndex, resolveTranscriptBrainId } from '../daemon/transcript-brain-routing.js';
import { getProviderAdapter } from './providers.js';
import { resolveTranscriptArchiveConfig } from './config.js';
import { readStableSnapshot, readStableSnapshotPart, transcriptFingerprintMatches } from './snapshot.js';
import { ArchiveLedger, getArchiveLedgerPath } from './ledger.js';
import { canonicalHash, isIsoInstant, logicalSessionKey } from './contracts.js';
import { ArchiveClientError, TRANSCRIPT_EXIT_CODES, TranscriptArchiveClient } from './client.js';
import { restoreArchiveSelection } from './restore.js';
import { buildOffloadPlan, observeHarnessStates, OFFLOAD_APPLY_GATE, OFFLOAD_PRODUCTION_VERDICT } from './offload.js';

const PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini', 'mech-run']);
export const TRANSCRIPT_EXIT_PRECEDENCE_CODES = Object.freeze([0, 2, 4, 5, 6, 1, 3, 7, 124]);
const EXIT_PRECEDENCE = new Map(TRANSCRIPT_EXIT_PRECEDENCE_CODES.map((code, rank) => [code, rank]));
const BOOKKEEPING_AVAILABILITY_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETIMEDOUT',
  'ENOENT', 'LEDGER_LOCK_TIMEOUT', 'INVENTORY_REFERENCE_MISSING']);
const DISCOVERY_DIAGNOSTIC_CODES = new Set(['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'DISCOVERY_DEPTH_EXCEEDED',
  'ENOENT', 'DISCOVERY_FAILURES_TRUNCATED', 'DISCOVERY_SYMLINK_REFUSED', 'DISCOVERY_NOT_A_DIRECTORY']);

export function transcriptUsage() {
  return [
    'Usage: agentbootup transcripts <backup|status|verify|restore|offload|mitigate-remote-copy> [options]',
    'Docs: https://registry.mechdna.net/agentbootup#transcripts',
    'Source: agentbootup transcripts CLI',
    '',
    '  backup [--all | --cwd <project>] [--cli <provider>] [--since <date>] [--dry-run] [--yes] [--json]',
    '  status [--all | --cwd <project>] [--cli <provider>] [--since <date>] [--json]',
    '  verify [--all | --cwd <project>] [--cli <provider>] [--since <date>] [--deep] [--json]',
    '  restore [--session <id> | --since <date> [--before <date>] | --archive-version <id> | --source-machine <id> | --all]',
    '          [--cli <provider>] [--brain <id> | --cwd <project>] [--native | --output-dir <path>] [--json]',
    '  offload [--older-than <duration> | --before <date> | --session <id>] [--cwd <project>] [--cli <provider>]',
    '          [--dry-run] [--apply [--yes]] [--json]',
    '  mitigate-remote-copy --redact [--repush] [--yes] [--cli <provider>] [--cwd <project>]',
    '          [--since <ISO timestamp>] [--since-basis <mtime|session|key>]',
    '          Duration units: m=minutes, h=hours, d=days, w=weeks.',
    '',
    'Manual backup and verification work without the transcript daemon.',
    'Offload apply is disabled while the production evidence verdict is PAUSE; dry-run never deletes files.',
  ].join('\n');
}

class UsageError extends Error {
  constructor(message) { super(message); this.code = 'USAGE_ERROR'; this.exitCode = TRANSCRIPT_EXIT_CODES.USAGE; }
}

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

export function uploadCheckpointStride(remainingParts) {
  return Math.max(1, Math.ceil(remainingParts / 32));
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || ['help', '--help', '-h'].includes(command)) return { command: 'help' };
  if (!['backup', 'status', 'verify', 'restore', 'offload'].includes(command)) throw new UsageError(`Unknown transcripts subcommand: ${command}`);
  const parsed = { command, all: false, cwd: null, cwdExplicit: false, cli: null, since: null, before: null,
    session: null, archiveVersion: null, sourceMachine: null, brain: null, outputDir: null, native: false,
    dryRun: false, json: false, deep: false, yes: false, apply: false, olderThan: null };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') parsed.all = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--deep') parsed.deep = true;
    else if (arg === '--yes') parsed.yes = true;
    else if (arg === '--apply') parsed.apply = true;
    else if (arg === '--native') parsed.native = true;
    else if (['--cwd', '--cli', '--since', '--before', '--session', '--archive-version', '--source-machine', '--brain', '--output-dir', '--older-than'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new UsageError(`${arg} requires a value`);
      const key = { 'archive-version': 'archiveVersion', 'source-machine': 'sourceMachine', 'output-dir': 'outputDir', 'older-than': 'olderThan' }[arg.slice(2)] ?? arg.slice(2);
      parsed[key] = argv[++i];
      if (arg === '--cwd') parsed.cwdExplicit = true;
    } else if (arg.startsWith('--cli=')) parsed.cli = arg.slice(6);
    else if (arg.startsWith('--cwd=')) { parsed.cwd = arg.slice(6); parsed.cwdExplicit = true; }
    else if (arg.startsWith('--since=')) parsed.since = arg.slice(8);
    else if (arg.startsWith('--before=')) parsed.before = arg.slice(9);
    else if (arg.startsWith('--session=')) parsed.session = arg.slice(10);
    else if (arg.startsWith('--archive-version=')) parsed.archiveVersion = arg.slice(18);
    else if (arg.startsWith('--source-machine=')) parsed.sourceMachine = arg.slice(17);
    else if (arg.startsWith('--brain=')) parsed.brain = arg.slice(8);
    else if (arg.startsWith('--output-dir=')) parsed.outputDir = arg.slice(13);
    else if (arg.startsWith('--older-than=')) parsed.olderThan = arg.slice(13);
    else if (['--help', '-h'].includes(arg)) return { command: 'help' };
    else throw new UsageError(`Unknown transcripts option: ${arg}`);
  }
  if (command !== 'restore' && parsed.all && parsed.cwd) throw new UsageError('Choose only one transcript scope: --all or --cwd');
  if (!parsed.cwd) parsed.cwd = process.cwd();
  if (parsed.cli && !PROVIDERS.has(parsed.cli)) throw new UsageError(`Unsupported transcript provider: ${parsed.cli}`);
  for (const field of ['since', 'before']) {
    if (!parsed[field]) continue;
    const timestamp = Date.parse(parsed[field]);
    if (!Number.isFinite(timestamp)) throw new UsageError(`--${field} must be an ISO date or timestamp`);
    parsed[field] = new Date(timestamp);
  }
  if (!['backup', 'offload'].includes(parsed.command) && (parsed.dryRun || parsed.yes)) throw new UsageError('--dry-run and --yes apply only to transcripts backup or offload');
  if (parsed.command !== 'offload' && (parsed.apply || parsed.olderThan)) throw new UsageError('--apply and --older-than apply only to transcripts offload');
  if (parsed.command !== 'verify' && parsed.deep) throw new UsageError('--deep applies only to transcripts verify');
  if (!['restore', 'offload'].includes(parsed.command) && (parsed.before || parsed.session || parsed.archiveVersion || parsed.sourceMachine
    || parsed.brain || parsed.outputDir || parsed.native)) throw new UsageError('restore selectors apply only to transcripts restore');
  if (parsed.command === 'restore') {
    const primary = [parsed.session, parsed.since, parsed.archiveVersion, parsed.sourceMachine, parsed.all].filter(Boolean).length;
    if (primary !== 1) throw new UsageError('transcripts restore requires exactly one of --session, --since, --archive-version, --source-machine, or --all');
    if (parsed.before && !parsed.since) throw new UsageError('--before requires --since');
    if (parsed.before && parsed.before <= parsed.since) throw new UsageError('--before must be later than --since');
    if (parsed.brain && parsed.cwdExplicit) throw new UsageError('Choose only one restore project scope: --brain or --cwd');
    if (parsed.native && parsed.outputDir) throw new UsageError('Choose only one restore destination: --native or --output-dir');
  }
  if (parsed.command === 'offload') {
    if (parsed.all || parsed.since || parsed.archiveVersion || parsed.sourceMachine || parsed.brain || parsed.outputDir || parsed.native || parsed.deep) {
      throw new UsageError('unsupported transcripts offload selector');
    }
    if (parsed.dryRun && parsed.apply) throw new UsageError('Choose only one offload mode: --dry-run or --apply');
    if (parsed.yes && !parsed.apply) throw new UsageError('--yes requires --apply for transcripts offload');
    if ([parsed.olderThan, parsed.before, parsed.session].filter(Boolean).length > 1) throw new UsageError('Choose only one offload age/session selector');
    if (parsed.olderThan) {
      const match = /^(\d+)(m|h|d|w)$/.exec(parsed.olderThan);
      if (!match || Number(match[1]) < 1) throw new UsageError('--older-than must be a positive duration such as 24h, 7d, or 2w');
      parsed.olderThanMs = Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
    }
    const scopedApply = parsed.cwdExplicit || Boolean(parsed.cli || parsed.olderThan || parsed.before || parsed.session);
    if (parsed.apply && !scopedApply) throw new UsageError('transcripts offload --apply requires an explicit --cwd, --cli, --older-than, --before, or --session scope');
  }
  if (parsed.cwd) parsed.cwd = path.resolve(parsed.cwd);
  if (parsed.outputDir) parsed.outputDir = path.resolve(parsed.outputDir);
  return parsed;
}

async function defaultConfirm(message) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(?:es)?$/i.test((await rl.question(`${message} [y/N] `)).trim()); } finally { rl.close(); }
}

function publicError(error) {
  if (error instanceof UsageError || error instanceof ArchiveClientError) return error;
  const code = error?.code === 'SNAPSHOT_CHANGED' || error?.code === 'SNAPSHOT_UNSTABLE'
    ? 'SOURCE_CHANGED' : 'INTERNAL_ERROR';
  const exitCode = code === 'SOURCE_CHANGED' ? TRANSCRIPT_EXIT_CODES.CONFLICT : TRANSCRIPT_EXIT_CODES.INTERNAL;
  const message = error instanceof Error && /^[^\r\n]{1,300}$/.test(error.message)
    ? error.message : 'transcript archive operation failed';
  return Object.assign(new Error(message), { code, exitCode });
}

export function combineExitCodes(codes) {
  if (!codes.length) return 0;
  const rank = (code) => EXIT_PRECEDENCE.get(code);
  const candidates = codes.map((code) => Number.isInteger(code) && rank(code) !== undefined
    ? { code, rank: rank(code) } : { code: TRANSCRIPT_EXIT_CODES.INTERNAL, rank: rank(TRANSCRIPT_EXIT_CODES.INTERNAL) });
  return candidates.slice(1).reduce((selected, candidate) => candidate.rank > selected.rank
    || (candidate.rank === selected.rank && candidate.code > selected.code) ? candidate : selected, candidates[0]).code;
}

function isBookkeepingAvailabilityError(error) {
  return BOOKKEEPING_AVAILABILITY_CODES.has(error?.code);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await fn(items[index], index); }
      catch (error) { results[index] = { ok: false, error: publicError(error), input: items[index] }; }
    }
  }));
  return results;
}

async function recordInventoryIsolated(ledger, items) {
  if (!items.length) return { valid: [], invalid: [] };
  const outcome = await ledger.recordInventoryEntries(items.map((item) => ({ manifest: item?.manifest, receipt: item?.receipt })), {
    isolateInvalid: true, requestedBrainIds: items.map((item) => item?.brainId),
  });
  if (!outcome || !Array.isArray(outcome.invalidIndexes)) throw new Error('ledger inventory isolation contract is unavailable');
  if (!Array.isArray(outcome.invalidEntries)) throw new Error('ledger inventory isolation classifications are unavailable');
  const invalidEntries = outcome.invalidEntries;
  const invalidEntryIndexes = new Set(invalidEntries.map((entry) => entry?.index));
  if (new Set(outcome.invalidIndexes).size !== outcome.invalidIndexes.length
    || outcome.invalidIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= items.length)
    || invalidEntryIndexes.size !== invalidEntries.length
    || outcome.invalidIndexes.length !== invalidEntries.length
    || outcome.invalidIndexes.some((index) => !invalidEntryIndexes.has(index))
    || invalidEntries.some((entry) => !Number.isSafeInteger(entry?.index) || entry.index < 0 || entry.index >= items.length
      || !['INVENTORY_METADATA_INVALID', 'QUERY_BRAIN_MISSING', 'QUERY_BRAIN_MISMATCH'].includes(entry.validationCode))) {
    throw new Error('ledger inventory isolation returned invalid classifications');
  }
  if (!Number.isSafeInteger(outcome.recorded) || outcome.recorded !== items.length - invalidEntries.length) {
    throw new Error('ledger inventory isolation did not account for every entry');
  }
  const invalidCodes = new Map(invalidEntries.map(({ index, validationCode }) => [index, validationCode]));
  return { valid: items.filter((_item, index) => !invalidCodes.has(index)),
    invalid: items.flatMap((item, index) => invalidCodes.has(index) ? [{ item, validationCode: invalidCodes.get(index) }] : []) };
}

function inventoryValidationResult({ item, validationCode }) {
  const tenantFailure = validationCode.startsWith('QUERY_BRAIN_');
  return { ok: false, brainId: item?.brainId ?? null, archiveVersionId: item?.manifest?.archiveVersionId ?? null,
    input: item, error: new ArchiveClientError(tenantFailure
      ? (validationCode === 'QUERY_BRAIN_MISSING' ? 'remote archive inventory has no requested brain binding'
        : 'remote archive inventory is not bound to the requested brain')
      : 'remote archive inventory contains invalid or unauthenticated metadata', {
      code: tenantFailure ? validationCode : 'VERIFICATION_FAILED',
      exitCode: TRANSCRIPT_EXIT_CODES.VERIFICATION,
    }) };
}

async function discover(options, deps, projects = [], limits = {}) {
  const inventoryWide = options.all || (options.command === 'offload' && !options.cwdExplicit);
  const inventory = await deps.discoverTranscriptInventory({ ...(inventoryWide ? {} : { projectRoot: options.cwd }), limits });
  if (!inventory || !Array.isArray(inventory.files) || !Array.isArray(inventory.unsupported)
    || (inventory.discoveryFailures !== undefined && !Array.isArray(inventory.discoveryFailures))) {
    throw new Error('native transcript discovery adapter returned an invalid result');
  }
  // Offload planning must prove that it evaluated the complete selected native
  // inventory. Existing backup/status/verify commands intentionally remain
  // best-effort around volatile native files and intentionally skipped roots.
  const strictNativeDiscovery = options.command === 'offload';
  const discoveryFailures = strictNativeDiscovery
    ? (inventory.discoveryFailures ?? []).filter((failure) => !options.cli || failure.provider === options.cli
      || (failure.provider === 'native' && options.cli !== 'mech-run'))
    : [];
  const mechRoots = options.cli && options.cli !== 'mech-run' ? [] : inventoryWide
    ? [...new Set(projects.filter((project) => project?.path).map((project) => path.resolve(project.path)))]
    : [options.cwd];
  for (const projectRoot of mechRoots) {
    try {
      const mechDiscovery = await deps.discoverMechRunTranscripts({ projectRoot, limits });
      if (!mechDiscovery || !Array.isArray(mechDiscovery.files) || !Array.isArray(mechDiscovery.discoveryFailures)
        || !Number.isSafeInteger(mechDiscovery.discoveryFailureOverflow) || mechDiscovery.discoveryFailureOverflow < 0) {
        throw new Error('mech-run discovery adapter returned an invalid result');
      }
      const mechFiles = mechDiscovery.files;
      inventory.files.push(...mechFiles);
      for (const failure of mechDiscovery.discoveryFailures) {
        const errorCode = DISCOVERY_DIAGNOSTIC_CODES.has(failure.errorCode) ? failure.errorCode : 'DISCOVERY_ERROR';
        discoveryFailures.push({ provider: 'mech-run', kind: 'transcripts', state: 'discovery_error',
          reason: 'directory_transcript_discovery_failed', projectRoot,
          directoryPath: failure.path, errorCode, ...(failure.scope ? { scope: failure.scope } : {}) });
      }
      if (mechDiscovery.discoveryFailureOverflow > 0) discoveryFailures.push({ provider: 'mech-run', kind: 'transcripts',
        state: 'discovery_error', reason: 'directory_transcript_discovery_failures_truncated', projectRoot,
        directoryPath: projectRoot, errorCode: 'DISCOVERY_FAILURES_TRUNCATED', omittedFailures: mechDiscovery.discoveryFailureOverflow });
    } catch (error) {
      const diagnosticCode = error?.code ?? error?.cause?.code;
      const errorCode = DISCOVERY_DIAGNOSTIC_CODES.has(diagnosticCode) ? diagnosticCode : 'DISCOVERY_ERROR';
      discoveryFailures.push({ provider: 'mech-run', kind: 'transcripts', state: 'discovery_error',
        reason: 'project_transcript_discovery_failed', projectRoot, errorCode });
    }
  }
  const seen = new Set();
  const files = [];
  for (const file of inventory.files) {
    if (options.cli && file.cli !== options.cli) continue;
    const key = `${file.cli}\0${path.resolve(file.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let stat;
    try {
      stat = await fsp.stat(file.path, { bigint: true });
    } catch (error) {
      const diagnosticCode = error?.code ?? error?.cause?.code;
      if (strictNativeDiscovery) discoveryFailures.push({ provider: file.cli, kind: 'transcripts', state: 'discovery_error',
        reason: 'native_transcript_stat_failed', directoryPath: file.path,
        errorCode: DISCOVERY_DIAGNOSTIC_CODES.has(diagnosticCode) ? diagnosticCode : 'DISCOVERY_ERROR' });
      continue;
    }
    if (!stat.isFile() || (options.since && stat.mtime < options.since)) continue;
    const modifiedAt = new Date(Number(stat.mtimeNs / 1_000_000n));
    if (options.since && modifiedAt < options.since) continue;
    files.push({ ...file, byteSize: Number(stat.size), modifiedAt: modifiedAt.toISOString(), statFingerprint: {
      device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
    } });
  }
  return { files, unsupported: inventory.unsupported.filter((item) => !options.cli || item.provider === options.cli),
    discoveryFailures };
}

function discoveryFailureResults(discovered) {
  return discovered.discoveryFailures.map((failure) => ({ ok: false, kind: 'discovery_failure',
    input: { cli: failure.provider, path: failure.directoryPath ?? failure.projectRoot }, discoveryFailure: failure,
    error: new ArchiveClientError('transcript discovery failed for a project', {
      code: 'DISCOVERY_FAILED', exitCode: TRANSCRIPT_EXIT_CODES.USAGE,
    }) }));
}

function partitionOffloadDiscoveryFailures(failures, options) {
  if (options.cli) return { blocking: failures, warnings: [] };
  const blockingProviders = new Set(['claude', 'codex', 'native', 'unknown']);
  const blocking = [];
  const warnings = [];
  for (const failure of failures) {
    if (failure.reason === 'project_registry_unavailable'
      || (options.session && failure.reason === 'session_identity_resolution_failed')
      || blockingProviders.has(failure.provider)) blocking.push(failure);
    else warnings.push(failure);
  }
  return { blocking, warnings };
}

async function selectOffloadSession(files, sessionId, limits) {
  const outcomes = await mapLimit(files, limits.uploadConcurrency, async (file) => {
    if (file.cli !== 'cursor' && file.byteSize > limits.identityByteLimit) {
      return { ok: false, input: file, error: { code: 'SNAPSHOT_TOO_LARGE' } };
    }
    const identity = await getProviderAdapter(file.cli).parseIdentity(file, { trustedRoot: file.root, limits });
    if (identity.method !== 'embedded_metadata') {
      return { ok: false, input: file, error: { code: 'SESSION_IDENTITY_UNTRUSTED' } };
    }
    return { ok: true, file: { ...file, sessionId: identity.sessionId }, selected: identity.sessionId === sessionId };
  });
  return {
    files: outcomes.filter((outcome) => outcome.ok && outcome.selected).map((outcome) => outcome.file),
    discoveryFailures: outcomes.filter((outcome) => !outcome.ok).map((outcome) => ({
      provider: outcome.input.cli, kind: 'transcripts', state: 'discovery_error',
      reason: 'session_identity_resolution_failed', directoryPath: outcome.input.path,
      errorCode: typeof outcome.error?.code === 'string' ? outcome.error.code : 'DISCOVERY_ERROR',
    })),
  };
}

function routeDiscovery(options, discovered, defaultBrainId, projects) {
  const linked = (projects ?? []).filter((project) => project?.path && project?.agent_id);
  const index = linked.length ? buildTranscriptProjectIndex(linked) : null;
  const inventoryWide = options.all || (options.command === 'offload' && !options.cwdExplicit);
  const scopedProject = inventoryWide ? null : linked.find((project) => path.resolve(project.path) === options.cwd); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- normalized comparison against the parsed absolute cwd; no filesystem access.
  const files = discovered.files.map((file) => {
    const filePath = path.resolve(file.path);
    const matchedProject = file.cli === 'mech-run' && file.matched_by
      ? linked.find((project) => path.resolve(project.path) === path.resolve(file.matched_by)) : null;
    const containmentCandidates = file.cli === 'mech-run' ? linked.filter((project) => {
      const projectRoot = path.resolve(project.path);
      const relative = path.relative(projectRoot, filePath);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }) : [];
    const mechProject = containmentCandidates.sort((a, b) => path.resolve(b.path).split(path.sep).length
      - path.resolve(a.path).split(path.sep).length)[0] ?? matchedProject ?? null;
    return { ...file, brainId: inventoryWide
      ? (mechProject?.agent_id ?? (index ? resolveTranscriptBrainId(file, index) : null))
      : (scopedProject?.agent_id ?? defaultBrainId) };
  });
  const brainIds = inventoryWide && linked.length
    ? [...new Set([...linked.map((project) => project.agent_id), defaultBrainId].filter(Boolean))]
    : [...new Set([scopedProject?.agent_id ?? defaultBrainId].filter(Boolean))];
  return { ...discovered, files, brainIds };
}

function ledgerSourceId(identity, file) {
  return `${logicalSessionKey(identity)}:${sha(path.resolve(file.path))}`;
}

function findInventoryItem(items, archiveVersionId) {
  return items.find((item) => item?.manifest?.archiveVersionId === archiveVersionId) ?? null;
}

function createLedgerVerifiers(client) {
  return {
    receiptVerifier: async ({ receipt, manifest, expected }) => {
      const [items, capabilities] = await Promise.all([client.inventory(expected.brainId), client.capabilities(expected.brainId)]);
      const item = findInventoryItem(items, expected.archiveVersionId);
      if (!item || canonicalHash(item.manifest) !== canonicalHash(manifest) || canonicalHash(item.receipt) !== canonicalHash(receipt)) {
        throw new Error('remote inventory does not authenticate the committed manifest and receipt');
      }
      return {
        receiptHash: canonicalHash(receipt), manifestHash: expected.manifestHash, archiveVersionId: expected.archiveVersionId,
        contentHash: expected.contentHash, byteSize: expected.byteSize, storageGeneration: expected.storageGeneration,
        brainId: expected.brainId, provider: expected.provider, sessionId: expected.sessionId,
        sourceMachineId: expected.sourceMachineId, manifestLookup: 'authoritative_match', verifierId: 'archive_v2_api',
        authenticatedAt: new Date().toISOString(),
        durabilityPolicy: capabilities?.durabilityClass === 'versioned_replicated' ? 'versioned_replicated_confirmed' : 'insufficient',
        serverTimePolicy: 'authenticated_store_time', bindingPolicy: 'exact_manifest_content_size_generation',
      };
    },
    restoreVerifier: async ({ restoreRead, verification, expected }) => ({
      archiveVersionId: expected.archiveVersionId, manifestHash: expected.manifestHash, contentHash: expected.contentHash,
      byteSize: expected.byteSize, storageGeneration: expected.storageGeneration, brainId: expected.brainId,
      provider: expected.provider, sessionId: expected.sessionId, sourceMachineId: expected.sourceMachineId,
      committedReadId: restoreRead?.committedReadId ?? verification?.committedReadId,
      verifierId: 'archive_v2_api', authenticatedAt: new Date().toISOString(),
    }),
  };
}

async function buildPartPlan(file, snapshot, partBytes) {
  const parts = [];
  for (let offset = 0, index = 0; offset < snapshot.byteSize; offset += partBytes, index++) {
    const length = Math.min(partBytes, snapshot.byteSize - offset);
    const bytes = await readStableSnapshotPart(file.path, {
      trustedRoot: file.root, expectedFingerprint: snapshot.after, offset, length,
    });
    parts.push({ index, byteSize: length, partHash: sha(bytes) });
  }
  return parts;
}

async function verifyCommittedSource(sourceId, brainId, snapshot, archiveVersionId, context) {
  const committedReadId = `read_${randomUUID()}`;
  const bytes = await context.client.readCommitted(brainId, archiveVersionId, committedReadId);
  if (bytes.byteLength !== snapshot.byteSize || sha(bytes) !== snapshot.contentHash) {
    throw new ArchiveClientError('fresh committed restore read did not match the local transcript', {
      code: 'VERIFICATION_FAILED', exitCode: TRANSCRIPT_EXIT_CODES.VERIFICATION,
    });
  }
  await context.ledger.transition(sourceId, 'restore_verified', { restoreRead: { bytes, committedReadId } });
}

async function backupFile(file, context) {
  if (!file.brainId) throw new UsageError('transcript could not be mapped to a configured brain');
  if (file.byteSize < 1) throw Object.assign(new Error('empty transcript files cannot be archived'), { code: 'UNSUPPORTED' });
  if (file.byteSize > context.config.limits.eligibilityByteLimit) {
    throw new ArchiveClientError('transcript exceeds the configured archive verification byte limit', {
      code: 'VERIFICATION_SIZE_LIMIT', exitCode: TRANSCRIPT_EXIT_CODES.VERIFICATION,
    });
  }
  const adapter = getProviderAdapter(file.cli);
  const snapshot = await readStableSnapshot(file.path, {
    trustedRoot: file.root, retainBuffer: false, maxBytes: context.config.limits.streamingFileByteLimit,
    maxAttempts: context.config.limits.snapshotMaxAttempts,
  });
  const identityResult = await adapter.parseIdentity(file, { trustedRoot: file.root, limits: context.config.limits });
  const identity = { brainId: file.brainId, provider: file.cli, sessionId: identityResult.sessionId };
  const sourceId = ledgerSourceId(identity, file);
  const ledgerSnapshot = {
    sourceId, logicalSessionKey: logicalSessionKey(identity), sourcePath: path.resolve(file.path),
    sourceRelativePath: file.relative_path, ...identity, machineId: context.machineId,
    matchConfidence: file.match_confidence || 'unscoped', matchMethod: identityResult.method,
    statFingerprint: snapshot.after, contentHash: snapshot.contentHash, byteSize: snapshot.byteSize,
    collectedAt: new Date().toISOString(),
  };
  const beforeRecord = (await context.ledger.read({ verify: false })).sources[sourceId];
  const priorArchiveVersion = beforeRecord?.archiveVersionId ?? beforeRecord?.inventoryReference?.archiveVersionId ?? null;
  await context.ledger.recordSnapshot(ledgerSnapshot);
  const current = (await context.ledger.read({ verify: false })).sources[sourceId];
  if (current?.contentHash === snapshot.contentHash && current.state === 'restore_verified') {
    return { ok: true, file, state: current.state, bytes: snapshot.byteSize, archiveVersionId: current.archiveVersionId, unchanged: true };
  }
  if (current?.contentHash === snapshot.contentHash && current.state === 'remote_committed') {
    await verifyCommittedSource(sourceId, file.brainId, snapshot, current.archiveVersionId, context);
    return { ok: true, file, state: 'restore_verified', bytes: snapshot.byteSize,
      archiveVersionId: current.archiveVersionId, unchanged: true };
  }
  const partBytes = Math.max(1, Math.floor((context.config.limits.requestByteLimit - 2048) * 3 / 4));
  const parts = await buildPartPlan(file, snapshot, partBytes);
  const declaration = {
    logicalIdentity: identity, contentHash: snapshot.contentHash, byteSize: snapshot.byteSize,
    provenance: { sourceMachineId: context.machineId, sourceRelativePath: file.relative_path,
      matchConfidence: file.match_confidence || 'unscoped', matchMethod: identityResult.method },
    timestamps: { first: null, last: null, collected: ledgerSnapshot.collectedAt },
    priorGeneration: priorArchiveVersion, totalParts: parts.length, parts,
  };
  if (current?.state !== 'uploading') await context.ledger.transition(sourceId, 'uploading');
  const declared = await context.client.declare(declaration);
  const received = new Set(declared.receivedParts ?? []);
  let progressBookkeepingWarning = false;
  const recordProgress = async () => {
    const progress = { uploadId: declared.uploadId, totalParts: parts.length,
      receivedParts: [...received], updatedAt: new Date().toISOString() };
    try {
      await context.ledger.recordUploadProgress(sourceId, progress);
    } catch (error) {
      if (!isBookkeepingAvailabilityError(error)) throw error;
      progressBookkeepingWarning = true;
      return false;
    }
    return true;
  };
  let lastCheckpointedSize = await recordProgress() ? received.size : -1;
  const remainingParts = parts.length - received.size;
  const checkpointStride = uploadCheckpointStride(remainingParts);
  let uploadedThisRun = 0;
  try {
    for (const part of parts) {
      if (received.has(part.index)) continue;
      const bytes = await readStableSnapshotPart(file.path, {
        trustedRoot: file.root, expectedFingerprint: snapshot.after,
        offset: part.index * partBytes, length: part.byteSize,
      });
      if (sha(bytes) !== part.partHash) throw Object.assign(new Error('transcript source changed during upload'), { code: 'SNAPSHOT_CHANGED' });
      await context.client.uploadPart(file.brainId, declared.uploadId, part.index, part.partHash, bytes);
      received.add(part.index);
      uploadedThisRun++;
      if (received.size === parts.length || uploadedThisRun % checkpointStride === 0) {
        if (await recordProgress()) lastCheckpointedSize = received.size;
      }
      context.progress?.({ provider: file.cli, path: file.path, part: part.index + 1, totalParts: parts.length });
    }
    if (received.size !== lastCheckpointedSize && await recordProgress()) lastCheckpointedSize = received.size;
  } catch (error) {
    if (received.size !== lastCheckpointedSize) {
      try {
        await recordProgress();
      } catch (checkpointError) {
        const diagnostic = publicError(checkpointError);
        context.diagnostic?.(`transcript upload progress checkpoint also failed (${diagnostic.code})`);
      }
    }
    throw error;
  }
  const finalSnapshot = await readStableSnapshot(file.path, {
    trustedRoot: file.root, retainBuffer: false, maxBytes: context.config.limits.streamingFileByteLimit,
    maxAttempts: context.config.limits.snapshotMaxAttempts,
  });
  if (finalSnapshot.contentHash !== snapshot.contentHash || !transcriptFingerprintMatches(finalSnapshot.after, snapshot.after)) {
    throw Object.assign(new Error('transcript source changed before archive commit'), { code: 'SNAPSHOT_CHANGED' });
  }
  const committed = await context.client.commit(file.brainId, declared.uploadId);
  await context.ledger.transition(sourceId, 'remote_committed', {
    archiveVersionId: committed.manifest.archiveVersionId, manifestHash: canonicalHash(committed.manifest),
    manifest: committed.manifest, receipt: committed.receipt,
  });
  await verifyCommittedSource(sourceId, file.brainId, snapshot, committed.manifest.archiveVersionId, context);
  return { ok: true, file, state: 'restore_verified', bytes: snapshot.byteSize,
    archiveVersionId: committed.manifest.archiveVersionId, unchanged: false,
    ...(progressBookkeepingWarning ? { bookkeepingWarning: 'local_upload_progress_checkpoint_not_recorded' } : {}) };
}

async function ensureConsent(options, config, deps) {
  if (config.consent.upload === 'granted' || options.yes) {
    if (options.yes && config.consent.upload !== 'granted') await deps.grantConsent();
    return true;
  }
  const accepted = await deps.confirm('Upload transcript contents to Agentbootup archive storage? Local files will be retained.');
  if (accepted) await deps.grantConsent();
  return accepted;
}

function summarizeLocal(discovered, ledgerState) {
  return discovered.files.map((file) => {
    const matches = Object.values(ledgerState.sources).filter((entry) => entry.sourcePath === path.resolve(file.path));
    const entry = matches.sort((a, b) => String(b.collectedAt || '').localeCompare(String(a.collectedAt || '')))[0];
    const sameGeneration = entry?.statFingerprint && ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs']
      .every((field) => entry.statFingerprint[field] === file.statFingerprint[field]);
    const storedState = entry?.state ?? 'local_only';
    const state = file.brainId ? (entry && !sameGeneration && ['remote_committed', 'restore_verified', 'eviction_eligible'].includes(storedState)
      ? 'changed_since_backup' : storedState) : 'unmapped';
    const progressUpdatedAt = Date.parse(entry?.uploadProgress?.updatedAt);
    return { provider: file.cli, path: file.path, bytes: file.byteSize, brainId: file.brainId ?? null,
      modifiedAt: file.modifiedAt, state, archiveVersionId: state === storedState ? entry?.archiveVersionId ?? null : null,
      durability: state === storedState ? entry?.receipt?.durabilityClass ?? 'unknown' : 'unknown', evictionEligible: false,
      uploadProgress: state === 'uploading' ? entry?.uploadProgress ?? null : null,
      uploadProgressAuthority: state === 'uploading' && entry?.uploadProgress ? 'prior_or_current_declaration_lower_bound' : null,
      uploadProgressMayBeStale: state === 'uploading' && Boolean(entry?.uploadProgress),
      uploadProgressAgeSeconds: state === 'uploading' && Number.isFinite(progressUpdatedAt)
        ? Math.max(0, Math.floor((Date.now() - progressUpdatedAt) / 1000)) : null };
  });
}

function aggregateStatus(local, remote, pages, ledgerState, unsupported) {
  const empty = () => ({ files: 0, bytes: 0 });
  const states = Object.fromEntries(['discovered', 'local_only', 'hashing', 'uploading', 'remote_committed', 'restore_verified',
    'eviction_eligible', 'offloaded', 'changed_since_backup', 'blocked_durability', 'unmapped', 'error']
    .map((state) => [state, empty()]));
  states.discovered = { files: local.length, bytes: local.reduce((sum, item) => sum + item.bytes, 0) };
  const providers = {};
  for (const item of local) {
    const state = states[item.state] ?? (states[item.state] = empty());
    state.files++; state.bytes += item.bytes;
    providers[item.provider] ??= { localFiles: 0, localBytes: 0, remoteVersions: 0, remoteBytes: 0 };
    providers[item.provider].localFiles++; providers[item.provider].localBytes += item.bytes;
  }
  for (const item of remote) {
    providers[item.manifest.logicalIdentity.provider] ??= { localFiles: 0, localBytes: 0, remoteVersions: 0, remoteBytes: 0 };
    providers[item.manifest.logicalIdentity.provider].remoteVersions++;
    providers[item.manifest.logicalIdentity.provider].remoteBytes += item.manifest.byteSize;
  }
  const pending = local.filter((item) => ['local_only', 'hashing', 'uploading', 'changed_since_backup', 'unmapped', 'error'].includes(item.state));
  const oldest = pending.map((item) => Date.parse(item.modifiedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const failures = {};
  for (const item of local.filter((candidate) => ['unmapped', 'error', 'blocked_durability'].includes(candidate.state))) {
    const reason = item.state; const brain = item.brainId ?? 'unmapped'; const key = `${reason}|${brain}`;
    failures[key] = { reason, brainId: item.brainId, files: (failures[key]?.files ?? 0) + 1, bytes: (failures[key]?.bytes ?? 0) + item.bytes };
  }
  for (const page of pages.filter((candidate) => !candidate.ok)) {
    const reason = page.error?.code ?? 'UNKNOWN';
    const brain = page.brainId ?? (typeof page.input === 'string' ? page.input : 'unknown');
    const archiveVersionId = page.archiveVersionId ?? null;
    const failureBytes = Number.isSafeInteger(page.input?.manifest?.byteSize) && page.input.manifest.byteSize >= 0
      ? page.input.manifest.byteSize : 0;
    const key = `${reason}|${brain}|${archiveVersionId ?? ''}`;
    failures[key] = { reason, brainId: brain, ...(archiveVersionId ? { archiveVersionId } : {}),
      files: (failures[key]?.files ?? 0) + 1, bytes: (failures[key]?.bytes ?? 0) + failureBytes };
  }
  const durability = {};
  for (const page of pages.filter((candidate) => candidate.ok)) durability[page.brainId] = {
    class: page.capabilities?.durabilityClass ?? 'unknown', evictionEligible: false,
    blockedReasons: page.capabilities?.blockedReasons ?? [],
  };
  const commits = remote.map((item) => item.receipt.committedAt).filter(Boolean).sort();
  const deep = Object.values(ledgerState.sources).map((entry) => entry.inventoryReference?.lastDeepVerifiedAt).filter(Boolean).sort();
  const hasFailure = Object.keys(failures).length > 0;
  const blockedDurability = Object.values(durability).some((item) => item.class !== 'versioned_replicated');
  const pendingBacklog = pending.length > 0;
  const healthState = hasFailure ? (local.some((item) => item.state === 'unmapped') ? 'blocked_identity' : 'error')
    : pendingBacklog ? 'working_backlog' : blockedDurability ? 'blocked_durability' : 'caught_up';
  return { states, providers, oldestPendingAgeSeconds: oldest === undefined ? null : Math.max(0, Math.floor((Date.now() - oldest) / 1000)),
    lastSuccessfulCommit: commits.at(-1) ?? null, lastSuccessfulDeepVerification: deep.at(-1) ?? null,
    failures: Object.values(failures), durability, healthState, pendingBacklog, blockedDurability, unsupported: unsupported.length,
    remote: { versions: remote.length, bytes: remote.reduce((sum, item) => sum + item.manifest.byteSize, 0) } };
}

async function commandStatus(options, context) {
  const pages = await mapLimit(context.discovered.brainIds, context.config.limits.verifierConcurrency,
    async (brainId) => ({ ok: true, brainId, items: await context.client.inventory(brainId), capabilities: await context.client.capabilities(brainId) }));
  const allRemote = pages.filter((page) => page.ok).flatMap((page) => page.items.map((item) => ({ ...item, brainId: page.brainId })));
  const isolatedInventory = await recordInventoryIsolated(context.ledger, allRemote);
  const inventoryValidation = isolatedInventory.invalid.map(inventoryValidationResult);
  const remote = isolatedInventory.valid.filter((item) => (!options.cli || item.manifest?.logicalIdentity?.provider === options.cli)
    && (!options.since || new Date(item.manifest?.timestamps?.last ?? item.manifest?.timestamps?.collected ?? 0) >= options.since));
  const state = await context.ledger.read({ verify: false });
  const local = summarizeLocal(context.discovered, state);
  const discoveryResults = discoveryFailureResults(context.discovered);
  const statusResults = [...pages.map((page) => page.ok
    ? { ok: true, brainId: page.brainId, capabilities: page.capabilities }
    : { ok: false, brainId: typeof page.input === 'string' ? page.input : null, error: page.error }),
    ...inventoryValidation, ...discoveryResults];
  const accounting = aggregateStatus(local, remote, statusResults, state, context.discovered.unsupported);
  return { command: 'status', scope: options.all ? 'all' : options.cwd, files: local,
    unsupported: context.discovered.unsupported, discoveryFailures: context.discovered.discoveryFailures, remote: remote.map((item) => ({
      brainId: item.manifest.logicalIdentity.brainId, provider: item.manifest.logicalIdentity.provider,
      sessionId: item.manifest.logicalIdentity.sessionId, archiveVersionId: item.manifest.archiveVersionId,
      bytes: item.manifest.byteSize, contentHash: item.manifest.contentHash,
      durability: item.receipt.durabilityClass, verificationStatus: item.receipt.verificationStatus,
    })), totals: { localFiles: local.length, localBytes: local.reduce((n, item) => n + item.bytes, 0),
      remoteVersions: remote.length, unsupported: context.discovered.unsupported.length,
      unmappedFiles: local.filter((item) => item.state === 'unmapped').length }, accounting,
    results: statusResults };
}

async function commandVerify(options, context) {
  if (!context.discovered.brainIds.length) throw new UsageError('No brain ID is configured; run agentbootup config set-brain <id>');
  const inventoryResults = await mapLimit(context.discovered.brainIds, context.config.limits.verifierConcurrency,
    async (brainId) => ({ ok: true, brainId, items: await context.client.inventory(brainId),
      capabilities: options.deep ? await context.client.capabilities(brainId) : null }));
  const rawItems = inventoryResults.filter((result) => result.ok).flatMap((result) => result.items.map((item) => ({
    ...item, brainId: result.brainId, capabilities: result.capabilities,
  })));
  const isolatedInventory = await recordInventoryIsolated(context.ledger, rawItems);
  const items = isolatedInventory.valid;
  const inventoryValidation = isolatedInventory.invalid.map(inventoryValidationResult);
  const filtered = items.filter((item) => (!options.cli || item.manifest?.logicalIdentity?.provider === options.cli)
    && (!options.since || new Date(item.manifest?.timestamps?.last ?? item.manifest?.timestamps?.collected ?? 0) >= options.since));
  const localReconciliation = await mapLimit(context.discovered.files, context.config.limits.verifierConcurrency, async (file) => {
    if (!file.brainId) throw new UsageError(`transcript is unmapped: ${file.path}`);
    if (file.byteSize > context.config.limits.eligibilityByteLimit) {
      throw new ArchiveClientError('transcript exceeds the configured archive verification byte limit', {
        code: 'VERIFICATION_SIZE_LIMIT', exitCode: TRANSCRIPT_EXIT_CODES.VERIFICATION,
      });
    }
    const adapter = getProviderAdapter(file.cli);
    const [snapshot, identity] = await Promise.all([
      readStableSnapshot(file.path, { trustedRoot: file.root, retainBuffer: false,
        maxBytes: context.config.limits.eligibilityByteLimit, maxAttempts: context.config.limits.snapshotMaxAttempts }),
      adapter.parseIdentity(file, { trustedRoot: file.root, limits: context.config.limits }),
    ]);
    const matched = items.find((item) => item.brainId === file.brainId
      && item.manifest.logicalIdentity.provider === file.cli && item.manifest.logicalIdentity.sessionId === identity.sessionId
      && item.manifest.contentHash === snapshot.contentHash && item.manifest.byteSize === snapshot.byteSize);
    if (!matched) throw new ArchiveClientError('no exact remote archive exists for the discovered local transcript', {
      code: 'NOT_FOUND', exitCode: TRANSCRIPT_EXIT_CODES.NOT_FOUND,
    });
    return { ok: true, kind: 'local_reconciliation', localPath: file.path, brainId: file.brainId,
      provider: file.cli, bytes: snapshot.byteSize,
      archiveVersionId: matched.manifest.archiveVersionId, durability: matched.receipt.durabilityClass };
  });
  const verifiedResults = await mapLimit(filtered, context.config.limits.verifierConcurrency, async (item) => {
    const manifest = item.manifest;
    const verified = options.deep
      ? await context.client.verifyCommitted(item.brainId, manifest.archiveVersionId)
      : { archiveVersionId: manifest.archiveVersionId, contentHash: manifest.contentHash, byteSize: manifest.byteSize,
          durabilityClass: item.receipt.durabilityClass };
    const ok = verified.archiveVersionId === manifest.archiveVersionId && verified.contentHash === manifest.contentHash
      && verified.byteSize === manifest.byteSize;
    if (!ok) throw new ArchiveClientError('remote verification evidence does not match the immutable manifest', { code: 'VERIFICATION_FAILED', exitCode: 7 });
    const durabilityRank = { unknown: 0, single_region_versioned: 1, versioned_replicated: 2 };
    if (options.deep && (verified.durabilityClass !== item.receipt.durabilityClass
      || (durabilityRank[item.capabilities?.durabilityClass] ?? -1) < (durabilityRank[item.receipt.durabilityClass] ?? 0))) {
      throw new ArchiveClientError('archive durability has degraded since this receipt was committed', { code: 'DURABILITY_DEGRADED', exitCode: 7 });
    }
    if (options.deep && !isIsoInstant(verified.verifiedAt)) {
      throw new ArchiveClientError('deep verification response has an invalid verification timestamp', {
        code: 'VERIFICATION_FAILED', exitCode: TRANSCRIPT_EXIT_CODES.VERIFICATION,
      });
    }
    const result = { ok: true, brainId: item.brainId, archiveVersionId: manifest.archiveVersionId,
      provider: manifest.logicalIdentity.provider, bytes: manifest.byteSize,
      durability: verified.durabilityClass, capabilityDurability: item.capabilities?.durabilityClass ?? null, deep: options.deep,
      manifestHash: canonicalHash(manifest), ...(options.deep ? { verifiedAt: verified.verifiedAt } : {}) };
    return result;
  });
  const verificationByArchive = new Map();
  const ungroupedVerificationResults = [];
  for (const result of verifiedResults) {
    const brainId = result.brainId ?? result.input?.brainId ?? result.input?.manifest?.logicalIdentity?.brainId;
    const archiveVersionId = result.archiveVersionId ?? result.input?.manifest?.archiveVersionId;
    if (!brainId || !archiveVersionId) { ungroupedVerificationResults.push(result); continue; }
    const key = `${brainId}|${archiveVersionId}`;
    verificationByArchive.set(key, [...(verificationByArchive.get(key) ?? []), result]);
  }
  const evidenceSignature = (result) => canonicalHash({ brainId: result.brainId, archiveVersionId: result.archiveVersionId,
    manifestHash: result.manifestHash, provider: result.provider, bytes: result.bytes, durability: result.durability,
    capabilityDurability: result.capabilityDurability, deep: result.deep });
  const consistentKeys = new Set([...verificationByArchive].filter(([, matches]) => matches.length
    && matches.every((result) => result.ok)
    && new Set(matches.map(evidenceSignature)).size === 1).map(([key]) => key));
  const bookkeepingWarningByArchive = new Map();
  if (options.deep) {
    for (const [key, matches] of verificationByArchive) {
      if (!consistentKeys.has(key)) continue;
      const { brainId, archiveVersionId } = matches[0];
      const verifiedTimes = matches.map((result) => Date.parse(result.verifiedAt)).filter(Number.isFinite);
      if (!verifiedTimes.length) continue;
      const verifiedAt = new Date(Math.max(...verifiedTimes)).toISOString();
      try { await context.ledger.recordDeepVerification(brainId, archiveVersionId, verifiedAt); }
      catch (error) {
        if (!isBookkeepingAvailabilityError(error)) throw error;
        const warning = error?.code === 'INVENTORY_REFERENCE_MISSING'
          ? 'local_deep_verification_reference_missing' : 'local_deep_verification_timestamp_not_recorded';
        bookkeepingWarningByArchive.set(key, warning);
      }
    }
  }
  const aggregatedVerificationByArchive = new Map([...verificationByArchive].map(([key, matches]) => {
    const failed = matches.find((result) => !result.ok);
    if (!failed && consistentKeys.has(key)) return [key, { ...matches[0],
      ...(bookkeepingWarningByArchive.has(key) ? { bookkeepingWarning: bookkeepingWarningByArchive.get(key) } : {}) }];
    const successful = matches.find((result) => result.ok);
    const item = failed?.input;
    const error = failed?.error ?? new ArchiveClientError('duplicate archive inventory contains divergent verification evidence', {
      code: 'VERIFICATION_FAILED', exitCode: TRANSCRIPT_EXIT_CODES.VERIFICATION,
    });
    return [key, { ok: false,
      brainId: successful?.brainId ?? item?.brainId ?? item?.manifest?.logicalIdentity?.brainId,
      archiveVersionId: successful?.archiveVersionId ?? item?.manifest?.archiveVersionId,
      provider: successful?.provider ?? item?.manifest?.logicalIdentity?.provider,
      bytes: successful?.bytes ?? item?.manifest?.byteSize,
      deep: options.deep, input: item, error }];
  }));
  const reconciledArchiveKeys = new Set();
  const reconciledResults = localReconciliation.map((localResult) => {
    if (!localResult.ok) return localResult;
    const key = `${localResult.brainId}|${localResult.archiveVersionId}`;
    reconciledArchiveKeys.add(key);
    const remoteResult = aggregatedVerificationByArchive.get(key);
    if (!remoteResult) return { ...localResult, deep: false, remoteVerification: 'filtered' };
    if (!remoteResult.ok) {
      const { durability: _unverifiedDurability, ...failedLocal } = localResult;
      return { ...failedLocal, ok: false, error: remoteResult.error };
    }
    return { ...localResult, deep: remoteResult.deep, durability: remoteResult.durability,
      ...(remoteResult.bookkeepingWarning ? { bookkeepingWarning: remoteResult.bookkeepingWarning } : {}) };
  });
  const remoteOnlyResults = [...aggregatedVerificationByArchive]
    .filter(([key]) => !reconciledArchiveKeys.has(key)).map(([, result]) => result)
    .concat(ungroupedVerificationResults);
  const results = [...discoveryFailureResults(context.discovered), ...inventoryResults.filter((item) => !item.ok), ...inventoryValidation,
    ...reconciledResults, ...remoteOnlyResults];
  const counts = (values, { local = false } = {}) => {
    const successful = values.filter((item) => item.ok);
    const verified = successful.filter((item) => item.remoteVerification !== 'filtered');
    const bytes = (item) => item.bytes ?? item.input?.byteSize ?? item.input?.manifest?.byteSize ?? 0;
    const base = { checked: values.length, checkedBytes: values.reduce((sum, item) => sum + bytes(item), 0),
      verified: verified.length, failed: values.filter((item) => !item.ok).length,
      verifiedBytes: verified.reduce((sum, item) => sum + bytes(item), 0) };
    return local ? { ...base, reconciled: successful.length,
      reconciledBytes: successful.reduce((sum, item) => sum + bytes(item), 0) } : base;
  };
  const authoritativeRemoteResults = [...aggregatedVerificationByArchive.values(), ...ungroupedVerificationResults];
  const bookkeepingWarnings = new Set(results.filter((item) => item.bookkeepingWarning)
    .map((item) => `${item.brainId}|${item.archiveVersionId}|${item.bookkeepingWarning}`)).size;
  const verificationCandidates = [...reconciledResults, ...remoteOnlyResults];
  return { command: 'verify', deep: options.deep, discoveryFailures: context.discovered.discoveryFailures, results, summary: { ...counts(verificationCandidates, { local: true }),
    localReconciliation: counts(reconciledResults, { local: true }), remoteVerification: counts(authoritativeRemoteResults),
    remoteAttempts: counts(verifiedResults), discoveryFailures: context.discovered.discoveryFailures.length,
    inventoryFailures: inventoryResults.filter((item) => !item.ok).length + inventoryValidation.length, bookkeepingWarnings } };
}

function printHuman(io, result) {
  if (result.command === 'backup') {
    io.stdout(`Transcript backup: ${result.summary.succeeded}/${result.summary.discovered} files verified, ${result.summary.bytes} bytes`);
    for (const item of result.results) io.stdout(item.ok
      ? `  ${item.state}: ${item.file.cli} ${item.file.path}${item.bookkeepingWarning ? ` (warning=${item.bookkeepingWarning})` : ''}`
      : `  failed: ${item.input?.cli ?? 'unknown'} ${item.input?.path ?? 'unknown'} (${item.error?.code ?? 'UNKNOWN'})`);
    if (result.summary.bookkeepingWarnings) io.stdout(`  warnings: ${result.summary.bookkeepingWarnings} upload progress checkpoint(s) were not recorded locally`);
  } else if (result.command === 'status') {
    io.stdout(`Transcript status: ${result.totals.localFiles} local files, ${result.totals.localBytes} bytes, ${result.totals.remoteVersions} remote versions`);
    for (const [provider, totals] of Object.entries(result.accounting.providers).sort(([a], [b]) => a.localeCompare(b))) {
      io.stdout(`  provider ${provider}: ${totals.localFiles} local files / ${totals.localBytes} source bytes; ${totals.remoteVersions} remote versions / ${totals.remoteBytes} bytes`);
    }
    const stateBytes = (state) => result.accounting.states[state]?.bytes ?? 0;
    const eligibleBytes = stateBytes('eviction_eligible');
    const blockedBytes = Math.max(0, result.totals.localBytes - eligibleBytes - stateBytes('offloaded'));
    io.stdout(`  source bytes: ${result.totals.localBytes}`);
    io.stdout(`  remotely committed bytes: ${result.accounting.remote.bytes}`);
    io.stdout(`  restore-verified bytes: ${stateBytes('restore_verified')}`);
    io.stdout(`  blocked bytes: ${blockedBytes}`);
    io.stdout(`  eligible bytes: ${eligibleBytes}`);
    io.stdout(`  estimated reclaimable bytes: ${eligibleBytes}`);
    for (const item of result.files) {
      const progress = item.uploadProgress ? `; locally-acknowledged-parts>=${item.uploadProgress.receivedParts.length}/${item.uploadProgress.totalParts}` : '';
      io.stdout(`  ${item.state}: ${item.provider} ${item.path} (${item.bytes} bytes; durability=${item.durability}; eviction=no${progress})`);
    }
    for (const item of result.unsupported) io.stdout(`  unsupported: ${item.provider} ${item.kind} (${item.reason})`);
    for (const item of result.results.filter((candidate) => !candidate.ok)) {
      const target = item.archiveVersionId ?? item.brainId ?? item.input?.path
        ?? (typeof item.input === 'string' ? item.input : 'remote inventory');
      io.stdout(`  failed: ${target} (${item.error?.code ?? 'UNKNOWN'})`);
    }
  } else if (result.command === 'verify') {
    io.stdout(`Transcript verification: ${result.summary.localReconciliation.reconciled} local sources reconciled, ${result.summary.remoteVerification.verified} archive versions remotely verified, ${result.summary.failed} verification candidates failed; ${result.summary.discoveryFailures + result.summary.inventoryFailures} could not be evaluated${result.deep ? ' (deep)' : ''}`);
    for (const item of result.results) io.stdout(item.ok
      ? `  ${item.remoteVerification === 'filtered' ? 'reconciled' : 'verified'}: ${item.provider} ${item.archiveVersionId} (${item.bytes} bytes; durability=${item.durability}${item.bookkeepingWarning ? `; warning=${item.bookkeepingWarning}` : ''})`
      : `  failed: ${item.archiveVersionId ?? item.input?.manifest?.archiveVersionId ?? item.input?.path
        ?? (typeof item.input === 'string' ? item.input : null) ?? 'unknown'} (${item.error?.code ?? 'UNKNOWN'})`);
    if (result.summary.bookkeepingWarnings) io.stdout(`  warnings: ${result.summary.bookkeepingWarnings} local verification bookkeeping update(s) were not recorded`);
    if (result.summary.discoveryFailures || result.summary.inventoryFailures) {
      io.stdout(`  scan failures: ${result.summary.discoveryFailures}; inventory failures: ${result.summary.inventoryFailures}`);
    }
  } else if (result.command === 'offload') {
    io.stdout(`Transcript offload plan ${result.planId}: ${result.summary.selectedFiles} selected files / ${result.summary.selectedBytes} source bytes; ${result.summary.eligibleFiles} eligible files / ${result.summary.eligibleBytes} bytes; ${result.summary.retainedFiles} retained files / ${result.summary.retainedBytes} bytes`);
    io.stdout(`  apply: disabled (${result.productionVerdict}; gate=${result.applyGate})`);
    io.stdout(`  current authenticated authority: unavailable; authoritative remote committed: ${result.summary.remoteCommittedFiles} files / ${result.summary.remoteCommittedBytes} bytes; authoritative restore verified: ${result.summary.restoreVerifiedFiles} files / ${result.summary.restoreVerifiedBytes} bytes`);
    io.stdout(`  stored historical claims (not current authority): ${result.summary.historicalClaimRemoteCommittedFiles} remote committed / ${result.summary.historicalClaimRemoteCommittedBytes} bytes; ${result.summary.historicalClaimRestoreVerifiedFiles} restore verified / ${result.summary.historicalClaimRestoreVerifiedBytes} bytes`);
    io.stdout(`  blocked: ${result.summary.blockedFiles} files / ${result.summary.blockedBytes} bytes`);
    io.stdout(`  technically qualified: ${result.summary.technicallyQualifiedFiles} files / ${result.summary.technicallyQualifiedBytes} bytes`);
    io.stdout(`  estimated reclaimable bytes: ${result.summary.estimatedReclaimableBytes}`);
    for (const [provider, totals] of Object.entries(result.providers)) io.stdout(`  provider ${provider}: ${totals.files} files / ${totals.bytes} bytes; ${totals.remoteCommittedBytes} authoritative remote committed; ${totals.restoreVerifiedBytes} authoritative restore verified; ${totals.historicalClaimRemoteCommittedBytes} historical remote-commit claim; ${totals.historicalClaimRestoreVerifiedBytes} historical restore-verification claim; ${totals.eligibleBytes} eligible; ${totals.retainedBytes} retained; ${totals.unsupportedItems ?? 0} unsupported`);
    for (const item of result.files) io.stdout(`  retained: ${item.provider} ${item.displayPath} [${item.pathHash}] (${item.bytes} bytes; state=${item.state}; ${item.blockedReasons.join(',')})`);
    for (const item of result.unsupported) io.stdout(`  retained unsupported: ${item.provider} ${item.kind} (${item.reason})`);
    if (result.summary.discoveryFailures || result.summary.discoveryWarnings) {
      io.stdout(`  scan failures: ${result.summary.discoveryFailures}; non-blocking unsupported-provider warnings: ${result.summary.discoveryWarnings}`);
    }
  } else {
    io.stdout(`Transcript restore: ${result.summary.restored} materialized, ${result.summary.alreadyPresent} already present, ${result.summary.partial} metadata-incomplete, ${result.summary.selected} selected, ${result.summary.bytes} bytes, ${result.summary.conflicts} conflicts preserved`);
    for (const item of result.results) io.stdout(item.ok
      ? `  ${item.state}: ${item.provider} ${item.sessionId} -> ${item.destination}${item.conflict ? ' (conflict preserved)' : ''}`
      : `  failed: ${item.provider} ${item.archiveVersionId} (${item.error?.code ?? 'UNKNOWN'})`);
  }
}

export async function runTranscriptsCommand(argv, io = { stdout: console.log, stderr: console.error }, injected = {}) {
  if (argv[0] === 'mitigate-remote-copy') {
    const { runMitigateRemoteCopy } = await import('../network/commands/transcripts-mitigate-remote-copy.js');
    return runMitigateRemoteCopy(argv.slice(1), io, injected);
  }
  let options;
  const wantsJson = argv.some((arg) => arg === '--json');
  try { options = parseArgs(argv); }
  catch (error) {
    if (wantsJson) io.stdout(JSON.stringify({ ok: false, code: error.code ?? 'USAGE_ERROR', message: error.message }));
    else { io.stderr(error.message); io.stderr(transcriptUsage()); }
    return error.exitCode;
  }
  if (options.command === 'help') { io.stdout(transcriptUsage()); return 0; }
  const deps = {
    inspectCredentials, readConfig, getBrainId, getMachineId, writeConfig, getNetworkProjects,
    getProjectBrainId: getAgentId,
    discoverTranscriptInventory, discoverMechRunTranscripts: (discoveryOptions) => getProviderAdapter('mech-run').discover(discoveryOptions),
    confirm: defaultConfirm, ...injected,
  };
  deps.grantConsent ??= async () => {
    const config = await deps.readConfig();
    await deps.writeConfig({ transcripts: { ...(config.transcripts ?? {}), consent: { ...(config.transcripts?.consent ?? {}), upload: 'granted' } } });
  };
  try {
    let projectRegistryError;
    const projectsPromise = Promise.resolve().then(() => deps.getNetworkProjects()).catch((error) => {
      projectRegistryError = error;
      return [];
    });
    const [rawConfig, brainId, projects] = await Promise.all([
      deps.readConfig(), deps.getBrainId(), projectsPromise,
    ]);
    const config = resolveTranscriptArchiveConfig(rawConfig);
    const rawDiscovered = options.command === 'restore'
      ? { files: [], unsupported: [], discoveryFailures: [] }
      : await discover(options, deps, projects, config.limits);
    const offloadNeedsProjectRegistry = options.command === 'offload'
      && (!options.cwdExplicit || options.cli === 'mech-run' || rawDiscovered.files.some((file) => file.cli === 'mech-run'));
    if (projectRegistryError && options.command !== 'restore'
      && (options.command !== 'offload' || offloadNeedsProjectRegistry)) {
      const diagnosticCode = projectRegistryError?.code ?? projectRegistryError?.cause?.code;
      rawDiscovered.discoveryFailures.push({ provider: 'mech-run', kind: 'transcripts', state: 'discovery_error',
        reason: 'project_registry_unavailable', errorCode: DISCOVERY_DIAGNOSTIC_CODES.has(diagnosticCode)
          ? diagnosticCode : 'PROJECT_REGISTRY_ERROR' });
    }
    const discovered = routeDiscovery(options, rawDiscovered, brainId, projects);
    const restoreProjectBrainId = options.command === 'restore' && (!options.all || options.cwdExplicit)
      ? deps.getProjectBrainId(options.cwd) : null;
    if (options.command === 'restore') {
      discovered.brainIds = [...new Set([options.brain ?? restoreProjectBrainId].filter(Boolean))];
    }
    if (projectRegistryError && !['restore', 'offload'].includes(options.command)) {
      discovered.files = discovered.files.map((file) => ({ ...file, brainId: null }));
      discovered.brainIds = [];
    }
    if (options.command === 'backup' && options.dryRun) {
      const discoveryResults = discoveryFailureResults(discovered);
      const result = { command: 'backup', dryRun: true, results: [...discovered.files.map((file) => ({
        ok: true, file, state: file.brainId ? 'would_upload' : 'unmapped', bytes: file.byteSize,
      })), ...discoveryResults], unsupported: discovered.unsupported, discoveryFailures: discovered.discoveryFailures,
        summary: { discovered: discovered.files.length,
        succeeded: 0, failed: 0, discoveryFailures: discoveryResults.length,
        bytes: discovered.files.reduce((n, file) => n + file.byteSize, 0), contentUploaded: false } };
      options.json ? io.stdout(JSON.stringify(result, (_key, value) => value instanceof Error
        ? { code: value.code, message: value.message, exitCode: value.exitCode } : value)) : printHuman(io, result);
      return combineExitCodes([...discoveryResults.map((item) => item.error?.exitCode || 1),
        ...(discovered.files.some((file) => !file.brainId) ? [TRANSCRIPT_EXIT_CODES.USAGE] : [])]);
    }
    if (options.command === 'offload') {
      const clock = injected.now?.() ?? new Date();
      const clockMs = new Date(clock).getTime();
      const cutoff = options.before?.getTime() ?? (options.olderThanMs ? clockMs - options.olderThanMs : null);
      if (cutoff !== null) discovered.files = discovered.files.filter((file) => Date.parse(file.modifiedAt) < cutoff);
      if (options.session) {
        const selection = await selectOffloadSession(discovered.files, options.session, config.limits);
        discovered.files = selection.files;
        discovered.discoveryFailures.push(...selection.discoveryFailures);
      }
      const ledgerFile = injected.ledgerFile ?? process.env.AGENTBOOTUP_ARCHIVE_LEDGER_FILE ?? getArchiveLedgerPath();
      const ledger = injected.ledger ?? new ArchiveLedger({ file: ledgerFile, limits: config.limits });
      const ledgerState = await ledger.read({ verify: false });
      const providers = [...new Set(discovered.files.map((file) => file.cli))];
      const harnessObservations = deps.getHarnessStates
        ? Object.fromEntries(Object.entries(await deps.getHarnessStates(providers)).map(([provider, state]) =>
          [provider, typeof state === 'string' ? { state, observedAt: new Date(clockMs).toISOString(), method: 'injected_test_state', matchedPids: [] } : state]))
        : await observeHarnessStates(providers, { now: () => clockMs, listProcesses: injected.listProcesses });
      const offloadDiscovery = partitionOffloadDiscoveryFailures(discovered.discoveryFailures, options);
      const result = await buildOffloadPlan({ files: discovered.files, ledgerSources: ledgerState.sources,
        unsupported: discovered.unsupported, discoveryFailures: offloadDiscovery.blocking,
        discoveryWarnings: offloadDiscovery.warnings,
        harnessObservations, minClosedAgeHours: config.localRetention.minClosedAgeHours,
        limits: config.limits, now: new Date(clockMs) });
      const output = options.apply ? { ok: false, code: 'OFFLOAD_APPLY_DISABLED', message: 'Transcript offload apply is disabled while production evidence verdict is PAUSE',
        deletionAttempted: false, productionVerdict: OFFLOAD_PRODUCTION_VERDICT, applyGate: OFFLOAD_APPLY_GATE, plan: result } : result;
      options.json ? io.stdout(JSON.stringify(output)) : options.apply
        ? io.stderr(`transcripts offload apply disabled: production evidence verdict is ${OFFLOAD_PRODUCTION_VERDICT}; no files were deleted`)
        : printHuman(io, result);
      return options.apply ? TRANSCRIPT_EXIT_CODES.VERIFICATION
        : combineExitCodes(discoveryFailureResults({ ...discovered, discoveryFailures: offloadDiscovery.blocking })
          .map((item) => item.error?.exitCode || 1));
    }
    if (options.command === 'backup' && config.archive.enabled !== true) {
      throw new UsageError('Transcript archive backup is disabled; set transcripts.archive.enabled to true before uploading content');
    }
    if (options.command === 'backup' && projectRegistryError) {
      const results = discoveryFailureResults(discovered);
      const result = { command: 'backup', dryRun: false, results, unsupported: discovered.unsupported,
        discoveryFailures: discovered.discoveryFailures,
        summary: { discovered: discovered.files.length, succeeded: 0, failed: 0, discoveryFailures: results.length,
          bytes: 0, bookkeepingWarnings: 0, contentUploaded: false } };
      options.json ? io.stdout(JSON.stringify(result, (_key, value) => value instanceof Error
        ? { code: value.code, message: value.message, exitCode: value.exitCode } : value)) : printHuman(io, result);
      return combineExitCodes(results.map((item) => item.error?.exitCode || TRANSCRIPT_EXIT_CODES.INTERNAL));
    }
    if (projectRegistryError && options.command !== 'restore') {
      const results = discoveryFailureResults(discovered);
      const result = { command: options.command, incomplete: true, results,
        discoveryFailures: discovered.discoveryFailures };
      if (options.json) io.stdout(JSON.stringify(result, (_key, value) => value instanceof Error
        ? { code: value.code, message: value.message, exitCode: value.exitCode } : value));
      else io.stderr(`Transcript ${options.command} could not evaluate project routing (${results[0]?.error?.code ?? 'DISCOVERY_FAILED'})`);
      return combineExitCodes(results.map((item) => item.error?.exitCode || TRANSCRIPT_EXIT_CODES.INTERNAL));
    }
    const credentialState = await deps.inspectCredentials();
    if (credentialState.state !== CREDS_STATE_OK) {
      const message = formatCredentialsRecoveryMessage(credentialState);
      if (options.json) io.stdout(JSON.stringify({ ok: false, code: 'AUTH_ERROR', message })); else io.stderr(message);
      return TRANSCRIPT_EXIT_CODES.AUTH;
    }
    const client = injected.client ?? new TranscriptArchiveClient({ ...credentialState.creds, ...config.limits, fetch: injected.fetch,
      timeoutMs: injected.timeoutMs ?? 30_000 });
    if (options.all && options.command !== 'backup') {
      const authorizedBrains = await client.listBrains();
      discovered.brainIds = [...new Set([...discovered.brainIds, ...authorizedBrains])];
    }
    const ledgerFile = injected.ledgerFile ?? process.env.AGENTBOOTUP_ARCHIVE_LEDGER_FILE ?? getArchiveLedgerPath();
    let ledger = injected.ledger ?? new ArchiveLedger({ file: ledgerFile, ...createLedgerVerifiers(client), limits: config.limits });
    if (!injected.ledger && injected.decorateLedger) ledger = injected.decorateLedger(ledger);
    const context = { discovered, config, client, ledger, diagnostic: io.stderr };
    let result;
    if (options.command === 'backup') {
      if (!discovered.brainIds.length) throw new UsageError('No brain ID is configured; run agentbootup config set-brain <id>');
      if (discovered.files.length && !(await ensureConsent(options, config, deps))) {
        throw new UsageError('Transcript upload consent was not granted; no content was uploaded');
      }
      context.machineId = await deps.getMachineId();
      context.progress = options.json ? null : (event) => io.stderr(`uploading ${event.provider}: part ${event.part}/${event.totalParts}`);
      const largestFile = Math.max(1, ...discovered.files.map((file) => file.byteSize));
      const memoryBoundConcurrency = Math.max(1, Math.floor(config.limits.eligibilityByteLimit / largestFile));
      const fileResults = await mapLimit(discovered.files, Math.min(config.limits.uploadConcurrency, memoryBoundConcurrency),
        (file) => backupFile(file, context));
      const discoveryResults = discoveryFailureResults(discovered);
      const results = [...fileResults, ...discoveryResults];
      result = { command: 'backup', dryRun: false, results, unsupported: discovered.unsupported,
        discoveryFailures: discovered.discoveryFailures,
        summary: { discovered: discovered.files.length, succeeded: fileResults.filter((item) => item.ok).length,
          failed: fileResults.filter((item) => !item.ok).length, discoveryFailures: discoveryResults.length,
          bytes: fileResults.filter((item) => item.ok).reduce((n, item) => n + item.bytes, 0),
          bookkeepingWarnings: fileResults.filter((item) => item.bookkeepingWarning).length, contentUploaded: true } };
    } else if (options.command === 'status') result = await commandStatus(options, context);
    else if (options.command === 'verify') result = await commandVerify(options, context);
    else {
      const configuredBrainId = options.brain ?? restoreProjectBrainId;
      if (!configuredBrainId && discovered.brainIds.length > 1) {
        throw new UsageError('Restore found multiple authorized brains; select one with --brain');
      }
      const selectedBrainId = configuredBrainId ?? discovered.brainIds[0];
      if (!selectedBrainId) throw new UsageError('Restore requires --brain or a configured brain ID');
      const results = await restoreArchiveSelection({ client, ledger, brainId: selectedBrainId, projectRoot: options.cwd,
        outputDir: options.outputDir, native: options.native, selector: { provider: options.cli, session: options.session,
          since: options.since, before: options.before, archiveVersion: options.archiveVersion, sourceMachine: options.sourceMachine,
          all: options.all } });
      result = { command: 'restore', brainId: selectedBrainId, mode: options.native ? 'native' : 'analysis_cache',
        outputDir: options.outputDir ?? null, results, summary: { selected: results.length,
          restored: results.filter((item) => item.ok && item.state === 'restored').length,
          alreadyPresent: results.filter((item) => item.ok && item.state === 'already_present').length,
          partial: results.filter((item) => item.partial === true).length,
          failed: results.filter((item) => !item.ok).length,
          conflicts: results.filter((item) => item.ok && item.conflict).length,
          bytes: results.filter((item) => item.ok).reduce((sum, item) => sum + item.bytes, 0) } };
    }
    options.json ? io.stdout(JSON.stringify(result, (_key, value) => value instanceof Error ? { code: value.code, message: value.message, exitCode: value.exitCode } : value)) : printHuman(io, result);
    const failures = result.results?.filter((item) => !item.ok) ?? [];
    return combineExitCodes(failures.map((item) => item.error?.exitCode || 1));
  } catch (rawError) {
    const error = publicError(rawError);
    if (options?.json) io.stdout(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    else io.stderr(`transcripts ${options?.command ?? 'command'} failed: ${error.message}`);
    return error.exitCode ?? TRANSCRIPT_EXIT_CODES.INTERNAL;
  }
}
