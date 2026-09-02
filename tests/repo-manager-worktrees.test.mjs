import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptRecovery, inventory, main, persistItems, releaseAfterReceipt } from '../scripts/repo-manager-worktrees.mjs';

const repo = '/private/secret-project';
const livePath = '/private/secret-project/live';
const orphanPath = '/private/secret-project/orphan';
const releasedPath = '/private/secret-project/released';
const legacyPath = '/private/secret-project/legacy';
const lease = (id, worktree_path, state, disposition, overrides = {}) => ({
  lease: { id, worktree_path, task_ref: 'tasks/0073#contains-a-prompt', branch: 'feature/private', session_id: `owner-${id}`, pid: 771, heartbeat_at: '2026-08-28T12:00:00.000Z', ...overrides }, state, disposition,
});
const statuses = [
  lease('wt-0000000000000001', livePath, 'live', 'not_eligible'),
  lease('wt-0000000000000002', orphanPath, 'orphaned', 'needs_reconciliation'),
  lease('wt-0000000000000003', releasedPath, 'released', 'candidate'),
];
const porcelain = `worktree ${repo}\nbranch refs/heads/main\n\nworktree ${livePath}\nbranch refs/heads/live\n\nworktree ${orphanPath}\nbranch refs/heads/orphan\n\nworktree ${releasedPath}\nbranch refs/heads/released\n\nworktree ${legacyPath}\nbranch refs/heads/legacy\n`;

const commands = [];
function runner(command, args) {
  commands.push([command, args]);
  if (command === 'git') return { status: 0, stdout: porcelain, stderr: '' };
  if (args.includes('list')) return { status: 0, stdout: JSON.stringify(statuses), stderr: '' };
  return { status: 0, stdout: JSON.stringify({ accepted: true }), stderr: '' };
}

test('inventory consumes classifier statuses, emits no host paths, and keeps no-lease worktrees legacy', () => {
  commands.length = 0;
  const report = inventory({ repo, classifier: '/runtime/worktree-session.ts', now: Date.parse('2026-08-28T12:01:00.000Z'), runner });
  assert.deepEqual(report.queues, { blocked_by_live: 1, needs_owner_recovery: 1, eligible_for_review: 1, legacy_unbound: 2 });
  assert.equal(report.mode, 'dry_run');
  assert.equal(report.items.find((item) => item.state === 'orphaned').item_kind, 'recovery_ticket');
  assert.equal(report.items.find((item) => item.state === 'released').item_kind, 'cleanup_candidate');
  assert.equal(report.items.find((item) => item.state === 'legacy_unbound').recovery_action, 'bind_or_recover');
  const output = JSON.stringify(report);
  assert.doesNotMatch(output, /\/private\/secret-project|contains-a-prompt|owner-wt/);
  assert.ok(commands.some(([command, args]) => command === 'bun' && args[0] === '/runtime/worktree-session.ts' && args.includes('list')));
});

