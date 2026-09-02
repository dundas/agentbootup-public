import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { ARCHIVE_TRANSITIONS, ArchiveLedger, archiveLedgerRevision, getArchiveLedgerPath, validateInventoryEntryBinding } from '../../lib/transcript-archive/ledger.js';
import { ARCHIVE_STATUS, canonicalHash, createArchiveManifest, createAuditEvent, createDurabilityReceipt } from '../../lib/transcript-archive/contracts.js';
import { ARCHIVE_LIMITS } from '../../lib/transcript-archive/config.js';
import { getMachineId } from '../../lib/machine-id/machine-id.js';

const temporaryHomes = new Set<string>();
const priorMachineIdFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
const priorUnsafeTestHooks = process.env.AGENTBOOTUP_ARCHIVE_UNSAFE_TEST_HOOKS;
let machineIdHome: string;
beforeAll(async () => {
  machineIdHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-machine-id-'));
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(machineIdHome, 'machine-id');
  process.env.AGENTBOOTUP_ARCHIVE_UNSAFE_TEST_HOOKS = '1';
});
afterAll(async () => {
  if (priorMachineIdFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  else process.env.AGENTBOOTUP_MACHINE_ID_FILE = priorMachineIdFile;
  if (priorUnsafeTestHooks === undefined) delete process.env.AGENTBOOTUP_ARCHIVE_UNSAFE_TEST_HOOKS;
  else process.env.AGENTBOOTUP_ARCHIVE_UNSAFE_TEST_HOOKS = priorUnsafeTestHooks;
  await fsp.rm(machineIdHome, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all([...temporaryHomes].map((home) => fsp.rm(home, { recursive: true, force: true })));
  temporaryHomes.clear();
});

async function tempLedger() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-ledger-'));
  temporaryHomes.add(home);
  return { home, file: path.join(home, '.agentbootup', 'transcript-archive', 'ledger.json') };
}

const trustedReceiptVerifier = async ({ receipt, expected, receiptHash }: any) => (receipt.authentication?.signature === 'signed-receipt'
  && receipt.archiveVersionId === expected.archiveVersionId
  && receipt.manifestHash === expected.manifestHash
  && receipt.contentHash === expected.contentHash
  && receipt.byteSize === expected.byteSize)
  ? { receiptHash, manifestHash: expected.manifestHash, archiveVersionId: expected.archiveVersionId, contentHash: expected.contentHash,
    byteSize: expected.byteSize, storageGeneration: expected.storageGeneration, brainId: expected.brainId, provider: expected.provider,
    sessionId: expected.sessionId, sourceMachineId: expected.sourceMachineId, manifestLookup: 'authoritative_match',
    verifierId: 'test-ed25519', authenticatedAt: '2026-07-19T00:00:01.000Z',
    durabilityPolicy: receipt.durabilityClass === 'versioned_replicated' ? 'versioned_replicated_confirmed' : 'insufficient',
    serverTimePolicy: 'authenticated_store_time', bindingPolicy: 'exact_manifest_content_size_generation' }
  : { receiptHash: '0'.repeat(64), manifestHash: '0'.repeat(64), archiveVersionId: `av_${'0'.repeat(64)}`, contentHash: '0'.repeat(64), byteSize: 0,
    storageGeneration: 'bad', brainId: 'bad', provider: 'bad', sessionId: 'bad', sourceMachineId: 'bad', manifestLookup: 'missing',
    verifierId: 'test-ed25519', authenticatedAt: '2026-07-19T00:00:01.000Z', durabilityPolicy: 'insufficient', serverTimePolicy: 'untrusted', bindingPolicy: 'mismatch' };

const trustedRestoreVerifier = async ({ expected, restoreRead, verification }: any) => ({ ...expected,
  committedReadId: restoreRead?.committedReadId ?? verification.committedReadId,
  verifierId: 'test-restore', authenticatedAt: '2026-07-19T00:00:02.000Z' });

const AV = `av_${'1'.repeat(64)}`;
const BODY_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

function snapshot(overrides: any = {}) {
  return { sourceId: 'source-1', sourcePath: '/native/session.jsonl', sourceRelativePath: 'session.jsonl', brainId: 'brain-a', provider: 'codex',
    sessionId: 'session', machineId: 'machine-a', contentHash: BODY_HASH, statFingerprint: { size: 4 }, ...overrides };
}

function manifest(contentHash = BODY_HASH, byteSize = 4) {
  return createArchiveManifest({ brainId: 'brain-a', provider: 'codex', sessionId: 'session', sourceMachineId: 'machine-a', sourceRelativePath: 'session.jsonl',
    contentHash, byteSize, storageGeneration: 'object-v1', storageDurabilityClass: 'versioned_replicated', collectedAt: '2026-07-19T00:00:00Z' });
}

function receipt(archiveVersionId = AV, contentHash = BODY_HASH, byteSize = 4, manifestHash?: string) {
  if (!manifestHash) throw new Error('test receipt requires the manifest hash from its commit evidence');
  return createDurabilityReceipt({
    archiveVersionId, manifestHash, contentHash, byteSize,
    storageGeneration: 'object-v1', durabilityClass: 'versioned_replicated',
    committedAt: '2026-07-19T00:00:00.000Z', verificationStatus: 'remote_committed',
    logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: 'session' }, sourceMachineId: 'machine-a',
    authentication: { keyId: 'server-key', signature: 'signed-receipt' },
  });
}

function commitEvidence(contentHash = BODY_HASH, byteSize = 4) {
  const value = manifest(contentHash, byteSize);
  return { archiveVersionId: value.archiveVersionId, manifestHash: canonicalHash(value), manifest: value, receipt: receipt(value.archiveVersionId, contentHash, byteSize, canonicalHash(value)) };
}

test('ledger is outside native roots, restrictive, atomic, and metadata-only', async () => {
  const { home, file } = await tempLedger();
  expect(getArchiveLedgerPath({ home })).toBe(file);
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  await ledger.recordSnapshot({ sourceId: 'source-1', sourcePath: '/native/session.jsonl', statFingerprint: { size: 4 }, contentHash: 'a'.repeat(64) });
  expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
  expect(await fsp.readdir(path.dirname(file))).toEqual(['ledger.json']);
  await expect(ledger.recordSnapshot({ sourceId: 'bad', rawBody: 'secret transcript body' })).rejects.toThrow(/unknown snapshot field/i);
  expect(await fsp.readFile(file, 'utf8')).not.toContain('secret transcript body');
});

test('ledger reads reject special files without opening a blocking stream', async () => {
  const { file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const created = Bun.spawnSync(['mkfifo', file]);
  expect(created.exitCode).toBe(0);
  await expect(new ArchiveLedger({ file }).read()).rejects.toThrow(/regular file/i);
});

test('ledger transitions fail closed without complete evidence', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  await ledger.recordSnapshot(snapshot());
  const mismatched = commitEvidence();
  mismatched.archiveVersionId = `av_${'2'.repeat(64)}`;
  mismatched.receipt = receipt(mismatched.archiveVersionId, BODY_HASH, 4, mismatched.manifestHash);
  await expect(ledger.transition('source-1', 'remote_committed', mismatched)).rejects.toThrow(/archiveVersionId.*manifest/i);
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  await expect(ledger.transition('source-1', 'restore_verified', {})).rejects.toThrow(/restore read|plain metadata/);
  await ledger.transition('source-1', 'restore_verified', { restoreRead: { bytes: Buffer.from('test'), committedReadId: 'read-1' } });
  const state = await ledger.read();
  expect(state.sources['source-1'].state).toBe('restore_verified');
});

test('stored authoritative state rejects a ledger and manifest archive-version split', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  const state = await ledger.read({ verify: false });
  const entry = state.sources['source-1'];
  entry.archiveVersionId = `av_${'2'.repeat(64)}`;
  entry.receipt = { ...entry.receipt, archiveVersionId: entry.archiveVersionId };
  entry.receiptTrust = { ...entry.receiptTrust, archiveVersionId: entry.archiveVersionId, receiptHash: canonicalHash(entry.receipt) };
  await fsp.writeFile(file, JSON.stringify(state));
  await expect(ledger.read()).rejects.toThrow(/manifest archiveVersionId.*ledger archiveVersionId/i);
});

test('every declared archive state has explicit lifecycle transitions', () => {
  expect(Object.keys(ARCHIVE_TRANSITIONS).sort()).toEqual([...ARCHIVE_STATUS].sort());
  expect(ARCHIVE_TRANSITIONS.legacy_unverified.includes('hashing')).toBe(true);
  expect(ARCHIVE_TRANSITIONS.inventory_present_unverified.includes('local_only')).toBe(true);
  expect(ARCHIVE_TRANSITIONS.blocked_active.includes('error')).toBe(true);
  expect(ARCHIVE_TRANSITIONS.changed_since_backup.includes('error')).toBe(true);
  const initialStates = new Set(['local_only', 'legacy_unverified', 'inventory_present_unverified', 'blocked_active']);
  const inbound = new Set(Object.values(ARCHIVE_TRANSITIONS).flat());
  for (const state of ARCHIVE_STATUS) expect(initialStates.has(state) || inbound.has(state)).toBe(true);
});

