import fsp from 'fs/promises';
import path from 'path';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { canonicalHash, validateArchiveManifest, validateDurabilityReceipt, validateVerificationEvidence } from './contracts.js';
import { readStableSnapshot } from './snapshot.js';

export const OFFLOAD_PLAN_SCHEMA = 'agentbootup.transcript.offload-plan.v1';
export const OFFLOAD_APPLY_GATE = 'production_evidence_proceed_required';
export const OFFLOAD_PRODUCTION_VERDICT = 'PAUSE';
const PLAN_TTL_MS = 15 * 60 * 1000;
const QUALIFIED_PROVIDERS = new Set(['claude', 'codex']);
const STRONG_ATTRIBUTION = new Set(['embedded_metadata', 'encoded_path', 'registered_metadata', 'project_local']);
const HARNESS_EXECUTABLES = Object.freeze({ claude: new Set(['claude']), codex: new Set(['codex']) });
const execFile = promisify(execFileCallback);

function fingerprint(stat) {
  return { device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
function sameFingerprint(left, right) {
  return Boolean(left && right && ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'].every((field) => left[field] === right[field]));
}
function completeFingerprint(value) {
  return Boolean(value && Number.isSafeInteger(value.size)
    && ['device', 'inode', 'mtimeNs', 'ctimeNs'].every((field) => typeof value[field] === 'string' && value[field]));
}
function contained(filePath, root) {
  if (!root) return false;
  const relative = path.relative(path.resolve(root), path.resolve(filePath)); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- comparison-only containment check; no filesystem access uses the resolved values.
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function publicIdentity(file) {
  const normalized = path.resolve(file.path); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- normalized only for a hash/display identity; guarded snapshot code owns filesystem access.
  const relative = contained(normalized, file.root) ? path.relative(path.resolve(file.root), normalized) : path.basename(normalized); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- display-only relative path after containment classification.
  return { displayPath: `${file.cli}/${relative.split(path.sep).join('/')}`, pathHash: canonicalHash({ normalizedPath: normalized }) };
}
function findLedgerEntries(file, sources) {
  const resolved = path.resolve(file.path); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- comparison-only local ledger lookup.
  return Object.values(sources || {}).filter((entry) => typeof entry?.sourcePath === 'string'
    && path.resolve(entry.sourcePath) === resolved) // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- comparison-only local ledger lookup after type validation.
    .sort((a, b) => String(b.collectedAt || '').localeCompare(String(a.collectedAt || '')));
}
function exactIdentity(entry, file) {
  const identity = entry?.manifest?.logicalIdentity;
  const receiptIdentity = entry?.receipt?.logicalIdentity;
  return (!file.sessionId || file.sessionId === entry?.sessionId)
    && identity?.brainId === file.brainId && identity?.provider === file.cli && identity?.sessionId === entry?.sessionId
    && receiptIdentity?.brainId === identity.brainId && receiptIdentity?.provider === identity.provider
    && receiptIdentity?.sessionId === identity.sessionId
    && receiptIdentity?.brainId === entry?.brainId && receiptIdentity?.provider === entry?.provider
    && receiptIdentity?.sessionId === entry?.sessionId
    && entry?.provider === file.cli && entry?.brainId === file.brainId && entry?.machineId === entry?.manifest?.provenance?.sourceMachineId;
}
function manifestBindingHolds(entry, actualHash, size) {
  return entry.archiveVersionId === entry.manifest.archiveVersionId
    && entry.manifestHash === canonicalHash(entry.manifest)
    && entry.contentHash === actualHash && entry.manifest.contentHash === actualHash
    && entry.manifest.byteSize === size;
}
function receiptTrustBindingHolds(entry, file, actualHash, size) {
  return entry.receiptTrust?.receiptHash === canonicalHash(entry.receipt)
    && entry.receiptTrust?.manifestHash === entry.manifestHash
    && entry.receiptTrust?.archiveVersionId === entry.archiveVersionId
    && entry.receiptTrust?.contentHash === actualHash && entry.receiptTrust?.byteSize === size
    && entry.receiptTrust?.storageGeneration === entry.manifest.blob.storageGeneration
    && entry.receiptTrust?.brainId === file.brainId && entry.receiptTrust?.provider === file.cli
    && entry.receiptTrust?.sessionId === entry.sessionId && entry.receiptTrust?.sourceMachineId === entry.machineId
    && entry.receiptTrust?.manifestLookup === 'authoritative_match'
    && entry.receiptTrust?.durabilityPolicy === 'versioned_replicated_confirmed'
    && entry.receiptTrust?.serverTimePolicy === 'authenticated_store_time'
    && entry.receiptTrust?.bindingPolicy === 'exact_manifest_content_size_generation';
}
function receiptBindingHolds(entry, actualHash, size) {
  return entry.receipt.manifestHash === entry.manifestHash && entry.receipt.archiveVersionId === entry.archiveVersionId
    && entry.receipt.storageGeneration === entry.manifest.blob.storageGeneration
    && entry.receipt.sourceMachineId === entry.machineId
    && entry.receipt.contentHash === actualHash && entry.receipt.byteSize === size
    && entry.receipt.durabilityClass === 'versioned_replicated'
    && entry.receipt.verificationStatus === 'replication_confirmed';
}
function verificationBindingHolds(entry, actualHash, size) {
  return entry.verification.archiveVersionId === entry.archiveVersionId
    && entry.verification.manifestHash === entry.manifestHash
    && entry.verification.storageGeneration === entry.manifest.blob.storageGeneration
    && entry.verification.source === 'committed_restore' && Boolean(entry.verification.committedReadId)
    && entry.verification.contentHash === actualHash && entry.verification.byteSize === size;
}
function historicalEvidenceIsBound(entry, file, actualFingerprint, actualHash) {
  if (!entry || !['restore_verified', 'eviction_eligible'].includes(entry.state)) return false;
  if (validateArchiveManifest(entry.manifest).length || validateDurabilityReceipt(entry.receipt).length
    || validateVerificationEvidence(entry.verification).length) return false;
  const size = actualFingerprint.size;
  return exactIdentity(entry, file)
    && completeFingerprint(entry.statFingerprint) && sameFingerprint(actualFingerprint, entry.statFingerprint)
    && manifestBindingHolds(entry, actualHash, size)
    && receiptTrustBindingHolds(entry, file, actualHash, size)
    && receiptBindingHolds(entry, actualHash, size)
    && verificationBindingHolds(entry, actualHash, size);
}

function sanitizeDiscoveryFailure(failure) {
  const sanitized = {
    provider: typeof failure?.provider === 'string' ? failure.provider : 'unknown',
    kind: typeof failure?.kind === 'string' ? failure.kind : 'transcripts',
    state: 'discovery_error',
    reason: typeof failure?.reason === 'string' ? failure.reason : 'transcript_discovery_failed',
    errorCode: typeof failure?.errorCode === 'string' ? failure.errorCode : 'DISCOVERY_ERROR',
  };
  if (typeof failure?.scope === 'string') sanitized.scope = failure.scope;
  if (Number.isSafeInteger(failure?.omittedFailures) && failure.omittedFailures > 0) {
    sanitized.omittedFailures = failure.omittedFailures;
  }
  if (typeof failure?.projectRoot === 'string') {
    sanitized.projectPathHash = canonicalHash({ normalizedPath: path.resolve(failure.projectRoot) }); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- hash-only redaction; no filesystem access.
  }
  if (typeof failure?.directoryPath === 'string') {
    sanitized.directoryPathHash = canonicalHash({ normalizedPath: path.resolve(failure.directoryPath) }); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- hash-only redaction; no filesystem access.
  }
  return sanitized;
}

export async function observeHarnessStates(providers, options = {}) {
  const observedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const requested = [...new Set(providers)].sort();
  try {
    const listProcesses = options.listProcesses ?? (async () => (await execFile('ps', ['-axo', 'pid=,comm='], { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 })).stdout);
    const rows = String(await listProcesses()).split(/\r?\n/).map((line) => line.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean)
      .map((match) => ({ pid: Number(match[1]), executable: path.basename(match[2]) }));
    return Object.fromEntries(requested.map((provider) => {
      const names = HARNESS_EXECUTABLES[provider];
      if (!names) return [provider, { state: 'unknown', observedAt, method: 'unsupported_provider', matchedPids: [] }];
      const matchedPids = rows.filter((row) => names.has(row.executable)).map((row) => row.pid).sort((a, b) => a - b);
      return [provider, matchedPids.length
        ? { state: 'running', observedAt, method: 'exact_process_executable_positive_match', matchedPids }
        : { state: 'unknown', observedAt, method: 'process_snapshot_absence_not_proof_of_stopped', matchedPids }];
    }));
  } catch (error) {
    return Object.fromEntries(requested.map((provider) => [provider, { state: 'unknown', observedAt,
      method: 'process_snapshot_failed', errorCode: typeof error?.code === 'string' ? error.code : 'PROCESS_OBSERVATION_FAILED', matchedPids: [] }]));
  }
}

async function classify(file, sources, harnessObservations, clockMs, minClosedAgeHours, limits) {
  const publicId = publicIdentity(file);
  try {
    const entries = findLedgerEntries(file, sources);
    const reasons = [];
    let actualFingerprint = null;
    let actualHash = null;
    let stat = null;
    let observationError = null;
    const isContained = contained(file.path, file.root);
    try {
      stat = await fsp.lstat(file.path, { bigint: true });
      if (stat.isSymbolicLink()) reasons.push('symlink_source');
      else if (!stat.isFile()) reasons.push('not_regular_file');
      else if (stat.nlink !== 1n) reasons.push('hard_linked_source');
      actualFingerprint = fingerprint(stat);
    } catch (error) {
      reasons.push('source_unavailable');
      observationError = typeof error?.code === 'string' ? error.code : 'LSTAT_FAILED';
    }
    if (!isContained) reasons.push('containment_failed');
    if (!file.brainId) reasons.push('unmapped_transcript');
    else if (!QUALIFIED_PROVIDERS.has(file.cli)) reasons.push('provider_offload_not_qualified');
    else if (path.extname(file.path).toLowerCase() !== '.jsonl') reasons.push('unsupported_transcript_format');
    else if (!STRONG_ATTRIBUTION.has(file.match_confidence)) reasons.push('low_confidence_attribution');
    const harnessObservation = harnessObservations?.[file.cli] ?? { state: 'unknown', observedAt: new Date(clockMs).toISOString(), method: 'not_observed', matchedPids: [] };
    const initialFingerprint = actualFingerprint;
    // Bind plan identity to the current generation even when another safety
    // reason already guarantees retention.
    if (stat?.isFile() && isContained) {
      try {
        const snapshot = await readStableSnapshot(file.path, { trustedRoot: file.root, retainBuffer: false,
          maxAttempts: limits.snapshotMaxAttempts, maxBytes: limits.eligibilityByteLimit });
        actualFingerprint = snapshot.after;
        actualHash = snapshot.contentHash;
        if (!sameFingerprint(initialFingerprint, actualFingerprint)) reasons.push('source_changed');
      } catch (error) {
        observationError = typeof error?.code === 'string' ? error.code : 'SNAPSHOT_READ_FAILED';
        if (error?.code === 'SNAPSHOT_TOO_LARGE') reasons.push('eligibility_byte_limit_exceeded');
        else reasons.push(error?.code === 'SNAPSHOT_CHANGED' || error?.code === 'SNAPSHOT_UNSTABLE' ? 'source_changed' : 'source_read_failed');
      }
    }
    if (actualHash && actualFingerprint && !sameFingerprint(actualFingerprint, file.statFingerprint)) reasons.push('source_changed');
    const entry = actualHash && actualFingerprint
      ? entries.find((candidate) => historicalEvidenceIsBound(candidate, file, actualFingerprint, actualHash)) ?? entries[0] ?? null
      : entries[0] ?? null;
    if (actualHash && completeFingerprint(entry?.statFingerprint)
      && !sameFingerprint(actualFingerprint, entry.statFingerprint)) reasons.push('source_changed');
    if (harnessObservation.state !== 'stopped') reasons.push(harnessObservation.state === 'running' ? 'harness_running' : 'harness_state_unknown');
    if (actualFingerprint) {
      const ageMs = clockMs - Number(BigInt(actualFingerprint.mtimeNs) / 1_000_000n);
      if (ageMs < minClosedAgeHours * 60 * 60 * 1000) reasons.push(ageMs < -1_000 ? 'source_timestamp_in_future' : 'source_not_old_enough');
    }
    // Historical evidence is accounting about these exact stable bytes. It is
    // deliberately orthogonal to whether this local source is safe to offload.
    const historicalEvidenceMatched = Boolean(actualHash && actualFingerprint
      && historicalEvidenceIsBound(entry, file, actualFingerprint, actualHash));
    if (!historicalEvidenceMatched) reasons.push('archive_evidence_not_eligible');
    if (historicalEvidenceMatched) reasons.push('current_authenticated_authority_unavailable');
    reasons.push('production_evidence_pause');
    const blockedReasons = [...new Set(reasons)];
    const state = blockedReasons.some((reason) => ['source_unavailable', 'source_read_failed'].includes(reason)) ? 'error'
      : blockedReasons.some((reason) => ['source_changed', 'hard_linked_source'].includes(reason)) ? 'changed_since_backup'
      : blockedReasons.some((reason) => ['symlink_source', 'not_regular_file', 'containment_failed',
        'unmapped_transcript', 'provider_offload_not_qualified', 'unsupported_transcript_format',
        'low_confidence_attribution', 'eligibility_byte_limit_exceeded'].includes(reason)) ? 'local_only'
      : blockedReasons.some((reason) => ['harness_running', 'harness_state_unknown', 'source_not_old_enough', 'source_timestamp_in_future'].includes(reason)) ? 'blocked_active'
      : blockedReasons.some((reason) => ['archive_evidence_not_eligible', 'current_authenticated_authority_unavailable'].includes(reason)) ? 'blocked_durability'
      : 'local_only';
    const binding = { pathHash: publicId.pathHash, contentHash: actualHash, statFingerprint: actualFingerprint,
      observation: actualHash ? 'stable_snapshot' : 'metadata_or_error_only', observationError,
      archiveContentHash: entry?.contentHash ?? null, archiveVersionId: entry?.archiveVersionId ?? null,
      manifestHash: entry?.manifestHash ?? null, receiptHash: entry?.receipt ? canonicalHash(entry.receipt) : null,
      receiptTrustHash: entry?.receiptTrust ? canonicalHash(entry.receiptTrust) : null,
      verificationHash: entry?.verification ? canonicalHash(entry.verification) : null };
    const bytes = actualFingerprint?.size ?? 0;
    return { ...publicId, provider: file.cli, brainId: file.brainId ?? null, sessionId: file.sessionId ?? entry?.sessionId ?? null,
      sourceMachineId: entry?.machineId ?? null, bytes, discoveryBytes: Number(file.byteSize) || 0, harnessObservation,
      evidenceQualification: historicalEvidenceMatched ? 'historically_authenticated_not_currently_revalidated' : 'not_qualified',
      historicalEvidenceMatched, historicalClaim: { remoteCommitted: historicalEvidenceMatched, restoreVerified: historicalEvidenceMatched },
      technicallyQualified: false, remoteCommitted: false, restoreVerified: false, state,
      eligible: false, retained: true, blockedReasons, binding };
  } catch {
    return { ...publicId, provider: file.cli, brainId: file.brainId ?? null, sessionId: file.sessionId ?? null, sourceMachineId: null,
      bytes: 0, discoveryBytes: Number(file.byteSize) || 0, harnessObservation: harnessObservations?.[file.cli] ?? null,
      evidenceQualification: 'not_qualified', historicalEvidenceMatched: false,
      historicalClaim: { remoteCommitted: false, restoreVerified: false }, technicallyQualified: false,
      remoteCommitted: false, restoreVerified: false, state: 'error', eligible: false, retained: true,
      blockedReasons: ['planning_error', 'production_evidence_pause'], binding: { pathHash: publicId.pathHash,
        contentHash: null, statFingerprint: null, observation: 'metadata_or_error_only', observationError: 'PLANNING_ERROR' } };
  }
}

async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() { while (next < items.length) { const index = next++; results[index] = await fn(items[index]); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return results;
}

export async function buildOffloadPlan({ files, ledgerSources, unsupported = [], harnessObservations, harnessStates,
  discoveryFailures = [], discoveryWarnings = [],
  now = new Date(), minClosedAgeHours = 24, planTtlMs = PLAN_TTL_MS,
  limits = { uploadConcurrency: 3, eligibilityByteLimit: 256 * 1024 * 1024, snapshotMaxAttempts: 3 } }) {
  const clockMs = new Date(now).getTime();
  if (!Number.isFinite(clockMs)) throw new TypeError('offload planning clock must be valid');
  const generatedAt = new Date(clockMs).toISOString();
  const expiresAt = new Date(clockMs + planTtlMs).toISOString();
  // harnessStates is an explicit deterministic test seam. Production CLI calls pass observations from observeHarnessStates.
  const observations = harnessObservations ?? Object.fromEntries(Object.entries(harnessStates ?? {}).map(([provider, state]) =>
    [provider, { state, observedAt: generatedAt, method: 'injected_test_state', matchedPids: [] }]));
  const sorted = [...files].sort((a, b) => `${a.cli}\0${path.resolve(a.path)}`.localeCompare(`${b.cli}\0${path.resolve(b.path)}`)); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- deterministic comparison only; snapshot containment guards filesystem access.
  const largestBounded = Math.max(1, ...sorted.map((file) => Math.min(Number(file.byteSize) || 1, limits.eligibilityByteLimit)));
  const memoryConcurrency = Math.max(1, Math.floor(limits.eligibilityByteLimit / largestBounded));
  const planningConcurrency = Math.max(1, Math.min(limits.uploadConcurrency, memoryConcurrency));
  const planned = await mapLimit(sorted, planningConcurrency,
    (file) => classify(file, ledgerSources, observations, clockMs, minClosedAgeHours, limits));
  const retainedUnsupported = [...unsupported].map((item) => ({ provider: item.provider ?? 'unknown', kind: item.kind ?? 'transcripts',
    reason: item.reason ?? 'unsupported', retained: true })).sort((a, b) => `${a.provider}\0${a.kind}\0${a.reason}`.localeCompare(`${b.provider}\0${b.kind}\0${b.reason}`));
  const sanitizedDiscoveryFailures = discoveryFailures.map(sanitizeDiscoveryFailure).sort((a, b) =>
    `${a.provider}\0${a.reason}\0${a.errorCode}\0${a.projectPathHash ?? ''}\0${a.directoryPathHash ?? ''}`
      .localeCompare(`${b.provider}\0${b.reason}\0${b.errorCode}\0${b.projectPathHash ?? ''}\0${b.directoryPathHash ?? ''}`));
  const sanitizedDiscoveryWarnings = discoveryWarnings.map(sanitizeDiscoveryFailure).sort((a, b) =>
    `${a.provider}\0${a.reason}\0${a.errorCode}\0${a.projectPathHash ?? ''}\0${a.directoryPathHash ?? ''}`
      .localeCompare(`${b.provider}\0${b.reason}\0${b.errorCode}\0${b.projectPathHash ?? ''}\0${b.directoryPathHash ?? ''}`));
  const discoveryFailureReasons = {};
  for (const failure of sanitizedDiscoveryFailures) {
    discoveryFailureReasons[failure.reason] = (discoveryFailureReasons[failure.reason] ?? 0) + 1;
  }
  const discoveryWarningReasons = {};
  for (const warning of sanitizedDiscoveryWarnings) {
    discoveryWarningReasons[warning.reason] = (discoveryWarningReasons[warning.reason] ?? 0) + 1;
  }
  const providers = {};
  const blockedReasons = {};
  for (const item of planned) {
    providers[item.provider] ??= { files: 0, bytes: 0, discoveryBytes: 0, remoteCommittedFiles: 0, remoteCommittedBytes: 0,
      restoreVerifiedFiles: 0, restoreVerifiedBytes: 0, eligibleFiles: 0, eligibleBytes: 0,
      historicalClaimRemoteCommittedFiles: 0, historicalClaimRemoteCommittedBytes: 0,
      historicalClaimRestoreVerifiedFiles: 0, historicalClaimRestoreVerifiedBytes: 0,
      technicallyQualifiedFiles: 0, technicallyQualifiedBytes: 0, retainedFiles: 0, retainedBytes: 0, estimatedReclaimableBytes: 0 };
    const totals = providers[item.provider];
    totals.files++; totals.bytes += item.bytes; totals.discoveryBytes += item.discoveryBytes;
    totals.retainedFiles++; totals.retainedBytes += item.bytes;
    if (item.remoteCommitted) { totals.remoteCommittedFiles++; totals.remoteCommittedBytes += item.bytes; }
    if (item.restoreVerified) { totals.restoreVerifiedFiles++; totals.restoreVerifiedBytes += item.bytes; }
    if (item.historicalClaim.remoteCommitted) { totals.historicalClaimRemoteCommittedFiles++; totals.historicalClaimRemoteCommittedBytes += item.bytes; }
    if (item.historicalClaim.restoreVerified) { totals.historicalClaimRestoreVerifiedFiles++; totals.historicalClaimRestoreVerifiedBytes += item.bytes; }
    for (const reason of item.blockedReasons) {
      blockedReasons[reason] ??= { files: 0, bytes: 0 };
      blockedReasons[reason].files++; blockedReasons[reason].bytes += item.bytes;
    }
  }
  for (const item of retainedUnsupported) {
    providers[item.provider] ??= { files: 0, bytes: 0, discoveryBytes: 0, remoteCommittedFiles: 0, remoteCommittedBytes: 0,
      restoreVerifiedFiles: 0, restoreVerifiedBytes: 0, eligibleFiles: 0, eligibleBytes: 0,
      historicalClaimRemoteCommittedFiles: 0, historicalClaimRemoteCommittedBytes: 0,
      historicalClaimRestoreVerifiedFiles: 0, historicalClaimRestoreVerifiedBytes: 0,
      technicallyQualifiedFiles: 0, technicallyQualifiedBytes: 0, retainedFiles: 0, retainedBytes: 0, estimatedReclaimableBytes: 0 };
    providers[item.provider].unsupportedItems = (providers[item.provider].unsupportedItems ?? 0) + 1;
  }
  const sum = (predicate) => planned.filter(predicate).reduce((total, item) => total + item.bytes, 0);
  const summary = { selectedFiles: planned.length, selectedBytes: sum(() => true),
    discoveryBytes: planned.reduce((total, item) => total + item.discoveryBytes, 0),
    remoteCommittedFiles: planned.filter((item) => item.remoteCommitted).length, remoteCommittedBytes: sum((item) => item.remoteCommitted),
    restoreVerifiedFiles: planned.filter((item) => item.restoreVerified).length, restoreVerifiedBytes: sum((item) => item.restoreVerified),
    historicalClaimRemoteCommittedFiles: planned.filter((item) => item.historicalClaim.remoteCommitted).length,
    historicalClaimRemoteCommittedBytes: sum((item) => item.historicalClaim.remoteCommitted),
    historicalClaimRestoreVerifiedFiles: planned.filter((item) => item.historicalClaim.restoreVerified).length,
    historicalClaimRestoreVerifiedBytes: sum((item) => item.historicalClaim.restoreVerified),
    blockedFiles: planned.length, blockedBytes: sum(() => true), eligibleFiles: 0, eligibleBytes: 0,
    technicallyQualifiedFiles: 0, technicallyQualifiedBytes: 0, retainedFiles: planned.length,
    retainedBytes: sum(() => true), estimatedReclaimableBytes: 0, unsupportedItems: retainedUnsupported.length,
    discoveryFailures: sanitizedDiscoveryFailures.length, discoveryWarnings: sanitizedDiscoveryWarnings.length };
  const core = { schema: OFFLOAD_PLAN_SCHEMA, command: 'offload', dryRun: true, generatedAt, expiresAt,
    incomplete: sanitizedDiscoveryFailures.length > 0,
    productionVerdict: OFFLOAD_PRODUCTION_VERDICT, applyGate: OFFLOAD_APPLY_GATE, applyAllowed: false,
    authorityQualification: 'historical_local_evidence_only_not_currently_authenticated',
    planning: { concurrency: planningConcurrency, eligibilityByteLimit: limits.eligibilityByteLimit, snapshotMaxAttempts: limits.snapshotMaxAttempts },
    summary, providers, blockedReasons: Object.fromEntries(Object.entries(blockedReasons).sort(([a], [b]) => a.localeCompare(b))),
    files: planned, unsupported: retainedUnsupported, discoveryFailures: sanitizedDiscoveryFailures,
    discoveryFailureReasons: Object.fromEntries(Object.entries(discoveryFailureReasons).sort(([a], [b]) => a.localeCompare(b))),
    discoveryWarnings: sanitizedDiscoveryWarnings,
    discoveryWarningReasons: Object.fromEntries(Object.entries(discoveryWarningReasons).sort(([a], [b]) => a.localeCompare(b))) };
  return { ...core, planId: `op_${canonicalHash(core)}` };
}
