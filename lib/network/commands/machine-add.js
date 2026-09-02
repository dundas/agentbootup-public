/**
 * Report-only second-machine onboarding proposal.
 *
 * This is intentionally not an executor.  An onboarding plan is evidence for an
 * explicit policy approval; it must not create a target identity, contact a
 * remote, move credentials, acquire a lease, write a receipt, or start a daemon.
 */

import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { assertUsableSourceRoot, describeCheckedOutRef, isWorkTreeDirty } from '../../brain/canonical-ref.js';
import { PER_MACHINE_STATE_ROOTS, collectIgnoredState, stateKey } from '../../brain/canonical-state-root.js';
import { planCanonicalWrite } from '../../brain/canonical-write.js';
import { descriptorHash } from '../../brain/source-descriptor.js';
import { classifyAssets, evaluateDaemonSource, loadDescriptor } from '../../brain/source-migration.js';
import { readMachineIdState } from '../../machine-id/machine-id.js';

const USAGE = 'Usage: agentbootup machine add --dry-run --source-root <dir> --target <name> [--remote <endpoint>] [--json]';

function parse(args) {
  const valueFlags = new Set(['--source-root', '--target', '--remote']);
  const parsed = { dryRun: false, json: false, sourceRoot: null, target: null, remote: null };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--dry-run') parsed.dryRun = true;
    else if (token === '--json') parsed.json = true;
    else if (valueFlags.has(token)) {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(`${token} requires a value`);
      const field = token === '--source-root' ? 'sourceRoot' : token.slice(2);
      if (parsed[field] !== null) throw new Error(`${token} may be supplied only once`);
      parsed[field] = value;
    } else if (token === '--help' || token === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return parsed;
}

function planError(message) {
  const err = new Error(message);
  err.name = 'MachineAddPlanError';
  return err;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function countExcludedPolicyPaths(root, ignoredRoots, includedPaths) {
  const included = new Set(includedPaths);
  const counts = { secret_or_denied: 0, symlink: 0, non_regular: 0 };
  const walk = (directory, relativeBase) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      throw planError('policy inventory changed or became unreadable');
    }
    for (const entry of entries) {
      const relativePath = `${relativeBase}/${entry.name}`;
      const absolutePath = path.join(directory, entry.name); // nosemgrep: path-join-resolve-traversal -- entry names are supplied by readdir under an already-contained allowed root
      if (entry.isSymbolicLink()) {
        counts.symlink += 1;
      } else if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        if (!included.has(relativePath)) counts.secret_or_denied += 1;
      } else {
        counts.non_regular += 1;
      }
    }
  };
  for (const relativeRoot of ignoredRoots) {
    const absoluteRoot = path.join(root, relativeRoot); // nosemgrep: path-join-resolve-traversal -- relativeRoot is supplied by canonical ignored-state classification
    // `collectIgnoredState` has already lstat-validated this root. Repeat that
    // boundary here because the proposal's counts must not follow a link if the
    // filesystem changes between collection and classification.
    let rootStat;
    try {
      rootStat = fs.lstatSync(absoluteRoot);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    if (rootStat.isSymbolicLink()) throw planError(`policy root is a symlink: ${relativeRoot}`);
    if (!rootStat.isDirectory()) throw planError(`policy root is not a directory: ${relativeRoot}`);
    walk(absoluteRoot, relativeRoot);
  }
  return counts;
}

/**
 * Produce the reviewable, non-secret candidate set for a policy approval.
 * `collectIgnoredState` is deliberately the source of this inventory: it applies
 * the canonical secret, extension, containment, and symlink rules *before* any
 * file is represented in a plan. A rejected file is therefore never named or
 * hashed in a CLI report that might be pasted into an approval ticket.
 */