test('a crash before rename preserves the last durable ledger and cleans the temporary file', async () => {
  const { home, file } = await tempLedger();
  const initial = new ArchiveLedger({ file });
  await initial.recordSnapshot({ sourceId: 'source-1', contentHash: 'a'.repeat(64), statFingerprint: { size: 4 } });
  const crashing = new ArchiveLedger({ file, hooks: { beforeRename: async () => { throw new Error('simulated crash'); } } });
  await expect(crashing.recordSnapshot({ sourceId: 'source-2', contentHash: 'b'.repeat(64), statFingerprint: { size: 5 } })).rejects.toThrow('simulated crash');
  const state = await initial.read();
  expect(Object.keys(state.sources)).toEqual(['source-1']);
  expect((await fsp.readdir(path.dirname(file))).filter((name) => name.includes('.tmp-'))).toEqual([]);
});

test('a post-rename verification error explicitly reports that the write committed', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, hooks: { afterRename: async () => { throw new Error('simulated post-commit failure'); } } });
  await expect(ledger.recordSnapshot(snapshot())).rejects.toThrow(/write committed.*post-commit/i);
  expect((await new ArchiveLedger({ file }).read()).sources['source-1'].state).toBe('local_only');
});

test('migrates a v0 source map without manufacturing verification', async () => {
  const { home, file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 0, sources: { source: { contentHash: 'a'.repeat(64), verified: true } } }));
  const state = await new ArchiveLedger({ file }).read();
  expect(state.schemaVersion).toBe(1);
  expect(state.sources.source.state).toBe('local_only');
  expect(state.sources.source.verified).toBeUndefined();
});

test('v0 migration rejects malformed source entries instead of dropping inventory', async () => {
  const { file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  for (const malformed of [null, []]) {
    await fsp.writeFile(file, JSON.stringify({ schemaVersion: 0, sources: { malformed } }));
    await expect(new ArchiveLedger({ file }).read()).rejects.toThrow(/legacy ledger source.*plain metadata object/i);
  }
});

test('current ledger schema defaults an absent audit log but rejects invalid audit values', async () => {
  const { home, file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, sources: {} }));
  expect((await new ArchiveLedger({ file }).read()).audit).toEqual([]);
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, sources: {}, audit: null }));
  await expect(new ArchiveLedger({ file }).read()).rejects.toThrow(/audit must be an array/);
});

test('ledger load rejects oversized history before iterating attacker-controlled entries', async () => {
  const { home, file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, sources: {}, audit: new Array(100_001).fill(null) }));
  await expect(new ArchiveLedger({ file }).read()).rejects.toThrow(/audit exceeds the absolute safety ceiling/i);
});

test('ledger reads reject oversized files before parsing JSON', async () => {
  const { home, file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, 'x'.repeat(64 * 1024 + 1));
  await expect(new ArchiveLedger({ file, limits: { ledgerByteLimit: 64 * 1024 } }).read()).rejects.toThrow(/configured byte limit/i);
});

test('ledger load bounds the number of source records before validating them', async () => {
  const { home, file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const sources = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`source-${index}`, null]));
  for (const schemaVersion of [0, 1]) {
    await fsp.writeFile(file, JSON.stringify({ schemaVersion, sources, audit: [] }));
    await expect(new ArchiveLedger({ file }).read()).rejects.toThrow(/sources exceed the absolute safety ceiling/i);
  }
});

test('write persists the migrated ledger schema instead of legacy input', async () => {
  const { home, file } = await tempLedger();
  const legacy = { schemaVersion: 0, sources: { source: { contentHash: 'a'.repeat(64), verified: true } } };
  await new ArchiveLedger({ file }).write(legacy as any);
  const persisted = JSON.parse(await fsp.readFile(file, 'utf8'));
  expect(persisted.schemaVersion).toBe(1);
  expect(persisted.sources.source.state).toBe('local_only');
  expect(persisted.sources.source.verified).toBeUndefined();
});

test('rejects prototype-polluting source keys in current state and v0 migration', async () => {
  for (const schemaVersion of [0, 1]) {
    const { home, file } = await tempLedger();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `{"schemaVersion":${schemaVersion},"audit":[],"sources":{"__proto__":{"sourceId":"x"}}}`);
    await expect(new ArchiveLedger({ file }).read()).rejects.toThrow(/dangerous key/i);
    expect(({} as any).sourceId).toBeUndefined();
  }
  const { home, file } = await tempLedger();
  await expect(new ArchiveLedger({ file }).recordSnapshot({ sourceId: '__proto__', contentHash: 'a'.repeat(64), statFingerprint: { size: 1 } })).rejects.toThrow(/snapshot.sourceId.*dangerous/i);
});

test('incomplete authoritative evidence reports the missing trusted receipt boundary', async () => {
  const { home, file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, audit: [], sources: {
    source: { sourceId: 'source', state: 'local_only', generations: [], contentHash: 'a'.repeat(64), statFingerprint: { size: 1 }, receiptTrust: {} },
  } }));
  await expect(new ArchiveLedger({ file }).read()).rejects.toThrow(/fully trusted receipt and authoritative manifest/i);
});

test('rejects unknown ledger versions instead of interpreting them as v0', async () => {
  const { home, file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 2, sources: {} }));
  await expect(new ArchiveLedger({ file }).read()).rejects.toThrow(/unsupported ledger schema/i);
});

test('corrupt eviction state fails closed on read and write', async () => {
  const { home, file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, audit: [], sources: {
    source: { sourceId: 'source', state: 'offloaded', generations: [], contentHash: 'a'.repeat(64), statFingerprint: { size: 4 } },
  } }));
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  await expect(ledger.read()).rejects.toThrow(/offloaded|trusted receipt|verification/i);
  await expect(ledger.write(JSON.parse(await fsp.readFile(file, 'utf8')))).rejects.toThrow(/offloaded|trusted receipt|verification/i);
});

test('ledger fails closed when no-follow protection is unavailable', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, hooks: { noFollowSupported: false } });
  await expect(ledger.read()).rejects.toThrow(/O_NOFOLLOW|no-follow/i);
});

test('ledger locking fails loudly without stable machine identity', async () => {
  const { home, file } = await tempLedger();
  await expect(new ArchiveLedger({ file, hooks: { machineId: '' } }).recordSnapshot(snapshot())).rejects.toThrow(/stable machine identity/i);
});

test('first metadata-only snapshot receives an explicit local-only state', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot({ sourceId: 'metadata-only', sourcePath: '/native/session.jsonl' });
  expect((await ledger.read()).sources['metadata-only'].state).toBe('local_only');
  await expect(ledger.transition('metadata-only', 'remote_committed', commitEvidence())).rejects.toThrow(/stable snapshot byte size/);
});

test('snapshot source paths must be absolute and normalized at ingest', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  for (const sourcePath of ['relative/session.jsonl', '/safe/../unsafe/session.jsonl']) {
    await expect(ledger.recordSnapshot(snapshot({ sourcePath }))).rejects.toThrow(/absolute normalized path/i);
  }
  const manifestInput = { brainId: 'brain-a', provider: 'codex', sessionId: 'session', sourceMachineId: 'machine-a',
    contentHash: BODY_HASH, byteSize: 4, storageGeneration: 'g1', storageDurabilityClass: 'unknown', collectedAt: '2026-07-19T00:00:00Z' };
  for (const sourceRelativePath of ['../../../etc/passwd', '/etc/passwd', 'windows\\escape.jsonl']) {
    await expect(ledger.recordSnapshot(snapshot({ sourceRelativePath }))).rejects.toThrow(/sourceRelativePath/i);
    expect(() => createArchiveManifest({ ...manifestInput, sourceRelativePath })).toThrow(/sourceRelativePath/i);
  }
});

test('batch snapshot recording validates and writes the ledger once', async () => {
  const { file } = await tempLedger();
  let writes = 0;
  const ledger = new ArchiveLedger({ file, hooks: { beforeRename: async () => { writes++; } } });
  const result = await ledger.recordSnapshots([
    snapshot({ sourceId: 'batch-a' }),
    { sourceId: 'invalid', rawBody: 'must not enter the ledger' } as any,
    snapshot({ sourceId: 'batch-b', contentHash: 'b'.repeat(64) }),
  ]);
  expect(writes).toBe(1);
  expect(result.recordedSourceIds).toEqual(['batch-a', 'batch-b']);
  expect(result.failures).toHaveLength(1);
  expect(Object.keys((await ledger.read()).sources).sort()).toEqual(['batch-a', 'batch-b']);
  await expect(ledger.recordSnapshots([])).rejects.toThrow(/non-empty array/i);
});

test('metadata-only rescans require an explicit transition out of legacy states', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.write({ schemaVersion: 1, sources: { legacy: { sourceId: 'legacy', sourcePath: '/native/session.jsonl', state: 'legacy_unverified', generations: [] } }, audit: [] });
  await expect(ledger.recordSnapshot({ sourceId: 'legacy', sourcePath: '/native/session.jsonl' })).rejects.toThrow(/explicit lifecycle transition/i);
  await ledger.transition('legacy', 'local_only');
  await ledger.recordSnapshot({ sourceId: 'legacy', sourcePath: '/native/session.jsonl' });
  expect((await ledger.read()).sources.legacy.state).toBe('local_only');
});

