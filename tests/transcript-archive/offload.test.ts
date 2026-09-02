import { afterEach, expect, test } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { canonicalHash, createArchiveManifest, createDurabilityReceipt, createVerificationEvidence } from '../../lib/transcript-archive/contracts.js';
import { buildOffloadPlan, observeHarnessStates, OFFLOAD_APPLY_GATE } from '../../lib/transcript-archive/offload.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))); });

async function fixture(provider = 'codex', confidence = 'embedded_metadata', mtime = new Date('2026-07-20T12:00:00.000Z')) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ab-offload-'));
  roots.push(root);
  const sourcePath = path.join(root, 'session.jsonl');
  const content = Buffer.from('{"event":"safe"}\n');
  await fsp.writeFile(sourcePath, content);
  // Plans in this suite use a fixed July 21 clock. Freeze the fixture mtime so
  // a test run later that day cannot look like a source from the future.
  await fsp.utimes(sourcePath, mtime, mtime);
  const stat = await fsp.stat(sourcePath, { bigint: true });
  const contentHash = createHash('sha256').update(content).digest('hex');
  const manifest = createArchiveManifest({ brainId: 'brain-one', provider, sessionId: 'session-one', contentHash,
    byteSize: content.length, storageGeneration: 'generation-one', sourceMachineId: 'machine-one',
    sourceRelativePath: 'session.jsonl', matchConfidence: confidence, matchMethod: 'fixture',
    collectedAt: '2026-07-20T12:00:00.000Z', storageDurabilityClass: 'versioned_replicated' });
  const manifestHash = canonicalHash(manifest);
  const receipt = createDurabilityReceipt({ archiveVersionId: manifest.archiveVersionId, manifestHash,
    contentHash, byteSize: content.length, storageGeneration: 'generation-one', durabilityClass: 'versioned_replicated',
    committedAt: '2026-07-20T12:01:00.000Z', verificationStatus: 'replication_confirmed', logicalIdentity: manifest.logicalIdentity,
    sourceMachineId: 'machine-one', authentication: { keyId: 'key-one', signature: 'signed' } });
  const verification = createVerificationEvidence({ archiveVersionId: manifest.archiveVersionId, contentHash,
    byteSize: content.length, verifiedAt: '2026-07-20T12:02:00.000Z', manifestHash,
    storageGeneration: 'generation-one', committedReadId: 'read-one', verifierId: 'archive-v2' });
  const file = { cli: provider, root, path: sourcePath, filename: 'session.jsonl', relative_path: 'session.jsonl',
    brainId: 'brain-one', byteSize: content.length, match_confidence: confidence, statFingerprint: {
      device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
    } };
  const entry: any = { state: 'restore_verified', sourcePath, provider, brainId: 'brain-one', machineId: 'machine-one', sessionId: 'session-one',
    contentHash, statFingerprint: file.statFingerprint, archiveVersionId: manifest.archiveVersionId, manifest,
    manifestHash, receipt, verification, receiptTrust: { receiptHash: canonicalHash(receipt), manifestHash,
      archiveVersionId: manifest.archiveVersionId, contentHash, byteSize: content.length, storageGeneration: 'generation-one',
      brainId: 'brain-one', provider, sessionId: 'session-one', sourceMachineId: 'machine-one', manifestLookup: 'authoritative_match',
      verifierId: 'fixture-verifier', authenticatedAt: '2026-07-20T12:01:30.000Z',
      durabilityPolicy: 'versioned_replicated_confirmed', serverTimePolicy: 'authenticated_store_time',
      bindingPolicy: 'exact_manifest_content_size_generation' } };
  return { root, sourcePath, content, file, entry };
}

