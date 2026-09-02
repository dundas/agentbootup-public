/** Explicit, repository-independent operator interface for source authority. */
import fs from 'fs';
import path from 'path';
import { describeCanonicalRef } from './canonical-ref.js';
import { descriptorHash, declareDescriptor, SourceDescriptorError } from './source-descriptor.js';
import { DAEMON_STATES, buildMigrationReport, descriptorStateLabel, evaluateDaemonSource, recordAuthoritativeSelection } from './source-migration.js';

const USAGE = 'Usage: agentbootup brain source <report|status|select> --source <dir> [--json]';
const COMMANDS = new Set(['report', 'status', 'select']);
const VALUE_FLAGS = new Set(['--source', '--kind', '--brain', '--ref', '--branch', '--selected-by', '--selected-at', '--rationale']);
const BOOLEAN_FLAGS = new Set(['--json']);

function parse(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) throw new Error('usage');
  const values = Object.create(null); let json = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (BOOLEAN_FLAGS.has(token)) { json = true; continue; }
    if (!VALUE_FLAGS.has(token)) throw new Error('usage');
    if (Object.hasOwn(values, token)) throw new Error(`duplicate value for ${token}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('-')) throw new Error(`missing value for ${token}`);
    values[token] = value; i += 1;
  }
  return { command, values, json };
}
function required(values, flag) { if (!values[flag]) throw new Error(`missing value for ${flag}`); return values[flag]; }
function assertSource(source) {
  const root = path.resolve(source); // nosemgrep: path-join-resolve-traversal -- explicit local operator-selected --source is intentionally allowed to name any local worktree
  let stat;
  try { stat = fs.lstatSync(root); } catch (err) {
    throw new Error(err?.code === 'ENOENT' ? 'source_missing' : 'source_stat_failed');
  }
  if (stat.isSymbolicLink()) throw new Error('source_symlink_denied');
  if (!stat.isDirectory()) throw new Error('source_not_directory');
  return root;
}
function status(evaluation) {
  return { operation: 'status', state: evaluation.state, reason: evaluation.reason ?? null,
    may_publish: evaluation.may_publish === true, descriptor_state: descriptorStateLabel(evaluation),
    legacy_descriptor: evaluation.legacy_descriptor, descriptor_hash: evaluation.descriptor ? descriptorHash(evaluation.descriptor) : null,
    canonical_ref: evaluation.canonical_ref ?? null, ref_source: evaluation.ref_source ?? null };
}
function reportProjection(report) {
  return { operation: 'report', state: report.daemon_state, reason: report.quarantine_reason,
    descriptor_state: report.descriptor_state, legacy_descriptor: report.legacy_descriptor,
    git_backed: report.git_backed, checked_out_ref: report.checked_out_ref, canonical_ref: report.canonical_ref,
    ref_source: report.ref_source, work_tree_dirty: report.work_tree_dirty,
    ignored_state_roots: report.ignored_state_roots, unsafe_ignored_state_roots: report.unsafe_ignored_state_roots };
}
function emit(result, json, io) { io.stdout(json ? JSON.stringify({ brain_source: result }, null, 2) : `brain source ${result.operation}: ${result.state}${result.reason ? ` (${result.reason})` : ''}`); }

export function runBrainSource(argv, io = { stdout: console.log, stderr: console.error }) {
  if (argv.includes('--help') || argv.includes('-h')) { io.stdout(USAGE); return 0; }
  let parsed;
  try {
    parsed = parse(argv); const source = assertSource(required(parsed.values, '--source'));
    let result;
    if (parsed.command === 'report') result = reportProjection(buildMigrationReport(source));
    else if (parsed.command === 'status') result = status(evaluateDaemonSource(source));
    else {
      const sourceKind = required(parsed.values, '--kind');
      const descriptor = declareDescriptor({ sourceKind, sourceRoot: source, repoRef: sourceKind === 'git' ? required(parsed.values, '--ref') : null, brainId: required(parsed.values, '--brain'), branchId: parsed.values['--branch'] ?? null });
      if (sourceKind === 'git') { const canonical = describeCanonicalRef(source, { declaredRef: descriptor.repo_ref }); if (!canonical.resolved) throw new Error(`git_source_${canonical.reason}`); }
      const receipt = recordAuthoritativeSelection(source, descriptor, { selectedBy: required(parsed.values, '--selected-by'), selectedAt: required(parsed.values, '--selected-at'), rationale: parsed.values['--rationale'] ?? null });
      // Re-evaluate after the atomic write rather than assembling a success result
      // from the pre-write Git check: this is the only read that proves the exact
      // persisted descriptor is usable by the daemon.
      result = { ...status(evaluateDaemonSource(source)), operation: 'select', descriptor_hash: receipt.descriptor_hash,
        receipt: { receipt_version: receipt.receipt_version, descriptor_hash: receipt.descriptor_hash, selected_by: receipt.selected_by, selected_at: receipt.selected_at } };
    }
    emit(result, parsed.json, io); return result.operation === 'report' || result.state === DAEMON_STATES.READY ? 0 : 1;
  } catch (err) {
    // Descriptor errors may carry a local pathname as diagnostic detail. CLI
    // output is suitable for shared logs, so surface only their closed reason.
    const rawReason = err instanceof SourceDescriptorError ? err.reason : (err instanceof Error ? err.message : String(err));
    const reason = /^(?:usage|source_[a-z_]+|git_source_[a-z_]+|missing value for --[a-z-]+|duplicate value for --[a-z-]+)$/.test(rawReason)
      ? rawReason
      : 'source_operation_failed';
    if (reason === 'usage' || reason.startsWith('missing value for') || reason.startsWith('duplicate value for')) { io.stderr(reason === 'usage' ? USAGE : `${reason}; ${USAGE}`); return 2; }
    emit({ operation: parsed?.command ?? 'unknown', state: 'rejected', reason, may_publish: false }, parsed?.json === true, io); return 1;
  }
}