test('unchanged rescans preserve evidence while growth and truncation mark changed generations', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  const first = snapshot();
  await ledger.recordSnapshot(first);
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  await expect(ledger.recordSnapshot({ sourceId: 'source-1', sourcePath: first.sourcePath })).rejects.toThrow(/requires content hash and stable fingerprint/i);
  expect((await ledger.read()).sources['source-1'].state).toBe('remote_committed');
  await ledger.recordSnapshot(first);
  expect((await ledger.read()).sources['source-1'].state).toBe('remote_committed');
  await ledger.recordSnapshot({ ...first, contentHash: 'b'.repeat(64), statFingerprint: { size: 8 } });
  let entry = (await ledger.read()).sources['source-1'];
  expect(entry.state).toBe('changed_since_backup');
  expect(entry.receipt).toBeUndefined();
  await ledger.recordSnapshot({ ...first, contentHash: 'c'.repeat(64), statFingerprint: { size: 2 } });
  entry = (await ledger.read()).sources['source-1'];
  expect(entry.generations.map((generation) => generation.contentHash)).toEqual([BODY_HASH, 'b'.repeat(64), 'c'.repeat(64)]);
});

test('fingerprint key order cannot demote an unchanged committed source', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  const first = snapshot({ statFingerprint: { device: '1', inode: '2', size: 4 } });
  await ledger.recordSnapshot(first);
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  await ledger.recordSnapshot(snapshot({ statFingerprint: { size: 4, inode: '2', device: '1' } }));
  expect((await ledger.read()).sources['source-1'].state).toBe('remote_committed');
});

test('unchanged snapshots without machine identity do not duplicate generations', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  const machineLess = { sourceId: 'machine-less', contentHash: 'd'.repeat(64), statFingerprint: { size: 4 } };
  await ledger.recordSnapshot(machineLess);
  await ledger.recordSnapshot(machineLess);
  expect((await ledger.read()).sources['machine-less'].generations).toEqual([
    { contentHash: 'd'.repeat(64), machineId: null, statFingerprint: { size: 4 } },
  ]);
});

test('same bytes on a rotated inode record a distinct generation', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot(snapshot({ statFingerprint: { device: '1', inode: '10', size: 4, mtimeNs: '100', ctimeNs: '100' } }));
  await ledger.recordSnapshot(snapshot({ statFingerprint: { device: '1', inode: '11', size: 4, mtimeNs: '101', ctimeNs: '101' } }));
  expect((await ledger.read()).sources['source-1'].generations.map((generation) => generation.statFingerprint.inode)).toEqual(['10', '11']);
});

test('identity drift on byte-identical committed content requires a new backup', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  await expect(ledger.recordSnapshot(snapshot({ machineId: 'machine-b' }))).resolves.toBeUndefined();
  const entry = (await ledger.read()).sources['source-1'];
  expect(entry.state).toBe('changed_since_backup');
  expect(entry.receipt).toBeUndefined();
  expect(entry.generations.map((generation) => generation.machineId)).toEqual(['machine-a', 'machine-b']);
});

test('unsigned or unverified receipts can never advance commit or eviction state', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot(snapshot());
  await expect(ledger.transition('source-1', 'remote_committed', {
    ...commitEvidence(),
  })).rejects.toThrow(/authenticated receipt verification/i);
  expect((await ledger.read()).sources['source-1'].state).toBe('local_only');
});

test('eviction re-verifies authenticated receipt and restore bindings instead of trusting local ledger flags', async () => {
  const { home, file } = await tempLedger();
  const trusted = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  await trusted.recordSnapshot(snapshot());
  await trusted.transition('source-1', 'remote_committed', commitEvidence());
  await trusted.transition('source-1', 'restore_verified', { restoreRead: { bytes: Buffer.from('test'), committedReadId: 'read-1' } });
  const refusing = new ArchiveLedger({ file, receiptVerifier: async () => ({ authenticated: false }), restoreVerifier: trustedRestoreVerifier });
  await expect(refusing.transition('source-1', 'eviction_eligible')).rejects.toThrow(/receiptTrust|replicated durability/);
  await trusted.transition('source-1', 'eviction_eligible');
  expect((await trusted.read()).sources['source-1'].state).toBe('eviction_eligible');
  await expect(new ArchiveLedger({ file }).read()).rejects.toThrow(/fresh authenticated receipt verification/i);
});

test('restore verification is created only from authenticated committed bytes and revalidated on read', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  await expect(ledger.transition('source-1', 'restore_verified', { verification: { authoritative: true } } as any)).rejects.toThrow(/unknown restore verification evidence field/i);
  await expect(ledger.transition('source-1', 'restore_verified', { restoreRead: { bytes: Buffer.from('evil'), committedReadId: 'read-evil' } })).rejects.toThrow(/bytes do not exactly match/i);
  await ledger.transition('source-1', 'restore_verified', { restoreRead: { bytes: Buffer.from('test'), committedReadId: 'read-ok' } });
  const persisted = JSON.parse(await fsp.readFile(file, 'utf8'));
  expect(persisted.sources['source-1'].verification.bytes).toBeUndefined();
  await expect(new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier }).read()).rejects.toThrow(/authenticated restore verification/i);
});

test('malformed restore evidence is rejected before a remote verifier call', async () => {
  const { file } = await tempLedger();
  let verificationCalls = 0;
  const ledger = new ArchiveLedger({ file, receiptVerifier: async (input: any) => {
    verificationCalls++;
    return trustedReceiptVerifier(input);
  } });
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  verificationCalls = 0;
  await expect(ledger.transition('source-1', 'restore_verified', {})).rejects.toThrow(/restore read|plain metadata/i);
  expect(verificationCalls).toBe(0);
});

test('receipt authentication binds logical owner, machine, generation, and authoritative manifest lookup', async () => {
  const { home, file } = await tempLedger();
  const detached = async ({ receiptHash, expected }: any) => ({ receiptHash, ...expected, brainId: 'other-brain', manifestLookup: 'authoritative_match',
    verifierId: 'detached', authenticatedAt: '2026-07-19T00:00:01Z', durabilityPolicy: 'versioned_replicated_confirmed',
    serverTimePolicy: 'authenticated_store_time', bindingPolicy: 'exact_manifest_content_size_generation' });
  const ledger = new ArchiveLedger({ file, receiptVerifier: detached });
  await ledger.recordSnapshot(snapshot());
  await expect(ledger.transition('source-1', 'remote_committed', commitEvidence())).rejects.toThrow(/brainId|identit/i);
});

test('error and blocked durability states recover through safe retry and replication confirmation', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'error');
  await ledger.transition('source-1', 'uploading');
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  await ledger.transition('source-1', 'blocked_durability');
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  expect((await ledger.read()).sources['source-1'].state).toBe('remote_committed');
});

test('blocked durability evidence is reauthenticated and revoked receipts cannot advance restore', async () => {
  const { home, file } = await tempLedger();
  const trusted = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  await trusted.recordSnapshot(snapshot());
  await trusted.transition('source-1', 'remote_committed', commitEvidence());
  await trusted.transition('source-1', 'blocked_durability');
  const revoked = new ArchiveLedger({ file, receiptVerifier: async () => ({ authenticated: false }), restoreVerifier: trustedRestoreVerifier });
  await expect(revoked.read()).rejects.toThrow(/receiptTrust|authenticated receipt/i);
  await expect(revoked.transition('source-1', 'restore_verified', {
    restoreRead: { bytes: Buffer.from('test'), committedReadId: 'read-revoked' },
  })).rejects.toThrow(/receiptTrust|authenticated receipt/i);
  expect(JSON.parse(await fsp.readFile(file, 'utf8')).sources['source-1'].state).toBe('blocked_durability');
  await trusted.transition('source-1', 'error');
  const errored = (await revoked.read()).sources['source-1'];
  expect(errored.state).toBe('error');
  expect(errored.receipt).toBeUndefined();
});

test('demoting a committed source clears stale authoritative evidence', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  await ledger.transition('source-1', 'changed_since_backup');
  const entry = (await ledger.read()).sources['source-1'];
  expect(entry.state).toBe('changed_since_backup');
  for (const field of ['receipt', 'receiptTrust', 'verification', 'archiveVersionId', 'manifestHash', 'manifest']) expect(entry[field]).toBeUndefined();
});

test('hung authoritative verification is bounded and releases the mutation lock', async () => {
  const { home, file } = await tempLedger();
  const trusted = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  await trusted.recordSnapshot(snapshot());
  await trusted.transition('source-1', 'remote_committed', commitEvidence());

  const hanging = new ArchiveLedger({
    file,
    receiptVerifier: () => new Promise(() => {}),
    verifierTimeoutMs: 10,
  });
  await expect(hanging.read()).rejects.toThrow(/verification.*timed out/i);
  await hanging.recordSnapshot(snapshot());
  await trusted.recordSnapshot(snapshot());
  expect((await trusted.read()).sources['source-1'].state).toBe('remote_committed');
});