test('offload plan is canonical, evidence-bound, and fail-closed while production verdict is PAUSE', async () => {
  const item = await fixture();
  const now = new Date('2026-07-21T13:00:00.000Z');
  const plan = await buildOffloadPlan({ files: [item.file], ledgerSources: { one: item.entry }, unsupported: [],
    harnessStates: { codex: 'stopped' }, now, minClosedAgeHours: 0 });
  expect(plan).toMatchObject({ schema: 'agentbootup.transcript.offload-plan.v1', applyGate: OFFLOAD_APPLY_GATE,
    productionVerdict: 'PAUSE', applyAllowed: false, authorityQualification: 'historical_local_evidence_only_not_currently_authenticated',
    summary: { selectedFiles: 1, eligibleFiles: 0, technicallyQualifiedFiles: 0, remoteCommittedFiles: 0,
      restoreVerifiedFiles: 0, historicalClaimRemoteCommittedFiles: 1, historicalClaimRestoreVerifiedFiles: 1,
      estimatedReclaimableBytes: 0 }, providers: { codex: { files: 1, remoteCommittedFiles: 0,
        restoreVerifiedFiles: 0, historicalClaimRemoteCommittedFiles: 1, historicalClaimRestoreVerifiedFiles: 1 } } });
  expect(plan.files[0]).toMatchObject({ displayPath: 'codex/session.jsonl', provider: 'codex', state: 'blocked_durability',
    technicallyQualified: false, remoteCommitted: false, restoreVerified: false,
    historicalEvidenceMatched: true, evidenceQualification: 'historically_authenticated_not_currently_revalidated',
    historicalClaim: { remoteCommitted: true, restoreVerified: true }, eligible: false, retained: true,
    blockedReasons: ['current_authenticated_authority_unavailable', 'production_evidence_pause'],
    harnessObservation: { state: 'stopped' },
    binding: { contentHash: item.entry.contentHash, archiveVersionId: item.entry.archiveVersionId } });
  expect(plan.files[0].pathHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(plan)).not.toContain(item.root);
  expect(plan.planId).toMatch(/^op_[a-f0-9]{64}$/);
  expect((await buildOffloadPlan({ files: [item.file], ledgerSources: { one: item.entry }, unsupported: [],
    harnessStates: { codex: 'stopped' }, now, minClosedAgeHours: 0 })).planId).toBe(plan.planId);
});

