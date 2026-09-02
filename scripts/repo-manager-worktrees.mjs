#!/usr/bin/env node
/**
 * Report-only portfolio adapter for the Decisive worktree-session classifier.
 *
 * This intentionally does not inspect PIDs, heartbeats, Git reachability, or
 * worktree dirtiness itself. Those are classifier-owned facts. The only local
 * discovery is Git's list of registered worktree identities, allowing a
 * worktree with no lease to remain explicitly legacy/unbound.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SCHEMA_VERSION = 'repo-manager-worktree-adapter-v1';
const LEASE_ID = /^wt-[a-f0-9]{16}$/;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const opaque = (value, prefix) => `${prefix}_${sha(value).slice(0, 24)}`;
const safeIsoAge = (value, now = Date.now()) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && parsed <= now ? now - parsed : null;
};
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const locatorFor = (repo, lease) => opaque(`${path.resolve(repo)}\0${path.resolve(lease.worktree_path)}\0${lease.id}`, 'wtloc');

function run(command, args, cwd, runner = spawnSync) {
  const result = runner(command, args, { cwd, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

export function parseWorktrees(porcelain) {
  const entries = []; let current;
  for (const line of String(porcelain).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { if (current) entries.push(current); current = { path: line.slice(9), branch: null }; }
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  if (current) entries.push(current);
  return entries;
}

function normalizeClassifierEntry(value) {
  const lease = value?.lease;
  if (!lease || typeof lease !== 'object' || !LEASE_ID.test(lease.id || '') || typeof lease.worktree_path !== 'string') throw fail('INVALID_CLASSIFIER_CONTRACT');
  if (!['live', 'suspect', 'orphaned', 'released'].includes(value.state) || !['not_eligible', 'needs_reconciliation', 'candidate'].includes(value.disposition)) throw fail('INVALID_CLASSIFIER_CONTRACT');
  return value;
}

export function callClassifier({ repo, classifier, classifierArgs = [], bunPath = 'bun', runner = spawnSync }) {
  if (!repo || !classifier) throw fail('CLASSIFIER_REQUIRED');
  const result = run(bunPath, [classifier, 'list', '--repo', repo, ...classifierArgs], repo, runner);
  if (result.status !== 0) throw fail('CLASSIFIER_UNAVAILABLE');
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw fail('INVALID_CLASSIFIER_CONTRACT'); }
  if (!Array.isArray(parsed)) throw fail('INVALID_CLASSIFIER_CONTRACT');
  return parsed.map(normalizeClassifierEntry);
}

export function actionFor(status) {
  if (!status) return { queue: 'legacy_unbound', action: 'bind_or_recover', item_kind: null };
  if (status.state === 'live') return { queue: 'blocked_by_live', action: 'report_only', item_kind: null };
  if (status.state === 'suspect') return { queue: 'blocked_by_live', action: 'quarantine', item_kind: null };
  if (status.disposition === 'candidate') return { queue: 'eligible_for_review', action: 'operator_cleanup_review', item_kind: 'cleanup_candidate' };
  if (status.disposition === 'needs_reconciliation') return { queue: 'needs_owner_recovery', action: 'owner_adopt_and_reconcile', item_kind: 'recovery_ticket' };
  return { queue: 'legacy_unbound', action: 'report_only', item_kind: null };
}
function ownerEvidence(lease) { return opaque(`${lease.id}\0${lease.session_id}\0${lease.pid}\0${lease.process_started_at || ''}\0${lease.boot_id || ''}`, 'owner'); }

export function inventory({ repo, classifier, stateDir, persist = false, now = Date.now(), bunPath = 'bun', runner = spawnSync }) {
  const git = run('git', ['-C', repo, 'worktree', 'list', '--porcelain'], repo, runner);
  if (git.status !== 0) throw fail('REPOSITORY_UNAVAILABLE');
  const statuses = callClassifier({ repo, classifier, bunPath, runner });
  const byPath = new Map(statuses.map((status) => [path.resolve(status.lease.worktree_path), status]));
  const items = parseWorktrees(git.stdout).map((tree) => {
    const status = byPath.get(path.resolve(tree.path));
    const route = actionFor(status);
    const locator = status ? locatorFor(repo, status.lease) : opaque(`${path.resolve(repo)}\0${path.resolve(tree.path)}\0legacy`, 'wtloc');
    const heartbeatAgeMs = status ? safeIsoAge(status.lease.heartbeat_at, now) : null;
    const priorOwnerEvidence = status ? ownerEvidence(status.lease) : null;
    return {
      locator, lease_id: status?.lease.id || null, task_locator: status?.lease.task_ref ? opaque(status.lease.task_ref, 'task') : null,
      branch_locator: status?.lease.branch || tree.branch ? opaque(status?.lease.branch || tree.branch, 'branch') : null, state: status?.state || 'legacy_unbound', disposition: status?.disposition || 'not_eligible',
      heartbeat_age_ms: heartbeatAgeMs, recovery_action: route.action, queue: route.queue, item_kind: route.item_kind,
      prior_owner_evidence: priorOwnerEvidence,
    };
  });
  const report = { schema_version: SCHEMA_VERSION, operation: 'inventory', mode: persist ? 'report_and_persist_items' : 'dry_run', observed_at: new Date(now).toISOString(), queues: Object.fromEntries(['blocked_by_live', 'needs_owner_recovery', 'eligible_for_review', 'legacy_unbound'].map((queue) => [queue, items.filter((item) => item.queue === queue).length])), items };
  if (persist) persistItems(stateDir, report.items, now);
  return report;
}

export function persistItems(stateDir, items, now = Date.now()) {
  if (!stateDir) throw fail('STATE_DIR_REQUIRED');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const item of items.filter((candidate) => candidate.item_kind)) {
    const target = path.join(stateDir, `${item.locator}.${item.item_kind}.json`);
    const record = { schema_version: SCHEMA_VERSION, locator: item.locator, kind: item.item_kind, lease_id: item.lease_id, task_locator: item.task_locator, prior_owner_evidence: item.prior_owner_evidence, created_at: new Date(now).toISOString() };
    if (fs.existsSync(target)) { verifyTicket(target, record); continue; }
    try { fs.writeFileSync(target, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error?.code === 'EEXIST') verifyTicket(target, record); else throw error; }
  }
}
function verifyTicket(ticketPath, expected) {
  let existing;
  try { existing = JSON.parse(fs.readFileSync(ticketPath, 'utf8')); } catch { throw fail('TICKET_INTEGRITY_ERROR'); }
  for (const key of ['schema_version', 'locator', 'kind', 'lease_id', 'task_locator', 'prior_owner_evidence']) {
    if (existing?.[key] !== expected[key]) throw fail('TICKET_INTEGRITY_ERROR');
  }
}

function required(flag, flags) {
  const value = flags.get(flag);
  if (typeof value !== 'string' || !value.trim()) throw fail('INVALID_ARGUMENT', `${flag} is required`);
  return value;
}
function parseFlags(args, allowed) {
  const flags = new Map();
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--') || !allowed.has(args[i])) throw fail('INVALID_ARGUMENT');
    const key = args[i]; const next = args[i + 1];
    if (next && !next.startsWith('--')) { flags.set(key, next); i += 1; } else flags.set(key, true);
  }
  return flags;
}
function invokeLifecycle({ repo, classifier, command, args, bunPath = 'bun', runner = spawnSync }) {
  const result = run(bunPath, [classifier, command, '--repo', repo, ...args], repo, runner);
  if (result.status !== 0) throw fail('LIFECYCLE_OPERATION_FAILED');
}
function operationReceipt(operation, repo, lease) { return { schema_version: SCHEMA_VERSION, operation, accepted: true, locator: locatorFor(repo, lease), lease_id: lease.id }; }
function leaseStatus({ repo, classifier, leaseId, bunPath, runner }) {
  const status = callClassifier({ repo, classifier, bunPath, runner }).find((entry) => entry.lease.id === leaseId);
  if (!status) throw fail('LEASE_NOT_FOUND');
  return status;
}

export function adoptRecovery({ repo, classifier, stateDir, leaseId, sessionId, ownerPid, priorOwnerEvidence, observedPriorOwnerEvidence, priorSessionId, confirm, bunPath = 'bun', runner = spawnSync }) {
  if (!confirm) throw fail('CONFIRMATION_REQUIRED');
  if (!LEASE_ID.test(leaseId || '') || !Number.isSafeInteger(Number(ownerPid)) || Number(ownerPid) < 1) throw fail('INVALID_ARGUMENT');
  const status = leaseStatus({ repo, classifier, leaseId, bunPath, runner });
  if (!priorOwnerEvidence || priorOwnerEvidence !== observedPriorOwnerEvidence || priorOwnerEvidence !== ownerEvidence(status.lease) || priorSessionId !== status.lease.session_id) throw fail('PRIOR_OWNER_EVIDENCE_MISMATCH');
  if (!['orphaned', 'released'].includes(status.state) || status.disposition !== 'needs_reconciliation') throw fail('RECOVERY_NOT_ELIGIBLE');
  const ticket = { schema_version: SCHEMA_VERSION, locator: locatorFor(repo, status.lease), kind: 'recovery_ticket', lease_id: leaseId, task_locator: status.lease.task_ref ? opaque(status.lease.task_ref, 'task') : null, prior_owner_evidence: priorOwnerEvidence };
  if (!stateDir) throw fail('STATE_DIR_REQUIRED');
  verifyTicket(path.join(stateDir, `${ticket.locator}.recovery_ticket.json`), ticket);
  // Do not send --force. If a new child/launch marker makes this lease suspect
  // between the inventory and canonical lock acquisition, the runtime rejects
  // the mutation rather than upgrading this adapter's orphan-only authority.
  invokeLifecycle({ repo, classifier, command: 'adopt', args: [leaseId, '--session', sessionId, '--owner-pid', String(ownerPid), '--confirm-prior-session', priorSessionId], bunPath, runner });
  return operationReceipt('adopt_recovery', repo, status.lease);
}

export function releaseAfterReceipt({ repo, classifier, leaseId, sessionId, receipt, confirmNoDescendants, releaseTokenFile, bunPath = 'bun', runner = spawnSync }) {
  if (!confirmNoDescendants) throw fail('CONFIRMATION_REQUIRED');
  if (!LEASE_ID.test(leaseId || '') || !sessionId || !isTerminalReceipt(receipt, leaseId)) throw fail('INVALID_ARGUMENT');
  const status = leaseStatus({ repo, classifier, leaseId, bunPath, runner });
  if (status.state !== 'live' || status.lease.session_id !== sessionId) throw fail('RELEASE_NOT_ELIGIBLE');
  // Do not force release: a child may attach after the local read, and the
  // canonical runtime must retain authority to reject that changed lifecycle state.
  invokeLifecycle({ repo, classifier, command: 'release', args: [leaseId, '--session', sessionId, '--confirm-no-descendants', ...(releaseTokenFile ? ['--release-token-file', releaseTokenFile] : [])], bunPath, runner });
  return operationReceipt('release_after_receipt', repo, status.lease);
}

export function isTerminalReceipt(receipt, leaseId) {
  return !!receipt && receipt.schema_version === 'worktree-terminal-receipt-v1' && receipt.lease_id === leaseId && RECEIPT_ID.test(receipt.receipt_id || '') && ['integrated', 'closed'].includes(receipt.terminal_state) && typeof receipt.integration_evidence === 'string' && receipt.integration_evidence.length > 0 && receipt.integration_evidence.length <= 500;
}
function readReceipt(receiptFile) {
  try { return JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { throw fail('INVALID_TERMINAL_RECEIPT'); }
}

export function main(argv, io = console) {
  const [command, ...args] = argv;
  if (!command || command === 'help') { io.log('repo-manager-worktrees inventory --repo PATH --classifier PATH [--state-dir PATH] [--persist-items] [--json]'); return 0; }
  try {
    const permitted = command === 'inventory'
      ? new Set(['--repo', '--classifier', '--state-dir', '--persist-items', '--json'])
      : command === 'adopt-recovery'
        ? new Set(['--repo', '--classifier', '--state-dir', '--lease-id', '--session', '--owner-pid', '--prior-owner-evidence', '--observed-prior-owner-evidence', '--confirm-prior-session', '--confirm-adopt'])
        : command === 'release-after-receipt'
          ? new Set(['--repo', '--classifier', '--lease-id', '--session', '--terminal-receipt-file', '--confirm-no-descendants', '--release-token-file'])
          : new Set();
    const flags = parseFlags(args, permitted); const repo = required('--repo', flags); const classifier = required('--classifier', flags);
    if (command === 'inventory') { const report = inventory({ repo, classifier, stateDir: flags.get('--state-dir'), persist: flags.get('--persist-items') === true }); io.log(JSON.stringify(report, null, 2)); return 0; }
    if (command === 'adopt-recovery') {
      const output = adoptRecovery({ repo, classifier, stateDir: required('--state-dir', flags), leaseId: required('--lease-id', flags), sessionId: required('--session', flags), ownerPid: Number(required('--owner-pid', flags)), priorOwnerEvidence: required('--prior-owner-evidence', flags), observedPriorOwnerEvidence: required('--observed-prior-owner-evidence', flags), priorSessionId: required('--confirm-prior-session', flags), confirm: flags.get('--confirm-adopt') === true }); io.log(JSON.stringify(output)); return 0;
    }
    if (command === 'release-after-receipt') { const output = releaseAfterReceipt({ repo, classifier, leaseId: required('--lease-id', flags), sessionId: required('--session', flags), receipt: readReceipt(required('--terminal-receipt-file', flags)), confirmNoDescendants: flags.get('--confirm-no-descendants') === true, releaseTokenFile: flags.get('--release-token-file') }); io.log(JSON.stringify(output)); return 0; }
    throw fail('INVALID_COMMAND');
  } catch (error) { io.error(JSON.stringify({ error: error.code || 'REPO_MANAGER_FAILED' })); return 1; }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