test('authoritative verification aborts concurrent hung verifiers', async () => {
  const { home, file } = await tempLedger();
  const trusted = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  for (const sourceId of ['source-1', 'source-2']) {
    await trusted.recordSnapshot(snapshot({ sourceId }));
    await trusted.transition(sourceId, 'remote_committed', commitEvidence());
  }
  let calls = 0;
  let aborted = 0;
  const hanging = new ArchiveLedger({ file, receiptVerifier: ({ signal }: any) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
  }, verifierTimeoutMs: 20 });
  await expect(hanging.read()).rejects.toThrow(/receipt verification timed out/i);
  expect(calls).toBe(2);
  expect(aborted).toBe(2);
});

test('authoritative verification respects its dedicated configured concurrency across batches', async () => {
  const { file } = await tempLedger();
  const trusted = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  for (let index = 0; index < 5; index++) {
    const sourceId = `batch-${index}`;
    await trusted.recordSnapshot(snapshot({ sourceId }));
    await trusted.transition(sourceId, 'remote_committed', commitEvidence());
  }
  let active = 0;
  let maximumActive = 0;
  const measured = new ArchiveLedger({ file, limits: { verifierConcurrency: 2 }, receiptVerifier: async (input: any) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return trustedReceiptVerifier(input);
  } });
  await measured.read();
  expect(maximumActive).toBe(2);
});

test('authoritative verification has an aggregate sweep deadline across batches', async () => {
  const { file } = await tempLedger();
  const trusted = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  await trusted.recordSnapshot(snapshot({ sourceId: 'deadline-base' }));
  await trusted.transition('deadline-base', 'remote_committed', commitEvidence());
  const state: any = await trusted.read({ verify: false });
  const expectedLedgerHash = archiveLedgerRevision(state);
  const base = state.sources['deadline-base'];
  state.sources = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`deadline-${index}`, { ...base, sourceId: `deadline-${index}` }]));
  await trusted.write(state, { expectedLedgerHash });
  const measured = new ArchiveLedger({ file, verifierTimeoutMs: 100, limits: {
    verifierConcurrency: 1, verificationSweepTimeoutMs: 1200, verificationSweepMaxTimeoutMs: 1200,
  }, receiptVerifier: async (input: any) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return trustedReceiptVerifier(input);
  } });
  await expect(measured.read()).rejects.toThrow(/verification sweep.*timed out/i);
});

test('unrelated structural mutations do not fan out remote verification under the lock', async () => {
  const { home, file } = await tempLedger();
  const trusted = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  await trusted.recordSnapshot(snapshot());
  await trusted.transition('source-1', 'remote_committed', commitEvidence());
  let verifierCalls = 0;
  const mutation = new ArchiveLedger({ file, receiptVerifier: async (input: any) => { verifierCalls++; return trustedReceiptVerifier(input); } });
  await mutation.recordSnapshot(snapshot({ sourceId: 'source-2', sessionId: 'session-2', contentHash: 'e'.repeat(64) }));
  expect(verifierCalls).toBe(0);
});

test('hung commit verification is bounded and releases the transition lock', async () => {
  const { home, file } = await tempLedger();
  const hanging = new ArchiveLedger({ file, receiptVerifier: () => new Promise(() => {}), verifierTimeoutMs: 10 });
  await hanging.recordSnapshot(snapshot());
  await expect(hanging.transition('source-1', 'remote_committed', commitEvidence())).rejects.toThrow(/receipt verification timed out/);

  const recovery = new ArchiveLedger({ file });
  await recovery.recordSnapshot(snapshot());
  expect((await recovery.read()).sources['source-1'].state).toBe('local_only');
});

test('non-evidence transitions cannot rewrite stable snapshot bindings', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot(snapshot());
  await expect(ledger.transition('source-1', 'hashing', { contentHash: 'f'.repeat(64) })).rejects.toThrow(/unknown hashing evidence field/i);
  expect((await ledger.read()).sources['source-1'].contentHash).toBe(BODY_HASH);
});

test('verifier ENOENT errors after opening the ledger are never mistaken for an empty ledger', async () => {
  const { home, file } = await tempLedger();
  const trusted = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  await trusted.recordSnapshot(snapshot());
  await trusted.transition('source-1', 'remote_committed', commitEvidence());
  const missingVerifierFile = Object.assign(new Error('verifier file missing'), { code: 'ENOENT' });
  await expect(new ArchiveLedger({ file, receiptVerifier: async () => { throw missingVerifierFile; } }).read()).rejects.toThrow('verifier file missing');
});

test('structural diagnostic reads are explicit and do not claim remote verification', async () => {
  const { file } = await tempLedger();
  const trusted = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier });
  await trusted.recordSnapshot(snapshot());
  await trusted.transition('source-1', 'remote_committed', commitEvidence());
  const diagnostic = new ArchiveLedger({ file });
  expect((await diagnostic.read({ verify: false })).sources['source-1'].state).toBe('remote_committed');
  await expect(diagnostic.read()).rejects.toThrow(/requires fresh authenticated receipt verification/i);
});

test('offload history is exact metadata and binds the deleted eligible source', async () => {
  const { home, file } = await tempLedger();
  let receiptAvailable = true;
  let restoreAvailable = true;
  const ledger = new ArchiveLedger({ file,
    receiptVerifier: async (input: any) => {
      if (!receiptAvailable) throw new Error('receipt revoked');
      return trustedReceiptVerifier(input);
    },
    restoreVerifier: async (input: any) => {
      if (!restoreAvailable) throw new Error('restore proof revoked');
      return trustedRestoreVerifier(input);
    } });
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  await ledger.transition('source-1', 'restore_verified', { restoreRead: { bytes: Buffer.from('test'), committedReadId: 'read-1' } });
  await ledger.transition('source-1', 'eviction_eligible');
  const archiveVersionId = (await ledger.read()).sources['source-1'].archiveVersionId;
  const offloadRecord = { schema: 'agentbootup.transcript.offload-record.v1', schemaVersion: 1, offloadedAt: '2026-07-19T00:00:03Z',
    originalPath: '/native/session.jsonl', archiveVersionId, contentHash: BODY_HASH, byteSize: 4, result: 'deleted', reason: 'none' };
  await ledger.transition('source-1', 'offloaded', { offloadRecord });
  expect((await ledger.read()).sources['source-1'].offloadHistory).toEqual([offloadRecord]);
  await expect(ledger.recordSnapshot(snapshot({ contentHash: 'f'.repeat(64), statFingerprint: { size: 5 } }))).rejects.toThrow(/explicit lifecycle transition/i);
  expect((await ledger.read()).sources['source-1'].archiveVersionId).toBe(archiveVersionId);
  await expect(ledger.transition('source-1', 'error')).rejects.toThrow(/invalid archive ledger transition/i);
  await expect(ledger.transition('source-1', 'local_restored')).rejects.toThrow(/recordRestoredSnapshot/i);
  const restoredSnapshot = snapshot({ statFingerprint: { device: '1', inode: '99', size: 4, mtimeNs: '2', ctimeNs: '2' } });
  const restoreRecord = {
    restoredAt: '2026-07-19T00:00:04Z', destination: '/native/session.jsonl', mode: 'native',
    archiveVersionId, contentHash: BODY_HASH, byteSize: 4, result: 'restored',
  };
  receiptAvailable = false;
  await expect(ledger.recordRestoredSnapshot('source-1', restoredSnapshot, restoreRecord)).rejects.toThrow(/receipt revoked/i);
  receiptAvailable = true;
  restoreAvailable = false;
  await expect(ledger.recordRestoredSnapshot('source-1', restoredSnapshot, restoreRecord)).rejects.toThrow(/restore proof revoked/i);
  restoreAvailable = true;
  await ledger.recordRestoredSnapshot('source-1', restoredSnapshot, restoreRecord);
  expect((await ledger.read()).sources['source-1'].state).toBe('local_restored');
  await expect(ledger.recordSnapshot(restoredSnapshot)).resolves.toBeUndefined();
});

test('offload requires a freshly authenticated replicated receipt', async () => {
  const { home, file } = await tempLedger();
  let receiptValid = true;
  const ledger = new ArchiveLedger({ file, receiptVerifier: async (input: any) => receiptValid ? trustedReceiptVerifier(input) : ({ authenticated: false }), restoreVerifier: trustedRestoreVerifier });
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'remote_committed', commitEvidence());
  await ledger.transition('source-1', 'restore_verified', { restoreRead: { bytes: Buffer.from('test'), committedReadId: 'read-offload' } });
  await ledger.transition('source-1', 'eviction_eligible');
  receiptValid = false;
  const current = JSON.parse(await fsp.readFile(file, 'utf8')).sources['source-1'];
  await expect(ledger.transition('source-1', 'offloaded', { offloadRecord: {
    schema: 'agentbootup.transcript.offload-record.v1', schemaVersion: 1, offloadedAt: '2026-07-19T00:00:03Z',
    originalPath: current.sourcePath, archiveVersionId: current.archiveVersionId, contentHash: current.contentHash,
    byteSize: current.statFingerprint.size, result: 'deleted', reason: 'none',
  } })).rejects.toThrow(/receiptTrust|authenticated receipt/i);
  expect(JSON.parse(await fsp.readFile(file, 'utf8')).sources['source-1'].state).toBe('eviction_eligible');
});

