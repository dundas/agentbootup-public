import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { readBrainSyncHealth, syncPendingFiles } from '../../lib/daemon/brain-asset-sync.mjs';
import { getBrainAssetSources } from '../../lib/brain/asset-sources.js';
import { saveDescriptor } from '../../lib/brain/source-migration.js';
import { declareDescriptor } from '../../lib/brain/source-descriptor.js';

const priorDescriptorStateRoot = process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT;
const descriptorTestStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-quarantine-state-'));
process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = descriptorTestStateRoot;
test.after(() => {
  if (priorDescriptorStateRoot == null) delete process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT;
  else process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = priorDescriptorStateRoot;
  fs.rmSync(descriptorTestStateRoot, { recursive: true, force: true });
});

function git(args, cwd) {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (proc.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr}`);
  return (proc.stdout || '').trim();
}

/** A git-backed project root with a real filesystem remote. */
function makeProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'source-quarantine-'));
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(['init', '--bare', '--initial-branch=trunk', bare], base);
  git(['init', '--initial-branch=trunk', work], base);
  git(['config', 'user.email', 't@e.com'], work);
  git(['config', 'user.name', 'T'], work);
  fs.mkdirSync(path.join(work, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(work, '.claude', 'skills', 'a.md'), '# skill');
  git(['add', '.'], work);
  git(['commit', '-m', 'init'], work);
  git(['remote', 'add', 'origin', bare], work);
  git(['push', '-u', 'origin', 'trunk'], work);
  return { base, work, ref: 'refs/heads/trunk' };
}

/**
 * The daemon must reach the network only if it is allowed to publish. A server URL
 * that cannot resolve makes any real attempt fail rather than silently pass.
 */
const UNREACHABLE = 'http://127.0.0.1:1';

/**
 * A real sync cycle always records health; a quarantined one never gets that far.
 * The health record is therefore the observable that distinguishes "gated" from
 * "ran and failed" — timing is not, because an unreachable server fails fast
 * either way. An earlier version of this test asserted elapsed time and passed
 * with the gate deleted, which is a test that verifies nothing.
 */
function syncRan(brainId, sinceIso) {
  const health = readBrainSyncHealth(brainId);
  return Boolean(health && (!sinceIso || health.lastSyncAt >= sinceIso));
}

/** Real sources, so the sync path genuinely proceeds when it is allowed to. */
/**
 * Health records live in a GLOBAL daemon dir keyed only by brain id, so a stale
 * record from an earlier run of this same file would otherwise be read as this
 * run's result. Unique per invocation, not just per pid.
 */
function uniqueBrainId(prefix) {
  return `${prefix}-${process.pid}-${process.hrtime.bigint()}`;
}

function syncArgs(work) {
  return [getBrainAssetSources(work), { shouldSkip: () => false }];
}

test('enforcement OFF: an undeclared source publishes, but says what it would have done', async () => {
  const { base, work } = makeProject();
  const previous = process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE;
  delete process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE;
  try {
    const brainId = uniqueBrainId('advisory');
    const [sources, guard] = syncArgs(work);
    await syncPendingFiles(brainId, 'key', UNREACHABLE, work, sources, guard, 'machine-a');
    // A health record proves the cycle actually ran: advisory mode must NOT gate.
    assert.equal(syncRan(brainId), true, 'advisory mode must still publish');
    // The verdict is recorded even when not enforced, so an operator can see what
    // enforcement WOULD do before switching it on.
    const advisoryHealth = readBrainSyncHealth(brainId);
    assert.equal(advisoryHealth.quarantinedSource?.enforced, false);
    assert.equal(advisoryHealth.quarantinedSource?.reason, 'no_source_descriptor');
  } finally {
    if (previous === undefined) delete process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE;
    else process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enforcement ON: an undeclared source is quarantined and never publishes', async () => {
  const { base, work } = makeProject();
  const previous = process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE;
  process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE = '1';
  try {
    const brainId = uniqueBrainId('enforced');
    const [sources, guard] = syncArgs(work);
    await syncPendingFiles(brainId, 'key', UNREACHABLE, work, sources, guard, 'machine-a');

    // Two things must BOTH hold, and an earlier version of this test asserted only
    // the first — which quietly codified an invisible quarantine as correct.
    const health = readBrainSyncHealth(brainId);
    // (a) nothing was published, and no push was attempted
    assert.equal(health.lastPushed, 0, 'quarantine must publish nothing');
    assert.equal(health.lastErrors, 0, 'quarantine must not even attempt a push');
    // (b) and the operator can SEE why. A quarantine daemon status cannot show is
    //     an outage with no symptom.
    assert.ok(health.quarantinedSource, 'enforced quarantine must be visible in sync health');
    assert.equal(health.quarantinedSource.reason, 'no_source_descriptor');
    assert.equal(health.quarantinedSource.enforced, true);
  } finally {
    if (previous === undefined) delete process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE;
    else process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enforcement surfaces legacy descriptor evidence without importing it', async () => {
  const { base, work } = makeProject();
  fs.mkdirSync(path.join(work, '.brain'));
  fs.writeFileSync(path.join(work, '.brain', 'source-descriptor.json'), '{"legacy":"untrusted"}');
  const previous = process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE;
  process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE = '1';
  try {
    const brainId = uniqueBrainId('legacy');
    const [sources, guard] = syncArgs(work);
    await syncPendingFiles(brainId, 'key', UNREACHABLE, work, sources, guard, 'machine-a');
    const health = readBrainSyncHealth(brainId);
    assert.equal(health.quarantinedSource?.reason, 'no_source_descriptor');
    assert.equal(health.quarantinedSource?.legacyDescriptor, 'present');
  } finally {
    if (previous === undefined) delete process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE;
    else process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enforcement ON with a declared source: the daemon is allowed through', async () => {
  const { base, work, ref } = makeProject();
  saveDescriptor(work, declareDescriptor({
    sourceKind: 'git',
    sourceRoot: work,
    repoRef: ref,
    brainId: 'test-brain',
  }));
  const previous = process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE;
  process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE = '1';
  try {
    const brainId = uniqueBrainId('declared');
    const [sources, guard] = syncArgs(work);
    await syncPendingFiles(brainId, 'key', UNREACHABLE, work, sources, guard, 'machine-a');
    assert.equal(syncRan(brainId), true, 'a declared source must lift quarantine');
    // No stale quarantine left behind once a source is declared.
    assert.equal(readBrainSyncHealth(brainId).quarantinedSource, null);
  } finally {
    if (previous === undefined) delete process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE;
    else process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