function buildPolicyProposal(root, ignoredRoots) {
  // A plan often becomes a ticket/approval attachment. Suppress collector
  // diagnostics here: an excluded filename can itself contain sensitive data.
  const contents = collectIgnoredState(root, { roots: ignoredRoots, warnOnSkip: false });
  const files = Object.entries(contents)
    .map(([relativePath, body]) => ({
      path: relativePath,
      bytes: body.length,
      sha256: sha256(body),
    }))
    // Do not use localeCompare: its collation can vary with host ICU/locale,
    // while an approval must bind the same inventory on every machine.
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  // Hash the canonical, already-sorted candidate records rather than the source
  // directory: it is stable across host paths and contains no file payload.
  const inventoryHash = sha256(JSON.stringify(files));
  const excludedCounts = countExcludedPolicyPaths(root, ignoredRoots, files.map((file) => file.path));

  return {
    version: 'machine-asset-policy-proposal/1',
    state: 'proposed_unapproved',
    included: {
      roots: [...ignoredRoots],
      files,
      file_count: files.length,
      total_bytes: totalBytes,
      inventory_sha256: inventoryHash,
    },
    exclusions: {
      per_machine_roots: {
        roots: [...PER_MACHINE_STATE_ROOTS],
        disposition: 'never_shared_machine_local_state',
      },
      secret_or_denied_paths: {
        disposition: 'excluded_before_plan_output',
        detail: 'secret-shaped, denied-extension, escaped, symlink, and non-regular paths are never named or hashed',
        count: excludedCounts.secret_or_denied,
      },
      symlink_paths: {
        disposition: 'excluded_before_plan_output',
        count: excludedCounts.symlink,
      },
      non_regular_paths: {
        disposition: 'excluded_before_plan_output',
        count: excludedCounts.non_regular,
      },
    },
    approval: {
      required: true,
      disposition: 'proposal_only_no_apply_path',
      binds_inventory_sha256: inventoryHash,
    },
  };
}

// A bootstrap proposal is often pasted into tickets and receipts. Accepting a
// credential-bearing endpoint would therefore turn a report-only command into a
// secret disclosure path. Remote execution is not implemented in this slice, so
// there is no compatibility reason to accept embedded credentials now.
function assertNonSecretRemote(remote) {
  if (remote == null) return null;
  if (typeof remote !== 'string' || !remote.trim()) throw planError('--remote must be a non-empty endpoint');
  // Reject this raw form before URL parsing. Opaque URI schemes such as
  // `ssh:user:secret@host` do not expose `@` as URL userinfo, but carrying the
  // value into a report is still a credential disclosure risk.
  if (remote.includes('@')) throw planError('--remote must not contain credentials');
  let url;
  try {
    url = new URL(remote);
  } catch {
    // Non-URL endpoint forms (for example, a host alias) cannot carry URL
    // userinfo/query credentials. Reject an `@` prefix anyway: `user@host` is
    // credential-shaped and has no role in this declarative plan contract.
    if (remote.includes('?') || remote.includes('#')) throw planError('--remote must not contain query parameters or fragments');
    return remote;
  }
  if (url.username || url.password) throw planError('--remote must not contain userinfo credentials');
  // Queries and fragments are opaque to this plan-only interface. Trying to
  // recognize every possible credential spelling (`jwt`, `session`, provider
  // specific keys, signed fragments, ...) would inevitably leak the next one
  // into plan output. Remote execution is deferred, so reject the entire form.
  if (url.search || url.hash) throw planError('--remote must not contain query parameters or fragments');
  return remote;
}

/**
 * Build a proposal from persisted local authority only. `deps` makes the
 * read-only identity behavior independently testable: this command must use
 * readMachineIdState, never getMachineId (which mints identity state).
 */