test('lock publication is atomic and ledger write detects ancestor replacement before rename', async () => {
  const { home, file } = await tempLedger();
  let lockVisible = true;
  const ledger = new ArchiveLedger({ file, hooks: { beforeLockPublish: async ({ lockFile }: any) => { lockVisible = await fsp.lstat(lockFile).then(() => true).catch(() => false); } } });
  await ledger.recordSnapshot(snapshot());
  expect(lockVisible).toBe(false);
  const parent = path.dirname(file);
  const moved = `${parent}-moved`;
  const swapping = new ArchiveLedger({ file, hooks: { beforeRename: async () => { await fsp.rename(parent, moved); await fsp.mkdir(parent); } } });
  await expect(swapping.recordSnapshot(snapshot({ sourceId: 'source-2' }))).rejects.toThrow(/parent identity changed/i);
  await fsp.rm(moved, { recursive: true, force: true });
});

test('a post-publication failure removes only the lock owned by that attempt', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, hooks: { afterLockPublish: async () => { throw new Error('simulated post-publish failure'); } } });
  await expect(ledger.recordSnapshot(snapshot())).rejects.toThrow(/simulated post-publish failure/i);
  expect(await fsp.lstat(`${file}.lock`).then(() => true).catch((error) => error.code !== 'ENOENT')).toBe(false);
});

test('a concurrent process retries through the two-link publication window', async () => {
  const { home, file } = await tempLedger();
  const marker = path.join(home, 'child-started');
  const moduleUrl = pathToFileURL(path.resolve('lib/transcript-archive/ledger.js')).href;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const ledger = new ArchiveLedger({ file, hooks: { afterLockPublish: async () => {
    const script = `import fsp from 'fs/promises'; import { ArchiveLedger } from ${JSON.stringify(moduleUrl)}; await fsp.writeFile(${JSON.stringify(marker)}, 'started'); const ledger = new ArchiveLedger({ file: ${JSON.stringify(file)} }); await ledger.recordSnapshot({ sourceId: 'child-source', contentHash: '${'d'.repeat(64)}', statFingerprint: { size: 1 } });`;
    child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fsp.lstat(marker).then(() => true).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } } });
  await ledger.recordSnapshot(snapshot());
  expect(child).toBeDefined();
  const exitCode = await child!.exited;
  const stderr = await new Response(child!.stderr).text();
  expect(stderr).not.toMatch(/\b(error|not implemented)\b/i);
  expect(exitCode).toBe(0);
  expect(Object.keys((await ledger.read()).sources).sort()).toEqual(['child-source', 'source-1']);
});

test('lock heartbeat keeps a live long-running writer from appearing stale', async () => {
  const { file } = await tempLedger();
  const moduleUrl = pathToFileURL(path.resolve('lib/transcript-archive/ledger.js')).href;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = new ArchiveLedger({ file, hooks: { testOnlyUnsafeTiming: true, machineId: 'heartbeat-machine', staleLockMs: 30, lockTimeoutMs: 1000,
    beforeRename: async () => { enter(); await gate; } } });
  const holderWrite = holder.recordSnapshot(snapshot());
  await entered;
  const script = `import { ArchiveLedger } from ${JSON.stringify(moduleUrl)}; const ledger = new ArchiveLedger({ file: ${JSON.stringify(file)}, hooks: { testOnlyUnsafeTiming: true, machineId: 'heartbeat-machine', staleLockMs: 30, lockTimeoutMs: 1000 } }); await ledger.recordSnapshot({ sourceId: 'heartbeat-child', contentHash: '${'e'.repeat(64)}', statFingerprint: { size: 1 } });`;
  const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  await holderWrite;
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).not.toMatch(/stale|Error/i);
  expect(Object.keys((await holder.read()).sources).sort()).toEqual(['heartbeat-child', 'source-1']);
});

test('a corrupt replacement lock cannot mask a completed write or deadlock later writers', async () => {
  const { home, file } = await tempLedger();
  let corruptOnce = true;
  const ledger = new ArchiveLedger({ file, hooks: { beforeRename: async () => {
    if (!corruptOnce) return;
    corruptOnce = false;
    await fsp.writeFile(`${file}.lock`, 'corrupt owner');
  } } });
  await expect(ledger.recordSnapshot(snapshot())).resolves.toBeUndefined();
  await expect(ledger.recordSnapshot(snapshot())).resolves.toBeUndefined();
});

test('configured ledger history limits fail closed without discarding evidence', async () => {
  const { home, file } = await tempLedger();
  const limits = { ledgerGenerationLimit: 2, ledgerRestoreHistoryLimit: 2, ledgerAuditLimit: 2 };
  const ledger = new ArchiveLedger({ file, limits, receiptVerifier: trustedReceiptVerifier });
  for (const hash of ['a', 'b']) await ledger.recordSnapshot(snapshot({ contentHash: hash.repeat(64) }));
  await expect(ledger.recordSnapshot(snapshot({ contentHash: 'c'.repeat(64) }))).rejects.toThrow(/generation history limit reached/i);
  await ledger.recordSnapshot(snapshot({ sourceId: 'restored' }));
  await ledger.transition('restored', 'remote_committed', commitEvidence());
  const restoredVersion = (await ledger.read()).sources.restored.archiveVersionId;
  await expect(ledger.recordRestore('restored', { restoredAt: '2026-07-19T00:00:09.000Z', destination: '/tmp/claimed', mode: 'analysis_cache',
    archiveVersionId: restoredVersion, contentHash: BODY_HASH, byteSize: 4, result: 'restored' })).rejects.toThrow(/successful restores require/i);
  await expect(ledger.recordRestore('restored', { restoredAt: '2026-07-19T00:00:09.000Z', destination: '/tmp/wrong', mode: 'analysis_cache',
    archiveVersionId: restoredVersion, contentHash: 'f'.repeat(64), byteSize: 4, result: 'error' })).rejects.toThrow(/exactly bind/i);
  for (let index = 0; index < 2; index++) {
    await ledger.recordRestore('restored', {
      restoredAt: `2026-07-19T00:00:0${index}.000Z`, destination: `/tmp/restore-${index}`, mode: 'analysis_cache',
      archiveVersionId: restoredVersion, contentHash: BODY_HASH, byteSize: 4, result: 'error',
    });
    await ledger.recordAudit(createAuditEvent({ eventId: `event-${index}`, type: 'restore', occurredAt: `2026-07-19T00:00:0${index}.000Z`,
      brainId: 'brain-a', provider: 'codex', actor: 'test', result: 'success', reason: 'none' }));
  }
  await expect(ledger.recordRestore('restored', { restoredAt: '2026-07-19T00:00:02.000Z', destination: '/tmp/restore-2', mode: 'analysis_cache',
    archiveVersionId: restoredVersion, contentHash: BODY_HASH, byteSize: 4, result: 'error' })).rejects.toThrow(/restoration history limit reached/i);
  await expect(ledger.recordAudit(createAuditEvent({ eventId: 'event-2', type: 'restore', occurredAt: '2026-07-19T00:00:02.000Z',
    brainId: 'brain-a', provider: 'codex', actor: 'test', result: 'success', reason: 'none' }))).rejects.toThrow(/audit history limit reached/i);
  const state = await ledger.read();
  expect(state.sources['source-1'].generations.map((item) => item.contentHash)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  expect(state.sources.restored.restorationHistory.map((item) => item.destination)).toEqual(['/tmp/restore-0', '/tmp/restore-1']);
  expect(state.audit.map((item) => item.eventId)).toEqual(['event-0', 'event-1']);
});

test('verified history export provides a supported drain path for configured limits', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, limits: { ledgerGenerationLimit: 1, ledgerAuditLimit: 1 } });
  await ledger.recordSnapshot(snapshot({ contentHash: 'a'.repeat(64) }));
  await ledger.recordAudit(createAuditEvent({ eventId: 'before-drain', type: 'restore', occurredAt: '2026-07-19T00:00:00Z',
    brainId: 'brain-a', provider: 'codex', actor: 'test', result: 'success', reason: 'none' }));
  await expect(ledger.recordSnapshot(snapshot({ contentHash: 'b'.repeat(64) }))).rejects.toThrow(/generation history limit/i);
  const exportRoot = path.join(home, 'exports');
  await fsp.mkdir(exportRoot);
  const destination = path.join(exportRoot, 'ledger-history-1.json');
  await expect(ledger.archiveHistoryTo(destination)).rejects.toThrow(/explicit trustedRoot/i);
  const archive = await ledger.archiveHistoryTo(destination, { trustedRoot: home });
  const raw = await fsp.readFile(destination);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(archive.contentHash);
  expect(JSON.parse(raw.toString()).counts).toMatchObject({ audit: 1, generations: 1 });
  expect((await fsp.stat(destination)).mode & 0o777).toBe(0o600);
  const compacted = await ledger.read();
  expect(compacted.sources['source-1'].generations.map((item) => item.contentHash)).toEqual(['a'.repeat(64)]);
  expect(compacted.sources['source-1'].historyArchive).toMatchObject({ destination, contentHash: archive.contentHash });
  expect(compacted.historyArchive).toEqual(compacted.sources['source-1'].historyArchive);
  await expect(ledger.recordSnapshot(snapshot({ contentHash: 'b'.repeat(64) }))).resolves.toBeUndefined();
  await expect(ledger.recordAudit(createAuditEvent({ eventId: 'after-drain', type: 'restore', occurredAt: '2026-07-19T00:00:01Z',
    brainId: 'brain-a', provider: 'codex', actor: 'test', result: 'success', reason: 'none' }))).resolves.toBeUndefined();
});