test('persisted recovery and cleanup records are idempotent and opaque', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-manager-state-'));
  try {
    inventory({ repo, classifier: '/runtime/worktree-session.ts', stateDir, persist: true, runner });
    const first = fs.readdirSync(stateDir).sort();
    inventory({ repo, classifier: '/runtime/worktree-session.ts', stateDir, persist: true, runner });
    assert.deepEqual(fs.readdirSync(stateDir).sort(), first);
    assert.equal(first.length, 2);
    for (const file of first) assert.doesNotMatch(fs.readFileSync(path.join(stateDir, file), 'utf8'), /secret-project|contains-a-prompt/);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('a corrupt existing ticket fails closed instead of suppressing recovery', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-manager-race-'));
  try {
    const report = inventory({ repo, classifier: '/runtime/worktree-session.ts', runner });
    const item = report.items.find((candidate) => candidate.item_kind === 'recovery_ticket');
    fs.writeFileSync(path.join(stateDir, `${item.locator}.recovery_ticket.json`), '{"another_writer":true}\n', { mode: 0o600 });
    assert.throws(() => inventory({ repo, classifier: '/runtime/worktree-session.ts', stateDir, persist: true, runner }), { code: 'TICKET_INTEGRITY_ERROR' });
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('adoption requires exact opaque prior-owner evidence and explicit confirmation', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-manager-adopt-'));
  try {
    assert.throws(() => adoptRecovery({ repo, classifier: '/runtime/worktree-session.ts', stateDir, leaseId: 'wt-0000000000000002', sessionId: 'new', ownerPid: 42, priorOwnerEvidence: 'owner_x', observedPriorOwnerEvidence: 'owner_y', priorSessionId: 'old', confirm: true, runner }), { code: 'PRIOR_OWNER_EVIDENCE_MISMATCH' });
    inventory({ repo, classifier: '/runtime/worktree-session.ts', stateDir, persist: true, runner });
    const item = inventory({ repo, classifier: '/runtime/worktree-session.ts', runner }).items.find((candidate) => candidate.lease_id === 'wt-0000000000000002');
    const result = adoptRecovery({ repo, classifier: '/runtime/worktree-session.ts', stateDir, leaseId: 'wt-0000000000000002', sessionId: 'new', ownerPid: 42, priorOwnerEvidence: item.prior_owner_evidence, observedPriorOwnerEvidence: item.prior_owner_evidence, priorSessionId: 'owner-wt-0000000000000002', confirm: true, runner });
    assert.deepEqual(result, { schema_version: 'repo-manager-worktree-adapter-v1', operation: 'adopt_recovery', accepted: true, locator: item.locator, lease_id: item.lease_id });
    const live = inventory({ repo, classifier: '/runtime/worktree-session.ts', runner }).items.find((candidate) => candidate.lease_id === 'wt-0000000000000001');
    assert.throws(() => adoptRecovery({ repo, classifier: '/runtime/worktree-session.ts', stateDir, leaseId: 'wt-0000000000000001', sessionId: 'new', ownerPid: 42, priorOwnerEvidence: live.prior_owner_evidence, observedPriorOwnerEvidence: live.prior_owner_evidence, priorSessionId: 'owner-wt-0000000000000001', confirm: true, runner }), { code: 'RECOVERY_NOT_ELIGIBLE' });
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('release is impossible without a typed receipt identifier and descendant confirmation', () => {
  const receipt = { schema_version: 'worktree-terminal-receipt-v1', receipt_id: 'receipt-verified', lease_id: 'wt-0000000000000001', terminal_state: 'integrated', integration_evidence: 'PR #1 merged' };
  assert.throws(() => releaseAfterReceipt({ repo, classifier: '/runtime/worktree-session.ts', leaseId: 'wt-0000000000000001', sessionId: 'owner-wt-0000000000000001', receipt: { ...receipt, lease_id: 'wt-0000000000000002' }, confirmNoDescendants: true, runner }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => releaseAfterReceipt({ repo, classifier: '/runtime/worktree-session.ts', leaseId: 'wt-0000000000000001', sessionId: 'owner-wt-0000000000000001', receipt, confirmNoDescendants: false, runner }), { code: 'CONFIRMATION_REQUIRED' });
  commands.length = 0;
  assert.deepEqual(releaseAfterReceipt({ repo, classifier: '/runtime/worktree-session.ts', leaseId: 'wt-0000000000000001', sessionId: 'owner-wt-0000000000000001', receipt, confirmNoDescendants: true, runner }), { schema_version: 'repo-manager-worktree-adapter-v1', operation: 'release_after_receipt', accepted: true, locator: inventory({ repo, classifier: '/runtime/worktree-session.ts', runner }).items.find((item) => item.lease_id === 'wt-0000000000000001').locator, lease_id: 'wt-0000000000000001' });
  const releaseCall = commands.find(([, args]) => args.includes('release'));
  assert.ok(releaseCall);
  assert.ok(!releaseCall[1].includes('--force'));
  assert.throws(() => releaseAfterReceipt({ repo, classifier: '/runtime/worktree-session.ts', leaseId: 'wt-0000000000000003', sessionId: 'owner-wt-0000000000000003', receipt: { ...receipt, lease_id: 'wt-0000000000000003' }, confirmNoDescendants: true, runner }), { code: 'RELEASE_NOT_ELIGIBLE' });
  const suspectRunner = (command, args) => command === 'git' ? { status: 0, stdout: porcelain, stderr: '' } : args.includes('list') ? { status: 0, stdout: JSON.stringify([lease('wt-0000000000000001', livePath, 'suspect', 'needs_reconciliation')]), stderr: '' } : { status: 0, stdout: '{}', stderr: '' };
  assert.throws(() => releaseAfterReceipt({ repo, classifier: '/runtime/worktree-session.ts', leaseId: 'wt-0000000000000001', sessionId: 'owner-wt-0000000000000001', receipt, confirmNoDescendants: true, runner: suspectRunner }), { code: 'RELEASE_NOT_ELIGIBLE' });
});

test('recovery and later cleanup records share a locator without overwrite or conflict', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-manager-transition-'));
  const base = { locator: 'wtloc_transition', lease_id: 'wt-0000000000000002', task_locator: 'task_transition', prior_owner_evidence: 'owner_transition' };
  try {
    persistItems(stateDir, [{ ...base, item_kind: 'recovery_ticket' }]);
    persistItems(stateDir, [{ ...base, item_kind: 'cleanup_candidate' }]);
    assert.deepEqual(fs.readdirSync(stateDir).sort(), ['wtloc_transition.cleanup_candidate.json', 'wtloc_transition.recovery_ticket.json']);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('classifier contract failures are fail-closed rather than recreated locally', () => {
  const badRunner = (command, args) => command === 'git' ? { status: 0, stdout: porcelain, stderr: '' } : { status: 0, stdout: '{}', stderr: '' };
  assert.throws(() => inventory({ repo, classifier: '/runtime/worktree-session.ts', runner: badRunner }), { code: 'INVALID_CLASSIFIER_CONTRACT' });
});

test('an orphaned but not-eligible classifier result never creates a recovery ticket', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-manager-not-eligible-'));
  const runner = (command, args) => command === 'git'
    ? { status: 0, stdout: porcelain, stderr: '' }
    : args.includes('list')
      ? { status: 0, stdout: JSON.stringify([lease('wt-0000000000000002', orphanPath, 'orphaned', 'not_eligible')]), stderr: '' }
      : { status: 0, stdout: '{}', stderr: '' };
  try {
    const report = inventory({ repo, classifier: '/runtime/worktree-session.ts', stateDir, persist: true, runner });
    const item = report.items.find((candidate) => candidate.lease_id === 'wt-0000000000000002');
    assert.equal(item.queue, 'legacy_unbound');
    assert.equal(item.item_kind, null);
    assert.deepEqual(fs.readdirSync(stateDir), []);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('CLI rejects unknown and bulk selector flags', () => {
  const io = { log() {}, error() {} };
  assert.equal(main(['inventory', '--repo', repo, '--classifier', '/runtime/worktree-session.ts', '--all'], io), 1);
  assert.equal(main(['inventory', '--repo', repo, '--classifier', '/runtime/worktree-session.ts', '--status', 'released'], io), 1);
  assert.equal(main(['adopt-recovery', '--repo', repo, '--classifier', '/runtime/worktree-session.ts', '--state-dir', '/tmp/tickets', '--lease-id', 'wt-0000000000000002', '--session', 'new-owner', '--owner-pid', '--confirm-adopt'], io), 1);
});