export async function buildMachineAddPlan({ sourceRoot, target, remote = null }, deps = {}) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) throw planError('--source-root is required');
  if (typeof target !== 'string' || !target.trim()) throw planError('--target is required');
  // nosemgrep: path-join-resolve-traversal -- sourceRoot is an explicit operator-selected onboarding root; assertUsableSourceRoot rejects missing, non-directory, and symlink paths before any descriptor or Git access.
  const root = assertUsableSourceRoot(path.resolve(sourceRoot));
  const safeRemote = assertNonSecretRemote(remote);
  const descriptor = loadDescriptor(root);
  if (descriptor == null) throw planError('source descriptor is required; authority is never inferred from a checkout');
  if (descriptor.__invalid) throw planError(`source descriptor is invalid: ${descriptor.__invalid}`);

  const source = evaluateDaemonSource(root);
  if (!source.may_publish) {
    throw planError(`source authority is quarantined: ${source.reason}${source.detail ? ` (${source.detail})` : ''}`);
  }

  // A declared ref is not enough evidence that there are canonical bytes to put
  // on a second machine. Reuse the canonical write planner's read-only existence
  // and upstream checks; it neither writes nor creates a worktree in this mode.
  if (descriptor.source_kind === 'git') {
    const canonicalPlan = planCanonicalWrite(root, source.canonical_ref, []);
    if (!canonicalPlan.ok) {
      throw planError(`declared canonical ref is unavailable: ${canonicalPlan.reason}`);
    }
  }

  const classification = classifyAssets(root);
  if (classification.unsafe_ignored_state_roots.length > 0) {
    const [unsafe] = classification.unsafe_ignored_state_roots;
    throw planError(`policy root is unsafe: ${unsafe.root} (${unsafe.reason})`);
  }
  const policyProposal = buildPolicyProposal(root, classification.ignored_state_roots);
  const identity = await (deps.readMachineIdState ?? readMachineIdState)();
  const gitBacked = descriptor.source_kind === 'git';
  const checkedOut = gitBacked ? describeCheckedOutRef(root) : null;
  const dirty = gitBacked ? isWorkTreeDirty(root) : null;
  const canonicalCode = gitBacked
    ? {
      kind: 'git', ref: source.canonical_ref, ref_source: source.ref_source,
      checked_out_ref: checkedOut?.ref ?? null, checked_out_detached: checkedOut?.detached ?? null,
      work_tree_dirty: dirty,
      checkout_disposition: 'not_selected_as_authority',
    }
    : {
      kind: 'directory', ref: null, ref_source: 'not_applicable', checked_out_ref: null,
      checked_out_detached: null, work_tree_dirty: null, checkout_disposition: 'declared_directory_source',
    };

  return {
    version: 'machine-add-plan/1',
    dry_run: true,
    source: { descriptor, descriptor_hash: descriptorHash(descriptor), daemon_state: source.state },
    canonical_code: canonicalCode,
    selected_assets: {
      tracked_code: { included: gitBacked, disposition: gitBacked ? 'clone_or_checkout_canonical_ref' : 'not_applicable' },
      ignored_state_roots: classification.ignored_state_roots,
      disposition: 'non_secret_assets_only',
      secrets: { included: false, disposition: 'excluded_from_ordinary_bootstrap' },
      excluded_per_machine_roots: [...PER_MACHINE_STATE_ROOTS],
    },
    target: {
      declared: target,
      disposition: 'declared_unverified',
      identity: { state: 'unverified', machine_id: null, disposition: 'target_must_create_or_use_its_own_identity' },
    },
    remote: {
      endpoint: safeRemote,
      capability: safeRemote ? 'declared_unverified' : 'not_declared',
      disposition: 'no_remote_connection_attempted',
    },
    source_identity: { state: identity.state, machine_id: identity.id, disposition: 'read_only_not_transferred' },
    writer_fence: {
      required: true, state_key: stateKey(descriptor.brain_id, descriptor.branch_id),
      disposition: 'must_acquire_fresh_lease_and_fencing_token_before_any_state_write',
    },
    policy: {
      approval_required: true,
      approved: false,
      disposition: 'proposal_only_no_apply_path',
      proposal: policyProposal,
    },
    daemon: { disposition: 'stopped_pending_canary' },
    actions: [
      { id: 'verify-policy-approval', mutates: false, disposition: 'requires_explicit_operator_approval' },
      { id: 'verify-target-capability', mutates: false, disposition: 'not_attempted_by_dry_run' },
      { id: 'establish-separate-target-identity', mutates: false, disposition: 'not_attempted_by_dry_run' },
      { id: 'obtain-target-enrollment', mutates: false, disposition: 'not_attempted_by_dry_run_no_secrets_transferred' },
      { id: 'materialize-canonical-code', mutates: false, disposition: gitBacked ? 'would_use_explicit_canonical_ref' : 'would_use_declared_directory_source' },
      { id: 'restore-selected-non-secret-assets', mutates: false, disposition: 'would_exclude_secrets_and_per_machine_state' },
      { id: 'acquire-writer-fence', mutates: false, disposition: 'would_require_fresh_lease_before_state_write' },
      { id: 'write-resumable-receipt', mutates: false, disposition: 'not_attempted_by_dry_run' },
      { id: 'start-daemon', mutates: false, disposition: 'prohibited_until_seedid_canary_passes' },
    ],
  };
}

export async function runMachineCommand(args, io) {
  if (args[0] !== 'add') {
    io.stderr(`machine requires the add subcommand\n${USAGE}`);
    return 2;
  }
  let parsed;
  try {
    parsed = parse(args.slice(1));
  } catch (err) {
    io.stderr(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (!parsed.dryRun) {
    io.stderr(`machine add only supports --dry-run in this release; no apply path exists\n${USAGE}`);
    return 2;
  }
  try {
    const plan = await buildMachineAddPlan(parsed);
    if (parsed.json) io.stdout(JSON.stringify(plan));
    else io.stdout(JSON.stringify(plan, null, 2));
    return 0;
  } catch (err) {
    io.stderr(`machine add plan failed: ${err.message}`);
    return 1;
  }
}