test('history export retries the same verified artifact after compaction failure', async () => {
  const { home, file } = await tempLedger();
  let failCompaction = false;
  const ledger = new ArchiveLedger({ file, hooks: { beforeRename: async () => {
    if (failCompaction) { failCompaction = false; throw new Error('simulated compaction failure'); }
  } } });
  await ledger.recordSnapshot(snapshot());
  const exportRoot = path.join(home, 'exports');
  await fsp.mkdir(exportRoot);
  const destination = path.join(exportRoot, 'retry.json');
  failCompaction = true;
  await expect(ledger.archiveHistoryTo(destination, { trustedRoot: home })).rejects.toThrow(/simulated compaction failure/i);
  expect(await fsp.lstat(destination).then(() => true)).toBe(true);
  const result = await ledger.archiveHistoryTo(destination, { trustedRoot: home });
  expect(result.created).toBe(false);
  const compacted = await ledger.read();
  expect(compacted.sources['source-1'].generations).toHaveLength(1);
  expect(compacted.sources['source-1'].historyArchive).toMatchObject({ destination, contentHash: result.contentHash });
  expect(compacted.historyArchive).toEqual(compacted.sources['source-1'].historyArchive);
});

test('history export rejects symlinked ancestors beneath its trusted root', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot(snapshot());
  const real = path.join(home, 'real-export');
  await fsp.mkdir(path.join(real, 'nested'), { recursive: true });
  await fsp.symlink(real, path.join(home, 'linked-export'));
  await expect(ledger.archiveHistoryTo(path.join(home, 'linked-export', 'nested', 'history.json'), { trustedRoot: home })).rejects.toThrow(/symlink/i);
});

test('configured ceilings above defaults remain readable and writable', async () => {
  const { home, file } = await tempLedger();
  const event = createAuditEvent({ eventId: 'event-large-limit', type: 'restore', occurredAt: '2026-07-19T00:00:00.000Z',
    brainId: 'brain-a', provider: 'codex', actor: 'test', result: 'success', reason: 'none' });
  const ledger = new ArchiveLedger({ file, limits: { ledgerAuditLimit: ARCHIVE_LIMITS.ledgerAuditLimit + 2 } });
  const audit = Array.from({ length: ARCHIVE_LIMITS.ledgerAuditLimit + 1 }, (_, index) => ({ ...event, eventId: `event-large-${index}` }));
  await ledger.write({ schemaVersion: 1, sources: {}, audit });
  expect((await ledger.read()).audit).toHaveLength(ARCHIVE_LIMITS.ledgerAuditLimit + 1);
});

test('lowered configured history limits preserve evidence and block further append', async () => {
  const { home, file } = await tempLedger();
  const events = [0, 1, 2].map((index) => createAuditEvent({ eventId: `lower-${index}`, type: 'restore', occurredAt: `2026-07-19T00:00:0${index}.000Z`,
    brainId: 'brain-a', provider: 'codex', actor: 'test', result: 'success', reason: 'none' }));
  await new ArchiveLedger({ file, limits: { ledgerAuditLimit: 3 } }).write({ schemaVersion: 1, sources: {}, audit: events });
  const lowered = new ArchiveLedger({ file, limits: { ledgerAuditLimit: 2 } });
  expect((await lowered.read()).audit.map((event) => event.eventId)).toEqual(['lower-0', 'lower-1', 'lower-2']);
  await expect(lowered.recordAudit(createAuditEvent({ eventId: 'lower-3', type: 'restore', occurredAt: '2026-07-19T00:00:03.000Z',
    brainId: 'brain-a', provider: 'codex', actor: 'test', result: 'success', reason: 'none' }))).rejects.toThrow(/audit history limit reached/i);
  expect(JSON.parse(await fsp.readFile(file, 'utf8')).audit.map((event: any) => event.eventId)).toEqual(['lower-0', 'lower-1', 'lower-2']);
});

test('ledger accepts central limits and rejects unknown ones', async () => {
  const { home, file } = await tempLedger();
  expect(() => new ArchiveLedger({ file, limits: { ...ARCHIVE_LIMITS, verifierTimeoutMs: 20 } })).not.toThrow();
  expect(() => new ArchiveLedger({ file, hooks: { lockTimeoutMs: 20 } })).toThrow(/lockTimeoutMs hook/i);
  expect(() => new ArchiveLedger({ file, limits: { unknownLimit: 20 } as any })).toThrow(/unknown archive limit/i);
  expect(() => new ArchiveLedger({ file, verifierTimeoutMs: 50, limits: { verifierTimeoutMs: 5000 } })).toThrow(/conflicting verifierTimeoutMs/i);
  expect(() => new ArchiveLedger({ file, verifierTimeoutMs: 300_000, limits: { lockTimeoutMs: 1_020 } })).toThrow(/lock timeouts/i);
  expect(() => new ArchiveLedger({ file, verifierTimeoutMs: 10, limits: { staleLockMs: 5_000, lockTimeoutMs: 5_000 } })).toThrow(/staleLockMs.*shorter/i);
  const maximumVerifier: any = new ArchiveLedger({ file, verifierTimeoutMs: 300_000,
    limits: { verificationSweepTimeoutMs: 601_000, staleLockMs: 601_000 } });
  expect(maximumVerifier.hooks.lockTimeoutMs).toBeGreaterThanOrEqual(601_000);
});

test('ledger accepts only explicit metadata schemas, including nested values', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await expect(ledger.recordSnapshot({ sourceId: 'bad', sourcePath: '/safe', extra: { innocentName: 'raw transcript' } })).rejects.toThrow(/unknown snapshot field/i);
  await expect(ledger.recordSnapshot({ sourceId: 'bad', sourcePath: '/safe', statFingerprint: { size: 4, body: 'secret' } })).rejects.toThrow(/unknown statFingerprint field/i);
  await expect(ledger.recordSnapshot({ sourceId: 'bad-size', statFingerprint: { size: '4' } as any })).rejects.toThrow(/size.*number/i);
  await expect(ledger.recordSnapshot({ sourceId: 'bad-inode', statFingerprint: { size: 4, inode: 2 } as any })).rejects.toThrow(/inode.*string/i);
  await expect(ledger.recordSnapshot({ sourceId: 'bad', matchMethod: 'x'.repeat(129), statFingerprint: { size: 4 } })).rejects.toThrow(/bounded safe metadata/i);
  await expect(ledger.recordSnapshot({ sourceId: 'unsafe-identity', brainId: 'brain a', provider: 'codex', sessionId: 'a/../b', machineId: 'machine-a' })).rejects.toThrow(/snapshot.brainId|snapshot.sessionId/i);
  await expect(ledger.recordSnapshot({ sourceId: 'brain\0codex\0different:/safe', brainId: 'brain', provider: 'codex', sessionId: 'session', logicalSessionKey: 'brain\0codex\0different' })).rejects.toThrow(/does not match/i);
});