test('planner retains unsupported providers, low-confidence and unmapped files with stable reasons', async () => {
  const cursor = await fixture('cursor');
  const low = await fixture('claude', 'basename');
  const unmapped = await fixture('codex');
  unmapped.file.brainId = null as any;
  const plan = await buildOffloadPlan({ files: [cursor.file, low.file, unmapped.file],
    ledgerSources: { cursor: cursor.entry, low: low.entry, unmapped: unmapped.entry },
    unsupported: [{ provider: 'cursor', kind: 'chats', reason: 'cursor_chats_not_archive_supported' }],
    harnessStates: { cursor: 'unknown', claude: 'stopped', codex: 'stopped' },
    now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(Object.fromEntries(plan.files.map((file: any) => [file.provider, file.blockedReasons]))).toEqual({
    cursor: ['provider_offload_not_qualified', 'harness_state_unknown',
      'current_authenticated_authority_unavailable', 'production_evidence_pause'],
    claude: ['low_confidence_attribution', 'current_authenticated_authority_unavailable', 'production_evidence_pause'],
    codex: ['unmapped_transcript', 'archive_evidence_not_eligible', 'production_evidence_pause'],
  });
  expect(plan.files.every((file: any) => file.state === 'local_only')).toBe(true);
  expect(plan.files.filter((file: any) => file.provider !== 'codex')
    .every((file: any) => file.historicalEvidenceMatched)).toBe(true);
  expect(plan.unsupported).toEqual([{ provider: 'cursor', kind: 'chats', reason: 'cursor_chats_not_archive_supported', retained: true }]);
});

test('planner detects source mutation, running harness, symlinks and hard links without deleting', async () => {
  const changed = await fixture();
  await fsp.appendFile(changed.sourcePath, 'changed');
  const running = await fixture('claude');
  const linked = await fixture('codex');
  await fsp.link(linked.sourcePath, path.join(linked.root, 'other.jsonl'));
  const symlinked = await fixture('codex');
  const target = path.join(symlinked.root, 'target.jsonl');
  await fsp.rename(symlinked.sourcePath, target);
  await fsp.symlink(target, symlinked.sourcePath);
  const plan = await buildOffloadPlan({ files: [changed.file, running.file, linked.file, symlinked.file],
    ledgerSources: { changed: changed.entry, running: running.entry, linked: linked.entry, symlinked: symlinked.entry },
    unsupported: [], harnessStates: { codex: 'stopped', claude: 'running' },
    now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(plan.files.map((file: any) => file.blockedReasons[0]).sort()).toEqual(
    ['source_changed', 'harness_running', 'hard_linked_source', 'symlink_source'].sort());
  expect(Object.fromEntries(plan.files.map((file: any) => [file.blockedReasons[0], file.state]))).toEqual({
    source_changed: 'changed_since_backup', harness_running: 'blocked_active',
    hard_linked_source: 'changed_since_backup', symlink_source: 'local_only',
  });
  expect(plan.files.every((file: any) => file.blockedReasons.at(-1) === 'production_evidence_pause')).toBe(true);
  expect(plan.files.find((file: any) => file.blockedReasons[0] === 'harness_running').binding).toMatchObject({
    observation: 'stable_snapshot', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await fsp.readFile(changed.sourcePath, 'utf8')).toContain('changed');
  expect((await fsp.lstat(symlinked.sourcePath)).isSymbolicLink()).toBe(true);
});

test('corrupt receipts and receipt trust bindings are retained without historical qualification', async () => {
  const corruptReceipt = await fixture();
  corruptReceipt.entry.receipt = { ...corruptReceipt.entry.receipt, storageGeneration: 'generation-corrupt' };
  const corruptTrust = await fixture();
  corruptTrust.entry.receiptTrust = { ...corruptTrust.entry.receiptTrust, receiptHash: '0'.repeat(64) };
  const plan = await buildOffloadPlan({ files: [corruptReceipt.file, corruptTrust.file],
    ledgerSources: { corruptReceipt: corruptReceipt.entry, corruptTrust: corruptTrust.entry },
    harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(plan.files.every((file: any) => file.historicalEvidenceMatched === false)).toBe(true);
  expect(plan.files.every((file: any) => file.remoteCommitted === false && file.restoreVerified === false)).toBe(true);
  expect(plan.files.every((file: any) => file.blockedReasons.includes('archive_evidence_not_eligible'))).toBe(true);
});

test('receipt identity and replication confirmation remain bound after receipt-trust hash recomputation', async () => {
  const wrongIdentity = await fixture();
  wrongIdentity.entry.receipt = { ...wrongIdentity.entry.receipt,
    logicalIdentity: { ...wrongIdentity.entry.receipt.logicalIdentity, sessionId: 'different-session' } };
  wrongIdentity.entry.receiptTrust = { ...wrongIdentity.entry.receiptTrust, receiptHash: canonicalHash(wrongIdentity.entry.receipt) };
  const unconfirmed = await fixture();
  unconfirmed.entry.receipt = { ...unconfirmed.entry.receipt, verificationStatus: 'remote_committed' };
  unconfirmed.entry.receiptTrust = { ...unconfirmed.entry.receiptTrust, receiptHash: canonicalHash(unconfirmed.entry.receipt) };
  const plan = await buildOffloadPlan({ files: [wrongIdentity.file, unconfirmed.file],
    ledgerSources: { wrongIdentity: wrongIdentity.entry, unconfirmed: unconfirmed.entry }, harnessStates: { codex: 'stopped' },
    now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(plan.files.every((file: any) => file.historicalEvidenceMatched === false)).toBe(true);
  expect(plan.files.every((file: any) => file.historicalClaim.remoteCommitted === false
    && file.historicalClaim.restoreVerified === false)).toBe(true);
  expect(plan.summary).toMatchObject({ remoteCommittedFiles: 0, restoreVerifiedFiles: 0,
    historicalClaimRemoteCommittedFiles: 0, historicalClaimRestoreVerifiedFiles: 0 });
});

test('a newer mismatched ledger row cannot mask older evidence bound to the current source', async () => {
  const item = await fixture();
  item.entry.collectedAt = '2026-07-20T12:00:00.000Z';
  const newer = structuredClone(item.entry);
  newer.collectedAt = '2026-07-20T13:00:00.000Z';
  newer.contentHash = '0'.repeat(64);
  const plan = await buildOffloadPlan({ files: [item.file], ledgerSources: { older: item.entry, newer },
    harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(plan.files[0]).toMatchObject({ historicalEvidenceMatched: true,
    evidenceQualification: 'historically_authenticated_not_currently_revalidated',
    binding: { archiveContentHash: item.entry.contentHash, archiveVersionId: item.entry.archiveVersionId } });
  expect(plan.files[0].blockedReasons).not.toContain('archive_evidence_not_eligible');
});

test('a malformed unrelated ledger path cannot poison file classification', async () => {
  const item = await fixture();
  const plan = await buildOffloadPlan({ files: [item.file], ledgerSources: { malformed: { sourcePath: { invalid: true } } },
    harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(plan.files[0]).toMatchObject({ state: 'blocked_durability', historicalEvidenceMatched: false,
    blockedReasons: ['archive_evidence_not_eligible', 'production_evidence_pause'] });
});

test('legacy evidence without a complete stat fingerprint is ineligible, not source-changed', async () => {
  const item = await fixture();
  delete item.entry.statFingerprint;
  const plan = await buildOffloadPlan({ files: [item.file], ledgerSources: { legacy: item.entry },
    harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(plan.files[0]).toMatchObject({ state: 'blocked_durability', historicalEvidenceMatched: false,
    blockedReasons: ['archive_evidence_not_eligible', 'production_evidence_pause'] });
  expect(plan.files[0].blockedReasons).not.toContain('source_changed');
});

test('planner uses configured bounds, isolates oversized files, and handles a large inventory', async () => {
  const items = await Promise.all(Array.from({ length: 18 }, () => fixture()));
  const plan = await buildOffloadPlan({ files: items.map((item) => item.file),
    ledgerSources: Object.fromEntries(items.map((item, index) => [String(index), item.entry])),
    harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0,
    limits: { uploadConcurrency: 4, eligibilityByteLimit: 64, snapshotMaxAttempts: 2 } });
  expect(plan.planning).toEqual({ concurrency: 3, eligibilityByteLimit: 64, snapshotMaxAttempts: 2 });
  expect(plan.files).toHaveLength(18);
  const oversized = await fixture();
  const oversizedPlan = await buildOffloadPlan({ files: [oversized.file], ledgerSources: { one: oversized.entry },
    harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0,
    limits: { uploadConcurrency: 8, eligibilityByteLimit: 4, snapshotMaxAttempts: 1 } });
  expect(oversizedPlan.files[0].blockedReasons).toEqual(
    ['eligibility_byte_limit_exceeded', 'archive_evidence_not_eligible', 'production_evidence_pause']);
  expect(oversizedPlan.summary.retainedFiles).toBe(1);
});

test('one planning instant controls exact age boundary, generated time, and expiry', async () => {
  const item = await fixture();
  const stat = await fsp.stat(item.sourcePath, { bigint: true });
  const boundaryMs = Number(stat.mtimeNs / 1_000_000n) + 60 * 60 * 1000;
  const plan = await buildOffloadPlan({ files: [item.file], ledgerSources: { one: item.entry }, harnessStates: { codex: 'stopped' },
    now: new Date(boundaryMs), minClosedAgeHours: 1, planTtlMs: 1234 });
  expect(plan.generatedAt).toBe(new Date(boundaryMs).toISOString());
  expect(plan.expiresAt).toBe(new Date(boundaryMs + 1234).toISOString());
  expect(plan.files[0].blockedReasons).not.toContain('source_not_old_enough');
});

test('default harness observer only proves running and fails closed when process absence cannot prove stopped', async () => {
  const observed = await observeHarnessStates(['claude', 'codex', 'cursor'], {
    now: () => new Date('2026-07-21T00:00:00.000Z'),
    listProcesses: async () => ' 10 /usr/local/bin/claude\n 11 codex-helper\n 12 /opt/bin/node\n',
  });
  expect(observed).toMatchObject({
    claude: { state: 'running', method: 'exact_process_executable_positive_match', matchedPids: [10] },
    codex: { state: 'unknown', method: 'process_snapshot_absence_not_proof_of_stopped', matchedPids: [] },
    cursor: { state: 'unknown', method: 'unsupported_provider' },
  });
  const failed = await observeHarnessStates(['codex'], { listProcesses: async () => { const error: any = new Error('no ps'); error.code = 'ENOENT'; throw error; } });
  expect(failed.codex).toMatchObject({ state: 'unknown', method: 'process_snapshot_failed', errorCode: 'ENOENT' });
});

test('identical relative paths under distinct absolute roots have distinct identities and plans', async () => {
  const first = await fixture();
  const second = await fixture();
  const options = { harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 };
  const firstPlan = await buildOffloadPlan({ files: [first.file], ledgerSources: { one: first.entry }, ...options });
  const secondPlan = await buildOffloadPlan({ files: [second.file], ledgerSources: { one: second.entry }, ...options });
  expect(first.file.relative_path).toBe(second.file.relative_path);
  expect(firstPlan.files[0].displayPath).toBe(secondPlan.files[0].displayPath);
  expect(firstPlan.files[0].pathHash).not.toBe(secondPlan.files[0].pathHash);
  expect(firstPlan.planId).not.toBe(secondPlan.planId);
});

test('plan identity binds changed same-size content even when another reason already blocks offload', async () => {
  const item = await fixture('cursor');
  const options = { ledgerSources: { one: item.entry }, harnessStates: { cursor: 'stopped' },
    now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 };
  const first = await buildOffloadPlan({ files: [item.file], ...options });
  await fsp.writeFile(item.sourcePath, Buffer.from('{"event":"risk"}\n'));
  const second = await buildOffloadPlan({ files: [item.file], ...options });
  expect(first.files[0].blockedReasons).toContain('provider_offload_not_qualified');
  expect(second.files[0].blockedReasons).toContain('provider_offload_not_qualified');
  expect(first.files[0].bytes).toBe(second.files[0].bytes);
  expect(first.files[0].binding.contentHash).not.toBe(second.files[0].binding.contentHash);
  expect(first.planId).not.toBe(second.planId);
});

test('current snapshot size drives every byte total while discovery size remains diagnostic', async () => {
  const item = await fixture();
  item.file.byteSize = 999;
  const plan = await buildOffloadPlan({ files: [item.file], ledgerSources: { one: item.entry },
    harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  const actualBytes = item.content.length;
  expect(plan.files[0]).toMatchObject({ bytes: actualBytes, discoveryBytes: 999 });
  expect(plan.summary).toMatchObject({ selectedBytes: actualBytes, blockedBytes: actualBytes,
    retainedBytes: actualBytes, discoveryBytes: 999 });
  expect(plan.providers.codex).toMatchObject({ bytes: actualBytes, retainedBytes: actualBytes, discoveryBytes: 999 });
  for (const total of Object.values(plan.blockedReasons) as any[]) expect(total.bytes).toBe(actualBytes);
});

test('unknown harness and source age use blocked_active while durability failures stay blocked_durability', async () => {
  const currentMtime = new Date();
  const unknown = await fixture('codex', 'embedded_metadata', currentMtime);
  const young = await fixture('claude', 'embedded_metadata', currentMtime);
  const durability = await fixture('codex', 'embedded_metadata', currentMtime);
  durability.entry.receiptTrust = { ...durability.entry.receiptTrust, receiptHash: '0'.repeat(64) };
  const plan = await buildOffloadPlan({ files: [unknown.file, young.file, durability.file],
    ledgerSources: { unknown: unknown.entry, young: young.entry, durability: durability.entry },
    harnessStates: { codex: 'stopped', claude: 'stopped' }, now: new Date(), minClosedAgeHours: 24 });
  const durabilityFile = plan.files.find((file: any) => file.pathHash === canonicalHash({ normalizedPath: path.resolve(durability.sourcePath) }));
  expect(durabilityFile.state).toBe('blocked_active');
  const authorityPlan = await buildOffloadPlan({ files: [durability.file], ledgerSources: { durability: durability.entry },
    harnessStates: { codex: 'stopped' }, now: new Date(), minClosedAgeHours: 0 });
  expect(authorityPlan.files[0]).toMatchObject({ state: 'blocked_durability',
    blockedReasons: ['archive_evidence_not_eligible', 'production_evidence_pause'] });
  const unknownPlan = await buildOffloadPlan({ files: [unknown.file], ledgerSources: { unknown: unknown.entry },
    harnessStates: { codex: 'unknown' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(unknownPlan.files[0].state).toBe('blocked_active');
  expect(plan.files.find((file: any) => file.provider === 'claude').state).toBe('blocked_active');
});

test('historical evidence accounting survives active, age, provider, and attribution blockers', async () => {
  const running = await fixture();
  const unsupported = await fixture('cursor');
  const lowConfidence = await fixture('claude', 'basename');
  const plan = await buildOffloadPlan({ files: [running.file, unsupported.file, lowConfidence.file],
    ledgerSources: { running: running.entry, unsupported: unsupported.entry, lowConfidence: lowConfidence.entry },
    harnessStates: { codex: 'running', cursor: 'unknown', claude: 'stopped' }, now: new Date(), minClosedAgeHours: 24 });
  expect(plan.files.every((file: any) => file.historicalEvidenceMatched
    && file.historicalClaim.remoteCommitted && file.historicalClaim.restoreVerified)).toBe(true);
  expect(plan.summary).toMatchObject({ historicalClaimRemoteCommittedFiles: 3,
    historicalClaimRestoreVerifiedFiles: 3, eligibleFiles: 0, technicallyQualifiedFiles: 0 });
  expect(plan.files.every((file: any) => !file.eligible && !file.technicallyQualified
    && !file.remoteCommitted && !file.restoreVerified)).toBe(true);
});

test('source failures use stable error state while changed, active, and durability remain distinct', async () => {
  const unavailable = await fixture();
  await fsp.unlink(unavailable.sourcePath);
  const unreadable = await fixture('cursor');
  await fsp.chmod(unreadable.sourcePath, 0o000);
  const unavailablePlan = await buildOffloadPlan({ files: [unavailable.file], ledgerSources: { unavailable: unavailable.entry },
    harnessStates: { codex: 'stopped' }, now: new Date(), minClosedAgeHours: 0 });
  const unreadablePlan = await buildOffloadPlan({ files: [unreadable.file], ledgerSources: { unreadable: unreadable.entry },
    harnessStates: { cursor: 'stopped' }, now: new Date(), minClosedAgeHours: 0 });
  expect(unavailablePlan.files[0]).toMatchObject({ state: 'error',
    blockedReasons: expect.arrayContaining(['source_unavailable']) });
  expect(unreadablePlan.files[0]).toMatchObject({ state: 'error',
    blockedReasons: expect.arrayContaining(['source_read_failed']) });
});

test('offload plan accounts for sanitized discovery failures without exposing paths', async () => {
  const item = await fixture();
  const secretRoot = path.join(item.root, 'private-project');
  const plan = await buildOffloadPlan({ files: [item.file], ledgerSources: { one: item.entry },
    discoveryFailures: [{ provider: 'mech-run', kind: 'transcripts', state: 'discovery_error',
      reason: 'project_registry_unavailable', errorCode: 'EACCES', projectRoot: secretRoot,
      directoryPath: path.join(secretRoot, '.mech-run', 'transcripts') }],
    harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(plan).toMatchObject({ incomplete: true, summary: { discoveryFailures: 1 },
    discoveryFailureReasons: { project_registry_unavailable: 1 },
    discoveryFailures: [{ provider: 'mech-run', reason: 'project_registry_unavailable', errorCode: 'EACCES',
      projectPathHash: expect.stringMatching(/^[a-f0-9]{64}$/), directoryPathHash: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
  expect(JSON.stringify(plan)).not.toContain(item.root);
});

test('non-blocking discovery warnings remain visible without making the plan incomplete', async () => {
  const item = await fixture();
  const secretRoot = path.join(item.root, 'unsupported-provider');
  const plan = await buildOffloadPlan({ files: [item.file], ledgerSources: { one: item.entry },
    discoveryWarnings: [{ provider: 'cursor', kind: 'chats', state: 'discovery_error',
      reason: 'cursor_chats_presence_check_failed', errorCode: 'EACCES', directoryPath: secretRoot }],
    harnessStates: { codex: 'stopped' }, now: new Date('2026-07-21T13:00:00.000Z'), minClosedAgeHours: 0 });
  expect(plan).toMatchObject({ incomplete: false,
    summary: { discoveryFailures: 0, discoveryWarnings: 1 },
    discoveryWarningReasons: { cursor_chats_presence_check_failed: 1 },
    discoveryWarnings: [{ provider: 'cursor', reason: 'cursor_chats_presence_check_failed', errorCode: 'EACCES',
      directoryPathHash: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
  expect(JSON.stringify(plan)).not.toContain(item.root);
});