test('stale valid dead-owner locks are recovered only for the same machine and corrupt ownership fails closed', async () => {
  for (const owner of [{ pid: 99999999, token: '00000000-0000-4000-8000-000000000000', machineId: 'machine-test', createdAt: '2020-01-01T00:00:00Z' }]) {
    const { home, file } = await tempLedger();
    const lockFile = `${file}.lock`;
    await fsp.mkdir(path.dirname(lockFile), { recursive: true });
    await fsp.writeFile(lockFile, JSON.stringify(owner));
    await fsp.utimes(lockFile, new Date(0), new Date(0));
    const ledger = new ArchiveLedger({ file, hooks: { testOnlyUnsafeTiming: true, staleLockMs: 0, lockTimeoutMs: 500, machineId: 'machine-test' } });
    await ledger.recordSnapshot({ sourceId: 'source', contentHash: 'a'.repeat(64), statFingerprint: { size: 1 } });
    expect((await ledger.read()).sources.source.state).toBe('local_only');
    expect(await fsp.lstat(lockFile).then(() => true).catch((error) => error.code !== 'ENOENT')).toBe(false);
  }
  const foreign = await tempLedger();
  await fsp.mkdir(path.dirname(foreign.file), { recursive: true });
  await fsp.writeFile(`${foreign.file}.lock`, JSON.stringify({ pid: 99999999, token: '00000000-0000-4000-8000-000000000000', machineId: 'other-machine', createdAt: '2020-01-01T00:00:00Z' }));
  await fsp.utimes(`${foreign.file}.lock`, new Date(0), new Date(0));
  await expect(new ArchiveLedger({ file: foreign.file, hooks: { testOnlyUnsafeTiming: true, staleLockMs: 0, lockTimeoutMs: 20, machineId: 'machine-test' } }).recordSnapshot(snapshot())).rejects.toThrow(/foreign machine.*remove/i);
  await fsp.rm(foreign.home, { recursive: true });
  const activeForeign = await tempLedger();
  await fsp.mkdir(path.dirname(activeForeign.file), { recursive: true });
  await fsp.writeFile(`${activeForeign.file}.lock`, JSON.stringify({ pid: 1, token: '00000000-0000-4000-8000-000000000000', machineId: 'other-machine', createdAt: new Date().toISOString() }));
  await expect(new ArchiveLedger({ file: activeForeign.file, hooks: { testOnlyUnsafeTiming: true, staleLockMs: 60_000, lockTimeoutMs: 20, machineId: 'machine-test' } }).recordSnapshot(snapshot())).rejects.toThrow(/^timed out acquiring/);
  await fsp.rm(activeForeign.home, { recursive: true });
  const { home, file } = await tempLedger();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(`${file}.lock`, '{broken');
  await expect(new ArchiveLedger({ file, hooks: { testOnlyUnsafeTiming: true, staleLockMs: 0, lockTimeoutMs: 20 } }).recordSnapshot(snapshot())).rejects.toThrow(/uncertain owner/i);
  await fsp.writeFile(`${file}.lock`, JSON.stringify({ pid: 99999999, token: '00000000-0000-4000-8000-000000000000', machineId: null, createdAt: '2020-01-01T00:00:00Z' }));
  await expect(new ArchiveLedger({ file, hooks: { testOnlyUnsafeTiming: true, staleLockMs: 0, lockTimeoutMs: 20 } }).recordSnapshot(snapshot())).rejects.toThrow(/uncertain owner/i);
  await fsp.writeFile(`${file}.lock`, 'x'.repeat(4097));
  await expect(new ArchiveLedger({ file, hooks: { testOnlyUnsafeTiming: true, staleLockMs: 0, lockTimeoutMs: 20 } }).recordSnapshot(snapshot())).rejects.toThrow(/uncertain owner/i);
  await fsp.writeFile(`${file}.lock`, '{broken');
  await fsp.utimes(`${file}.lock`, new Date(0), new Date(0));
  await new ArchiveLedger({ file, hooks: { testOnlyUnsafeTiming: true, corruptStaleLockMs: 0, lockTimeoutMs: 100, machineId: 'machine-test' } }).recordSnapshot(snapshot());
  expect((await new ArchiveLedger({ file }).read()).sources['source-1'].state).toBe('local_only');
});

test('default stable machine identity reclaims a local dead-owner lock', async () => {
  const { home, file } = await tempLedger();
  const machineId = await getMachineId();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(`${file}.lock`, JSON.stringify({ pid: 99999999, token: '00000000-0000-4000-8000-000000000000', machineId, createdAt: '2020-01-01T00:00:00Z' }));
  await fsp.utimes(`${file}.lock`, new Date(0), new Date(0));
  const ledger = new ArchiveLedger({ file, hooks: { testOnlyUnsafeTiming: true, staleLockMs: 0, lockTimeoutMs: 500 } });
  await ledger.recordSnapshot(snapshot());
  expect((await ledger.read()).sources['source-1'].state).toBe('local_only');
});

test('lock disappearance between lstat and owner read is retried', async () => {
  const { home, file } = await tempLedger();
  const machineId = await getMachineId();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, token: '00000000-0000-4000-8000-000000000000', machineId, createdAt: new Date().toISOString() }));
  let removed = false;
  const ledger = new ArchiveLedger({ file, hooks: { beforeReadLockOwner: async ({ lockFile }: any) => {
    if (!removed) { removed = true; await fsp.unlink(lockFile); }
  } } });
  await ledger.recordSnapshot(snapshot());
  expect((await ledger.read()).sources['source-1'].state).toBe('local_only');
});

test('concurrent ledger instances serialize mutations without lost updates', async () => {
  const { home, file } = await tempLedger();
  const a = new ArchiveLedger({ file });
  const b = new ArchiveLedger({ file });
  await Promise.all([
    a.recordSnapshot({ sourceId: 'source-a', contentHash: 'a'.repeat(64), machineId: 'one', statFingerprint: { size: 4 } }),
    b.recordSnapshot({ sourceId: 'source-b', contentHash: 'b'.repeat(64), machineId: 'two', statFingerprint: { size: 5 } }),
  ]);
  expect(Object.keys((await a.read()).sources).sort()).toEqual(['source-a', 'source-b']);
});

test('full-ledger replacement rejects a stale expected revision', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot(snapshot());
  const staleState = await ledger.read({ verify: false });
  const expectedLedgerHash = archiveLedgerRevision(staleState);
  await ledger.recordSnapshot(snapshot({ sourceId: 'newer-source', contentHash: 'e'.repeat(64) }));
  await expect(ledger.write(staleState, { expectedLedgerHash })).rejects.toThrow(/changed since it was read/i);
  expect((await ledger.read({ verify: false })).sources['newer-source']).toBeDefined();
});

test('in-process ledger lock waiters time out without bypassing the active holder', async () => {
  const { file } = await tempLedger();
  let releaseRename!: () => void;
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseRename = resolve; });
  let first = true;
  const ledger = new ArchiveLedger({ file, hooks: { testOnlyUnsafeTiming: true, machineId: 'machine-test', queueTimeoutMs: 20, beforeRename: async () => {
    if (!first) return;
    first = false;
    signalEntered();
    await gate;
  } } });
  const holder = ledger.recordSnapshot(snapshot());
  await entered;
  await expect(ledger.recordSnapshot(snapshot({ sourceId: 'queued' }))).rejects.toThrow(/timed out waiting for in-process/i);
  releaseRename();
  await holder;
  await ledger.recordSnapshot(snapshot({ sourceId: 'after-holder' }));
});

test('cross-process ledger writers serialize without lost updates', async () => {
  const { home, file } = await tempLedger();
  const moduleUrl = new URL('../../lib/transcript-archive/ledger.js', import.meta.url).href;
  const child = (id: string, hash: string) => Bun.spawn({
    cmd: [process.execPath, '--eval', `import { ArchiveLedger } from ${JSON.stringify(moduleUrl)};
      await new ArchiveLedger({ file: ${JSON.stringify(file)} }).recordSnapshot({ sourceId: ${JSON.stringify(id)}, contentHash: ${JSON.stringify(hash)}, statFingerprint: { size: 1 } });`],
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, AGENTBOOTUP_MACHINE_ID_FILE: process.env.AGENTBOOTUP_MACHINE_ID_FILE! },
  });
  const children = [child('process-a', 'a'.repeat(64)), child('process-b', 'b'.repeat(64))];
  expect(await Promise.all(children.map((process) => process.exited))).toEqual([0, 0]);
  expect(Object.keys((await new ArchiveLedger({ file }).read()).sources).sort()).toEqual(['process-a', 'process-b']);
});

test('concurrent stale-lock reclaim has one winner and preserves both writers', async () => {
  const { home, file } = await tempLedger();
  const lockFile = `${file}.lock`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(lockFile, JSON.stringify({ pid: 99999999, token: '00000000-0000-4000-8000-000000000000', machineId: 'reclaim-machine', createdAt: '2020-01-01T00:00:00Z' }));
  await fsp.utimes(lockFile, new Date(0), new Date(0));
  const moduleUrl = new URL('../../lib/transcript-archive/ledger.js', import.meta.url).href;
  const run = (id: string, hash: string) => Bun.spawn([process.execPath, '--eval', `
    import { ArchiveLedger } from ${JSON.stringify(moduleUrl)};
    await new ArchiveLedger({ file: ${JSON.stringify(file)}, hooks: { testOnlyUnsafeTiming: true, machineId: 'reclaim-machine', staleLockMs: 0, lockTimeoutMs: 1000 } })
      .recordSnapshot({ sourceId: ${JSON.stringify(id)}, contentHash: ${JSON.stringify(hash)}, statFingerprint: { size: 1 } });`], {
    cwd: path.resolve('.'), env: { ...process.env, AGENTBOOTUP_MACHINE_ID_FILE: process.env.AGENTBOOTUP_MACHINE_ID_FILE! },
  });
  const processes = [run('reclaim-a', 'a'.repeat(64)), run('reclaim-b', 'b'.repeat(64))];
  expect(await Promise.all(processes.map((child) => child.exited))).toEqual([0, 0]);
  expect(Object.keys((await new ArchiveLedger({ file }).read()).sources).sort()).toEqual(['reclaim-a', 'reclaim-b']);
});

test('a scan without a fingerprint cannot retain stale stat evidence', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot(snapshot({ statFingerprint: { size: 4 } }));
  await ledger.recordSnapshot({ sourceId: 'source-1', contentHash: 'a'.repeat(64) });
  expect((await ledger.read()).sources['source-1'].statFingerprint).toBeUndefined();
});

test('a scan without a hash cannot bind an old hash to a new fingerprint', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot(snapshot({ statFingerprint: { size: 4 } }));
  await ledger.recordSnapshot({ sourceId: 'source-1', statFingerprint: { size: 99 } });
  const entry = (await ledger.read()).sources['source-1'];
  expect(entry.contentHash).toBeUndefined();
  expect(entry.statFingerprint.size).toBe(99);
  await expect(ledger.transition('source-1', 'remote_committed', commitEvidence())).rejects.toThrow(/manifest|contentHash/i);
});

test('same logical session on two paths and machines retains distinct content', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot({ sourceId: 'brain\0codex\0same:/one', logicalSessionKey: 'brain\0codex\0same', brainId: 'brain', provider: 'codex', sessionId: 'same', sourcePath: '/one/session.jsonl', machineId: 'one', contentHash: 'a'.repeat(64), statFingerprint: { size: 4 } });
  await ledger.recordSnapshot({ sourceId: 'brain\0codex\0same:/two', logicalSessionKey: 'brain\0codex\0same', brainId: 'brain', provider: 'codex', sessionId: 'same', sourcePath: '/two/session.jsonl', machineId: 'two', contentHash: 'b'.repeat(64), statFingerprint: { size: 5 } });
  const sources = Object.values((await ledger.read()).sources) as any[];
  expect(sources.map((item) => item.contentHash).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
});

test('composite source ids must be bound to their logical session key', async () => {
  const { home, file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  const identity = { logicalSessionKey: 'brain\0codex\0same', brainId: 'brain', provider: 'codex', sessionId: 'same' };
  await expect(ledger.recordSnapshot({ sourceId: 'brain\0codex\0other:/one', ...identity })).rejects.toThrow(/sourceId composite/i);
  await expect(ledger.recordSnapshot({ sourceId: 'brain\0codex\0same:/one\0extra', ...identity })).rejects.toThrow(/sourceId composite/i);
  await expect(ledger.recordSnapshot({ sourceId: 'free-form', ...identity })).rejects.toThrow(/must be composite/i);
  await expect(ledger.recordSnapshot({ sourceId: 'brain\0codex\0same:/partial', logicalSessionKey: identity.logicalSessionKey, brainId: 'brain' })).rejects.toThrow(/requires brainId, provider, and sessionId/i);
});

test('rejects symlinked ledger parent paths', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-ledger-link-'));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-ledger-outside-'));
  temporaryHomes.add(home);
  temporaryHomes.add(outside);
  await fsp.symlink(outside, path.join(home, '.agentbootup'));
  const ledger = new ArchiveLedger({ file: getArchiveLedgerPath({ home }) });
  await expect(ledger.recordSnapshot({ sourceId: 'source', contentHash: 'a'.repeat(64), statFingerprint: { size: 1 } })).rejects.toThrow(/symlink/i);
  await fsp.rm(outside, { recursive: true });
});

test('clean-machine inventory reconstruction records unverified catalog references without claiming restore authority', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  const committed = commitEvidence();
  await expect(ledger.recordInventoryEntries([{ manifest: committed.manifest, receipt: committed.receipt }], {
    observedAt: '2026-07-19T00:00:03.000Z',
  })).resolves.toEqual({ recorded: 1 });
  const entries = Object.values((await ledger.read({ verify: false })).sources) as any[];
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    state: 'inventory_present_unverified',
    inventoryReference: {
      archiveVersionId: committed.manifest.archiveVersionId,
      manifestHash: committed.manifestHash,
      durabilityClass: 'versioned_replicated',
    },
  });
  expect(entries[0]).not.toHaveProperty('receipt');
  expect(entries[0]).not.toHaveProperty('verification');
  expect(entries[0]).not.toHaveProperty('archiveVersionId');

  await ledger.recordRestoreByArchive(committed.manifest.archiveVersionId, {
    restoredAt: '2026-07-19T00:00:04.000Z', destination: '/tmp/reconstructed-restore', mode: 'analysis_cache',
    archiveVersionId: committed.manifest.archiveVersionId, contentHash: committed.manifest.contentHash,
    byteSize: committed.manifest.byteSize, result: 'error',
  });
  await expect(ledger.recordInventoryEntries([{ manifest: committed.manifest, receipt: committed.receipt }], {
    observedAt: '2026-07-19T00:00:05.000Z',
  })).resolves.toEqual({ recorded: 1 });
  const refreshed = Object.values((await ledger.read({ verify: false })).sources) as any[];
  expect(refreshed[0].restorationHistory).toEqual([
    expect.objectContaining({ destination: '/tmp/reconstructed-restore', result: 'error' }),
  ]);
  expect(refreshed[0].inventoryReference.observedAt).toBe('2026-07-19T00:00:05.000Z');
});

test('inventory reconstruction reuses a known archive source without demoting lifecycle evidence', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  const committed = commitEvidence();
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'remote_committed', committed);
  await expect(ledger.recordInventoryEntries([{ manifest: committed.manifest, receipt: committed.receipt }]))
    .resolves.toEqual({ recorded: 1 });
  const state = await ledger.read({ verify: false });
  expect(Object.keys(state.sources)).toEqual(['source-1']);
  expect(state.sources['source-1'].state).toBe('remote_committed');
  expect(state.sources['source-1'].inventoryReference).toMatchObject({
    observedAt: expect.any(String), verificationStatus: committed.receipt.verificationStatus,
    receiptHash: canonicalHash(committed.receipt),
  });
});

test('known archive inventory refreshes remote evidence while preserving lifecycle and histories', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file, receiptVerifier: trustedReceiptVerifier, restoreVerifier: trustedRestoreVerifier });
  const committed = commitEvidence();
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'remote_committed', committed);
  await ledger.recordInventoryEntries([{ manifest: committed.manifest, receipt: committed.receipt }], {
    observedAt: '2026-07-19T00:00:03.000Z',
  });
  const refreshedReceipt = { ...committed.receipt, verificationStatus: 'replication_confirmed',
    committedAt: '2026-07-19T00:00:04.000Z' };
  await ledger.recordInventoryEntries([{ manifest: committed.manifest, receipt: refreshedReceipt }], {
    observedAt: '2026-07-19T00:00:05.000Z',
  });
  const source = (await ledger.read({ verify: false })).sources['source-1'];
  expect(source.state).toBe('remote_committed');
  expect(source.inventoryReference).toMatchObject({ observedAt: '2026-07-19T00:00:05.000Z',
    verificationStatus: 'replication_confirmed', receiptHash: canonicalHash(refreshedReceipt) });
  expect(source.receipt).toEqual(committed.receipt);
});

test('inventory isolation reports exact invalid indexes while recording valid siblings', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  const valid = commitEvidence();
  const invalid = { manifest: valid.manifest, receipt: { ...valid.receipt, contentHash: '0'.repeat(64) } };
  expect(() => validateInventoryEntryBinding(valid)).not.toThrow();
  expect(() => validateInventoryEntryBinding(invalid)).toThrow(/bind its manifest/i);
  await expect(ledger.recordInventoryEntries([valid, invalid, valid], { isolateInvalid: true,
    observedAt: '2026-07-19T00:00:03.000Z' })).resolves.toEqual({ recorded: 2, invalidIndexes: [1],
      invalidEntries: [{ index: 1, validationCode: 'INVENTORY_METADATA_INVALID' }] });
  expect(Object.values((await ledger.read({ verify: false })).sources)).toHaveLength(1);
});

test('leaving reconstructed inventory state clears the unverified catalog reference', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  const committed = commitEvidence();
  await ledger.recordInventoryEntries([{ manifest: committed.manifest, receipt: committed.receipt }]);
  const reconstructed = await ledger.read({ verify: false });
  const [sourceId] = Object.keys(reconstructed.sources);
  expect(reconstructed.sources[sourceId].inventoryReference).toBeDefined();

  await ledger.transition(sourceId, 'local_only');

  const local = (await ledger.read({ verify: false })).sources[sourceId];
  expect(local.state).toBe('local_only');
  expect(local).not.toHaveProperty('inventoryReference');
});

test('resumable upload progress and deep verification timestamps persist as bounded metadata', async () => {
  const { file } = await tempLedger();
  const ledger = new ArchiveLedger({ file });
  await ledger.recordSnapshot(snapshot());
  await ledger.transition('source-1', 'uploading');
  await ledger.recordUploadProgress('source-1', { uploadId: `up_${'a'.repeat(64)}`, totalParts: 3,
    receivedParts: [2, 0], updatedAt: '2026-07-19T00:00:03.000Z' });
  expect((await ledger.read({ verify: false })).sources['source-1'].uploadProgress).toEqual({
    uploadId: `up_${'a'.repeat(64)}`, totalParts: 3, receivedParts: [0, 2], updatedAt: '2026-07-19T00:00:03.000Z',
  });
  await expect(ledger.recordUploadProgress('source-1', { uploadId: `up_${'a'.repeat(64)}`, totalParts: 3,
    receivedParts: [0, 0], updatedAt: '2026-07-19T00:00:03.000Z' })).rejects.toThrow(/unique valid indexes/i);
  await ledger.transition('source-1', 'error');
  await ledger.transition('source-1', 'uploading');
  expect((await ledger.read({ verify: false })).sources['source-1']).not.toHaveProperty('uploadProgress');

  const committed = commitEvidence();
  await ledger.recordInventoryEntries([{ manifest: committed.manifest, receipt: committed.receipt }]);
  await ledger.recordDeepVerification('brain-a', committed.manifest.archiveVersionId, '2026-07-19T00:00:04.000Z');
  const reconstructed = Object.values((await ledger.read({ verify: false })).sources).find((entry: any) => entry.inventoryReference) as any;
  expect(reconstructed.inventoryReference.lastDeepVerifiedAt).toBe('2026-07-19T00:00:04.000Z');
});
